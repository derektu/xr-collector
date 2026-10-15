import type { StartRunRequest } from './channel-collector.js';
import type { NewJobEvent } from '../jobs/job-store.js';
import {
  CollectorError,
  type ChannelSchedule,
  type JobSubmission,
  type ScheduledCheck,
  type YouTubeChannel,
} from '../core/types.js';

/** What the Vault keeps for automatic collection; check times live with each subscription. */
export interface StoredChannelSchedule {
  enabled: boolean;
}

export interface ChannelScheduleStore {
  load(): Promise<StoredChannelSchedule>;
  save(schedule: StoredChannelSchedule): Promise<void>;
}

/** The subscription service the scheduler checks through. */
export interface ScheduledChannelRunner {
  listChannels(): Promise<YouTubeChannel[]>;
  startRun(request: StartRunRequest): Promise<JobSubmission[]>;
  planChecks(options: { reset: boolean }): Promise<void>;
}

export interface ChannelSchedulerOptions {
  now?: () => Date;
  pollIntervalMs?: number;
  recordEvent?: (entry: Omit<NewJobEvent, 'vaultPath' | 'jobId'>) => void;
}

export interface UpdateChannelSchedule {
  enabled: boolean;
}

/**
 * Checks each subscription when its own next check time arrives. Every poll submits all due
 * subscriptions together, one job per subscription, and returns without waiting for them; the
 * job manager bounds how many run at once.
 */
export class ChannelScheduler {
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private schedule: StoredChannelSchedule | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking: Promise<void> | null = null;
  private suspended = false;

  constructor(
    private readonly runner: ScheduledChannelRunner,
    private readonly store: ChannelScheduleStore,
    private readonly options: ChannelSchedulerOptions = {},
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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.checking;
  }

  async isEnabled(): Promise<boolean> {
    return (await this.ensureLoaded()).enabled;
  }

  /** The switch, the newest finished check and, while collection is on, the subscription due first. */
  async getSchedule(): Promise<ChannelSchedule> {
    const { enabled } = await this.ensureLoaded();
    const channels = await this.runner.listChannels();
    let lastCheck: ScheduledCheck | null = null;
    let nextCheck: ScheduledCheck | null = null;
    for (const channel of channels) {
      if (channel.lastCheckedAt && (!lastCheck || channel.lastCheckedAt > lastCheck.at)) {
        lastCheck = { channelId: channel.id, title: channel.title, at: channel.lastCheckedAt };
      }
      if (enabled && channel.enabled && channel.nextCheckAt && (!nextCheck || channel.nextCheckAt < nextCheck.at)) {
        nextCheck = { channelId: channel.id, title: channel.title, at: channel.nextCheckAt };
      }
    }
    return { enabled, status: enabled ? 'scheduled' : 'paused', lastCheck, nextCheck };
  }

  /**
   * Turns automatic collection on or off. Turning it on counts every enabled subscription's next
   * check from now, so a long pause never makes them all due at once.
   */
  async updateSchedule(input: UpdateChannelSchedule): Promise<ChannelSchedule> {
    if (typeof input?.enabled !== 'boolean') {
      throw new CollectorError('invalid_request', '自動收集開關必須是 true 或 false。');
    }
    const current = await this.ensureLoaded();
    if (current.enabled !== input.enabled) {
      current.enabled = input.enabled;
      await this.store.save(current);
      if (current.enabled) await this.runner.planChecks({ reset: true });
      this.options.recordEvent?.({
        severity: 'info', eventType: 'schedule.updated', message: current.enabled ? '已開啟自動收集。' : '已暫停自動收集。',
      });
    }
    return this.getSchedule();
  }

  /** Checks every enabled subscription now, whether or not automatic collection is on. */
  async runNow(): Promise<JobSubmission[]> {
    if (this.suspended) throw new CollectorError('vault_busy', '資料搬移進行中，請稍後再檢查。');
    return this.runner.startRun({ trigger: 'manual' });
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
    let channels = await this.runner.listChannels();
    if (channels.some((channel) => channel.enabled && !channel.nextCheckAt)) {
      await this.runner.planChecks({ reset: false });
      channels = await this.runner.listChannels();
    }
    const now = this.now().getTime();
    const due = channels.filter((channel) => channel.enabled && channel.nextCheckAt && new Date(channel.nextCheckAt).getTime() <= now);
    if (due.length === 0) return;
    await this.runner.startRun({ trigger: 'scheduled', channelIds: due.map((channel) => channel.id) }).catch(reportScheduleError);
  }

  private async ensureLoaded(): Promise<StoredChannelSchedule> {
    this.schedule ??= await this.store.load();
    return this.schedule;
  }
}

function reportScheduleError(error: unknown): void {
  console.error('Scheduled channel check failed', error);
}
