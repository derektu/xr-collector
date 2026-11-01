import { constants } from 'node:fs';
import { access, lstat, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError, type NewVaultCheck, type PackageDescription } from '../core/types.js';
import { checkPackageFile, isWithin, isWorkFolder } from './transfer-files.js';
import { writeVaultMarker } from './vault-directory.js';
import { openPackage } from './vault-package.js';

/** Name of a new Vault folder when the person gives none, and of one created from an export that records none. */
export const DEFAULT_VAULT_NAME = 'XR Collector';

/** Characters no folder name may hold on macOS or Windows. */
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/u;
/** Device names Windows reserves, with or without an extension. */
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const NAME_BYTES = 255;

/**
 * Why `name` cannot name a Vault folder, or null when it can. The rules are those of both desktop
 * platforms, so a Vault folder keeps its name when the Vault is copied to the other one.
 */
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

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Folders the app keeps its own files in, where no new Vault goes: the active Vault, if any, and the profile. */
export interface AppFolders { vaultRoot?: string | undefined; profilePath: string }

/**
 * Checks a new Vault folder named `name` inside the folder `location`: the location exists and can be
 * written, outside the app's own `folders`, the name can name a folder, and nothing of that name is
 * in the location yet. `path` is the folder that would be created, null when the input names none.
 */
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

/** The folder a new Vault goes in, or the reason it cannot be created as a `vault_invalid` error. */
export async function newVaultFolder(location: unknown, name: unknown, folders?: AppFolders): Promise<string> {
  const checked = await checkNewVault(location, name, folders);
  if (checked.problem || !checked.path) throw new CollectorError('vault_invalid', checked.problem ?? '請選擇位置並輸入名稱。');
  return checked.path;
}

/** Creates the folder `name` in `location` as a new, empty Vault and returns its path; see `checkNewVault`. */
export async function createNewVault(location: unknown, name: unknown, createdBy: string, folders?: AppFolders): Promise<string> {
  const target = await newVaultFolder(location, name, folders);
  try {
    await mkdir(target);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw new CollectorError('vault_invalid', `這個位置已經有「${path.basename(target)}」，請換個名稱。`);
    throw new CollectorError('vault_invalid', `無法建立資料夾（${errorCode(error) ?? '未知錯誤'}）。`);
  }
  try {
    await writeVaultMarker(target, createdBy);
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw new CollectorError('vault_invalid', `無法建立知識庫（${errorCode(error) ?? '未知錯誤'}）。`, { cause: error });
  }
  return target;
}

/**
 * What an export file holds, read from its manifest once its structure is checked. Creating a Vault
 * from the file checks every document again.
 */
export async function describePackage(file: unknown): Promise<PackageDescription> {
  const checked = await checkPackageFile(file);
  const reader = await openPackage(checked);
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
