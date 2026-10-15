import { describe, expect, it } from 'vitest';
import { ChannelCollector } from '../../src/channels/channel-collector.js';
import type { ChannelStore } from '../../src/channels/json-channel-store.js';
import { Collector, type DocumentVault } from '../../src/core/collector.js';
import type { YouTubeChannel } from '../../src/core/types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import type { YouTubeSource } from '../../src/sources/youtube/adapter.js';

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

const emptyVault: DocumentVault = {
  getBySourceId: async () => null,
  add: async () => { throw new Error('not used'); },
  list: async () => [],
  read: async () => null,
};

function setup(source: Partial<YouTubeSource> = {}) {
  const store = new MemoryChannelStore();
  const jobs = new JobManager({
    vaultPath: '/vault',
    store: JobStore.memory(),
    source: {
      resolveChannel: async () => { throw new Error('not used'); },
      discover: async () => [],
      capture: async () => { throw new Error('not used'); },
      ...source,
    },
    documents: new Collector(emptyVault),
    channels: store,
  });
  return { store, jobs, channels: new ChannelCollector(store, jobs) };
}

describe('ChannelCollector', () => {
  it('accepts a channel address as a job that resolves and persists it with collection enabled', async () => {
    const { store, jobs, channels } = setup({
      resolveChannel: async () => ({ id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123/videos' }),
    });

    const submission = await channels.addChannel('https://www.youtube.com/@sample');
    expect(submission.job).toMatchObject({ kind: 'youtube.channel-add', state: 'queued' });
    expect(await jobs.whenSettled(submission.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'created', channelId: 'UC123' } });
    expect(store.channels).toEqual([expect.objectContaining({ id: 'UC123', title: '測試頻道', enabled: true })]);
    await jobs.close();
  });

  it('submits one job per enabled channel, or per requested channel', async () => {
    const { store, jobs, channels } = setup();
    store.channels.push(channel('one', true), channel('two', false), channel('three', true));

    const enabled = await channels.startRun();
    expect(enabled.map(({ job }) => job.source.id)).toEqual(['one', 'three']);
    const requested = await channels.startRun(['two', 'one', 'two']);
    expect(requested.map(({ job }) => job.source.id)).toEqual(['two', 'one']);
    await expect(channels.startRun(['missing'])).rejects.toMatchObject({ code: 'channel_not_found' });
    await Promise.all([...enabled, ...requested].map(({ job }) => channels.whenSettled(job.id)));
    await jobs.close();
  });

  it('changes enabled state and removes channels through its interface', async () => {
    const { store, channels } = setup();
    store.channels.push(channel('one', true));

    expect(await channels.setChannelEnabled('one', false)).toMatchObject({
      id: 'one',
      enabled: false,
    });
    await channels.removeChannel('one');
    expect(await channels.listChannels()).toEqual([]);
    await expect(channels.startRun()).rejects.toMatchObject({ code: 'invalid_request' });
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
