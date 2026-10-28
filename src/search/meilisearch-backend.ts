import { createHash } from 'node:crypto';
import type {
  DocumentMetadata,
  SavedDocument,
  SearchHit,
  SearchQuery,
  SearchResponse,
} from '../core/types.js';
import { NO_PUBLISHER_ID } from '../core/collector.js';
import { sourceDeclarations } from '../core/source-registry.js';
import type { SearchBackend } from './managed-transcript-search.js';
import { ContiguousFragmentIndex, type NormalizedMatchPosition } from './contiguous-fragment-index.js';
import { planFragmentQuery } from './fragment-query.js';
import { normalizeSearchText, normalizeSearchTextWithMap } from './search-normalization.js';
import type { SearchLexicon } from './search-lexicon.js';

/** The index UID carries the schema version; a schema change gets a new index and a full rebuild. */
const INDEX_UID = 'documents_v3';
/** Indexes written by earlier schema versions, removed once the current index is in place. */
const RETIRED_INDEX_UIDS = ['transcripts'];
const MAX_TOTAL_HITS = 10_000;

/** Fields a search returns: the core's own and the details block of every registered source type. */
function retrievedAttributes(): string[] {
  return [
    'id', 'type', 'sourceType', 'sourceId', 'sourceUrl', 'title', 'publisherId', 'publisherName',
    'publishedAt', 'collectedAt', ...sourceDeclarations().map((declaration) => declaration.id), 'bodyMarkdown',
  ];
}

interface MeilisearchBackendOptions {
  baseUrl: string;
  apiKey: string;
  lexicon?: SearchLexicon;
  fetch?: typeof fetch;
}

interface TaskReference {
  taskUid: number;
}

interface TaskResult {
  uid: number;
  status: 'enqueued' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  error: { message?: string } | null;
}

/**
 * One indexed document. Besides the core fields it carries one details block named after its source
 * type, between `collectedAt` and `bodyMarkdown`; that block is null when the
 * document has no details.
 */
interface IndexedDocument {
  [sourceType: string]: unknown;
  key: string;
  id: string;
  type: SavedDocument['type'];
  sourceType: SavedDocument['sourceType'];
  sourceId: string;
  sourceUrl: string;
  title: string;
  publisherId: string | null;
  publisherName: string;
  publishedAt: string | null;
  publishedAtEpoch: number | null;
  collectedAt: string;
  bodyMarkdown: string;
  searchTitle: string;
  searchPublisherName: string;
  searchBodyMarkdown: string;
  /** Fingerprint of everything above, compared with the Vault to decide whether the index is current. */
  contentHash: string;
}

interface SearchHitDocument extends IndexedDocument {
  _matchesPosition?: Record<string, Array<{ start: number; length: number }>>;
}

interface MeilisearchSearchResponse {
  hits: SearchHitDocument[];
  totalHits?: number;
  page?: number;
  hitsPerPage?: number;
}

/** Meilisearch keys allow only `[A-Za-z0-9_-]`; base64url keeps the full document ID reversible and unique. */
export function indexKey(documentId: string): string {
  return Buffer.from(documentId, 'utf8').toString('base64url');
}

const TASK_TIMEOUT_MS = 30_000;
/** How long starting the search waits for the index settings to apply. */
const SETTINGS_TASK_TIMEOUT_MS = 5 * 60_000;

export class MeilisearchBackend implements SearchBackend {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private fragments = ContiguousFragmentIndex.fromDocuments([]);

