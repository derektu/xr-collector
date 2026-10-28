import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Collector } from '../../src/core/collector.js';
import { registerSourceDefinitions } from '../../src/core/source-registry.js';
import { CollectorError, type CollectionJob, type SubscriptionRecord } from '../../src/core/types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { forwardingPort } from '../../src/jobs/subscription-port.js';
import { CollectionScheduler, type ScheduleStore, type StoredSchedule } from '../../src/subscriptions/scheduler.js';
import { SubscriptionService, SubscriptionServices } from '../../src/subscriptions/subscription-service.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { createFakePlugin, FAKE, FAKE2, FakeSource } from '../support/fake-source-plugin.js';
import { readEventFiles } from '../activity/event-files.js';

// The subscription rules hold through SubscriptionService, the only writer of subscriptions, with a
// real job manager running checks of fake source types: failure counts, out-of-range items,
// dispatch times and the check time, failed checks in a row and the pause they lead to, and
// refusing a check request as a whole.

registerSourceDefinitions([FAKE, FAKE2]);

const DAY = 24 * 60 * 60_000;
const MINUTE = 60_000;
const INTERVAL = 60 * MINUTE;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});

class MemoryScheduleStore implements ScheduleStore {
  private value: StoredSchedule = { enabled: true };
  async load(): Promise<StoredSchedule> { return { ...this.value }; }
  async save(value: StoredSchedule): Promise<void> { this.value = { ...value }; }
}

type FakeType = 'fake' | 'fake2';

/**
 * One Vault with both fake types: subscription files and services, a job manager on a job record
 * kept in a directory, a scheduler and a manual clock. `crash()` leaves the running generation as
 * a killed process would and resumes its jobs in a new one on the same Vault and job record.
 */
async function world(onAutoPaused?: (type: FakeType, subscription: SubscriptionRecord) => void | Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-subscription-writer-'));
  const jobsDirectory = await mkdtemp(path.join(tmpdir(), 'xr-subscription-writer-jobs-'));
  roots.push(root, jobsDirectory);
  const clock = { now: new Date('2026-10-15T04:00:00.000Z') };
  const now = () => clock.now;
  const sources = { fake: new FakeSource('fake'), fake2: new FakeSource('fake2') };
  const plugins = [createFakePlugin(FAKE, sources.fake), createFakePlugin(FAKE2, sources.fake2)];
  const scheduleStore = new MemoryScheduleStore();
  const build = async () => {
    const store = await JobStore.open(jobsDirectory, now);
    const collector = new Collector(new MarkdownVault(root, { now }));
    const stores = { fake: new JsonSubscriptionStore(root, 'fake', now), fake2: new JsonSubscriptionStore(root, 'fake2', now) };
    let services!: SubscriptionServices;
    const jobs: JobManager = new JobManager({
      vaultPath: root, store, plugins, documents: collector, subscriptions: forwardingPort(() => services), now,
      limits: { discovery: 1, capture: 1 }, retry: { maxAttempts: 1 }, setTimer: () => () => undefined,
    });
    const service = (type: FakeType) => new SubscriptionService(type, stores[type], jobs, {
      autoCollection: async () => true,
      resolveTarget: (url, signal) => plugins.find((plugin) => plugin.id === type)!.resolveTarget!(url, { priority: 'interactive', signal }),
      documents: () => collector.list(),
      now,
      ...(onAutoPaused ? { onAutoPaused: (subscription: SubscriptionRecord) => onAutoPaused(type, subscription) } : {}),
    });
    services = new SubscriptionServices([service('fake'), service('fake2')]);
    const scheduler = new CollectionScheduler(services.all(), scheduleStore, { now, pollIntervalMs: DAY });
    return { store, jobs, services, stores, scheduler };
  };
  let current = await build();
  return {
    clock, sources,
    async events() {
      await current.store.flush();
      return readEventFiles(jobsDirectory);
    },
    get jobs() { return current.jobs; },
    get services() { return current.services; },
    get scheduler() { return current.scheduler; },
    advance(ms: number) { clock.now = new Date(clock.now.getTime() + ms); },
    async record(type: FakeType, id: string): Promise<SubscriptionRecord> {
      return (await current.stores[type].list()).find((record) => record.id === id)!;
    },
    /** Writes fields of a subscription file directly, as another writer of the same Vault would. */
    async patch(type: FakeType, id: string, patch: Partial<SubscriptionRecord>): Promise<void> {
      await current.stores[type].updateWith(() => new Map([[id, patch]]));
    },
    /** Subscribes through the service and returns the first check once it ends. */
    async subscribe(type: FakeType, id: string): Promise<CollectionJob> {
      const added = await current.jobs.whenSettled((await current.services.of(type)!.add(`https://${type}.example/feed/${id}`)).job.id);
      expect(added.result).toMatchObject({ outcome: 'created' });
      return current.jobs.whenSettled(added.result!.followUpJobId!);
    },
    async checkNow(type: FakeType, id: string): Promise<CollectionJob> {
      return current.jobs.whenSettled((await current.services.of(type)!.checkNow(id)).job.id);
    },
    async crash(): Promise<void> {
      await current.store.flush();
      current = await build();
      await current.jobs.resume();
    },
  };
}

