import { describe, expect, it } from 'vitest';
import { SubscriptionService } from '../../src/subscriptions/subscription-service.js';
import type { SubscriptionPatch, SubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import { DEFAULT_POLICY } from '../../src/plugins/youtube/settings.js';
import { Collector, type DocumentVault } from '../../src/core/collector.js';
import type { SubscriptionRecord } from '../../src/core/types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import type { YouTubeSource } from '../../src/plugins/youtube/adapter.js';
import { youtubePlugin } from '../../src/plugins/youtube/server.js';

class MemoryChannelStore implements SubscriptionStore {
  readonly channels: SubscriptionRecord[] = [];

  async list(): Promise<SubscriptionRecord[]> {
    return this.channels.map((channel) => ({ ...channel }));
  }

  async add(channel: SubscriptionRecord): Promise<SubscriptionRecord> {
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

  async setEnabled(id: string, enabled: boolean): Promise<SubscriptionRecord | null> {
    return this.update(id, { enabled });
  }

  async updateWith(change: (channels: readonly SubscriptionRecord[]) => Map<string, SubscriptionPatch>): Promise<SubscriptionRecord[]> {
    return this.updateMany(change(await this.list()));
  }

  async updateMany(patches: Map<string, SubscriptionPatch>): Promise<SubscriptionRecord[]> {
    const updated: SubscriptionRecord[] = [];
    for (const [id, patch] of patches) {
      const channel = await this.update(id, patch);
      if (channel) updated.push(channel);
    }
    return updated;
  }

  async update(id: string, patch: SubscriptionPatch): Promise<SubscriptionRecord | null> {
    const channel = this.channels.find((candidate) => candidate.id === id);
    if (!channel) return null;
    Object.assign(channel, patch);
    return { ...channel };
  }
}

const emptyVault: DocumentVault = {
  getByKey: async () => null,
  add: async () => { throw new Error('not used'); },
  list: async () => [],
  read: async () => null,
};

function setup(source: Partial<YouTubeSource> = {}) {
  const store = new MemoryChannelStore();
  const jobs = new JobManager({
    vaultPath: '/vault',
    store: JobStore.memory(),
    plugins: [youtubePlugin({
      resolveChannel: async () => { throw new Error('not used'); },
      discover: async () => [],
      capture: async () => { throw new Error('not used'); },
      ...source,
    })],
    documents: new Collector(emptyVault),
    subscriptions: { youtube: store },
  });
  return {
    store,
    jobs,
    channels: new SubscriptionService('youtube', store, jobs, {
      autoCollection: async () => true,
      resolveTarget: async () => { throw new Error('not used'); },
      documents: async () => [],
    }),
  };
}

describe('SubscriptionService', () => {
  it('accepts a channel address as a job that resolves and persists it with collection enabled', async () => {
    const { store, jobs, channels } = setup({
      resolveChannel: async () => ({ id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123/videos' }),
    });

    const submission = await channels.add('https://www.youtube.com/@sample');
    expect(submission.job).toMatchObject({ kind: 'youtube.channel-add', state: 'queued' });
    expect(await jobs.whenSettled(submission.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'created', channelId: 'UC123' } });
    expect(store.channels).toEqual([expect.objectContaining({ id: 'UC123', title: '測試頻道', enabled: true, settings: DEFAULT_POLICY })]);
    await jobs.close();
  });

  it('submits one job per enabled channel, or per requested channel', async () => {
    const { store, jobs, channels } = setup();
    store.channels.push(channel('one', true), channel('two', false), channel('three', true));

    const enabled = await channels.startRun({ trigger: 'manual' });
    expect(enabled.map(({ job }) => job.source.id)).toEqual(['one', 'three']);
    await Promise.all(enabled.map(({ job }) => channels.whenSettled(job.id)));
    const requested = await channels.startRun({ trigger: 'manual', subscriptionIds: ['three', 'one', 'three'] });
    expect(requested.map(({ job }) => job.source.id)).toEqual(['three', 'one']);
    await expect(channels.startRun({ trigger: 'manual', subscriptionIds: ['missing'] })).rejects.toMatchObject({ code: 'subscription_not_found' });
    await expect(channels.startRun({ trigger: 'manual', subscriptionIds: ['two'] })).rejects.toMatchObject({ code: 'subscription_paused' });
    await Promise.all([...enabled, ...requested].map(({ job }) => channels.whenSettled(job.id)));
    await jobs.close();
  });

  it('changes enabled state and removes channels through its interface', async () => {
    const { store, channels } = setup();
    store.channels.push(channel('one', true));

    expect(await channels.setEnabled('one', false)).toMatchObject({
      subscription: { id: 'one', enabled: false },
      submission: null,
    });
    expect(await channels.remove('one')).toEqual({ documentsKept: 0, documentsDeleted: 0, documentsFailed: 0 });
    expect(await channels.list()).toEqual([]);
    await expect(channels.startRun({ trigger: 'manual' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await channels.startRun({ trigger: 'scheduled' })).toEqual([]);
  });
});

function channel(id: string, enabled: boolean): SubscriptionRecord {
  return {
    id,
    title: `頻道 ${id}`,
    url: `https://www.youtube.com/channel/${id}/videos`,
    enabled,
    addedAt: '2026-09-17T00:00:00.000Z',
    settings: DEFAULT_POLICY,
  };
}