  constructor(private readonly options: MeilisearchBackendOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, '');
    this.fetchImplementation = options.fetch ?? fetch;
  }

  async initialize(): Promise<void> {
    const indexResponse = await this.fetchImplementation(
      `${this.baseUrl}/indexes/${INDEX_UID}`,
      { headers: this.headers() },
    );
    if (indexResponse.status === 404) {
      const task = await this.request<TaskReference>('/indexes', {
        method: 'POST',
        body: JSON.stringify({ uid: INDEX_UID, primaryKey: 'key' }),
      });
      await this.waitForTask(task.taskUid);
    } else if (!indexResponse.ok) {
      throw await this.responseError(indexResponse);
    }

    const settingsTask = await this.request<TaskReference>(
      `/indexes/${INDEX_UID}/settings`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          searchableAttributes: ['searchTitle', 'searchPublisherName', 'searchBodyMarkdown'],
          filterableAttributes: ['id', 'sourceType', 'publisherId', 'publishedAtEpoch'],
          pagination: { maxTotalHits: MAX_TOTAL_HITS },
        }),
      },
    );
    // Making a field filterable re-processes every stored document, which takes a while on a large index.
    await this.waitForTask(settingsTask.taskUid, SETTINGS_TASK_TIMEOUT_MS);

    for (const uid of RETIRED_INDEX_UIDS) {
      const existing = await this.fetchImplementation(`${this.baseUrl}/indexes/${uid}`, { headers: this.headers() });
      if (existing.status === 404) continue;
      if (!existing.ok) throw await this.responseError(existing);
      const task = await this.request<TaskReference>(`/indexes/${uid}`, { method: 'DELETE' });
      await this.waitForTask(task.taskUid);
    }

    // Loading the patched engine's lazy Jieba state is part of readiness, not the first user query.
    await this.request<MeilisearchSearchResponse>(`/indexes/${INDEX_UID}/search`, {
      method: 'POST',
      body: JSON.stringify({ q: '中文初始化', hitsPerPage: 1, page: 1, attributesToRetrieve: ['id'] }),
    });
  }

  async count(): Promise<number> {
    const stats = await this.request<{ numberOfDocuments: number }>(
      `/indexes/${INDEX_UID}/stats`,
    );
    return stats.numberOfDocuments;
  }

  /** True when the index holds exactly the given documents with identical content. */
  async isCurrent(documents: SavedDocument[]): Promise<boolean> {
    const fragments = ContiguousFragmentIndex.fromDocuments(documents);
    const expected = new Map(documents.map((document) => {
      const indexed = toIndexedDocument(document);
      return [indexed.key, indexed.contentHash];
    }));
    let seen = 0;
    let current = true;
    for (let offset = 0; ; offset += 1000) {
      const page = await this.request<{ results: Array<{ key: string; contentHash?: string }>; total: number }>(
        `/indexes/${INDEX_UID}/documents?fields=key,contentHash&limit=1000&offset=${offset}`,
      );
      for (const entry of page.results) {
        if (expected.get(entry.key) !== entry.contentHash) current = false;
        seen += 1;
      }
      if (page.results.length < 1000) break;
    }
    this.fragments = fragments;
    return current && seen === expected.size;
  }

  async replaceAll(documents: SavedDocument[]): Promise<void> {
    const fragments = ContiguousFragmentIndex.fromDocuments(documents);
    const deleteTask = await this.request<TaskReference>(
      `/indexes/${INDEX_UID}/documents`,
      { method: 'DELETE' },
    );
    await this.waitForTask(deleteTask.taskUid);
    if (documents.length === 0) {
      this.fragments = fragments;
      return;
    }

    const addTask = await this.request<TaskReference>(
      `/indexes/${INDEX_UID}/documents`,
      {
        method: 'PUT',
        body: JSON.stringify(documents.map(toIndexedDocument)),
      },
    );
    await this.waitForTask(addTask.taskUid);
    this.fragments = fragments;
  }

  async upsert(document: SavedDocument): Promise<void> {
    const task = await this.request<TaskReference>(
      `/indexes/${INDEX_UID}/documents`,
      {
        method: 'PUT',
        body: JSON.stringify([toIndexedDocument(document)]),
      },
    );
    await this.waitForTask(task.taskUid);
    this.fragments.upsert(document);
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const task = await this.request<TaskReference>(
      `/indexes/${INDEX_UID}/documents/delete-batch`,
      { method: 'POST', body: JSON.stringify(ids.map(indexKey)) },
    );
    await this.waitForTask(task.taskUid);
    this.fragments.remove(ids);
  }

  async search(query: SearchQuery, excludeIds: string[] = []): Promise<SearchResponse> {
    const filter = this.filters(query, excludeIds);
    const plan = this.options.lexicon
      ? planFragmentQuery(query.query, this.options.lexicon)
      : { normalized: normalizeSearchText(query.query), groups: [], latinQuery: '', hasHan: false };
    if (plan.hasHan) return this.searchWithFragments(query, excludeIds, filter, plan);

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    // Page-based search returns an exact total, which numbered pagination needs.
    const result = await this.request<MeilisearchSearchResponse>(
      `/indexes/${INDEX_UID}/search`,
      {
        method: 'POST',
        body: JSON.stringify({
          q: plan.normalized,
          hitsPerPage: limit,
          page: Math.floor(offset / limit) + 1,
          attributesToRetrieve: retrievedAttributes(),
          showMatchesPosition: true,
          matchingStrategy: 'all',
          ...(filter.length > 0 ? { filter } : {}),
        }),
      },
    );

    return {
      hits: result.hits.map((hit) => toSearchHit(hit)),
      total: result.totalHits ?? result.hits.length,
      offset,
      limit,
    };
  }

  private filters(query: SearchQuery, excludeIds: string[]): string[] {
    const filter: string[] = [];
    if (excludeIds.length > 0) {
      filter.push(`id NOT IN [${excludeIds.map((id) => JSON.stringify(id)).join(', ')}]`);
    }
    if (query.sourceType) {
      filter.push(`sourceType = ${JSON.stringify(query.sourceType)}`);
    }
    if (query.publisherId === NO_PUBLISHER_ID) {
      filter.push('publisherId IS NULL');
    } else if (query.publisherId) {
      filter.push(`publisherId = ${JSON.stringify(query.publisherId)}`);
    }
    if (query.publishedFrom) {
      filter.push(`publishedAtEpoch >= ${dateBoundary(query.publishedFrom, 'start')}`);
    }
    if (query.publishedTo) {
      filter.push(`publishedAtEpoch <= ${dateBoundary(query.publishedTo, 'end')}`);
    }
    return filter;
  }

  private async searchWithFragments(
    query: SearchQuery,
    excludeIds: string[],
    filter: string[],
    plan: ReturnType<typeof planFragmentQuery>,
  ): Promise<SearchResponse> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const eligible = this.fragments.eligibleIds(plan.groups, query, new Set(excludeIds));
    const eligibleSet = new Set(eligible);
    const primary = await this.searchAll(plan.normalized, filter);
    const retainedPrimary = primary.hits.filter(({ id }) => eligibleSet.has(id));
    const primaryIds = new Set(retainedPrimary.map(({ id }) => id));
    const latin = plan.latinQuery ? await this.searchAll(plan.latinQuery, filter) : null;
    const fallback = (latin ? latin.hits.map(({ id }) => id) : eligible)
      .filter((id) => eligibleSet.has(id) && !primaryIds.has(id));
    const ordered = [...retainedPrimary.map(({ id }) => id), ...fallback].slice(0, MAX_TOTAL_HITS);
    const pageIds = ordered.slice(offset, offset + limit);
    const details = await this.fetchDetails(pageIds, filter, plan.latinQuery);
    const byId = new Map(details.map((hit) => [hit.id, hit]));

    return {
      hits: pageIds.flatMap((id) => {
        const hit = byId.get(id);
        if (!hit) return [];
        const positions = [
          ...this.fragments.bodyPositions(id, plan.groups),
          ...(hit._matchesPosition?.searchBodyMarkdown ?? []),
        ];
        return [toSearchHit(hit, positions)];
      }),
      total: ordered.length,
      offset,
      limit,
    };
  }

  private async searchAll(query: string, filter: string[]): Promise<{ hits: SearchHitDocument[] }> {
    const hits: SearchHitDocument[] = [];
    for (let page = 1; hits.length < MAX_TOTAL_HITS; page += 1) {
      const result = await this.request<MeilisearchSearchResponse>(`/indexes/${INDEX_UID}/search`, {
        method: 'POST',
        body: JSON.stringify({
          q: query,
          hitsPerPage: 1000,
          page,
          attributesToRetrieve: ['id'],
          matchingStrategy: 'all',
          ...(filter.length > 0 ? { filter } : {}),
        }),
      });
      hits.push(...result.hits);
      if (result.hits.length < 1000 || hits.length >= (result.totalHits ?? 0)) break;
    }
    return { hits: hits.slice(0, MAX_TOTAL_HITS) };
  }

  private async fetchDetails(ids: string[], filter: string[], latinQuery: string): Promise<SearchHitDocument[]> {
    if (ids.length === 0) return [];
    const result = await this.request<MeilisearchSearchResponse>(`/indexes/${INDEX_UID}/search`, {
      method: 'POST',
      body: JSON.stringify({
        q: latinQuery,
        hitsPerPage: ids.length,
        page: 1,
        attributesToRetrieve: retrievedAttributes(),
        ...(latinQuery ? { showMatchesPosition: true, matchingStrategy: 'all' } : {}),
        filter: [...filter, `id IN [${ids.map((id) => JSON.stringify(id)).join(', ')}]`],
      }),
    });
    return result.hits;
  }

  private async waitForTask(taskUid: number, timeoutMs = TASK_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = await this.request<TaskResult>(`/tasks/${taskUid}`);
      if (task.status === 'succeeded') return;
      if (task.status === 'failed' || task.status === 'canceled') {
        throw new Error(task.error?.message ?? `Meilisearch task ${taskUid} ${task.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Meilisearch task ${taskUid} timed out`);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init?.headers),
    });
    if (!response.ok) throw await this.responseError(response);
    return response.json() as Promise<T>;
  }

  private headers(existing?: HeadersInit): Headers {
    const headers = new Headers(existing);
    headers.set('Authorization', `Bearer ${this.options.apiKey}`);
    headers.set('Content-Type', 'application/json');
    return headers;
  }

  private async responseError(response: Response): Promise<Error> {
    const body = await response.json().catch(() => ({})) as { message?: string };
    return new Error(body.message ?? `Meilisearch request failed with HTTP ${response.status}`);
  }
}

