import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import {
  canonicalJson, removalsFromJson, subscriptionContent, subscriptionsFromJson, subscriptionsToJson, type SubscriptionRemoval,
} from '../subscriptions/subscription-files.js';
import { subscriptionDefinitions } from '../core/source-registry.js';
import { CollectorError, type ChangeCounts, type ImportMode, type SubscriptionRecord } from '../core/types.js';
import type { SourceDefinition } from '../plugins/types.js';
import { DELETIONS_FILE, deletionId, deletionsFromJson, deletionsToJson, type DeletionRecord } from './deleted-documents.js';
import { documentIdFromPath, documentPathFromId } from './document-paths.js';

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

/**
 * One item of a side, keyed `document:<document ID>` or `subscription:<source type>:<subscription
 * ID>`: present with the digest of its content, or deleted (a document's deletion record, a
 * subscription's removal record), with the time of that state. The keys live in memory only.
 */
export interface ItemState {
  state: 'present' | 'deleted';
  /** Digest of the content; null for a deleted item. */
  digest: string | null;
  /** When the item reached this state; null when the side records no readable time. */
  at: string | null;
}
export type ItemStates = Map<string, ItemState>;

/**
 * A document file for comparison: its metadata and body without `collector.collected_at` and
 * `collector.updated_at`, which say when a copy was made or changed rather than what it holds, so
 * two machines that each collected the same item hold the same document. Its time is `updated_at`,
 * the last change the app made, or `collected_at` for a document unchanged since its collection.
 */
function documentState(bytes: Buffer, file: string): ItemState {
  const match = bytes.toString().replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u);
  if (!match) throw new CollectorError('invalid_request', `文件格式無效：${file}`);
  const parsed = parse(match[1]!) as unknown;
  const metadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed as Record<string, unknown> } : {};
  const section = metadata.collector && typeof metadata.collector === 'object' && !Array.isArray(metadata.collector)
    ? { ...metadata.collector as Record<string, unknown> } : null;
  let at: string | null = null;
  if (section) {
    const stamp = section.updated_at ?? section.collected_at;
    at = typeof stamp === 'string' ? stamp : stamp instanceof Date ? stamp.toISOString() : null;
    delete section.collected_at;
    delete section.updated_at;
    metadata.collector = section;
  }
  // A copy, so the time outlives the comparison without holding the file text in memory.
  return { state: 'present', digest: digest(`${canonicalJson(metadata)}\n${match[2]!.trim()}`), at: at === null ? null : structuredClone(at) };
}

/** The parsed JSON of a settings file, or undefined when the side has none. */
async function json(files: FileSource, file: string): Promise<unknown> {
  return files.has(file) ? JSON.parse((await files.read(file)).toString()) as unknown : undefined;
}

/** The subscriptions file of one source type on one side. */
interface TypeSubscriptions {
  definition: SourceDefinition;
  rows: Map<string, SubscriptionRecord>;
  removals: Map<string, SubscriptionRemoval>;
  /** The top-level fields of the file, which a rewrite keeps. */
  top: Record<string, unknown>;
}

interface Settings {
  /** Keyed by source type, for every registered type with subscriptions. */
  subscriptions: Map<string, TypeSubscriptions>;
  records: Map<string, DeletionRecord>;
  /** The top-level fields of the deletion file, which a rewrite keeps. */
  deletionsTop: Record<string, unknown>;
}

const top = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

async function settingsOf(files: FileSource): Promise<Settings> {
  const subscriptions = new Map<string, TypeSubscriptions>();
  for (const definition of subscriptionDefinitions()) {
    const file = await json(files, definition.storage!.subscriptionsFile);
    const rows = new Map<string, SubscriptionRecord>();
    for (const row of subscriptionsFromJson(definition, file)) {
      if (rows.has(row.id)) throw new CollectorError('invalid_request', `${definition.subscription!.targetNoun} ID 重複：${row.id}`);
      rows.set(row.id, row);
    }
    subscriptions.set(definition.id, {
      definition, rows, removals: new Map(removalsFromJson(definition, file).map((record) => [record.id, record])), top: top(file),
    });
  }
  const deletions = await json(files, DELETIONS_FILE);
  return {
    subscriptions,
    records: new Map(deletionsFromJson(deletions).map((record) => [deletionId(record), record])),
    deletionsTop: top(deletions),
  };
}

