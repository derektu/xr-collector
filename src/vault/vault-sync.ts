import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { canonicalJson, CHANNELS_FILE, channelsFromJson, subscriptionContent } from '../channels/subscription-files.js';
import {
  CollectorError, type ImportChoice, type ImportConflict, type ImportCounts, type ImportMode, type ImportSide, type ImportSituation,
  type YouTubeChannel,
} from '../core/types.js';
import { DELETIONS_FILE, deletionId, deletionsFromJson, deletionsToJson, type DeletionRecord } from './deleted-documents.js';
import { documentIdFromPath, documentPathFromId } from './document-paths.js';
import type { SyncItems } from './sync-points.js';

/**
 * The files of one side of an import: the registered files of the local Vault or the files of an
 * export file. Files are read one at a time as the comparison reaches them, so neither side is ever
 * held in memory whole.
 */
export interface FileSource {
  paths(): Iterable<string>;
  has(file: string): boolean;
  read(file: string): Promise<Buffer>;
}

/** A source over files already in memory, for tests. */
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
 * A change an import writes to one file: the bytes of the file in the export file (`incoming`), new
 * bytes the import made, or null to remove the file.
 */
export type FileChange = { incoming: string } | { bytes: Buffer } | null;
export type FileChanges = Map<string, FileChange>;

const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const DELETED = 'deleted';

/**
 * A document file for comparison: its metadata and body without the collection and change times,
 * which say when a copy was made rather than what it holds, so two machines that each collected
 * the same video hold the same document. The times live under `collector` when the metadata has
 * that section; a document without one compares on everything.
 */
function documentContent(bytes: Buffer, file: string): { content: string; time: string | null; title: string } {
  const match = bytes.toString().replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u);
  if (!match) throw new CollectorError('invalid_request', `文件格式無效：${file}`);
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
  // The time and title outlive the comparison; copies keep them from holding the file text in memory.
  return { content: `${canonicalJson(metadata)}\n${match[2]!.trim()}`, ...structuredClone({ time, title }) };
}

/** The parsed JSON of a settings file, or undefined when the side has none. */
async function json(files: FileSource, file: string): Promise<unknown> {
  return files.has(file) ? JSON.parse((await files.read(file)).toString()) as unknown : undefined;
}

async function channelRows(files: FileSource): Promise<Map<string, YouTubeChannel>> {
  const result = new Map<string, YouTubeChannel>();
  for (const row of channelsFromJson(await json(files, CHANNELS_FILE))) {
    if (result.has(row.id)) throw new CollectorError('invalid_request', `頻道 ID 重複：${row.id}`);
    result.set(row.id, row);
  }
  return result;
}

async function deletionRecords(files: FileSource): Promise<Map<string, DeletionRecord>> {
  return new Map(deletionsFromJson(await json(files, DELETIONS_FILE)).map((record) => [deletionId(record), record]));
}

/** One item of a side: its digest, and the name and time an import shows for it. */
export interface ItemState {
  digest: string;
  state: 'present' | 'deleted';
  label: string;
  time: string | null;
}
export type ItemStates = Map<string, ItemState>;

/** The items of one side, keyed as sync points key them. */
export async function itemStates(files: FileSource): Promise<ItemStates> {
  const states: ItemStates = new Map();
  for (const file of [...files.paths()].sort()) {
    const id = documentIdFromPath(file);
    if (!id) continue;
    const document = documentContent(await files.read(file), file);
    states.set(`document:${id}`, { digest: digest(document.content), state: 'present', label: document.title, time: document.time });
  }
  for (const [id, record] of await deletionRecords(files)) {
    const key = `document:${id}`;
    if (!states.has(key)) states.set(key, { digest: DELETED, state: 'deleted', label: record.title, time: record.deletedAt });
  }
  for (const [id, row] of await channelRows(files)) {
    states.set(`channel:${id}`, { digest: digest(subscriptionContent(row)), state: 'present', label: row.title, time: row.updatedAt ?? null });
  }
  // Source IDs that differ in letter case alone cannot sit side by side on a case-insensitive disk.
  const lower = new Map<string, string>();
  for (const file of files.paths()) {
    const key = file.toLowerCase();
    if (lower.has(key) && lower.get(key) !== file) throw new CollectorError('invalid_request', `路徑只差大小寫：${file}`);
    lower.set(key, file);
  }
  return states;
}

/** The digests of a side, as a sync point records them. */
export function syncItems(states: ItemStates): Map<string, string> {
  return new Map([...states].map(([key, state]) => [key, state.digest]));
}

export interface Comparison {
  situation: ImportSituation;
  /** Keys a merge takes from the file without asking. */
  incomingKeys: string[];
  incoming: ImportCounts;
  conflicts: ImportConflict[];
  /** Keys whose local item differs from the file's; replacing takes all of them from the file. */
  differing: string[];
  replaceLoses: number;
}

const counted = (from: ItemState | undefined, to: ItemState | undefined, counts: ImportCounts) => {
  const before = from?.state === 'present';
  const after = to?.state === 'present';
  if (before && after) counts.modified += 1;
  else if (after) counts.added += 1;
  else counts.removed += 1;
};

