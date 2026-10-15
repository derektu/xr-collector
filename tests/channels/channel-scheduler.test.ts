import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelCollector } from '../../src/channels/channel-collector.js';
import { ChannelScheduler, type ChannelScheduleStore, type StoredChannelSchedule } from '../../src/channels/channel-scheduler.js';
import { JsonChannelStore } from '../../src/channels/json-channel-store.js';
import { Collector } from '../../src/core/collector.js';
import type { CollectionPolicy } from '../../src/core/types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { MemoryDocuments, SyntheticYouTube } from './synthetic-youtube.js';

const MINUTE = 60_000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryScheduleStore implements ChannelScheduleStore {
  saves: StoredChannelSchedule[] = [];
  constructor(private value: StoredChannelSchedule = { enabled: true }) {}
  async load(): Promise<StoredChannelSchedule> { return structuredClone(this.value); }
  async save(value: StoredChannelSchedule): Promise<void> {
    this.value = structuredClone(value);
    this.saves.push(structuredClone(value));
  }
}

/**
 * Subscriptions over synthetic channels with a controllable clock, and a scheduler whose polls the
 * test runs by hand.
 */
async function world(schedule: StoredChannelSchedule = { enabled: true }) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-scheduler-'));
  roots.push(root);
  const clock = { now: new Date('2026-10-15T04:00:00.000Z') };
  const now = () => clock.now;
  const source = new SyntheticYouTube();
  const documents = new MemoryDocuments(now);
  const channelStore = new JsonChannelStore(root);
  const collector = new Collector(documents);
  const jobs = new JobManager({
    vaultPath: root, store: JobStore.memory(now), source, documents: collector, channels: channelStore, now,
    limits: { discovery: 2, capture: 4 }, retry: { maxAttempts: 1 },
  });
  const scheduleStore = new MemoryScheduleStore(schedule);
  const events: string[] = [];
  let scheduler!: ChannelScheduler;
  const channels = new ChannelCollector(channelStore, jobs, {
    autoCollection: () => scheduler.isEnabled(), resolveChannel: (url) => source.resolveChannel(url), documents: () => collector.list(), now,
  });
  scheduler = new ChannelScheduler(channels, scheduleStore, { now, pollIntervalMs: 24 * 60 * MINUTE, recordEvent: (entry) => events.push(entry.eventType) });
  const runs = vi.spyOn(channels, 'startRun');
  const jobEvents = vi.spyOn(jobs, 'recordEvent');
  return {
    root, clock, source, jobs, channels, channelStore, scheduler, scheduleStore, events, runs,
    jobEvents: () => jobEvents.mock.calls.map(([entry]) => entry.eventType),
    advance(ms: number) { clock.now = new Date(clock.now.getTime() + ms); },
    async idle() { await vi.waitFor(() => expect(jobs.isBusy()).toBe(false)); },
    async subscribe(name: string, settings: Partial<CollectionPolicy>): Promise<string> {
      const id = source.addChannel(name);
      source.publish(id, name.slice(0, 1), clock.now, [1]);
      const added = await jobs.whenSettled((await channels.addChannel(`@${name}`, settings)).job.id);
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
    await w.scheduler.start();
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
    await w.scheduler.start();
    w.runs.mockClear();
    w.advance(60 * MINUTE);
    await poll(w);
    expect(w.runs.mock.calls).toEqual([[{ trigger: 'scheduled', channelIds: [quarter, hourly] }]]);
    expect([w.scheduledChecks(quarter), w.scheduledChecks(hourly)]).toEqual([1, 1]);
    expect(await w.channel(quarter)).toMatchObject({ lastDispatchedAt: '2026-10-15T05:00:00.000Z', nextCheckAt: '2026-10-15T05:15:00.000Z' });
    expect(await w.channel(hourly)).toMatchObject({ lastDispatchedAt: '2026-10-15T05:00:00.000Z', nextCheckAt: '2026-10-15T06:00:00.000Z' });
    await w.scheduler.close();
  });

  it('joins a job still running and moves the next check without a second job', async () => {
    const w = await world();
    const id = await w.subscribe('slow', { intervalMinutes: 15 });
    await w.scheduler.start();
    w.source.holdCaptures = true;
    const [video] = w.source.publish(id, 'n', w.clock.now, [0.001], 5);
    w.advance(15 * MINUTE);
    await w.scheduler.checkNow();
    await vi.waitFor(() => expect(w.source.running()).toEqual([video]));
    w.advance(15 * MINUTE);
    await w.scheduler.checkNow();
    expect(w.scheduledChecks(id)).toBe(1);
    expect(await w.channel(id)).toMatchObject({ nextCheckAt: '2026-10-15T04:45:00.000Z' });
    w.source.holdCaptures = false;
    w.source.release(video!);
    await w.idle();
    await w.scheduler.close();
  });

  it('never checks a paused subscription, and checks nothing while automatic collection is off', async () => {
    const w = await world();
    const active = await w.subscribe('active', { intervalMinutes: 15 });
    const paused = await w.subscribe('paused', { intervalMinutes: 15 });
    await w.channels.setChannelEnabled(paused, false);
    expect(await w.channel(paused)).toMatchObject({ nextCheckAt: null });
    await w.scheduler.start();
    w.advance(15 * MINUTE);
    await poll(w);
    expect([w.scheduledChecks(active), w.scheduledChecks(paused)]).toEqual([1, 0]);

    expect(await w.scheduler.updateSchedule({ enabled: false })).toMatchObject({ enabled: false, status: 'paused', nextCheck: null });
    w.advance(120 * MINUTE);
    await poll(w);
    expect(w.scheduledChecks(active)).toBe(1);

    // Turning it on counts every enabled subscription's next check from now.
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

  it('counts a new interval from the last check and is due at once when that time has passed', async () => {
    const w = await world();
    const id = await w.subscribe('interval', { intervalMinutes: 180 });
    w.advance(40 * MINUTE);
    expect(await w.channels.updateSettings(id, { intervalMinutes: 60 })).toMatchObject({ nextCheckAt: '2026-10-15T05:00:00.000Z' });
    w.advance(30 * MINUTE);
    expect(await w.channels.updateSettings(id, { intervalMinutes: 15 })).toMatchObject({ nextCheckAt: '2026-10-15T05:10:00.000Z' });
    // Backfill settings move nothing and start nothing.
    expect(await w.channels.updateSettings(id, { backfillWindow: '6m' })).toMatchObject({ nextCheckAt: '2026-10-15T05:10:00.000Z' });
    expect(w.jobs.list({ limit: 100 }).jobs).toHaveLength(2);
    await expect(w.channels.updateSettings(id, { backfillMaxItems: 7 })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(w.jobEvents().filter((event) => event === 'subscription.settings_updated')).toHaveLength(3);
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
    await w.scheduler.start();
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
      lastCheck: { channelId: second, title: '合成頻道 second', at: '2026-10-15T04:05:00.000Z' },
      nextCheck: { channelId: second, title: '合成頻道 second', at: '2026-10-15T04:20:00.000Z' },
    });
    await w.channels.setChannelEnabled(second, false);
    expect((await w.scheduler.getSchedule()).nextCheck).toEqual({ channelId: first, title: '合成頻道 first', at: '2026-10-15T05:00:00.000Z' });
    await w.scheduler.updateSchedule({ enabled: false });
    expect(await w.scheduler.getSchedule()).toMatchObject({ status: 'paused', nextCheck: null, lastCheck: { channelId: second } });
  });
});

