// Document status over the HTTP API the UI and authorized Agents share: every document reads as a
// draft or published (a collected one and one another tool wrote without `status` are published),
// browse and search filter by status with counts that follow the other filters, publishing and
// taking back to draft change only the status, notify readers and record an event, and the search
// index follows. Without it an Agent cannot see or change status, an unauthorized request could, a
// filter mixes in the other status, or search keeps showing a status the document no longer has.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NewJobEvent } from '../../../../src/shared/activity/activity-types.js';
import type { Change } from '../../../../src/shared/api/changes.js';
import { Collector } from '../../../../src/domain/vault/collector.js';
import type { SearchResponse, TranscriptSearch } from '../../../../src/shared/api/search-types.js';
import { transcriptDocument } from '../../../../src/domain/sources/youtube/server.js';
import { ManagedTranscriptSearch } from '../../../../src/domain/search/managed-transcript-search.js';
import { MeilisearchBackend } from '../../../../src/domain/search/meilisearch-backend.js';
import { startMeilisearchProcess, type RunningMeilisearch } from '../../../../src/domain/search/meilisearch-process.js';
import { loadSearchLexicon } from '../../../../src/domain/search/search-lexicon.js';
import { createHttpApp } from '../../../../src/transport/server/app.js';
import { MarkdownVault } from '../../../../src/domain/vault/markdown-vault.js';
import { VaultFileWriter } from '../../../../src/domain/vault/vault-files.js';
import { video } from '../../../support/exchange-fixtures.js';
import { PRODUCT_SOURCES } from '../../../support/product-sources.js';
import { bundledLexicon, bundledMeilisearch, REAL_ENGINE_TAG } from '../../../support/real-engine.js';
import { acceptsBearer } from '../../../support/agent-access.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const TOKEN = 'status-secret';
const agent = { authorization: `Bearer ${TOKEN}` };
const statusPath = (id: string) => `/api/documents/${encodeURIComponent(id)}/status`;
const filePath = (root: string, videoId: string) => path.join(root, 'documents', 'youtube', `${videoId}.md`);

/** A document file as another tool writes it: the Vault format without `status`. */
const UNTAGGED = `---
type: Transcript
title: "手寫 文件"
resource: https://www.youtube.com/watch?v=handwritten
tags: []
collector:
  id: youtube:handwritten
  source: youtube
  source_id: handwritten
  publisher: 手寫頻道
  publisher_id: UC-hand
  collected_at: 2026-09-01T00:00:00.000Z
  content_extent: full
  subtitle: { language_code: zh-Hant, kind: manual }
  source_tags: []
---

手寫的正文，半導體與 orchard。
`;

interface Setup {
  root: string;
  vault: MarkdownVault;
  collector: Collector;
  events: Array<Omit<NewJobEvent, 'vaultPath' | 'jobId'>>;
  changes: Change[];
}

/**
 * A Vault with five collected documents and one another tool wrote: `ch1aaaaaaa1`–`3` of channel
 * UC-one, `ch2aaaaaaa1`–`2` of UC-two, and `handwritten` of UC-hand. Every body holds 半導體 and
 * orchard, so both the Chinese fragment and the Latin search path find all six.
 */
async function setup(search?: Pick<TranscriptSearch, 'index'>, clock: { now: Date } = { now: new Date('2026-11-01T00:00:00.000Z') }): Promise<Setup> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-document-status-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const vault = new MarkdownVault(new VaultFileWriter(root, PRODUCT_SOURCES), { now: () => clock.now });
  for (const [id, channelId] of [['ch1aaaaaaa1', 'UC-one'], ['ch1aaaaaaa2', 'UC-one'], ['ch1aaaaaaa3', 'UC-one'], ['ch2aaaaaaa1', 'UC-two'], ['ch2aaaaaaa2', 'UC-two']] as const) {
    await vault.add(transcriptDocument(video(id, { channelId, bodyMarkdown: `${id} 談半導體產業，orchard observatory。` })));
  }
  await mkdir(path.join(root, 'documents', 'youtube'), { recursive: true });
  await writeFile(filePath(root, 'handwritten'), UNTAGGED);
  const events: Array<Omit<NewJobEvent, 'vaultPath' | 'jobId'>> = [];
  const changes: Change[] = [];
  const collector = new Collector(vault, search, { recordEvent: (entry) => events.push(entry), noteChange: (change) => changes.push(change) });
  return { root, vault, collector, events, changes };
}

