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
