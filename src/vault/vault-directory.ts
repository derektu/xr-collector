import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { removalsFromJson, scheduleEnabledFromJson } from '../subscriptions/subscription-files.js';
import { scheduleFile, sourceDefinitions, subscriptionDefinitions } from '../core/source-registry.js';
import { CollectorError, type VaultInspection } from '../core/types.js';
import { DELETIONS_FILE, deletionsFromJson } from './deleted-documents.js';

/** Root file that marks a directory as a self-contained XR Collector Vault. */
export const VAULT_MARKER = 'xr-collector-vault.json';
export const VAULT_FORMAT = 'xr-collector-vault';
export const VAULT_FORMAT_VERSION = 1;

export interface VaultMarker {
  format: typeof VAULT_FORMAT;
  formatVersion: number;
  createdAt: string;
  createdBy: string;
  /**
   * Identity of the Vault: written when the Vault is created or imported and kept when it moves.
   * Export files never carry the marker, so every Vault created from one gets a new ID.
   */
  id: string;
}

const VAULT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Operating-system files that do not make a directory non-empty. */
const IGNORED_ENTRIES = new Set(['.DS_Store', '.localized', 'Thumbs.db', 'desktop.ini']);
/**
 * Settings files and what each must read as: the subscriptions file of every registered type with
 * subscriptions, the schedule file and the deletion file. An unreadable deletion file would let
 * deleted documents return, and a subscription or schedule file of another version would be
 * misread, so any of them failing makes the directory no Vault this program opens.
 */
function settingsFiles(): Array<{ file: string; check: (value: unknown) => unknown }> {
  return [
    ...subscriptionDefinitions().map((definition) => ({
      file: definition.storage!.subscriptionsFile, check: (value: unknown) => removalsFromJson(definition, value),
    })),
    { file: scheduleFile(), check: scheduleEnabledFromJson },
    { file: DELETIONS_FILE, check: deletionsFromJson },
  ];
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function unreadableReason(error: unknown, subject: string): string {
  const code = errorCode(error);
  if (code === 'EACCES' || code === 'EPERM') return `沒有權限讀取${subject}。`;
  if (code === 'ETIMEDOUT' || code === 'EIO' || code === 'EAGAIN') {
    return `${subject}目前無法讀取。若位於同步資料夾，請確認檔案已下載到這台電腦。`;
  }
  return `無法讀取${subject}（${code ?? '未知錯誤'}）。`;
}

function localTimestamp(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (value: number) => String(Math.trunc(Math.abs(value))).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:`
    + `${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

function markerProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object') return '知識庫標記檔格式錯誤。';
  const marker = value as Partial<VaultMarker>;
  if (marker.format !== VAULT_FORMAT || !Number.isInteger(marker.formatVersion) || (marker.formatVersion ?? 0) < 1) {
    return '知識庫標記檔格式錯誤。';
  }
  if ((marker.formatVersion ?? 0) > supportedVaultFormatVersion()) {
    return `此知識庫由較新版本的 XR Collector 建立（格式版本 ${marker.formatVersion}），請更新程式後再開啟。`;
  }
  if (typeof marker.id !== 'string' || !VAULT_ID.test(marker.id)) {
    return '知識庫標記檔沒有識別碼，不是目前支援的知識庫格式，無法開啟。';
  }
  return null;
}

/** The `.md` files in the document folder of every registered source type. */
async function countDocuments(root: string): Promise<number> {
  let count = 0;
  for (const definition of sourceDefinitions()) {
    try {
      const entries = await readdir(path.join(root, 'documents', definition.id));
      count += entries.filter((name) => name.endsWith('.md')).length;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
  }
  return count;
}

/** Reads a directory and classifies it without changing anything inside it. */
export async function inspectVaultDirectory(input: string): Promise<VaultInspection> {
  if (!path.isAbsolute(input)) return { kind: 'invalid', path: input, reason: '請提供完整的絕對路徑。' };
  const root = path.resolve(input);
  let entries: string[];
  try {
    if (!(await stat(root)).isDirectory()) return { kind: 'invalid', path: root, reason: '這個路徑不是目錄。' };
    entries = (await readdir(root)).filter((name) => !IGNORED_ENTRIES.has(name));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      const parent = path.dirname(root);
      try {
        if ((await stat(parent)).isDirectory()) return { kind: 'empty', path: root, exists: false };
      } catch { /* reported below */ }
      return { kind: 'invalid', path: root, reason: '找不到這個目錄，上層目錄也不存在。' };
    }
    return { kind: 'invalid', path: root, reason: unreadableReason(error, '這個目錄') };
  }

  if (entries.length === 0) {
    try {
      await access(root, constants.W_OK);
    } catch {
      return { kind: 'invalid', path: root, reason: '沒有權限寫入這個目錄。' };
    }
    return { kind: 'empty', path: root, exists: true };
  }
  if (!entries.includes(VAULT_MARKER)) {
    return { kind: 'invalid', path: root, reason: '這個目錄包含其他檔案，無法辨識為 XR Collector 知識庫。' };
  }

  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(path.join(root, VAULT_MARKER), 'utf8'));
  } catch (error) {
    return { kind: 'invalid', path: root, reason: error instanceof SyntaxError ? '知識庫標記檔格式錯誤。' : unreadableReason(error, '知識庫標記檔') };
  }
  const problem = markerProblem(marker);
  if (problem) return { kind: 'invalid', path: root, reason: problem };

  for (const { file, check } of settingsFiles()) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path.join(root, file), 'utf8'));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      return { kind: 'invalid', path: root, reason: error instanceof SyntaxError
        ? `知識庫設定檔 ${file} 格式錯誤。` : unreadableReason(error, `知識庫設定檔 ${file}`) };
    }
    try { check(value); } catch {
      return { kind: 'invalid', path: root, reason: `知識庫設定檔 ${file} 格式錯誤或不是目前支援的版本，無法開啟。` };
    }
  }
  try {
    return { kind: 'existing', path: root, documentCount: await countDocuments(root) };
  } catch (error) {
    return { kind: 'invalid', path: root, reason: unreadableReason(error, '知識庫的文件目錄') };
  }
}

