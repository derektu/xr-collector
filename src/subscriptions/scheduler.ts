import type { StartRunRequest } from './subscription-service.js';
import type { NewJobEvent } from '../jobs/job-store.js';
import { PAUSE_MESSAGES, type CollectionPause } from '../core/collection-pause.js';
import {
  CollectorError,
  type CollectionSchedule,
  type JobSubmission,
  type ScheduledCheck,
  type SubscriptionRecord,
} from '../core/types.js';

/** What the Vault keeps for automatic collection; check times live with each subscription. */
export interface StoredSchedule {
  enabled: boolean;
}

export interface ScheduleStore {
  load(): Promise<StoredSchedule>;
  save(schedule: StoredSchedule): Promise<void>;
}

/** The subscription service of one source type, as the scheduler checks through it. */
export interface ScheduledRunner {
  readonly type: string;
  list(): Promise<SubscriptionRecord[]>;
  startRun(request: StartRunRequest): Promise<JobSubmission[]>;
  planChecks(options: { overdue: boolean }): Promise<void>;
}

export interface SchedulerOptions {
  now?: () => Date;
  pollIntervalMs?: number;
  recordEvent?: (entry: Omit<NewJobEvent, 'vaultPath' | 'jobId'>) => void;
  /**
   * No check is dispatched while collection is paused; the due subscriptions are checked once it
   * continues. Each pause reason coming into force or lifting is recorded in the activity log.
   */
  pause?: CollectionPause;
}

export interface UpdateSchedule {
  enabled: boolean;
}

/**
 * Checks each subscription of every source type when its own next check time arrives. Every poll
 * submits all due subscriptions together, one job per subscription, and returns without waiting
 * for them; the job manager bounds how many run at once. One switch turns automatic collection on
 * or off for every type.
 */
export class CollectionScheduler {
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private schedule: StoredSchedule | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking: Promise<void> | null = null;
  private suspended = false;
  private unsubscribePause: (() => void) | null = null;

  constructor(
    private readonly runners: readonly ScheduledRunner[],
    private readonly store: ScheduleStore,
    private readonly options: SchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
  }

  async start(): Promise<void> {
    await this.ensureLoaded();
    this.unsubscribePause ??= this.options.pause?.subscribe(({ reason, inForce, paused }) => {
      this.options.recordEvent?.({
        severity: 'info', eventType: inForce ? 'collection.paused' : 'collection.resumed', pauseReason: reason,
        message: inForce ? PAUSE_MESSAGES[reason].paused : PAUSE_MESSAGES[reason].resumed,
      });
      if (!paused) void this.checkNow().catch(reportScheduleError);
    }) ?? null;
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
    this.unsubscribePause?.();
    this.unsubscribePause = null;
    await this.checking;
  }

  async isEnabled(): Promise<boolean> {
    return (await this.ensureLoaded()).enabled;
  }

  /** The switch, the newest finished check and, while collection is on, the subscription due first. */
  async getSchedule(): Promise<CollectionSchedule> {
    const { enabled } = await this.ensureLoaded();
    let lastCheck: ScheduledCheck | null = null;
    let nextCheck: ScheduledCheck | null = null;
    for (const runner of this.runners) {
      for (const subscription of await runner.list()) {
        if (subscription.lastCheckedAt && (!lastCheck || subscription.lastCheckedAt > lastCheck.at)) {
          lastCheck = { type: runner.type, subscriptionId: subscription.id, title: subscription.title, at: subscription.lastCheckedAt };
        }
        if (enabled && subscription.enabled && subscription.nextCheckAt && (!nextCheck || subscription.nextCheckAt < nextCheck.at)) {
          nextCheck = { type: runner.type, subscriptionId: subscription.id, title: subscription.title, at: subscription.nextCheckAt };
        }
      }
    }
    return { enabled, status: enabled ? 'scheduled' : 'paused', lastCheck, nextCheck };
  }