const dispatchTimes = (record: SubscriptionRecord) => ({
  lastDispatchedAt: record.lastDispatchedAt, nextCheckAt: record.nextCheckAt, lastCheckedAt: record.lastCheckedAt,
});

describe('failed items across checks', () => {
  it('marks an item skipped after three failed checks, or at once for a failure that is not retried', async () => {
    const w = await world();
    const [, retried, gone] = w.sources.fake.addFeed('f', w.clock.now, [1, 2, 3]);
    w.sources.fake.fail(retried!, ...[1, 2, 3].map(() => new CollectorError('capture_failed', '收集失敗。')));
    w.sources.fake.fail(gone!, new CollectorError('video_unavailable', '文章不存在。'));

    await w.subscribe('fake', 'f');
    expect((await w.record('fake', 'f')).failures).toEqual([
      expect.objectContaining({ itemKey: retried, attempts: 1, skipped: false }),
      expect.objectContaining({ itemKey: gone, attempts: 1, errorCode: 'video_unavailable', skipped: true }),
    ]);
    await w.checkNow('fake', 'f');
    await w.checkNow('fake', 'f');
    expect((await w.record('fake', 'f')).failures?.find((entry) => entry.itemKey === retried)).toMatchObject({ attempts: 3, skipped: true });

    const captures = w.sources.fake.captures.length;
    const fourth = await w.checkNow('fake', 'f');
    expect(w.sources.fake.captures).toHaveLength(captures);
    expect(fourth.result).toMatchObject({ outcome: 'empty' });
  });

  it('forgets a failed item once it is collected, and once it leaves the collection range', async () => {
    const w = await world();
    const [recovers, leaves] = w.sources.fake.addFeed('f', w.clock.now, [1, 2]);
    w.sources.fake.fail(recovers!, new CollectorError('capture_failed', '收集失敗。'));
    w.sources.fake.fail(leaves!, new CollectorError('capture_failed', '收集失敗。'), new CollectorError('capture_failed', '收集失敗。'));
    await w.subscribe('fake', 'f');
    expect((await w.record('fake', 'f')).failures?.map((entry) => entry.itemKey)).toEqual([recovers, leaves]);

    // Five newer items fill the five candidates of the next check, so `leaves` drops out of its range.
    const feed = w.sources.fake.feed('f');
    feed.items.unshift(...[1, 2, 3, 4, 5].map((index) => ({ key: `new-${index}`, title: `新的 ${index}`, publishedAt: new Date(w.clock.now.getTime() - index * MINUTE).toISOString() })));
    await w.checkNow('fake', 'f');
    expect((await w.record('fake', 'f')).failures).toBeUndefined();
  });
});

describe('out-of-range items', () => {
  it('leaves an item out of every check whose range starts no earlier than the one that found it out of range', async () => {
    const w = await world();
    const [late] = w.sources.fake.addFeed('f', w.clock.now, [40]);
    // The listing reports it inside the 30-day range; its exact publish time is earlier.
    w.sources.fake.feed('f').items[0]!.listedAt = new Date(w.clock.now.getTime() - DAY).toISOString();
    await w.subscribe('fake', 'f');
    const record = await w.record('fake', 'f');
    expect(record.outOfRange).toEqual([{ itemKey: late, before: new Date(w.clock.now.getTime() - 30 * DAY).toISOString() }]);
    expect(w.sources.fake.captures).toEqual([late]);

    w.advance(MINUTE);
    const next = await w.checkNow('fake', 'f');
    expect(w.sources.fake.captures).toEqual([late]);
    expect(next.result).toMatchObject({ outcome: 'empty' });
  });
});

