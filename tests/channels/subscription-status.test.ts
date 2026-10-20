import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PacingEvent, YouTubePacing } from '../../src/capture/youtube-gate.js';
import { ChannelCollector, checkStatus } from '../../src/channels/channel-collector.js';
import { JsonChannelStore } from '../../src/channels/json-channel-store.js';
import { Collector } from '../../src/core/collector.js';
import { CollectorError, type CollectionJob, type YouTubePacingStatus } from '../../src/core/types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { MemoryDocuments, SyntheticYouTube } from './synthetic-youtube.js';

const MINUTE = 60_000;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** A YouTube request channel the test puts into a cooldown and out of it. */
class ScriptedPacing implements YouTubePacing {
  private listener: ((event: PacingEvent) => void) | null = null;
  private until: string | null = null;
  status(): YouTubePacingStatus {
    return { state: this.until ? 'cooldown' : 'idle', cooldownUntil: this.until, level: this.until ? 1 : 0, waitRangeMs: { min: 0, max: 0 } };
  }
  subscribe(listener: (event: PacingEvent) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }
  limit(until: string): void {
    this.until = until;
    this.listener?.({ type: 'rate_limited', until, level: 1 });
  }
}

/**
 * Real subscription and job services over synthetic channels with a manual clock. Retry timers are
 * kept, never fired, so a job waiting for its next attempt stays waiting.
 */