  /**
   * Turns automatic collection on or off. Turning it on keeps each next check time still ahead and
   * counts the overdue ones from now, so a long pause never makes them all due at once.
   */
  async updateSchedule(input: UpdateSchedule): Promise<CollectionSchedule> {
    if (typeof input?.enabled !== 'boolean') {
      throw new CollectorError('invalid_request', '自動檢查開關必須是 true 或 false。');
    }
    const current = await this.ensureLoaded();
    if (current.enabled !== input.enabled) {
      current.enabled = input.enabled;
      await this.store.save(current);
      if (current.enabled) for (const runner of this.runners) await runner.planChecks({ overdue: true });
      this.options.recordEvent?.({
        severity: 'info', eventType: 'schedule.updated', message: current.enabled ? '已開啟自動檢查。' : '已關閉自動檢查。',
      });
    }
    return this.getSchedule();
  }

  /** Checks every enabled subscription of every type now, whether or not automatic collection is on. */
  async runNow(): Promise<JobSubmission[]> {
    if (this.suspended) throw new CollectorError('vault_busy', '資料搬移進行中，請稍後再檢查。');
    const lists = await Promise.all(this.runners.map((runner) => runner.list()));
    const runners = this.runners.filter((_runner, index) => lists[index]!.some((subscription) => subscription.enabled));
    // With nothing to check, the service of the first type answers as a manual check of nothing does.
    if (runners.length === 0) return this.runners[0]?.startRun({ trigger: 'manual' }) ?? [];
    const submissions: JobSubmission[] = [];
    for (const runner of runners) submissions.push(...await runner.startRun({ trigger: 'manual' }));
    return submissions;
  }

  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
  }

  isBusy(): boolean {
    return this.checking !== null;
  }

  /** Resolves when the check in progress, if any, has finished. */
  async idle(): Promise<void> {
    await this.checking?.catch(() => undefined);
  }

  checkNow(): Promise<void> {
    if (this.suspended || this.options.pause?.paused) return Promise.resolve();
    if (this.checking) return this.checking;
    const operation = this.runDueChecks();
    this.checking = operation;
    const clearChecking = () => {
      if (this.checking === operation) this.checking = null;
    };
    void operation.then(clearChecking, clearChecking);
    return operation;
  }

  /** Submits the enabled subscriptions whose next check time has come. */
  private async runDueChecks(): Promise<void> {
    const schedule = await this.ensureLoaded();
    if (!schedule.enabled) return;
    const due: Array<{ runner: ScheduledRunner; ids: string[] }> = [];
    for (const runner of this.runners) {
      let subscriptions = await runner.list();
      if (subscriptions.some((subscription) => subscription.enabled && !subscription.nextCheckAt)) {
        await runner.planChecks({ overdue: false });
        subscriptions = await runner.list();
      }
      // Due is decided once the subscriptions are read, by the clock at that moment.
      const now = this.now().getTime();
      const ids = subscriptions
        .filter((subscription) => subscription.enabled && subscription.nextCheckAt && new Date(subscription.nextCheckAt).getTime() <= now)
        .map((subscription) => subscription.id);
      if (ids.length > 0) due.push({ runner, ids });
    }
    const count = due.reduce((sum, entry) => sum + entry.ids.length, 0);
    if (count === 0) return;
    this.options.recordEvent?.({
      severity: 'debug', eventType: 'schedule.dispatched', message: `定時檢查開始：${count} 個訂閱到了檢查時間。`,
    });
    for (const { runner, ids } of due) {
      await runner.startRun({ trigger: 'scheduled', subscriptionIds: ids }).catch((error: unknown) => {
        reportScheduleError(error);
        this.options.recordEvent?.({
          severity: 'error', eventType: 'schedule.failed',
          message: error instanceof CollectorError ? `定時檢查無法派工：${error.message}` : '定時檢查無法派工。',
          ...(error instanceof CollectorError ? { errorCode: error.code } : {}),
        });
      });
    }
  }

  private async ensureLoaded(): Promise<StoredSchedule> {
    this.schedule ??= await this.store.load();
    return this.schedule;
  }
}

function reportScheduleError(error: unknown): void {
  console.error('Scheduled subscription check failed', error);
}