describe('apply settings to the same type (A5)', () => {
  it('gives every other subscription the settings, keeps paused ones paused and starts nothing', async () => {
    const w = await world();
    const source = await w.subscribe('source', { intervalMinutes: 60, backfillWindow: '2w', backfillMaxItems: 5 });
    const other = await w.subscribe('other', {});
    const paused = await w.subscribe('resting', {});
    await w.channels.setChannelEnabled(paused, false);
    const jobsBefore = w.jobs.list({ limit: 100 }).jobs.length;
    w.advance(10 * MINUTE);

    expect(await w.channels.applySettingsToAll(source)).toEqual({ updated: 2, paused: 1 });
    const settings = { intervalMinutes: 60, backfillWindow: '2w', backfillMaxItems: 5 };
    expect(await w.channel(other)).toMatchObject({ settings, enabled: true, nextCheckAt: '2026-10-15T05:00:00.000Z' });
    expect(await w.channel(paused)).toMatchObject({ settings, enabled: false, nextCheckAt: null });
    expect(w.jobs.list({ limit: 100 }).jobs).toHaveLength(jobsBefore);
    expect(w.jobEvents()).toContain('subscription.settings_applied');
    await expect(w.channels.applySettingsToAll('UCmissing')).rejects.toMatchObject({ code: 'channel_not_found' });
  });
});
