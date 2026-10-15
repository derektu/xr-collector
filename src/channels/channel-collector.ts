import type { ChannelStore } from './json-channel-store.js';
import { catchUpThresholdMs } from './collection-policy.js';
import { backfillScope, type JobManager } from '../jobs/job-manager.js';
import type { ResolvedYouTubeChannel } from '../sources/youtube/adapter.js';
import { classifyYouTubeInput } from '../sources/youtube/url.js';
import {
  CollectorError,
  type ChannelJobScope,
  type ChannelJobTrigger,
  type ChannelPreview,
  type CollectionJob,
  type CollectionPolicy,
  type DocumentMetadata,
  type JobSubmission,
  type Subscription,
  type YouTubeChannel,
} from '../core/types.js';

/** A channel preview resolves synchronously; a slower lookup reports a network problem instead of hanging. */
export const PREVIEW_TIMEOUT_MS = 60_000;

export type SchedulePolicy = CollectionPolicy & { enabled: boolean };

export interface ChannelCollectorOptions {
  /** The Global settings in force; read whenever a job's scope is decided. */
  policy: () => Promise<SchedulePolicy>;
  resolveChannel: (url: string) => Promise<ResolvedYouTubeChannel>;
  documents: () => Promise<DocumentMetadata[]>;
  now?: () => Date;
  previewTimeoutMs?: number;
}

export interface StartRunRequest {
  trigger: Extract<ChannelJobTrigger, 'scheduled' | 'manual' | 'backlog'>;
  /** Only these subscriptions; by default every enabled one. */
  channelIds?: string[];
}

export interface ChannelEnabledResult {
  channel: YouTubeChannel;
  /** The backfill job a resume started. */
  submission: JobSubmission | null;
}

/** Subscriptions and the entry points that turn them into collection jobs. */
export class ChannelCollector {
  private readonly now: () => Date;
  /** Subscriptions not checked since this time are checked with backfill limits, as after a restart. */
  private readonly startedAt: Date;

  constructor(
    private readonly store: ChannelStore,
    private readonly jobs: JobManager,
    private readonly options: ChannelCollectorOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.startedAt = this.now();
  }

  listChannels(): Promise<YouTubeChannel[]> {
    return this.store.list();
  }

  /** Subscriptions with their current job, document count and newest collection time. */
  async listSubscriptions(): Promise<Subscription[]> {
    const [channels, documents] = await Promise.all([this.store.list(), this.options.documents()]);
    const counts = new Map<string, { count: number; latest: string | null }>();
    for (const document of documents) {
      if (document.sourceType !== 'youtube' || !document.publisher.id) continue;
      const entry = counts.get(document.publisher.id) ?? { count: 0, latest: null };
      entry.count += 1;
      if (!entry.latest || document.collectedAt > entry.latest) entry.latest = document.collectedAt;
      counts.set(document.publisher.id, entry);
    }
    return channels.map((channel) => {
      const job = this.jobs.activeChannelJob(channel.id);
      const totals = counts.get(channel.id);
      return {
        ...channel,
        cursor: channel.cursor ?? null,
        lastCheckedAt: channel.lastCheckedAt ?? null,
        backlog: channel.backlog ?? false,
        status: !channel.enabled ? 'paused' : job ? 'collecting' : 'tracking',
        activeJob: job ? { id: job.id, done: job.progress?.done ?? 0, total: job.progress?.total ?? 0 } : null,
        documentCount: totals?.count ?? 0,
        lastCollectedAt: totals?.latest ?? null,
      };
    });
  }

  /** Resolves a channel address now and reports its subscription state and the policy a subscription would use. */
  async preview(url: string): Promise<ChannelPreview> {
    const input = classifyYouTubeInput(url);
    if (input.kind !== 'channel') throw new CollectorError('invalid_channel', '請輸入 YouTube 頻道網址或 @handle。');
    const channel = await withTimeout(
      this.options.resolveChannel(input.url),
      this.options.previewTimeoutMs ?? PREVIEW_TIMEOUT_MS,
    );
    const existing = (await this.store.list()).find((candidate) => candidate.id === channel.id);
    return {
      channel: { id: channel.id, title: existing?.title ?? channel.title, url: channel.url },
      subscription: existing ? { enabled: existing.enabled } : null,
      policy: await this.options.policy(),
    };
  }

  /** Accepts a channel address; the job resolves it, subscribes and runs the first backfill. */
  addChannel(inputUrl: string): Promise<JobSubmission> {
    return this.jobs.submitChannelAdd(inputUrl);
  }

