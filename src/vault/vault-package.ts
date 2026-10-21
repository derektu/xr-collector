import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { removalsFromJson, scheduleEnabledFromJson, subscriptionsFromJson } from '../subscriptions/subscription-files.js';
import { scheduleFile, sourceDefinitions, subscriptionDefinitions } from '../core/source-registry.js';
import { CollectorError } from '../core/types.js';
import { DELETIONS_FILE, deletionsFromJson, deletionsToJson } from './deleted-documents.js';
import { documentId, documentKeyFromPath, documentPath, documentPathFromId } from './document-paths.js';
import { MarkdownVault, parseDocument } from './markdown-vault.js';
import { VAULT_MARKER } from './vault-directory.js';
import type { FileSource } from './vault-merge.js';

/**
 * The export file (`.zip`): a zip of the files a Vault registers, each at its path relative to the
 * Vault root, text compressed with deflate, plus `manifest.json`:
 *
 * ```json
 * { "format": "xr-collector-package", "formatVersion": 1,
 *   "exportedAt": "<ISO time>", "createdBy": "<program>",
 *   "source": { "vaultId": "<UUID>", "machine": "<name>" },
 *   "summary": { "documents": 0, "subscriptions": 0, "deletions": 0 },
 *   "files": [{ "path": "documents/<source type>/<ID>.md", "size": 0, "sha256": "<hex>" }] }
 * ```
 *
 * `source` names the Vault and the machine the export came from, for diagnosis; an import compares
 * the files themselves, whose documents, subscriptions and records carry their own times.
 *
 * The registered files are the documents `MarkdownVault.list` returns and the settings files:
 * the subscriptions file each registered source type declares, the schedule file and the deletion
 * file. Nothing else in the Vault folder is read or packed, so files a person keeps there never
 * fail an export. Packages are written and read as streams: memory holds the manifest and the file
 * in hand, never the whole package. A file read into memory to be checked (a document or a
 * settings file) is at most `FILE_LIMIT` bytes, and the manifest at most `MANIFEST_LIMIT`; a
 * package has no limit on its total size.
 */
export const PACKAGE_FORMAT = 'xr-collector-package';
export const PACKAGE_FORMAT_VERSION = 1;
export const MANIFEST = 'manifest.json';
export const FILE_LIMIT = 64 * 1024 * 1024;
export const MANIFEST_LIMIT = 64 * 1024 * 1024;
/** Every manifest row holds at least a 64-character digest, so a manifest within its limit lists no more files than this. */
const ENTRY_LIMIT = MANIFEST_LIMIT / 64;
/** Operating-system files that are never counted as a person's files in the Vault. */
const SYSTEM_FILES = new Set(['.DS_Store', '.localized', 'Thumbs.db', 'desktop.ini']);
/** Working folder of an import being applied in place, inside the Vault: `.xr-collector-import-<UUID>`. */
export const IMPORT_STAGING_PREFIX = '.xr-collector-import-';

/** The settings files a package may hold, in the order an export packs them. */
function settingsFiles(): string[] {
  return [...subscriptionDefinitions().map((definition) => definition.storage!.subscriptionsFile), scheduleFile(), DELETIONS_FILE];
}

/** The registered source types whose documents or subscription files are among `paths`. */
export function sourceTypesOf(paths: Iterable<string>): Set<string> {
  const subscriptionFiles = new Map(subscriptionDefinitions().map((definition) => [definition.storage!.subscriptionsFile, definition.id]));
  const types = new Set<string>();
  for (const file of paths) {
    const type = documentKeyFromPath(file)?.sourceType ?? subscriptionFiles.get(file);
    if (type) types.add(type);
  }
  return types;
}

/**
 * The format version a package of these files is written with: the highest `packageFormatVersion`
 * among the source types whose documents or subscription files it holds, and at least
 * `PACKAGE_FORMAT_VERSION`.
 */
export function packageFormatVersion(paths: readonly string[]): number {
  const types = sourceTypesOf(paths);
  return Math.max(PACKAGE_FORMAT_VERSION, ...sourceDefinitions().filter((definition) => types.has(definition.id)).map((definition) => definition.packageFormatVersion));
}

/** The highest package format version this program reads: its own, or a higher one a registered source type declares. */
export function supportedPackageFormatVersion(): number {
  return Math.max(PACKAGE_FORMAT_VERSION, ...sourceDefinitions().map((definition) => definition.packageFormatVersion));
}