/** Writes the marker that turns an empty directory into a Vault, with a new Vault ID. */
export async function writeVaultMarker(root: string, createdBy: string, now = new Date()): Promise<void> {
  const marker: VaultMarker = {
    format: VAULT_FORMAT, formatVersion: VAULT_FORMAT_VERSION, createdAt: localTimestamp(now), createdBy, id: randomUUID(),
  };
  await writeFile(path.join(root, VAULT_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
}

/** The highest Vault format version this program opens: its own, or a higher one a registered source type declares. */
export function supportedVaultFormatVersion(): number {
  return Math.max(VAULT_FORMAT_VERSION, ...sourceDefinitions().map((definition) => definition.vaultFormatVersion));
}

/**
 * Raises the marker of the Vault at `root` to the format version the given source types declare,
 * before their documents or subscription files are written. A Vault already at that version or
 * higher is left as it is, so a Vault holding only types of the base format keeps its marker byte
 * for byte. A directory without a readable marker is not a Vault this hook changes.
 */
export async function ensureVaultFormat(root: string, types: Iterable<string>): Promise<void> {
  const required = Math.max(0, ...[...types].map((type) => sourceDefinitions().find((definition) => definition.id === type)?.vaultFormatVersion ?? 0));
  if (required <= VAULT_FORMAT_VERSION) return;
  const file = path.join(root, VAULT_MARKER);
  let marker: VaultMarker;
  try {
    marker = JSON.parse(await readFile(file, 'utf8')) as VaultMarker;
  } catch {
    return;
  }
  if (markerProblem(marker) || marker.formatVersion >= required) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...marker, formatVersion: required }, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, file);
}

/** Creates a Vault only in a missing or empty directory. */
export async function createVaultDirectory(input: string, createdBy: string): Promise<string> {
  const inspection = await inspectVaultDirectory(input);
  if (inspection.kind === 'existing') throw new CollectorError('vault_invalid', '這個目錄已經是知識庫，請改用開啟。');
  if (inspection.kind === 'invalid') throw new CollectorError('vault_invalid', inspection.reason);
  try {
    await mkdir(inspection.path, { recursive: true });
    await writeVaultMarker(inspection.path, createdBy);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw new CollectorError('vault_invalid', '目錄內容在建立時有變更，請重新選擇。');
    const code = errorCode(error);
    throw new CollectorError('vault_invalid', code === 'EACCES' || code === 'EPERM'
      ? '沒有權限寫入這個目錄。' : `無法建立知識庫（${code ?? '未知錯誤'}）。`);
  }
  return inspection.path;
}

/** The Vault ID in a Vault's marker, or null when the marker has none or cannot be read. */
export async function readVaultId(root: string): Promise<string | null> {
  try {
    const marker = JSON.parse(await readFile(path.join(root, VAULT_MARKER), 'utf8')) as Partial<VaultMarker> | null;
    return marker && typeof marker.id === 'string' && VAULT_ID.test(marker.id) ? marker.id : null;
  } catch {
    return null;
  }
}
