import { describe, expect, it } from 'vitest';
import { MAX_PENDING_REMOVALS } from '../../src/search/managed-transcript-search.js';
import type { SavedDocument } from '../../src/core/types.js';
import {
  ManagedTranscriptSearch,
  type SearchBackend,
  type SearchStateStore,
} from '../../src/search/managed-transcript-search.js';
import { indexKey, MeilisearchBackend } from '../../src/search/meilisearch-backend.js';

const documents: SavedDocument[] = [
  {
    id: 'youtube:dQw4w9WgXcQ',
    type: 'Transcript',
    sourceType: 'youtube',
    sourceId: 'dQw4w9WgXcQ',
    sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: '第一支影片',
    publisher: { id: 'channel-1', name: '測試頻道' },
    publishedAt: '2026-09-01T00:00:00.000Z',
    collectedAt: '2026-09-17T00:00:00.000Z',
    youtube: { languageCode: 'zh-Hant', languageName: '繁體中文', subtitleKind: 'manual' },
    bodyMarkdown: '第一份字幕',
  },
  {
    id: 'youtube:aqz-KE-bpKQ',
    type: 'Transcript',
    sourceType: 'youtube',
    sourceId: 'aqz-KE-bpKQ',
    sourceUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    title: '第二支影片',
    publisher: { id: 'channel-2', name: '另一個頻道' },
    publishedAt: '2026-09-02T00:00:00.000Z',
    collectedAt: '2026-09-17T00:01:00.000Z',
    youtube: { languageCode: 'en', languageName: 'English', subtitleKind: 'automatic' },
    bodyMarkdown: 'Second transcript',
  },
];

function fakeBackend(current: boolean, rebuilt: SavedDocument[][]): SearchBackend {
  return {
    initialize: async () => undefined,
    count: async () => documents.length,
    isCurrent: async () => current,
    replaceAll: async (items) => {
      rebuilt.push(items);
    },
    upsert: async () => undefined,
    remove: async () => undefined,
    search: async () => ({ hits: [], total: 0, offset: 0, limit: 50 }),
  };
}

function memoryStateStore(initial: string | null = null): SearchStateStore & { saved: Array<string | null> } {
  let lastRebuiltAt = initial;
  const saved: Array<string | null> = [];
  return {
    saved,
    load: async () => ({ lastRebuiltAt }),
    save: async (state) => {
      lastRebuiltAt = state.lastRebuiltAt;
      saved.push(state.lastRebuiltAt);
    },
  };
}

