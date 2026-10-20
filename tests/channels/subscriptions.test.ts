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

describe('first subscription (S-T3)', () => {
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
    expect(first.scope).toEqual({ trigger: 'subscribe' });
    expect(w.jobs.get(first.items![0]!.jobId!).publishedNotBefore).toBe('2026-09-15T04:00:00.000Z');
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

    // The next check keeps it as a candidate without asking YouTube again.
    expect((await w.channelStore.list())[0]!.outOfRange).toEqual([{ videoId: borderline, before: '2026-09-15T04:00:00.000Z' }]);
    w.advance(HOUR);
    const [next] = await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
    expect(next).toMatchObject({ state: 'completed', result: { outcome: 'empty' }, items: [] });
    expect(w.jobs.list({ state: 'all', limit: 100 }).jobs.filter((job) => job.kind === 'youtube.video')).toHaveLength(0);

    // A wider range starts before the recorded one, so the video is checked again and now collected.
    await w.channels.updateSettings(id, { backfillWindow: '3m' });
    w.advance(HOUR);
    const [wider] = await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
    expect(wider!.items).toEqual([expect.objectContaining({ sourceId: borderline, outcome: 'created' })]);
    expect((await w.channelStore.list())[0]!.outOfRange).toEqual([{ videoId: borderline, before: '2026-09-15T04:00:00.000Z' }]);

    // Once the video leaves the candidates, the record goes with it.
    w.source.channels.get(id)!.videos.splice(1, 1);
    w.advance(HOUR);
    await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
    expect((await w.channelStore.list())[0]!.outOfRange).toEqual([]);
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

describe('checks after the first (R-02, R-03, R-07, R-09)', () => {
  it('collects only the new videos when a few were published, and only the newest limit when more were', async () => {
    const w = await world();
    const id = w.source.addChannel('busy');
    const older = w.source.publish(id, 'o', w.clock.now, Array.from({ length: 12 }, (_, index) => 1 + index));
    const first = await subscribe(w, 'busy');
    expect(first.items!.map((item) => item.sourceId)).toEqual(older.slice(0, 10));

    w.advance(30 * 60_000);
    const few = w.source.publish(id, 'b', w.clock.now, [0.01, 0.02, 0.03]);
    const [check] = await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
    expect(check!.items!.map((item) => item.sourceId)).toEqual(few);

    w.advance(30 * 60_000);
    const many = w.source.publish(id, 'm', w.clock.now, Array.from({ length: 15 }, (_, index) => (index + 1) / 10_000), 100);
    const [crowded] = await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
    expect(crowded!.items!.map((item) => item.sourceId)).toEqual(many.slice(0, 10));

    // The five older new videos fall outside the newest ten for good: later checks never reach them.
    w.advance(30 * 60_000);
    const [next] = await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
    expect(next).toMatchObject({ result: { outcome: 'empty' }, items: [] });
    expect(many.slice(10).some((video) => w.documents.documents.has(video))).toBe(false);
    expect(older.slice(10).some((video) => w.documents.documents.has(video))).toBe(false);
    expect(new Set(w.source.captures).size).toBe(w.source.captures.length);
  });

  it('joins the active job when a check overlaps it, then finds what was published meanwhile', async () => {
    const w = await world({ capture: 1 });
    const id = w.source.addChannel('overlap');
    w.source.publish(id, 'a', w.clock.now, [1]);
    await subscribe(w, 'overlap');

    w.advance(30 * 60_000);
    w.source.holdCaptures = true;
    const firstNew = w.source.publish(id, 'b', w.clock.now, [0.01]);
    const [running] = await w.channels.startRun({ trigger: 'scheduled' });
    await vi.waitFor(() => expect(w.source.running()).toEqual(firstNew));

    w.advance(30 * 60_000);
    const meanwhile = w.source.publish(id, 'c', w.clock.now, [0.001], 10);
    const [manual] = await w.channels.startRun({ trigger: 'manual' });
    const [scheduled] = await w.channels.startRun({ trigger: 'scheduled' });
    expect(manual).toMatchObject({ deduplicated: true, job: { id: running!.job.id } });
    expect(scheduled).toMatchObject({ deduplicated: true, job: { id: running!.job.id } });

    w.source.holdCaptures = false;
    w.source.release(firstNew[0]!);
    expect((await w.jobs.whenSettled(running!.job.id)).items!.map((item) => item.sourceId)).toEqual(firstNew);
    w.advance(30 * 60_000);
    const [next] = await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
    expect(next!.items!.map((item) => item.sourceId)).toEqual(meanwhile);
    expect(w.source.captures.filter((video) => video === firstNew[0])).toHaveLength(1);
  });

  it('tries a failed video again at the next check while it is still a candidate', async () => {
    const w = await world();
    const id = w.source.addChannel('retrying');
    const [fresh, other] = w.source.publish(id, 'f', w.clock.now, [0.1, 1]);
    w.source.failures.set(fresh!, new CollectorError('no_subtitles', '這支影片沒有可取得的既有字幕。'));
    const first = await subscribe(w, 'retrying');
    expect(first.items!.map((item) => [item.sourceId, item.state])).toEqual([[fresh, 'failed'], [other, 'completed']]);

    w.source.failures.clear();
    w.advance(30 * 60_000);
    const [next] = await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
    expect(next!.items!.map((item) => [item.sourceId, item.outcome])).toEqual([[fresh, 'created']]);
  });
});

describe('full queue', () => {
  it('fails the videos that could not be queued, and the next check finds them again', async () => {
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

    w.advance(30 * 60_000);
    await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' }));
    await vi.waitFor(() => expect(w.jobs.isBusy()).toBe(false));
    expect(collectedIds(w)).toEqual([...ids].sort());
  });
});

describe('every check follows the same rule (R-05)', () => {
  type Check = (w: World, id: string) => Promise<CollectionJob>;
  const scheduled: Check = async (w) => (await settleAll(w, await w.channels.startRun({ trigger: 'scheduled' })))[0]!;
  const checks: Array<[string, Check]> = [
    ['a scheduled check', scheduled],
    ['an immediate check', async (w, id) => (await settleAll(w, await w.channels.startRun({ trigger: 'manual', channelIds: [id] })))[0]!],
    ['a resume', async (w, id) => {
      await w.channels.setChannelEnabled(id, false);
      return w.jobs.whenSettled((await w.channels.setChannelEnabled(id, true)).submission!.job.id);
    }],
    ['a check after a long gap', async (w, id) => { w.advance(3 * DAY); return scheduled(w, id); }],
    ['a check after the service restarts', async (w, id) => { await w.restart(); return scheduled(w, id); }],
    ['a check after a failed one', async (w, id) => {
      w.source.discoveryFailure = new CollectorError('network_error', '網路連線失敗。');
      expect((await scheduled(w, id)).state).toBe('failed');
      w.source.discoveryFailure = null;
      w.advance(HOUR);
      return scheduled(w, id);
    }],
  ];

  /** Twelve videos within the range, of which the second is collected and the fourth taken out of the candidates. */
  async function prepared(w: World, id: string): Promise<string[]> {
    const ids = w.source.publish(id, 'v', w.clock.now, Array.from({ length: 12 }, (_, index) => 0.5 + index / 2));
    await w.documents.add(await w.source.capture({ videoId: ids[1]!, canonicalUrl: `https://www.youtube.com/watch?v=${ids[1]}` }));
    w.source.channels.get(id)!.videos.splice(3, 1);
    return ids.filter((_, index) => index !== 3);
  }

  it('collects the newest videos in range at the first subscription, leaving out the collected one', async () => {
    const w = await world();
    const id = w.source.addChannel('same');
    const ids = await prepared(w, id);
    const job = await subscribe(w, 'same');
    expect(job.items!.map((item) => item.sourceId)).toEqual([ids[0], ...ids.slice(2, 10)]);
  });

  it.each(checks)('collects the same videos at %s', async (_name, check) => {
    const w = await world();
    const id = w.source.addChannel('same');
    await subscribe(w, 'same');
    w.advance(HOUR);
    const ids = await prepared(w, id);
    const job = await check(w, id);
    expect(job.state).toBe('completed');
    expect(job.items!.map((item) => item.sourceId)).toEqual([ids[0], ...ids.slice(2, 10)]);
  });
});

describe('settings when discovery starts (S-T7, A3)', () => {
  it('uses the subscription settings in force when its queued check starts discovering', async () => {
    const w = await world();
    const blocker = w.source.addChannel('blocker');
    const id = w.source.addChannel('snapshot');
    w.source.publish(blocker, 'k', w.clock.now, [1]);
    await subscribe(w, 'blocker');
    await subscribe(w, 'snapshot');
    w.advance(HOUR);
    const ids = w.source.publish(id, 's', w.clock.now, Array.from({ length: 20 }, (_, index) => 1 + index));
    let release!: () => void;
    w.source.holdDiscovery = new Promise((resolve) => { release = resolve; });
    const [held] = await w.channels.startRun({ trigger: 'manual', channelIds: [blocker] });
    await vi.waitFor(() => expect(w.jobs.get(held!.job.id).phase).toBe('discover'));
    const [queued] = await w.channels.startRun({ trigger: 'manual', channelIds: [id] });
    expect(queued!.job.state).toBe('queued');

    await w.channels.updateSettings(id, { backfillWindow: '1w', backfillMaxItems: 5 });
    w.source.holdDiscovery = null;
    release();
    const check = await w.jobs.whenSettled(queued!.job.id);
    expect(check.items!.map((item) => item.sourceId)).toEqual(ids.slice(0, 5));
    expect(w.jobs.get(check.items![0]!.jobId!).publishedNotBefore).toBe('2026-10-08T05:00:00.000Z');
    await w.jobs.whenSettled(held!.job.id);
  });

  it('starts a subscription with the settings chosen when its channel-add job was accepted', async () => {
    const w = await world();
    const id = w.source.addChannel('chosen');
    w.source.publish(id, 'c', w.clock.now, Array.from({ length: 8 }, (_, index) => 1 + 3 * index));
    const added = await w.jobs.whenSettled((await w.channels.addChannel('@chosen', { intervalMinutes: 60, backfillWindow: '2w', backfillMaxItems: 5 })).job.id);
    const first = await w.jobs.whenSettled(added.result!.followUpJobId!);
    expect(first.scope).toEqual({ trigger: 'subscribe' });
    expect(first.progress).toMatchObject({ total: 5 });
    expect(w.jobs.get(first.items![0]!.jobId!).publishedNotBefore).toBe('2026-10-01T04:00:00.000Z');
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

    // Resuming checks with the subscription's settings; the collected video stays a candidate that is not collected.
    w.source.holdCaptures = false;
    await w.channels.updateSettings(id, { backfillWindow: '1w', backfillMaxItems: 5 });
    const resumed = await w.channels.setChannelEnabled(id, true);
    expect(resumed.channel).toMatchObject({ enabled: true, settings: { backfillWindow: '1w', backfillMaxItems: 5 } });
    const check = await w.jobs.whenSettled(resumed.submission!.job.id);
    expect(check).toMatchObject({ scope: { trigger: 'resume' } });
    expect(check.items!.map((item) => item.sourceId)).toEqual([ids[1], ids[2]]);

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

  it('starts its own check when resumed while a video of the paused job is still capturing', async () => {
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

  it('runs the first check when a channel is subscribed again right after removal', async () => {
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
    const first = await w.jobs.whenSettled(again.result!.followUpJobId!);
    expect(first).toMatchObject({ scope: { trigger: 'subscribe' } });
    await vi.waitFor(() => expect(w.jobs.isBusy()).toBe(false));
    expect(collectedIds(w)).toEqual([...ids].sort());
  });

  it('discards what a stopped discovery found even when the channel is enabled again before it returns', async () => {
    const w = await world();
    const id = w.source.addChannel('racing');
    w.source.publish(id, 'z', w.clock.now, [1]);
    await subscribe(w, 'racing');
    let release!: () => void;
    w.source.holdDiscovery = new Promise((resolve) => { release = resolve; });
    w.advance(HOUR);
    const fresh = w.source.publish(id, 'n', w.clock.now, [0.01], 5);
    const [old] = await w.channels.startRun({ trigger: 'manual' });
    await vi.waitFor(() => expect(w.jobs.get(old!.job.id).phase).toBe('discover'));

    await w.channels.setChannelEnabled(id, false);
    const resumed = await w.channels.setChannelEnabled(id, true);
    w.source.holdDiscovery = null;
    release();
    expect(await w.jobs.whenSettled(old!.job.id)).toMatchObject({ result: { outcome: 'skipped', skipReason: 'subscription_paused' }, items: null });
    const check = await w.jobs.whenSettled(resumed.submission!.job.id);
    expect(check.scope).toEqual({ trigger: 'resume' });
    expect(check.items!.map((item) => item.sourceId)).toEqual(fresh);
  });

  it('still collects a queued video the user also submitted directly, past a pause and the range bound', async () => {
    const w = await world({ capture: 1 });
    const id = w.source.addChannel('claimed');
    const ids = w.source.publish(id, 'c', w.clock.now, [1, 2, 45]);
    // Listed as 25 days old, published 45 days ago: the range bound alone would skip it.
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

    expect(await w.channels.removeChannel(id)).toEqual({ documentsKept: 1, documentsDeleted: 0, documentsFailed: 0 });
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