export interface PackageSummary { documents: number; subscriptions: number; deletions: number }
export interface ManifestFile { path: string; size: number; sha256: string }
export interface PackageSource { vaultId: string; machine: string }
export interface PackageManifest {
  format: typeof PACKAGE_FORMAT;
  formatVersion: number;
  exportedAt?: string;
  createdBy?: string;
  source?: PackageSource;
  summary?: PackageSummary;
  files: ManifestFile[];
}

function invalid(message: string): never {
  throw new CollectorError('invalid_request', message);
}

const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/**
 * The name of this machine as export files and the activity log record it: `XR_COLLECTOR_MACHINE_NAME`
 * when set, otherwise the host name without the `.local` suffix macOS adds.
 */
export function machineName(): string {
  const configured = process.env.XR_COLLECTOR_MACHINE_NAME?.trim();
  return configured || hostname().replace(/\.local$/iu, '') || '這台電腦';
}

/** Whether a path names a file a package may hold: a document file or one of the settings files. */
export function packagePath(value: string): boolean {
  return documentKeyFromPath(value) !== null || settingsFiles().includes(value);
}

/** A file of a Vault that a package holds: read from `absolute`, or `bytes` the export wrote itself. */
export interface RegisteredFile { path: string; absolute?: string; bytes?: Buffer }

export interface RegisteredFiles {
  files: RegisteredFile[];
  /** Files in the Vault folder that belong to no record of the Vault and stay out of the package. */
  unregisteredFiles: number;
  summary: PackageSummary;
}

/**
 * The files of a Vault a package holds. Deletion records and document files go through the same
 * visibility rule as `MarkdownVault.list`: a document file a deletion hides stays out, and a record
 * whose document is newer stays out, so a package never holds a document next to the record that
 * hides it, even while a deletion is unfinished.
 */
export async function registeredFiles(root: string): Promise<RegisteredFiles> {
  const vault = new MarkdownVault(root);
  const documents = await vault.list();
  const portable = await vault.portableDeletions();
  const files: RegisteredFile[] = [];
  for (const document of documents) {
    const file = documentPathFromId(document.id)!;
    const absolute = await regularFile(root, file);
    if (absolute) files.push({ path: file, absolute });
  }
  let subscriptions: number | null = null;
  const subscriptionFiles = new Map(subscriptionDefinitions().map((definition) => [definition.storage!.subscriptionsFile, definition]));
  for (const file of settingsFiles()) {
    const absolute = await regularFile(root, file);
    if (!absolute) continue;
    if (file === DELETIONS_FILE) {
      const stored = deletionsFromJson(JSON.parse(await readFile(absolute, 'utf8')));
      files.push(stored.length === portable.records.length ? { path: file, absolute }
        : { path: file, bytes: Buffer.from(`${JSON.stringify(deletionsToJson(portable.records), null, 2)}\n`) });
    } else {
      const definition = subscriptionFiles.get(file);
      if (definition) subscriptions = (subscriptions ?? 0) + subscriptionsFromJson(definition, JSON.parse(await readFile(absolute, 'utf8'))).length;
      files.push({ path: file, absolute });
    }
  }
  const owned = new Set([...files.map((file) => file.path), ...[...portable.hidden].flatMap((id) => documentPathFromId(id) ?? [])]);
  return {
    files,
    unregisteredFiles: await countOthers(root, '', owned),
    summary: { documents: documents.length, subscriptions: subscriptions ?? 0, deletions: portable.records.length },
  };
}

