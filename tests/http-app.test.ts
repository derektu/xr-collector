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
  it('reads and updates the channel schedule through HTTP', async () => {
    const calls: unknown[] = [];
    const scheduleValue = {
      enabled: true,
      intervalMinutes: 15,
      status: 'scheduled' as const,
      lastAttemptAt: null,
      lastCompletedAt: null,
      nextRunAt: '2026-09-17T00:15:00.000Z',
      lastResult: null,
    };
    const schedule = {
      getSchedule: async () => scheduleValue,
      updateSchedule: async (input: { enabled: boolean; intervalMinutes: number }) => {
        calls.push(input);
        return { ...scheduleValue, ...input };
      },
    };
    const app = await createHttpApp({ collector: makeCollector(), schedule });

    const read = await app.inject({ method: 'GET', url: '/api/youtube/schedule' });
    const updated = await app.inject({
      method: 'PUT',
      url: '/api/youtube/schedule',
      payload: { enabled: false, intervalMinutes: 60 },
    });
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/youtube/schedule',
      payload: { enabled: true, intervalMinutes: 0 },
    });

    expect(read.json()).toEqual({ schedule: scheduleValue });
    expect(updated.json()).toMatchObject({
      schedule: { enabled: false, intervalMinutes: 60 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('invalid_request');
    expect(calls).toEqual([{ enabled: false, intervalMinutes: 60 }]);
    await app.close();
  });

  it('manages channels and starts a channel collection run through HTTP', async () => {
    const savedChannel = {
      id: 'UC-channel-one',
      title: '頻道一',
      url: 'https://www.youtube.com/channel/UC-channel-one/videos',
      enabled: true,
      addedAt: '2026-09-17T00:00:00.000Z',
    };
    const run = {
      id: 'run-1',
      status: 'running' as const,
      channelIds: [savedChannel.id],
      currentChannelId: savedChannel.id,
      totalVideos: 2,
      processedVideos: 1,
      created: 1,
      existing: 0,
      failed: 0,
      results: [],
      startedAt: '2026-09-17T00:00:00.000Z',
      completedAt: null,
    };
    const calls: unknown[] = [];
    const channels = {
      listChannels: async () => [savedChannel],
      addChannel: async (url: string) => {
        calls.push(['add', url]);
        return { status: 'created' as const, channel: savedChannel };
      },
      setChannelEnabled: async (id: string, enabled: boolean) => {
        calls.push(['enabled', id, enabled]);
        return { ...savedChannel, enabled };
      },
      removeChannel: async (id: string) => {
        calls.push(['remove', id]);
      },
      startRun: async (ids?: string[]) => {
        calls.push(['run', ids]);
        return run;
      },
      getRun: (id: string) => {
        calls.push(['getRun', id]);
        return run;
      },
    };
    const app = await createHttpApp({ collector: makeCollector(), channels });

    const added = await app.inject({
      method: 'POST',
      url: '/api/youtube/channels',
      payload: { url: 'https://www.youtube.com/@channel-one' },
    });
    const listed = await app.inject({
      method: 'GET',
      url: '/api/youtube/channels',
    });
    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/youtube/channels/${savedChannel.id}`,
      payload: { enabled: false },
    });
    const started = await app.inject({
      method: 'POST',
      url: '/api/youtube/channel-runs',
      payload: { channelIds: [savedChannel.id] },
    });
    const progress = await app.inject({
      method: 'GET',
      url: '/api/youtube/channel-runs/run-1',
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/youtube/channels/${savedChannel.id}`,
    });

    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ status: 'created', channel: { id: savedChannel.id } });
    expect(listed.json()).toEqual({ channels: [savedChannel] });
    expect(disabled.json()).toMatchObject({ channel: { id: savedChannel.id, enabled: false } });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ run: { id: 'run-1', status: 'running' } });
    expect(progress.json()).toMatchObject({ run: { processedVideos: 1, totalVideos: 2 } });
    expect(removed.json()).toEqual({ removed: true });
    expect(calls).toEqual([
      ['add', 'https://www.youtube.com/@channel-one'],
      ['enabled', savedChannel.id, false],
      ['run', [savedChannel.id]],
      ['getRun', 'run-1'],
      ['remove', savedChannel.id],
    ]);
    await app.close();
  });

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
