import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { canonicalJson } from '../core/canonical-json.js';
import type { SourceRegistry } from '../core/source-registry.js';
import type { ExchangedSubscriptions, SubscriptionFileExchange } from '../core/subscription-exchange.js';
import { CollectorError } from '../core/collector-error.js';
import type { ChangeCounts, ImportMode } from '../core/vault-types.js';
import type { DeletionRecord } from '../core/document-types.js';
import { DELETIONS_FILE, deletionId, deletionsFromJson, deletionsToJson } from './deleted-documents.js';
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
interface TypeSubscriptions extends ExchangedSubscriptions {
  exchange: SubscriptionFileExchange;
  /** The parsed file, or undefined when the side has none. */
  value: unknown;
}

interface Settings {
  /** Keyed by source type, for every type of the registry with subscriptions. */
  subscriptions: Map<string, TypeSubscriptions>;
  records: Map<string, DeletionRecord>;
  /** The top-level fields of the deletion file, which a rewrite keeps. */
  deletionsTop: Record<string, unknown>;
}

const top = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

async function settingsOf(sources: SourceRegistry, files: FileSource): Promise<Settings> {
  const subscriptions = new Map<string, TypeSubscriptions>();
  for (const exchange of sources.exchange.files()) {
    const value = await json(files, exchange.file);
    const read = exchange.read(value);
    const ids = new Set<string>();
    for (const { id } of read.subscriptions) {
      if (ids.has(id)) throw new CollectorError('invalid_request', `${sources.require(exchange.type).subscription!.targetNoun} ID 重複：${id}`);
      ids.add(id);
    }
    subscriptions.set(exchange.type, { ...read, exchange, value });
  }
  const deletions = await json(files, DELETIONS_FILE);
  return {
    subscriptions,
    records: new Map(deletionsFromJson(deletions, sources).map((record) => [deletionId(record), record])),
    deletionsTop: top(deletions),
  };
}

/** The in-memory key of a subscription item. */
function subscriptionKey(type: string, id: string): string {
  return `subscription:${type}:${id}`;
}

/** The items of one side, as the types of `sources` read them. */
export async function itemStates(sources: SourceRegistry, files: FileSource): Promise<ItemStates> {
  const states: ItemStates = new Map();
  for (const file of [...files.paths()].sort()) {
    const id = documentIdFromPath(sources, file);
    if (id) states.set(`document:${id}`, documentState(await files.read(file), file));
  }
  const settings = await settingsOf(sources, files);
  for (const [id, record] of settings.records) {
    const key = `document:${id}`;
    if (!states.has(key)) states.set(key, { state: 'deleted', digest: null, at: record.deletedAt });
  }
  for (const [type, { subscriptions, removals }] of settings.subscriptions) {
    for (const { id, content, at } of subscriptions) {
      states.set(subscriptionKey(type, id), { state: 'present', digest: digest(content), at });
    }
    for (const { id, at } of removals) {
      const key = subscriptionKey(type, id);
      if (!states.has(key)) states.set(key, { state: 'deleted', digest: null, at });
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
 * removed, or leaves with both removed when the file has neither. Subscriptions and their removal
 * records are taken as the subscriptions block merges two copies of its file (`SubscriptionFileExchange.take`).
 * Settings files keep their other top-level fields; the automatic collection switch is never touched.
 */
export async function planChanges(
  sources: SourceRegistry, local: FileSource, incoming: FileSource, keys: readonly string[], localStates: ItemStates,
): Promise<ImportPlan> {
  const changes: FileChanges = new Map();
  const displaced: DisplacedDocument[] = [];
  const mine = await settingsOf(sources, local);
  const theirs = await settingsOf(sources, incoming);
  let recordsChanged = false;
  /** The subscription IDs taken from the file, by source type. */
  const subscriptionsTaken = new Map<string, string[]>();
  for (const key of keys) {
    if (key.startsWith('document:')) {
      const id = key.slice('document:'.length);
      const file = documentPathFromId(sources, id);
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
      if (!mine.subscriptions.has(type)) throw new Error(`Not a subscription key: ${key}`);
      subscriptionsTaken.set(type, [...subscriptionsTaken.get(type) ?? [], rest.slice(type.length + 1)]);
    }
  }
  const rewrite = async (file: string, value: Record<string, unknown>) => {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    if (!local.has(file) || !(await local.read(file)).equals(bytes)) changes.set(file, { bytes });
  };
  for (const [type, ids] of subscriptionsTaken) {
    const { exchange, value } = mine.subscriptions.get(type)!;
    await rewrite(exchange.file, exchange.take(value, theirs.subscriptions.get(type)!.value, ids));
  }
  if (recordsChanged) await rewrite(DELETIONS_FILE, { ...mine.deletionsTop, ...deletionsToJson([...mine.records.values()]) });
  return { changes, displaced };
}