/** The absolute path of a registered file, or null when it does not exist; anything but a regular file fails the export. */
async function regularFile(root: string, relative: string): Promise<string | null> {
  const absolute = path.join(root, relative);
  try {
    if (!(await lstat(absolute)).isFile()) invalid(`知識庫檔案不是一般檔案，無法匯出：${relative}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return absolute;
}

/**
 * Counts the entries of the Vault folder that no record owns, without reading them or following
 * symbolic links. Folders that cannot be read are skipped: the count only informs the person.
 */
async function countOthers(root: string, relative: string, owned: ReadonlySet<string>): Promise<number> {
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (SYSTEM_FILES.has(entry.name)) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (!relative && entry.isDirectory() && entry.name.startsWith(IMPORT_STAGING_PREFIX)) continue;
    if (entry.isDirectory()) count += await countOthers(root, child, owned);
    else if (!owned.has(child) && child !== VAULT_MARKER) count += 1;
  }
  return count;
}

/** Hashes and counts the bytes passing through, failing past `limit`. */
class Measure extends Transform {
  readonly hash = createHash('sha256');
  size = 0;
  constructor(private readonly limit: number, private readonly onLimit: () => Error) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.size += chunk.length;
    if (this.size > this.limit) { done(this.onLimit()); return; }
    this.hash.update(chunk);
    done(null, chunk);
  }
}

export interface WrittenPackage { unregisteredFiles: number; summary: PackageSummary }

/**
 * Writes the package of a Vault to `file`, a new file. Each registered file streams into the zip
 * in turn and its digest is taken on the way; the manifest goes last, once every digest is known.
 * `info` describes the package for people choosing it and for an import comparing it.
 */
export async function writePackage(
  root: string, file: string, info: { createdBy?: string; exportedAt?: Date; source?: PackageSource } = {},
): Promise<WrittenPackage> {
  const registered = await registeredFiles(root);
  // Opening first refuses an existing file before any entry is read, so only a file this call created is removed on failure.
  const handle = await open(file, 'wx', 0o600);
  const zip = new yazl.ZipFile();
  const output = zip.outputStream as unknown as Readable;
  zip.on('error', (error: Error) => output.destroy(error));
  const mtime = info.exportedAt ?? new Date();
  const rows: ManifestFile[] = [];
  for (const entry of registered.files) {
    zip.addReadStreamLazy(entry.path, { mtime }, (done) => {
      const measure = new Measure(FILE_LIMIT, () => new CollectorError('invalid_request', `知識庫檔案超過 64 MiB，無法匯出：${entry.path}`));
      measure.on('end', () => rows.push({ path: entry.path, size: measure.size, sha256: measure.hash.digest('hex') }));
      const source = entry.bytes ? Readable.from([entry.bytes]) : createReadStream(entry.absolute!);
      source.on('error', (error: Error) => measure.destroy(
        new CollectorError('invalid_request', `知識庫檔案在匯出途中無法讀取，請稍後再試：${entry.path}`, { cause: error })));
      // The zip does not listen for errors of the streams it reads, so a failed file ends the output and with it the export.
      measure.on('error', (error: Error) => output.destroy(error));
      done(null, source.pipe(measure));
    });
  }
  zip.addReadStreamLazy(MANIFEST, { mtime }, (done) => {
    const manifest: PackageManifest = {
      format: PACKAGE_FORMAT, formatVersion: packageFormatVersion(rows.map((row) => row.path)),
      ...(info.exportedAt ? { exportedAt: info.exportedAt.toISOString() } : {}), ...(info.createdBy ? { createdBy: info.createdBy } : {}),
      ...(info.source ? { source: info.source } : {}),
      summary: registered.summary, files: rows,
    };
    done(null, Readable.from([Buffer.from(JSON.stringify(manifest))]));
  });
  zip.end();
  try {
    await pipeline(output, handle.createWriteStream());
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(file, { force: true }).catch(() => undefined);
    throw error;
  }
  return { unregisteredFiles: registered.unregisteredFiles, summary: registered.summary };
}

/** A package opened for reading; every file read from it is checked against its manifest row. */
export interface PackageReader {
  manifest: PackageManifest;
  /** A digest of the manifest, which changes whenever the package content does. */
  identity: string;
  has(file: string): boolean;
  paths(): string[];
  /** The bytes of a file, checked against its size and SHA-256. */
  read(file: string): Promise<Buffer>;
  /** Writes a file to `target`, a new file, checking it on the way; a file that does not match is removed. */
  extract(file: string, target: string): Promise<void>;
  close(): void;
}

/**
 * Opens a package file and checks its structure: a zip whose entries are exactly `manifest.json`
 * and the files the manifest lists, each at a path a package may hold, with the size the manifest
 * gives. Contents are checked as they are read.
 */
export async function openPackage(file: string): Promise<PackageReader> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true });
  } catch {
    invalid('這不是 XR Collector 的匯出檔（無法以 zip 讀取）。');
  }
  try {
    if (zip.entryCount > ENTRY_LIMIT + 1) invalid('匯出檔的項目數量超出可處理的範圍。');
    const entries = new Map<string, yauzl.Entry>();
    const folded = new Set<string>();
    try {
      for await (const entry of zip.eachEntry()) {
        const name = entry.fileName;
        if (name.endsWith('/') || entry.isEncrypted() || !entry.canDecodeFileData()) invalid('匯出檔含有無法處理的項目。');
        const key = name.toLocaleLowerCase('en-US');
        if (folded.has(key)) invalid('匯出檔含有重複或只差大小寫的路徑。');
        folded.add(key);
        entries.set(name, entry);
      }
    } catch (error) {
      if (error instanceof CollectorError) throw error;
      invalid('匯出檔已損壞或含有不安全的路徑。');
    }
    const manifestEntry = entries.get(MANIFEST);
    if (!manifestEntry) invalid('這不是 XR Collector 的匯出檔（缺少 manifest.json）。');
    if (manifestEntry.uncompressedSize > MANIFEST_LIMIT) invalid('匯出檔的 manifest.json 超過 64 MiB。');
    const manifestBytes = await readEntry(zip, manifestEntry, MANIFEST_LIMIT);
    const manifest = parseManifest(manifestBytes);
    const rows = new Map(manifest.files.map((row) => [row.path, row]));
    for (const row of manifest.files) {
      const entry = entries.get(row.path);
      if (!entry) invalid(`匯出檔缺少 manifest 列出的檔案：${row.path}`);
      if (entry.uncompressedSize !== row.size) invalid(`匯出檔的內容與 manifest 不一致：${row.path}`);
    }
    for (const name of entries.keys()) {
      if (name !== MANIFEST && !rows.has(name)) invalid(`匯出檔含有 manifest 沒有列出的項目：${name}`);
    }
    const open = async (name: string): Promise<{ stream: Readable; measure: Measure; row: ManifestFile }> => {
      const row = rows.get(name);
      if (!row) throw new Error(`Not in the package: ${name}`);
      const stream = await zip.openReadStreamPromise(entries.get(name)!);
      const measure = new Measure(row.size, () => new CollectorError('invalid_request', `匯出檔的內容與 manifest 不一致：${name}`));
      return { stream, measure, row };
    };
    const verify = (measure: Measure, row: ManifestFile) => {
      if (measure.size !== row.size || measure.hash.digest('hex') !== row.sha256) invalid(`匯出檔的內容與 manifest 不一致：${row.path}`);
    };
    return {
      manifest,
      identity: digest(manifestBytes),
      has: (name) => rows.has(name),
      paths: () => [...rows.keys()],
      async read(name) {
        const { stream, measure, row } = await open(name);
        const chunks: Buffer[] = [];
        try {
          await pipeline(stream, measure, async (source: AsyncIterable<Buffer>) => { for await (const chunk of source) chunks.push(chunk); });
        } catch (error) {
          if (error instanceof CollectorError) throw error;
          invalid(`匯出檔已損壞：${name}`);
        }
        verify(measure, row);
        return Buffer.concat(chunks);
      },
      async extract(name, target) {
        const { stream, measure, row } = await open(name);
        try {
          await pipeline(stream, measure, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
          verify(measure, row);
        } catch (error) {
          await rm(target, { force: true }).catch(() => undefined);
          if (error instanceof CollectorError || (error as NodeJS.ErrnoException).code) throw error;
          invalid(`匯出檔已損壞：${name}`);
        }
      },
      close: () => zip.close(),
    };
  } catch (error) {
    zip.close();
    throw error;
  }
}

async function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of await zip.openReadStreamPromise(entry) as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > limit) invalid('匯出檔的 manifest.json 超過 64 MiB。');
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    invalid('匯出檔已損壞。');
  }
  return Buffer.concat(chunks);
}

function parseManifest(bytes: Buffer): PackageManifest {
  let value: Partial<PackageManifest>;
  try { value = JSON.parse(bytes.toString('utf8')) as Partial<PackageManifest>; } catch { invalid('匯出檔的 manifest.json 格式無效。'); }
  if (!value || value.format !== PACKAGE_FORMAT) invalid('這不是 XR Collector 的匯出檔。');
  const formatVersion = value.formatVersion;
  if (!Number.isInteger(formatVersion) || formatVersion! < 1 || formatVersion! > supportedPackageFormatVersion()) invalid('不支援這個匯出檔的格式版本。');
  if (!Array.isArray(value.files)) invalid('匯出檔的 manifest.json 格式無效。');
  const seen = new Set<string>();
  for (const row of value.files as unknown[]) {
    const file = row as Partial<ManifestFile> | null;
    if (!file || typeof file.path !== 'string' || !packagePath(file.path)) {
      invalid(`匯出檔含有不支援的路徑：${typeof file?.path === 'string' ? file.path : '(無效)'}`);
    }
    if (!Number.isSafeInteger(file.size) || file.size! < 0 || file.size! > FILE_LIMIT) invalid(`匯出檔中的檔案大小無效或超過 64 MiB：${file.path}`);
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(file.sha256)) invalid(`匯出檔中的校驗碼無效：${file.path}`);
    const key = file.path.toLocaleLowerCase('en-US');
    if (seen.has(key)) invalid('匯出檔含有重複或只差大小寫的路徑。');
    seen.add(key);
  }
  const summary = value.summary;
  const source = value.source as Partial<PackageSource> | undefined;
  const sourceValid = !!source && typeof source === 'object' && typeof source.vaultId === 'string' && typeof source.machine === 'string';
  return {
    format: PACKAGE_FORMAT, formatVersion: formatVersion!,
    ...(typeof value.exportedAt === 'string' ? { exportedAt: value.exportedAt } : {}),
    ...(typeof value.createdBy === 'string' ? { createdBy: value.createdBy } : {}),
    ...(sourceValid ? { source: { vaultId: source.vaultId!, machine: source.machine! } } : {}),
    ...(summary && typeof summary === 'object' && [summary.documents, summary.subscriptions, summary.deletions].every(Number.isSafeInteger)
      ? { summary: { documents: summary.documents, subscriptions: summary.subscriptions, deletions: summary.deletions } } : {}),
    files: (value.files as ManifestFile[]).map(({ path: file, size, sha256 }) => ({ path: file, size, sha256 })),
  };
}

/** The total size of the files a package holds once unpacked. */
export function unpackedBytes(reader: PackageReader): number {
  return reader.manifest.files.reduce((sum, row) => sum + row.size, 0);
}

/**
 * Checks what a package holds before an import uses it: every document is a document of
 * its path, the settings files read as current settings, no document sits next to the deletion
 * record that would hide it, and no subscription next to its removal record (an export never
 * writes either pair).
 */
export async function checkPackageContent(reader: PackageReader): Promise<void> {
  const json = async (file: string) => (reader.has(file) ? JSON.parse((await reader.read(file)).toString('utf8')) as unknown : undefined);
  let records;
  try { records = deletionsFromJson(await json(DELETIONS_FILE)); } catch (error) {
    if (error instanceof CollectorError) throw error;
    invalid('匯出檔中的刪除紀錄格式無效。');
  }
  if (records.some((record) => reader.has(documentPath(record)))) invalid('匯出檔中同一份文件同時有內容與刪除紀錄。');
  const types = [];
  try {
    for (const definition of subscriptionDefinitions()) {
      const file = await json(definition.storage!.subscriptionsFile);
      types.push({ subscriptions: subscriptionsFromJson(definition, file), removals: removalsFromJson(definition, file) });
    }
    scheduleEnabledFromJson(await json(scheduleFile()));
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    invalid('匯出檔中的訂閱或排程設定格式無效。');
  }
  // A subscription ID is unique within its type.
  for (const { subscriptions, removals } of types) {
    const ids = new Set<string>();
    for (const subscription of subscriptions) {
      if (ids.has(subscription.id)) invalid(`匯出檔中的訂閱 ID 重複：${subscription.id}`);
      ids.add(subscription.id);
    }
    const removed = new Set<string>();
    for (const record of removals) {
      if (ids.has(record.id) || removed.has(record.id)) invalid(`匯出檔中的訂閱與移除紀錄重複：${record.id}`);
      removed.add(record.id);
    }
  }
  for (const file of reader.paths()) {
    const key = documentKeyFromPath(file);
    if (!key) continue;
    const bytes = await reader.read(file);
    let document;
    try { document = parseDocument(bytes.toString('utf8')); } catch { invalid(`匯出檔中的文件格式無效：${file}`); }
    if (document.id !== documentId(key) || document.sourceType !== key.sourceType || document.sourceId !== key.sourceId
      || typeof document.title !== 'string' || typeof document.publisher?.name !== 'string'
      || typeof document.collectedAt !== 'string' || typeof document.sourceUrl !== 'string') {
      invalid(`匯出檔中的文件格式無效：${file}`);
    }
  }
}

/** Writes the files of a checked package into `destination`, a new private folder. */
export async function unpackPackage(
  reader: PackageReader, destination: string, progress: (done: number, total: number) => void,
): Promise<void> {
  const files = reader.paths();
  for (const [index, file] of files.entries()) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await reader.extract(file, target);
    progress(index + 1, files.length);
  }
}

/** The registered files of a Vault as one side of an import. */
export function registeredSource(registered: RegisteredFiles): FileSource {
  const files = new Map(registered.files.map((file) => [file.path, file]));
  return {
    paths: () => files.keys(),
    has: (file) => files.has(file),
    read: async (file) => {
      const entry = files.get(file);
      if (!entry) throw new Error(`Not a registered file: ${file}`);
      return entry.bytes ?? readFile(entry.absolute!);
    },
  };
}
