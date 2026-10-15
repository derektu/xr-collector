import { randomUUID } from 'node:crypto';
import { discoverChannelVideos } from '../channels/channel-discovery.js';
import { BACKFILL_WINDOWS, backfillWindowStart, DEFAULT_POLICY, isBackfillLimit } from '../channels/collection-policy.js';
import type { ChannelStore } from '../channels/json-channel-store.js';
import type { Collector } from '../core/collector.js';
import {
  CollectorError,
  type BackfillWindow,
  type ChannelJobScope,
  type ChannelJobTrigger,
  type CollectionJob,
  type CollectionPolicy,
  type JobError,
  type JobItem,
  type JobKind,
  type JobPage,
  type JobPhase,
  type JobProgress,
  type JobResult,
  type JobRetry,
  type JobState,
  type JobSubmission,
  type SkipReason,
  type YouTubeChannel,
} from '../core/types.js';
import { parseYouTubeVideoUrl } from '../core/video-url.js';
import type { YouTubeSource } from '../sources/youtube/adapter.js';
import { classifyYouTubeInput } from '../sources/youtube/url.js';
import type { JobStore, NewJobEvent } from './job-store.js';

export interface JobLimits {
  /** Channel resolution and discovery running at once. */
  discovery: number;
  /** Single-video captures running at once. */
  capture: number;
  /** Jobs waiting in both queues together; further submissions are refused. */
  maxQueued: number;
}

export const DEFAULT_JOB_LIMITS: JobLimits = { discovery: 1, capture: 2, maxQueued: 500 };

/** Automatic retries after a transient failure (`network_error`). */
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

const RETRYABLE: ReadonlySet<string> = new Set(['network_error']);

/** A backfill scope for the policy in force when a job is accepted. */
export function backfillScope(trigger: ChannelJobTrigger, policy: CollectionPolicy, now: Date): ChannelJobScope {
  return {
    trigger,
    mode: 'backfill',
    windowStart: backfillWindowStart(now, policy.backfillWindow).toISOString(),
    maxItems: policy.backfillMaxItems,
    cursor: null,
  };
}

/**
 * Settings recovered from a subscription job's accepted first-collection range: its item limit and
 * the offered window nearest to its start, with the default interval. Anything the range does not
 * show takes the default.
 */
export function settingsFromScope(scope: ChannelJobScope | undefined, acceptedAt: string): CollectionPolicy {
  if (!scope || scope.mode !== 'backfill') return { ...DEFAULT_POLICY };
  const accepted = new Date(acceptedAt);
  const start = new Date(scope.windowStart).getTime();
  const distance = (window: BackfillWindow) => Math.abs(backfillWindowStart(accepted, window).getTime() - start);
  const backfillWindow = BACKFILL_WINDOWS.reduce((nearest, window) => (distance(window) < distance(nearest) ? window : nearest));
  return {
    intervalMinutes: DEFAULT_POLICY.intervalMinutes,
    backfillWindow,
    backfillMaxItems: isBackfillLimit(scope.maxItems) ? scope.maxItems : DEFAULT_POLICY.backfillMaxItems,
  };
}

export interface JobManagerOptions {
  /** The Vault every job of this manager writes to. */
  vaultPath: string;
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
}

export interface JobListQuery {
  state?: 'active' | 'all';
  limit?: number;
  cursor?: string;
}

const ACTIVE: ReadonlySet<JobState> = new Set(['queued', 'running']);

/**
 * Accepts collection work for one Vault, runs it in bounded queues and records every state change.
 * Discovery (channel resolution and video listing) and single-video capture use separate queues;
 * captures rotate between the jobs that queued them so one large channel cannot hold every slot.
 */
export class JobManager {
  private readonly limits: JobLimits;
  private readonly retry: RetryPolicy;
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
  /** Channel jobs whose discovery left newer videos for a follow-up batch. */
  private readonly backlogJobs = new Set<string>();
  /**
   * Running channel jobs of a paused or removed subscription, with the reason. They no longer hold
   * the channel's dedupe key, so a resume or new subscription starts its own job at once.
   */
  private readonly stoppedJobs = new Map<string, SkipReason>();
  /** Videos a channel job queued that the user then submitted directly; pausing never skips them. */
  private readonly manualClaims = new Set<string>();
  private closed = false;

