// The scheduler checks each subscription on its own interval and rhythm, never a paused one and
// nothing while automatic collection is off. While the system sleeps or the network is gone it
// dispatches nothing, then checks each due subscription once; a check that began listing after its
// subscription came due serves that due time, also when it finishes before the poll submits. A
// settings change moves the next check by the newest interval, and concurrent changes all persist.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionService, SubscriptionServices } from '../../src/subscriptions/subscription-service.js';
import { forwardingPort } from '../../src/jobs/subscription-port.js';
import { CollectionScheduler, type ScheduleStore, type StoredSchedule } from '../../src/subscriptions/scheduler.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import { Collector } from '../../src/core/collector.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { CollectionPause } from '../../src/core/collection-pause.js';
import { Connectivity } from '../../src/core/connectivity.js';
import { CollectorError, type JobSubmission } from '../../src/core/types.js';
import { memoryJobRecords } from '../../src/runtime/job-records.js';
import { MemoryDocuments, SyntheticYouTube } from './synthetic-youtube.js';
import type { CollectionPolicy } from '../../src/plugins/youtube/settings.js';
import { youtubePlugin } from '../../src/plugins/youtube/server.js';
import { eventually } from '../support/wait.js';
import { VaultFileWriter } from '../../src/vault/vault-files.js';
import { eventSpec } from '../../src/core/event-catalog.js';
import { PRODUCT_SOURCES } from '../support/product-sources.js';

const MINUTE = 60_000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryScheduleStore implements ScheduleStore {
  saves: StoredSchedule[] = [];
  constructor(private value: StoredSchedule = { enabled: true }) {}
  async load(): Promise<StoredSchedule> { return structuredClone(this.value); }
  async save(value: StoredSchedule): Promise<void> {
    this.value = structuredClone(value);
    this.saves.push(structuredClone(value));
  }
}

/**
 * Subscriptions over synthetic channels with a controllable clock, and a scheduler whose polls the
 * test runs by hand.
 */
async function world(schedule: StoredSchedule = { enabled: true }, pause?: CollectionPause, connectivity?: Connectivity) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-scheduler-'));
  roots.push(root);
  const clock = { now: new Date('2026-10-15T04:00:00.000Z') };
  const now = () => clock.now;
  const source = new SyntheticYouTube();
  const documents = new MemoryDocuments(now);
  const channelStore = new JsonSubscriptionStore(new VaultFileWriter(root, PRODUCT_SOURCES), 'youtube');
  const collector = new Collector(documents);
  const jobs: JobManager = new JobManager({
    sources: PRODUCT_SOURCES,
    vaultPath: root, store: memoryJobRecords(PRODUCT_SOURCES, { now }).jobs, plugins: [youtubePlugin(source)], documents: collector, subscriptions: forwardingPort(() => new SubscriptionServices(PRODUCT_SOURCES, [channels])), now,
    limits: { discovery: 2, capture: 4 }, retry: { maxAttempts: 1 }, ...(pause ? { pause } : {}), ...(connectivity ? { connectivity } : {}),
  });
  const scheduleStore = new MemoryScheduleStore(schedule);
  const events: string[] = [];
  const eventRecords: Array<{ eventType: string; severity: string }> = [];
  let scheduler!: CollectionScheduler;
  const channels = new SubscriptionService('youtube', channelStore, jobs, {
    sources: PRODUCT_SOURCES,
    autoCollection: () => scheduler.isEnabled(), resolveTarget: (url) => source.resolveChannel(url), documents: () => collector.list(), now,
  });
  scheduler = new CollectionScheduler([channels], scheduleStore, {
    now, pollIntervalMs: 24 * 60 * MINUTE, recordEvent: (entry) => { events.push(entry.eventType); eventRecords.push({ ...entry, severity: entry.severity ?? eventSpec(entry.eventType)!.severity }); }, ...(pause ? { pause } : {}),
  });
  const runs = vi.spyOn(channels, 'startRun');
  const jobEvents = vi.spyOn(jobs, 'recordEvent');
  return {
    root, clock, source, jobs, channels, channelStore, scheduler, scheduleStore, events, eventRecords, runs,
    jobEvents: () => jobEvents.mock.calls.map(([entry]) => entry.eventType),
    advance(ms: number) { clock.now = new Date(clock.now.getTime() + ms); },
    /** Starts the scheduler and returns once the check it starts has finished. */
    async start() {
      await scheduler.start();
      await scheduler.idle();
    },
    async idle() {
      // A dispatched check records the dispatch before it submits its jobs.
      await scheduler.idle();
      await eventually(() => expect(jobs.isBusy()).toBe(false));
      // A check leaves the job list before it records its end in the subscription.
      (await jobs.hold())();
    },
    async subscribe(name: string, settings: Partial<CollectionPolicy>): Promise<string> {
      const id = source.addChannel(name);
      source.publish(id, name.slice(0, 1), clock.now, [1]);
      const added = await jobs.whenSettled((await channels.add(`@${name}`, settings)).job.id);
      await jobs.whenSettled(added.result!.followUpJobId!);
      return id;
    },
    scheduledChecks(id: string): number {
      return jobs.list({ limit: 100 }).jobs.filter((job) => job.kind === 'youtube.channel' && job.source.id === id && job.scope?.trigger === 'scheduled').length;
    },
    async channel(id: string) { return (await channelStore.list()).find((channel) => channel.id === id)!; },
  };
}

