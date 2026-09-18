import {
  CollectorError,
  type ChannelRun,
  type ChannelSchedule,
  type ChannelScheduleLastResult,
} from '../core/types.js';

export interface StoredChannelSchedule {
  enabled: boolean;
  intervalMinutes: number;
  lastAttemptAt: string | null;
  lastCompletedAt: string | null;
  nextRunAt: string | null;
  lastResult: ChannelScheduleLastResult | null;
}

export interface ChannelScheduleStore {
  load(): Promise<StoredChannelSchedule>;
  save(schedule: StoredChannelSchedule): Promise<void>;
}

export interface ScheduledChannelRunner {
  startRun(channelIds?: string[]): Promise<ChannelRun>;
  getRun(id: string): ChannelRun;
  getActiveRun(): ChannelRun | null;
}

export interface ChannelSchedulerOptions {
  now?: () => Date;
  pollIntervalMs?: number;
  runPollIntervalMs?: number;
}

export interface UpdateChannelSchedule {
  enabled: boolean;
  intervalMinutes: number;
}

export class ChannelScheduler {
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private readonly runPollIntervalMs: number;
  private schedule: StoredChannelSchedule | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking: Promise<void> | null = null;
  private suspended = false;
  private scheduledRunId: string | null = null;

  constructor(
    private readonly runner: ScheduledChannelRunner,
    private readonly store: ChannelScheduleStore,
    options: ChannelSchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.runPollIntervalMs = options.runPollIntervalMs ?? 500;
  }

  async start(): Promise<void> {
    await this.ensureLoaded();
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.checkNow().catch(reportScheduleError);
      }, this.pollIntervalMs);
    }
    void this.checkNow().catch(reportScheduleError);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async getSchedule(): Promise<ChannelSchedule> {
    const schedule = await this.ensureLoaded();
    return this.snapshot(schedule);
  }

  async updateSchedule(input: UpdateChannelSchedule): Promise<ChannelSchedule> {
    if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1 || input.intervalMinutes > 10_080) {
      throw new CollectorError('invalid_request', '抓取週期必須是 1 到 10080 分鐘的整數。');
    }
    const current = await this.ensureLoaded();
    const changed = current.enabled !== input.enabled
      || current.intervalMinutes !== input.intervalMinutes;
    current.enabled = input.enabled;
    current.intervalMinutes = input.intervalMinutes;
    if (!input.enabled) {
      current.nextRunAt = null;
    } else if (changed || !current.nextRunAt) {
      current.nextRunAt = addMinutes(this.now(), input.intervalMinutes).toISOString();
    }
    await this.store.save(current);
    return this.snapshot(current);
  }

  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
  }

  isBusy(): boolean {
    return this.checking !== null;
  }

  checkNow(): Promise<void> {
    if (this.suspended) return Promise.resolve();
    if (this.checking) return this.checking;
    const operation = this.runDueSchedule();
    this.checking = operation;
    const clearChecking = () => {
      if (this.checking === operation) this.checking = null;
    };
    void operation.then(clearChecking, clearChecking);
    return operation;
  }

  private async runDueSchedule(): Promise<void> {
    const schedule = await this.ensureLoaded();
    if (!schedule.enabled || !schedule.nextRunAt) return;
    if (new Date(schedule.nextRunAt).getTime() > this.now().getTime()) return;
    if (this.runner.getActiveRun()) return;

    schedule.lastAttemptAt = this.now().toISOString();
    await this.store.save(schedule);

    try {
      let run = await this.runner.startRun();
      this.scheduledRunId = run.id;
      while (run.status !== 'completed') {
        await delay(this.runPollIntervalMs);
        run = this.runner.getRun(run.id);
      }
      schedule.lastResult = {
        runId: run.id,
        created: run.created,
        existing: run.existing,
        failed: run.failed,
      };
    } catch (error) {
      schedule.lastResult = {
        runId: null,
        created: 0,
        existing: 0,
        failed: 1,
        error: error instanceof Error ? error.message : '排程抓取失敗。',
      };
    } finally {
      this.scheduledRunId = null;
      const completedAt = this.now();
      schedule.lastCompletedAt = completedAt.toISOString();
      schedule.nextRunAt = schedule.enabled
        ? addMinutes(completedAt, schedule.intervalMinutes).toISOString()
        : null;
      await this.store.save(schedule);
    }
  }

  private async ensureLoaded(): Promise<StoredChannelSchedule> {
    this.schedule ??= await this.store.load();
    return this.schedule;
  }

  private snapshot(schedule: StoredChannelSchedule): ChannelSchedule {
    let status: ChannelSchedule['status'];
    if (!schedule.enabled) {
      status = 'paused';
    } else if (this.scheduledRunId) {
      status = 'running';
    } else if (
      schedule.nextRunAt
      && new Date(schedule.nextRunAt).getTime() <= this.now().getTime()
      && this.runner.getActiveRun()
    ) {
      status = 'waiting_for_run';
    } else {
      status = 'scheduled';
    }
    return {
      ...schedule,
      status,
      nextRunAt: status === 'scheduled' ? schedule.nextRunAt : null,
      lastResult: schedule.lastResult ? { ...schedule.lastResult } : null,
    };
  }
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function reportScheduleError(error: unknown): void {
  console.error('Scheduled channel check failed', error);
}
