import { assertPolicyPatch } from './collection-policy.js';
import type { SchedulePolicy, StartRunRequest } from './channel-collector.js';
import type { NewJobEvent } from '../jobs/job-store.js';
import {
  CollectorError,
  type BackfillWindow,
  type ChannelSchedule,
  type ChannelScheduleLastResult,
  type CollectionJob,
  type JobSubmission,
} from '../core/types.js';

export interface StoredChannelSchedule {
  enabled: boolean;
  intervalMinutes: number;
  backfillWindow: BackfillWindow;
  backfillMaxItems: number;
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
  startRun(request: StartRunRequest): Promise<JobSubmission[]>;
  whenSettled(jobId: string): Promise<CollectionJob>;
}

export interface ChannelSchedulerOptions {
  now?: () => Date;
  pollIntervalMs?: number;
  recordEvent?: (entry: Omit<NewJobEvent, 'vaultPath' | 'jobId'>) => void;
}

/** Any subset of the Global settings; fields left out keep their value. */
export type UpdateChannelSchedule = Partial<SchedulePolicy>;

export class ChannelScheduler {
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private schedule: StoredChannelSchedule | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking: Promise<void> | null = null;
  private suspended = false;
  private closed = false;
  /** Increments per dispatch; only the latest dispatch records its result. */
  private dispatchCount = 0;
  private pendingDispatch: number | null = null;

  constructor(
    private readonly runner: ScheduledChannelRunner,
    private readonly store: ChannelScheduleStore,
    private readonly options: ChannelSchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
  }

  async start(): Promise<void> {
    const schedule = await this.ensureLoaded();
    // A Vault without a schedule file is enabled with no due time yet; the first check is one interval away.
    if (schedule.enabled && !schedule.nextRunAt) {
      schedule.nextRunAt = addMinutes(this.now(), schedule.intervalMinutes).toISOString();
      await this.store.save(schedule);
    }
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

  async getPolicy(): Promise<SchedulePolicy> {
    const { enabled, intervalMinutes, backfillWindow, backfillMaxItems } = await this.ensureLoaded();
    return { enabled, intervalMinutes, backfillWindow, backfillMaxItems };
  }

  /**
   * Changes the Global settings. Turning collection on counts the interval from now; a new interval
   * counts from the last dispatch and is due at once if that time has passed. Backfill settings
   * apply to the next backfill only and start no work.
   */
  async updateSchedule(input: UpdateChannelSchedule): Promise<ChannelSchedule> {
    assertPolicyPatch(input);
    const current = await this.ensureLoaded();
    const now = this.now();
    const wasEnabled = current.enabled;
    const intervalChanged = input.intervalMinutes !== undefined && input.intervalMinutes !== current.intervalMinutes;
    if (input.enabled !== undefined) current.enabled = input.enabled;
    if (input.intervalMinutes !== undefined) current.intervalMinutes = input.intervalMinutes;
    if (input.backfillWindow !== undefined) current.backfillWindow = input.backfillWindow;
    if (input.backfillMaxItems !== undefined) current.backfillMaxItems = input.backfillMaxItems;
    if (!current.enabled) {
      current.nextRunAt = null;
    } else if (!wasEnabled || !current.nextRunAt) {
      current.nextRunAt = addMinutes(now, current.intervalMinutes).toISOString();
    } else if (intervalChanged) {
      const base = current.lastAttemptAt ? new Date(current.lastAttemptAt) : now;
      const next = addMinutes(base, current.intervalMinutes);
      current.nextRunAt = (next.getTime() < now.getTime() ? now : next).toISOString();
    }
    await this.store.save(current);
    this.options.recordEvent?.({
      severity: 'info', eventType: 'schedule.updated', message: '已更新自動收集設定。',
    });
    return this.snapshot(current);
  }

  /**
   * Checks every enabled subscription now, whether or not automatic collection is on, and counts the
   * next automatic check from this dispatch.
   */
  async runNow(): Promise<JobSubmission[]> {
    if (this.suspended) throw new CollectorError('vault_busy', '資料搬移進行中，請稍後再檢查。');
    const schedule = await this.ensureLoaded();
    return this.dispatch(schedule, 'manual', true);
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
    await this.dispatch(schedule, 'scheduled', false).catch(() => undefined);
  }

  /** Records the dispatch, submits the jobs and leaves their result to be recorded when they settle. */
  private async dispatch(
    schedule: StoredChannelSchedule,
    trigger: 'scheduled' | 'manual',
    rethrow: boolean,
  ): Promise<JobSubmission[]> {
    const dispatchedAt = this.now();
    schedule.lastAttemptAt = dispatchedAt.toISOString();
    if (schedule.enabled) schedule.nextRunAt = addMinutes(dispatchedAt, schedule.intervalMinutes).toISOString();
    const dispatch = ++this.dispatchCount;
    let submissions: JobSubmission[];
    try {
      submissions = await this.runner.startRun({ trigger });
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
      if (rethrow) throw error;
      return [];
    }
    this.pendingDispatch = dispatch;
    await this.store.save(schedule);
    void Promise.all(submissions.map(({ job }) => this.runner.whenSettled(job.id)))
      .then((jobs) => this.recordResult(dispatch, jobs))
      .catch(reportScheduleError);
    return submissions;
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
