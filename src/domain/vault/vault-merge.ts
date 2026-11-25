import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { canonicalJson } from '../../shared/lib/canonical-json.js';
import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import type { ExchangedSubscriptions, SubscriptionFileExchange } from '../../shared/subscriptions/subscription-exchange.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { ChangeCounts, ImportMode } from '../../shared/vault/vault-types.js';
import type { DeletionRecord } from '../../shared/documents/document-types.js';
import { documentId } from '../../shared/documents/document-id.js';
import { DELETIONS_FILE, deletionsFromJson, deletionsToJson } from './deleted-documents.js';
import { documentIdFromPath, documentPathFromId } from './document-paths.js';

export interface FileSource {
  paths(): Iterable<string>;
  has(file: string): boolean;
  read(file: string): Promise<Buffer>;
}

export type FileChange = { incoming: string } | { bytes: Buffer } | null;
export type FileChanges = Map<string, FileChange>;

const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export interface ItemState {
  state: 'present' | 'deleted';
  digest: string | null;
  at: string | null;
}
export type ItemStates = Map<string, ItemState>;

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
  // V8 keeps a whole file's text alive while a substring sliced from it lives: https://crbug.com/v8/2869
  return { state: 'present', digest: digest(`${canonicalJson(metadata)}\n${match[2]!.trim()}`), at: at === null ? null : structuredClone(at) };
}

async function json(files: FileSource, file: string): Promise<unknown> {
  return files.has(file) ? JSON.parse((await files.read(file)).toString()) as unknown : undefined;
}

interface TypeSubscriptions extends ExchangedSubscriptions {
  exchange: SubscriptionFileExchange;
  value: unknown;
}

interface Settings {
  subscriptions: Map<string, TypeSubscriptions>;
  records: Map<string, DeletionRecord>;
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
    records: new Map(deletionsFromJson(deletions, sources).map((record) => [documentId(record), record])),
    deletionsTop: top(deletions),
  };
}

function subscriptionKey(type: string, id: string): string {
  return `subscription:${type}:${id}`;
}

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
  return states;
}

function time(at: string | null): number {
  const value = at === null ? Number.NaN : Date.parse(at);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

function same(local: ItemState | undefined, incoming: ItemState | undefined): boolean {
  if (!local || !incoming || local.state !== incoming.state) return !local && !incoming;
  return local.state === 'present' ? local.digest === incoming.digest : local.at === incoming.at;
}

function takesIncoming(local: ItemState | undefined, incoming: ItemState | undefined): boolean {
  if (!incoming || same(local, incoming)) return false;
  if (!local) return true;
  return time(incoming.at) > time(local.at);
}

const emptyCounts = (): ChangeCounts => ({
  documents: { added: 0, updated: 0, removed: 0 }, subscriptions: { added: 0, updated: 0, removed: 0 },
});

function count(counts: ChangeCounts, key: string, local: ItemState | undefined, incoming: ItemState | undefined): void {
  const kind = key.startsWith('subscription:') ? counts.subscriptions : counts.documents;
  const before = local?.state === 'present';
  const after = incoming?.state === 'present';
  if (before && after) kind.updated += 1;
  else if (after) kind.added += 1;
  else if (before || incoming?.state === 'deleted') kind.removed += 1;
}

export interface Comparison {
  mergeKeys: string[];
  replaceKeys: string[];
  merge: ChangeCounts;
  replace: ChangeCounts;
  localNewer: number;
}

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

export function chosenKeys(comparison: Comparison, mode: ImportMode): string[] {
  return mode === 'replace' ? comparison.replaceKeys : comparison.mergeKeys;
}

export interface DisplacedDocument { id: string; path: string; reason: 'replaced' | 'deleted' }

export interface ImportPlan {
  changes: FileChanges;
  displaced: DisplacedDocument[];
}

export async function planChanges(
  sources: SourceRegistry, local: FileSource, incoming: FileSource, keys: readonly string[], localStates: ItemStates,
): Promise<ImportPlan> {
  const changes: FileChanges = new Map();
  const displaced: DisplacedDocument[] = [];
  const mine = await settingsOf(sources, local);
  const theirs = await settingsOf(sources, incoming);
  let recordsChanged = false;
  const subscriptionsTaken = new Map<string, string[]>();
  for (const key of keys) {
    if (key.startsWith('document:')) {
      const id = key.slice('document:'.length);
      const file = documentPathFromId(sources, id);
      if (!file) throw new Error(`Not a document ID: ${id}`);
      const arriving = incoming.has(file);
      if (localStates.get(key)?.state === 'present') displaced.push({ id, path: file, reason: arriving ? 'replaced' : 'deleted' });
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