describe('dispatch times', () => {
  it('moves them with the first check of a new subscription, a manual check and a scheduled check', async () => {
    const w = await world();
    w.sources.fake.addFeed('f', w.clock.now, [1]);
    const subscribedAt = w.clock.now.toISOString();
    await w.subscribe('fake', 'f');
    expect(dispatchTimes(await w.record('fake', 'f'))).toEqual({
      lastDispatchedAt: subscribedAt, nextCheckAt: new Date(w.clock.now.getTime() + INTERVAL).toISOString(), lastCheckedAt: subscribedAt,
    });

    w.advance(10 * MINUTE);
    const manualAt = w.clock.now;
    await w.checkNow('fake', 'f');
    expect(dispatchTimes(await w.record('fake', 'f'))).toEqual({
      lastDispatchedAt: manualAt.toISOString(), nextCheckAt: new Date(manualAt.getTime() + INTERVAL).toISOString(), lastCheckedAt: manualAt.toISOString(),
    });

    // Two minutes late, a scheduled check keeps the rhythm of the time that came due.
    const due = new Date(manualAt.getTime() + INTERVAL);
    w.advance(INTERVAL + 2 * MINUTE);
    await w.scheduler.checkNow();
    await vi.waitFor(() => expect(w.jobs.isBusy()).toBe(false));
    expect(dispatchTimes(await w.record('fake', 'f'))).toEqual({
      lastDispatchedAt: w.clock.now.toISOString(), nextCheckAt: new Date(due.getTime() + INTERVAL).toISOString(), lastCheckedAt: w.clock.now.toISOString(),
    });
  });

  it('keeps them and the check time when the failed items of a check are collected again', async () => {
    const w = await world();
    const [failing] = w.sources.fake.addFeed('f', w.clock.now, [1, 2]);
    w.sources.fake.fail(failing!, new CollectorError('capture_failed', '收集失敗。'));
    const first = await w.subscribe('fake', 'f');
    expect(first.result).toMatchObject({ outcome: 'partial' });
    const before = dispatchTimes(await w.record('fake', 'f'));

    w.advance(10 * MINUTE);
    const retry = await w.jobs.whenSettled((await w.jobs.retry(first.id)).job.id);
    expect(retry.result).toMatchObject({ outcome: 'created' });
    const after = await w.record('fake', 'f');
    expect(dispatchTimes(after)).toEqual(before);
    expect(after.failures).toBeUndefined();
  });

  it('keeps them when a check interrupted by a restart continues, and records the check time when it ends', async () => {
    const w = await world();
    const [held, queued] = w.sources.fake.addFeed('f', w.clock.now, [1, 2]);
    w.sources.fake.held.add(held!);
    const added = await w.jobs.whenSettled((await w.services.of('fake')!.add('https://fake.example/feed/f')).job.id);
    const check = added.result!.followUpJobId!;
    await vi.waitFor(() => expect(w.sources.fake.running()).toEqual([held]));
    // Listed, with an item still collecting: the first check has not ended.
    const before = dispatchTimes(await w.record('fake', 'f'));
    expect(before.lastCheckedAt).toBeNull();

    w.sources.fake.held.delete(held!);
    w.advance(10 * MINUTE);
    await w.crash();
    const resumed = await w.jobs.whenSettled(check);
    expect(resumed.result).toMatchObject({ outcome: 'created' });
    expect(resumed.items?.map((item) => item.sourceId)).toEqual([held, queued]);
    expect(dispatchTimes(await w.record('fake', 'f'))).toEqual({ ...before, lastCheckedAt: resumed.finishedAt });
  });

  it('records the check time when the last item ends, and keeps a later one', async () => {
    const w = await world();
    w.sources.fake.addFeed('f', w.clock.now, [1]);
    const first = await w.subscribe('fake', 'f');
    expect((await w.record('fake', 'f')).lastCheckedAt).toBe(first.finishedAt);

    // The feed gains a second item; the next check lists it and collects it while the test holds it.
    const [, held] = w.sources.fake.addFeed('f', w.clock.now, [1, 2]);
    w.sources.fake.held.add(held!);
    w.advance(10 * MINUTE);
    const accepted = await w.services.of('fake')!.checkNow('f');
    await vi.waitFor(() => expect(w.sources.fake.running()).toEqual([held]));
    expect((await w.record('fake', 'f')).lastCheckedAt).toBe(first.finishedAt);
    w.advance(5 * MINUTE);
    w.sources.fake.release(held!);
    const second = await w.jobs.whenSettled(accepted.job.id);
    expect(second.finishedAt).toBe(w.clock.now.toISOString());
    expect((await w.record('fake', 'f')).lastCheckedAt).toBe(second.finishedAt);

    const later = new Date(w.clock.now.getTime() + 60 * MINUTE).toISOString();
    await w.patch('fake', 'f', { lastCheckedAt: later });
    await w.checkNow('fake', 'f');
    expect((await w.record('fake', 'f')).lastCheckedAt).toBe(later);
  });
});

