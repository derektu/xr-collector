import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError } from '../core/types.js';
import { inspectVaultDirectory, VAULT_MARKER } from './vault-directory.js';

/**
 * Local files of Vault export and import: export files a person or Agent names by path, the export
 * folder and its file names, the folder an import from Onboarding creates, and the profile record
 * of that import while it runs.
 */

const invalid = (message: string): never => { throw new CollectorError('invalid_request', message); };

/** Resolves symbolic links of an existing path, as `fs.realpath` does; tests replace it to stand for another file system. */
export type RealPath = (target: string) => Promise<string>;

/**
 * The real location of a path, resolving symbolic links of whichever ancestors exist. On a
 * case-insensitive volume the real path also carries the spelling stored on disk, so two spellings
 * of one folder resolve to the same location.
 */
export async function resolved(target: string, real: RealPath = realpath): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await real(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Whether `target` is `folder` or inside it, after resolving symbolic links. */
export async function isWithin(target: string, folder: string, real: RealPath = realpath): Promise<boolean> {
  const relative = path.relative(await resolved(folder, real), await resolved(target, real));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const WORK_FOLDER = /\.(?:moving|moved|importing)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Whether a folder carries the name of a move's or import's working folder (`.moving-<UUID>`,
 * `.moved-<UUID>`, `.importing-<UUID>`). Recovery at startup deletes such folders, so they never
 * become a Vault in use, a move target or an import target.
 */
export function isWorkFolder(folder: string): boolean {
  return WORK_FOLDER.test(path.basename(path.resolve(folder)));
}

/** Folders an export file may not be placed in: the active Vault and the profile. */
export interface ProtectedFolders { vaultRoot: string; profilePath: string }

async function refuseProtected(target: string, folders: ProtectedFolders, what: string): Promise<void> {
  if (await isWithin(target, folders.vaultRoot)) invalid(`${what}不能放在目前的知識庫裡。`);
  if (await isWithin(target, folders.profilePath)) invalid(`${what}不能放在程式資料目錄裡。`);
}

function absolute(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) invalid(message);
  return path.normalize(value as string);
}

/** Checks an export file a caller named by its absolute path (a `.zip` file) and returns that path. */
export async function checkPackageFile(value: unknown): Promise<string> {
  const file = absolute(value, '請提供匯出檔的完整路徑。');
  if (!/\.zip$/iu.test(file)) invalid('只能匯入 XR Collector 的 .zip 匯出檔。');
  let info;
  try { info = await stat(file); } catch { invalid('找不到這個匯出檔。'); }
  if (!info!.isFile()) invalid('這個路徑不是檔案。');
  return file;
}

/**
 * Checks where an export may be written: an absolute `.zip` path in an existing folder, outside the
 * active Vault and the profile. An existing file is replaced only with `overwrite`.
 */
export async function checkExportFile(value: unknown, overwrite: boolean, folders: ProtectedFolders): Promise<string> {
  const file = absolute(value, '請提供匯出檔的完整路徑。');
  if (!/\.zip$/iu.test(file)) invalid('匯出檔名必須以 .zip 結尾。');
  await refuseProtected(file, folders, '匯出檔');
  let parent;
  try { parent = await stat(path.dirname(file)); } catch { invalid('匯出檔所在的資料夾不存在。'); }
  if (!parent!.isDirectory()) invalid('匯出檔所在的資料夾不存在。');
  try {
    const existing = await lstat(file);
    if (!existing.isFile()) invalid('這個路徑已有資料夾或其他項目，請換一個檔名。');
    if (!overwrite) throw new CollectorError('file_exists', `「${path.basename(file)}」已經存在。要取代它，請確認覆寫。`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return file;
}

/** Name of the folder exports go to by default, inside the person's Documents folder. */
export const EXPORT_FOLDER_NAME = 'XR Collector 匯出';

/**
 * The default export folder: `XR_COLLECTOR_EXPORT_DIR` when set, otherwise `XR Collector 匯出` in
 * `documents`. `paths` joins with the separators of the platform the folder is on.
 */
export function exportFolder(documents: string, paths: Pick<typeof path, 'join'> = path): string {
  const configured = process.env.XR_COLLECTOR_EXPORT_DIR?.trim();
  return configured ? path.resolve(configured) : paths.join(documents, EXPORT_FOLDER_NAME);
}

const pad = (value: number) => String(value).padStart(2, '0');
const localDay = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** "XR Collector 匯出 2026-10-19.zip", in local time. */
export function exportFileName(now: Date): string {
  return `XR Collector 匯出 ${localDay(now)}.zip`;
}

/** "XR Collector 匯入前 2026-10-19 143005.zip", in local time: the export an import takes before it applies. */
export function preImportFileName(now: Date): string {
  return `XR Collector 匯入前 ${localDay(now)} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`;
}

/** Writes a file through a temporary file beside it, so the named file is either whole or untouched. */
export async function writeAtomically(file: string, bytes: Buffer): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Checks the folder an import from Onboarding creates its Vault in: an absolute path that does not
 * exist yet or is an empty folder, and not a working folder of a move or import.
 */
export async function checkImportFolder(value: unknown): Promise<string> {
  const folder = absolute(value, '請提供新知識庫的完整路徑。');
  if (isWorkFolder(folder)) invalid('這是搬移或匯入使用的暫存資料夾，請選擇其他位置。');
  const inspection = await inspectVaultDirectory(folder);
  if (inspection.kind === 'invalid') invalid(inspection.reason);
  if (inspection.kind !== 'empty') invalid('這個資料夾已經有內容，請選擇不存在或空的資料夾。');
  return inspection.path;
}

const STAGING = /\.importing-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The temporary folder an import from Onboarding unpacks into, beside the folder it becomes. */
export function stagingFolder(folder: string): string {
  return `${folder}.importing-${randomUUID()}`;
}

/**
 * Profile record of an import from Onboarding in progress, kept until the device selection names
 * the new Vault:
 * `{ "staging": "<path>", "target": "<path>", "placed": <boolean>, "marker": "<sha256>", "emptyTarget": <boolean> }`.
 * The import unpacks into the staging folder and renames it to the target once it is complete.
 * `placed` is set just before that rename; `marker` is the digest of the Vault marker the import
 * wrote, which tells the new folder apart from anything else at the target path, and `emptyTarget`
 * says the target was an empty folder the import replaced.
 */
export const IMPORT_JOURNAL = 'vault-import-journal.json';

export interface ImportJournal {
  staging: string;
  target: string;
  placed: boolean;
  marker: string | null;
  emptyTarget: boolean;
}

export async function writeImportJournal(profilePath: string, journal: ImportJournal): Promise<void> {
  await mkdir(profilePath, { recursive: true });
  await writeAtomically(path.join(profilePath, IMPORT_JOURNAL), Buffer.from(JSON.stringify(journal)));
}

export async function clearImportJournal(profilePath: string): Promise<void> {
  await rm(path.join(profilePath, IMPORT_JOURNAL), { force: true });
}

/** The digest of a Vault's marker file, or null when it has none. */
export async function markerDigest(folder: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await readFile(path.join(folder, VAULT_MARKER))).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * Takes back an import from Onboarding a stop interrupted, unless `kept` names its target (the
 * device selection and the Vault being opened): the staging folder is removed, and a target folder
 * whose marker is the one the import wrote is renamed back to a staging name and removed, leaving
 * an empty folder where the import found one. Only folders named like an import's staging folder
 * and a target carrying the import's own marker are touched; a journal naming anything else is
 * dropped without touching it. Returns the folders removed.
 */
export async function recoverImport(profilePath: string, kept: readonly (string | null)[]): Promise<string[]> {
  let journal: Partial<ImportJournal> | null;
  try {
    journal = JSON.parse(await readFile(path.join(profilePath, IMPORT_JOURNAL), 'utf8')) as Partial<ImportJournal>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    journal = null;
  }
  const removed: string[] = [];
  const staging = journal?.staging;
  if (typeof staging === 'string' && path.isAbsolute(staging) && STAGING.test(staging)) {
    await rm(staging, { recursive: true, force: true });
    removed.push(staging);
    const target = journal?.target;
    if (journal?.placed === true && typeof target === 'string' && path.isAbsolute(target)
      && staging.startsWith(`${target}.importing-`) && !kept.includes(target)
      && typeof journal.marker === 'string' && await markerDigest(target) === journal.marker) {
      await rename(target, staging);
      await rm(staging, { recursive: true, force: true });
      if (journal.emptyTarget === true) await mkdir(target);
      removed.push(target);
    }
  }
  await clearImportJournal(profilePath);
  return removed;
}

/** Whether a folder exists and holds nothing. */
export async function isEmptyFolder(folder: string): Promise<boolean> {
  try { return (await readdir(folder)).length === 0; } catch { return false; }
}