async function app(collector: Collector, search?: TranscriptSearch) {
  const created = await createHttpApp({ sources: PRODUCT_SOURCES, collector, ...(search ? { search } : {}), agentAuthorize: acceptsBearer(TOKEN) });
  cleanup.push(() => created.close());
  return created;
}

const ids = (list: Array<{ id: string }>) => list.map(({ id }) => id).sort();

describe('document status over HTTP', () => {
  it('reads a collected document and a file without status as published, in reads and in filters', async () => {
    const { root, collector } = await setup();
    const http = await app(collector);
    expect(await readFile(filePath(root, 'ch1aaaaaaa1'), 'utf8')).toMatch(/\ntags: \[\]\nstatus: published\ncollector:\n/u);

    const all = (await http.inject({ url: '/api/documents', headers: agent })).json();
    expect(all.total).toBe(6);
    expect(all.statusCounts).toEqual({ draft: 0, published: 6 });
    expect(new Set(all.documents.map((document: { status: string }) => document.status))).toEqual(new Set(['published']));
    expect((await http.inject({ url: '/api/documents/youtube%3Ahandwritten', headers: agent })).json().document.status).toBe('published');
    expect(ids((await http.inject({ url: '/api/documents?status=published', headers: agent })).json().documents)).toContain('youtube:handwritten');
    expect((await http.inject({ url: '/api/documents?status=draft', headers: agent })).json()).toMatchObject({ total: 0, documents: [] });
  });

  it('lets an authorized Agent publish and take back to draft, refuses an unauthorized request, and filters with the source', async () => {
    const { root, collector, events, changes } = await setup();
    const http = await app(collector);
    const before = await readFile(filePath(root, 'ch1aaaaaaa2'), 'utf8');

    const refused = await http.inject({ method: 'PUT', url: statusPath('youtube:ch1aaaaaaa2'), payload: { status: 'draft' } });
    expect([refused.statusCode, refused.json().error.code]).toEqual([401, 'unauthorized']);
    expect(await readFile(filePath(root, 'ch1aaaaaaa2'), 'utf8')).toBe(before);

    for (const id of ['youtube:ch1aaaaaaa2', 'youtube:ch1aaaaaaa3', 'youtube:ch2aaaaaaa1', 'youtube:handwritten']) {
      const drafted = await http.inject({ method: 'PUT', url: statusPath(id), headers: agent, payload: { status: 'draft' } });
      expect(drafted.statusCode).toBe(200);
      expect(drafted.json().document).toMatchObject({ id, status: 'draft', bodyMarkdown: expect.any(String) });
    }
    const published = await http.inject({ method: 'PUT', url: statusPath('youtube:ch1aaaaaaa3'), headers: agent, payload: { status: 'published' } });
    expect(published.json().document.status).toBe('published');
    expect((await http.inject({ url: '/api/documents/youtube%3Ach1aaaaaaa2', headers: agent })).json().document.status).toBe('draft');

    const drafts = (await http.inject({ url: '/api/documents?status=draft', headers: agent })).json();
    expect(ids(drafts.documents)).toEqual(['youtube:ch1aaaaaaa2', 'youtube:ch2aaaaaaa1', 'youtube:handwritten']);
    expect(drafts).toMatchObject({ total: 3, statusCounts: { draft: 3, published: 3 } });
    const channelOne = (await http.inject({ url: '/api/documents?sourceType=youtube&publisherId=UC-one&status=published', headers: agent })).json();
    expect(ids(channelOne.documents)).toEqual(['youtube:ch1aaaaaaa1', 'youtube:ch1aaaaaaa3']);
    expect(channelOne).toMatchObject({ total: 2, statusCounts: { draft: 1, published: 2 } });

    expect(changes.filter((change) => change.kind === 'document' && change.id === 'youtube:ch1aaaaaaa3')).toHaveLength(2);
    expect(events.map(({ eventType, detail, documentId }) => [eventType, detail, documentId])).toEqual([
      ['document.status_changed', 'draft', 'youtube:ch1aaaaaaa2'],
      ['document.status_changed', 'draft', 'youtube:ch1aaaaaaa3'],
      ['document.status_changed', 'draft', 'youtube:ch2aaaaaaa1'],
      ['document.status_changed', 'draft', 'youtube:handwritten'],
      ['document.status_changed', 'published', 'youtube:ch1aaaaaaa3'],
    ]);
  });

  it('writes, notes and records nothing when the document already has the status', async () => {
    const indexed: string[] = [];
    const { root, collector, events, changes } = await setup({ index: async (document) => { indexed.push(document.id); } });
    const http = await app(collector);
    const file = filePath(root, 'ch1aaaaaaa1');
    const [text, { mtimeMs }] = [await readFile(file, 'utf8'), await stat(file)];

    const same = await http.inject({ method: 'PUT', url: statusPath('youtube:ch1aaaaaaa1'), headers: agent, payload: { status: 'published' } });
    expect([same.statusCode, same.json().document.status]).toEqual([200, 'published']);
    expect(await readFile(file, 'utf8')).toBe(text);
    expect((await stat(file)).mtimeMs).toBe(mtimeMs);
    expect({ indexed, changes, events }).toEqual({ indexed: [], changes: [], events: [] });
  });

  it('answers invalid_request for any other status and names a missing or deleted document', async () => {
    const { collector } = await setup();
    const search = { status: () => ({ state: 'ready' as const, indexedDocuments: 6, lastRebuiltAt: null }), index: async () => undefined,
      remove: async () => undefined, rebuild: async () => undefined,
      search: async (): Promise<SearchResponse> => ({ hits: [], total: 0, statusCounts: { draft: 0, published: 0 }, offset: 0, limit: 50 }) };
    const http = await app(collector, search);
    for (const payload of [{ status: 'trash' }, { status: 'Draft' }, {}, { status: null }]) {
      const response = await http.inject({ method: 'PUT', url: statusPath('youtube:ch1aaaaaaa1'), headers: agent, payload });
      expect([response.statusCode, response.json().error.code]).toEqual([400, 'invalid_request']);
    }
    for (const url of ['/api/documents?status=trash', '/api/documents?status=', '/api/search?q=orchard&status=all', '/api/documents?status=draft&status=published']) {
      const response = await http.inject({ url, headers: agent });
      expect([response.statusCode, response.json().error.code], url).toEqual([400, 'invalid_request']);
    }

    const missing = await http.inject({ method: 'PUT', url: statusPath('youtube:zzzzzzzzzzz'), headers: agent, payload: { status: 'draft' } });
    expect([missing.statusCode, missing.json().error.code]).toEqual([404, 'document_not_found']);
    await collector.delete('youtube:ch2aaaaaaa2');
    const deleted = await http.inject({ method: 'PUT', url: statusPath('youtube:ch2aaaaaaa2'), headers: agent, payload: { status: 'draft' } });
    expect([deleted.statusCode, deleted.json().error.code]).toEqual([404, 'document_deleted']);
  });
});

