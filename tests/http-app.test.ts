import { describe, expect, it } from 'vitest';
import { Collector, type DocumentVault, type YouTubeCapture } from '../src/core/collector.js';
import { CollectorError, type CapturedTranscript, type SavedDocument } from '../src/core/types.js';
import { createHttpApp } from '../src/server/app.js';

const captured: CapturedTranscript = {
  videoId: 'dQw4w9WgXcQ',
  sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'HTTP 測試',
  channelId: null,
  channelTitle: '測試頻道',
  publishedAt: null,
  languageCode: 'zh-Hant',
  languageName: null,
  subtitleKind: 'automatic',
  bodyMarkdown: '內容',
};

function makeCollector(captureFailure?: CollectorError): Collector {
  let saved: SavedDocument | null = null;
  const capture: YouTubeCapture = {
    capture: async () => {
      if (captureFailure) throw captureFailure;
      return captured;
    },
  };
  const vault: DocumentVault = {
    getBySourceId: async () => saved,
    add: async (input) => {
      saved = {
        id: `youtube:${input.videoId}`,
        type: 'Transcript',
        title: input.title,
        sourceUrl: input.sourceUrl,
        sourceId: input.videoId,
        channelId: input.channelId,
        channelTitle: input.channelTitle,
        publishedAt: input.publishedAt,
        collectedAt: '2026-09-17T00:00:00.000Z',
        languageCode: input.languageCode,
        languageName: input.languageName,
        subtitleKind: input.subtitleKind,
        bodyMarkdown: input.bodyMarkdown,
      };
      return saved;
    },
    list: async () => [],
    read: async () => saved,
  };
  return new Collector(capture, vault);
}

describe('HTTP app', () => {
  it('searches transcript text with channel and published-date filters', async () => {
    const searchRequests: unknown[] = [];
    const search = {
      status: () => ({ state: 'ready' as const, indexedDocuments: 2 }),
      index: async () => undefined,
      search: async (request: unknown) => {
        searchRequests.push(request);
        return {
          hits: [
            {
              id: 'youtube:dQw4w9WgXcQ',
              title: '搜尋結果',
              channelTitle: '測試頻道',
              publishedAt: '2026-09-12T00:00:00.000Z',
              languageCode: 'zh-Hant',
              subtitleKind: 'manual' as const,
              snippet: '…符合條件的字幕內容…',
            },
          ],
          estimatedTotalHits: 1,
        };
      },
      rebuild: async () => undefined,
    };
    const app = await createHttpApp({ collector: makeCollector(), search });

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=%E6%A2%9D%E4%BB%B6&channel=%E6%B8%AC%E8%A9%A6%E9%A0%BB%E9%81%93&publishedFrom=2026-09-01&publishedTo=2026-09-30',
    });

    expect(response.statusCode).toBe(200);
    expect(searchRequests).toEqual([
      {
        query: '條件',
        channel: '測試頻道',
        publishedFrom: '2026-09-01',
        publishedTo: '2026-09-30',
      },
    ]);
    expect(response.json()).toEqual({
      hits: [
        expect.objectContaining({
          id: 'youtube:dQw4w9WgXcQ',
          snippet: '…符合條件的字幕內容…',
        }),
      ],
      estimatedTotalHits: 1,
    });
    await app.close();
  });

  it('rejects an invalid published-date filter before searching', async () => {
    let searchCount = 0;
    const search = {
      status: () => ({ state: 'ready' as const, indexedDocuments: 0 }),
      search: async () => {
        searchCount += 1;
        return { hits: [], estimatedTotalHits: 0 };
      },
      index: async () => undefined,
      rebuild: async () => undefined,
    };
    const app = await createHttpApp({ collector: makeCollector(), search });

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&publishedFrom=not-a-date',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_request');
    expect(searchCount).toBe(0);
    await app.close();
  });

  it('collects a video through the public HTTP interface', async () => {
    const app = await createHttpApp({ collector: makeCollector() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/youtube/collect',
      payload: { url: captured.sourceUrl },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'created',
      document: { id: 'youtube:dQw4w9WgXcQ', title: 'HTTP 測試' },
    });
    await app.close();
  });

  it('returns a stable error code when no subtitles exist', async () => {
    const app = await createHttpApp({
      collector: makeCollector(new CollectorError('no_subtitles', '沒有字幕')),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/youtube/collect',
      payload: { url: captured.sourceUrl },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: { code: 'no_subtitles', message: '沒有字幕' },
    });
    await app.close();
  });

  it('rejects malformed requests without invoking collection', async () => {
    const app = await createHttpApp({ collector: makeCollector() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/youtube/collect',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_request');
    await app.close();
  });
});
