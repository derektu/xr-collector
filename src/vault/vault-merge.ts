import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { CHANNELS_FILE, channelsFromJson } from '../channels/subscription-files.js';
import { CollectorError, type MergeItem, type MergeChoice, type YouTubeChannel } from '../core/types.js';
import { DELETIONS_FILE, deletionId, deletionsFromJson, deletionsToJson, type DeletionRecord } from './deleted-documents.js';
import { documentKeyFromPath, documentPath } from './document-paths.js';

/**
 * The files of one side of a merge: the registered files of the local Vault or the files of a
 * package. Files are read one at a time as the comparison reaches them, so neither side is ever
 * held in memory whole.
 */
export interface FileSource {
  paths(): Iterable<string>;
  has(file: string): boolean;
  read(file: string): Promise<Buffer>;
}

/** A source over files already in memory; small settings comparisons and tests use it. */
export function memorySource(files: ReadonlyMap<string, Buffer>): FileSource {
  return {
    paths: () => files.keys(),
    has: (file) => files.has(file),
    read: async (file) => {
      const bytes = files.get(file);
      if (!bytes) throw new Error(`Missing file: ${file}`);
      return bytes;
    },
  };
}

/**
 * A change a merge writes to one file: the bytes of the imported file (`incoming`), new bytes the
 * merge made, or null to remove the file.
 */
export type FileChange = { incoming: string } | { bytes: Buffer } | null;
export type FileChanges = Map<string, FileChange>;
export const fingerprint = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
/**
 * A document file for comparison: its metadata and body without the collection and change times,
 * which say when a copy was made rather than what it holds. The times live under `collector`
 * when the metadata has that section; a document without one compares on everything.
 */
function document(bytes: Buffer, file: string) {
  const match = bytes.toString().replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u);
  if (!match) throw new CollectorError('invalid_request', '文件格式無效。');
  const parsed = parse(match[1]!) as unknown;
  const metadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed as Record<string, unknown> } : {};
  const section = metadata.collector && typeof metadata.collector === 'object' && !Array.isArray(metadata.collector)
    ? { ...metadata.collector as Record<string, unknown> } : null;
  let time: string | null = null;
  if (section) {
    const stamp = section.updated_at ?? section.collected_at;
    time = stamp === undefined || stamp === null ? null : String(stamp);
    delete section.collected_at;
    delete section.updated_at;
    metadata.collector = section;
  }
  const title = typeof metadata.title === 'string' && metadata.title ? metadata.title : file.split('/').pop()!;
  // The time and title outlive the comparison in its items; copies keep them from holding the file text in memory.
  return { content: `${canonical(metadata)}\n${match[2]!.trim()}`, ...structuredClone({ time, title }) };
}
function view(bytes: Buffer | undefined): string {
  if (!bytes) return '';
  const text = bytes.toString('utf8');
  if (text.includes('\0') || !Buffer.from(text).equals(bytes)) return `二進位檔案 · ${bytes.length} bytes · SHA-256 ${fingerprint(bytes)}`;
  return text.length > 100_000 ? `${text.slice(0, 100_000)}\n…（僅顯示前 100000 字元；比較使用完整內容）` : text;
}
/** The parsed JSON of a settings file, or undefined when the side has none. */
async function json(files: FileSource, file: string): Promise<unknown> {
  return files.has(file) ? JSON.parse((await files.read(file)).toString()) as unknown : undefined;
}

/** Subscriptions of one side by ID. */
async function channels(files: FileSource): Promise<Map<string, YouTubeChannel>> {
  const result = new Map<string, YouTubeChannel>();
  for (const row of channelsFromJson(await json(files, CHANNELS_FILE))) {
    if (result.has(row.id)) throw new CollectorError('invalid_request', `頻道 ID 重複：${row.id}`);
    result.set(row.id, row);
  }
  return result;
}

/**
 * The added time, check times and out-of-range videos describe collection, not the subscription
 * choice, so they never conflict; the title, URL, paused state and settings do.
 */
