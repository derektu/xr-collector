import { randomUUID } from 'node:crypto';
import { discoverChannelVideos } from '../channels/channel-discovery.js';
import { backfillWindowStart, DEFAULT_POLICY } from '../channels/collection-policy.js';
import type { ChannelStore } from '../channels/json-channel-store.js';
import type { Collector } from '../core/collector.js';
import {
  CollectorError,
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

export interface JobManagerOptions {
  /** The Vault every job of this manager writes to. */
  vaultPath: string;
  store: JobStore;
  source: YouTubeSource;
  documents: Collector;
  channels: ChannelStore;
  limits?: Partial<JobLimits>;
  /** The Global policy a new subscription's first collection snapshots. */
  policy?: () => Promise<CollectionPolicy>;
  now?: () => Date;
  createId?: () => string;
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
   * Resolves a channel address and subscribes to it. A new subscription starts its first collection
   * with the backfill range of the policy in force now; an existing one is left as it is.
   */
  async submitChannelAdd(url: string): Promise<JobSubmission> {
    const input = classifyYouTubeInput(url);
    if (input.kind !== 'channel') throw new CollectorError('invalid_channel', '請輸入 YouTube 頻道網址或 @handle。');
    const policy = await (this.options.policy?.() ?? Promise.resolve(DEFAULT_POLICY));
    const submission = this.enqueue('youtube.channel-add', `channel-add:${input.url.toLowerCase()}`, {
      id: null, url: input.url, title: null,
    }, null, { scope: backfillScope('subscribe', policy, this.now()) });
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
    return job;
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
    const page = jobs.slice(0, limit);
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

  /** Stops starting work, waits for running steps, and records what is left as interrupted. */
  async close(): Promise<void> {
    this.closed = true;
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
    for (const job of [...this.jobs.values()]) {
      this.options.store.interrupt(job, '服務停止時工作尚未完成；已保存的內容保留。');
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
    extra: Pick<CollectionJob, 'scope' | 'publishedNotBefore'> = {},
  ): JobSubmission {
    if (this.closed) throw new CollectorError('vault_busy', '服務正在停止，無法接受新的收集工作。');
    const activeId = this.activeByKey.get(key);
    if (activeId) {
      const active = this.jobs.get(activeId);
      if (active && parentId === null && active.parentId !== null && kind === 'youtube.video') {
        // A direct submission is the user's own request: no backfill bound and no subscription stop applies.
        this.manualClaims.add(active.id);
        if (active.publishedNotBefore) {
          delete active.publishedNotBefore;
          this.update(active, {});
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
    if (kind === 'youtube.video') {
      const lane = parentId ?? job.id;
      const queue = this.captureLanes.get(lane);
      if (queue) queue.push(job.id);
      else {
        this.captureLanes.set(lane, [job.id]);
        this.laneOrder.push(lane);
      }
    } else {
      this.discoveryQueue.push(job.id);
    }
    this.options.store.put(job);
    this.event(job, { severity: 'info', eventType: 'job.accepted', message: '已接受收集工作。' });
    return { job: structuredClone(job), deduplicated: false };
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
    this.start(job, 'capture');
    try {
      const video = parseYouTubeVideoUrl(job.source.url);
      const { documents, source } = this.options;
      let document = await documents.findExisting(video.videoId);
      let outcome: 'created' | 'existing' = 'existing';
      if (!document) {
        const captured = await source.capture(
          video, job.publishedNotBefore ? { publishedNotBefore: job.publishedNotBefore } : {},
        );
        this.update(job, { phase: 'save', source: { ...job.source, title: captured.title } });
        document = await documents.save(captured);
        outcome = 'created';
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
      this.finish(job, 'failed', { outcome: 'failed' }, errorDetails(error));
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
      this.finish(job, 'failed', { outcome: 'failed' }, errorDetails(error));
    }
  }

  private async addChannel(job: CollectionJob): Promise<void> {
    this.start(job, 'resolve');
    const resolved = await this.options.source.resolveChannel(job.source.url);
    const existing = (await this.options.channels.list()).find((channel) => channel.id === resolved.id);
    // The service stopped while resolving; close() records the job as interrupted.
    if (this.closed) return;
    if (existing) {
      // An existing subscription keeps its own state; a paused one is resumed explicitly.
      this.update(job, { source: { ...job.source, id: existing.id, title: existing.title } });
      this.finish(job, 'completed', { outcome: 'existing', channelId: existing.id }, null);
      return;
    }
    const channel = await this.options.channels.add({
      ...resolved, enabled: true, addedAt: this.now().toISOString(), cursor: null, lastCheckedAt: null, backlog: false,
    });
    this.recordEvent({ severity: 'info', eventType: 'subscription.added', message: `已訂閱「${channel.title}」。`, sourceId: channel.id });
    this.update(job, { source: { ...job.source, id: channel.id, title: channel.title } });
    const scope = job.scope ?? backfillScope('subscribe', DEFAULT_POLICY, this.now());
    const followUp = this.enqueueChannel(channel, scope);
    this.finish(job, 'completed', {
      outcome: 'created', channelId: channel.id, followUpJobId: followUp.job.id,
    }, null);
  }

  private async discoverChannel(job: CollectionJob): Promise<void> {
    this.start(job, 'discover');
    const channel: YouTubeChannel = {
      id: job.source.id!, title: job.source.title ?? job.source.id!, url: job.source.url, enabled: true, addedAt: job.createdAt,
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
    this.update(job, { phase: 'capture', items, progress: progressOf(items) });
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
    const saved = await this.options.channels.update(channel.id, {
      ...(discovery.cursor && allAccepted ? { cursor: discovery.cursor } : {}),
      lastCheckedAt: this.now().toISOString(),
      backlog: discovery.backlog && allAccepted,
    });
    if (!saved) this.stopChannel(channel.id, 'subscription_removed');
    else if (!saved.enabled) this.stopChannel(channel.id, 'subscription_paused');
    if (this.jobs.has(job.id)) this.completeChannelIfDone(job);
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
      const items = channel.items.map((item) => item.jobId === video.id ? {
        ...item,
        state: video.state,
        outcome: video.result?.outcome === 'created' || video.result?.outcome === 'existing' || video.result?.outcome === 'skipped'
          ? video.result.outcome : null,
        ...(video.result?.skipReason ? { skipReason: video.result.skipReason } : {}),
        error: video.error,
      } : item);
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
    this.update(job, { state: 'running', phase, startedAt: job.startedAt ?? timestamp });
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
    for (const resolve of waiters) resolve(job);
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