async function world(options: { maxAttempts?: number; capture?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-subscription-status-'));
  roots.push(root);
  const clock = { now: new Date('2026-10-15T04:00:00.000Z') };
  const now = () => clock.now;
  const source = new SyntheticYouTube();
  const documents = new MemoryDocuments(now);
  const collector = new Collector(documents);
  const channelStore = new JsonChannelStore(root);
  const pacing = new ScriptedPacing();
  let autoCheck = true;
  const jobs = new JobManager({
    vaultPath: root, store: JobStore.memory(now), source, documents: collector, channels: channelStore, now, pacing,
    limits: { discovery: 1, capture: options.capture ?? 4 },
    retry: { maxAttempts: options.maxAttempts ?? 1, delaysMs: [5 * MINUTE] },
    setTimer: () => () => undefined,
  });
  const channels = new ChannelCollector(channelStore, jobs, {
    autoCollection: async () => autoCheck, resolveChannel: (url) => source.resolveChannel(url), documents: () => collector.list(), now,
  });
  const subscribe = async (name: string): Promise<{ id: string; first: CollectionJob }> => {
    const added = await jobs.whenSettled((await channels.addChannel(`@${name}`)).job.id);
    return { id: added.result!.channelId!, first: await jobs.whenSettled(added.result!.followUpJobId!) };
  };
  const status = async (id: string) => (await channels.listSubscriptions()).find((subscription) => subscription.id === id)!.checkStatus;
  return {
    clock, source, jobs, channels, channelStore, pacing, subscribe, status,
    setAutoCheck(value: boolean) { autoCheck = value; },
    advance(ms: number) { clock.now = new Date(clock.now.getTime() + ms); },
  };
}

describe('subscription check status computed by the service (N75-T5)', () => {
  it('shows the next check after a check, paused while paused, and auto check off only for enabled ones', async () => {
    const w = await world();
    const alpha = w.source.addChannel('alpha');
    const beta = w.source.addChannel('beta');
    w.source.publish(alpha, 'a', w.clock.now, [1]);
    await w.subscribe('alpha');
    await w.subscribe('beta');
    const next = (await w.channelStore.list()).find((channel) => channel.id === alpha)!.nextCheckAt;

    expect(await w.status(alpha)).toEqual({ state: 'scheduled', nextCheckAt: next });
    await w.channels.setChannelEnabled(beta, false);
    expect(await w.status(beta)).toEqual({ state: 'paused' });

    w.setAutoCheck(false);
    expect(await w.status(alpha)).toEqual({ state: 'auto_check_off' });
    expect(await w.status(beta)).toEqual({ state: 'paused' });
  });

  it('shows updating with item progress while a check collects', async () => {
    const w = await world();
    const alpha = w.source.addChannel('alpha');
    const videos = w.source.publish(alpha, 'a', w.clock.now, [1, 2, 3]);
    w.source.holdCaptures = true;
    const added = await w.jobs.whenSettled((await w.channels.addChannel('@alpha')).job.id);
    await vi.waitFor(() => expect(w.source.running()).toHaveLength(3));
    expect(await w.status(alpha)).toEqual({ state: 'updating', done: 0, total: 3 });

    w.source.release(videos[0]!);
    await vi.waitFor(async () => expect(await w.status(alpha)).toEqual({ state: 'updating', done: 1, total: 3 }));
    w.source.release(videos[1]!);
    w.source.release(videos[2]!);
    await w.jobs.whenSettled(added.result!.followUpJobId!);
    expect((await w.status(alpha)).state).toBe('scheduled');
  });

  it('shows queued for a check behind another subscription and updating once its discovery starts', async () => {
    const w = await world();
    const alpha = w.source.addChannel('alpha');
    const beta = w.source.addChannel('beta');
    await w.subscribe('alpha');
    await w.subscribe('beta');
    let release!: () => void;
    w.source.holdDiscovery = new Promise<void>((resolve) => { release = resolve; });
    const submissions = await w.channels.startRun({ trigger: 'manual' });
    await vi.waitFor(() => expect(w.source.listingRequests.at(-1)?.channelId).toBe(alpha));

    expect(await w.status(alpha)).toEqual({ state: 'updating', done: 0, total: 0 });
    expect(await w.status(beta)).toEqual({ state: 'queued' });
    release();
    w.source.holdDiscovery = null;
    await Promise.all(submissions.map(({ job }) => w.jobs.whenSettled(job.id)));
  });

  it('shows queued while its videos wait behind the videos of another subscription', async () => {
    const w = await world({ capture: 1 });
    const alpha = w.source.addChannel('alpha');
    const beta = w.source.addChannel('beta');
    const alphaVideos = w.source.publish(alpha, 'a', w.clock.now, [1, 2]);
    const betaVideos = w.source.publish(beta, 'b', w.clock.now, [1]);
    w.source.holdCaptures = true;
    const first = await w.jobs.whenSettled((await w.channels.addChannel('@alpha')).job.id);
    const second = await w.jobs.whenSettled((await w.channels.addChannel('@beta')).job.id);
    await vi.waitFor(async () => expect((await w.jobs.get(second.result!.followUpJobId!))?.items).toHaveLength(1));
    expect(w.source.running()).toEqual([alphaVideos[0]]);

    expect(await w.status(alpha)).toEqual({ state: 'updating', done: 0, total: 2 });
    expect(await w.status(beta)).toEqual({ state: 'queued' });

    w.source.release(alphaVideos[0]!);
    await vi.waitFor(() => expect(w.source.running()).toEqual([alphaVideos[1]]));
    w.source.release(alphaVideos[1]!);
    await vi.waitFor(() => expect(w.source.running()).toEqual([betaVideos[0]]));
    expect(await w.status(beta)).toEqual({ state: 'updating', done: 0, total: 1 });
    w.source.release(betaVideos[0]!);
    await w.jobs.whenSettled(first.result!.followUpJobId!);
    await w.jobs.whenSettled(second.result!.followUpJobId!);
  });

  it('shows queued while a YouTube cooldown holds the check', async () => {
    const w = await world();
    const alpha = w.source.addChannel('alpha');
    await w.subscribe('alpha');
    w.pacing.limit(new Date(w.clock.now.getTime() + 10 * MINUTE).toISOString());
    await w.channels.startRun({ trigger: 'manual', channelIds: [alpha] });

    expect(await w.status(alpha)).toEqual({ state: 'queued' });
  });

  it('shows queued while every video left waits for a retry, and a failed video leaves the status alone', async () => {
    const w = await world({ maxAttempts: 2 });
    const alpha = w.source.addChannel('alpha');
    const [failing, fine] = w.source.publish(alpha, 'a', w.clock.now, [1, 2]);
    w.source.failures.set(failing!, new CollectorError('network_error', '無法連線到 YouTube。'));
    const added = await w.jobs.whenSettled((await w.channels.addChannel('@alpha')).job.id);
    const check = added.result!.followUpJobId!;
    await vi.waitFor(() => expect(w.jobs.get(check).items?.find((item) => item.sourceId === fine)?.state).toBe('completed'));
    await vi.waitFor(() => expect(w.jobs.get(check).items?.find((item) => item.sourceId === failing)?.retry?.nextAttemptAt).toBeTruthy());

    expect(await w.status(alpha)).toEqual({ state: 'queued' });
  });

  it('keeps showing the next check after a video failed for good', async () => {
    const w = await world();
    const alpha = w.source.addChannel('alpha');
    const [failing] = w.source.publish(alpha, 'a', w.clock.now, [1, 2]);
    w.source.failures.set(failing!, new CollectorError('video_unavailable', '影片不存在。'));
    const { first } = await w.subscribe('alpha');

    expect(first.progress).toMatchObject({ failed: 1 });
    expect((await w.status(alpha)).state).toBe('scheduled');
  });

  it('shows queued when a check came due and was not dispatched, and the next check after a failed check', async () => {
    const w = await world();
    const alpha = w.source.addChannel('alpha');
    await w.subscribe('alpha');
    w.source.discoveryFailure = new CollectorError('network_error', '無法連線到 YouTube。');
    const failed = await w.jobs.whenSettled((await w.channels.startRun({ trigger: 'manual', channelIds: [alpha] }))[0]!.job.id);
    expect(failed.state).toBe('failed');
    const subscription = (await w.channels.listSubscriptions())[0]!;
    expect(subscription).toMatchObject({ status: 'error', checkStatus: { state: 'scheduled', nextCheckAt: subscription.nextCheckAt } });

    w.advance(31 * MINUTE);
    expect(await w.status(alpha)).toEqual({ state: 'queued' });
  });

  it('orders paused, sign-in, active work, the auto check switch and the schedule', () => {
    const now = new Date('2026-10-15T04:00:00.000Z');
    const later = '2026-10-15T05:00:00.000Z';
    const job = (overrides: Partial<CollectionJob>): CollectionJob => ({
      id: 'j', kind: 'youtube.channel', state: 'running', phase: 'capture', vaultPath: '/v', parentId: null,
      source: { type: 'youtube', id: 'UC1', url: 'https://www.youtube.com/channel/UC1', title: 'A' },
      createdAt: now.toISOString(), startedAt: now.toISOString(), finishedAt: null, updatedAt: now.toISOString(),
      progress: { total: 10, done: 3, created: 3, existing: 0, failed: 0 }, items: null, result: null, error: null, ...overrides,
    });
    const item = (state: 'queued' | 'running' | 'completed', extra = {}) => ({ sourceId: 'v', title: 'v', url: 'u', jobId: 'x', state, outcome: null, error: null, ...extra });
    const context = { autoCheck: true, now, loginRequired: false };
    const enabled = { enabled: true, nextCheckAt: later };

    expect(checkStatus({ enabled: false, nextCheckAt: null }, job({}), { ...context, loginRequired: true })).toEqual({ state: 'paused' });
    expect(checkStatus(enabled, job({}), { ...context, loginRequired: true })).toEqual({ state: 'login_required' });
    expect(checkStatus(enabled, job({}), { ...context, autoCheck: false })).toEqual({ state: 'updating', done: 3, total: 10 });
    expect(checkStatus(enabled, job({ state: 'queued' }), context)).toEqual({ state: 'queued' });
    expect(checkStatus(enabled, job({ state: 'queued', wait: { reason: 'rate_limited', until: later } }), context)).toEqual({ state: 'queued' });
    const cooldown = { wait: { reason: 'rate_limited' as const, until: later } };
    expect(checkStatus(enabled, job({ items: [item('completed'), item('queued', cooldown), item('queued', cooldown)] }), context)).toEqual({ state: 'queued' });
    expect(checkStatus(enabled, job({ items: [item('queued', cooldown), item('running')] }), context)).toEqual({ state: 'updating', done: 3, total: 10 });
    expect(checkStatus(enabled, null, { ...context, autoCheck: false })).toEqual({ state: 'auto_check_off' });
    expect(checkStatus({ enabled: true, nextCheckAt: now.toISOString() }, null, context)).toEqual({ state: 'queued' });
    expect(checkStatus(enabled, null, context)).toEqual({ state: 'scheduled', nextCheckAt: later });
    // A subscription without a next check time yet, such as after an import, waits for the scheduler to plan one.
    expect(checkStatus({ enabled: true, nextCheckAt: null }, null, context)).toEqual({ state: 'queued' });
  });
});
