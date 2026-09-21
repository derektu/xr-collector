import { describe, expect, it, vi } from 'vitest';
import {
  ChannelScheduler,
  type ChannelScheduleStore,
  type StoredChannelSchedule,
} from '../../src/channels/channel-scheduler.js';
import type { ChannelRun } from '../../src/core/types.js';

class MemoryScheduleStore implements ChannelScheduleStore {
  saves: StoredChannelSchedule[] = [];

  constructor(private value: StoredChannelSchedule) {}

  async load(): Promise<StoredChannelSchedule> {
    return structuredClone(this.value);
  }

  async save(value: StoredChannelSchedule): Promise<void> {
    this.value = structuredClone(value);
    this.saves.push(structuredClone(value));
  }
}

describe('ChannelScheduler', () => {
  it('does not expose the expired due time as the next run while collection is running', async () => {
    let now = new Date('2026-09-17T00:30:00.000Z');
    const store = new MemoryScheduleStore({
      enabled: true,
      intervalMinutes: 5,
      lastAttemptAt: null,
      lastCompletedAt: null,
      nextRunAt: '2026-09-17T00:20:00.000Z',
      lastResult: null,
    });
    let currentRun = run({
      id: 'running-schedule',
      status: 'running',
      completedAt: null,
    });
    const scheduler = new ChannelScheduler({
      startRun: async () => currentRun,
      getRun: () => currentRun,
      getActiveRun: () => null,
    }, store, {
      now: () => now,
      pollIntervalMs: 60_000,
      runPollIntervalMs: 1,
    });

    await scheduler.start();
    await vi.waitFor(async () => {
      expect((await scheduler.getSchedule()).status).toBe('running');
    }, { timeout: 200 });

    expect(await scheduler.getSchedule()).toMatchObject({
      status: 'running',
      lastAttemptAt: '2026-09-17T00:30:00.000Z',
      lastCompletedAt: null,
      nextRunAt: null,
    });

    now = new Date('2026-09-17T00:31:00.000Z');
    currentRun = run({ id: 'running-schedule' });
    await scheduler.checkNow();
    await scheduler.close();
  });

  it('automatically starts a run when an enabled schedule becomes due', async () => {
    let now = new Date('2026-09-17T00:00:00.000Z');
    const store = new MemoryScheduleStore({
      enabled: false,
      intervalMinutes: 60,
      lastAttemptAt: null,
      lastCompletedAt: null,
      nextRunAt: null,
      lastResult: null,
    });
    let starts = 0;
    const completedRun = run({ id: 'timer-run', completedAt: '2026-09-17T00:01:10.000Z' });
    const scheduler = new ChannelScheduler({
      startRun: async () => {
        starts += 1;
        now = new Date('2026-09-17T00:01:10.000Z');
        return completedRun;
      },
      getRun: () => completedRun,
      getActiveRun: () => null,
    }, store, {
      now: () => now,
      pollIntervalMs: 5,
      runPollIntervalMs: 1,
    });

    await scheduler.start();
    await scheduler.updateSchedule({ enabled: true, intervalMinutes: 1 });
    now = new Date('2026-09-17T00:01:00.000Z');

    await vi.waitFor(() => expect(starts).toBe(1), { timeout: 200 });
    await scheduler.close();
  });

  it('coalesces missed periods into one run and schedules from actual completion', async () => {
    let now = new Date('2026-09-17T00:30:00.000Z');
    const store = new MemoryScheduleStore({
      enabled: true,
      intervalMinutes: 5,
      lastAttemptAt: '2026-09-16T23:00:00.000Z',
      lastCompletedAt: '2026-09-16T23:01:00.000Z',
      nextRunAt: '2026-09-16T23:05:00.000Z',
      lastResult: null,
    });
    const completedRun = run({
      id: 'scheduled-run',
      created: 2,
      existing: 1,
      failed: 1,
      completedAt: '2026-09-17T00:31:00.000Z',
    });
    let starts = 0;
    const scheduler = new ChannelScheduler({
      startRun: async () => {
        starts += 1;
        now = new Date('2026-09-17T00:31:00.000Z');
        return completedRun;
      },
      getRun: () => completedRun,
      getActiveRun: () => null,
    }, store, {
      now: () => now,
      pollIntervalMs: 60_000,
      runPollIntervalMs: 1,
    });

    await scheduler.start();
    await scheduler.checkNow();

    expect(starts).toBe(1);
    expect(await scheduler.getSchedule()).toEqual({
      enabled: true,
      intervalMinutes: 5,
      status: 'scheduled',
      lastAttemptAt: '2026-09-17T00:30:00.000Z',
      lastCompletedAt: '2026-09-17T00:31:00.000Z',
      nextRunAt: '2026-09-17T00:36:00.000Z',
      lastResult: {
        runId: 'scheduled-run',
        created: 2,
        existing: 1,
        failed: 1,
      },
    });
    await scheduler.close();
  });

  it('waits for a manual run instead of starting an overlapping scheduled run', async () => {
    const now = new Date('2026-09-17T00:30:00.000Z');
    const store = new MemoryScheduleStore({
      enabled: true,
      intervalMinutes: 5,
      lastAttemptAt: null,
      lastCompletedAt: null,
      nextRunAt: '2026-09-17T00:20:00.000Z',
      lastResult: null,
    });
    let active: ChannelRun | null = run({
      id: 'manual-run',
      status: 'running',
      completedAt: null,
    });
    let starts = 0;
    const scheduledRun = run({ id: 'scheduled-after-manual' });
    const scheduler = new ChannelScheduler({
      startRun: async () => {
        starts += 1;
        return scheduledRun;
      },
      getRun: () => scheduledRun,
      getActiveRun: () => active,
    }, store, { now: () => now, pollIntervalMs: 60_000 });

    await scheduler.start();
    await scheduler.checkNow();
    expect(starts).toBe(0);
    expect(await scheduler.getSchedule()).toMatchObject({ status: 'waiting_for_run' });

    active = null;
    await scheduler.checkNow();
    expect(starts).toBe(1);
    await scheduler.close();
  });

  it('retries failures at the next period and persists a paused schedule', async () => {
    let now = new Date('2026-09-17T00:00:00.000Z');
    const store = new MemoryScheduleStore({
      enabled: false,
      intervalMinutes: 60,
      lastAttemptAt: null,
      lastCompletedAt: null,
      nextRunAt: null,
      lastResult: null,
    });
    const runs = [
      run({ id: 'offline-run', failed: 2, completedAt: '2026-09-17T00:05:30.000Z' }),
      run({ id: 'retry-run', created: 2, completedAt: '2026-09-17T00:11:00.000Z' }),
    ];
    let starts = 0;
    const scheduler = new ChannelScheduler({
      startRun: async () => {
        const next = runs[starts];
        if (!next) throw new Error('unexpected run');
        starts += 1;
        now = new Date(next.completedAt!);
        return next;
      },
      getRun: (id) => runs.find((candidate) => candidate.id === id)!,
      getActiveRun: () => null,
    }, store, {
      now: () => now,
      pollIntervalMs: 60_000,
      runPollIntervalMs: 1,
    });

    await scheduler.start();
    expect(await scheduler.updateSchedule({ enabled: true, intervalMinutes: 5 })).toMatchObject({
      status: 'scheduled',
      nextRunAt: '2026-09-17T00:05:00.000Z',
    });

    now = new Date('2026-09-17T00:05:00.000Z');
    await scheduler.checkNow();
    expect(await scheduler.getSchedule()).toMatchObject({
      lastResult: { runId: 'offline-run', failed: 2 },
      nextRunAt: '2026-09-17T00:10:30.000Z',
    });

    now = new Date('2026-09-17T00:10:30.000Z');
    await scheduler.checkNow();
    expect(starts).toBe(2);
    expect(await scheduler.getSchedule()).toMatchObject({
      lastResult: { runId: 'retry-run', created: 2, failed: 0 },
    });

    expect(await scheduler.updateSchedule({ enabled: false, intervalMinutes: 5 })).toMatchObject({
      status: 'paused',
      nextRunAt: null,
    });
    await scheduler.close();
  });
});

function run(overrides: Partial<ChannelRun> = {}): ChannelRun {
  return {
    id: 'run-1',
    status: 'completed',
    channelIds: ['one'],
    currentChannelId: null,
    totalVideos: 0,
    processedVideos: 0,
    created: 0,
    existing: 0,
    failed: 0,
    results: [],
    startedAt: '2026-09-17T00:30:00.000Z',
    completedAt: '2026-09-17T00:31:00.000Z',
    ...overrides,
  };
}