describe('ManagedTranscriptSearch', () => {
  it('rebuilds a stale index from the authoritative vault on startup and records when', async () => {
    const rebuilt: SavedDocument[][] = [];
    const store = memoryStateStore();
    const search = new ManagedTranscriptSearch(
      fakeBackend(false, rebuilt),
      async () => documents,
      store,
      () => new Date('2026-10-15T01:02:03.000Z'),
    );

    await search.start();

    expect(rebuilt).toEqual([documents]);
    expect(store.saved).toEqual(['2026-10-15T01:02:03.000Z']);
    expect(search.status()).toEqual({
      state: 'ready',
      indexedDocuments: 2,
      lastRebuiltAt: '2026-10-15T01:02:03.000Z',
    });
  });

  it('keeps a current index and reports the stored rebuild time after a restart', async () => {
    const rebuilt: SavedDocument[][] = [];
    const search = new ManagedTranscriptSearch(
      fakeBackend(true, rebuilt),
      async () => documents,
      memoryStateStore('2026-10-01T00:00:00.000Z'),
    );

    await search.start();

    expect(rebuilt).toEqual([]);
    expect(search.status()).toMatchObject({ state: 'ready', lastRebuiltAt: '2026-10-01T00:00:00.000Z' });
  });

  it('forces a full replacement for a new semantic profile and records it only after success', async () => {
    const rebuilt: SavedDocument[][] = [];
    const recorded: string[] = [];
    const search = new ManagedTranscriptSearch(
      fakeBackend(true, rebuilt),
      async () => documents,
      undefined,
      () => new Date('2026-10-24T00:00:00.000Z'),
      { forceRebuild: true, afterRebuild: async () => { recorded.push('profile'); } },
    );
    await search.start();
    expect(rebuilt).toEqual([documents]);
    expect(recorded).toEqual(['profile']);
  });

  it('enters the error state when committing the semantic profile fails', async () => {
    const search = new ManagedTranscriptSearch(
      fakeBackend(false, []),
      async () => documents,
      undefined,
      () => new Date(),
      { afterRebuild: async () => { throw new Error('marker disk full'); } },
    );
    await expect(search.start()).rejects.toThrow('marker disk full');
    expect(search.status()).toMatchObject({ state: 'error', message: '無法啟動搜尋索引。' });
  });

  it('reports a failed rebuild with its reason and keeps the previous rebuild time', async () => {
    const store = memoryStateStore('2026-10-01T00:00:00.000Z');
    const backend = { ...fakeBackend(true, []), replaceAll: async () => { throw new Error('engine down'); } };
    const search = new ManagedTranscriptSearch(backend, async () => documents, store);
    await search.start();

    await expect(search.rebuild()).rejects.toThrow('engine down');

    expect(search.status()).toEqual({
      state: 'error',
      indexedDocuments: 2,
      lastRebuiltAt: '2026-10-01T00:00:00.000Z',
      message: '無法重建搜尋索引。',
    });
    await expect(search.search({ query: '字幕' })).rejects.toMatchObject({ code: 'search_unavailable' });
  });

  it('keys documents by their full ID and filters by stable source and publisher IDs', async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      requests.push({ url, method, body });

      if (url.endsWith('/indexes/documents_v2') && method === 'GET') {
        return Response.json({ uid: 'documents_v2', primaryKey: 'key' });
      }
      if (url.endsWith('/indexes/transcripts') && method === 'GET') {
        return Response.json({ message: 'not found' }, { status: 404 });
      }
      if (url.endsWith('/indexes/documents_v2/settings') && method === 'PATCH') {
        return Response.json({ taskUid: 1 }, { status: 202 });
      }
      if (url.endsWith('/tasks/1')) {
        return Response.json({ uid: 1, status: 'succeeded', error: null });
      }
      if (url.includes('/indexes/documents_v2/documents?fields=key,contentHash')) {
        return Response.json({ results: [], total: 0 });
      }
      if (url.endsWith('/indexes/documents_v2/documents') && method === 'DELETE') {
        return Response.json({ taskUid: 1 }, { status: 202 });
      }
      if (url.endsWith('/indexes/documents_v2/documents') && method === 'PUT') {
        return Response.json({ taskUid: 1 }, { status: 202 });
      }
      if (url.endsWith('/indexes/documents_v2/search') && method === 'POST') {
        return Response.json({
          hits: [{
            id: documents[0]!.id,
            type: 'Transcript',
            sourceType: 'youtube',
            sourceId: documents[0]!.sourceId,
            sourceUrl: documents[0]!.sourceUrl,
            title: documents[0]!.title,
            publisherId: 'channel-1',
            publisherName: '測試頻道',
            publishedAt: documents[0]!.publishedAt,
            collectedAt: documents[0]!.collectedAt,
            youtube: documents[0]!.youtube,
            bodyMarkdown: documents[0]!.bodyMarkdown,
            _formatted: { bodyMarkdown: '…<mark>關鍵字</mark>出現在這裡…' },
          }],
          totalHits: 41,
          page: 3,
          hitsPerPage: 20,
        });
      }
      return Response.json({ message: `Unexpected request: ${method} ${url}` }, { status: 500 });
    };
    const backend = new MeilisearchBackend({
      baseUrl: 'http://127.0.0.1:7177',
      apiKey: 'test-master-key-at-least-16-bytes',
      fetch: fakeFetch,
    });
    const search = new ManagedTranscriptSearch(backend, async () => documents);
    await search.start();

    const settings = requests.find(({ url, method }) => url.endsWith('/settings') && method === 'PATCH')?.body as Record<string, unknown>;
    expect(settings).toEqual({
      searchableAttributes: ['title', 'publisherName', 'bodyMarkdown'],
      filterableAttributes: ['id', 'sourceType', 'publisherId', 'publishedAtEpoch'],
      pagination: { maxTotalHits: 10_000 },
    });
    expect(settings).not.toHaveProperty('localizedAttributes');

    const indexed = requests.find(({ url, method }) => url.endsWith('/documents') && method === 'PUT')?.body as Array<{ key: string }>;
    expect(indexed.map(({ key }) => key)).toEqual(documents.map(({ id }) => indexKey(id)));
    expect(Buffer.from(indexed[0]!.key, 'base64url').toString()).toBe('youtube:dQw4w9WgXcQ');

    const result = await search.search({
      query: '關鍵字',
      sourceType: 'youtube',
      publisherId: 'channel-1',
      publishedFrom: '2026-09-01',
      publishedTo: '2026-09-30',
      offset: 40,
      limit: 20,
    });

    expect(result).toEqual({
      hits: [{
        id: 'youtube:dQw4w9WgXcQ',
        type: 'Transcript',
        sourceType: 'youtube',
        sourceId: 'dQw4w9WgXcQ',
        sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: '第一支影片',
        publisher: { id: 'channel-1', name: '測試頻道' },
        publishedAt: '2026-09-01T00:00:00.000Z',
        collectedAt: '2026-09-17T00:00:00.000Z',
        youtube: { languageCode: 'zh-Hant', languageName: '繁體中文', subtitleKind: 'manual' },
        snippet: '…<mark>關鍵字</mark>出現在這裡…',
      }],
      total: 41,
      offset: 40,
      limit: 20,
    });
    const searchRequest = requests.find(({ url }) => url.endsWith('/search'));
    expect(searchRequest?.body).toMatchObject({
      q: '關鍵字',
      matchingStrategy: 'all',
      page: 3,
      hitsPerPage: 20,
      filter: [
        'sourceType = "youtube"',
        'publisherId = "channel-1"',
        'publishedAtEpoch >= 1788220800000',
        'publishedAtEpoch <= 1790812799999',
      ],
      attributesToCrop: ['bodyMarkdown:32'],
      highlightPreTag: '<mark>',
    });

    await search.search({ query: '關鍵字', sourceType: 'youtube', publisherId: 'none' });
    expect(requests.filter(({ url }) => url.endsWith('/search')).at(-1)?.body).toMatchObject({
      filter: ['sourceType = "youtube"', 'publisherId IS NULL'],
    });
  });

  it('gives different source types with the same source ID different keys', () => {
    expect(indexKey('youtube:abc')).not.toBe(indexKey('rss:abc'));
  });
});