describe('document status in search', { tags: [REAL_ENGINE_TAG] }, () => {
  /** A managed search on the engine at `databasePath`, loading the Vault's documents; counts its rebuilds. */
  async function startSearch(databasePath: string, vault: MarkdownVault): Promise<{ search: ManagedTranscriptSearch; engine: RunningMeilisearch; rebuilds: () => number }> {
    const engine = await startMeilisearchProcess({ binaryPath: bundledMeilisearch, databasePath });
    cleanup.push(() => engine.close());
    let rebuilds = 0;
    const search = new ManagedTranscriptSearch(
      new MeilisearchBackend({ sources: PRODUCT_SOURCES, baseUrl: engine.url, apiKey: engine.apiKey, lexicon: await loadSearchLexicon(bundledLexicon) }),
      async () => Promise.all((await vault.list()).map(async (document) => (await vault.read(document.id))!)),
      { load: async () => ({ lastRebuiltAt: null }), save: async () => { rebuilds += 1; } },
    );
    await search.start();
    return { search, engine, rebuilds: () => rebuilds };
  }

  it('filters search by status with the source filter and query, follows status changes, and keeps them after a rebuild and a restart', async () => {
    const searchRef: { current: TranscriptSearch | null } = { current: null };
    const { root, vault, collector } = await setup({ index: (document) => searchRef.current!.index(document) });
    const databasePath = path.join(root, '..', `${path.basename(root)}-search`);
    cleanup.push(() => rm(databasePath, { recursive: true, force: true }));
    const first = await startSearch(databasePath, vault);
    searchRef.current = first.search;
    const http = await app(collector, first.search);
    const get = async (url: string) => {
      const response = await http.inject({ url, headers: agent });
      expect(response.statusCode, url).toBe(200);
      return response.json() as SearchResponse;
    };
    const put = async (id: string, status: string) =>
      expect((await http.inject({ method: 'PUT', url: statusPath(id), headers: agent, payload: { status } })).statusCode).toBe(200);
    for (const id of ['youtube:ch1aaaaaaa2', 'youtube:ch2aaaaaaa1', 'youtube:handwritten']) await put(id, 'draft');

    /** Draft and published hits of a query with every other filter, checked against the counts and the unfiltered total. */
    const byStatus = async (filters: string) => {
      const any = await get(`/api/search?${filters}`);
      const draft = await get(`/api/search?${filters}&status=draft`);
      const published = await get(`/api/search?${filters}&status=published`);
      for (const result of [any, draft, published]) expect(result.statusCounts, filters).toEqual(any.statusCounts);
      expect(any.statusCounts.draft + any.statusCounts.published, filters).toBe(any.total);
      expect([draft.total, published.total], filters).toEqual([any.statusCounts.draft, any.statusCounts.published]);
      expect(draft.hits.every((hit) => hit.status === 'draft') && published.hits.every((hit) => hit.status === 'published'), filters).toBe(true);
      return { draft: ids(draft.hits), published: ids(published.hits) };
    };

    const expected = {
      fragment: { draft: ['youtube:ch1aaaaaaa2', 'youtube:ch2aaaaaaa1', 'youtube:handwritten'], published: ['youtube:ch1aaaaaaa1', 'youtube:ch1aaaaaaa3', 'youtube:ch2aaaaaaa2'] },
      channelOne: { draft: ['youtube:ch1aaaaaaa2'], published: ['youtube:ch1aaaaaaa1', 'youtube:ch1aaaaaaa3'] },
    };
    expect(await byStatus('q=半導體')).toEqual(expected.fragment);
    expect(await byStatus('q=orchard')).toEqual(expected.fragment);
    expect(await byStatus('q=半導&sourceType=youtube&publisherId=UC-one')).toEqual(expected.channelOne);
    expect(await byStatus('q=orchard&sourceType=youtube&publisherId=UC-one')).toEqual(expected.channelOne);

    // Publishing reaches the search filter by the time the response arrives.
    await put('youtube:ch1aaaaaaa2', 'published');
    const followed = { draft: ['youtube:ch2aaaaaaa1', 'youtube:handwritten'], published: [...expected.fragment.published, 'youtube:ch1aaaaaaa2'].sort() };
    expect(await byStatus('q=半導體')).toEqual(followed);
    expect(await byStatus('q=orchard')).toEqual(followed);

    expect((await http.inject({ method: 'POST', url: '/api/search/rebuild', headers: agent })).statusCode).toBe(200);
    expect(await byStatus('q=半導體')).toEqual(followed);

    await first.engine.close();
    const second = await startSearch(databasePath, vault);
    searchRef.current = second.search;
    expect(second.rebuilds()).toBe(0);
    const restarted = await app(collector, second.search);
    const draftsAfterRestart = (await restarted.inject({ url: '/api/search?q=orchard&status=draft', headers: agent })).json() as SearchResponse;
    expect(ids(draftsAfterRestart.hits)).toEqual(followed.draft);
    expect(draftsAfterRestart.statusCounts).toEqual({ draft: 2, published: 4 });
  });
});
