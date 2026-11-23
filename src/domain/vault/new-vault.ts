import { constants } from 'node:fs';
import { access, lstat, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { NewVaultCheck, PackageDescription } from '../../shared/vault/vault-types.js';
import { checkPackageFile, isWithin, isWorkFolder } from './transfer-files.js';
import { writeVaultMarker } from './vault-directory.js';
import { openPackage } from './vault-package.js';
import { errorCode } from './errno.js';

export const DEFAULT_VAULT_NAME = 'XR Collector';

/** Characters no folder name may hold on macOS or Windows; see https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file#naming-conventions. */
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/u;
/** Device names Windows reserves, with or without an extension; see https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file#naming-conventions. */
const RESERVED = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu;
const NAME_BYTES = 255;

export function nameProblem(name: string): string | null {
  if (!name.trim()) return '請輸入名稱。';
  if (FORBIDDEN.test(name)) return '名稱不能包含 \\ / : * ? " < > | 等字元。';
  if (name !== name.trim()) return '名稱的開頭和結尾不能是空白。';
  if (name.startsWith('.')) return '名稱不能以句點開頭。';
  if (name.endsWith('.')) return '名稱不能以句點結尾。';
  if (RESERVED.test(name)) return `「${name}」是系統保留的名稱，請換個名稱。`;
  if (Buffer.byteLength(name, 'utf8') > NAME_BYTES) return '名稱太長。';
  return null;
}

export interface AppFolders { vaultRoot?: string | undefined; profilePath: string }

export async function checkNewVault(location: unknown, name: unknown, folders?: AppFolders): Promise<NewVaultCheck> {
  if (typeof location !== 'string' || !location.trim()) return { path: null, problem: '請選擇位置。' };
  if (!path.isAbsolute(location)) return { path: null, problem: '位置必須是完整的絕對路徑。' };
  if (typeof name !== 'string') return { path: null, problem: '請輸入名稱。' };
  const parent = path.resolve(location);
  const problem = nameProblem(name);
  if (problem) return { path: null, problem };
  const target = path.join(parent, name);
  if (isWorkFolder(target)) return { path: target, problem: '這是匯入使用的暫存資料夾名稱，請換個名稱。' };
  try {
    if (!(await stat(parent)).isDirectory()) return { path: target, problem: '位置不是資料夾。' };
  } catch (error) {
    return { path: target, problem: errorCode(error) === 'ENOENT' ? '找不到這個位置。' : '無法讀取這個位置。' };
  }
  try {
    await lstat(target);
    return { path: target, problem: `這個位置已經有「${name}」，請換個名稱。` };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return { path: target, problem: '無法讀取這個位置。' };
  }
  if (folders?.vaultRoot && await isWithin(target, folders.vaultRoot)) return { path: target, problem: '不能建立在目前的知識庫裡。' };
  if (folders && await isWithin(target, folders.profilePath)) return { path: target, problem: '不能建立在程式資料目錄裡。' };
  try {
    await access(parent, constants.W_OK);
  } catch {
    return { path: target, problem: '沒有權限在這個位置建立資料夾。' };
  }
  return { path: target, problem: null };
}

export async function newVaultFolder(location: unknown, name: unknown, folders?: AppFolders): Promise<string> {
  const checked = await checkNewVault(location, name, folders);
  if (checked.problem || !checked.path) throw new CollectorError('vault_invalid', checked.problem ?? '請選擇位置並輸入名稱。');
  return checked.path;
}

export async function createNewVault(location: unknown, name: unknown, createdBy: string, sources: SourceRegistry, folders?: AppFolders): Promise<string> {
  const target = await newVaultFolder(location, name, folders);
  try {
    await mkdir(target);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw new CollectorError('vault_invalid', `這個位置已經有「${path.basename(target)}」，請換個名稱。`);
    throw new CollectorError('vault_invalid', `無法建立資料夾（${errorCode(error) ?? '未知錯誤'}）。`);
  }
  try {
    await writeVaultMarker(target, createdBy, sources);
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw new CollectorError('vault_invalid', `無法建立知識庫（${errorCode(error) ?? '未知錯誤'}）。`, { cause: error });
  }
  return target;
}

export async function describePackage(file: unknown, sources: SourceRegistry): Promise<PackageDescription> {
  const checked = await checkPackageFile(file);
  const reader = await openPackage(checked, sources);
  try {
    const { exportedAt, source, summary } = reader.manifest;
    const folderName = source?.folderName && !nameProblem(source.folderName) ? source.folderName : DEFAULT_VAULT_NAME;
    return {
      path: checked, fileName: path.basename(checked), exportedAt: exportedAt ?? null,
      documents: summary?.documents ?? 0, subscriptions: summary?.subscriptions ?? 0, folderName,
    };
  } finally {
    reader.close();
  }
}