/**
 * The indexed form of a document. The content hash covers the fields in this order, the details
 * block included, so it changes whenever anything the index shows changes.
 */
function toIndexedDocument(document: SavedDocument): IndexedDocument {
  const fields = {
    key: indexKey(document.id),
    id: document.id,
    type: document.type,
    sourceType: document.sourceType,
    sourceId: document.sourceId,
    sourceUrl: document.sourceUrl,
    title: document.title,
    publisherId: document.publisher.id,
    publisherName: document.publisher.name,
    publishedAt: document.publishedAt,
    publishedAtEpoch: document.publishedAt ? Date.parse(document.publishedAt) : null,
    collectedAt: document.collectedAt,
    [document.sourceType]: documentDetails(document) ?? null,
    bodyMarkdown: document.bodyMarkdown,
    searchTitle: normalizeSearchText(document.title),
    searchPublisherName: normalizeSearchText(document.publisher.name),
    searchBodyMarkdown: normalizeSearchText(document.bodyMarkdown),
  };
  return { ...fields, contentHash: createHash('sha256').update(JSON.stringify(fields)).digest('hex') } as IndexedDocument;
}

function toSearchHit(hit: SearchHitDocument, bodyMatches?: NormalizedMatchPosition[]): SearchHit {
  const metadata: DocumentMetadata = {
    id: hit.id,
    type: hit.type,
    sourceType: hit.sourceType,
    sourceId: hit.sourceId,
    sourceUrl: hit.sourceUrl,
    title: hit.title,
    publisher: { id: hit.publisherId, name: hit.publisherName },
    publishedAt: hit.publishedAt,
    collectedAt: hit.collectedAt,
    ...(hit[hit.sourceType] ? { [hit.sourceType]: hit[hit.sourceType] } : {}),
  };
  return { ...metadata, snippet: originalSnippet(hit.bodyMarkdown, bodyMatches ?? hit._matchesPosition?.searchBodyMarkdown ?? []) };
}

