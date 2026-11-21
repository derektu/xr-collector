import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError } from '../../shared/lib/collector-error.js';
import { VAULT_MARKER } from './vault-directory.js';
import { errorCode } from './errno.js';

function invalid(message: string): never {
  throw new CollectorError('invalid_request', message);
}

// On a case-insensitive volume (the macOS and Windows defaults), realpath returns the spelling stored
// on disk, so two spellings of one folder resolve to the same location.
async function resolved(target: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export async function isWithin(target: string, folder: string): Promise<boolean> {
  const relative = path.relative(await resolved(folder), await resolved(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const STAGING = /\.importing-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isWorkFolder(folder: string): boolean {
  return STAGING.test(path.basename(path.resolve(folder)));
}

export interface ProtectedFolders { vaultRoot: string; profilePath: string }

async function refuseProtected(target: string, folders: ProtectedFolders, what: string): Promise<void> {
  if (await isWithin(target, folders.vaultRoot)) invalid(`${what}不能放在目前的知識庫裡。`);
  if (await isWithin(target, folders.profilePath)) invalid(`${what}不能放在程式資料目錄裡。`);
}

function absolute(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) invalid(message);
  return path.normalize(value);
}

export async function checkPackageFile(value: unknown): Promise<string> {
  const file = absolute(value, '請提供匯出檔的完整路徑。');
  if (!/\.zip$/iu.test(file)) invalid('只能匯入 XR Collector 的 .zip 匯出檔。');
  let info;
  try { info = await stat(file); } catch { invalid('找不到這個匯出檔。'); }
  if (!info.isFile()) invalid('這個路徑不是檔案。');
  return file;
}

export async function checkExportFile(value: unknown, overwrite: boolean, folders: ProtectedFolders): Promise<string> {
  const file = absolute(value, '請提供匯出檔的完整路徑。');
  if (!/\.zip$/iu.test(file)) invalid('匯出檔名必須以 .zip 結尾。');
  await refuseProtected(file, folders, '匯出檔');
  let parent;
  try { parent = await stat(path.dirname(file)); } catch { invalid('匯出檔所在的資料夾不存在。'); }
  if (!parent.isDirectory()) invalid('匯出檔所在的資料夾不存在。');
  try {
    const existing = await lstat(file);
    if (!existing.isFile()) invalid('這個路徑已有資料夾或其他項目，請換一個檔名。');
    if (!overwrite) throw new CollectorError('file_exists', `「${path.basename(file)}」已經存在。要取代它，請確認覆寫。`);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  return file;
}

export const EXPORT_FOLDER_NAME = 'XR Collector 匯出';

/**
 * The default export folder: `XR_COLLECTOR_EXPORT_DIR` when set, otherwise `XR Collector 匯出` in
 * `documents`. `paths` joins with the separators of the platform the folder is on.
 */
export function exportFolder(documents: string, paths: Pick<typeof path, 'join'> = path): string {
  const configured = process.env.XR_COLLECTOR_EXPORT_DIR?.trim();
  return configured ? path.resolve(configured) : paths.join(documents, EXPORT_FOLDER_NAME);
}

export const BACKUP_FOLDER_NAME = 'XR Collector 備份';

/**
 * The backup folder: `XR_COLLECTOR_BACKUP_DIR` when set, otherwise `XR Collector 備份` in `documents`.
 * `paths` joins with the separators of the platform the folder is on.
 */
export function backupFolder(documents: string, paths: Pick<typeof path, 'join'> = path): string {
  const configured = process.env.XR_COLLECTOR_BACKUP_DIR?.trim();
  return configured ? path.resolve(configured) : paths.join(documents, BACKUP_FOLDER_NAME);
}

const pad = (value: number) => String(value).padStart(2, '0');
const localDay = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** "XR Collector 匯出 2026-10-19.zip", in local time. */
export function exportFileName(now: Date): string {
  return `XR Collector 匯出 ${localDay(now)}.zip`;
}

export function backupFileName(now: Date): string {
  return `匯入前備份 ${localDay(now)} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`;
}

/**
 * Writes a file through a temporary file beside it, so the named file is either whole or untouched.
 * rename(2) replaces an existing target atomically: https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html
 */
async function writeAtomically(file: string, bytes: Buffer): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function checkImportFolder(value: unknown): Promise<string> {
  const folder = absolute(value, '請提供新知識庫的完整路徑。');
  if (isWorkFolder(folder)) invalid('這是匯入使用的暫存資料夾，請選擇其他位置。');
  try {
    await lstat(folder);
    invalid(`這個位置已經有「${path.basename(folder)}」，請換個名稱。`);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  let parent;
  try { parent = await stat(path.dirname(folder)); } catch { invalid('找不到新知識庫所在的資料夾。'); }
  if (!parent.isDirectory()) invalid('找不到新知識庫所在的資料夾。');
  return folder;
}

export function stagingFolder(folder: string): string {
  return `${folder}.importing-${randomUUID()}`;
}

export const IMPORT_JOURNAL = 'vault-import-journal.json';

export interface ImportJournal {
  staging: string;
  target: string;
  placed: boolean;
  marker: string | null;
}

export async function writeImportJournal(profilePath: string, journal: ImportJournal): Promise<void> {
  await mkdir(profilePath, { recursive: true });
  await writeAtomically(path.join(profilePath, IMPORT_JOURNAL), Buffer.from(JSON.stringify(journal)));
}

export async function clearImportJournal(profilePath: string): Promise<void> {
  await rm(path.join(profilePath, IMPORT_JOURNAL), { force: true });
}

export async function markerDigest(folder: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await readFile(path.join(folder, VAULT_MARKER))).digest('hex');
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return null;
    throw error;
  }
}

export async function recoverImport(profilePath: string, kept: readonly (string | null)[]): Promise<string[]> {
  let journal: Partial<ImportJournal> | null;
  try {
    journal = JSON.parse(await readFile(path.join(profilePath, IMPORT_JOURNAL), 'utf8')) as Partial<ImportJournal>;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
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
      removed.push(target);
    }
  }
  await clearImportJournal(profilePath);
  return removed;
}

export async function isEmptyFolder(folder: string): Promise<boolean> {
  try { return (await readdir(folder)).length === 0; } catch { return false; }
}
