import type { ChannelStore } from './json-channel-store.js';
import { assertPolicyPatch, catchUpThresholdMs, DEFAULT_POLICY } from './collection-policy.js';
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

/**
 * Channel job states that decide whether a subscription shows an error: the latest completed or
 * failed job. An interrupted job (a shutdown or restart) says nothing about the source, so it
 * neither raises nor clears an error.
 */
const DECIDING = new Set(['completed', 'failed']);

/** A channel preview resolves synchronously; a slower lookup reports a network problem instead of hanging. */
export const PREVIEW_TIMEOUT_MS = 60_000;

export interface ChannelCollectorOptions {
  /** Whether automatic collection is on; previews report it. */
  autoCollection: () => Promise<boolean>;
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

/** What applying one subscription's settings to the others of its type changed. */
export interface ApplySettingsResult {
  /** Subscriptions that took the settings, paused ones included. */
  updated: number;
  /** How many of them are paused; they keep the settings for their next resume. */
  paused: number;
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
    const history = this.jobs.channelJobs();
    return channels.map((channel) => {
      const job = this.jobs.activeChannelJob(channel.id);
      const totals = counts.get(channel.id);
      const lastDeciding = (history.get(channel.id) ?? []).find((candidate) => DECIDING.has(candidate.state));
      const failed = channel.enabled && !job && lastDeciding?.state === 'failed';
      return {
        ...channel,
        cursor: channel.cursor ?? null,
        lastCheckedAt: channel.lastCheckedAt ?? null,
        backlog: channel.backlog ?? false,
        nextCheckAt: channel.nextCheckAt ?? null,
        lastDispatchedAt: channel.lastDispatchedAt ?? null,
        status: !channel.enabled ? 'paused' : job ? 'collecting' : failed ? 'error' : 'tracking',
        lastError: failed ? lastDeciding.error ?? { code: 'capture_failed', message: '收集失敗。' } : null,
        activeJob: job ? { id: job.id, done: job.progress?.done ?? 0, total: job.progress?.total ?? 0 } : null,
        documentCount: totals?.count ?? 0,
        lastCollectedAt: totals?.latest ?? null,
      };
    });
  }

  /** Channel jobs of one subscription, newest first, as far back as the job history keeps them. */
  channelJobs(id: string): CollectionJob[] {
    return this.jobs.channelJobs().get(id) ?? [];
  }

