import { randomUUID } from 'node:crypto';
import { discoverChannelVideos } from '../channels/channel-discovery.js';
import { backfillWindowStart, DEFAULT_POLICY } from '../channels/collection-policy.js';
import type { ChannelStore } from '../channels/json-channel-store.js';
import type { Collector } from '../core/collector.js';
import {
  CollectorError,
  type ChannelJobTrigger,
  type CollectionJob,
  type CollectionPolicy,
  isRetryable,
  type JobError,
  type JobItem,
  type JobKind,
  type JobPage,
  type JobPhase,
  type JobProgress,
  type JobResult,
  type JobRetry,
  type JobState,
  type JobStopKind,
  type JobSubmission,
  type JobSummary,
  type OutOfRangeVideo,
  type SkipReason,
  type YouTubeChannel,
} from '../core/types.js';
import { parseYouTubeVideoUrl } from '../core/video-url.js';
import type { YouTubeSource } from '../sources/youtube/adapter.js';
import type { PacingEvent, YouTubePacing } from '../capture/youtube-gate.js';
import { classifyYouTubeInput } from '../sources/youtube/url.js';
import { limitText, redact } from '../activity/redact.js';
import type { JobStore, NewJobEvent } from './job-store.js';

export interface JobLimits {
  /** Channel resolution and discovery running at once. */
  discovery: number;
  /**
   * Single-video captures running at once. Every YouTube request also passes the device's one
   * request channel, so a higher number only lets a capture wait there for its turn.
   */
  capture: number;
  /** Jobs waiting in both queues together; further submissions are refused. */
  maxQueued: number;
}

export const DEFAULT_JOB_LIMITS: JobLimits = { discovery: 1, capture: 1, maxQueued: 500 };

/**
 * Automatic retries after a transient failure (`network_error`). A YouTube limit (`rate_limited`)
 * is not a failed attempt: the job waits for the cooldown and continues.
 */
export interface RetryPolicy {
  /** Attempts in total, the first one included. */
  maxAttempts: number;
  /** Wait before each retry; the last value repeats when attempts outnumber it. */
  delaysMs: number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, delaysMs: [30_000, 120_000] };

/**
 * Restarts that may find a job in the middle of a step before it stops resuming. A job that keeps
 * crashing the service would otherwise be resumed into the same crash on every start.
 */
export const MAX_UNCLEAN_STOPS = 3;

/** A limit reported without a cooldown end (no request channel) waits this long. */
const FALLBACK_COOLDOWN_MS = 5 * 60_000;

const RETRYABLE: ReadonlySet<string> = new Set(['network_error']);

export interface JobManagerOptions {
  /** The Vault every job of this manager writes to. */
  vaultPath: string;
  /** ID of that Vault; null for a Vault without an ID, whose jobs are then known by path alone. */
  vaultId?: string | null;
  store: JobStore;
  source: YouTubeSource;
  documents: Collector;
  channels: ChannelStore;
  limits?: Partial<JobLimits>;
  retry?: Partial<RetryPolicy>;
  now?: () => Date;
  createId?: () => string;
  /** Starts a timer and returns its cancel function; retries wait through it. */
  setTimer?: (callback: () => void, ms: number) => () => void;
  /**
   * The shared settings a converted Vault gave its subscriptions; a subscription job accepted
   * before the conversion carries no settings of its own and subscribes with these.
   */
  legacySettings?: () => Promise<CollectionPolicy | null>;
  /** Checks one subscription now, as a manual check does; a failed channel job is retried through it. */
  checkChannel?: (channelId: string) => Promise<JobSubmission>;
  /** The device's YouTube request channel; its cooldowns pause every YouTube step of this manager. */
  pacing?: YouTubePacing;
}

export interface JobListQuery {
  state?: 'active' | 'all';
  limit?: number;
  cursor?: string;
}

const ACTIVE: ReadonlySet<JobState> = new Set(['queued', 'running']);
/** How long a hold waits for running steps before giving up. */
export const HOLD_TIMEOUT_MS = 2 * 60_000;

/**
 * Accepts collection work for one Vault, runs it in bounded queues and records every state change.
 * Discovery (channel resolution and video listing) and single-video capture use separate queues;
 * captures rotate between the jobs that queued them so one large channel cannot hold every slot.
 */
export class JobManager {
  private readonly limits: JobLimits;
  private readonly retryPolicy: RetryPolicy;
  private readonly setTimer: (callback: () => void, ms: number) => () => void;
  /** Cancel functions of jobs waiting for their next attempt. */
  private readonly retryTimers = new Map<string, () => void>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  /** Unfinished jobs, including channel jobs waiting for their videos. */
  private readonly jobs = new Map<string, CollectionJob>();
  private readonly keys = new Map<string, string>();
  private readonly activeByKey = new Map<string, string>();
  private readonly discoveryQueue: string[] = [];
  private readonly captureLanes = new Map<string, string[]>();
  private laneOrder: string[] = [];
  private runningDiscovery = 0;
  private runningCapture = 0;
  private readonly running = new Set<Promise<void>>();
  /** Channel jobs that wait for a video job, keyed by the video job. */
  private readonly watchers = new Map<string, Set<string>>();
  private readonly settleWaiters = new Map<string, Array<(job: CollectionJob) => void>>();
  /**
   * Running channel jobs of a paused or removed subscription, with the reason. They no longer hold
   * the channel's dedupe key, so a resume or new subscription starts its own job at once.
   */
  private readonly stoppedJobs = new Map<string, SkipReason>();
  /** Videos a channel job queued that the user then submitted directly; pausing never skips them. */
  private readonly manualClaims = new Set<string>();
  private closed = false;
  /** Number of holds in force; while any is, no queued step starts. */
  private holds = 0;
  /**
   * Aborted by a hold or close: steps still waiting for their YouTube turn give it up and return
   * to the queue (or are left for close() to record), so neither waits on the request channel.
   */
  private stepAbort = new AbortController();
  /** End of the YouTube cooldown in force; no step starts before it. */
  private cooldownUntil: string | null = null;
  private cancelCooldownTimer: (() => void) | null = null;
  private readonly unsubscribePacing: () => void;

