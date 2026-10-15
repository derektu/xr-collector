import {
  CollectorError,
  type ChannelSchedule,
  type ChannelScheduleLastResult,
  type CollectionJob,
  type JobSubmission,
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
  startRun(channelIds?: string[]): Promise<JobSubmission[]>;
  whenSettled(jobId: string): Promise<CollectionJob>;
}

export interface ChannelSchedulerOptions {
  now?: () => Date;
  pollIntervalMs?: number;
}

export interface UpdateChannelSchedule {
  enabled: boolean;
  intervalMinutes: number;
}

export class ChannelScheduler {
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private schedule: StoredChannelSchedule | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking: Promise<void> | null = null;
  private suspended = false;
  private closed = false;
  /** Increments per dispatch; only the latest dispatch records its result. */
  private dispatch = 0;
  private pendingDispatch: number | null = null;

  constructor(
    private readonly runner: ScheduledChannelRunner,
    private readonly store: ChannelScheduleStore,
    options: ChannelSchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
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
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.checking;
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

  /**
   * Submits one job per enabled channel when the schedule is due, then returns without waiting for
   * them. The next due time counts from the dispatch; the result is recorded when the jobs settle.
   */
  private async runDueSchedule(): Promise<void> {
    const schedule = await this.ensureLoaded();
    if (!schedule.enabled || !schedule.nextRunAt) return;
    if (new Date(schedule.nextRunAt).getTime() > this.now().getTime()) return;

    const dispatchedAt = this.now();
    schedule.lastAttemptAt = dispatchedAt.toISOString();
    schedule.nextRunAt = addMinutes(dispatchedAt, schedule.intervalMinutes).toISOString();
    const dispatch = ++this.dispatch;
    let submissions: JobSubmission[];
    try {
      submissions = await this.runner.startRun();
    } catch (error) {
      this.pendingDispatch = null;
      schedule.lastCompletedAt = this.now().toISOString();
      schedule.lastResult = {
        runId: null,
        created: 0,
        existing: 0,
        failed: 1,
        error: error instanceof Error ? error.message : '排程抓取失敗。',
      };
      await this.store.save(schedule);
      return;
    }
    this.pendingDispatch = dispatch;
    await this.store.save(schedule);
    void Promise.all(submissions.map(({ job }) => this.runner.whenSettled(job.id)))
      .then((jobs) => this.recordResult(dispatch, jobs))
      .catch(reportScheduleError);
  }

  private async recordResult(dispatch: number, jobs: CollectionJob[]): Promise<void> {
    if (this.closed || dispatch !== this.pendingDispatch) return;
    this.pendingDispatch = null;
    const schedule = await this.ensureLoaded();
    const result: ChannelScheduleLastResult = { runId: null, created: 0, existing: 0, failed: 0 };
    for (const job of jobs) {
      if (job.progress) {
        result.created += job.progress.created;
        result.existing += job.progress.existing;
        result.failed += job.progress.failed;
      } else if (job.state !== 'completed') {
        result.failed += 1;
      }
    }
    schedule.lastCompletedAt = this.now().toISOString();
    schedule.lastResult = result;
    await this.store.save(schedule);
  }

  private async ensureLoaded(): Promise<StoredChannelSchedule> {
    this.schedule ??= await this.store.load();
    return this.schedule;
  }

  private snapshot(schedule: StoredChannelSchedule): ChannelSchedule {
    let status: ChannelSchedule['status'];
    if (!schedule.enabled) {
      status = 'paused';
    } else if (this.pendingDispatch !== null) {
      status = 'running';
    } else {
      status = 'scheduled';
    }
    return {
      ...schedule,
      status,
      nextRunAt: schedule.enabled ? schedule.nextRunAt : null,
      lastResult: schedule.lastResult ? { ...schedule.lastResult } : null,
    };
  }
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function reportScheduleError(error: unknown): void {
  console.error('Scheduled channel check failed', error);
}
