import { describe, expect, it } from 'vitest';
import { ChannelCollector, type YouTubeChannelSource } from '../src/channels/channel-collector.js';
import type { ChannelStore } from '../src/channels/json-channel-store.js';
import { CollectorError, type CollectResult, type SavedDocument, type YouTubeChannel } from '../src/core/types.js';

class MemoryChannelStore implements ChannelStore {
  readonly channels: YouTubeChannel[] = [];

  async list(): Promise<YouTubeChannel[]> {
    return this.channels.map((channel) => ({ ...channel }));
  }

  async add(channel: YouTubeChannel): Promise<YouTubeChannel> {
    const existing = this.channels.find((candidate) => candidate.id === channel.id);
    if (existing) return existing;
    this.channels.push(channel);
    return channel;
  }

  async remove(id: string): Promise<boolean> {
    const index = this.channels.findIndex((channel) => channel.id === id);
    if (index < 0) return false;
    this.channels.splice(index, 1);
    return true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<YouTubeChannel | null> {
    const channel = this.channels.find((candidate) => candidate.id === id);
    if (!channel) return null;
    channel.enabled = enabled;
    return channel;
  }
}

describe('ChannelCollector', () => {
  it('resolves and persists a channel with collection enabled', async () => {
    const store = new MemoryChannelStore();
    const source: YouTubeChannelSource = {
      resolve: async () => ({
        id: 'UC-channel-one',
        title: '頻道一',
        url: 'https://www.youtube.com/channel/UC-channel-one/videos',
      }),
      listVideos: async () => [],
    };
    const channels = new ChannelCollector(source, store, {
      collect: async () => {
        throw new Error('not used');
      },
    }, {
      now: () => new Date('2026-09-17T00:00:00.000Z'),
    });

    const result = await channels.addChannel('https://www.youtube.com/@channel-one');

    expect(result).toEqual({
      status: 'created',
      channel: {
        id: 'UC-channel-one',
        title: '頻道一',
        url: 'https://www.youtube.com/channel/UC-channel-one/videos',
        enabled: true,
        addedAt: '2026-09-17T00:00:00.000Z',
      },
    });
    expect(await channels.listChannels()).toEqual([result.channel]);
  });

  it('collects the recent videos from every enabled channel and keeps going after failures', async () => {
    const store = new MemoryChannelStore();
    store.channels.push(
      channel('one', true),
      channel('two', true),
      channel('disabled', false),
    );
    const listedChannels: string[] = [];
    const source: YouTubeChannelSource = {
      resolve: async () => {
        throw new Error('not used');
      },
      listVideos: async (saved, limit) => {
        listedChannels.push(`${saved.id}:${limit}`);
        return saved.id === 'one'
          ? [video('aaaaaaaaaaa'), video('bbbbbbbbbbb')]
          : [video('ccccccccccc')];
      },
    };
    const channels = new ChannelCollector(source, store, {
      collect: async (url) => {
        if (url.includes('bbbbbbbbbbb')) {
          throw new CollectorError('no_subtitles', '這支影片沒有字幕。');
        }
        return collectResult(
          url.includes('ccccccccccc') ? 'existing' : 'created',
          url.match(/[a-z]{11}/u)?.[0] ?? 'aaaaaaaaaaa',
        );
      },
    }, {
      createId: () => 'run-1',
      now: () => new Date('2026-09-17T00:00:00.000Z'),
    });

    const started = await channels.startRun();
    let completed = started;
    while (completed.status !== 'completed') {
      await new Promise((resolve) => setTimeout(resolve, 0));
      completed = channels.getRun(started.id);
    }

    expect(listedChannels).toEqual(['one:10', 'two:10']);
    expect(completed).toMatchObject({
      status: 'completed',
      totalVideos: 3,
      processedVideos: 3,
      created: 1,
      existing: 1,
      failed: 1,
    });
    expect(completed.results).toEqual([
      expect.objectContaining({ videoId: 'aaaaaaaaaaa', status: 'created' }),
      expect.objectContaining({
        videoId: 'bbbbbbbbbbb',
        status: 'failed',
        error: { code: 'no_subtitles', message: '這支影片沒有字幕。' },
      }),
      expect.objectContaining({ videoId: 'ccccccccccc', status: 'existing' }),
    ]);
  });

  it('changes enabled state and removes channels through its interface', async () => {
    const store = new MemoryChannelStore();
    store.channels.push(channel('one', true));
    const channels = new ChannelCollector({
      resolve: async () => {
        throw new Error('not used');
      },
      listVideos: async () => [],
    }, store, {
      collect: async () => {
        throw new Error('not used');
      },
    });

    expect(await channels.setChannelEnabled('one', false)).toMatchObject({
      id: 'one',
      enabled: false,
    });
    await channels.removeChannel('one');
    expect(await channels.listChannels()).toEqual([]);
  });
});

function channel(id: string, enabled: boolean): YouTubeChannel {
  return {
    id,
    title: `頻道 ${id}`,
    url: `https://www.youtube.com/channel/${id}/videos`,
    enabled,
    addedAt: '2026-09-17T00:00:00.000Z',
  };
}

function video(id: string) {
  return { id, title: `影片 ${id}`, url: `https://www.youtube.com/watch?v=${id}` };
}

function collectResult(status: CollectResult['status'], id: string): CollectResult {
  const document: SavedDocument = {
    id: `youtube:${id}`,
    type: 'Transcript',
    title: `影片 ${id}`,
    sourceUrl: `https://www.youtube.com/watch?v=${id}`,
    sourceId: id,
    channelId: null,
    channelTitle: '測試頻道',
    publishedAt: null,
    collectedAt: '2026-09-17T00:00:00.000Z',
    languageCode: 'zh-Hant',
    languageName: null,
    subtitleKind: 'automatic',
    bodyMarkdown: '內容',
  };
  return {
    status,
    document,
    searchStatus: { state: 'ready', indexedDocuments: 1 },
  };
}
