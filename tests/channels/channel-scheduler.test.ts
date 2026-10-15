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

  triggers: string[] = [];

  async startRun(request: { trigger: string }): Promise<JobSubmission[]> {
    this.starts += 1;
    this.triggers.push(request.trigger);
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
    backfillWindow: '1m',
    backfillMaxItems: 10,
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
      backfillWindow: '1m',
      backfillMaxItems: 10,
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
    await scheduler.updateSchedule({ enabled: true, intervalMinutes: 15 });
    now = new Date('2026-09-17T00:15:00.000Z');

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
    expect(await scheduler.updateSchedule({ enabled: true, intervalMinutes: 15 })).toMatchObject({
      status: 'scheduled',
      nextRunAt: '2026-09-17T00:15:00.000Z',
    });

    now = new Date('2026-09-17T00:15:00.000Z');
    await scheduler.checkNow();
    expect(await scheduler.getSchedule()).toMatchObject({
      status: 'scheduled',
      lastResult: { runId: null, failed: 1, error: '沒有可執行的 YouTube 頻道。' },
      nextRunAt: '2026-09-17T00:30:00.000Z',
    });

    runner.failure = null;
    now = new Date('2026-09-17T00:30:00.000Z');
    await scheduler.checkNow();
    expect(runner.starts).toBe(2);

    expect(await scheduler.updateSchedule({ enabled: false })).toMatchObject({
      status: 'paused',
      nextRunAt: null,
    });
    expect(store.saves.at(-1)).toMatchObject({ enabled: false, nextRunAt: null });
    await scheduler.close();
  });
});

describe('ChannelScheduler Global settings', () => {
  it('schedules the first check one interval after starting when enabled without a due time', async () => {
    const store = new MemoryScheduleStore(schedule({ intervalMinutes: 30, nextRunAt: null }));
    const scheduler = new ChannelScheduler(new ControlledRunner(), store, { now: () => new Date('2026-09-17T00:00:00.000Z'), pollIntervalMs: 60_000 });
    await scheduler.start();
    expect((await scheduler.getSchedule()).nextRunAt).toBe('2026-09-17T00:30:00.000Z');
    expect(store.saves.at(-1)).toMatchObject({ nextRunAt: '2026-09-17T00:30:00.000Z' });
    await scheduler.close();
  });

  it('applies partial updates, validates offered values and records an event', async () => {
    const now = new Date('2026-09-17T00:00:00.000Z');
    const store = new MemoryScheduleStore(schedule({ intervalMinutes: 30, nextRunAt: '2026-09-17T00:30:00.000Z' }));
    const events: string[] = [];
    const scheduler = new ChannelScheduler(new ControlledRunner(), store, {
      now: () => now, pollIntervalMs: 60_000, recordEvent: (entry) => events.push(entry.eventType),
    });

    expect(await scheduler.updateSchedule({ backfillWindow: '1w' })).toMatchObject({
      enabled: true, intervalMinutes: 30, backfillWindow: '1w', backfillMaxItems: 10, nextRunAt: '2026-09-17T00:30:00.000Z',
    });
    expect(await scheduler.updateSchedule({ backfillMaxItems: 5 })).toMatchObject({ backfillWindow: '1w', backfillMaxItems: 5 });
    for (const invalid of [{ intervalMinutes: 45 }, { intervalMinutes: 1 }, { backfillWindow: '2m' }, { backfillMaxItems: 7 }, { enabled: 'yes' }]) {
      await expect(scheduler.updateSchedule(invalid as never)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(store.saves).toHaveLength(2);
    expect(events).toEqual(['schedule.updated', 'schedule.updated']);
  });

  it('counts a new interval from the last dispatch and is due at once when that time has passed', async () => {
    let now = new Date('2026-09-17T01:00:00.000Z');
    const store = new MemoryScheduleStore(schedule({
      intervalMinutes: 180, lastAttemptAt: '2026-09-17T00:40:00.000Z', nextRunAt: '2026-09-17T03:40:00.000Z',
    }));
    const runner = new ControlledRunner();
    const scheduler = new ChannelScheduler(runner, store, { now: () => now, pollIntervalMs: 60_000 });

    expect((await scheduler.updateSchedule({ intervalMinutes: 60 })).nextRunAt).toBe('2026-09-17T01:40:00.000Z');
    expect((await scheduler.updateSchedule({ intervalMinutes: 15 })).nextRunAt).toBe('2026-09-17T01:00:00.000Z');
    // Changing only the backfill range moves nothing and dispatches nothing.
    now = new Date('2026-09-17T00:59:00.000Z');
    expect((await scheduler.updateSchedule({ backfillWindow: '6m' })).nextRunAt).toBe('2026-09-17T01:00:00.000Z');
    expect(runner.starts).toBe(0);
  });

  it('checks now on request even when automatic collection is off, and moves the next automatic check', async () => {
    let now = new Date('2026-09-17T00:10:00.000Z');
    const store = new MemoryScheduleStore(schedule({ intervalMinutes: 30, nextRunAt: '2026-09-17T00:30:00.000Z' }));
    const runner = new ControlledRunner();
    const scheduler = new ChannelScheduler(runner, store, { now: () => now, pollIntervalMs: 60_000 });

    const submissions = await scheduler.runNow();
    expect(submissions).toHaveLength(1);
    expect(runner.triggers).toEqual(['manual']);
    expect(await scheduler.getSchedule()).toMatchObject({
      status: 'running', lastAttemptAt: '2026-09-17T00:10:00.000Z', nextRunAt: '2026-09-17T00:40:00.000Z',
    });

    await scheduler.updateSchedule({ enabled: false });
    now = new Date('2026-09-17T00:20:00.000Z');
    await scheduler.runNow();
    expect(runner.triggers).toEqual(['manual', 'manual']);
    expect(await scheduler.getSchedule()).toMatchObject({ enabled: false, lastAttemptAt: '2026-09-17T00:20:00.000Z', nextRunAt: null });

    runner.failure = new Error('沒有可檢查的訂閱。');
    await expect(scheduler.runNow()).rejects.toThrow('沒有可檢查的訂閱。');
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
