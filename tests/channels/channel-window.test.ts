import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelCollector } from '../../src/channels/channel-collector.js';
import { JsonChannelStore } from '../../src/channels/json-channel-store.js';
import { Collector } from '../../src/core/collector.js';
import type { CollectionJob } from '../../src/core/types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { SyntheticYouTube } from './synthetic-youtube.js';

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;
const originalZone = process.env.TZ;
const roots: string[] = [];

beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
afterEach(async () => {
  process.env.TZ = originalZone;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

/** A Markdown Vault with deletion records, its subscription services and synthetic channels on a controllable clock. */
async function world() {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-channel-window-'));
  roots.push(root);
  const clock = { now: new Date('2026-10-15T04:00:00.000Z') };
  const now = () => clock.now;
  const source = new SyntheticYouTube();
  const vault = new MarkdownVault(root, { now });
  const collector = new Collector(vault, { index: async () => {}, remove: async () => {} });
  const channelStore = new JsonChannelStore(root);
  const jobs = new JobManager({
    vaultPath: root, store: JobStore.memory(now), source, documents: collector, channels: channelStore, now,
    limits: { discovery: 1, capture: 4 }, retry: { maxAttempts: 1 },
  });
  const channels = new ChannelCollector(channelStore, jobs, {
    autoCollection: async () => true, resolveChannel: (url) => source.resolveChannel(url), documents: () => collector.list(), now,
  });
  return {
    clock, source, collector, jobs, channels,
    advance(ms: number) { clock.now = new Date(clock.now.getTime() + ms); },
    async collected(): Promise<string[]> { return (await collector.list()).map((document) => document.sourceId).sort(); },
    async check(trigger: 'scheduled' | 'manual'): Promise<CollectionJob> {
      const [submission] = await channels.startRun({ trigger });
      return jobs.whenSettled(submission!.job.id);
    },
    async resume(id: string): Promise<CollectionJob> {
      await channels.setChannelEnabled(id, false);
      return jobs.whenSettled((await channels.setChannelEnabled(id, true)).submission!.job.id);
    },
  };
}

const itemIds = (job: CollectionJob) => job.items!.map((item) => item.sourceId);

describe('the range every check collects (R-01–R-04)', () => {
  it('never reaches past the newest videos of the range, whatever was collected or deleted', async () => {
    const w = await world();
    const id = w.source.addChannel('window', '【合成】範圍頻道');
    // A1…A25, newest first, all within the 1-month range.
    const a = w.source.publish(id, 'a', w.clock.now, Array.from({ length: 25 }, (_, index) => 1 + index));

    // R-01: the first check collects A1–A10; eight are deleted; a resume collects nothing.
    const added = await w.jobs.whenSettled((await w.channels.addChannel('@window')).job.id);
    const first = await w.jobs.whenSettled(added.result!.followUpJobId!);
    expect(itemIds(first)).toEqual(a.slice(0, 10));
    for (const video of a.slice(2, 10)) await w.collector.delete(`youtube:${video}`);
    expect(await w.collected()).toEqual(a.slice(0, 2).sort());

    w.advance(HOUR);
    const resumed = await w.resume(id);
    expect(resumed).toMatchObject({ state: 'completed', result: { outcome: 'empty' }, items: [] });
    expect(await w.collected()).toEqual(a.slice(0, 2).sort());
    expect(w.source.captures.some((video) => a.slice(10).includes(video))).toBe(false);

    // R-02: three new videos; only they are collected.
    w.advance(HOUR);
    const b = w.source.publish(id, 'b', w.clock.now, [0.01, 0.02, 0.03]);
    expect(itemIds(await w.check('manual'))).toEqual(b);

    // R-03: fifteen new videos; the newest ten are collected and the older five never are.
    w.advance(HOUR);
    const c = w.source.publish(id, 'c', w.clock.now, Array.from({ length: 15 }, (_, index) => (index + 1) / 1000));
    expect(itemIds(await w.check('scheduled'))).toEqual(c.slice(0, 10));
    w.advance(HOUR);
    expect(await w.check('scheduled')).toMatchObject({ result: { outcome: 'empty' }, items: [] });
    expect((await w.collected()).filter((video) => c.slice(10).includes(video))).toEqual([]);

    // R-04: two months later the range has moved past A, B and C; a resume takes the newest within it.
    await w.channels.setChannelEnabled(id, false);
    w.advance(60 * DAY);
    const d = w.source.publish(id, 'd', w.clock.now, [1, 2, 3]);
    const later = await w.jobs.whenSettled((await w.channels.setChannelEnabled(id, true)).submission!.job.id);
    expect(itemIds(later)).toEqual(d);
    expect(w.jobs.get(later.items![0]!.jobId!).publishedNotBefore).toBe('2026-11-14T08:00:00.000Z');
    expect((await w.collected()).filter((video) => a.slice(10).includes(video) || c.slice(10).includes(video))).toEqual([]);
  });
});
