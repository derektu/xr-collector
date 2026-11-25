import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError } from '../../shared/lib/collector-error.js';
import { errorCode } from './errno.js';

function invalid(message: string): never {
  throw new CollectorError('invalid_request', message);
}

// On a case-insensitive volume (the macOS and Windows defaults), realpath returns the spelling stored
// on disk, so two spellings of one folder resolve to the same location.
const real = (folder: string) => realpath(folder).catch(() => path.resolve(folder));

export async function isSameFolder(one: string, other: string): Promise<boolean> {
  return await real(one) === await real(other);
}

export async function isWithin(target: string, folder: string): Promise<boolean> {
  const relative = path.relative(await real(folder), await real(target));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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

export async function checkExportFile(value: unknown, overwrite: boolean): Promise<string> {
  const file = absolute(value, '請提供匯出檔的完整路徑。');
  if (!/\.zip$/iu.test(file)) invalid('匯出檔名必須以 .zip 結尾。');
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

export function exportFolder(documents: string, paths: Pick<typeof path, 'join'> = path): string {
  const configured = process.env.XR_COLLECTOR_EXPORT_DIR?.trim();
  return configured ? path.resolve(configured) : paths.join(documents, EXPORT_FOLDER_NAME);
}

export const BACKUP_FOLDER_NAME = 'XR Collector 備份';

export function backupFolder(documents: string, paths: Pick<typeof path, 'join'> = path): string {
  const configured = process.env.XR_COLLECTOR_BACKUP_DIR?.trim();
  return configured ? path.resolve(configured) : paths.join(documents, BACKUP_FOLDER_NAME);
}

const pad = (value: number) => String(value).padStart(2, '0');
const localDay = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export function exportFileName(now: Date): string {
  return `XR Collector 匯出 ${localDay(now)}.zip`;
}

export function backupFileName(now: Date): string {
  return `匯入前備份 ${localDay(now)} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`;
}

export async function checkImportFolder(value: unknown): Promise<string> {
  const folder = absolute(value, '請提供新知識庫的完整路徑。');
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
