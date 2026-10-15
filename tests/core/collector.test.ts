import { describe, expect, it } from 'vitest';
import { Collector, type DocumentVault } from '../../src/core/collector.js';
import type {
  CapturedTranscript,
  DocumentMetadata,
  SavedDocument,
} from '../../src/core/types.js';

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
      sourceType: 'youtube',
      sourceUrl: capture.sourceUrl,
      sourceId: capture.videoId,
      publisher: { id: capture.channelId, name: capture.channelTitle },
      publishedAt: capture.publishedAt,
      collectedAt: '2026-09-17T00:00:00.000Z',
      youtube: { languageCode: capture.languageCode, languageName: capture.languageName, subtitleKind: capture.subtitleKind },
      bodyMarkdown: capture.bodyMarkdown,
    };
    return this.document;
  }

  async list(): Promise<DocumentMetadata[]> {
    return [];
  }

  async read(): Promise<SavedDocument | null> {
    return this.document;
  }
}

describe('Collector', () => {
  it('keeps a newly saved document when its search-index update fails', async () => {
    const vault = new MemoryVault();
    let indexAttempted = false;
    const collector = new Collector(vault, {
      index: async () => {
        indexAttempted = true;
        throw new Error('index unavailable');
      },
    });

    const { document } = await collector.save(captureResult);
    const outcome = await collector.index(document);

    expect(indexAttempted).toBe(true);
    expect(outcome).toEqual({ indexed: false, message: expect.any(String) });
    expect(await collector.read('youtube:dQw4w9WgXcQ')).toMatchObject({ title: '測試影片' });
  });

  it('finds an existing document by its YouTube ID', async () => {
    const vault = new MemoryVault();
    const collector = new Collector(vault, { index: async () => undefined });
    expect(await collector.findExisting('dQw4w9WgXcQ')).toBeNull();
    const { document } = await collector.save(captureResult);
    expect(await collector.findExisting('dQw4w9WgXcQ')).toEqual(document);
    expect(await collector.index(document)).toEqual({ indexed: true });
  });
});
