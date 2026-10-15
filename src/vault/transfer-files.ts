import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError } from '../core/types.js';
import { inspectVaultDirectory } from './vault-directory.js';
import { PACKAGE_LIMIT } from './vault-package.js';

/**
 * Local files of Vault export, restore and merge: package files a person or Agent names by path,
 * the folder a restore creates, and the device records of both. Device records live in the profile,
 * never in a Vault, so exporting or restoring never changes the data it describes.
 */

const invalid = (message: string): never => { throw new CollectorError('invalid_request', message); };

/** The real location of a path, resolving symbolic links of whichever ancestors exist. */
async function resolved(target: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
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
export async function isWithin(target: string, folder: string): Promise<boolean> {
  const relative = path.relative(await resolved(folder), await resolved(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Folders a package file or restored Vault may not be placed in: the active Vault and the profile. */
export interface ProtectedFolders { vaultRoot: string; profilePath: string }

async function refuseProtected(target: string, folders: ProtectedFolders, what: string): Promise<void> {
  if (await isWithin(target, folders.vaultRoot)) invalid(`${what}不能放在目前的知識庫裡。`);
  if (await isWithin(target, folders.profilePath)) invalid(`${what}不能放在程式資料目錄裡。`);
}

function absolute(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) invalid(message);
  return path.normalize(value as string);
}

/** Reads a package file a caller named by its absolute path. */
export async function readPackageFile(value: unknown): Promise<Buffer> {
  const file = absolute(value, '請提供資料包檔案的完整路徑。');
  let info;
  try { info = await stat(file); } catch { invalid('找不到這個資料包檔案。'); }
  if (!info!.isFile()) invalid('這個路徑不是檔案。');
  if (info!.size > PACKAGE_LIMIT) invalid('資料包超過 128 MiB。');
  return readFile(file);
}

/**
 * Checks where an export may be written: an absolute `.xr-vault` path in an existing folder,
 * outside the active Vault and the profile. An existing file is replaced only with `overwrite`.
 */
export async function checkExportFile(value: unknown, overwrite: boolean, folders: ProtectedFolders): Promise<string> {
  const file = absolute(value, '請提供備份檔案的完整路徑。');
  if (!/\.xr-vault$/iu.test(file)) invalid('備份檔名必須以 .xr-vault 結尾。');
  await refuseProtected(file, folders, '備份檔案');
  let parent;
  try { parent = await stat(path.dirname(file)); } catch { invalid('備份檔案所在的資料夾不存在。'); }
  if (!parent!.isDirectory()) invalid('備份檔案所在的資料夾不存在。');
  try {
    const existing = await lstat(file);
    if (!existing.isFile()) invalid('這個路徑已有資料夾或其他項目，請換一個檔名。');
    if (!overwrite) invalid('這個檔案已經存在。要取代它，請確認覆寫。');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return file;
}

/** Writes a package through a temporary file beside it, so the named file is either whole or untouched. */
export async function writePackageFile(file: string, bytes: Buffer): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Checks the folder a restore creates its Vault in: an absolute path that does not exist yet or is
 * an empty folder, outside the active Vault and the profile.
 */
export async function checkRestoreFolder(value: unknown, folders: ProtectedFolders): Promise<string> {
  const folder = absolute(value, '請提供還原知識庫的完整路徑。');
  await refuseProtected(folder, folders, '還原的知識庫');
  if (await isWithin(folders.vaultRoot, folder)) invalid('還原的知識庫不能包含目前的知識庫。');
  const inspection = await inspectVaultDirectory(folder);
  if (inspection.kind === 'invalid') invalid(inspection.reason);
  if (inspection.kind !== 'empty') invalid('這個資料夾已經有內容，請選擇不存在或空的資料夾。');
  return folder;
}

/**
 * A free folder beside the active Vault, named after it and the date: "XR Collector 還原 2026-10-16".
 * A Vault that is itself a restore lends its original name, so names do not pile up.
 */
export async function suggestRestoreFolder(vaultRoot: string, now: Date): Promise<string> {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const name = path.basename(vaultRoot).replace(/ 還原 \d{4}-\d{2}-\d{2}(?: \(\d+\))?$/u, '');
  const base = path.join(path.dirname(vaultRoot), `${name} 還原 ${date}`);
  for (let index = 1; ; index += 1) {
    const candidate = index === 1 ? base : `${base} (${index})`;
    try { await lstat(candidate); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
      throw error;
    }
  }
}

const STAGING = /\.restoring-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The temporary folder a restore unpacks into, beside the folder it becomes. */
export function stagingFolder(folder: string): string {
  return `${folder}.restoring-${randomUUID()}`;
}

/**
 * Profile record of a restore in progress: `{ "staging": "<absolute path>" }`. A restore unpacks
 * into the staging folder and renames it to the chosen folder once it is complete, so a stop before
 * the rename leaves only the staging folder, which the next start removes.
 */
export const RESTORE_JOURNAL = 'vault-restore-journal.json';

export async function writeRestoreJournal(profilePath: string, staging: string): Promise<void> {
  await mkdir(profilePath, { recursive: true });
  await writePackageFile(path.join(profilePath, RESTORE_JOURNAL), Buffer.from(JSON.stringify({ staging })));
}

export async function clearRestoreJournal(profilePath: string): Promise<void> {
  await rm(path.join(profilePath, RESTORE_JOURNAL), { force: true });
}

/**
 * Removes the staging folder of a restore a stop interrupted. Only a folder whose name a restore
 * gives its staging folder is removed; a journal naming anything else is dropped without touching it.
 */
export async function recoverRestore(profilePath: string): Promise<string | null> {
  let staging: unknown;
  try {
    staging = (JSON.parse(await readFile(path.join(profilePath, RESTORE_JOURNAL), 'utf8')) as { staging?: unknown }).staging;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    staging = null;
  }
  let removed: string | null = null;
  if (typeof staging === 'string' && path.isAbsolute(staging) && STAGING.test(staging)) {
    await rm(staging, { recursive: true, force: true });
    removed = staging;
  }
  await clearRestoreJournal(profilePath);
  return removed;
}

/** Profile record of when each Vault was last exported: `{ "version": 1, "vaults": { "<path>": "<ISO time>" } }`. */
export const EXPORT_LOG = 'vault-exports.json';

export async function readLastExport(profilePath: string, vaultRoot: string): Promise<string | null> {
  const vaults = await readExportLog(profilePath);
  return vaults[vaultRoot] ?? null;
}

export async function recordExport(profilePath: string, vaultRoot: string, at: string): Promise<void> {
  const vaults = await readExportLog(profilePath);
  await mkdir(profilePath, { recursive: true });
  await writePackageFile(path.join(profilePath, EXPORT_LOG),
    Buffer.from(`${JSON.stringify({ version: 1, vaults: { ...vaults, [vaultRoot]: at } }, null, 2)}\n`));
}

async function readExportLog(profilePath: string): Promise<Record<string, string>> {
  try {
    const value = JSON.parse(await readFile(path.join(profilePath, EXPORT_LOG), 'utf8')) as { vaults?: unknown };
    if (!value.vaults || typeof value.vaults !== 'object') return {};
    return Object.fromEntries(Object.entries(value.vaults).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    // A missing or unreadable record only means the time is unknown.
    return {};
  }
}

/** Whether a folder exists and holds nothing. */
export async function isEmptyFolder(folder: string): Promise<boolean> {
  try { return (await readdir(folder)).length === 0; } catch { return false; }
}
