import { describe, expect, it } from 'vitest';
import { Collector, type DocumentVault, type YouTubeCapture } from '../src/core/collector.js';
import type {
  CapturedTranscript,
  DocumentSummary,
  SavedDocument,
  YouTubeVideoRef,
} from '../src/core/types.js';

const captureResult: CapturedTranscript = {
  videoId: 'dQw4w9WgXcQ',
  sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: '測試影片',
  channelId: 'channel-1',
  channelTitle: '測試頻道',
  publishedAt: '2026-09-01T00:00:00.000Z',
  languageCode: 'zh-Hant',
  languageName: '繁體中文',
  subtitleKind: 'manual',
  bodyMarkdown: '第一句',
};

class MemoryVault implements DocumentVault {
  document: SavedDocument | null = null;

  async getBySourceId(): Promise<SavedDocument | null> {
    return this.document;
  }

  async add(capture: CapturedTranscript): Promise<SavedDocument> {
    this.document = {
      id: `youtube:${capture.videoId}`,
      type: 'Transcript',
      title: capture.title,
      sourceUrl: capture.sourceUrl,
      sourceId: capture.videoId,
      channelId: capture.channelId,
      channelTitle: capture.channelTitle,
      publishedAt: capture.publishedAt,
      collectedAt: '2026-09-17T00:00:00.000Z',
      languageCode: capture.languageCode,
      languageName: capture.languageName,
      subtitleKind: capture.subtitleKind,
      bodyMarkdown: capture.bodyMarkdown,
    };
    return this.document;
  }

  async list(): Promise<DocumentSummary[]> {
    return [];
  }

  async read(): Promise<SavedDocument | null> {
    return this.document;
  }
}

describe('Collector', () => {
  it('returns the existing document without calling YouTube again', async () => {
    const vault = new MemoryVault();
    await vault.add(captureResult);
    const capture: YouTubeCapture = {
      capture: async () => {
        throw new Error('capture must not run');
      },
    };
    const collector = new Collector(capture, vault);

    const result = await collector.collect(captureResult.sourceUrl);

    expect(result.status).toBe('existing');
    expect(result.document.id).toBe('youtube:dQw4w9WgXcQ');
  });

  it('coalesces concurrent collection of the same video', async () => {
    const vault = new MemoryVault();
    let captureCount = 0;
    const capture: YouTubeCapture = {
      async capture(_video: YouTubeVideoRef) {
        captureCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return captureResult;
      },
    };
    const collector = new Collector(capture, vault);

    const [first, second] = await Promise.all([
      collector.collect(captureResult.sourceUrl),
      collector.collect(captureResult.sourceUrl),
    ]);

    expect(captureCount).toBe(1);
    expect(first.document.id).toBe(second.document.id);
  });
});