/** The in-memory key of a subscription item. */
function subscriptionKey(type: string, id: string): string {
  return `subscription:${type}:${id}`;
}

/** The items of one side. */
export async function itemStates(files: FileSource): Promise<ItemStates> {
  const states: ItemStates = new Map();
  for (const file of [...files.paths()].sort()) {
    const id = documentIdFromPath(file);
    if (id) states.set(`document:${id}`, documentState(await files.read(file), file));
  }
  const settings = await settingsOf(files);
  for (const [id, record] of settings.records) {
    const key = `document:${id}`;
    if (!states.has(key)) states.set(key, { state: 'deleted', digest: null, at: record.deletedAt });
  }
  for (const [type, { rows, removals }] of settings.subscriptions) {
    for (const [id, row] of rows) {
      states.set(subscriptionKey(type, id), { state: 'present', digest: digest(subscriptionContent(row)), at: row.updatedAt ?? row.addedAt });
    }
    for (const [id, record] of removals) {
      const key = subscriptionKey(type, id);
      if (!states.has(key)) states.set(key, { state: 'deleted', digest: null, at: record.removedAt });
    }
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

/** A time to compare; a missing or unreadable time is older than any other. */
function time(at: string | null): number {
  const value = at === null ? Number.NaN : Date.parse(at);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

/** Whether both sides hold an item in the same state: equal content, or deleted at the same time. */
function same(local: ItemState | undefined, incoming: ItemState | undefined): boolean {
  if (!local || !incoming || local.state !== incoming.state) return !local && !incoming;
  return local.state === 'present' ? local.digest === incoming.digest : local.at === incoming.at;
}

/**
 * Whether a merge takes the file's state of an item: the file holds the item in another state that
 * is newer, or a newer record of the same deletion. A tie keeps the local state and an item the file
 * lacks stays as it is.
 */
function takesIncoming(local: ItemState | undefined, incoming: ItemState | undefined): boolean {
  if (!incoming || same(local, incoming)) return false;
  if (!local) return true;
  return time(incoming.at) > time(local.at);
}

const emptyCounts = (): ChangeCounts => ({
  documents: { added: 0, updated: 0, removed: 0 }, subscriptions: { added: 0, updated: 0, removed: 0 },
});

/**
 * Counts the change from `local` to `incoming` of one item. A deletion record arriving for an item
 * the Vault does not hold changes nothing a person sees and is not counted.
 */
function count(counts: ChangeCounts, key: string, local: ItemState | undefined, incoming: ItemState | undefined): void {
  const kind = key.startsWith('subscription:') ? counts.subscriptions : counts.documents;
  const before = local?.state === 'present';
  const after = incoming?.state === 'present';
  if (before && after) kind.updated += 1;
  else if (after) kind.added += 1;
  else if (before) kind.removed += 1;
}

/** The number of items a person sees change in `counts`. */
export function changeTotal(counts: ChangeCounts): number {
  return [counts.documents, counts.subscriptions].reduce((sum, kind) => sum + kind.added + kind.updated + kind.removed, 0);
}

export interface Comparison {
  /** Keys a merge takes from the file. */
  mergeKeys: string[];
  /** Keys whose local state differs from the file's; replacing takes all of them from the file. */
  replaceKeys: string[];
  merge: ChangeCounts;
  replace: ChangeCounts;
  /** Differing items a person sees where the Vault keeps its own state in a merge. */
  localNewer: number;
}

/**
 * Compares the local items with the items of an import file, item by item: for each item the newer
 * state wins, a tie keeps the local state, and an item the file lacks stays. Two copies of a document
 * with equal content are the same whatever their times.
 */
export function compareItems(local: ItemStates, incoming: ItemStates): Comparison {
  const comparison: Comparison = { mergeKeys: [], replaceKeys: [], merge: emptyCounts(), replace: emptyCounts(), localNewer: 0 };
  for (const key of [...new Set([...local.keys(), ...incoming.keys()])].sort()) {
    const left = local.get(key);
    const right = incoming.get(key);
    if (same(left, right)) continue;
    comparison.replaceKeys.push(key);
    count(comparison.replace, key, left, right);
    if (takesIncoming(left, right)) {
      comparison.mergeKeys.push(key);
      count(comparison.merge, key, left, right);
    } else if (left?.state === 'present' || right?.state === 'present') {
      comparison.localNewer += 1;
    }
  }
  return comparison;
}

/** The keys an import takes from the file. */
export function chosenKeys(comparison: Comparison, mode: ImportMode): string[] {
  return mode === 'replace' ? comparison.replaceKeys : comparison.mergeKeys;
}

/** A visible local document an import overwrites with the file's version or removes. */
export interface DisplacedDocument { id: string; path: string; reason: 'replaced' | 'deleted' }

export interface ImportPlan {
  changes: FileChanges;
  /**
   * The local documents the changes overwrite or remove. Putting the changes in place is the one
   * step that drops these versions from the Vault.
   */
  displaced: DisplacedDocument[];
}

/**
 * The file changes that take `keys` from the file. A document taken from the file arrives with its
 * file and loses its local deletion record, or leaves as the file's deletion record with its file
 * removed, or leaves with both removed when the file has neither. A subscription taken from the file
 * keeps the local collection progress when the Vault has it and is checked first one of its intervals
 * after the import; a removal taken from the file replaces the subscription with that record.
 * Settings files keep their other top-level fields; the automatic collection switch is never touched.
 */
export async function planChanges(local: FileSource, incoming: FileSource, keys: readonly string[], localStates: ItemStates): Promise<ImportPlan> {
  const changes: FileChanges = new Map();
  const displaced: DisplacedDocument[] = [];
  const mine = await settingsOf(local);
  const theirs = await settingsOf(incoming);
  let recordsChanged = false;
  const subscriptionsChanged = new Set<string>();
  for (const key of keys) {
    if (key.startsWith('document:')) {
      const id = key.slice('document:'.length);
      const file = documentPathFromId(id);
      if (!file) throw new Error(`Not a document ID: ${id}`);
      const arriving = incoming.has(file);
      if (localStates.get(key)?.state === 'present') displaced.push({ id, path: file, reason: arriving ? 'replaced' : 'deleted' });
      // A file a deletion hides is not a registered file, so removal does not depend on the local side naming it.
      changes.set(file, arriving ? { incoming: file } : null);
      const record = theirs.records.get(id);
      if (record) mine.records.set(id, record);
      else mine.records.delete(id);
      recordsChanged = true;
    } else {
      const rest = key.slice('subscription:'.length);
      const type = rest.slice(0, rest.indexOf(':'));
      const id = rest.slice(type.length + 1);
      const ours = mine.subscriptions.get(type);
      const other = theirs.subscriptions.get(type);
      if (!ours || !other) throw new Error(`Not a subscription key: ${key}`);
      const row = other.rows.get(id);
      const before = ours.rows.get(id);
      if (row) ours.rows.set(id, { ...(before ? withoutProgress(row) : row), ...(before ? collectionProgress(before) : {}), nextCheckAt: null, lastDispatchedAt: null });
      else ours.rows.delete(id);
      const removal = other.removals.get(id);
      if (removal) ours.removals.set(id, removal);
      else ours.removals.delete(id);
      subscriptionsChanged.add(type);
    }
  }
  const rewrite = async (file: string, value: Record<string, unknown>) => {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    if (!local.has(file) || !(await local.read(file)).equals(bytes)) changes.set(file, { bytes });
  };
  for (const type of subscriptionsChanged) {
    const { definition, rows, removals, top: fileTop } = mine.subscriptions.get(type)!;
    // The records go last, after the subscription list.
    const { removed: _removed, ...kept } = fileTop;
    await rewrite(definition.storage!.subscriptionsFile, subscriptionsToJson(definition, kept, [...rows.values()], [...removals.values()]));
  }
  if (recordsChanged) await rewrite(DELETIONS_FILE, { ...mine.deletionsTop, ...deletionsToJson([...mine.records.values()]) });
  return { changes, displaced };
}

/** A subscription without the item progress an import never takes over for a subscription this Vault has. */
function withoutProgress(row: SubscriptionRecord): SubscriptionRecord {
  const { outOfRange: _outOfRange, failures: _failures, ...rest } = row;
  return rest;
}

/** The collection progress of a subscription, which an import never replaces. */
function collectionProgress(row: SubscriptionRecord): Partial<SubscriptionRecord> {
  const { addedAt, lastCheckedAt, outOfRange, failures } = row;
  return {
    addedAt, ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}), ...(outOfRange !== undefined ? { outOfRange } : {}),
    ...(failures !== undefined ? { failures } : {}),
  };
}