/** A backend holding documents in memory that applies the exclusion like the engine filter does. */
function recordingBackend(initial: SavedDocument[]) {
  const held = new Map(initial.map((document) => [document.id, document]));
  const calls = { removes: [] as string[][], excludes: [] as string[][], rebuilds: 0 };
  let removeFails = false;
  const backend: SearchBackend = {
    initialize: async () => undefined,
    count: async () => held.size,
    isCurrent: async (items) => items.length === held.size && items.every((item) => held.has(item.id)),
    replaceAll: async (items) => { calls.rebuilds += 1; held.clear(); for (const item of items) held.set(item.id, item); },
    upsert: async (document) => { held.set(document.id, document); },
    remove: async (ids) => { calls.removes.push(ids); if (removeFails) throw new Error('engine down'); for (const id of ids) held.delete(id); },
    search: async (_query, excludeIds) => {
      calls.excludes.push(excludeIds);
      const hits = [...held.values()].filter((document) => !excludeIds.includes(document.id)).map((document) => ({ ...document, snippet: document.bodyMarkdown }));
      return { hits, total: hits.length, offset: 0, limit: 50 };
    },
  };
  return { backend, held, calls, setRemoveFails(value: boolean) { removeFails = value; } };
}

describe('removing deleted documents from search (A3)', () => {
  it('excludes a document whose removal failed and removes it with the next index change', async () => {
    let vault = [...documents];
    const engine = recordingBackend(documents);
    const search = new ManagedTranscriptSearch(engine.backend, async () => vault);
    await search.start();
    const [first, second] = documents as [SavedDocument, SavedDocument];

    engine.setRemoveFails(true);
    vault = [second];
    await expect(search.remove(first.id)).rejects.toThrow('engine down');

    expect(search.status().state).toBe('ready');
    const result = await search.search({ query: '字幕' });
    expect(result.hits.map(({ id }) => id)).toEqual([second.id]);
    expect(result.total).toBe(1);
    expect(engine.calls.excludes.at(-1)).toEqual([first.id]);
    expect(engine.held.has(first.id)).toBe(true);

    engine.setRemoveFails(false);
    await search.index(second);
    expect(engine.held.has(first.id)).toBe(false);
    await search.search({ query: '字幕' });
    expect(engine.calls.excludes.at(-1)).toEqual([]);
  });

  it('rebuilds from the Vault instead of sending a filter longer than the limit', async () => {
    const many = Array.from({ length: MAX_PENDING_REMOVALS + 2 }, (_, index) => ({
      ...documents[0]!, id: `youtube:${String(index).padStart(11, 'x')}`, sourceId: String(index).padStart(11, 'x'),
    }));
    let vault = [...many];
    const engine = recordingBackend(many);
    const search = new ManagedTranscriptSearch(engine.backend, async () => vault);
    await search.start();
    engine.setRemoveFails(true);

    for (const document of many.slice(0, MAX_PENDING_REMOVALS)) {
      vault = vault.filter((candidate) => candidate.id !== document.id);
      await search.remove(document.id).catch(() => undefined);
    }
    await search.search({ query: 'x' });
    expect(engine.calls.excludes.at(-1)).toHaveLength(MAX_PENDING_REMOVALS);

    const extra = many[MAX_PENDING_REMOVALS]!;
    vault = vault.filter((candidate) => candidate.id !== extra.id);
    await search.remove(extra.id);

    expect(engine.calls.rebuilds).toBe(1);
    expect([...engine.held.keys()]).toEqual([many[MAX_PENDING_REMOVALS + 1]!.id]);
    await search.search({ query: 'x' });
    expect(engine.calls.excludes.at(-1)).toEqual([]);
    expect(Math.max(...engine.calls.excludes.map((ids) => ids.length))).toBeLessThanOrEqual(MAX_PENDING_REMOVALS);
  });

  it('rebuilds at the next start when a removal never reached the index', async () => {
    const engine = recordingBackend(documents);
    const search = new ManagedTranscriptSearch(engine.backend, async () => [documents[1]!]);
    await search.start();
    expect(engine.calls.rebuilds).toBe(1);
    expect([...engine.held.keys()]).toEqual([documents[1]!.id]);
  });
});
