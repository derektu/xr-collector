import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { CHANNELS_FILE, channelsFromJson, SCHEDULE_FILE } from '../channels/subscription-files.js';
import { CollectorError, type MergeItem, type MergeChoice, type YouTubeChannel } from '../core/types.js';
import { DELETIONS_FILE, deletionId, deletionsFromJson, deletionsToJson, type DeletionRecord } from './deleted-documents.js';

export type Files = Map<string, Buffer>;
/** Files a merge writes; null removes the file. */
export type FileChanges = Map<string, Buffer | null>;
export const fingerprint = (data: Buffer) => createHash('sha256').update(data).digest('hex');
// Packages reach this module only after unpackVault validates their contents.
export function packageFiles(buffer: Buffer): Files {
  const value = JSON.parse(buffer.toString()) as { files: { path: string; data: string }[] };
  return new Map(value.files.map((file) => [file.path, Buffer.from(file.data, 'base64')]));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function document(bytes: Buffer) {
  const match = bytes.toString().replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u);
  if (!match) throw new CollectorError('invalid_request', '文件格式無效。');
  const metadata = parse(match[1]!) as Record<string, unknown> & { collector: Record<string, unknown> };
  const time = String(metadata.collector.updated_at ?? metadata.collector.collected_at ?? '未提供');
  delete metadata.collector.collected_at;
  delete metadata.collector.updated_at;
  return { content: `${canonical(metadata)}\n${match[2]!.trim()}`, time, title: String(metadata.title) };
}
function view(bytes: Buffer | undefined): string {
  if (!bytes) return '';
  const text = bytes.toString('utf8');
  if (text.includes('\0') || !Buffer.from(text).equals(bytes)) return `二進位檔案 · ${bytes.length} bytes · SHA-256 ${fingerprint(bytes)}`;
  return text.length > 100_000 ? `${text.slice(0, 100_000)}\n…（僅顯示前 100000 字元；比較使用完整內容）` : text;
}
/**
 * Subscriptions of a package by ID, each with its own settings. A version 1 package's rows take the
 * shared settings of its own schedule file, so packages of both versions compare alike.
 */
function channels(files: Files): Map<string, YouTubeChannel> {
  const json = (file: string) => {
    const bytes = files.get(file);
    return bytes ? JSON.parse(bytes.toString()) as unknown : undefined;
  };
  const result = new Map<string, YouTubeChannel>();
  for (const row of channelsFromJson(json(CHANNELS_FILE), json(SCHEDULE_FILE))) {
    if (result.has(row.id)) throw new CollectorError('invalid_request', `頻道 ID 重複：${row.id}`);
    result.set(row.id, row);
  }
  return result;
}

/**
 * Discovery progress and check times describe collection, not the subscription choice, so they
 * never conflict; the title, URL, paused state and settings do.
 */
function subscriptionContent({
  addedAt: _time, cursor: _cursor, lastCheckedAt: _checked, backlog: _backlog, nextCheckAt: _next, lastDispatchedAt: _dispatched, ...rest
}: YouTubeChannel): string {
  return canonical(rest);
}

/** Deletion records of a package by document ID. */
function deletions(files: Files): Map<string, DeletionRecord> {
  const bytes = files.get(DELETIONS_FILE);
  const records = bytes ? deletionsFromJson(JSON.parse(bytes.toString()) as unknown) : [];
  return new Map(records.map((record) => [deletionId(record), record]));
}

const documentPath = (record: DeletionRecord) => `documents/${record.sourceType}/${record.sourceId}.md`;
const deletionText = (record: DeletionRecord) => `已刪除：${record.title}\n刪除時間：${record.deletedAt}\n來源：${record.sourceUrl}`;

/**
 * The automatic collection switch belongs to the Vault being merged into, so the schedule file is
 * never a merge item. A deletion record never silently removes or blocks a document: a record on one
 * side and the document on the other side form one `deletion` conflict, while a record that meets
 * no document is added like any new item.
 */
