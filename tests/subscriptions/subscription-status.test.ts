import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PacingEvent, Pacing } from '../../src/pacing/pacing-gate.js';
import { SubscriptionService, SubscriptionServices, checkStatus } from '../../src/subscriptions/subscription-service.js';
import { forwardingPort } from '../../src/jobs/subscription-port.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import { Collector } from '../../src/core/collector.js';
import { CollectorError, type CollectionJob, type PacingStatus } from '../../src/core/types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { MemoryDocuments, SyntheticYouTube } from './synthetic-youtube.js';
import { youtubePlugin } from '../../src/plugins/youtube/server.js';

const MINUTE = 60_000;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** A YouTube request channel the test puts into a cooldown and out of it. */
class ScriptedPacing implements Pacing {
  readonly group = 'youtube';
  private listener: ((event: PacingEvent) => void) | null = null;
  private until: string | null = null;
  status(): PacingStatus {
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
  const channelStore = new JsonSubscriptionStore(root, 'youtube');
  const pacing = new ScriptedPacing();
  let autoCheck = true;
  const jobs: JobManager = new JobManager({
    vaultPath: root, store: JobStore.memory(now), plugins: [youtubePlugin(source)], documents: collector,
    subscriptions: forwardingPort(() => new SubscriptionServices([channels])), now, pacing: [pacing],
    limits: { discovery: 1, capture: options.capture ?? 4 },
    retry: { maxAttempts: options.maxAttempts ?? 1, delaysMs: [5 * MINUTE] },
    setTimer: () => () => undefined,
  });
  const channels = new SubscriptionService('youtube', channelStore, jobs, {
    autoCollection: async () => autoCheck, resolveTarget: (url) => source.resolveChannel(url), documents: () => collector.list(), now,
  });
  const subscribe = async (name: string): Promise<{ id: string; first: CollectionJob }> => {
    const added = await jobs.whenSettled((await channels.add(`@${name}`)).job.id);
    return { id: added.result!.subscriptionId!, first: await jobs.whenSettled(added.result!.followUpJobId!) };
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
    await w.channels.setEnabled(beta, false);
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
    const added = await w.jobs.whenSettled((await w.channels.add('@alpha')).job.id);
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
    const first = await w.jobs.whenSettled((await w.channels.add('@alpha')).job.id);
    const second = await w.jobs.whenSettled((await w.channels.add('@beta')).job.id);
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
    await w.channels.startRun({ trigger: 'manual', subscriptionIds: [alpha] });

    expect(await w.status(alpha)).toEqual({ state: 'queued' });
  });

  it('shows queued while every video left waits for a retry, and a failed video leaves the status alone', async () => {
    const w = await world({ maxAttempts: 2 });
    const alpha = w.source.addChannel('alpha');
    const [failing, fine] = w.source.publish(alpha, 'a', w.clock.now, [1, 2]);
    w.source.failures.set(failing!, new CollectorError('network_error', '無法連線到 YouTube。'));
    const added = await w.jobs.whenSettled((await w.channels.add('@alpha')).job.id);
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
    const failed = await w.jobs.whenSettled((await w.channels.startRun({ trigger: 'manual', subscriptionIds: [alpha] }))[0]!.job.id);
    expect(failed.state).toBe('failed');
    const subscription = (await w.channels.listSubscriptions())[0]!;
    expect(subscription).toMatchObject({ status: 'error', checkStatus: { state: 'scheduled', nextCheckAt: subscription.nextCheckAt } });

    w.advance(31 * MINUTE);
    expect(await w.status(alpha)).toEqual({ state: 'queued' });
  });

  it('orders paused, sign-in, active work, the auto check switch and the schedule', () => {
    const now = new Date('2026-10-15T04:00:00.000Z');
    const later = '2026-10-15T05:00:00.000Z';
    // Work facts as the job manager reports them for a subscription's queued or running check.
    const collecting = { jobId: 'j', waiting: false, done: 3, total: 10 };
    const waiting = { ...collecting, waiting: true };
    const context = { autoCheck: true, now, loginRequired: false };
    const enabled = { enabled: true, nextCheckAt: later };

    expect(checkStatus({ enabled: false, nextCheckAt: null }, collecting, { ...context, loginRequired: true })).toEqual({ state: 'paused' });
    expect(checkStatus(enabled, collecting, { ...context, loginRequired: true })).toEqual({ state: 'login_required' });
    expect(checkStatus(enabled, collecting, { ...context, autoCheck: false })).toEqual({ state: 'updating', done: 3, total: 10 });
    expect(checkStatus(enabled, waiting, context)).toEqual({ state: 'queued' });
    expect(checkStatus(enabled, collecting, context)).toEqual({ state: 'updating', done: 3, total: 10 });
    expect(checkStatus(enabled, null, { ...context, autoCheck: false })).toEqual({ state: 'auto_check_off' });
    expect(checkStatus({ enabled: true, nextCheckAt: now.toISOString() }, null, context)).toEqual({ state: 'queued' });
    expect(checkStatus(enabled, null, context)).toEqual({ state: 'scheduled', nextCheckAt: later });
    // A subscription without a next check time yet, such as after an import, waits for the scheduler to plan one.
    expect(checkStatus({ enabled: true, nextCheckAt: null }, null, context)).toEqual({ state: 'queued' });
  });
});