type World = Awaited<ReturnType<typeof world>>;

async function poll(w: World): Promise<void> {
  await w.scheduler.checkNow();
  await w.idle();
}

describe('per-subscription scheduling (A2)', () => {
  it('checks each subscription on its own interval', async () => {
    const w = await world();
    const quarter = await w.subscribe('quarter', { intervalMinutes: 15 });
    const hourly = await w.subscribe('hourly', { intervalMinutes: 60 });
    const daily = await w.subscribe('daily', { intervalMinutes: 1440 });
    await w.start();
    for (let step = 0; step < 8; step += 1) {
      w.advance(15 * MINUTE);
      await poll(w);
    }
    expect([w.scheduledChecks(quarter), w.scheduledChecks(hourly), w.scheduledChecks(daily)]).toEqual([8, 2, 0]);
    expect(await w.channel(daily)).toMatchObject({ nextCheckAt: '2026-10-16T04:00:00.000Z' });
    await w.scheduler.close();
  });

  it('submits the subscriptions due in one poll together, one job each', async () => {
    const w = await world();
    const quarter = await w.subscribe('together-a', { intervalMinutes: 15 });
    const hourly = await w.subscribe('together-b', { intervalMinutes: 60 });
    await w.start();
    w.runs.mockClear();
    w.advance(60 * MINUTE);
    await poll(w);
    expect(w.runs.mock.calls).toEqual([[{ trigger: 'scheduled', subscriptionIds: [quarter, hourly] }]]);
    expect([w.scheduledChecks(quarter), w.scheduledChecks(hourly)]).toEqual([1, 1]);
    expect(await w.channel(quarter)).toMatchObject({ lastDispatchedAt: '2026-10-15T05:00:00.000Z', nextCheckAt: '2026-10-15T05:15:00.000Z' });
    expect(await w.channel(hourly)).toMatchObject({ lastDispatchedAt: '2026-10-15T05:00:00.000Z', nextCheckAt: '2026-10-15T06:00:00.000Z' });
    await w.scheduler.close();
  });

  it('joins a job still running and moves the next check without a second job', async () => {
    const w = await world();
    const id = await w.subscribe('slow', { intervalMinutes: 15 });
    await w.start();
    w.source.holdCaptures = true;
    const [video] = w.source.publish(id, 'n', w.clock.now, [0.001], 5);
    w.advance(15 * MINUTE);
    await w.scheduler.checkNow();
    await w.source.holds.reach([video]);
    w.advance(15 * MINUTE);
    await w.scheduler.checkNow();
    expect(w.scheduledChecks(id)).toBe(1);
    expect(await w.channel(id)).toMatchObject({ nextCheckAt: '2026-10-15T04:45:00.000Z' });
    w.source.holdCaptures = false;
    w.source.release(video!);
    await w.idle();
    await w.scheduler.close();
  });

  it('starts a new check when the one before it started listing before the subscription came due', async () => {
    const w = await world();
    const id = await w.subscribe('long', { intervalMinutes: 15 });
    await w.start();
    w.source.holdCaptures = true;
    const [video] = w.source.publish(id, 'l', w.clock.now, [0.001], 5);
    w.advance(15 * MINUTE);
    await w.scheduler.checkNow();
    await w.source.holds.reach([video]);
    // The check listed at 04:15 and finishes after 04:30 came due, before the next poll.
    w.advance(15 * MINUTE);
    w.source.holdCaptures = false;
    w.source.release(video!);
    await w.idle();
    await poll(w);
    expect(w.scheduledChecks(id)).toBe(2);
    expect(await w.channel(id)).toMatchObject({ nextCheckAt: '2026-10-15T04:45:00.000Z' });
    await w.scheduler.close();
  });

  it('never checks a paused subscription, and checks nothing while automatic collection is off', async () => {
    const w = await world();
    const active = await w.subscribe('active', { intervalMinutes: 15 });
    const paused = await w.subscribe('paused', { intervalMinutes: 15 });
    await w.channels.setEnabled(paused, false);
    expect(await w.channel(paused)).toMatchObject({ nextCheckAt: null });
    await w.start();
    w.advance(15 * MINUTE);
    await poll(w);
    expect([w.scheduledChecks(active), w.scheduledChecks(paused)]).toEqual([1, 0]);

    expect(await w.scheduler.updateSchedule({ enabled: false })).toMatchObject({ enabled: false, status: 'paused', nextCheck: null });
    w.advance(120 * MINUTE);
    await poll(w);
    expect(w.scheduledChecks(active)).toBe(1);

    // Turning it on counts an overdue next check from now.
    await w.scheduler.updateSchedule({ enabled: true });
    expect(await w.channel(active)).toMatchObject({ nextCheckAt: '2026-10-15T06:30:00.000Z' });
    expect(await w.channel(paused)).toMatchObject({ nextCheckAt: null });
    await poll(w);
    expect(w.scheduledChecks(active)).toBe(1);
    expect(w.scheduleStore.saves).toEqual([{ enabled: false }, { enabled: true }]);
    expect(w.events.filter((event) => event === 'schedule.updated')).toHaveLength(2);
    await expect(w.scheduler.updateSchedule({ enabled: 'yes' } as never)).rejects.toMatchObject({ code: 'invalid_request' });
    await w.scheduler.close();
  });

  it('keeps the next checks still ahead when automatic collection is turned back on, and counts the overdue ones from then', async () => {
    const w = await world();
    const quarter = await w.subscribe('quarter', { intervalMinutes: 15 });
    const daily = await w.subscribe('daily', { intervalMinutes: 1440 });
    const paused = await w.subscribe('paused', { intervalMinutes: 15 });
    await w.channels.setEnabled(paused, false);
    await w.start();
    w.advance(15 * MINUTE);
    await poll(w);
    expect(await w.channel(daily)).toMatchObject({ nextCheckAt: '2026-10-16T04:00:00.000Z' });

    await w.scheduler.updateSchedule({ enabled: false });
    w.advance(60 * MINUTE);
    await w.scheduler.updateSchedule({ enabled: true });
    expect(await w.channel(quarter)).toMatchObject({ nextCheckAt: '2026-10-15T05:30:00.000Z' });
    expect(await w.channel(daily)).toMatchObject({ nextCheckAt: '2026-10-16T04:00:00.000Z' });
    expect(await w.channel(paused)).toMatchObject({ nextCheckAt: null });
    await poll(w);
    expect([w.scheduledChecks(quarter), w.scheduledChecks(daily), w.scheduledChecks(paused)]).toEqual([1, 0, 0]);
    await w.scheduler.close();
  });

  it('counts a new interval from the last check and is due at once when that time has passed', async () => {
    const w = await world();
    const id = await w.subscribe('interval', { intervalMinutes: 180 });
    w.advance(40 * MINUTE);
    expect(await w.channels.updateSettings(id, { intervalMinutes: 60 })).toMatchObject({ nextCheckAt: '2026-10-15T05:00:00.000Z' });
    w.advance(30 * MINUTE);
    expect(await w.channels.updateSettings(id, { intervalMinutes: 15 })).toMatchObject({ nextCheckAt: '2026-10-15T05:10:00.000Z' });
    // Backfill settings move nothing and start nothing.
    expect(await w.channels.updateSettings(id, { backfillDays: 60 })).toMatchObject({ nextCheckAt: '2026-10-15T05:10:00.000Z' });
    expect(w.jobs.list({ limit: 100 }).jobs).toHaveLength(2);
    await expect(w.channels.updateSettings(id, { backfillMaxItems: 101 })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(w.jobEvents().filter((event) => event === 'subscription.settings_updated')).toHaveLength(3);
  });

  it('keeps each subscription on its own rhythm however late the poll that dispatches it', async () => {
    const w = await world();
    const id = await w.subscribe('rhythm', { intervalMinutes: 15 });
    await w.start();
    // Each poll comes 7 seconds later than the last; the next checks stay on the quarter hours.
    for (const next of ['04:30', '04:45', '05:00']) {
      w.advance(15 * MINUTE + 7_000);
      await poll(w);
      expect(await w.channel(id)).toMatchObject({ nextCheckAt: `2026-10-15T${next}:00.000Z` });
    }
    expect(w.scheduledChecks(id)).toBe(3);
    // A sleep that missed several periods dispatches once, at 06:25:21; the next check stays on the same rhythm.
    w.advance(100 * MINUTE);
    await poll(w);
    expect(await w.channel(id)).toMatchObject({ nextCheckAt: '2026-10-15T06:30:00.000Z' });
    await poll(w);
    expect(w.scheduledChecks(id)).toBe(4);
    await w.scheduler.close();
  });

  it('moves the next check of every subscription a manual check reaches', async () => {
    const w = await world({ enabled: false });
    const id = await w.subscribe('manual', { intervalMinutes: 30 });
    w.advance(10 * MINUTE);
    const submissions = await w.scheduler.runNow();
    expect(submissions).toHaveLength(1);
    await w.idle();
    expect(await w.channel(id)).toMatchObject({ lastDispatchedAt: '2026-10-15T04:10:00.000Z', nextCheckAt: '2026-10-15T04:40:00.000Z' });
  });

  it('plans subscriptions without a next check one interval from the first poll', async () => {
    const w = await world();
    const id = await w.subscribe('unplanned', { intervalMinutes: 60 });
    await w.channelStore.update(id, { nextCheckAt: null });
    w.advance(5 * MINUTE);
    await w.start();
    await w.scheduler.checkNow();
    expect(await w.channel(id)).toMatchObject({ nextCheckAt: '2026-10-15T05:05:00.000Z' });
    expect(w.scheduledChecks(id)).toBe(0);
    await w.scheduler.close();
  });

  it('reports the newest check and the subscription due first by name', async () => {
    const w = await world();
    const first = await w.subscribe('first', { intervalMinutes: 60 });
    w.advance(5 * MINUTE);
    const second = await w.subscribe('second', { intervalMinutes: 15 });
    expect(await w.scheduler.getSchedule()).toEqual({
      enabled: true,
      status: 'scheduled',
      lastCheck: { type: 'youtube', subscriptionId: second, title: '合成頻道 second', at: '2026-10-15T04:05:00.000Z' },
      nextCheck: { type: 'youtube', subscriptionId: second, title: '合成頻道 second', at: '2026-10-15T04:20:00.000Z' },
    });
    await w.channels.setEnabled(second, false);
    expect((await w.scheduler.getSchedule()).nextCheck).toEqual({ type: 'youtube', subscriptionId: first, title: '合成頻道 first', at: '2026-10-15T05:00:00.000Z' });
    await w.scheduler.updateSchedule({ enabled: false });
    expect(await w.scheduler.getSchedule()).toMatchObject({ status: 'paused', nextCheck: null, lastCheck: { type: 'youtube', subscriptionId: second } });
  });
});

describe('system sleep (#97)', () => {
  it('dispatches nothing from suspend to resume, then checks each due subscription once', async () => {
    const pause = new CollectionPause();
    const w = await world({ enabled: true }, pause);
    const quarter = await w.subscribe('sleep-quarter', { intervalMinutes: 15 });
    const hourly = await w.subscribe('sleep-hourly', { intervalMinutes: 60 });
    await w.start();
    w.runs.mockClear();
    pause.set('sleep', true);
    // Dark wakes run the poll timer while the system sleeps; four periods of the quarter subscription pass.
    for (let step = 0; step < 4; step += 1) {
      w.advance(15 * MINUTE + 7_000);
      await poll(w);
    }
    expect(w.runs).not.toHaveBeenCalled();
    expect(w.events).toEqual(['collection.paused']);
    expect([w.scheduledChecks(quarter), w.scheduledChecks(hourly)]).toEqual([0, 0]);

    pause.set('sleep', false);
    await eventually(() => expect(w.events).toContain('schedule.dispatched'));
    await w.idle();
    expect(w.runs.mock.calls).toEqual([[{ trigger: 'scheduled', subscriptionIds: [quarter, hourly] }]]);
    expect([w.scheduledChecks(quarter), w.scheduledChecks(hourly)]).toEqual([1, 1]);
    expect(await w.channel(quarter)).toMatchObject({ nextCheckAt: '2026-10-15T05:15:00.000Z' });
    await poll(w);
    expect(w.events).toEqual(['collection.paused', 'collection.resumed', 'schedule.dispatched']);
    expect(w.eventRecords.find((event) => event.eventType === 'schedule.dispatched')).toMatchObject({ severity: 'debug' });
    await w.scheduler.close();
  });

  it('records each pause reason that comes into force or lifts, and nothing when it is already so', async () => {
    const pause = new CollectionPause();
    const entries: Array<{ severity: string; eventType: string; pauseReason?: string; message: string }> = [];
    const w = await world({ enabled: true }, pause);
    const scheduler = new CollectionScheduler([w.channels], w.scheduleStore, {
      now: () => w.clock.now, pollIntervalMs: 24 * 60 * MINUTE, pause, recordEvent: (entry) => entries.push(entry),
    });
    await scheduler.start();
    pause.set('sleep', true);
    pause.set('sleep', true);
    pause.set('sleep', false);
    pause.set('sleep', false);
    await scheduler.close();
    pause.set('sleep', true);
    expect(entries.map(({ severity, eventType, pauseReason, message }) => ({ severity, eventType, pauseReason, message }))).toEqual([
      { severity: 'info', eventType: 'collection.paused', pauseReason: 'sleep', message: '系統進入睡眠，暫停收集。' },
      { severity: 'info', eventType: 'collection.resumed', pauseReason: 'sleep', message: '系統已喚醒，恢復收集。' },
    ]);
  });

  it('keeps checking on schedule when the system never suspends', async () => {
    const w = await world({ enabled: true }, new CollectionPause());
    const id = await w.subscribe('awake', { intervalMinutes: 15 });
    await w.start();
    for (let step = 0; step < 3; step += 1) {
      w.advance(15 * MINUTE);
      await poll(w);
    }
    expect(w.scheduledChecks(id)).toBe(3);
    await w.scheduler.close();
  });
});

describe('lost network (#128)', () => {
  /**
   * Two subscriptions, 15 and 60 minutes; the network drops, the 15-minute subscription's scheduled
   * check finds no network and waits in the queue, and four more periods pass offline.
   */
  async function offlineWithStalledCheck() {
    const pause = new CollectionPause();
    const network = { online: true };
    const connectivity = new Connectivity({ pause, probe: async () => network.online });
    const w = await world({ enabled: true }, pause, connectivity);
    const quarter = await w.subscribe('net-quarter', { intervalMinutes: 15 });
    const hourly = await w.subscribe('net-hourly', { intervalMinutes: 60 });
    await w.start();
    w.runs.mockClear();
    w.events.splice(0);

    network.online = false;
    w.source.discoveryFailure = new CollectorError('network_error', '無法連線到 YouTube，請稍後再試。');
    w.advance(15 * MINUTE);
    await w.scheduler.checkNow();
    await eventually(() => expect(pause.has('offline')).toBe(true));
    const [stalled] = w.jobs.list({ limit: 100 }).jobs.filter((job) => job.scope?.trigger === 'scheduled');
    await eventually(() => expect(w.jobs.get(stalled!.id).state).toBe('queued'));
    expect(w.jobs.get(stalled!.id)).not.toHaveProperty('retry');
    expect(w.runs).toHaveBeenCalledTimes(1);

    w.runs.mockClear();
    for (let step = 0; step < 4; step += 1) {
      w.advance(15 * MINUTE);
      await w.scheduler.checkNow();
    }
    expect(w.runs).not.toHaveBeenCalled();
    /** The network comes back; the scheduler's poll and the stalled check both go on. */
    const reconnect = async () => {
      network.online = true;
      w.source.discoveryFailure = null;
      expect(await connectivity.check()).toBe('online');
    };
    return { w, connectivity, quarter, hourly, stalled: stalled!.id, reconnect };
  }

  it('pauses on a check that finds no network, dispatches nothing while offline, then checks each due subscription once', async () => {
    const { w, connectivity, quarter, hourly, stalled, reconnect } = await offlineWithStalledCheck();

    // Four periods passed offline; the poll dispatched nothing and nothing failed.
    expect(w.events).toEqual(['schedule.dispatched', 'collection.paused']);
    expect(w.jobEvents()).not.toContain('job.failed');
    expect(w.jobEvents()).not.toContain('job.retry_scheduled');

    await reconnect();
    await eventually(() => expect(w.events).toEqual(['schedule.dispatched', 'collection.paused', 'collection.resumed', 'schedule.dispatched']));
    await w.idle();
    expect(w.runs.mock.calls).toEqual([[{ trigger: 'scheduled', subscriptionIds: [quarter, hourly] }]]);
    // The stalled check finishes and takes the due check of its subscription; each subscription has one scheduled check.
    expect(w.jobs.get(stalled)).toMatchObject({ state: 'completed' });
    expect([w.scheduledChecks(quarter), w.scheduledChecks(hourly)]).toEqual([1, 1]);
    connectivity.close();
    await w.scheduler.close();
  });

  it('takes the due check from a stalled check that finishes before the poll submits it (#229)', async () => {
    const { w, connectivity, quarter, hourly, stalled, reconnect } = await offlineWithStalledCheck();
    // The poll has read the due subscriptions; it submits them only once the stalled check has finished.
    w.runs.mockImplementationOnce(async (request) => {
      await w.jobs.whenSettled(stalled);
      return SubscriptionService.prototype.startRun.call(w.channels, request);
    });
    await reconnect();
    await eventually(() => expect(w.runs).toHaveBeenCalledTimes(1));
    const submissions = await w.runs.mock.results[0]!.value as JobSubmission[];
    await w.idle();
    expect(w.runs.mock.calls).toEqual([[{ trigger: 'scheduled', subscriptionIds: [quarter, hourly] }]]);
    expect(submissions[0]).toMatchObject({ job: { id: stalled }, deduplicated: true });
    expect([w.scheduledChecks(quarter), w.scheduledChecks(hourly)]).toEqual([1, 1]);
    expect(await w.channel(quarter)).toMatchObject({ nextCheckAt: '2026-10-15T05:30:00.000Z' });
    connectivity.close();
    await w.scheduler.close();
  });
});

describe('concurrent changes of one subscription (A5)', () => {
  it('keeps every concurrent settings change and computes the next check from the newest interval', async () => {
    const w = await world();
    const id = await w.subscribe('busy', { intervalMinutes: 30 });
    const other = await w.subscribe('apply-target', {});
    w.advance(10 * MINUTE);
    await Promise.all([
      w.channels.updateSettings(id, { intervalMinutes: 180 }),
      w.channels.updateSettings(id, { backfillDays: 60 }),
      w.channels.updateSettings(id, { backfillMaxItems: 50 }),
      w.channels.applySettingsToAll(id),
    ]);
    const settings = { intervalMinutes: 180, backfillDays: 60, backfillMaxItems: 50 };
    expect(await w.channel(id)).toMatchObject({ settings });
    // Applying ran after the three changes it was queued behind.
    expect(await w.channel(other)).toMatchObject({ settings });

    // A check dispatched while the interval changes moves the next check by the new interval.
    w.advance(10 * MINUTE);
    await Promise.all([w.channels.startRun({ trigger: 'manual', subscriptionIds: [id] }), w.channels.updateSettings(id, { intervalMinutes: 1440 })]);
    expect(await w.channel(id)).toMatchObject({
      settings: { ...settings, intervalMinutes: 1440 }, lastDispatchedAt: '2026-10-15T04:20:00.000Z', nextCheckAt: '2026-10-16T04:20:00.000Z',
    });
    await w.idle();
  });
});

describe('apply settings to the same type (A5)', () => {
  it('gives every other subscription the settings, keeps paused ones paused and starts nothing', async () => {
    const w = await world();
    const source = await w.subscribe('source', { intervalMinutes: 60, backfillDays: 14, backfillMaxItems: 5 });
    const other = await w.subscribe('other', {});
    const paused = await w.subscribe('resting', {});
    await w.channels.setEnabled(paused, false);
    const jobsBefore = w.jobs.list({ limit: 100 }).jobs.length;
    w.advance(10 * MINUTE);

    expect(await w.channels.applySettingsToAll(source)).toEqual({ updated: 2, paused: 1 });
    const settings = { intervalMinutes: 60, backfillDays: 14, backfillMaxItems: 5 };
    expect(await w.channel(other)).toMatchObject({ settings, enabled: true, nextCheckAt: '2026-10-15T05:00:00.000Z' });
    expect(await w.channel(paused)).toMatchObject({ settings, enabled: false, nextCheckAt: null });
    expect(w.jobs.list({ limit: 100 }).jobs).toHaveLength(jobsBefore);
    expect(w.jobEvents()).toContain('subscription.settings_applied');
    await expect(w.channels.applySettingsToAll('UCmissing')).rejects.toMatchObject({ code: 'subscription_not_found' });
  });
});
