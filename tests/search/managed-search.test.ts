import { describe, expect, it } from 'vitest';
import type { SavedDocument } from '../../src/core/types.js';
import {
  ManagedTranscriptSearch,
  type SearchBackend,
} from '../../src/search/managed-transcript-search.js';
import { MeilisearchBackend } from '../../src/search/meilisearch-backend.js';

const documents: SavedDocument[] = [
  {
    id: 'youtube:dQw4w9WgXcQ',
    type: 'Transcript',
    title: '第一支影片',
    sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    sourceId: 'dQw4w9WgXcQ',
    channelId: 'channel-1',
    channelTitle: '測試頻道',
    publishedAt: '2026-09-01T00:00:00.000Z',
    collectedAt: '2026-09-17T00:00:00.000Z',
    languageCode: 'zh-Hant',
    languageName: '繁體中文',
    subtitleKind: 'manual',
    bodyMarkdown: '第一份字幕',
  },
  {
    id: 'youtube:aqz-KE-bpKQ',
    type: 'Transcript',
    title: '第二支影片',
    sourceUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    sourceId: 'aqz-KE-bpKQ',
    channelId: 'channel-2',
    channelTitle: '另一個頻道',
    publishedAt: '2026-09-02T00:00:00.000Z',
    collectedAt: '2026-09-17T00:01:00.000Z',
    languageCode: 'en',
    languageName: 'English',
    subtitleKind: 'automatic',
    bodyMarkdown: 'Second transcript',
  },
];

describe('ManagedTranscriptSearch', () => {
  it('rebuilds a missing index from the authoritative vault on startup', async () => {
    const rebuilt: SavedDocument[][] = [];
    const backend: SearchBackend = {
      initialize: async () => undefined,
      count: async () => 0,
      replaceAll: async (items) => {
        rebuilt.push(items);
      },
      upsert: async () => undefined,
      search: async () => ({ hits: [], estimatedTotalHits: 0 }),
    };
    const search = new ManagedTranscriptSearch(backend, async () => documents);

    await search.start();

    expect(rebuilt).toEqual([documents]);
    expect(search.status()).toEqual({
      state: 'ready',
      indexedDocuments: 2,
    });
  });

  it('returns a cropped transcript hit through the public search seam', async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      requests.push({ url, method, body });

      if (url.endsWith('/indexes/transcripts') && method === 'GET') {
        return Response.json({ uid: 'transcripts', primaryKey: 'key' });
      }
      if (url.endsWith('/indexes/transcripts/settings') && method === 'PATCH') {
        return Response.json({ taskUid: 1 }, { status: 202 });
      }
      if (url.endsWith('/tasks/1')) {
        return Response.json({ uid: 1, status: 'succeeded', error: null });
      }
      if (url.endsWith('/indexes/transcripts/stats')) {
        return Response.json({ numberOfDocuments: 2 });
      }
      if (url.endsWith('/indexes/transcripts/search') && method === 'POST') {
        return Response.json({
          hits: [
            {
              id: documents[0]!.id,
              title: documents[0]!.title,
              channelTitle: documents[0]!.channelTitle,
              publishedAt: documents[0]!.publishedAt,
              collectedAt: documents[0]!.collectedAt,
              languageCode: documents[0]!.languageCode,
              subtitleKind: documents[0]!.subtitleKind,
              _formatted: { bodyMarkdown: '…關鍵字出現在這裡…' },
            },
          ],
          estimatedTotalHits: 1,
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

    const result = await search.search({
      query: '關鍵字',
      channel: '測試頻道',
      publishedFrom: '2026-09-01',
      publishedTo: '2026-09-30',
    });

    expect(result).toEqual({
      hits: [
        expect.objectContaining({
          id: 'youtube:dQw4w9WgXcQ',
          snippet: '…關鍵字出現在這裡…',
        }),
      ],
      estimatedTotalHits: 1,
    });
    const searchRequest = requests.find(({ url }) => url.endsWith('/search'));
    expect(searchRequest?.body).toMatchObject({
      q: '關鍵字',
      matchingStrategy: 'all',
      filter: [
        'channelTitle = "測試頻道"',
        'publishedAtEpoch >= 1788220800000',
        'publishedAtEpoch <= 1790812799999',
      ],
      attributesToCrop: ['bodyMarkdown:32'],
    });
  });
});