describe('failed checks in a row', () => {
  const gone = () => new CollectorError('feed_gone', '這個動態已不存在。');

  it('records the check time of a failed check, counts failures in a row and clears them on a success', async () => {
    const w = await world();
    w.sources.fake.addFeed('f', w.clock.now, [1]);
    await w.subscribe('fake', 'f');
    const service = w.services.of('fake')!;

    w.advance(10 * MINUTE);
    w.sources.fake.listFailures.push(gone());
    const first = await w.checkNow('fake', 'f');
    expect(first.state).toBe('failed');
    expect(await w.record('fake', 'f')).toMatchObject({
      lastCheckedAt: first.finishedAt, checkFailures: { count: 1, since: first.finishedAt, error: { code: 'feed_gone' } },
    });
    w.advance(10 * MINUTE);
    w.sources.fake.listFailures.push(new CollectorError('network_error', '無法連線。'), gone());
    await w.checkNow('fake', 'f');
    w.advance(10 * MINUTE);
    const third = await w.checkNow('fake', 'f');
    expect(await w.record('fake', 'f')).toMatchObject({
      lastCheckedAt: third.finishedAt, checkFailures: { count: 3, since: first.finishedAt, error: { code: 'feed_gone' } },
    });
    expect((await service.listSubscriptions())[0]).toMatchObject({
      status: 'error', lastError: { code: 'feed_gone' }, checkFailures: { count: 3 }, autoPausedAt: null,
      checkStatus: { state: 'failing', failures: 3 },
    });
    // A failed check never enters the failed section of the jobs page.
    expect((await w.jobs.overview()).failed.map((entry) => entry.jobId)).not.toContain(third.id);

    w.advance(10 * MINUTE);
    const success = await w.checkNow('fake', 'f');
    expect(success.state).toBe('completed');
    const record = await w.record('fake', 'f');
    expect(record.checkFailures).toBeUndefined();
    expect(record.lastCheckedAt).toBe(success.finishedAt);
    expect((await service.listSubscriptions())[0]).toMatchObject({ status: 'tracking', lastError: null, checkFailures: null });
  });

  it('does not count a source that needs a new sign-in, a check a pause stopped, or a source that limits requests', async () => {
    const w = await world();
    w.sources.fake.addFeed('f', w.clock.now, [1, 2]);
    await w.subscribe('fake', 'f');
    w.advance(10 * MINUTE);
    w.sources.fake.listFailures.push(gone());
    const failed = await w.checkNow('fake', 'f');

    // A sign-in failure ends the check without counting it.
    w.advance(10 * MINUTE);
    w.sources.fake.listFailures.push(new CollectorError('login_needed', '需要重新登入。'));
    const signIn = await w.checkNow('fake', 'f');
    expect(signIn.state).toBe('failed');
    expect(await w.record('fake', 'f')).toMatchObject({ lastCheckedAt: signIn.finishedAt, checkFailures: { count: 1, since: failed.finishedAt } });

    // A check a pause stopped while its item finished records its time and leaves the count.
    w.advance(10 * MINUTE);
    // The feed gains a third item, which the check collects.
    const [, , added] = w.sources.fake.addFeed('f', w.clock.now, [0, 1, 2]);
    w.sources.fake.held.add(added!);
    const accepted = await w.services.of('fake')!.checkNow('f');
    await vi.waitFor(() => expect(w.sources.fake.running()).toHaveLength(1));
    await w.services.of('fake')!.setEnabled('f', false);
    w.sources.fake.release(added!);
    const stopped = await w.jobs.whenSettled(accepted.job.id);
    expect(stopped.state).toBe('completed');
    expect(await w.record('fake', 'f')).toMatchObject({ lastCheckedAt: stopped.finishedAt, checkFailures: { count: 1 } });

    // A limit leaves the check waiting for the cooldown; it neither ends nor counts.
    w.sources.fake.listFailures.push(gone());
    const resumed = await w.services.of('fake')!.setEnabled('f', true);
    expect(await w.jobs.whenSettled(resumed.submission!.job.id)).toMatchObject({ state: 'failed' });
    const settled = await w.record('fake', 'f');
    expect(settled.checkFailures).toMatchObject({ count: 1 });
    w.advance(10 * MINUTE);
    w.sources.fake.listFailures.push(new CollectorError('rate_limited', '限制連線。'));
    const limited = await w.services.of('fake')!.checkNow('f');
    await vi.waitFor(() => expect(w.jobs.get(limited.job.id)).toMatchObject({ state: 'queued', wait: { reason: 'rate_limited' } }));
    const after = await w.record('fake', 'f');
    expect({ lastCheckedAt: after.lastCheckedAt, checkFailures: after.checkFailures })
      .toEqual({ lastCheckedAt: settled.lastCheckedAt, checkFailures: settled.checkFailures });
  });

  it('pauses after five failures despite a notification profile write failure, then resumes and checks', async () => {
    const autoPauses: Array<{ type: FakeType; subscription: SubscriptionRecord }> = [];
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = await world(async (type, subscription) => {
      autoPauses.push({ type, subscription });
      throw new Error('notification profile is read-only');
    });
    w.sources.fake.addFeed('f', w.clock.now, [1]);
    await w.subscribe('fake', 'f');
    const service = w.services.of('fake')!;
    const failNext = async () => {
      w.advance(10 * MINUTE);
      w.sources.fake.listFailures.push(gone());
      return w.checkNow('fake', 'f');
    };

    // Five in an hour: too short a span.
    const first = await failNext();
    for (let attempt = 0; attempt < 4; attempt += 1) await failNext();
    expect(await w.record('fake', 'f')).toMatchObject({ enabled: true, checkFailures: { count: 5, since: first.finishedAt } });

    // A day of failures, but only four of them.
    await w.patch('fake', 'f', { checkFailures: { count: 3, since: new Date(w.clock.now.getTime() - DAY).toISOString(), error: { code: 'feed_gone', message: '這個動態已不存在。' } } });
    await failNext();
    expect(await w.record('fake', 'f')).toMatchObject({ enabled: true, checkFailures: { count: 4 } });
    expect((await w.record('fake', 'f')).autoPausedAt).toBeUndefined();

    // The fifth, a day after the first.
    const fifth = await failNext();
    const paused = await w.record('fake', 'f');
    expect(paused).toMatchObject({ enabled: false, nextCheckAt: null, autoPausedAt: fifth.finishedAt, checkFailures: { count: 5 } });
    expect((await service.listSubscriptions())[0]).toMatchObject({
      status: 'paused', autoPausedAt: fifth.finishedAt, checkStatus: { state: 'auto_paused', failures: 5 },
    });
    expect((await w.events()).filter((event) => event.eventType === 'subscription.auto_paused'))
      .toEqual([expect.objectContaining({ severity: 'warning', subscriptionId: 'f', errorCode: 'feed_gone' })]);
    expect(autoPauses).toEqual([{ type: 'fake', subscription: expect.objectContaining({
      id: 'f', enabled: false, autoPausedAt: fifth.finishedAt, checkFailures: expect.objectContaining({ count: 5 }),
    }) }]);
    expect(warning).toHaveBeenCalledWith('Unable to record auto-pause notification', expect.objectContaining({ message: 'notification profile is read-only' }));
    warning.mockRestore();
    await expect(service.checkNow('f')).rejects.toMatchObject({ code: 'subscription_paused' });

    const resumed = await service.setEnabled('f', true);
    expect(resumed.subscription.checkFailures).toBeUndefined();
    expect(resumed.subscription.autoPausedAt).toBeUndefined();
    const check = await w.jobs.whenSettled(resumed.submission!.job.id);
    expect(check).toMatchObject({ state: 'completed', scope: { trigger: 'resume' } });
    expect(await w.record('fake', 'f')).toMatchObject({ enabled: true, lastCheckedAt: check.finishedAt });
  });
});

describe('checking listed subscriptions', () => {
  it('refuses a request across types with a paused subscription before any job starts', async () => {
    const w = await world();
    w.sources.fake.addFeed('f', w.clock.now, [1]);
    w.sources.fake2.addFeed('g', w.clock.now, [1]);
    await w.subscribe('fake', 'f');
    await w.subscribe('fake2', 'g');
    await w.services.of('fake2')!.setEnabled('g', false);
    const before = dispatchTimes(await w.record('fake', 'f'));
    const jobs = w.jobs.list({ state: 'all', limit: 100 }).jobs.length;

    w.advance(MINUTE);
    await expect(w.services.startChecks([{ type: 'fake', id: 'f' }, { type: 'fake2', id: 'g' }]))
      .rejects.toMatchObject({ code: 'subscription_paused' });
    await expect(w.services.startChecks([{ type: 'fake', id: 'f' }, { type: 'fake2', id: 'missing' }]))
      .rejects.toMatchObject({ code: 'subscription_not_found' });
    expect(w.jobs.list({ state: 'all', limit: 100 }).jobs).toHaveLength(jobs);
    expect(dispatchTimes(await w.record('fake', 'f'))).toEqual(before);
  });
});
