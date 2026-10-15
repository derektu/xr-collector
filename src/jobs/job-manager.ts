import { randomUUID } from 'node:crypto';
import type { ChannelStore } from '../channels/json-channel-store.js';
import type { Collector } from '../core/collector.js';
import {
  CollectorError,
  type CollectionJob,
  type JobError,
  type JobItem,
  type JobKind,
  type JobPage,
  type JobPhase,
  type JobProgress,
  type JobResult,
  type JobState,
  type JobSubmission,
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
/** Videos a channel collection job looks at, newest first. */
export const CHANNEL_VIDEO_LIMIT = 10;

export interface JobManagerOptions {
  /** The Vault every job of this manager writes to. */
  vaultPath: string;
  store: JobStore;
  source: YouTubeSource;
  documents: Collector;
  channels: ChannelStore;
  limits?: Partial<JobLimits>;
  channelVideoLimit?: number;
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
  private readonly channelVideoLimit: number;
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
  private closed = false;

  constructor(private readonly options: JobManagerOptions) {
    this.limits = { ...DEFAULT_JOB_LIMITS, ...options.limits };
    this.channelVideoLimit = options.channelVideoLimit ?? CHANNEL_VIDEO_LIMIT;
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

  /** Resolves a channel address, adds the channel and starts one collection of its recent videos. */
  async submitChannelAdd(url: string): Promise<JobSubmission> {
    const input = classifyYouTubeInput(url);
    if (input.kind !== 'channel') throw new CollectorError('invalid_channel', '請輸入 YouTube 頻道網址或 @handle。');
    const submission = this.enqueue('youtube.channel-add', `channel-add:${input.url.toLowerCase()}`, {
      id: null, url: input.url, title: null,
    }, null);
    await this.options.store.flush();
    this.pump();
    return submission;
  }

  async submitChannel(channel: YouTubeChannel): Promise<JobSubmission> {
    const submission = this.enqueueChannel(channel);
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

  private enqueueVideo(url: string, parentId: string | null): JobSubmission {
    const video = parseYouTubeVideoUrl(url);
    return this.enqueue('youtube.video', `video:${video.videoId}`, {
      id: video.videoId, url: video.canonicalUrl, title: null,
    }, parentId);
  }

  private enqueueChannel(channel: YouTubeChannel): JobSubmission {
    return this.enqueue('youtube.channel', `channel:${channel.id}`, {
      id: channel.id, url: channel.url, title: channel.title,
    }, null);
  }

  private enqueue(kind: JobKind, key: string, source: Omit<CollectionJob['source'], 'type'>, parentId: string | null): JobSubmission {
    if (this.closed) throw new CollectorError('vault_busy', '服務正在停止，無法接受新的收集工作。');
    const activeId = this.activeByKey.get(key);
    if (activeId) return { job: this.get(activeId), deduplicated: true };
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
        const captured = await source.capture(video);
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
    const channel = existing ?? await this.options.channels.add({
      ...resolved, enabled: true, addedAt: this.now().toISOString(),
    });
    // The service stopped while resolving; close() records the job as interrupted.
    if (this.closed) return;
    this.update(job, { source: { ...job.source, id: channel.id, title: channel.title } });
    const followUp = this.enqueueChannel(channel);
    this.finish(job, 'completed', {
      outcome: existing ? 'existing' : 'created', channelId: channel.id, followUpJobId: followUp.job.id,
    }, null);
  }

  private async discoverChannel(job: CollectionJob): Promise<void> {
    this.start(job, 'discover');
    const channel: YouTubeChannel = {
      id: job.source.id!, title: job.source.title ?? job.source.id!, url: job.source.url, enabled: true, addedAt: job.createdAt,
    };
    const videos = await this.options.source.discover(channel, this.channelVideoLimit);
    // The service stopped while discovering; close() records the job as interrupted.
    if (this.closed) return;
    const items: JobItem[] = videos.map((video) => {
      const item: JobItem = {
        sourceId: video.id, title: video.title, url: video.url, jobId: null, state: 'queued', outcome: null, error: null,
      };
      try {
        const submission = this.enqueueVideo(video.url, job.id);
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
    this.update(job, { phase: 'capture', items, progress: progressOf(items) });
    this.event(job, {
      severity: 'info', eventType: 'channel.discovered', message: `發現 ${items.length} 支影片。`, phase: 'discover',
    });
    this.completeChannelIfDone(job);
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
        outcome: video.result?.outcome === 'created' || video.result?.outcome === 'existing' ? video.result.outcome : null,
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
    if (items.length === 0) {
      this.finish(job, 'completed', { outcome: 'empty' }, null);
    } else if (progress.failed === items.length) {
      this.finish(job, 'failed', { outcome: 'failed' }, { code: 'all_items_failed', message: '這個頻道的影片都收集失敗。' });
    } else {
      const outcome = progress.failed > 0 ? 'partial' : progress.created > 0 ? 'created' : 'existing';
      this.finish(job, 'completed', { outcome }, null);
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
  const progress: JobProgress = { total: items.length, done: 0, created: 0, existing: 0, failed: 0 };
  for (const item of items) {
    if (ACTIVE.has(item.state)) continue;
    progress.done += 1;
    if (item.state === 'completed' && item.outcome) progress[item.outcome] += 1;
    else progress.failed += 1;
  }
  return progress;
}

function errorDetails(error: unknown): JobError {
  if (error instanceof CollectorError) return { code: error.code, message: error.message };
  return { code: 'capture_failed', message: '收集失敗，請稍後再試。' };
}
