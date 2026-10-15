import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelCollector } from '../../src/channels/channel-collector.js';
import { DEFAULT_POLICY } from '../../src/channels/collection-policy.js';
import { JsonChannelStore } from '../../src/channels/json-channel-store.js';
import { Collector } from '../../src/core/collector.js';
import { CollectorError, type CollectionJob, type CollectionPolicy } from '../../src/core/types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { MemoryDocuments, SyntheticYouTube, syntheticChannelId } from './synthetic-youtube.js';
import { readEventFiles } from '../activity/event-files.js';

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;
const originalZone = process.env.TZ;
const roots: string[] = [];

beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
afterEach(async () => {
  process.env.TZ = originalZone;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

/**
 * One Vault's subscription services over synthetic YouTube channels, a controllable clock and a
 * real channel settings file. `restart()` builds new services on the same Vault and device record.
 */
async function world(options: { capture?: number; discovery?: number; maxQueued?: number; jobsDirectory?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-subscriptions-'));
  roots.push(root);
  const clock = { now: new Date('2026-10-15T04:00:00.000Z') };
  const now = () => clock.now;
  /** The settings `subscribe` gives new subscriptions. */
  const policy: CollectionPolicy = { ...DEFAULT_POLICY };
  const source = new SyntheticYouTube();
  const documents = new MemoryDocuments(now);
  const store = options.jobsDirectory ? await JobStore.open(options.jobsDirectory, now) : JobStore.memory(now);
  const build = () => {
    const channelStore = new JsonChannelStore(root);
    const collector = new Collector(documents);
    const jobs = new JobManager({
      vaultPath: root, store, source, documents: collector, channels: channelStore, now,
      limits: { discovery: options.discovery ?? 1, capture: options.capture ?? 4, ...(options.maxQueued ? { maxQueued: options.maxQueued } : {}) },
      // Failed checks here drive the catch-up rules; automatic retries have their own cases.
      retry: { maxAttempts: 1 },
    });
    const channels = new ChannelCollector(channelStore, jobs, {
      autoCollection: async () => true, resolveChannel: (url) => source.resolveChannel(url), documents: () => collector.list(), now,
    });
    return { channelStore, jobs, channels };
  };
  let services = build();
  return {
    root, clock, policy, source, documents, store,
    get jobs() { return services.jobs; },
    get channels() { return services.channels; },
    get channelStore() { return services.channelStore; },
    async restart() {
      await services.jobs.close();
      services = build();
    },
    advance(ms: number) { clock.now = new Date(clock.now.getTime() + ms); },
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Subscribes through the channel-add job and returns the settled first collection. */
async function subscribe(w: World, name: string): Promise<CollectionJob> {
  const added = await w.jobs.whenSettled((await w.channels.addChannel(`@${name}`, { ...w.policy })).job.id);
  expect(added.result).toMatchObject({ outcome: 'created' });
  return w.jobs.whenSettled(added.result!.followUpJobId!);
}

async function settleAll(w: World, submissions: { job: CollectionJob }[]): Promise<CollectionJob[]> {
  return Promise.all(submissions.map(({ job }) => w.jobs.whenSettled(job.id)));
}

function collectedIds(w: World): string[] {
  return [...w.documents.documents.keys()].sort();
}

describe('first subscription backfill (S-T3)', () => {
  it('collects the newest uncollected videos published within the Global range, at most the Global count', async () => {
    const w = await world();
    const id = w.source.addChannel('first');
    // Ages 1, 4, 7 … 88 days; a 1-month range from 15 October reaches back to 15 September (30 days).
    const ids = w.source.publish(id, 'f', w.clock.now, Array.from({ length: 30 }, (_, index) => 1 + 3 * index));
    w.source.channels.get(id)!.videos.unshift({ id: 'premiere000', publishedAt: '2026-10-20T00:00:00.000Z', upcoming: true });
    // Two in-range videos were already collected as single videos.
    for (const existing of [ids[1]!, ids[3]!]) await w.documents.add((await w.source.capture({ videoId: existing, canonicalUrl: `https://www.youtube.com/watch?v=${existing}` })));
    w.source.captures.length = 0;

    const first = await subscribe(w, 'first');
    expect(first.scope).toMatchObject({ trigger: 'subscribe', mode: 'backfill', maxItems: 10, windowStart: '2026-09-15T04:00:00.000Z' });
    expect(first.items!.map((item) => item.sourceId)).toEqual([ids[0], ids[2], ...ids.slice(4, 10)]);
    expect(first).toMatchObject({ state: 'completed', result: { outcome: 'created' }, progress: { total: 8, created: 8 } });
    expect(w.source.captures).not.toContain('premiere000');
  });

  it.each([
    ['1w', 50, 3],
    ['1m', 5, 5],
    ['3m', 50, 30],
  ] as const)('applies range %s with at most %i videos', async (window, maxItems, expected) => {
    const w = await world();
    Object.assign(w.policy, { backfillWindow: window, backfillMaxItems: maxItems });
    const id = w.source.addChannel('ranges');
    const ids = w.source.publish(id, 'r', w.clock.now, Array.from({ length: 30 }, (_, index) => 1 + 3 * index));
    const first = await subscribe(w, 'ranges');
    expect(first.items!.map((item) => item.sourceId)).toEqual(ids.slice(0, expected));
  });

  it('skips before downloading subtitles a video whose listing age is in range but whose exact date is not', async () => {
    const w = await world();
    const id = w.source.addChannel('approx');
    const [inside, borderline] = w.source.publish(id, 'x', w.clock.now, [2, 45]);
    // "1 month ago" in the listing, 45 days by the video's own metadata.
    w.source.channels.get(id)!.videos[1]!.listedAt = new Date(w.clock.now.getTime() - 25 * DAY).toISOString();

    const first = await subscribe(w, 'approx');
    expect(first.items).toEqual([
      expect.objectContaining({ sourceId: inside, outcome: 'created' }),
      expect.objectContaining({ sourceId: borderline, state: 'completed', outcome: 'skipped', skipReason: 'out_of_range' }),
    ]);
    expect(first.progress).toMatchObject({ created: 1, skipped: 1, failed: 0 });
    expect(collectedIds(w)).toEqual([inside]);
  });

  it('leaves an existing subscription as it is and starts no collection', async () => {
    const w = await world();
    const id = w.source.addChannel('again');
    w.source.publish(id, 'g', w.clock.now, [1]);
    await subscribe(w, 'again');
    await w.channels.setChannelEnabled(id, false);
    const repeated = await w.jobs.whenSettled((await w.channels.addChannel('@again')).job.id);
    expect(repeated.result).toEqual({ outcome: 'existing', channelId: id });
    expect((await w.channelStore.list())[0]).toMatchObject({ enabled: false });
  });
});

describe('incremental checks (S-T4, S-T5)', () => {
  it('collects every new video after the cursor without the backfill limits, in batches that follow each other', async () => {
    const w = await world();
    Object.assign(w.policy, { backfillWindow: '1w', backfillMaxItems: 5 });
    const id = w.source.addChannel('busy');
    w.source.publish(id, 'o', w.clock.now, [1, 2]);
    await subscribe(w, 'busy');

    w.advance(30 * 60_000);
    const twelve = w.source.publish(id, 'n', w.clock.now, Array.from({ length: 12 }, (_, index) => index / 1000));
    const [check] = await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
    expect(check!.scope).toMatchObject({ mode: 'incremental' });
    expect(check!.items!.map((item) => item.sourceId).sort()).toEqual([...twelve].sort());

    w.advance(30 * 60_000);
    const many = w.source.publish(id, 'm', w.clock.now, Array.from({ length: 120 }, (_, index) => index / 10_000), 100);
    const [batch] = await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
    expect(batch).toMatchObject({ result: { backlog: true }, progress: { total: 50 } });
    // Follow-up batches start by themselves until the backlog is gone.
    await vi.waitFor(() => expect(many.every((video) => w.documents.documents.has(video))).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(w.jobs.isBusy()).toBe(false));
    const batches = w.jobs.list({ limit: 50 }).jobs.filter((job) => job.kind === 'youtube.channel' && job.scope?.mode === 'incremental');
    const followUps = batches.filter((job) => job.scope?.trigger === 'backlog');
    // The clock stands still, so the order among same-time jobs is not asserted.
    expect(followUps.map((job) => job.progress?.total).sort()).toEqual([20, 50]);
    // Every video was captured exactly once.
    expect(new Set(w.source.captures).size).toBe(w.source.captures.length);
    expect((await w.channelStore.list())[0]).toMatchObject({ backlog: false, cursor: { videoId: many[0] } });
  });

  it('reuses the active job when a check overlaps it, then finds what was published meanwhile', async () => {
    const w = await world({ capture: 1 });
    const id = w.source.addChannel('overlap');
    w.source.publish(id, 'a', w.clock.now, [1]);
    await subscribe(w, 'overlap');

    w.advance(30 * 60_000);
    w.source.holdCaptures = true;
    const firstNew = w.source.publish(id, 'b', w.clock.now, [0.01]);
    const [running] = await w.channels.startRun({ trigger: 'scheduled' });
    await vi.waitFor(() => expect(w.source.running()).toEqual(firstNew));
    const cursorBefore = (await w.channelStore.list())[0]!.cursor;

    w.advance(30 * 60_000);
    const meanwhile = w.source.publish(id, 'c', w.clock.now, [0.001], 10);
    const [manual] = await w.channels.startRun({ trigger: 'manual' });
    expect(manual).toMatchObject({ deduplicated: true, job: { id: running!.job.id } });
    expect((await w.channelStore.list())[0]!.cursor).toEqual(cursorBefore);

    w.source.holdCaptures = false;
    w.source.release(firstNew[0]!);
    await w.jobs.whenSettled(running!.job.id);
    w.advance(30 * 60_000);
    const [next] = await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
    expect(next!.items!.map((item) => item.sourceId)).toEqual(meanwhile);
  });
});

describe('full queue', () => {
  it('keeps the cursor when some found videos could not be queued, so the next check finds them again', async () => {
    const w = await world({ capture: 1, maxQueued: 3 });
    const id = w.source.addChannel('crowded');
    const ids = w.source.publish(id, 'q', w.clock.now, [1, 2, 3, 4, 5]);
    w.source.holdCaptures = true;
    const first = w.jobs.whenSettled((await w.jobs.whenSettled((await w.channels.addChannel('@crowded')).job.id)).result!.followUpJobId!);
    await vi.waitFor(() => expect(w.source.running()).toEqual([ids[0]]));
    w.source.holdCaptures = false;
    for (const video of w.source.running()) w.source.release(video);
    const settled = await first;
    expect(settled.items!.filter((item) => item.error?.code === 'queue_full')).toHaveLength(2);
    expect((await w.channelStore.list())[0]!.cursor).toBeNull();

    w.advance(30 * 60_000);
    await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
    await vi.waitFor(() => expect(w.jobs.isBusy()).toBe(false));
    expect(collectedIds(w)).toEqual([...ids].sort());
    expect((await w.channelStore.list())[0]!.cursor).toMatchObject({ videoId: ids[0] });
  });
});

describe('catch-up decisions (S-T6)', () => {
  async function trackedWorld(intervalMinutes = 30) {
    const w = await world();
    w.policy.intervalMinutes = intervalMinutes;
    const id = w.source.addChannel('gap');
    w.source.publish(id, 'g', w.clock.now, [1]);
    await subscribe(w, 'gap');
    return { w, id };
  }

  async function nextMode(w: World): Promise<string | undefined> {
    const [job] = await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
    return job!.scope?.mode;
  }

  it('checks incrementally after a short gap and with backfill limits after a long one', async () => {
    const { w } = await trackedWorld();
    w.advance(2 * HOUR);
    expect(await nextMode(w)).toBe('incremental');
    w.advance(30 * HOUR);
    expect(await nextMode(w)).toBe('backfill');
    w.advance(30 * 60_000);
    expect(await nextMode(w)).toBe('incremental');
  });

  it('uses three intervals as the threshold for a daily check', async () => {
    const { w } = await trackedWorld(1440);
    w.advance(30 * HOUR);
    expect(await nextMode(w)).toBe('incremental');
    w.advance(73 * HOUR);
    expect(await nextMode(w)).toBe('backfill');
  });

  it('uses backfill limits for the first check after the service restarts', async () => {
    const { w, id } = await trackedWorld();
    w.advance(60_000);
    await w.restart();
    w.advance(30 * 60_000);
    const backfillNew = w.source.publish(id, 'r', w.clock.now, Array.from({ length: 15 }, (_, index) => index / 1000), 10);
    const [job] = await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
    expect(job).toMatchObject({ scope: { mode: 'backfill', maxItems: 10 }, progress: { total: 10 } });
    expect(job!.items!.map((item) => item.sourceId)).toEqual(backfillNew.slice(0, 10));
    w.advance(30 * 60_000);
    expect(await nextMode(w)).toBe('incremental');
  });

  it('treats checks that keep failing for over a day like a long gap', async () => {
    const { w } = await trackedWorld();
    w.source.discoveryFailure = new CollectorError('network_error', '網路連線失敗。');
    for (let hour = 0; hour < 26; hour += 1) {
      w.advance(HOUR);
      const [failed] = await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
      expect(failed!.state).toBe('failed');
    }
    w.source.discoveryFailure = null;
    w.advance(HOUR);
    expect(await nextMode(w)).toBe('backfill');
  });
});

describe('accepted scope (S-T7, A3)', () => {
  it('keeps the range a job accepted when the subscription settings change before it runs', async () => {
    const w = await world();
    const id = w.source.addChannel('snapshot');
    const ids = w.source.publish(id, 's', w.clock.now, Array.from({ length: 20 }, (_, index) => 1 + index));
    let release!: () => void;
    w.source.holdDiscovery = new Promise((resolve) => { release = resolve; });

    const added = await w.channels.addChannel('@snapshot', { backfillMaxItems: 10 });
    const followUpId = (await w.jobs.whenSettled(added.job.id)).result!.followUpJobId!;
    await w.channels.updateSettings(id, { backfillWindow: '1w', backfillMaxItems: 5 });
    w.source.holdDiscovery = null;
    release();
    const first = await w.jobs.whenSettled(followUpId);
    expect(first.scope).toMatchObject({ maxItems: 10, windowStart: '2026-09-15T04:00:00.000Z' });
    expect(first.items!.map((item) => item.sourceId)).toEqual(ids.slice(0, 10));

    // The next backfill uses the changed settings.
    await w.channels.setChannelEnabled(id, false);
    const resumed = await w.channels.setChannelEnabled(id, true);
    expect((await w.jobs.whenSettled(resumed.submission!.job.id)).scope).toMatchObject({
      trigger: 'resume', maxItems: 5, windowStart: '2026-10-08T04:00:00.000Z',
    });
  });

  it('starts a subscription with the settings chosen when its channel-add job was accepted', async () => {
    const w = await world();
    const id = w.source.addChannel('chosen');
    w.source.publish(id, 'c', w.clock.now, Array.from({ length: 8 }, (_, index) => 1 + 3 * index));
    const added = await w.jobs.whenSettled((await w.channels.addChannel('@chosen', { intervalMinutes: 60, backfillWindow: '2w', backfillMaxItems: 5 })).job.id);
    const first = await w.jobs.whenSettled(added.result!.followUpJobId!);
    expect(first.scope).toMatchObject({ trigger: 'subscribe', maxItems: 5, windowStart: '2026-10-01T04:00:00.000Z' });
    expect(first.progress).toMatchObject({ total: 5 });
    expect((await w.channelStore.list())[0]).toMatchObject({
      settings: { intervalMinutes: 60, backfillWindow: '2w', backfillMaxItems: 5 },
      lastDispatchedAt: '2026-10-15T04:00:00.000Z', nextCheckAt: '2026-10-15T05:00:00.000Z',
    });
    await expect(w.channels.addChannel('@chosen', { intervalMinutes: 7 })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('pause, resume and remove (S-T8, S-T9)', () => {
  it('skips a queued channel job when its subscription is paused', async () => {
    const w = await world();
    const blocker = w.source.addChannel('blocker');
    const target = w.source.addChannel('target');
    w.source.publish(blocker, 'k', w.clock.now, [1]);
    w.source.publish(target, 't', w.clock.now, [1]);
    await subscribe(w, 'blocker');
    await subscribe(w, 'target');
    w.advance(HOUR);
    let release!: () => void;
    w.source.holdDiscovery = new Promise((resolve) => { release = resolve; });
    const [first, second] = await w.channels.startRun({ trigger: 'scheduled' });
    expect(second!.job.state).toBe('queued');

    await w.channels.setChannelEnabled(target, false);
    expect(await w.jobs.whenSettled(second!.job.id)).toMatchObject({
      state: 'completed', result: { outcome: 'skipped', skipReason: 'subscription_paused' },
    });
    w.source.holdDiscovery = null;
    release();
    await w.jobs.whenSettled(first!.job.id);
  });

  it('skips videos that have not started, lets a running capture finish, and discards a discovery that sees the pause', async () => {
    const w = await world({ capture: 1 });
    const id = w.source.addChannel('pausing');
    const ids = w.source.publish(id, 'p', w.clock.now, [1, 2, 3]);
    w.source.holdCaptures = true;
    const added = await w.jobs.whenSettled((await w.channels.addChannel('@pausing')).job.id);
    const jobId = added.result!.followUpJobId!;
    await vi.waitFor(() => expect(w.source.running()).toEqual([ids[0]]));

    await w.channels.setChannelEnabled(id, false);
    w.source.release(ids[0]!);
    const paused = await w.jobs.whenSettled(jobId);
    expect(paused.items!.map((item) => [item.sourceId, item.outcome, item.skipReason])).toEqual([
      [ids[0], 'created', undefined],
      [ids[1], 'skipped', 'subscription_paused'],
      [ids[2], 'skipped', 'subscription_paused'],
    ]);
    expect(collectedIds(w)).toEqual([ids[0]]);

    // Resuming forgets the cursor and backfills with the subscription's settings.
    w.source.holdCaptures = false;
    await w.channels.updateSettings(id, { backfillWindow: '1w', backfillMaxItems: 5 });
    const resumed = await w.channels.setChannelEnabled(id, true);
    expect(resumed.channel).toMatchObject({ enabled: true, cursor: null, settings: { backfillWindow: '1w', backfillMaxItems: 5 } });
    const backfill = await w.jobs.whenSettled(resumed.submission!.job.id);
    expect(backfill).toMatchObject({ scope: { trigger: 'resume', mode: 'backfill', maxItems: 5 } });
    expect(backfill.items!.map((item) => item.sourceId)).toEqual([ids[1], ids[2]]);

    // A pause that lands while the listing is read discards what the listing found.
    let release!: () => void;
    w.source.holdDiscovery = new Promise((resolve) => { release = resolve; });
    w.advance(HOUR);
    const [during] = await w.channels.startRun({ trigger: 'manual' });
    await vi.waitFor(() => expect(w.jobs.get(during!.job.id).phase).toBe('discover'));
    await w.channels.setChannelEnabled(id, false);
    w.source.holdDiscovery = null;
    release();
    expect(await w.jobs.whenSettled(during!.job.id)).toMatchObject({ result: { outcome: 'skipped', skipReason: 'subscription_paused' }, items: null });
  });

  it('starts its own backfill when resumed while a video of the paused job is still capturing', async () => {
    const w = await world({ capture: 1 });
    const id = w.source.addChannel('quick');
    const ids = w.source.publish(id, 'u', w.clock.now, [1, 2, 3, 4]);
    w.source.holdCaptures = true;
    const added = await w.jobs.whenSettled((await w.channels.addChannel('@quick')).job.id);
    const oldJobId = added.result!.followUpJobId!;
    await vi.waitFor(() => expect(w.source.running()).toEqual([ids[0]]));

    await w.channels.setChannelEnabled(id, false);
    const resumed = await w.channels.setChannelEnabled(id, true);
    expect(resumed.submission).toMatchObject({ deduplicated: false, job: { scope: { trigger: 'resume' } } });
    expect(resumed.submission!.job.id).not.toBe(oldJobId);
    expect((await w.channels.listSubscriptions())[0]!.activeJob?.id).toBe(resumed.submission!.job.id);

    w.source.holdCaptures = false;
    w.source.release(ids[0]!);
    expect((await w.jobs.whenSettled(oldJobId)).items!.map((item) => item.outcome)).toEqual(['created', 'skipped', 'skipped', 'skipped']);
    await w.jobs.whenSettled(resumed.submission!.job.id);
    await vi.waitFor(() => expect(w.jobs.isBusy()).toBe(false));
    expect(collectedIds(w)).toEqual([...ids].sort());
  });

  it('runs the first backfill when a channel is subscribed again right after removal', async () => {
    const w = await world({ capture: 1 });
    const id = w.source.addChannel('again2');
    const ids = w.source.publish(id, 'y', w.clock.now, [1, 2, 3]);
    w.source.holdCaptures = true;
    const added = await w.jobs.whenSettled((await w.channels.addChannel('@again2')).job.id);
    const oldJobId = added.result!.followUpJobId!;
    await vi.waitFor(() => expect(w.source.running()).toEqual([ids[0]]));

    await w.channels.removeChannel(id);
    const again = await w.jobs.whenSettled((await w.channels.addChannel('@again2')).job.id);
    expect(again.result).toMatchObject({ outcome: 'created' });
    expect(again.result!.followUpJobId).not.toBe(oldJobId);

    w.source.holdCaptures = false;
    w.source.release(ids[0]!);
    const backfill = await w.jobs.whenSettled(again.result!.followUpJobId!);
    expect(backfill).toMatchObject({ scope: { trigger: 'subscribe', mode: 'backfill' } });
    await vi.waitFor(() => expect(w.jobs.isBusy()).toBe(false));
    expect(collectedIds(w)).toEqual([...ids].sort());
  });

  it('discards what a stopped discovery found even when the channel is enabled again before it returns', async () => {
    const w = await world();
    const id = w.source.addChannel('racing');
    w.source.publish(id, 'z', w.clock.now, [1]);
    await subscribe(w, 'racing');
    const cursor = (await w.channelStore.list())[0]!.cursor;
    let release!: () => void;
    w.source.holdDiscovery = new Promise((resolve) => { release = resolve; });
    w.advance(HOUR);
    w.source.publish(id, 'n', w.clock.now, [0.01], 5);
    const [old] = await w.channels.startRun({ trigger: 'manual' });
    await vi.waitFor(() => expect(w.jobs.get(old!.job.id).phase).toBe('discover'));

    await w.channels.setChannelEnabled(id, false);
    const resumed = await w.channels.setChannelEnabled(id, true);
    w.source.holdDiscovery = null;
    release();
    expect(await w.jobs.whenSettled(old!.job.id)).toMatchObject({ result: { outcome: 'skipped', skipReason: 'subscription_paused' }, items: null });
    const backfill = await w.jobs.whenSettled(resumed.submission!.job.id);
    expect(backfill.scope).toMatchObject({ trigger: 'resume' });
    expect((await w.channelStore.list())[0]!.cursor).not.toEqual(cursor);
  });

  it('still collects a queued video the user also submitted directly, past a pause and the backfill bound', async () => {
    const w = await world({ capture: 1 });
    const id = w.source.addChannel('claimed');
    const ids = w.source.publish(id, 'c', w.clock.now, [1, 2, 45]);
    // Listed as 25 days old, published 45 days ago: the backfill bound alone would skip it.
    w.source.channels.get(id)!.videos[2]!.listedAt = new Date(w.clock.now.getTime() - 25 * DAY).toISOString();
    w.source.holdCaptures = true;
    const added = await w.jobs.whenSettled((await w.channels.addChannel('@claimed')).job.id);
    const jobId = added.result!.followUpJobId!;
    await vi.waitFor(() => expect(w.source.running()).toEqual([ids[0]]));

    const manual = await w.jobs.submitVideo(`https://www.youtube.com/watch?v=${ids[2]}`);
    expect(manual.deduplicated).toBe(true);
    await w.channels.setChannelEnabled(id, false);
    w.source.holdCaptures = false;
    w.source.release(ids[0]!);
    const job = await w.jobs.whenSettled(jobId);
    expect(job.items!.map((item) => [item.sourceId, item.outcome, item.skipReason])).toEqual([
      [ids[0], 'created', undefined],
      [ids[1], 'skipped', 'subscription_paused'],
      [ids[2], 'created', undefined],
    ]);
    expect(collectedIds(w)).toEqual([ids[0], ids[2]].sort());
  });

  it('removes a subscription, keeps its documents and refuses checks of a paused one', async () => {
    const w = await world({ capture: 1 });
    const id = w.source.addChannel('leaving');
    const ids = w.source.publish(id, 'l', w.clock.now, [1, 2, 3]);
    w.source.holdCaptures = true;
    const added = await w.jobs.whenSettled((await w.channels.addChannel('@leaving')).job.id);
    await vi.waitFor(() => expect(w.source.running()).toEqual([ids[0]]));
    w.source.release(ids[0]!);
    await vi.waitFor(() => expect(w.source.running()).toEqual([ids[1]]));

    expect(await w.channels.removeChannel(id)).toEqual({ documentsKept: 1 });
    w.source.release(ids[1]!);
    const removed = await w.jobs.whenSettled(added.result!.followUpJobId!);
    expect(removed.items!.map((item) => item.skipReason ?? item.outcome)).toEqual(['created', 'created', 'subscription_removed']);
    expect(collectedIds(w)).toEqual([ids[0], ids[1]].sort());
    expect(await w.channelStore.list()).toEqual([]);
    await expect(w.channels.removeChannel(id)).rejects.toMatchObject({ code: 'channel_not_found' });

    const other = w.source.addChannel('paused');
    w.source.holdCaptures = false;
    await subscribe(w, 'paused');
    await w.channels.setChannelEnabled(other, false);
    await expect(w.channels.startRun({ trigger: 'manual', channelIds: [other] })).rejects.toMatchObject({ code: 'channel_paused' });
  });

  it('keeps paused and removed subscriptions as they are after a restart', async () => {
    const w = await world();
    const kept = w.source.addChannel('kept');
    const paused = w.source.addChannel('rest');
    const removed = w.source.addChannel('gone');
    for (const [channel, prefix] of [[kept, 'k'], [paused, 'z'], [removed, 'q']] as const) w.source.publish(channel, prefix, w.clock.now, [1]);
    for (const name of ['kept', 'rest', 'gone']) await subscribe(w, name);
    await w.channels.setChannelEnabled(paused, false);
    await w.channels.removeChannel(removed);

    await w.restart();
    w.advance(HOUR);
    expect((await w.channelStore.list()).map((channel) => [channel.id, channel.enabled])).toEqual([[kept, true], [paused, false]]);
    const submissions = await w.channels.startRun({ trigger: 'scheduled' });
    expect(submissions.map(({ job }) => job.source.id)).toEqual([kept]);
    await settleAll(w, submissions);
  });

  it('lists subscriptions with their status, progress, document count and newest collection time', async () => {
    const w = await world({ capture: 1 });
    const id = w.source.addChannel('listed');
    const ids = w.source.publish(id, 'v', w.clock.now, [1, 2]);
    w.source.holdCaptures = true;
    await w.channels.addChannel('@listed');
    await vi.waitFor(() => expect(w.source.running()).toEqual([ids[0]]));
    expect((await w.channels.listSubscriptions())[0]).toMatchObject({
      id, status: 'collecting', activeJob: { done: 0, total: 2 }, documentCount: 0, lastCollectedAt: null,
    });
    w.source.holdCaptures = false;
    w.source.release(ids[0]!);
    await vi.waitFor(() => expect(w.jobs.isBusy()).toBe(false));
    expect((await w.channels.listSubscriptions())[0]).toMatchObject({
      status: 'tracking', activeJob: null, documentCount: 2, lastCollectedAt: w.clock.now.toISOString(),
    });
    await w.channels.setChannelEnabled(id, false);
    expect((await w.channels.listSubscriptions())[0]).toMatchObject({ status: 'paused' });
  });
});

describe('subscription events (S-T12)', () => {
  it('records subscribing, pausing, resuming and removing as events', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xr-subscription-events-'));
    roots.push(directory);
    const w = await world({ jobsDirectory: directory });
    const id = w.source.addChannel('events');
    await subscribe(w, 'events');
    await w.channels.setChannelEnabled(id, false);
    const resumed = await w.channels.setChannelEnabled(id, true);
    await w.jobs.whenSettled(resumed.submission!.job.id);
    await w.channels.removeChannel(id);
    await w.store.flush();
    const events = await readEventFiles(directory);
    expect(events.filter((event) => event.eventType.startsWith('subscription.'))).toEqual([
      expect.objectContaining({ eventType: 'subscription.added', sourceId: syntheticChannelId('events'), jobId: null }),
      expect.objectContaining({ eventType: 'subscription.paused' }),
      expect.objectContaining({ eventType: 'subscription.resumed' }),
      expect.objectContaining({ eventType: 'subscription.removed' }),
    ]);
  });
});
