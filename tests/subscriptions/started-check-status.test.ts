import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Collector } from '../../src/core/collector.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { forwardingPort } from '../../src/jobs/subscription-port.js';
import { youtubePlugin } from '../../src/plugins/youtube/server.js';
import { SubscriptionService, SubscriptionServices } from '../../src/subscriptions/subscription-service.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import { MemoryDocuments, SyntheticYouTube } from './synthetic-youtube.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** Real subscription and job services over synthetic channels, with one capture slot that rotates between checks. */
async function world() {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-started-check-'));
  roots.push(root);
  const now = () => new Date('2026-10-15T04:00:00.000Z');
  const source = new SyntheticYouTube();
  const collector = new Collector(new MemoryDocuments(now));
  const jobs: JobManager = new JobManager({
    vaultPath: root, store: JobStore.memory(now), plugins: [youtubePlugin(source)], documents: collector,
    subscriptions: forwardingPort(() => new SubscriptionServices([channels])), now,
    limits: { discovery: 1, capture: 1 }, setTimer: () => () => undefined,
  });
  const channels = new SubscriptionService('youtube', new JsonSubscriptionStore(root, 'youtube'), jobs, {
    autoCollection: async () => true, resolveTarget: (url) => source.resolveChannel(url), documents: () => collector.list(), now,
  });
  const status = async (id: string) => (await channels.listSubscriptions()).find((subscription) => subscription.id === id)!.checkStatus;
  return { source, jobs, channels, status };
}

describe('a check that started (#108)', () => {
  it('never shows queued again while its videos wait for the capture slot another subscription holds', async () => {
    const w = await world();
    const alpha = w.source.addChannel('alpha');
    const beta = w.source.addChannel('beta');
    const alphaVideos = w.source.publish(alpha, 'a', new Date('2026-10-15T04:00:00.000Z'), [1, 2]);
    const betaVideos = w.source.publish(beta, 'b', new Date('2026-10-15T04:00:00.000Z'), [1]);
    w.source.holdCaptures = true;
    const first = await w.jobs.whenSettled((await w.channels.add('@alpha')).job.id);
    const second = await w.jobs.whenSettled((await w.channels.add('@beta')).job.id);
    const betaCheck = second.result!.followUpJobId!;
    await vi.waitFor(() => expect(w.jobs.get(betaCheck).items).toHaveLength(1));
    expect(w.source.running()).toEqual([alphaVideos[0]]);

    expect((await w.status(beta)).state).not.toBe('queued');
    const overview = await w.jobs.overview();
    expect(overview.running.map((entry) => entry.jobId)).toContain(betaCheck);
    expect(overview.queued.map((entry) => entry.jobId)).not.toContain(betaCheck);

    w.source.release(alphaVideos[0]!);
    await vi.waitFor(() => expect(w.source.running()).toEqual([alphaVideos[1]]));
    expect((await w.status(beta)).state).not.toBe('queued');
    w.source.release(alphaVideos[1]!);
    await vi.waitFor(() => expect(w.source.running()).toEqual([betaVideos[0]]));
    w.source.release(betaVideos[0]!);
    await w.jobs.whenSettled(first.result!.followUpJobId!);
    await w.jobs.whenSettled(betaCheck);
  });
});