  constructor(private readonly options: JobManagerOptions) {
    this.limits = { ...DEFAULT_JOB_LIMITS, ...options.limits };
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.setTimer = options.setTimer ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => randomUUID());
  }

  get vaultPath(): string { return this.options.vaultPath; }

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
   * source type's defaults when omitted) and its first collection uses their backfill range; an
   * existing subscription keeps its own state and settings.
   */
  async submitChannelAdd(url: string, settings: CollectionPolicy = DEFAULT_POLICY): Promise<JobSubmission> {
    const input = classifyYouTubeInput(url);
    if (input.kind !== 'channel') throw new CollectorError('invalid_channel', '請輸入 YouTube 頻道網址或 @handle。');
    const submission = this.enqueue('youtube.channel-add', `channel-add:${input.url.toLowerCase()}`, {
      id: null, url: input.url, title: null,
    }, null, { scope: backfillScope('subscribe', settings, this.now()), checkpoint: { settings: { ...settings } } });
    await this.options.store.flush();
    this.pump();
    return submission;
  }

  /** Starts one collection of a subscription; an active job of the same channel is returned instead. */
  async submitChannel(channel: YouTubeChannel, scope: ChannelJobScope): Promise<JobSubmission> {
    const submission = this.enqueueChannel(channel, scope);
    await this.options.store.flush();
    this.pump();
    return submission;
  }

  get(id: string): CollectionJob {
    const job = this.options.store.get(id);
    if (!job || job.vaultPath !== this.options.vaultPath) {
      throw new CollectorError('job_not_found', '找不到這個收集工作。');
    }
    return publicJob(job);
  }

  /** Top-level jobs, newest first. Videos a channel job started appear as that job's items. */
  list(query: JobListQuery = {}): JobPage {
    const limit = query.limit ?? 20;
    let jobs = this.options.store.list(this.options.vaultPath).filter((job) => job.parentId === null);
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
    for (const job of this.options.store.list(this.options.vaultPath)) {
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

  /** Records a Vault-level event, such as a subscription change, that belongs to no job. */
  recordEvent(entry: Omit<NewJobEvent, 'vaultPath' | 'jobId'>): void {
    this.options.store.event({ ...entry, vaultPath: this.options.vaultPath, jobId: null });
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
   * starts. Each job keeps its accepted scope, finished items, saved documents and failed attempts.
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
    for (const job of store.list(this.options.vaultPath)) {
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
        const scope = restored.scope ?? backfillScope('subscribe', DEFAULT_POLICY, this.now());
        this.update(restored, { source: { ...restored.source, id: subscribed.id, title: subscribed.title } });
        const followUp = this.enqueueChannel(subscribed, scope);
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
    // Channel jobs past discovery wait for their videos again and finish their cursor update.
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
      if (discovered?.backlog) this.backlogJobs.add(job.id);
      if (discovered && !discovered.cursorSaved) {
        const subscription = subscriptions.find((candidate) => candidate.id === job.source.id);
        // A later check already moved the subscription on; an older cursor must not replace it.
        if (subscription?.lastCheckedAt && subscription.lastCheckedAt > discovered.at) {
          this.update(job, { checkpoint: { ...job.checkpoint, discovered: { ...discovered, cursorSaved: true } } });
        } else {
          await this.saveCursor(job, job.source.id!);
        }
      }
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
    this.options.store.put(job);
    const stopReason = job.recovery?.lastStop ?? 'unknown';
    this.event(job, {
      severity: 'info', eventType: 'job.resumed', stopReason,
      message: stopReason === 'shutdown' ? '服務正常關閉後重新啟動，接續收集工作。'
        : stopReason === 'crash' ? '服務異常結束後重新啟動，接續收集工作。' : '服務重新啟動後接續收集工作。',
    });
    if (waitsForVideos || !options.queue) return job;
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

  /** Stops starting work, waits for running steps, and records what is left as interrupted. */
  async close(): Promise<void> {
    this.closed = true;
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
    for (const job of [...this.jobs.values()]) {
      this.options.store.interrupt(job, '服務停止時工作尚未完成；已保存的內容保留。', { stop: 'shutdown' });
      this.release(job);
      this.notifySettled(this.options.store.get(job.id)!);
    }
    this.discoveryQueue.length = 0;
    this.captureLanes.clear();
    this.laneOrder = [];
    await this.options.store.flush();
  }

  private enqueueVideo(url: string, parentId: string | null, publishedNotBefore: string | null = null): JobSubmission {
    const video = parseYouTubeVideoUrl(url);
    return this.enqueue('youtube.video', `video:${video.videoId}`, {
      id: video.videoId, url: video.canonicalUrl, title: null,
    }, parentId, publishedNotBefore ? { publishedNotBefore } : {});
  }

  private enqueueChannel(channel: YouTubeChannel, scope: ChannelJobScope): JobSubmission {
    return this.enqueue('youtube.channel', `channel:${channel.id}`, {
      id: channel.id, url: channel.url, title: channel.title,
    }, null, { scope });
  }

  private enqueue(
    kind: JobKind,
    key: string,
    source: Omit<CollectionJob['source'], 'type'>,
    parentId: string | null,
    extra: Pick<CollectionJob, 'scope' | 'publishedNotBefore' | 'checkpoint'> = {},
  ): JobSubmission {
    if (this.closed) throw new CollectorError('vault_busy', '服務正在停止，無法接受新的收集工作。');
    const activeId = this.activeByKey.get(key);
    if (activeId) {
      const active = this.jobs.get(activeId);
      if (active && parentId === null && active.parentId !== null && kind === 'youtube.video') {
        // A direct submission is the user's own request: no backfill bound and no subscription stop applies.
        this.manualClaims.add(active.id);
        delete active.publishedNotBefore;
        this.update(active, { claimedByUser: true });
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
    this.options.store.put(job);
    this.event(job, { severity: 'info', eventType: 'job.accepted', message: '已接受收集工作。' });
    return { job: structuredClone(job), deduplicated: false };
  }

  /** Puts a job back in line: videos in their lane, channel work in the discovery queue. */
  private requeue(job: CollectionJob): void {
    if (job.kind !== 'youtube.video') {
      this.discoveryQueue.push(job.id);
      return;
    }
    const lane = job.parentId ?? job.id;
    const queue = this.captureLanes.get(lane);
    if (queue) queue.push(job.id);
    else {
      this.captureLanes.set(lane, [job.id]);
      this.laneOrder.push(lane);
    }
  }

  private queuedCount(): number {
    let count = this.discoveryQueue.length;
    for (const queue of this.captureLanes.values()) count += queue.length;
    return count;
  }

  private pump(): void {
    if (this.closed) return;
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
    this.start(job, 'capture');
    try {
      const video = parseYouTubeVideoUrl(job.source.url);
      const { documents, source } = this.options;
      let document = await documents.findExisting(video.videoId);
      let outcome: 'created' | 'existing' = document && savedEarlier ? 'created' : 'existing';
      if (!document) {
        const captured = await source.capture(
          video, job.publishedNotBefore ? { publishedNotBefore: job.publishedNotBefore } : {},
        );
        this.update(job, { phase: 'save', source: { ...job.source, title: captured.title } });
        // The save phase is on disk before the document is, so a restart knows who saved it.
        await this.options.store.flush();
        document = await documents.save(captured);
        outcome = 'created';
        this.update(job, { checkpoint: { ...job.checkpoint, savedDocumentId: document.id } });
        this.event(job, {
          severity: 'info', eventType: 'document.saved', message: '文件已保存。', phase: 'save', documentId: document.id,
        });
      }
      this.update(job, { phase: 'index', source: { ...job.source, title: document.title } });
      const index = await documents.index(document);
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
      if (error instanceof CollectorError && error.code === 'out_of_range') {
        this.finish(job, 'completed', { outcome: 'skipped', skipReason: 'out_of_range' }, null);
        return;
      }
      this.failOrRetry(job, errorDetails(error));
    }
  }

  private async runDiscovery(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    try {
      if (job.kind === 'youtube.channel-add') await this.addChannel(job);
      else await this.discoverChannel(job);
    } catch (error) {
      // A step cut short by shutdown is left for close() to record as interrupted.
      if (this.closed) return;
      this.failOrRetry(job, errorDetails(error));
    }
  }

  /**
   * Schedules another attempt after a transient failure while attempts remain; otherwise the job
   * fails, and a job that was retried says how many attempts it made.
   */
  private failOrRetry(job: CollectionJob, error: JobError): void {
    const attempts = (job.retry?.attempts ?? 0) + 1;
    if (!RETRYABLE.has(error.code)) {
      this.finish(job, 'failed', { outcome: 'failed' }, error);
      return;
    }
    const maxAttempts = this.retry.maxAttempts;
    if (attempts >= maxAttempts) {
      this.update(job, { retry: { attempts, maxAttempts, nextAttemptAt: null, lastError: error } });
      this.notifyItemRetry(job);
      const message = attempts > 1 ? `${error.message}（已嘗試 ${attempts} 次）` : error.message;
      this.finish(job, 'failed', { outcome: 'failed' }, { code: error.code, message });
      return;
    }
    const delays = this.retry.delaysMs;
    const delay = delays[Math.min(attempts - 1, delays.length - 1)] ?? 0;
    const nextAttemptAt = new Date(this.now().getTime() + delay).toISOString();
    this.update(job, { state: 'queued', retry: { attempts, maxAttempts, nextAttemptAt, lastError: error } });
    this.event(job, {
      severity: 'warning', eventType: 'job.retry_scheduled',
      message: `第 ${attempts} 次嘗試失敗，稍後自動重試：${error.message}`,
      errorCode: error.code, attempt: attempts, nextAttemptAt, ...(job.phase ? { phase: job.phase } : {}),
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

  private async addChannel(job: CollectionJob): Promise<void> {
    this.start(job, 'resolve');
    // A job interrupted while subscribing already knows its channel and may have added it.
    const subscribing = job.checkpoint?.subscribing;
    const resolved = subscribing
      ? { id: subscribing.channelId, title: subscribing.title, url: subscribing.url }
      : await this.options.source.resolveChannel(job.source.url);
    const existing = (await this.options.channels.list()).find((channel) => channel.id === resolved.id);
    // The service stopped while resolving; close() records the job as interrupted.
    if (this.closed) return;
    if (existing && subscribing) {
      this.update(job, { source: { ...job.source, id: existing.id, title: existing.title } });
      const scope = job.scope ?? backfillScope('subscribe', existing.settings, this.now());
      const followUp = this.enqueueChannel(existing, scope);
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
      ...resolved, enabled: true, addedAt: now.toISOString(), cursor: null, lastCheckedAt: null, backlog: false,
      settings: { ...settings }, lastDispatchedAt: now.toISOString(),
      nextCheckAt: new Date(now.getTime() + settings.intervalMinutes * 60_000).toISOString(),
    });
    this.recordEvent({ severity: 'info', eventType: 'subscription.added', message: `已訂閱「${channel.title}」。`, sourceId: channel.id });
    this.update(job, { source: { ...job.source, id: channel.id, title: channel.title } });
    const scope = job.scope ?? backfillScope('subscribe', settings, this.now());
    const followUp = this.enqueueChannel(channel, scope);
    this.finish(job, 'completed', {
      outcome: 'created', channelId: channel.id, followUpJobId: followUp.job.id,
    }, null);
  }

  /**
   * The settings a subscription job subscribes with: the ones accepted with it, or for a job
   * accepted before subscriptions had their own settings, the shared settings the Vault's
   * conversion gave every other subscription, else what its accepted range shows.
   */
  private async acceptedSettings(job: CollectionJob): Promise<CollectionPolicy> {
    if (job.checkpoint?.settings) return job.checkpoint.settings;
    const legacy = await this.options.legacySettings?.();
    return legacy ? { ...legacy } : settingsFromScope(job.scope, job.createdAt);
  }

  private async discoverChannel(job: CollectionJob): Promise<void> {
    this.start(job, 'discover');
    const channel: YouTubeChannel = {
      id: job.source.id!, title: job.source.title ?? job.source.id!, url: job.source.url, enabled: true, addedAt: job.createdAt,
      settings: DEFAULT_POLICY,
    };
    // Jobs accepted before scopes existed collect like a first subscription with the default policy.
    const scope = job.scope ?? backfillScope('scheduled', DEFAULT_POLICY, new Date(job.createdAt));
    const discovery = await discoverChannelVideos(
      this.options.source, channel, scope, async (videoId) => (await this.options.documents.findExisting(videoId)) !== null,
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
        const submission = this.enqueueVideo(video.url, job.id, discovery.publishedNotBefore);
        item.jobId = submission.job.id;
        item.state = submission.job.state;
        const watching = this.watchers.get(submission.job.id) ?? new Set<string>();
        watching.add(job.id);
        this.watchers.set(submission.job.id, watching);
      } catch (error) {
        item.state = 'failed';
        item.error = errorDetails(error);
      }
      return item;
    });
    // A video that could not be queued (for example, a full queue) must be found again, so the cursor stays.
    const allAccepted = items.every((item) => item.jobId !== null);
    if (discovery.backlog && allAccepted) this.backlogJobs.add(job.id);
    const discovered = {
      at: this.now().toISOString(),
      cursor: discovery.cursor && allAccepted ? discovery.cursor : null,
      backlog: discovery.backlog && allAccepted,
      cursorSaved: false,
    };
    this.update(job, { phase: 'capture', items, progress: progressOf(items), checkpoint: { ...job.checkpoint, discovered } });
    this.event(job, {
      severity: 'info', eventType: 'channel.discovered', message: `發現 ${items.length} 支影片。`, phase: 'discover',
    });
    // The cursor moves only after the accepted videos are recorded, so a stop in between finds them again.
    await this.options.store.flush();
    if (this.stoppedJobs.has(job.id)) {
      // Stopped while its videos were being recorded; a later job owns the subscription and its cursor.
      this.completeChannelIfDone(job);
      return;
    }
    const saved = await this.saveCursor(job, channel.id);
    if (!saved) this.stopChannel(channel.id, 'subscription_removed');
    else if (!saved.enabled) this.stopChannel(channel.id, 'subscription_paused');
    if (this.jobs.has(job.id)) this.completeChannelIfDone(job);
  }

  /** Moves the subscription cursor past the videos the job recorded; returns the subscription, or null once removed. */
  private async saveCursor(job: CollectionJob, channelId: string): Promise<YouTubeChannel | null> {
    const discovered = job.checkpoint!.discovered!;
    const saved = await this.options.channels.update(channelId, {
      ...(discovered.cursor ? { cursor: discovered.cursor } : {}),
      lastCheckedAt: discovered.at,
      backlog: discovered.backlog,
    });
    this.update(job, { checkpoint: { ...job.checkpoint, discovered: { ...discovered, cursorSaved: true } } });
    return saved;
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
    const stopped = this.stoppedJobs.delete(job.id);
    // A stopped job never asks for a follow-up batch.
    const backlog = this.backlogJobs.delete(job.id) && !stopped ? { backlog: true } : {};
    if (items.length === 0) {
      this.finish(job, 'completed', { outcome: 'empty', ...backlog }, null);
    } else if (progress.failed === items.length) {
      this.finish(job, 'failed', { outcome: 'failed', ...backlog }, { code: 'all_items_failed', message: '這個頻道的影片都收集失敗。' });
    } else {
      const outcome = progress.failed > 0 ? 'partial' : progress.created > 0 ? 'created'
        : progress.existing > 0 ? 'existing' : 'skipped';
      const skipReason = outcome === 'skipped' ? items.find((item) => item.skipReason)?.skipReason : undefined;
      this.finish(job, 'completed', { outcome, ...(skipReason ? { skipReason } : {}), ...backlog }, null);
    }
  }

  private start(job: CollectionJob, phase: JobPhase): void {
    const timestamp = this.now().toISOString();
    this.update(job, {
      state: 'running', phase, startedAt: job.startedAt ?? timestamp,
      ...(job.retry ? { retry: { ...job.retry, nextAttemptAt: null } } : {}),
    });
    // Channel items stop showing the wait once the next attempt starts.
    this.notifyItemRetry(job);
    this.event(job, { severity: 'info', eventType: 'job.started', message: '開始執行收集工作。', phase });
  }

  private finish(job: CollectionJob, state: 'completed' | 'failed', result: JobResult, error: JobError | null): void {
    this.update(job, { state, result, error, finishedAt: this.now().toISOString() });
    this.event(job, state === 'completed'
      ? { severity: 'info', eventType: 'job.completed', message: '收集工作完成。', outcome: result.outcome }
      : {
        severity: 'error', eventType: 'job.failed', message: error?.message ?? '收集工作失敗。', outcome: result.outcome,
        ...(error ? { errorCode: error.code } : {}),
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
    this.backlogJobs.delete(job.id);
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

  private event(job: CollectionJob, entry: Omit<NewJobEvent, 'vaultPath' | 'jobId'>): void {
    this.options.store.event({
      ...entry, vaultPath: job.vaultPath, jobId: job.id, ...(job.source.id ? { sourceId: job.source.id } : {}),
    });
  }
}

/** A channel job's item once the video job that collects it has finished. */
function settledItem(item: JobItem, video: CollectionJob): JobItem {
  return {
    ...item,
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

function errorDetails(error: unknown): JobError {
  if (error instanceof CollectorError) return { code: error.code, message: error.message };
  return { code: 'capture_failed', message: '收集失敗，請稍後再試。' };
}