/**
 * Compares the local items, the shared sync point `base` (null when there is none) and the items of
 * an import file, item by item:
 * - equal on both sides: nothing to do;
 * - with a base, only the file changed since it: taken from the file; only the local side changed: kept;
 *   both changed differently: a conflict;
 * - without a base, an item only the file has is added, an item only the local side has is kept,
 *   and an item both have differently is a conflict, so nothing is ever removed.
 */
export function compareItems(
  local: ItemStates, base: SyncItems | null, incoming: ItemStates, machines: { local: string | null; incoming: string | null },
): Comparison {
  const incomingKeys: string[] = [];
  const counts: ImportCounts = { added: 0, modified: 0, removed: 0 };
  const conflicts: ImportConflict[] = [];
  const differing: string[] = [];
  let localChanged = false;
  let replaceLoses = 0;
  const side = (state: ItemState | undefined, machine: string | null): ImportSide => (
    { state: state?.state ?? 'absent', time: state?.time ?? null, machine });
  for (const key of [...new Set([...local.keys(), ...incoming.keys(), ...(base?.keys() ?? [])])].sort()) {
    const left = local.get(key);
    const right = incoming.get(key);
    const was = base?.get(key);
    if (base && left?.digest !== was) localChanged = true;
    if (left?.digest === right?.digest) continue;
    differing.push(key);
    const takeIncoming = base ? left?.digest === was : left === undefined;
    const keepLocal = base ? right?.digest === was : right === undefined;
    if (base ? left?.digest !== was : left !== undefined) replaceLoses += 1;
    if (takeIncoming) {
      incomingKeys.push(key);
      counted(left, right, counts);
    } else if (!keepLocal) {
      conflicts.push({
        key, kind: key.startsWith('channel:') ? 'channel' : 'document', label: (right ?? left)!.label,
        local: side(left, machines.local), incoming: side(right, machines.incoming),
      });
    }
  }
  const situation: ImportSituation = !incomingKeys.length && !conflicts.length ? 'nothing'
    : !base ? 'unrelated' : localChanged ? 'both' : 'incoming';
  return { situation, incomingKeys, incoming: counts, conflicts, differing, replaceLoses };
}

/** The keys an import takes from the file: in a merge, its own changes and the conflicts chosen for it; in a replace, every differing item. */
export function chosenKeys(comparison: Comparison, mode: ImportMode, choices: Record<string, ImportChoice> | undefined): string[] {
  if (mode === 'replace') return comparison.differing;
  const given = choices ?? {};
  const conflicts = new Set(comparison.conflicts.map((item) => item.key));
  if (Object.keys(given).some((key) => !conflicts.has(key))
    || [...conflicts].some((key) => given[key] !== 'local' && given[key] !== 'incoming')) {
    throw new CollectorError('invalid_request', '請為每一項衝突選擇保留本機或採用匯入檔。');
  }
  return [...comparison.incomingKeys, ...[...conflicts].filter((key) => given[key] === 'incoming')];
}

/**
 * The file changes that take `keys` from the file. A document taken from the file arrives with its
 * file, or as a deletion record with its file removed, or leaves with both removed. A subscription
 * taken from the file keeps the local collection progress when the Vault has it, and is checked
 * first one of its intervals after the import. Settings files keep their other top-level fields.
 */
export async function planChanges(local: FileSource, incoming: FileSource, keys: readonly string[]): Promise<FileChanges> {
  const changes: FileChanges = new Map();
  const records = await deletionRecords(local);
  const incomingRecords = await deletionRecords(incoming);
  const rows = await channelRows(local);
  const incomingRows = await channelRows(incoming);
  let recordsChanged = false;
  let rowsChanged = false;
  for (const key of keys) {
    if (key.startsWith('document:')) {
      const id = key.slice('document:'.length);
      const file = documentPathFromId(id);
      if (!file) throw new Error(`Not a document ID: ${id}`);
      const record = incomingRecords.get(id);
      if (incoming.has(file)) changes.set(file, { incoming: file });
      // A file a deletion hides is not a registered file, so removal does not depend on the local side naming it.
      else changes.set(file, null);
      if (record) records.set(id, record);
      else records.delete(id);
      recordsChanged = true;
    } else {
      const id = key.slice('channel:'.length);
      const row = incomingRows.get(id);
      const before = rows.get(id);
      if (row) rows.set(id, { ...row, ...(before ? collectionProgress(before) : {}), nextCheckAt: null, lastDispatchedAt: null });
      else rows.delete(id);
      rowsChanged = true;
    }
  }
  const rewrite = async (file: string, value: object) => {
    const current = await json(local, file);
    const top = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
    const bytes = Buffer.from(`${JSON.stringify({ ...top, ...value }, null, 2)}\n`);
    if (!local.has(file) || !(await local.read(file)).equals(bytes)) changes.set(file, { bytes });
  };
  if (rowsChanged) await rewrite(CHANNELS_FILE, { version: 2, channels: [...rows.values()] });
  if (recordsChanged) await rewrite(DELETIONS_FILE, deletionsToJson([...records.values()]));
  return changes;
}

/** The collection progress of a subscription, which an import never replaces. */
function collectionProgress(row: YouTubeChannel): Partial<YouTubeChannel> {
  const { addedAt, lastCheckedAt, outOfRange } = row;
  return { addedAt, ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}), ...(outOfRange !== undefined ? { outOfRange } : {}) };
}