function subscriptionContent({
  addedAt: _time, lastCheckedAt: _checked, outOfRange: _outOfRange, nextCheckAt: _next, lastDispatchedAt: _dispatched, ...rest
}: YouTubeChannel): string {
  return canonical(rest);
}

/** Deletion records of one side by document ID. */
async function deletions(files: FileSource): Promise<Map<string, DeletionRecord>> {
  const records = deletionsFromJson(await json(files, DELETIONS_FILE));
  return new Map(records.map((record) => [deletionId(record), record]));
}

const deletionText = (record: DeletionRecord) => `已刪除：${record.title}\n刪除時間：${record.deletedAt}\n來源：${record.sourceUrl}`;

export interface Comparison {
  items: MergeItem[];
  /**
   * A digest of what the items stand on in the local Vault: each item's key and state, and the
   * local content a choice keeps or replaces. A merge applies only while this digest still matches
   * its preview. Subscription collection progress and check times are left out, so a check the
   * scheduler runs after the preview does not invalidate it; a changed document, deletion record or
   * subscription setting does, and so does a local change that adds or removes an item.
   */
  baseline: string;
}

/**
 * Compares the local Vault with a package. The automatic collection switch belongs to the Vault
 * being merged into, so the schedule file is never a merge item. A deletion record never silently
 * removes or blocks a document: a record on one side and the document on the other side form one
 * `deletion` conflict, while a record that meets no document is added like any new item. Only items
 * that need a choice carry the content of both sides; the rest carry their state alone.
 */
export async function compareFiles(local: FileSource, incoming: FileSource): Promise<Comparison> {
  const rows: { item: MergeItem; content: string }[] = [];
  const localDeletions = await deletions(local);
  const incomingDeletions = await deletions(incoming);
  const locallyDeletedPaths = new Set([...localDeletions.values()].map(documentPath));
  for (const file of [...incoming.paths()].sort()) {
    if (!documentKeyFromPath(file)) continue;
    // The local deletion record of this document is compared below as one deletion item.
    if (locallyDeletedPaths.has(file)) continue;
    const bytes = await incoming.read(file);
    const before = local.has(file) ? await local.read(file) : undefined;
    const right = document(bytes, file);
    const left = before ? document(before, file) : null;
    const state = !before ? 'new' : left!.content === right.content ? 'same' : 'conflict';
    rows.push({
      item: {
        key: file, kind: 'document', label: `${right.title} (${file.split('/').pop()})`, state,
        localTime: left?.time ?? null, incomingTime: right.time,
        localText: state === 'conflict' ? view(before) : '', incomingText: state === 'conflict' ? view(bytes) : '',
      },
      content: before ? fingerprint(before) : '',
    });
  }
  const left = await channels(local);
  for (const [id, row] of await channels(incoming)) {
    const before = left.get(id);
    const state = !before ? 'new' : subscriptionContent(before) === subscriptionContent(row) ? 'same' : 'conflict';
    rows.push({
      item: {
        key: `channel:${id}`, kind: 'channel', label: `${row.title} (${id})`, state,
        localTime: before ? String(before.addedAt) : null, incomingTime: String(row.addedAt),
        localText: state === 'conflict' ? JSON.stringify(before, null, 2) : '', incomingText: state === 'conflict' ? JSON.stringify(row, null, 2) : '',
      },
      content: before ? subscriptionContent(before) : '',
    });
  }
  for (const [id, record] of incomingDeletions) {
    const before = localDeletions.get(id);
    const file = documentPath(record);
    const localDocument = !before && local.has(file) ? await local.read(file) : undefined;
    const state = before ? 'same' : localDocument ? 'conflict' : 'new';
    rows.push({
      item: {
        key: `deletion:${id}`, kind: 'deletion', label: `刪除紀錄：${record.title}`, deletedOn: 'incoming', state,
        localTime: before?.deletedAt ?? (localDocument ? document(localDocument, file).time : null), incomingTime: record.deletedAt,
        localText: state === 'conflict' ? view(localDocument) : '', incomingText: state === 'conflict' ? deletionText(record) : '',
      },
      content: before ? canonical(before) : localDocument ? fingerprint(localDocument) : '',
    });
  }
  for (const [id, record] of localDeletions) {
    if (incomingDeletions.has(id)) continue;
    const file = documentPath(record);
    if (!incoming.has(file)) continue;
    const incomingDocument = await incoming.read(file);
    rows.push({
      item: {
        key: `deletion:${id}`, kind: 'deletion', label: `刪除紀錄：${record.title}`, deletedOn: 'local', state: 'conflict',
        localTime: record.deletedAt, incomingTime: document(incomingDocument, file).time,
        localText: deletionText(record), incomingText: view(incomingDocument),
      },
      content: canonical(record),
    });
  }
  // Source IDs differ in letter case alone, which a case-insensitive disk cannot hold side by side.
  const lower = new Map<string, string>();
  for (const file of new Set([...local.paths(), ...incoming.paths()])) {
    const key = file.toLowerCase();
    if (lower.has(key) && lower.get(key) !== file) throw new CollectorError('invalid_request', `兩份知識庫的路徑只差大小寫：${file}`);
    lower.set(key, file);
  }
  const hash = createHash('sha256');
  for (const { item, content } of rows) hash.update(canonical([item.key, item.state, item.deletedOn ?? null, content])).update('\n');
  return { items: rows.map((row) => row.item), baseline: hash.digest('hex') };
}

