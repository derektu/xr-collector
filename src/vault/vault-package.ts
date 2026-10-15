import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError } from '../core/types.js';
import { MarkdownVault } from './markdown-vault.js';
import { JsonChannelStore } from '../channels/json-channel-store.js';
import { JsonChannelScheduleStore } from '../channels/json-channel-schedule-store.js';
import { migrateSubscriptionSettings } from '../channels/subscription-files.js';
import { DELETIONS_FILE, deletionsFromJson, deletionsToJson } from './deleted-documents.js';
import { documentId, documentKeyFromPath, documentPath, documentPathFromId } from './document-paths.js';
import { CHANNELS_FILE, channelsFromJson, SCHEDULE_FILE } from '../channels/subscription-files.js';

export const PACKAGE_LIMIT = 128 * 1024 * 1024;
const CONTENT_LIMIT = 80 * 1024 * 1024;
const FILE_LIMIT = 10_000;
interface Entry { path: string; size: number; sha256: string; data: string }
/**
 * Version 3 packages carry deletion records (`settings/deleted-documents.json`) next to
 * subscriptions with their own collection settings. Version 2 packages have no deletion records;
 * version 1 packages also share one set of collection settings in the schedule file, and their
 * Vault is converted after unpacking. A program that reads up to version 2 refuses a version 3
 * package, so it never restores a Vault while silently dropping its deletions.
 */
interface VaultPackage extends PackageInfo { format: 'xr-collector-vault'; version: 1 | 2 | 3; files: Entry[]; sha256: string }

/**
 * Optional description of a package for people choosing it: when and by which program it was
 * written and what it holds. The manifest digest does not cover it and a reader that does not know
 * these fields ignores them, so they never decide whether a package is valid.
 */
export interface PackageInfo {
  exportedAt?: string;
  createdBy?: string;
  summary?: { documents: number; subscriptions: number; deletions: number };
}
const PACKAGE_VERSION = 3;
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const manifestDigest = (files: Entry[]) => digest(JSON.stringify(files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))));

function invalid(message: string): never {
  throw new CollectorError('invalid_request', message);
}

