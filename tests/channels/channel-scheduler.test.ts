import { describe, expect, it, vi } from 'vitest';
import {
  ChannelScheduler,
  type ChannelScheduleStore,
  type ScheduledChannelRunner,
  type StoredChannelSchedule,
} from '../../src/channels/channel-scheduler.js';
import type { CollectionJob, JobProgress, JobSubmission } from '../../src/core/types.js';

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

/** Channel jobs that stay unfinished until the test settles them. */
class ControlledRunner implements ScheduledChannelRunner {
  starts = 0;
  failure: Error | null = null;
  private readonly waiting = new Map<string, (job: CollectionJob) => void>();

  async startRun(): Promise<JobSubmission[]> {
    this.starts += 1;
    if (this.failure) throw this.failure;
    return [{ job: job(`dispatch-${this.starts}`), deduplicated: false }];
  }

  whenSettled(id: string): Promise<CollectionJob> {
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }

  settle(id: string, progress: Partial<JobProgress>): void {
    this.waiting.get(id)!({ ...job(id), state: 'completed', progress: { total: 0, done: 0, created: 0, existing: 0, failed: 0, ...progress } });
    this.waiting.delete(id);
  }
}

function schedule(overrides: Partial<StoredChannelSchedule> = {}): StoredChannelSchedule {
  return {
    enabled: true,
    intervalMinutes: 5,
    lastAttemptAt: null,
    lastCompletedAt: null,
    nextRunAt: '2026-09-17T00:20:00.000Z',
    lastResult: null,
    ...overrides,
  };
}

describe('ChannelScheduler', () => {
  it('dispatches due channels and returns before their jobs finish', async () => {
    let now = new Date('2026-09-17T00:30:00.000Z');
    const store = new MemoryScheduleStore(schedule({
      lastAttemptAt: '2026-09-16T23:00:00.000Z',
      lastCompletedAt: '2026-09-16T23:01:00.000Z',
      nextRunAt: '2026-09-16T23:05:00.000Z',
    }));
    const runner = new ControlledRunner();
    const scheduler = new ChannelScheduler(runner, store, { now: () => now, pollIntervalMs: 60_000 });

    await scheduler.start();
    await scheduler.checkNow();
    // Missed periods coalesce into one dispatch, and the check is over while the job still runs.
    expect(runner.starts).toBe(1);
    expect(scheduler.isBusy()).toBe(false);
    expect(await scheduler.getSchedule()).toMatchObject({
      status: 'running',
      lastAttemptAt: '2026-09-17T00:30:00.000Z',
      lastCompletedAt: '2026-09-16T23:01:00.000Z',
      nextRunAt: '2026-09-17T00:35:00.000Z',
    });

    now = new Date('2026-09-17T00:32:00.000Z');
    runner.settle('dispatch-1', { created: 2, existing: 1, failed: 1 });
    await vi.waitFor(async () => expect(await scheduler.getSchedule()).toEqual({
      enabled: true,
      intervalMinutes: 5,
      status: 'scheduled',
      lastAttemptAt: '2026-09-17T00:30:00.000Z',
      lastCompletedAt: '2026-09-17T00:32:00.000Z',
      nextRunAt: '2026-09-17T00:35:00.000Z',
      lastResult: { runId: null, created: 2, existing: 1, failed: 1 },
    }));
    await scheduler.close();
  });

  it('keeps checking at the next due time while earlier jobs are still running', async () => {
    let now = new Date('2026-09-17T00:30:00.000Z');
    const runner = new ControlledRunner();
    const scheduler = new ChannelScheduler(runner, new MemoryScheduleStore(schedule()), { now: () => now, pollIntervalMs: 60_000 });

    await scheduler.start();
    await scheduler.checkNow();
    now = new Date('2026-09-17T00:35:00.000Z');
    await scheduler.checkNow();
    expect(runner.starts).toBe(2);

    // Only the latest dispatch records its result.
    runner.settle('dispatch-1', { created: 5 });
    runner.settle('dispatch-2', { existing: 3 });
    await vi.waitFor(async () => expect((await scheduler.getSchedule()).lastResult).toMatchObject({ created: 0, existing: 3 }));
    await scheduler.close();
  });

  it('automatically dispatches when an enabled schedule becomes due', async () => {
    let now = new Date('2026-09-17T00:00:00.000Z');
    const runner = new ControlledRunner();
    const scheduler = new ChannelScheduler(runner, new MemoryScheduleStore(schedule({ enabled: false, intervalMinutes: 60, nextRunAt: null })), {
      now: () => now,
      pollIntervalMs: 5,
    });

    await scheduler.start();
    await scheduler.updateSchedule({ enabled: true, intervalMinutes: 1 });
    now = new Date('2026-09-17T00:01:00.000Z');

    await vi.waitFor(() => expect(runner.starts).toBe(1), { timeout: 200 });
    await scheduler.close();
  });

  it('records a failed dispatch, retries next period and persists a paused schedule', async () => {
    let now = new Date('2026-09-17T00:00:00.000Z');
    const store = new MemoryScheduleStore(schedule({ enabled: false, intervalMinutes: 60, nextRunAt: null }));
    const runner = new ControlledRunner();
    runner.failure = new Error('沒有可執行的 YouTube 頻道。');
    const scheduler = new ChannelScheduler(runner, store, { now: () => now, pollIntervalMs: 60_000 });

    await scheduler.start();
    expect(await scheduler.updateSchedule({ enabled: true, intervalMinutes: 5 })).toMatchObject({
      status: 'scheduled',
      nextRunAt: '2026-09-17T00:05:00.000Z',
    });

    now = new Date('2026-09-17T00:05:00.000Z');
    await scheduler.checkNow();
    expect(await scheduler.getSchedule()).toMatchObject({
      status: 'scheduled',
      lastResult: { runId: null, failed: 1, error: '沒有可執行的 YouTube 頻道。' },
      nextRunAt: '2026-09-17T00:10:00.000Z',
    });

    runner.failure = null;
    now = new Date('2026-09-17T00:10:00.000Z');
    await scheduler.checkNow();
    expect(runner.starts).toBe(2);

    expect(await scheduler.updateSchedule({ enabled: false, intervalMinutes: 5 })).toMatchObject({
      status: 'paused',
      nextRunAt: null,
    });
    expect(store.saves.at(-1)).toMatchObject({ enabled: false, nextRunAt: null });
    await scheduler.close();
  });
});

function job(id: string): CollectionJob {
  return {
    id, kind: 'youtube.channel', state: 'running', phase: 'capture', vaultPath: '/vault', parentId: null,
    source: { type: 'youtube', id: 'UC1', url: 'https://www.youtube.com/channel/UC1/videos', title: '頻道' },
    createdAt: '2026-09-17T00:00:00.000Z', startedAt: null, finishedAt: null, updatedAt: '2026-09-17T00:00:00.000Z',
    progress: null, items: null, result: null, error: null,
  };
}