/**
 * The file changes the choices make. Documents the merge takes from the package are named, not
 * read, so they are copied one at a time when the merge writes them.
 */
export async function mergeFiles(
  local: FileSource, incoming: FileSource, items: MergeItem[], choices: Record<string, MergeChoice>,
): Promise<FileChanges> {
  const conflicts = new Set(items.filter((item) => item.state === 'conflict').map((item) => item.key));
  if (Object.keys(choices).some((key) => !conflicts.has(key)) || [...conflicts].some((key) => choices[key] !== 'local' && choices[key] !== 'incoming')) {
    throw new CollectorError('invalid_request', '請為每一項差異選擇保留本機或採用匯入版本。');
  }
  const result: FileChanges = new Map();
  const rows = await channels(local); const incomingRows = await channels(incoming);
  const records = await deletions(local); const incomingRecords = await deletions(incoming);
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
        if (local.has(documentPath(imported))) result.set(documentPath(imported), null);
      } else {
        // The imported document wins over the local deletion.
        const record = records.get(id)!;
        records.delete(id);
        result.set(documentPath(record), { incoming: documentPath(record) });
      }
      deletionsChanged = true;
    } else if (item.kind === 'channel') {
      const id = item.key.slice('channel:'.length);
      const before = rows.get(id);
      // An imported subscription is first checked one of its intervals after the merge, never at once.
      // A subscription both Vaults have keeps the local collection progress: it describes what this
      // Vault already collected, while the imported choice covers the title, address, pause and settings.
      rows.set(id, { ...incomingRows.get(id)!, ...(before ? collectionProgress(before) : {}), nextCheckAt: null, lastDispatchedAt: null });
      channelsChanged = true;
    } else result.set(item.key, { incoming: item.key });
  }
  // Rewritten settings files keep the other top-level fields of the local file.
  const rewrite = async (file: string, value: object) => {
    const bytes = Buffer.from(`${JSON.stringify({ ...await topLevel(local, file), ...value }, null, 2)}\n`);
    if (!local.has(file) || !(await local.read(file)).equals(bytes)) result.set(file, { bytes });
  };
  if (channelsChanged) await rewrite(CHANNELS_FILE, { version: 2, channels: [...rows.values()] });
  if (deletionsChanged) await rewrite(DELETIONS_FILE, deletionsToJson([...records.values()]));
  return result;
}

/** The collection progress of a subscription, which a merge never replaces. */
function collectionProgress(row: YouTubeChannel): Partial<YouTubeChannel> {
  const { addedAt, lastCheckedAt, outOfRange } = row;
  return { addedAt, ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}), ...(outOfRange !== undefined ? { outOfRange } : {}) };
}

/** The top-level fields of a JSON settings file, or none when it is missing or not an object. */
async function topLevel(files: FileSource, file: string): Promise<Record<string, unknown>> {
  const value = await json(files, file);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