export function safePath(value: string): boolean {
  if (value.length > 500 || value !== value.normalize('NFC')) return false;
  const segments = value.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..'
    || /[\\\x00-\x1f\x7f:<>"|?*]/u.test(part) || /[. ]$/u.test(part)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part))) return false;
  return documentKeyFromPath(value) !== null
    || /^(settings\/youtube-(channels|schedule)\.json|settings\/deleted-documents\.json)$/u.test(value)
    || /^(attachments|versions|management)\/.+/u.test(value);
}

/**
 * Packs the portable data of a Vault. Deletion records and document files go through the same
 * visibility rule as `MarkdownVault.list`: a document file a deletion hides stays out, and a record
 * whose document is newer stays out, so a package never holds a document next to the record that
 * hides it, even while a deletion is unfinished.
 *
 * `info` describes a package written for people; packages this program writes for its own
 * comparisons leave it out, so two exports of unchanged data are byte for byte equal.
 */
export async function exportVault(root: string, info: { createdBy?: string; exportedAt?: Date } = {}): Promise<Buffer> {
  const files: Entry[] = [];
  let total = 0;
  const portable = await new MarkdownVault(root).portableDeletions();
  const hiddenPaths = new Set([...portable.hidden].map(documentPathFromId).filter((file): file is string => file !== null));
  async function visit(relative: string): Promise<void> {
    const absolute = path.join(root, relative);
    let stat;
    try { stat = await lstat(absolute); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) invalid('Vault 含有符號連結，無法安全匯出。');
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) {
        if (name === '.DS_Store') continue;
        await visit(relative ? `${relative}/${name}` : name);
      }
      return;
    }
    if (!stat.isFile() || !safePath(relative)) invalid(`Vault 檔案路徑不支援：${relative}`);
    if (hiddenPaths.has(relative)) return;
    if (++total > FILE_LIMIT) invalid('資料包檔案數超過 10000。');
    if (stat.size > CONTENT_LIMIT) invalid('資料包內容超過 80 MiB。');
    let data = await readFile(absolute);
    if (relative === DELETIONS_FILE) {
      const stored = deletionsFromJson(JSON.parse(data.toString('utf8')));
      if (stored.length !== portable.records.length) data = Buffer.from(`${JSON.stringify(deletionsToJson(portable.records), null, 2)}\n`);
    }
    files.push({ path: relative, size: data.length, sha256: digest(data), data: data.toString('base64') });
    if (files.reduce((sum, file) => sum + file.size, 0) > CONTENT_LIMIT) invalid('資料包內容超過 80 MiB。');
  }
  // Only portable vault data belongs in the package; local credentials and indexes live outside it.
  for (const directory of ['documents', 'attachments', 'versions', 'management']) await visit(directory);
  try {
    if ((await lstat(path.join(root, 'settings'))).isSymbolicLink()) invalid('Vault 含有符號連結，無法安全匯出。');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const name of ['youtube-channels.json', 'youtube-schedule.json', 'deleted-documents.json']) await visit(`settings/${name}`);
  const byPath = new Map(files.map((file) => [file.path, Buffer.from(file.data, 'base64')]));
  const json = (file: string) => { const bytes = byPath.get(file); return bytes ? JSON.parse(bytes.toString('utf8')) as unknown : undefined; };
  // The summary only describes the package; settings it cannot read leave it out instead of failing the export.
  let summary: VaultPackage['summary'];
  try {
    summary = {
      documents: files.filter((file) => documentKeyFromPath(file.path)).length,
      subscriptions: channelsFromJson(json(CHANNELS_FILE), json(SCHEDULE_FILE)).length,
      deletions: deletionsFromJson(json(DELETIONS_FILE)).length,
    };
  } catch {
    summary = undefined;
  }
  const result: VaultPackage = {
    format: 'xr-collector-vault', version: PACKAGE_VERSION,
    ...(info.exportedAt ? { exportedAt: info.exportedAt.toISOString() } : {}), ...(info.createdBy ? { createdBy: info.createdBy } : {}),
    ...(summary ? { summary } : {}),
    files, sha256: manifestDigest(files),
  };
  const buffer = Buffer.from(JSON.stringify(result));
  if (buffer.length > PACKAGE_LIMIT) invalid('資料包超過 128 MiB。');
  return buffer;
}

/** The description fields of a package, without checking its files. */
export function packageInfo(buffer: Buffer): PackageInfo & { version: number } {
  const parsed = JSON.parse(buffer.toString('utf8')) as Partial<VaultPackage>;
  const summary = parsed.summary;
  return {
    version: Number(parsed.version),
    ...(typeof parsed.exportedAt === 'string' ? { exportedAt: parsed.exportedAt } : {}),
    ...(typeof parsed.createdBy === 'string' ? { createdBy: parsed.createdBy } : {}),
    ...(summary && typeof summary === 'object' && [summary.documents, summary.subscriptions, summary.deletions].every(Number.isSafeInteger)
      ? { summary: { documents: summary.documents, subscriptions: summary.subscriptions, deletions: summary.deletions } } : {}),
  };
}

export interface UnpackOptions {
  /** Pause automatic collection in the unpacked Vault; a restored Vault starts paused. */
  pauseSchedule?: boolean;
  /**
   * The package is a backup this program wrote before a merge. Its data is checked for format but
   * not for agreement between documents and deletion records, so a rollback always restores it.
   */
  recovery?: boolean;
}