const SNIPPET_LENGTH = 180;

/** Builds the search excerpt from original Vault text while using normalized UTF-8 hit positions. */
export function originalSnippet(bodyMarkdown: string, matches: Array<{ start: number; length: number }>): string {
  if (matches.length === 0) {
    const end = graphemeBoundary(bodyMarkdown, Math.min(bodyMarkdown.length, SNIPPET_LENGTH), 1);
    return `${bodyMarkdown.slice(0, end)}${end < bodyMarkdown.length ? '…' : ''}`;
  }
  const projection = normalizeSearchTextWithMap(bodyMarkdown);
  const rawMatches = matches
    .map(({ start, length }) => projection.rawRange(start, length))
    .filter((range): range is { start: number; end: number } => range !== null)
    .sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const match of rawMatches) {
    const previous = merged.at(-1);
    if (previous && match.start <= previous.end) previous.end = Math.max(previous.end, match.end);
    else merged.push({ ...match });
  }

  const focus = merged[0]?.start ?? 0;
  let start = Math.max(0, focus - Math.floor(SNIPPET_LENGTH / 3));
  let end = Math.min(bodyMarkdown.length, Math.max(start + SNIPPET_LENGTH, merged[0]?.end ?? 0));
  if (end - start < SNIPPET_LENGTH) start = Math.max(0, end - SNIPPET_LENGTH);
  start = graphemeBoundary(bodyMarkdown, start, -1);
  end = graphemeBoundary(bodyMarkdown, end, 1);

  let snippet = '';
  let cursor = start;
  for (const match of merged) {
    if (match.end <= start || match.start >= end) continue;
    const matchStart = Math.max(start, match.start);
    const matchEnd = Math.min(end, match.end);
    snippet += bodyMarkdown.slice(cursor, matchStart);
    snippet += `<mark>${bodyMarkdown.slice(matchStart, matchEnd)}</mark>`;
    cursor = matchEnd;
  }
  snippet += bodyMarkdown.slice(cursor, end);
  return `${start > 0 ? '…' : ''}${snippet}${end < bodyMarkdown.length ? '…' : ''}`;
}

function graphemeBoundary(value: string, index: number, direction: -1 | 1): number {
  if (index <= 0 || index >= value.length) return index;
  for (const segment of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(value)) {
    const start = segment.index;
    const end = start + segment.segment.length;
    if (index === start || index === end) return index;
    if (index > start && index < end) return direction < 0 ? start : end;
  }
  return index;
}

/** The details block a document carries under the field named after its source type. */
function documentDetails(document: SavedDocument): unknown {
  return (document as unknown as Record<string, unknown>)[document.sourceType];
}

function dateBoundary(value: string, boundary: 'start' | 'end'): number {
  return Date.parse(`${value}T${boundary === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`);
}
