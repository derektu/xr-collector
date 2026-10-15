import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError } from '../core/types.js';
import { MarkdownVault } from './markdown-vault.js';
import { JsonChannelStore } from '../channels/json-channel-store.js';
import { JsonChannelScheduleStore } from '../channels/json-channel-schedule-store.js';
import { migrateSubscriptionSettings } from '../channels/subscription-files.js';
import { DELETIONS_FILE, deletionsFromJson, deletionsToJson } from './deleted-documents.js';

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
interface VaultPackage { format: 'xr-collector-vault'; version: 1 | 2 | 3; files: Entry[]; sha256: string }
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
  return /^(documents\/youtube\/[A-Za-z0-9_-]{11}\.md|settings\/youtube-(channels|schedule)\.json|settings\/deleted-documents\.json)$/u.test(value)
    || /^(attachments|versions|management)\/.+/u.test(value);
}

/**
 * Packs the portable data of a Vault. Deletion records and document files go through the same
 * visibility rule as `MarkdownVault.list`: a document file a deletion hides stays out, and a record
 * whose document is newer stays out, so a package never holds a document next to the record that
 * hides it, even while a deletion is unfinished.
 */
export async function exportVault(root: string): Promise<Buffer> {
  const files: Entry[] = [];
  let total = 0;
  const portable = await new MarkdownVault(root).portableDeletions();
  const hiddenPaths = new Set([...portable.hidden].map((id) => `documents/youtube/${id.slice('youtube:'.length)}.md`));
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
  const result: VaultPackage = { format: 'xr-collector-vault', version: PACKAGE_VERSION, files, sha256: manifestDigest(files) };
  const buffer = Buffer.from(JSON.stringify(result));
  if (buffer.length > PACKAGE_LIMIT) invalid('資料包超過 128 MiB。');
  return buffer;
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
    if (!recovery && records.some((record) => documents.has(`documents/${record.sourceType}/${record.sourceId}.md`))) {
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
    const expectedDocuments = decoded.filter((entry) => entry.path.startsWith('documents/')
      && !hidden.has(`youtube:${path.basename(entry.path, '.md')}`));
    if (documents.length !== expectedDocuments.length) throw new Error('Document count mismatch');
    for (const entry of expectedDocuments) {
      const id = `youtube:${path.basename(entry.path, '.md')}`;
      const doc = await vault.read(id);
      if (!doc || doc.id !== id || doc.sourceId !== id.slice(8) || doc.type !== 'Transcript'
        || typeof doc.title !== 'string' || typeof doc.publisher.name !== 'string'
        || typeof doc.collectedAt !== 'string' || typeof doc.youtube?.languageCode !== 'string'
        || !['manual', 'automatic'].includes(doc.youtube.subtitleKind)
        || doc.sourceUrl !== `https://www.youtube.com/watch?v=${doc.sourceId}`) throw new Error('Invalid document');
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