export async function unpackVault(
  buffer: Buffer, destination: string, progress: (done: number, total: number) => void, options: UnpackOptions = {},
): Promise<void> {
  const { pauseSchedule = true, recovery = false } = options;
  if (buffer.length > PACKAGE_LIMIT) invalid('資料包超過 128 MiB。');
  let parsed: VaultPackage;
  try { parsed = JSON.parse(buffer.toString('utf8')) as VaultPackage; } catch { invalid('資料包不是有效的 JSON。'); }
  if (!parsed || parsed.format !== 'xr-collector-vault' || ![1, 2, 3].includes(parsed.version) || !Array.isArray(parsed.files)
    || parsed.files.length > FILE_LIMIT) invalid('不支援的資料包格式或版本。');
  const seen = new Set<string>();
  const decoded: { path: string; bytes: Buffer }[] = [];
  let size = 0;
  for (const entry of parsed.files) {
    if (!entry || typeof entry.path !== 'string' || !safePath(entry.path)
      || typeof entry.data !== 'string' || typeof entry.sha256 !== 'string'
      || !Number.isSafeInteger(entry.size) || entry.size < 0) invalid('資料包含有無效檔案或不安全路徑。');
    const key = entry.path.toLocaleLowerCase('en-US');
    if (seen.has(key)) invalid('資料包含有重複或大小寫衝突路徑。');
    seen.add(key);
    const bytes = Buffer.from(entry.data, 'base64');
    if (bytes.toString('base64') !== entry.data || bytes.length !== entry.size || digest(bytes) !== entry.sha256) {
      invalid('資料包檔案內容不完整或校驗失敗。');
    }
    size += bytes.length;
    if (size > CONTENT_LIMIT) invalid('資料包內容超過 80 MiB。');
    decoded.push({ path: entry.path, bytes });
  }
  if (parsed.sha256 !== manifestDigest(parsed.files)) invalid('資料包清單校驗失敗。');
  const deletions = decoded.find((entry) => entry.path === DELETIONS_FILE);
  if (deletions) {
    if (parsed.version < 3) invalid('資料包版本不含刪除紀錄，卻帶有刪除紀錄檔。');
    let records;
    try { records = deletionsFromJson(JSON.parse(deletions.bytes.toString('utf8'))); } catch { invalid('資料包中的刪除紀錄格式無效。'); }
    // An export leaves out documents their deletion hides, so a package holding both is inconsistent.
    const documents = new Set(decoded.map((entry) => entry.path));
    if (!recovery && records.some((record) => documents.has(documentPath(record)))) {
      invalid('資料包中同一份文件同時有內容與刪除紀錄。');
    }
  }
  for (const key of seen) {
    const parts = key.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (seen.has(parts.join('/'))) invalid('資料包檔案與目錄路徑衝突。');
    }
  }
  // destination is a newly created private directory, never a user-selected existing vault.
  for (const [index, entry] of decoded.entries()) {
    const target = path.join(destination, entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.bytes, { flag: 'wx', mode: 0o600 });
    progress(index + 1, decoded.length);
  }
  try {
    const vault = new MarkdownVault(destination);
    const documents = await vault.list();
    const { hidden } = await vault.portableDeletions();
    const expectedDocuments = decoded.flatMap((entry) => {
      const key = documentKeyFromPath(entry.path);
      return key && !hidden.has(documentId(key)) ? [key] : [];
    });
    if (documents.length !== expectedDocuments.length) throw new Error('Document count mismatch');
    // The document parser checks the fields of each source type; this checks what every document shares.
    for (const key of expectedDocuments) {
      const doc = await vault.read(documentId(key));
      if (!doc || doc.id !== documentId(key) || doc.sourceType !== key.sourceType || doc.sourceId !== key.sourceId
        || typeof doc.type !== 'string' || typeof doc.title !== 'string' || typeof doc.publisher?.name !== 'string'
        || typeof doc.collectedAt !== 'string' || typeof doc.sourceUrl !== 'string') throw new Error('Invalid document');
    }
    await migrateSubscriptionSettings(destination);
    await new JsonChannelStore(destination).list();
    const store = new JsonChannelScheduleStore(destination);
    const schedule = await store.load();
    if (pauseSchedule) await store.save({ ...schedule, enabled: false });
  } catch {
    invalid('資料包中的文件、頻道或排程資料格式無效。');
  }
}