  /**
   * Pausing stops the subscription's queued work; resuming forgets the cursor and starts a backfill
   * with the current policy. Setting the state it already has changes nothing.
   */
  async setChannelEnabled(id: string, enabled: boolean): Promise<ChannelEnabledResult> {
    const current = (await this.store.list()).find((channel) => channel.id === id);
    if (!current) throw notFound();
    if (current.enabled === enabled) return { channel: current, submission: null };
    if (!enabled) {
      const channel = await this.store.update(id, { enabled: false, backlog: false });
      if (!channel) throw notFound();
      this.jobs.stopChannel(id, 'subscription_paused');
      this.jobs.recordEvent({ severity: 'info', eventType: 'subscription.paused', message: `已暫停「${channel.title}」。`, sourceId: id });
      return { channel, submission: null };
    }
    const channel = await this.store.update(id, { enabled: true, cursor: null, backlog: false });
    if (!channel) throw notFound();
    this.jobs.recordEvent({ severity: 'info', eventType: 'subscription.resumed', message: `已恢復「${channel.title}」。`, sourceId: id });
    const submission = await this.jobs.submitChannel(channel, backfillScope('resume', await this.options.policy(), this.now()));
    return { channel, submission };
  }

  /** Stops collecting a channel. Its documents stay in the Vault; their count is returned. */
  async removeChannel(id: string): Promise<{ documentsKept: number }> {
    const channel = (await this.store.list()).find((candidate) => candidate.id === id);
    if (!channel || !(await this.store.remove(id))) throw notFound();
    this.jobs.stopChannel(id, 'subscription_removed');
    this.jobs.recordEvent({ severity: 'info', eventType: 'subscription.removed', message: `已移除「${channel.title}」，文件保留。`, sourceId: id });
    const documents = await this.options.documents();
    return { documentsKept: documents.filter((document) => document.publisher.id === id).length };
  }

  /**
   * Submits one collection job per subscription: the listed ones, or every enabled one. A channel
   * whose job is still active returns that job, and its cursor waits for the next check.
   */
  async startRun(request: StartRunRequest): Promise<JobSubmission[]> {
    const allChannels = await this.store.list();
    let selected: YouTubeChannel[];
    if (request.channelIds) {
      selected = [...new Set(request.channelIds)].map((id) => {
        const channel = allChannels.find((candidate) => candidate.id === id);
        if (!channel) throw notFound();
        if (!channel.enabled) throw new CollectorError('channel_paused', `「${channel.title}」已暫停，請先恢復訂閱。`);
        return channel;
      });
    } else {
      selected = allChannels.filter((channel) => channel.enabled);
    }
    if (selected.length === 0) {
      if (request.trigger === 'scheduled') return [];
      throw new CollectorError('invalid_request', '沒有可檢查的訂閱。');
    }
    const policy = await this.options.policy();
    const submissions: JobSubmission[] = [];
    for (const channel of selected) {
      const submission = await this.jobs.submitChannel(channel, this.scopeFor(channel, request.trigger, policy));
      submissions.push(submission);
      if (!submission.deduplicated) this.followBacklog(submission.job.id, channel.id);
    }
    return submissions;
  }

  whenSettled(jobId: string): Promise<CollectionJob> {
    return this.jobs.whenSettled(jobId);
  }

  /**
   * Backfill when the subscription has no cursor or was not checked successfully since this service
   * started or within the catch-up threshold; otherwise incremental from the cursor.
   */
  private scopeFor(channel: YouTubeChannel, trigger: StartRunRequest['trigger'], policy: SchedulePolicy): ChannelJobScope {
    const now = this.now();
    const backfill = backfillScope(trigger, policy, now);
    const lastChecked = channel.lastCheckedAt ? new Date(channel.lastCheckedAt).getTime() : null;
    if (!channel.cursor || lastChecked === null || lastChecked < this.startedAt.getTime()
      || now.getTime() - lastChecked > catchUpThresholdMs(policy.intervalMinutes)) {
      return backfill;
    }
    return { ...backfill, mode: 'incremental', cursor: channel.cursor };
  }

  /** A job that left newer videos behind is followed at once by the next batch while the subscription stays enabled. */
  private followBacklog(jobId: string, channelId: string): void {
    void this.jobs.whenSettled(jobId).then(async (job) => {
      if (!job.result?.backlog) return;
      const channel = (await this.store.list()).find((candidate) => candidate.id === channelId);
      if (!channel?.enabled) return;
      await this.startRun({ trigger: 'backlog', channelIds: [channelId] });
    }).catch((error: unknown) => console.error('Follow-up channel batch failed', error));
  }
}

function notFound(): CollectorError {
  return new CollectorError('channel_not_found', '找不到這個 YouTube 頻道訂閱。');
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CollectorError('network_error', '解析頻道逾時，請稍後再試。')), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