export function compareFiles(local: Files, incoming: Files): MergeItem[] {
  const items: MergeItem[] = [];
  const localDeletions = deletions(local);
  const incomingDeletions = deletions(incoming);
  const locallyDeletedPaths = new Set([...localDeletions.values()].map(documentPath));
  for (const [file, bytes] of incoming) {
    if (file === CHANNELS_FILE || file === SCHEDULE_FILE || file === DELETIONS_FILE) continue;
    // The local deletion record of this document is compared below as one deletion item.
    if (locallyDeletedPaths.has(file)) continue;
    const before = local.get(file);
    let equal = before?.equals(bytes) ?? false;
    let label = file;
    let localTime: string | null = null; let incomingTime: string | null = null;
    let localText = view(before); let incomingText = view(bytes);
    if (file.startsWith('documents/')) {
      const right = document(bytes); const left = before ? document(before) : null;
      label = `${right.title} (${file.split('/').pop()})`;
      equal = left?.content === right.content; localTime = left?.time ?? null; incomingTime = right.time;
    }
    items.push({ key: file, kind: file.startsWith('documents/') ? 'document' : 'file',
      label, state: !before ? 'new' : equal ? 'same' : 'conflict', localTime, incomingTime, localText, incomingText });
  }
  const left = channels(local);
  for (const [id, row] of channels(incoming)) {
    const before = left.get(id);
    items.push({ key: `channel:${id}`, kind: 'channel', label: `${row.title} (${id})`,
      state: !before ? 'new' : subscriptionContent(before) === subscriptionContent(row) ? 'same' : 'conflict',
      localTime: before ? String(before.addedAt) : null, incomingTime: String(row.addedAt),
      localText: before ? JSON.stringify(before, null, 2) : '', incomingText: JSON.stringify(row, null, 2) });
  }
  for (const [id, record] of incomingDeletions) {
    const before = localDeletions.get(id);
    const localDocument = local.get(documentPath(record));
    items.push({
      key: `deletion:${id}`, kind: 'deletion', label: `刪除紀錄：${record.title}`,
      state: before ? 'same' : localDocument ? 'conflict' : 'new',
      localTime: before?.deletedAt ?? (localDocument ? document(localDocument).time : null), incomingTime: record.deletedAt,
      localText: before ? deletionText(before) : view(localDocument), incomingText: deletionText(record),
    });
  }
  for (const [id, record] of localDeletions) {
    if (incomingDeletions.has(id)) continue;
    const incomingDocument = incoming.get(documentPath(record));
    if (!incomingDocument) continue;
    items.push({
      key: `deletion:${id}`, kind: 'deletion', label: `刪除紀錄：${record.title}`, state: 'conflict',
      localTime: record.deletedAt, incomingTime: document(incomingDocument).time,
      localText: deletionText(record), incomingText: view(incomingDocument),
    });
  }
  // A cross-package path collision cannot be resolved with a file-level choice.
  const paths = [...new Set([...local.keys(), ...incoming.keys()])];
  const lower = new Map<string, string>();
  for (const file of paths) {
    const key = file.toLowerCase();
    if (lower.has(key) && lower.get(key) !== file) throw new CollectorError('invalid_request', `兩份 vault 的路徑大小寫衝突：${file}`);
    lower.set(key, file);
  }
  for (const file of lower.keys()) {
    const parts = file.split('/');
    while (parts.length > 1) { parts.pop(); if (lower.has(parts.join('/'))) throw new CollectorError('invalid_request', `兩份 vault 的檔案與目錄衝突：${file}`); }
  }
  return items;
}
export function mergeFiles(local: Files, incoming: Files, items: MergeItem[], choices: Record<string, MergeChoice>): FileChanges {
  const conflicts = new Set(items.filter((item) => item.state === 'conflict').map((item) => item.key));
  if (Object.keys(choices).some((key) => !conflicts.has(key)) || [...conflicts].some((key) => choices[key] !== 'local' && choices[key] !== 'incoming')) {
    throw new CollectorError('invalid_request', '請為每一項差異選擇保留本機或採用匯入版本。');
  }
  const result: FileChanges = new Map(local); const rows = channels(local); const incomingRows = channels(incoming);
  const records = deletions(local); const incomingRecords = deletions(incoming);
  let channelsChanged = false;
  let deletionsChanged = false;
  for (const item of items) {
    if (item.state === 'same' || (item.state === 'conflict' && choices[item.key] === 'local')) continue;
    if (item.kind === 'deletion') {
      const id = item.key.slice('deletion:'.length);
      const imported = incomingRecords.get(id);
      if (imported) {
        // The imported deletion wins: the local document goes and the record arrives.
        records.set(id, imported);
        result.set(documentPath(imported), null);
      } else {
        // The imported document wins over the local deletion.
        const record = records.get(id)!;
        records.delete(id);
        result.set(documentPath(record), incoming.get(documentPath(record))!);
      }
      deletionsChanged = true;
    } else if (item.kind === 'channel') {
      // An imported subscription is first checked one of its intervals after the merge, never at once.
      rows.set(item.key.slice(8), { ...incomingRows.get(item.key.slice(8))!, nextCheckAt: null, lastDispatchedAt: null });
      channelsChanged = true;
    } else result.set(item.key, incoming.get(item.key)!);
  }
  if (channelsChanged) result.set(CHANNELS_FILE, Buffer.from(JSON.stringify({ version: 2, channels: [...rows.values()] }, null, 2) + '\n'));
  if (deletionsChanged) result.set(DELETIONS_FILE, Buffer.from(`${JSON.stringify(deletionsToJson([...records.values()]), null, 2)}\n`));
  return new Map([...result].filter(([key, value]) => (value === null ? local.has(key) : !local.get(key)?.equals(value))));
}