  constructor(private readonly options: JobManagerOptions) {
    this.limits = { ...DEFAULT_JOB_LIMITS, ...options.limits };
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.setTimer = options.setTimer ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => randomUUID());
    this.unsubscribePacing = options.pacing?.subscribe((event) => this.onPacing(event)) ?? (() => undefined);
    const until = options.pacing?.status().cooldownUntil;
    if (until) this.enterCooldown(until);
  }

  /** Records the device's YouTube cooldowns in this Vault's activity and follows them. */
  private onPacing(event: PacingEvent): void {
    if (this.closed) return;
    if (event.type === 'rate_limited') {
      this.recordEvent({
        severity: 'warning', eventType: 'youtube.rate_limited',
        message: `YouTube 暫時限制連線，${clockTime(event.until)} 前暫停所有 YouTube 請求。`,
        until: event.until, level: event.level, ...(event.detail ? { detail: event.detail } : {}),
      });
      this.enterCooldown(event.until);
      return;
    }
    this.recordEvent({ severity: 'info', eventType: 'youtube.cooldown_ended', message: 'YouTube 限制已解除，繼續收集。' });
    this.endCooldown();
  }

  /** Starts or extends the cooldown; every queued job then waits for it, as the job that hit the limit does. */
  private enterCooldown(until: string): void {
    if (this.cooldownUntil && this.cooldownUntil >= until) return;
    this.cooldownUntil = until;
    this.cancelCooldownTimer?.();
    this.cancelCooldownTimer = this.setTimer(() => {
      this.cancelCooldownTimer = null;
      this.endCooldown();
    }, Math.max(0, new Date(until).getTime() - this.now().getTime()));
    for (const job of this.jobs.values()) {
      if (job.state === 'queued') this.markWaiting(job);
    }
  }

  /** Gives a queued job the wait of the cooldown in force; outside a cooldown it does nothing. */
  private markWaiting(job: CollectionJob): void {
    const until = this.cooldownUntil && new Date(this.cooldownUntil).getTime() > this.now().getTime()
      ? this.cooldownUntil : this.options.pacing?.status().cooldownUntil ?? null;
    if (!until || job.wait?.until === until) return;
    this.update(job, { wait: { reason: 'rate_limited', until } });
    this.syncItemWait(job);
  }

  /** Ends the cooldown: waiting jobs drop their wait and queued steps start again. */
  private endCooldown(): void {
    this.cancelCooldownTimer?.();
    this.cancelCooldownTimer = null;
    this.cooldownUntil = null;
    if (this.closed) return;
    for (const job of this.jobs.values()) {
      if (!job.wait) continue;
      this.clearWait(job);
    }
    this.pump();
  }

  private coolingDown(): boolean {
    if (this.options.pacing?.status().state === 'cooldown') return true;
    return this.cooldownUntil !== null && new Date(this.cooldownUntil).getTime() > this.now().getTime();
  }

  private clearWait(job: CollectionJob): void {
    if (!job.wait) return;
    delete job.wait;
    this.update(job, {});
    this.syncItemWait(job);
  }

  /** Channel jobs show the cooldown wait of each of their videos. */
  private syncItemWait(video: CollectionJob): void {
    for (const channelId of this.watchers.get(video.id) ?? []) {
      const channel = this.jobs.get(channelId);
      if (!channel?.items) continue;
      this.update(channel, {
        items: channel.items.map((item) => {
          if (item.jobId !== video.id) return item;
          const next = { ...item };
          delete next.wait;
          return video.wait ? { ...next, wait: video.wait } : next;
        }),
      });
    }
  }

  get vaultPath(): string { return this.options.vaultPath; }

  private get vaultId(): string | null { return this.options.vaultId ?? null; }

  private vaultTag(): { vaultId?: string } {
    return this.vaultId ? { vaultId: this.vaultId } : {};
  }

  /** Whether a stored job belongs to this manager's Vault: the same path and the same Vault ID. */
  private owns(job: CollectionJob): boolean {
    return job.vaultPath === this.options.vaultPath && (job.vaultId ?? null) === this.vaultId;
  }

  /** Accepts a pasted video or channel address according to its syntax. */
  async submit(url: string): Promise<JobSubmission> {
    const input = classifyYouTubeInput(url);
    return input.kind === 'video' ? this.submitVideo(input.video.canonicalUrl) : this.submitChannelAdd(input.url);
  }

  async submitVideo(url: string): Promise<JobSubmission> {
    const submission = this.enqueueVideo(parseYouTubeVideoUrl(url).canonicalUrl, null);
    await this.options.store.flush();
    this.pump();
    return submission;
  }

  /**
   * Resolves a channel address and subscribes to it. A new subscription starts with `settings` (the
   * source type's defaults when omitted) and its first check follows them; an existing subscription
   * keeps its own state and settings.
   */
  async submitChannelAdd(url: string, settings: CollectionPolicy = DEFAULT_POLICY): Promise<JobSubmission> {
    const input = classifyYouTubeInput(url);
    if (input.kind !== 'channel') throw new CollectorError('invalid_channel', '請輸入 YouTube 頻道網址或 @handle。');
    const submission = this.enqueue('youtube.channel-add', `channel-add:${input.url.toLowerCase()}`, {
      id: null, url: input.url, title: null,
    }, null, { scope: { trigger: 'subscribe' }, checkpoint: { settings: { ...settings } } });
    await this.options.store.flush();
    this.pump();
    return submission;
  }

  /**
   * Starts one check of a subscription; an active job of the same channel is returned instead, so
   * the check joins it.
   */
  async submitChannel(channel: YouTubeChannel, trigger: ChannelJobTrigger): Promise<JobSubmission> {
    const submission = this.enqueueChannel(channel, trigger);
    await this.options.store.flush();
    this.pump();
    return submission;
  }

  get(id: string): CollectionJob {
    const job = this.options.store.get(id);
    if (!job || !this.owns(job)) {
      throw new CollectorError('job_not_found', '找不到這個收集工作。');
    }
    return publicJob(job);
  }

  /** Top-level jobs, newest first. Videos a channel job started appear as that job's items. */
  list(query: JobListQuery = {}): JobPage {
    const limit = query.limit ?? 20;
    let jobs = this.options.store.list(this.options.vaultPath, this.vaultId).filter((job) => job.parentId === null);
    if (query.state === 'active') jobs = jobs.filter((job) => ACTIVE.has(job.state));
    if (query.cursor) {
      const index = jobs.findIndex((job) => job.id === query.cursor);
      if (index < 0) throw new CollectorError('invalid_request', '分頁位置已失效，請重新讀取第一頁。');
      jobs = jobs.slice(index + 1);
    }
    const page = jobs.slice(0, limit).map(publicJob);
    return { jobs: page, nextCursor: jobs.length > limit ? page[page.length - 1]!.id : null };
  }

  /**
   * Channel collection jobs of the active Vault grouped by channel, newest first. Finished jobs are
   * kept up to the job store's limit, so older records drop out.
   */
  channelJobs(): Map<string, CollectionJob[]> {
    const byChannel = new Map<string, CollectionJob[]>();
    for (const job of this.options.store.list(this.options.vaultPath, this.vaultId)) {
      if (job.kind !== 'youtube.channel' || !job.source.id) continue;
      const jobs = byChannel.get(job.source.id) ?? [];
      jobs.push(job);
      byChannel.set(job.source.id, jobs);
    }
    return byChannel;
  }

  /** The channel collection job of this subscription that is still queued or running. */
  activeChannelJob(channelId: string): CollectionJob | null {
    for (const job of this.jobs.values()) {
      if (job.kind === 'youtube.channel' && job.source.id === channelId && !this.stoppedJobs.has(job.id)) return structuredClone(job);
    }
    return null;
  }

  /**
   * Converges a paused or removed subscription: its queued channel job and the videos it queued that
   * have not started end as skipped. A video already capturing finishes and is saved; a discovery in
   * progress sees the change before accepting any video.
   */
  stopChannel(channelId: string, reason: SkipReason): void {
    for (const job of [...this.jobs.values()]) {
      if (job.kind !== 'youtube.channel' || job.source.id !== channelId) continue;
      if (job.state === 'queued') {
        const index = this.discoveryQueue.indexOf(job.id);
        if (index >= 0) this.discoveryQueue.splice(index, 1);
        this.finish(job, 'completed', { outcome: 'skipped', skipReason: reason }, null);
        continue;
      }
      this.stoppedJobs.set(job.id, reason);
      const key = this.keys.get(job.id);
      if (key && this.activeByKey.get(key) === job.id) this.activeByKey.delete(key);
      for (const item of job.items ?? []) {
        const video = item.jobId ? this.jobs.get(item.jobId) : undefined;
        if (!video || video.parentId !== job.id || video.state !== 'queued' || this.manualClaims.has(video.id)) continue;
        this.removeFromLane(video);
        this.finish(video, 'completed', { outcome: 'skipped', skipReason: reason }, null);
      }
    }
    void this.options.store.flush().catch((error: unknown) => console.error('Job store flush failed', error));
  }

  /**
   * Retries a failed top-level job at the user's request with a new job and a fresh attempt budget.
   * A video is collected again and a subscription request subscribes with the settings it was
   * accepted with. A channel job whose discovery failed checks its subscription now; one that
   * recorded videos, failed or completed with some of them failing, collects those failed videos
   * again. The new job records `retryOf`, the earlier one `retriedBy`; an active job of the same
   * target is returned as a duplicate instead.
   */
  async retry(id: string): Promise<JobSubmission> {
    const job = this.options.store.get(id);
    if (!job || !this.owns(job)) throw new CollectorError('job_not_found', '找不到這個收集工作。');
    if (job.parentId !== null) {
      throw new CollectorError('job_not_retryable', '頻道收集中的影片隨頻道工作處理，請重試頻道工作。');
    }
    if (!isRetryable(job)) throw new CollectorError('job_not_retryable', '只有失敗或有影片失敗的工作可以重試。');
    if (job.retriedBy) throw new CollectorError('job_not_retryable', '這個工作已經重試過，請查看重試的工作。');
    let submission: JobSubmission;
    if (job.kind === 'youtube.video') {
      submission = this.enqueueVideo(job.source.url, null, null, { retryOf: job.id }, job.source.title);
    } else if (job.kind === 'youtube.channel-add') {
      const settings = await this.acceptedSettings(job);
      submission = this.enqueue('youtube.channel-add', jobKey(job), { id: null, url: job.source.url, title: null }, null, {
        scope: { trigger: 'subscribe' }, checkpoint: { settings: { ...settings } }, retryOf: job.id,
      });
    } else if (job.items && job.items.length > 0) {
      const retryItems = job.items.filter((item) => item.state === 'failed')
        .map((item) => ({ sourceId: item.sourceId, title: item.title, url: item.url }));
      if (retryItems.length === 0) throw new CollectorError('job_not_retryable', '這個工作沒有失敗的影片。');
      const stopped = await this.subscriptionStopped(job.source.id!);
      if (stopped === 'subscription_removed') throw new CollectorError('channel_not_found', '找不到這個 YouTube 頻道訂閱。');
      if (stopped) throw new CollectorError('channel_paused', `「${job.source.title ?? job.source.id}」已暫停，請先恢復訂閱。`);
      submission = this.enqueue('youtube.channel', `channel:${job.source.id}`, {
        id: job.source.id, url: job.source.url, title: job.source.title,
      }, null, { scope: { trigger: 'manual' }, checkpoint: { retryItems }, retryOf: job.id });
    } else {
      if (!this.options.checkChannel || !job.source.id) throw new CollectorError('job_not_retryable', '這個工作無法重試。');
      submission = await this.options.checkChannel(job.source.id);
      const started = this.jobs.get(submission.job.id);
      if (started && !submission.deduplicated) {
        this.update(started, { retryOf: job.id });
        submission = { ...submission, job: this.get(started.id) };
      }
    }
    this.updateStored(job, { retriedBy: submission.job.id, updatedAt: this.now().toISOString() });
    const retried = this.jobs.get(submission.job.id) ?? this.options.store.get(submission.job.id)!;
    this.event(retried, {
      severity: 'info', eventType: 'job.retry_requested', retryOf: job.id,
      message: submission.deduplicated ? '已手動重試，併入進行中的工作。' : '已手動重試，重新排入收集。',
    });
    await this.options.store.flush();
    this.pump();
    return submission;
  }

  /** Top-level job counts: queued or running now, and completed or failed (and not retried) since `since`. */
  summary(since: string): JobSummary {
    const bound = new Date(since).toISOString();
    const summary: JobSummary = { active: 0, completed: 0, failed: 0, since: bound };
    for (const job of this.options.store.list(this.options.vaultPath, this.vaultId)) {
      if (job.parentId !== null) continue;
      if (ACTIVE.has(job.state)) summary.active += 1;
      else if (!job.finishedAt || job.finishedAt < bound) continue;
      else if (job.state === 'completed') summary.completed += 1;
      else if (job.state === 'failed' && !job.retriedBy) summary.failed += 1;
    }
    return summary;
  }

  /** Records a Vault-level event, such as a subscription change, that belongs to no job. */
  recordEvent(entry: Omit<NewJobEvent, 'vaultPath' | 'jobId'>): void {
    this.options.store.event({ ...entry, vaultPath: this.options.vaultPath, ...this.vaultTag(), jobId: null });
  }

  /**
   * Stops starting queued steps and resolves once the steps already running have finished, with a
   * function that lifts the hold. Queued jobs keep their place and continue after the last hold is
   * lifted. When the running steps take longer than `timeoutMs`, the hold is lifted and the call
   * fails with `vault_busy`, so a caller never waits on a stuck step indefinitely. Aborting `signal`
   * while it waits lifts the hold and fails the call with the signal's reason.
   */
  async hold(timeoutMs = HOLD_TIMEOUT_MS, signal?: AbortSignal): Promise<() => void> {
    this.holds += 1;
    // Steps waiting for their YouTube turn go back to the queue instead of holding this up.
    this.stepAbort.abort(new CollectorError('vault_busy', '收集步驟已暫停。'));
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      if (this.holds === 0) {
        this.stepAbort = new AbortController();
        this.pump();
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const expired = new Promise<'expired'>((resolve) => { timer = setTimeout(() => resolve('expired'), timeoutMs); });
    const aborted = new Promise<'aborted'>((resolve) => {
      onAbort = () => resolve('aborted');
      if (signal?.aborted) resolve('aborted'); else signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      while (this.running.size > 0 || signal?.aborted) {
        const outcome = await Promise.race([Promise.allSettled([...this.running]).then(() => 'settled' as const), expired, aborted]);
        if (outcome === 'aborted') {
          release();
          throw signal!.reason;
        }
        if (outcome === 'expired') {
          release();
          throw new CollectorError('vault_busy', `目前的收集步驟在 ${Math.round(timeoutMs / 60_000) || 1} 分鐘內沒有結束，請稍後再試。`);
        }
      }
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
    return release;
  }

  /** Number of top-level jobs that are queued, running or waiting for their videos. */
  unfinishedCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) if (job.parentId === null) count += 1;
    return count;
  }

  /** True while any job of this Vault is queued, running or waiting for its videos. */
  isBusy(): boolean {
    return this.jobs.size > 0;
  }

  /** Resolves when the job finishes, fails or is interrupted. */
  whenSettled(id: string): Promise<CollectionJob> {
    if (!this.jobs.has(id)) return Promise.resolve(this.get(id));
    return new Promise((resolve) => {
      const waiters = this.settleWaiters.get(id) ?? [];
      waiters.push(resolve);
      this.settleWaiters.set(id, waiters);
    });
  }

  /**
   * Continues the Vault's interrupted jobs; called once when the Vault opens, before the scheduler
   * starts. Each job keeps its trigger, finished items, saved documents and failed attempts; a
   * channel job that had not recorded its videos discovers them as any check starting now would.
   * A job that a later job of the same video or channel took over, a channel job whose subscription
   * was paused or removed, and a job that kept stopping the service in mid-step end instead.
   */
  async resume(): Promise<void> {
    if (this.closed) return;
    const { store } = this.options;
    const superseded: CollectionJob[] = [];
    const pending: CollectionJob[] = [];
    const seen = new Set<string>();
    // The list is newest first, so a job whose key was already seen has a later job of the same target.
    for (const job of store.list(this.options.vaultPath, this.vaultId)) {
      const key = jobKey(job);
      const later = seen.has(key);
      seen.add(key);
      if (job.state === 'interrupted') (later ? superseded : pending).push(job);
    }
    pending.reverse();
    const settled = new Set<string>();
    const settle = (job: CollectionJob, state: 'completed' | 'failed', result: JobResult, error: JobError | null) => {
      settled.add(job.id);
      this.jobs.set(job.id, job);
      this.finish(job, state, result, error);
    };
    /** Ends a channel job and the videos it queued, except videos the user also submitted. */
    const skipChannel = (job: CollectionJob, reason: SkipReason) => {
      for (const child of pending) {
        if (child.parentId === job.id && !child.claimedByUser && !settled.has(child.id)) {
          settle(child, 'completed', { outcome: 'skipped', skipReason: reason }, null);
        }
      }
      if (job.items) {
        const items = job.items.map((item) => {
          const video = item.jobId ? store.get(item.jobId) : undefined;
          // A video the user also submitted continues as the user's own job.
          if (video?.claimedByUser && video.state === 'interrupted') {
            return { ...item, state: 'completed' as const, outcome: 'skipped' as const, skipReason: reason, error: null };
          }
          return this.storedItem(item);
        });
        this.updateStored(job, { items, progress: progressOf(items) });
      }
      settle(job, 'completed', { outcome: 'skipped', skipReason: reason }, null);
    };
    const tooManyStops = (job: CollectionJob) => (job.recovery?.uncleanStops ?? 0) >= MAX_UNCLEAN_STOPS;
    const repeated: JobError = { code: 'interrupted_repeatedly', message: '工作多次在執行中被中斷，已停止自動接續。可重新提交。' };

    for (const job of superseded) {
      if (job.kind === 'youtube.channel') skipChannel(job, 'superseded');
      else if (!settled.has(job.id)) settle(job, 'completed', { outcome: 'skipped', skipReason: 'superseded' }, null);
    }
    const subscriptions = await this.options.channels.list();
    const channelJobs: CollectionJob[] = [];
    // Channel work first, so its videos follow the subscription's state.
    for (const job of pending) {
      if (job.kind === 'youtube.video' || settled.has(job.id)) continue;
      if (tooManyStops(job)) {
        settle(job, 'failed', { outcome: 'failed' }, repeated);
        continue;
      }
      if (job.kind === 'youtube.channel') {
        const subscription = subscriptions.find((candidate) => candidate.id === job.source.id);
        const reason: SkipReason | null = !subscription ? 'subscription_removed' : !subscription.enabled ? 'subscription_paused' : null;
        if (reason) {
          skipChannel(job, reason);
          continue;
        }
        channelJobs.push(job);
      }
      const subscribing = job.kind === 'youtube.channel-add' ? job.checkpoint?.subscribing : undefined;
      const subscribed = subscribing ? subscriptions.find((candidate) => candidate.id === subscribing.channelId) : undefined;
      if (subscribed) {
        // The subscription was written before the stop; its first collection is queued now, before the
        // scheduler can start a check of the same channel, so that check joins it.
        const restored = this.restore(job, { queue: false });
        this.update(restored, { source: { ...restored.source, id: subscribed.id, title: subscribed.title } });
        const followUp = this.enqueueChannel(subscribed, 'subscribe');
        this.finish(restored, 'completed', { outcome: 'created', channelId: subscribed.id, followUpJobId: followUp.job.id }, null);
        continue;
      }
      this.restore(job);
    }
    for (const job of pending) {
      if (job.kind !== 'youtube.video' || settled.has(job.id)) continue;
      if (tooManyStops(job)) settle(job, 'failed', { outcome: 'failed' }, repeated);
      else this.restore(job);
    }
    // Channel jobs past discovery wait for their videos again and record their check time.
    for (const stored of channelJobs) {
      const job = this.jobs.get(stored.id);
      if (!job?.items) continue;
      const items = job.items.map((item) => {
        const video = item.jobId ? this.jobs.get(item.jobId) : undefined;
        if (!video) return this.storedItem(item);
        const watching = this.watchers.get(video.id) ?? new Set<string>();
        watching.add(job.id);
        this.watchers.set(video.id, watching);
        return { ...item, state: video.state, ...(video.retry ? { retry: video.retry } : {}) };
      });
      this.update(job, { items, progress: progressOf(items) });
      const discovered = job.checkpoint?.discovered;
      if (discovered && !job.checkpoint?.retryItems) await this.recordCheck(job.source.id!, discovered.at);
      if (this.jobs.has(job.id)) this.completeChannelIfDone(job);
    }
    await store.flush();
    this.pump();
  }

  /**
   * Makes an interrupted job active again and, unless told otherwise, returns it to the queue or to
   * waiting for its next attempt.
   */
  private restore(stored: CollectionJob, options: { queue: boolean } = { queue: true }): CollectionJob {
    const timestamp = this.now().toISOString();
    const waitsForVideos = stored.kind === 'youtube.channel' && stored.items !== null;
    const job: CollectionJob = {
      ...stored,
      state: waitsForVideos ? 'running' : 'queued',
      finishedAt: null,
      error: null,
      recovery: {
        ...stored.recovery,
        resumedCount: (stored.recovery?.resumedCount ?? 0) + 1,
        uncleanStops: stored.recovery?.uncleanStops ?? 0,
        lastInterruptedAt: stored.recovery?.lastInterruptedAt ?? stored.updatedAt,
        lastResumedAt: timestamp,
      },
      updatedAt: timestamp,
    };
    const key = jobKey(job);
    this.jobs.set(job.id, job);
    this.keys.set(job.id, key);
    this.activeByKey.set(key, job.id);
    if (job.claimedByUser) this.manualClaims.add(job.id);
    if (job.wait) {
      // A cooldown still in force keeps the job waiting; one that ended while stopped is over.
      if (new Date(job.wait.until).getTime() > this.now().getTime()) this.enterCooldown(job.wait.until);
      else delete job.wait;
    }
    this.options.store.put(job);
    const stopReason = job.recovery?.lastStop ?? 'unknown';
    this.event(job, {
      severity: 'info', eventType: 'job.resumed', stopReason,
      message: stopReason === 'shutdown' ? '服務正常關閉後重新啟動，接續收集工作。'
        : stopReason === 'crash' ? '服務異常結束後重新啟動，接續收集工作。'
          : stopReason === 'vault_move' ? '知識庫搬移完成，接續收集工作。'
            : stopReason === 'vault_switch' ? '回到這個知識庫，接續收集工作。' : '服務重新啟動後接續收集工作。',
    });
    if (waitsForVideos || !options.queue) return job;
    this.markWaiting(job);
    const waitMs = job.retry?.nextAttemptAt ? new Date(job.retry.nextAttemptAt).getTime() - this.now().getTime() : 0;
    if (waitMs > 0) this.waitForAttempt(job, waitMs);
    else this.requeue(job);
    return job;
  }

  /** An item whose video job is not running here, as that job's record says it ended. */
  private storedItem(item: JobItem): JobItem {
    const video = item.jobId ? this.options.store.get(item.jobId) : undefined;
    if (video && video.state !== 'interrupted' && !ACTIVE.has(video.state)) return settledItem(item, video);
    if (!ACTIVE.has(item.state) && item.state !== 'interrupted') return item;
    return { ...item, state: 'failed', error: { code: 'interrupted', message: '找不到這支影片的收集紀錄。' } };
  }

  /** Changes a job that is not running in this manager. */
  private updateStored(job: CollectionJob, patch: Partial<CollectionJob>): void {
    Object.assign(job, patch);
    this.options.store.put(job);
  }

  /**
   * Stops starting work, waits for running steps, and records what is left as interrupted with
   * `reason`, which says why the jobs stopped, and `stop`, the kind of stop.
   */
  async close(reason = '服務停止時工作尚未完成；已保存的內容保留。', stop: JobStopKind = 'shutdown'): Promise<void> {
    this.closed = true;
    this.stepAbort.abort(new CollectorError('vault_busy', '服務正在停止。'));
    this.unsubscribePacing();
    this.cancelCooldownTimer?.();
    this.cancelCooldownTimer = null;
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
    for (const job of [...this.jobs.values()]) {
      this.options.store.interrupt(job, reason, { stop });
      this.release(job);
      this.notifySettled(this.options.store.get(job.id)!);
    }
    this.discoveryQueue.length = 0;
    this.captureLanes.clear();
    this.laneOrder = [];
    await this.options.store.flush();
  }

  private enqueueVideo(
    url: string, parentId: string | null, publishedNotBefore: string | null = null, extra: Pick<CollectionJob, 'retryOf'> = {},
    title: string | null = null,
  ): JobSubmission {
    const video = parseYouTubeVideoUrl(url);
    return this.enqueue('youtube.video', `video:${video.videoId}`, {
      id: video.videoId, url: video.canonicalUrl, title,
    }, parentId, { ...(publishedNotBefore ? { publishedNotBefore } : {}), ...extra });
  }

  private enqueueChannel(channel: YouTubeChannel, trigger: ChannelJobTrigger): JobSubmission {
    return this.enqueue('youtube.channel', `channel:${channel.id}`, {
      id: channel.id, url: channel.url, title: channel.title,
    }, null, { scope: { trigger } });
  }

  private enqueue(
    kind: JobKind,
    key: string,
    source: Omit<CollectionJob['source'], 'type'>,
    parentId: string | null,
    extra: Pick<CollectionJob, 'scope' | 'publishedNotBefore' | 'checkpoint' | 'retryOf'> = {},
  ): JobSubmission {
    if (this.closed) throw new CollectorError('vault_busy', '服務正在停止，無法接受新的收集工作。');
    const activeId = this.activeByKey.get(key);
    if (activeId) {
      const active = this.jobs.get(activeId);
      if (active && parentId === null && kind === 'youtube.video') {
        const checkpoint = { ...active.checkpoint, claimedAt: this.now().toISOString() };
        if (active.parentId !== null) {
          // A direct submission is the user's own request: no range bound and no subscription stop applies.
          this.manualClaims.add(active.id);
          delete active.publishedNotBefore;
          this.update(active, { claimedByUser: true, checkpoint });
        } else {
          this.update(active, { checkpoint });
        }
      }
      return { job: this.get(activeId), deduplicated: true };
    }
    if (this.queuedCount() >= this.limits.maxQueued) {
      throw new CollectorError('queue_full', '等待中的收集工作已達上限，請等目前的工作完成後再試。');
    }
    const timestamp = this.now().toISOString();
    const job: CollectionJob = {
      id: this.createId(),
      kind,
      state: 'queued',
      phase: null,
      vaultPath: this.options.vaultPath,
      ...this.vaultTag(),
      parentId,
      source: { type: 'youtube', ...source },
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null,
      updatedAt: timestamp,
      progress: null,
      ...extra,
      items: null,
      result: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    this.keys.set(job.id, key);
    this.activeByKey.set(key, job.id);
    this.requeue(job);
    this.markWaiting(job);
    this.options.store.put(job);
    this.event(job, { severity: 'info', eventType: 'job.accepted', message: '已接受收集工作。', ...(job.retryOf ? { retryOf: job.retryOf } : {}) });
    return { job: structuredClone(job), deduplicated: false };
  }

  /**
   * Puts a job back in line: videos in their lane, channel work in the discovery queue. `front`
   * returns a step that was stopped before it reached YouTube to the head of the line.
   */
  private requeue(job: CollectionJob, front = false): void {
    if (job.kind !== 'youtube.video') {
      if (front) this.discoveryQueue.unshift(job.id);
      else this.discoveryQueue.push(job.id);
      return;
    }
    const lane = job.parentId ?? job.id;
    const queue = this.captureLanes.get(lane);
    if (queue) {
      if (front) queue.unshift(job.id);
      else queue.push(job.id);
    } else {
      this.captureLanes.set(lane, [job.id]);
      if (front) this.laneOrder.unshift(lane);
      else this.laneOrder.push(lane);
    }
  }

  /** A step stopped by a hold before its YouTube request returns to the queue without spending an attempt. */
  private returnToQueue(job: CollectionJob): void {
    this.update(job, { state: 'queued' });
    this.syncItemWait(job);
    this.requeue(job, true);
  }

  /**
   * YouTube limited requests: the job waits in the queue for the cooldown and continues by itself.
   * Its attempts are unchanged.
   */
  private deferForCooldown(job: CollectionJob, retryAt: string | undefined): void {
    const until = retryAt ?? this.cooldownUntil
      ?? new Date(this.now().getTime() + FALLBACK_COOLDOWN_MS).toISOString();
    this.enterCooldown(until);
    this.update(job, { state: 'queued', wait: { reason: 'rate_limited', until } });
    this.event(job, {
      severity: 'info', eventType: 'job.deferred', message: `YouTube 暫時限制連線，約 ${clockTime(until)} 自動繼續。`,
      until, ...(job.phase ? { phase: job.phase } : {}),
    });
    this.syncItemWait(job);
    this.requeue(job, true);
  }

  /** How a step that threw ended when the throw was not its own failure; true when handled. */
  private handledInterruption(job: CollectionJob, error: unknown, signal: AbortSignal): boolean {
    if (signal.aborted && error === signal.reason) {
      // A close records the job as interrupted; a hold puts it back in line.
      if (!this.closed) this.returnToQueue(job);
      return true;
    }
    if (error instanceof CollectorError && error.code === 'rate_limited') {
      if (!this.closed) this.deferForCooldown(job, error.retryAt);
      return true;
    }
    return false;
  }

  private queuedCount(): number {
    let count = this.discoveryQueue.length;
    for (const queue of this.captureLanes.values()) count += queue.length;
    return count;
  }

  private pump(): void {
    // Every step reads from YouTube, so none starts during a cooldown.
    if (this.closed || this.holds > 0 || this.coolingDown()) return;
    while (this.runningDiscovery < this.limits.discovery && this.discoveryQueue.length > 0) {
      const id = this.discoveryQueue.shift()!;
      this.runningDiscovery += 1;
      this.track(this.runDiscovery(id).finally(() => { this.runningDiscovery -= 1; this.pump(); }));
    }
    while (this.runningCapture < this.limits.capture) {
      const id = this.nextCapture();
      if (!id) break;
      this.runningCapture += 1;
      this.track(this.runVideo(id).finally(() => { this.runningCapture -= 1; this.pump(); }));
    }
  }

  private removeFromLane(job: CollectionJob): void {
    const lane = job.parentId ?? job.id;
    const queue = this.captureLanes.get(lane);
    if (!queue) return;
    const index = queue.indexOf(job.id);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) {
      this.captureLanes.delete(lane);
      this.laneOrder = this.laneOrder.filter((candidate) => candidate !== lane);
    }
  }

  private nextCapture(): string | undefined {
    const lane = this.laneOrder.shift();
    if (lane === undefined) return undefined;
    const queue = this.captureLanes.get(lane)!;
    const id = queue.shift();
    if (queue.length > 0) this.laneOrder.push(lane);
    else this.captureLanes.delete(lane);
    return id;
  }

  private track(work: Promise<void>): void {
    this.running.add(work);
    void work.finally(() => this.running.delete(work)).catch(() => undefined);
  }

  private async runVideo(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    // A job that reached the save phase, or recorded the saved document, before it stopped created
    // whatever document findExisting now returns for this video; that document is its own result.
    const savedEarlier = job.checkpoint?.savedDocumentId !== undefined || job.phase === 'save';
    const { signal } = this.stepAbort;
    this.start(job, 'capture');
    try {
      const video = parseYouTubeVideoUrl(job.source.url);
      const { documents, source } = this.options;
      let document = await documents.findExisting(video.videoId);
      let outcome: 'created' | 'existing' = document && savedEarlier ? 'created' : 'existing';
      if (!document && await documents.isDeletedFor(video.videoId, { explicitAt: explicitRequestTime(job) })) {
        // A deleted video is skipped before capture, so YouTube is not asked for a transcript the save would refuse.
        this.finish(job, 'completed', { outcome: 'skipped', skipReason: 'deleted' }, null);
        return;
      }
      if (!document) {
        const captured = await source.capture(
          video, { ...(job.publishedNotBefore ? { publishedNotBefore: job.publishedNotBefore } : {}), signal },
        );
        this.update(job, { phase: 'save', source: { ...job.source, title: captured.title } });
        // The save phase is on disk before the document is, so a restart knows who saved it.
        await this.options.store.flush();
        const saved = await documents.save(captured, { explicitAt: explicitRequestTime(job) });
        document = saved.document;
        outcome = 'created';
        this.update(job, { checkpoint: { ...job.checkpoint, savedDocumentId: document.id } });
        this.event(job, {
          severity: 'info', eventType: 'document.saved', message: '文件已保存。', phase: 'save', documentId: document.id,
        });
      }
      this.update(job, { phase: 'index', source: { ...job.source, title: document.title } });
      const index = await documents.index(document);
      if (index.deleted) {
        this.finish(job, 'completed', { outcome: 'skipped', skipReason: 'deleted' }, null);
        return;
      }
      if (!index.indexed) {
        this.event(job, {
          severity: 'warning', eventType: 'document.index_failed', message: '文件已保存，搜尋更新失敗。',
          phase: 'index', documentId: document.id,
        });
      }
      this.finish(job, 'completed', {
        outcome, documentId: document.id, saved: true, indexed: index.indexed,
        ...(index.message ? { indexMessage: index.message } : {}),
      }, null);
    } catch (error) {
      if (error instanceof CollectorError && (error.code === 'out_of_range' || error.code === 'document_deleted')) {
        if (error.code === 'out_of_range') await this.recordOutOfRange(job);
        this.finish(job, 'completed', { outcome: 'skipped', skipReason: error.code === 'out_of_range' ? 'out_of_range' : 'deleted' }, null);
        return;
      }
      if (this.handledInterruption(job, error, signal)) return;
      this.failOrRetry(job, errorDetails(error), diagnosticDetail(error));
    }
  }

  private async runDiscovery(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    const { signal } = this.stepAbort;
    try {
      if (job.kind === 'youtube.channel-add') await this.addChannel(job, signal);
      else await this.discoverChannel(job, signal);
    } catch (error) {
      // A step cut short by shutdown is left for close() to record as interrupted.
      if (this.closed) return;
      if (this.handledInterruption(job, error, signal)) return;
      this.failOrRetry(job, errorDetails(error), diagnosticDetail(error));
    }
  }

  /**
   * Schedules another attempt after a transient failure while attempts remain; otherwise the job
   * fails, and a job that was retried says how many attempts it made.
   */
  private failOrRetry(job: CollectionJob, error: JobError, detail?: string): void {
    const attempts = (job.retry?.attempts ?? 0) + 1;
    if (!RETRYABLE.has(error.code)) {
      this.finish(job, 'failed', { outcome: 'failed' }, error, detail);
      return;
    }
    const maxAttempts = this.retryPolicy.maxAttempts;
    if (attempts >= maxAttempts) {
      this.update(job, { retry: { attempts, maxAttempts, nextAttemptAt: null, lastError: error } });
      this.notifyItemRetry(job);
      const message = attempts > 1 ? `${error.message}（已嘗試 ${attempts} 次）` : error.message;
      this.finish(job, 'failed', { outcome: 'failed' }, { code: error.code, message }, detail);
      return;
    }
    const delays = this.retryPolicy.delaysMs;
    const delay = delays[Math.min(attempts - 1, delays.length - 1)] ?? 0;
    const nextAttemptAt = new Date(this.now().getTime() + delay).toISOString();
    this.update(job, { state: 'queued', retry: { attempts, maxAttempts, nextAttemptAt, lastError: error } });
    this.event(job, {
      severity: 'warning', eventType: 'job.retry_scheduled',
      message: `第 ${attempts} 次嘗試失敗，稍後自動重試：${error.message}`,
      errorCode: error.code, attempt: attempts, nextAttemptAt, ...(job.phase ? { phase: job.phase } : {}),
      ...(detail ? { detail } : {}),
    });
    this.notifyItemRetry(job);
    this.waitForAttempt(job, delay);
  }

  /** Puts the job back in line once its wait is over; a closing manager leaves it for close() to record. */
  private waitForAttempt(job: CollectionJob, delayMs: number): void {
    this.retryTimers.get(job.id)?.();
    if (this.closed) return;
    const cancel = this.setTimer(() => {
      this.retryTimers.delete(job.id);
      if (this.closed || this.jobs.get(job.id) !== job) return;
      this.requeue(job);
      this.pump();
    }, Math.max(0, delayMs));
    this.retryTimers.set(job.id, cancel);
  }

  /** Channel jobs show the retry state of each of their videos. */
  private notifyItemRetry(video: CollectionJob): void {
    if (!video.retry) return;
    for (const channelId of this.watchers.get(video.id) ?? []) {
      const channel = this.jobs.get(channelId);
      if (!channel?.items) continue;
      this.update(channel, {
        items: channel.items.map((item) => item.jobId === video.id ? { ...item, retry: video.retry! } : item),
      });
    }
  }

  private async addChannel(job: CollectionJob, signal: AbortSignal): Promise<void> {
    this.start(job, 'resolve');
    // A job interrupted while subscribing already knows its channel and may have added it.
    const subscribing = job.checkpoint?.subscribing;
    const resolved = subscribing
      ? { id: subscribing.channelId, title: subscribing.title, url: subscribing.url }
      : await this.options.source.resolveChannel(job.source.url, { signal });
    const existing = (await this.options.channels.list()).find((channel) => channel.id === resolved.id);
    // The service stopped while resolving; close() records the job as interrupted.
    if (this.closed) return;
    if (existing && subscribing) {
      this.update(job, { source: { ...job.source, id: existing.id, title: existing.title } });
      const followUp = this.enqueueChannel(existing, 'subscribe');
      this.finish(job, 'completed', { outcome: 'created', channelId: existing.id, followUpJobId: followUp.job.id }, null);
      return;
    }
    if (existing) {
      // An existing subscription keeps its own state; a paused one is resumed explicitly.
      this.update(job, { source: { ...job.source, id: existing.id, title: existing.title } });
      this.finish(job, 'completed', { outcome: 'existing', channelId: existing.id }, null);
      return;
    }
    this.update(job, {
      source: { ...job.source, id: resolved.id, title: resolved.title },
      checkpoint: { ...job.checkpoint, subscribing: { channelId: resolved.id, title: resolved.title, url: resolved.url } },
    });
    await this.options.store.flush();
    // The first collection below is this subscription's first check; the next one is an interval later.
    const settings = await this.acceptedSettings(job);
    const now = this.now();
    const channel = await this.options.channels.add({
      ...resolved, enabled: true, addedAt: now.toISOString(), lastCheckedAt: null,
      settings: { ...settings }, lastDispatchedAt: now.toISOString(),
      nextCheckAt: new Date(now.getTime() + settings.intervalMinutes * 60_000).toISOString(),
    });
    this.recordEvent({
      severity: 'info', eventType: 'subscription.added', message: `已訂閱「${channel.title}」。`,
      sourceId: channel.id, sourceTitle: channel.title, subscriptionId: channel.id,
    });
    this.update(job, { source: { ...job.source, id: channel.id, title: channel.title } });
    const followUp = this.enqueueChannel(channel, 'subscribe');
    this.finish(job, 'completed', {
      outcome: 'created', channelId: channel.id, followUpJobId: followUp.job.id,
    }, null);
  }

  /**
   * The settings a subscription job subscribes with: the ones accepted with it, or for a job
   * accepted before subscriptions had their own settings, the shared settings the Vault's
   * conversion gave every other subscription, else the source type's defaults.
   */
  private async acceptedSettings(job: CollectionJob): Promise<CollectionPolicy> {
    if (job.checkpoint?.settings) return job.checkpoint.settings;
    const legacy = await this.options.legacySettings?.();
    return { ...(legacy ?? DEFAULT_POLICY) };
  }

  /**
   * Lists the channel and queues one video job per discovered video. The range comes from the
   * subscription's settings at this moment and is measured back from now, so a job that waited in
   * the queue or across a restart checks the range a check started now would.
   */
  private async discoverChannel(job: CollectionJob, signal: AbortSignal): Promise<void> {
    this.start(job, 'discover');
    const retryItems = job.checkpoint?.retryItems;
    const subscription = (await this.options.channels.list()).find((candidate) => candidate.id === job.source.id);
    if (!subscription?.enabled) {
      this.finish(job, 'completed', { outcome: 'skipped', skipReason: subscription ? 'subscription_paused' : 'subscription_removed' }, null);
      return;
    }
    const channel: YouTubeChannel = { ...subscription, title: job.source.title ?? subscription.title, url: job.source.url };
    const windowStart = backfillWindowStart(this.now(), subscription.settings.backfillWindow);
    // A range that starts no earlier than the one that skipped a video still leaves it out.
    const outside = new Set((subscription.outOfRange ?? [])
      .filter((entry) => entry.before <= windowStart.toISOString()).map((entry) => entry.videoId));
    const discovery = retryItems
      ? {
        candidates: null,
        videos: retryItems.map((item) => ({ id: item.sourceId, title: item.title, url: item.url })),
        publishedNotBefore: null,
      }
      : await discoverChannelVideos(
        this.options.source, channel, { windowStart, maxItems: subscription.settings.backfillMaxItems },
        // Collected, deleted and out-of-range videos stay candidates that are not collected, so they still fill the item limit.
        async (videoId) => outside.has(videoId) || this.options.documents.isKnown(videoId),
        { signal },
      );
    // The service stopped while discovering; close() records the job as interrupted.
    if (this.closed) return;
    const reason = this.stoppedJobs.get(job.id) ?? await this.subscriptionStopped(channel.id);
    if (reason) {
      this.finish(job, 'completed', { outcome: 'skipped', skipReason: reason }, null);
      return;
    }
    const items: JobItem[] = discovery.videos.map((video) => {
      const item: JobItem = {
        sourceId: video.id, title: video.title, url: video.url, jobId: null, state: 'queued', outcome: null, error: null,
      };
      try {
        const submission = this.enqueueVideo(video.url, job.id, discovery.publishedNotBefore, {}, video.title || null);
        item.jobId = submission.job.id;
        item.state = submission.job.state;
        if (submission.job.wait) item.wait = submission.job.wait;
        const watching = this.watchers.get(submission.job.id) ?? new Set<string>();
        watching.add(job.id);
        this.watchers.set(submission.job.id, watching);
      } catch (error) {
        // A video that could not be queued (for example, a full queue) fails here; the next check finds it again while it is a candidate.
        item.state = 'failed';
        item.error = errorDetails(error);
      }
      return item;
    });
    const discovered = { at: this.now().toISOString() };
    this.update(job, { phase: 'capture', items, progress: progressOf(items), checkpoint: { ...job.checkpoint, discovered } });
    this.event(job, {
      severity: 'info', eventType: 'channel.discovered', message: `發現 ${items.length} 支影片。`, phase: 'discover',
    });
    // The check time is saved only after the accepted videos are recorded, so a stop in between finds them again.
    await this.options.store.flush();
    if (this.stoppedJobs.has(job.id) || retryItems) {
      // A job stopped while its videos were being recorded leaves the subscription to the later job;
      // a retry of earlier videos is not a check.
      this.completeChannelIfDone(job);
      return;
    }
    const saved = await this.recordCheck(channel.id, discovered.at, new Set(discovery.candidates ?? []));
    if (!saved) this.stopChannel(channel.id, 'subscription_removed');
    else if (!saved.enabled) this.stopChannel(channel.id, 'subscription_paused');
    if (this.jobs.has(job.id)) this.completeChannelIfDone(job);
  }

  /**
   * Records a check of the subscription at `at`, keeping a later check time already recorded, and
   * returns the subscription, or null once it is removed. Recording the same check again changes
   * nothing. With the check's `candidates`, out-of-range videos that are no longer candidates are
   * forgotten.
   */
  private async recordCheck(channelId: string, at: string, candidates?: ReadonlySet<string>): Promise<YouTubeChannel | null> {
    const current = (await this.options.channels.list()).find((candidate) => candidate.id === channelId);
    if (candidates && current?.outOfRange?.some((entry) => !candidates.has(entry.videoId))) {
      await this.updateOutOfRange(channelId, (entries) => entries.filter((entry) => candidates.has(entry.videoId)));
    }
    if (!current || (current.lastCheckedAt && current.lastCheckedAt >= at)) return current ?? null;
    return this.options.channels.update(channelId, { lastCheckedAt: at });
  }

  /** Remembers that a channel job's video was published before the range start it was checked against. */
  private async recordOutOfRange(video: CollectionJob): Promise<void> {
    const channelId = video.parentId ? this.jobs.get(video.parentId)?.source.id : null;
    const before = video.publishedNotBefore;
    const videoId = video.source.id;
    if (!channelId || !before || !videoId) return;
    await this.updateOutOfRange(channelId, (entries) => [...entries.filter((entry) => entry.videoId !== videoId), { videoId, before }]);
  }

  /** Changes a subscription's out-of-range videos in one serialized store update. */
  private async updateOutOfRange(channelId: string, change: (entries: OutOfRangeVideo[]) => OutOfRangeVideo[]): Promise<void> {
    await this.options.channels.updateWith((channels) => {
      const current = channels.find((candidate) => candidate.id === channelId);
      return current ? new Map([[channelId, { outOfRange: change(current.outOfRange ?? []) }]]) : new Map();
    });
  }

  /** Null while the subscription exists and is enabled; otherwise why its work stops. */
  private async subscriptionStopped(channelId: string): Promise<SkipReason | null> {
    const channel = (await this.options.channels.list()).find((candidate) => candidate.id === channelId);
    if (!channel) return 'subscription_removed';
    return channel.enabled ? null : 'subscription_paused';
  }

  private onVideoSettled(video: CollectionJob): void {
    const watching = this.watchers.get(video.id);
    if (!watching) return;
    this.watchers.delete(video.id);
    for (const channelId of watching) {
      const channel = this.jobs.get(channelId);
      if (!channel?.items) continue;
      const items = channel.items.map((item) => item.jobId === video.id ? settledItem(item, video) : item);
      this.update(channel, { items, progress: progressOf(items) });
      this.completeChannelIfDone(channel);
    }
  }

  private completeChannelIfDone(job: CollectionJob): void {
    const items = job.items ?? [];
    if (items.some((item) => ACTIVE.has(item.state))) return;
    const progress = progressOf(items);
    this.stoppedJobs.delete(job.id);
    if (items.length === 0) {
      this.finish(job, 'completed', { outcome: 'empty' }, null);
    } else if (progress.failed === items.length) {
      this.finish(job, 'failed', { outcome: 'failed' }, { code: 'all_items_failed', message: '這個頻道的影片都收集失敗。' });
    } else {
      const outcome = progress.failed > 0 ? 'partial' : progress.created > 0 ? 'created'
        : progress.existing > 0 ? 'existing' : 'skipped';
      const skipReason = outcome === 'skipped' ? items.find((item) => item.skipReason)?.skipReason : undefined;
      this.finish(job, 'completed', { outcome, ...(skipReason ? { skipReason } : {}) }, null);
    }
  }

  private start(job: CollectionJob, phase: JobPhase): void {
    const timestamp = this.now().toISOString();
    if (job.wait) delete job.wait;
    this.update(job, {
      state: 'running', phase, startedAt: job.startedAt ?? timestamp,
      ...(job.retry ? { retry: { ...job.retry, nextAttemptAt: null } } : {}),
    });
    // Channel items stop showing the wait once the next attempt starts.
    this.notifyItemRetry(job);
    this.syncItemWait(job);
    this.event(job, { severity: 'info', eventType: 'job.started', message: '開始執行收集工作。', phase });
  }

  private finish(job: CollectionJob, state: 'completed' | 'failed', result: JobResult, error: JobError | null, detail?: string): void {
    this.update(job, { state, result, error, finishedAt: this.now().toISOString() });
    this.event(job, state === 'completed'
      ? {
        severity: 'info', eventType: 'job.completed', message: completionMessage(job, result), outcome: result.outcome,
        ...(result.skipReason ? { skipReason: result.skipReason } : {}),
        ...(result.documentId ? { documentId: result.documentId } : {}),
      }
      : {
        severity: 'error', eventType: 'job.failed', message: error?.message ?? '收集工作失敗。', outcome: result.outcome,
        ...(error ? { errorCode: error.code } : {}), ...(detail ? { detail } : {}),
      });
    this.release(job);
    const settled = this.options.store.get(job.id)!;
    this.onVideoSettled(settled);
    this.notifySettled(settled);
  }

  private release(job: CollectionJob): void {
    this.retryTimers.get(job.id)?.();
    this.retryTimers.delete(job.id);
    this.jobs.delete(job.id);
    this.stoppedJobs.delete(job.id);
    this.manualClaims.delete(job.id);
    const key = this.keys.get(job.id);
    this.keys.delete(job.id);
    if (key && this.activeByKey.get(key) === job.id) this.activeByKey.delete(key);
  }

  private notifySettled(job: CollectionJob): void {
    const waiters = this.settleWaiters.get(job.id) ?? [];
    this.settleWaiters.delete(job.id);
    for (const resolve of waiters) resolve(publicJob(job));
  }

  private update(job: CollectionJob, patch: Partial<CollectionJob>): void {
    Object.assign(job, patch, { updatedAt: this.now().toISOString() });
    this.options.store.put(job);
  }

  /** Records an event of `job` with what the activity view shows and filters by: title, subscription, parent and trigger. */
  private event(job: CollectionJob, entry: Omit<NewJobEvent, 'vaultPath' | 'jobId'>): void {
    const subscriptionId = this.subscriptionOf(job);
    this.options.store.event({
      ...entry, vaultPath: job.vaultPath, ...(job.vaultId ? { vaultId: job.vaultId } : {}), jobId: job.id,
      ...(job.source.id ? { sourceId: job.source.id } : {}),
      ...(job.source.title ? { sourceTitle: job.source.title } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      ...(job.parentId ? { parentJobId: job.parentId } : {}),
      ...(job.scope ? { trigger: job.scope.trigger } : {}),
    });
  }

  /** The channel a job collects for: its own channel, its parent channel job's, or the one a subscription request added. */
  private subscriptionOf(job: CollectionJob): string | null {
    if (job.kind === 'youtube.channel') return job.source.id;
    if (job.kind === 'youtube.channel-add') return job.result?.channelId ?? job.checkpoint?.subscribing?.channelId ?? null;
    if (!job.parentId) return null;
    const parent = this.jobs.get(job.parentId) ?? this.options.store.get(job.parentId);
    return parent?.kind === 'youtube.channel' ? parent.source.id : null;
  }
}

function clockTime(value: string): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** A channel job's item once the video job that collects it has finished. */
function settledItem(item: JobItem, video: CollectionJob): JobItem {
  const { wait: _wait, ...rest } = item;
  return {
    ...rest,
    state: video.state,
    outcome: video.result?.outcome === 'created' || video.result?.outcome === 'existing' || video.result?.outcome === 'skipped'
      ? video.result.outcome : null,
    ...(video.result?.skipReason ? { skipReason: video.result.skipReason } : {}),
    error: video.error,
    ...(video.retry ? { retry: video.retry } : {}),
  };
}

/** The job as UI and Agents read it; the checkpoint and the user-claim flag only serve restarts. */
function publicJob(job: CollectionJob): CollectionJob {
  const copy = { ...job };
  delete copy.checkpoint;
  delete copy.claimedByUser;
  return copy;
}

/** The dedupe key an accepted job holds while it is unfinished. */
function jobKey(job: CollectionJob): string {
  if (job.kind === 'youtube.video') return `video:${job.source.id}`;
  if (job.kind === 'youtube.channel') return `channel:${job.source.id}`;
  return `channel-add:${job.source.url.toLowerCase()}`;
}

function progressOf(items: JobItem[]): JobProgress {
  const progress: JobProgress = { total: items.length, done: 0, created: 0, existing: 0, failed: 0, skipped: 0 };
  for (const item of items) {
    if (ACTIVE.has(item.state)) continue;
    progress.done += 1;
    if (item.state === 'completed' && item.outcome) progress[item.outcome] = (progress[item.outcome] ?? 0) + 1;
    else progress.failed += 1;
  }
  return progress;
}

/** What a finished job's activity entry says; skip reasons and counts make the log readable on its own. */
function completionMessage(job: CollectionJob, result: JobResult): string {
  if (result.outcome === 'skipped') return `略過：${SKIP_MESSAGES[result.skipReason ?? 'out_of_range']}。`;
  if (job.kind === 'youtube.video') {
    const stored = result.outcome === 'created' ? '收集完成，文件已保存' : '文件已存在';
    return result.indexed === false ? `${stored}，搜尋更新失敗。` : `${stored}。`;
  }
  if (job.kind === 'youtube.channel-add') return result.outcome === 'created' ? '已訂閱，開始首次收集。' : '這個頻道已在訂閱清單中。';
  if (result.outcome === 'empty') return '收集完成，沒有新影片。';
  const progress = job.progress;
  if (!progress) return '收集完成。';
  const parts = [`新增 ${progress.created}`, `已存在 ${progress.existing}`];
  if (progress.skipped) parts.push(`略過 ${progress.skipped}`);
  if (progress.failed) parts.push(`失敗 ${progress.failed}`);
  return `收集完成：${parts.join('・')}。`;
}

const SKIP_MESSAGES: Record<SkipReason, string> = {
  out_of_range: '超出收集範圍', subscription_paused: '訂閱已暫停', subscription_removed: '訂閱已移除',
  superseded: '已由較新的工作接續', deleted: '文件已刪除',
};

/**
 * The latest time the user asked for this video by itself: a direct submission or a retry of one,
 * including a later direct submission merged into the same job, or a video a channel job queued
 * when the user also submitted it. Null for channel work.
 */
function explicitRequestTime(job: CollectionJob): string | null {
  if (job.kind !== 'youtube.video') return null;
  if (job.parentId === null) return job.checkpoint?.claimedAt ?? job.createdAt;
  return job.claimedByUser ? job.checkpoint?.claimedAt ?? null : null;
}

/** External tool output carried by the error, for the activity log's diagnostic detail. */
function diagnosticDetail(error: unknown): string | undefined {
  return error instanceof CollectorError && error.detail ? error.detail : undefined;
}

function errorDetails(error: unknown): JobError {
  // Job errors reach the UI, Agents and diagnostics, so credentials in a source's message are masked here too.
  if (error instanceof CollectorError) return { code: error.code, message: limitText(redact(error.message), 500, 'head') };
  return { code: 'capture_failed', message: '收集失敗，請稍後再試。' };
}

