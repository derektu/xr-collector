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

// The subscription rules hold through SubscriptionService, the only writer of subscriptions, with a
// real job manager running checks of fake source types: failure counts, out-of-range items,
// dispatch times and the check time, and refusing a check request as a whole.

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
async function world() {
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
    });
    services = new SubscriptionServices([service('fake'), service('fake2')]);
    const scheduler = new CollectionScheduler(services.all(), scheduleStore, { now, pollIntervalMs: DAY });
    return { store, jobs, services, stores, scheduler };
  };
  let current = await build();
  return {
    clock, sources,
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

  it('keeps them and the check time when a check interrupted by a restart continues', async () => {
    const w = await world();
    const [held, queued] = w.sources.fake.addFeed('f', w.clock.now, [1, 2]);
    w.sources.fake.held.add(held!);
    const added = await w.jobs.whenSettled((await w.services.of('fake')!.add('https://fake.example/feed/f')).job.id);
    const check = added.result!.followUpJobId!;
    await vi.waitFor(() => expect(w.sources.fake.running()).toEqual([held]));
    // The check's own discovery is recorded before the restart.
    await vi.waitFor(async () => expect((await w.record('fake', 'f')).lastCheckedAt).not.toBeNull());
    const before = dispatchTimes(await w.record('fake', 'f'));

    w.sources.fake.held.delete(held!);
    w.advance(10 * MINUTE);
    await w.crash();
    const resumed = await w.jobs.whenSettled(check);
    expect(resumed.result).toMatchObject({ outcome: 'created' });
    expect(resumed.items?.map((item) => item.sourceId)).toEqual([held, queued]);
    expect(dispatchTimes(await w.record('fake', 'f'))).toEqual(before);
  });

  it('keeps a later check time when a check interrupted by a restart reports its earlier discovery', async () => {
    const w = await world();
    const [held] = w.sources.fake.addFeed('f', w.clock.now, [1, 2]);
    w.sources.fake.held.add(held!);
    const added = await w.jobs.whenSettled((await w.services.of('fake')!.add('https://fake.example/feed/f')).job.id);
    const check = added.result!.followUpJobId!;
    await vi.waitFor(() => expect(w.sources.fake.running()).toEqual([held]));
    const discoveredAt = w.clock.now.toISOString();
    await vi.waitFor(async () => expect((await w.record('fake', 'f')).lastCheckedAt).toBe(discoveredAt));

    w.advance(3 * 60 * MINUTE);
    const later = w.clock.now.toISOString();
    await w.patch('fake', 'f', { lastCheckedAt: later });
    w.sources.fake.held.delete(held!);
    await w.crash();
    expect(await w.jobs.whenSettled(check)).toMatchObject({ state: 'completed' });
    expect((await w.record('fake', 'f')).lastCheckedAt).toBe(later);
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