  /** Resolves a channel address now and reports its subscription state and the settings it uses or would start with. */
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
      subscription: existing ? { enabled: existing.enabled, settings: existing.settings } : null,
      settings: existing?.settings ?? DEFAULT_POLICY,
      autoCollection: await this.options.autoCollection(),
    };
  }

  /**
   * Accepts a channel address; the job resolves it, subscribes and runs the first backfill. Settings
   * left out of `settings` take the source type's defaults.
   */
  async addChannel(inputUrl: string, settings: Partial<CollectionPolicy> = {}): Promise<JobSubmission> {
    assertPolicyPatch(settings);
    return this.jobs.submitChannelAdd(inputUrl, { ...DEFAULT_POLICY, ...settings });
  }

  /**
   * Changes one subscription's settings. A new interval counts from the subscription's last check
   * and is due at once if that time has passed; backfill settings apply to its next backfill. No
   * work starts, and accepted jobs keep the range they were accepted with.
   */
  async updateSettings(id: string, patch: Partial<CollectionPolicy>): Promise<YouTubeChannel> {
    assertPolicyPatch(patch);
    const now = this.now();
    const [channel] = await this.store.updateWith((channels) => {
      const current = channels.find((candidate) => candidate.id === id);
      return new Map(current ? [[id, settingsPatch(current, { ...current.settings, ...patch }, now)]] : []);
    });
    if (!channel) throw notFound();
    this.jobs.recordEvent({ severity: 'info', eventType: 'subscription.settings_updated', message: `已更新「${channel.title}」的收集設定。`, ...subject(id, channel.title) });
    return channel;
  }

  /**
   * Gives every other subscription of the same type this subscription's settings. Paused ones take
   * them too and stay paused, so a later resume backfills with them. No work starts.
   */
  async applySettingsToAll(id: string): Promise<ApplySettingsResult> {
    const now = this.now();
    let source: YouTubeChannel | undefined;
    const updated = await this.store.updateWith((channels) => {
      source = channels.find((channel) => channel.id === id);
      const settings = source?.settings;
      if (!settings) return new Map();
      return new Map(channels
        .filter((channel) => channel.id !== id)
        .map((channel) => [channel.id, settingsPatch(channel, settings, now)] as const));
    });
    if (!source) throw notFound();
    const paused = updated.filter((channel) => !channel.enabled).length;
    this.jobs.recordEvent({
      severity: 'info', eventType: 'subscription.settings_applied',
      message: `已把「${source.title}」的收集設定套用到其他 ${updated.length} 個 YouTube 頻道。`, ...subject(id, source.title),
    });
    return { updated: updated.length, paused };
  }

  /**
   * Gives every enabled subscription a next check time an interval from now: all of them when
   * `reset` (automatic collection was turned on), otherwise those without one.
   */
  async planChecks(options: { reset: boolean }): Promise<void> {
    const now = this.now();
    await this.store.updateWith((channels) => new Map(channels
      .filter((channel) => channel.enabled && (options.reset || !channel.nextCheckAt))
      .map((channel) => [channel.id, { nextCheckAt: addMinutes(now, channel.settings.intervalMinutes).toISOString() }] as const)));
  }

  /**
   * Pausing stops the subscription's queued work; resuming forgets the cursor and starts a backfill
   * with the subscription's settings. Setting the state it already has changes nothing.
   */
  async setChannelEnabled(id: string, enabled: boolean): Promise<ChannelEnabledResult> {
    const current = (await this.store.list()).find((channel) => channel.id === id);
    if (!current) throw notFound();
    if (current.enabled === enabled) return { channel: current, submission: null };
    if (!enabled) {
      const channel = await this.store.update(id, { enabled: false, backlog: false, nextCheckAt: null });
      if (!channel) throw notFound();
      this.jobs.stopChannel(id, 'subscription_paused');
      this.jobs.recordEvent({ severity: 'info', eventType: 'subscription.paused', message: `已暫停「${channel.title}」。`, ...subject(id, channel.title) });
      return { channel, submission: null };
    }
    const now = this.now();
    const channel = await this.store.update(id, {
      enabled: true, cursor: null, backlog: false,
      lastDispatchedAt: now.toISOString(), nextCheckAt: addMinutes(now, current.settings.intervalMinutes).toISOString(),
    });
    if (!channel) throw notFound();
    this.jobs.recordEvent({ severity: 'info', eventType: 'subscription.resumed', message: `已恢復「${channel.title}」。`, ...subject(id, channel.title) });
    const submission = await this.jobs.submitChannel(channel, backfillScope('resume', channel.settings, now));
    return { channel, submission };
  }

  /** Stops collecting a channel. Its documents stay in the Vault; their count is returned. */
  async removeChannel(id: string): Promise<{ documentsKept: number }> {
    const channel = (await this.store.list()).find((candidate) => candidate.id === id);
    if (!channel || !(await this.store.remove(id))) throw notFound();
    this.jobs.stopChannel(id, 'subscription_removed');
    this.jobs.recordEvent({ severity: 'info', eventType: 'subscription.removed', message: `已移除「${channel.title}」，文件保留。`, ...subject(id, channel.title) });
    const documents = await this.options.documents();
    return { documentsKept: documents.filter((document) => document.publisher.id === id).length };
  }

  /**
   * Submits one collection job per subscription: the listed ones, or every enabled one. A channel
   * whose job is still active returns that job, and its cursor waits for the next check. Each
   * checked subscription's next automatic check moves on, also when it joined an active job: a
   * scheduled check keeps its rhythm from the time that came due, any other dispatch counts an
   * interval from now. A follow-up batch continues a check and moves nothing.
   */
  async startRun(request: StartRunRequest): Promise<JobSubmission[]> {
    const allChannels = await this.store.list();
    let selected: YouTubeChannel[];
    if (request.channelIds && request.trigger === 'scheduled') {
      // Due subscriptions were read a moment ago; one paused or removed since then is left out.
      const ids = new Set(request.channelIds);
      selected = allChannels.filter((channel) => ids.has(channel.id) && channel.enabled);
    } else if (request.channelIds) {
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
    const now = this.now();
    const submissions: JobSubmission[] = [];
    for (const channel of selected) {
      const submission = await this.jobs.submitChannel(channel, this.scopeFor(channel, request.trigger));
      submissions.push(submission);
      if (!submission.deduplicated) this.followBacklog(submission.job.id, channel.id);
    }
    if (request.trigger !== 'backlog') {
      const ids = new Set(selected.map((channel) => channel.id));
      // Computed from the current rows, so a settings change made meanwhile keeps its interval and
      // a subscription paused meanwhile gets no next check.
      await this.store.updateWith((channels) => new Map(channels
        .filter((channel) => ids.has(channel.id) && channel.enabled)
        .map((channel) => [channel.id, {
          lastDispatchedAt: now.toISOString(), nextCheckAt: nextCheckAfterDispatch(channel, request.trigger, now).toISOString(),
        }] as const)));
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
  private scopeFor(channel: YouTubeChannel, trigger: StartRunRequest['trigger']): ChannelJobScope {
    const now = this.now();
    const { settings } = channel;
    const backfill = backfillScope(trigger, settings, now);
    const lastChecked = channel.lastCheckedAt ? new Date(channel.lastCheckedAt).getTime() : null;
    if (!channel.cursor || lastChecked === null || lastChecked < this.startedAt.getTime()
      || now.getTime() - lastChecked > catchUpThresholdMs(settings.intervalMinutes)) {
      return backfill;
    }
    return { ...backfill, mode: 'incremental', cursor: channel.cursor };
  }

  /** Resumed channel jobs that left newer videos behind are followed by the next batch, as when they started. */
  followResumedBacklogs(): void {
    for (const [channelId] of this.jobs.channelJobs()) {
      const job = this.jobs.activeChannelJob(channelId);
      if (job) this.followBacklog(job.id, channelId);
    }
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

/**
 * The store change that gives `channel` new settings. A new interval on an enabled subscription
 * counts from its last dispatch and is due at once if that time has passed.
 */
function settingsPatch(channel: YouTubeChannel, settings: CollectionPolicy, now: Date): Partial<YouTubeChannel> {
  const patch: Partial<YouTubeChannel> = { settings: { ...settings } };
  if (channel.enabled && settings.intervalMinutes !== channel.settings.intervalMinutes) {
    const next = addMinutes(channel.lastDispatchedAt ? new Date(channel.lastDispatchedAt) : now, settings.intervalMinutes);
    patch.nextCheckAt = (next.getTime() < now.getTime() ? now : next).toISOString();
  }
  return patch;
}

/**
 * A scheduled check keeps the subscription's rhythm: the next check is whole intervals after the
 * one that came due, the first of them after `now`, so polling delay never accumulates and missed
 * periods are not checked one by one. Any other dispatch counts an interval from `now`.
 */
function nextCheckAfterDispatch(channel: YouTubeChannel, trigger: StartRunRequest['trigger'], now: Date): Date {
  const interval = channel.settings.intervalMinutes * 60_000;
  if (trigger !== 'scheduled' || !channel.nextCheckAt) return new Date(now.getTime() + interval);
  const due = new Date(channel.nextCheckAt).getTime();
  const periods = Math.max(1, Math.floor((now.getTime() - due) / interval) + 1);
  return new Date(due + periods * interval);
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
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

/** The fields that tie a subscription event to its channel, so the activity view can show and filter it by source. */
function subject(id: string, title: string): { sourceId: string; sourceTitle: string; subscriptionId: string } {
  return { sourceId: id, sourceTitle: title, subscriptionId: id };
}
