import type { ChannelStore } from './json-channel-store.js';
import type { ChannelRemoval } from './subscription-files.js';
import { assertPolicyPatch, DEFAULT_POLICY } from './collection-policy.js';
import type { JobManager } from '../jobs/job-manager.js';
import type { ResolvedYouTubeChannel } from '../sources/youtube/adapter.js';
import { classifyYouTubeInput } from '../sources/youtube/url.js';
import {
  CollectorError,
  type ChannelJobTrigger,
  type ChannelPreview,
  type CollectionJob,
  type CollectionPolicy,
  type DocumentMetadata,
  type JobSubmission,
  type PendingSubscription,
  type Subscription,
  type SubscriptionCheckStatus,
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

/** How long removing a subscription with its documents waits for the captures already running. */
export const REMOVAL_SETTLE_MS = 30_000;

/** What happens to a removed subscription's documents. */
export type RemovedDocuments = 'keep' | 'delete';

export interface ChannelRemovalResult {
  /** Documents of the channel left in the Vault. */
  documentsKept: number;
  /**
   * Documents deleted with the subscription; each leaves a deletion record. A capture its deletion
   * record stopped from saving never became a document and is not counted; one that saved first is.
   */
  documentsDeleted: number;
  /** Documents the removal tried to delete and could not; they stay in the Vault. */
  documentsFailed: number;
}

/** A deletion record for a video that has no document yet. */
export interface PendingDeletion {
  sourceType: 'youtube';
  sourceId: string;
  sourceUrl: string;
  title: string;
  publisherId: string;
  publisherName: string;
}

export interface ChannelCollectorOptions {
  /** Whether automatic collection is on; previews report it. */
  autoCollection: () => Promise<boolean>;
  /** Resolves a channel for a preview; aborting `signal` drops a request that has not started. */
  resolveChannel: (url: string, signal: AbortSignal) => Promise<ResolvedYouTubeChannel>;
  documents: () => Promise<DocumentMetadata[]>;
  /** Deletes one document as a user deletion does; required to remove a subscription with its documents. */
  deleteDocument?: (id: string) => Promise<unknown>;
  /** Records the deletion of a video still capturing, so it is not saved when the capture ends. */
  recordDeletion?: (entry: PendingDeletion) => Promise<unknown>;
  /**
   * Whether the subscription's source needs the user to sign in again. YouTube needs no account,
   * so its subscriptions never do.
   */
  loginRequired?: (channel: YouTubeChannel) => boolean;
  now?: () => Date;
  previewTimeoutMs?: number;
  /** Overrides REMOVAL_SETTLE_MS. */
  removalSettleMs?: number;
}

export interface StartRunRequest {
  trigger: Extract<ChannelJobTrigger, 'scheduled' | 'manual'>;
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
  /** The check a resume started. */
  submission: JobSubmission | null;
}

/** Subscriptions and the entry points that turn them into collection jobs. */
export class ChannelCollector {
  private readonly now: () => Date;

  constructor(
    private readonly store: ChannelStore,
    private readonly jobs: JobManager,
    private readonly options: ChannelCollectorOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  listChannels(): Promise<YouTubeChannel[]> {
    return this.store.list();
  }

  /** Subscriptions with their current job, check status, document count and newest collection time. */
  async listSubscriptions(): Promise<Subscription[]> {
    const [channels, documents, autoCheck] = await Promise.all([this.store.list(), this.options.documents(), this.options.autoCollection()]);
    const counts = new Map<string, { count: number; latest: string | null }>();
    for (const document of documents) {
      if (document.sourceType !== 'youtube' || !document.publisher.id) continue;
      const entry = counts.get(document.publisher.id) ?? { count: 0, latest: null };
      entry.count += 1;
      if (!entry.latest || document.collectedAt > entry.latest) entry.latest = document.collectedAt;
      counts.set(document.publisher.id, entry);
    }
    const history = this.jobs.channelJobs();
    const now = this.now();
    return channels.map((channel) => {
      const job = this.jobs.activeChannelJob(channel.id);
      const totals = counts.get(channel.id);
      const lastDeciding = (history.get(channel.id) ?? []).find((candidate) => DECIDING.has(candidate.state));
      const failed = channel.enabled && !job && lastDeciding?.state === 'failed';
      return {
        ...channel,
        lastCheckedAt: channel.lastCheckedAt ?? null,
        nextCheckAt: channel.nextCheckAt ?? null,
        lastDispatchedAt: channel.lastDispatchedAt ?? null,
        status: !channel.enabled ? 'paused' : job ? 'collecting' : failed ? 'error' : 'tracking',
        checkStatus: checkStatus(channel, job, { autoCheck, now, loginRequired: this.options.loginRequired?.(channel) ?? false }),
        capturing: this.jobs.pendingCaptures(channel.id).channelVideos.length > 0,
        lastError: failed ? lastDeciding.error ?? { code: 'capture_failed', message: '收集失敗。' } : null,
        activeJob: job ? { id: job.id, done: job.progress?.done ?? 0, total: job.progress?.total ?? 0 } : null,
        documentCount: totals?.count ?? 0,
        lastCollectedAt: totals?.latest ?? null,
      };
    });
  }

  /**
   * Subscription requests still resolving their channel. A request that already subscribed its
   * channel is left out, since the subscription itself is listed.
   */
  async pendingSubscriptions(): Promise<PendingSubscription[]> {
    const subscribed = new Set((await this.store.list()).map((channel) => channel.id));
    return this.jobs.activeChannelAdds()
      .filter((entry) => !entry.channelId || !subscribed.has(entry.channelId))
      .map(({ job, title }) => ({
        jobId: job.id, url: job.source.url, title,
        checkStatus: job.state === 'running' && !job.wait ? { state: 'updating', done: 0, total: 0 } : { state: 'queued' },
      }));
  }

  /** The Vault's removal records: subscriptions removed and not added again. */
  async listRemovals(): Promise<ChannelRemoval[]> {
    return await this.store.removals?.() ?? [];
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
      (signal) => this.options.resolveChannel(input.url, signal),
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
   * Accepts a channel address; the job resolves it, subscribes and runs the first check. Settings
   * left out of `settings` take the source type's defaults.
   */
  async addChannel(inputUrl: string, settings: Partial<CollectionPolicy> = {}): Promise<JobSubmission> {
    assertPolicyPatch(settings);
    return this.jobs.submitChannelAdd(inputUrl, { ...DEFAULT_POLICY, ...settings });
  }

  /**
   * Changes one subscription's settings. A new interval counts from the subscription's last check
   * and is due at once if that time has passed; a new range applies to every check whose discovery
   * starts afterwards, queued ones included. No work starts.
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
   * them too and stay paused, so the check a later resume starts uses them. No work starts.
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
   * Pausing stops the subscription's queued work; resuming starts a check. Setting the state it
   * already has changes nothing.
   */
  async setChannelEnabled(id: string, enabled: boolean): Promise<ChannelEnabledResult> {
    const current = (await this.store.list()).find((channel) => channel.id === id);
    if (!current) throw notFound();
    if (current.enabled === enabled) return { channel: current, submission: null };
    if (!enabled) {
      const channel = await this.store.update(id, { enabled: false, nextCheckAt: null });
      if (!channel) throw notFound();
      this.jobs.stopChannel(id, 'subscription_paused');
      this.jobs.recordEvent({ severity: 'info', eventType: 'subscription.paused', message: `已暫停「${channel.title}」。`, ...subject(id, channel.title) });
      return { channel, submission: null };
    }
    const now = this.now();
    const channel = await this.store.update(id, {
      enabled: true,
      lastDispatchedAt: now.toISOString(), nextCheckAt: addMinutes(now, current.settings.intervalMinutes).toISOString(),
    });
    if (!channel) throw notFound();
    this.jobs.recordEvent({ severity: 'info', eventType: 'subscription.resumed', message: `已恢復「${channel.title}」。`, ...subject(id, channel.title) });
    const submission = await this.jobs.submitChannel(channel, 'resume');
    return { channel, submission };
  }

  /**
   * Stops collecting a channel. With `documents: 'keep'` its documents stay in the Vault. With
   * `'delete'`, the videos of the channel still capturing (from any of its checks, a stopped one
   * included) first get deletion records, so one that finishes at any later time is not saved.
   * The removal then waits a bounded time for those captures and for single-video requests, whose
   * channel is known only after capture, and deletes every document of the channel one by one as a
   * user deletion does: each leaves a deletion record, leaves the search and records its own event.
   * A single-video request still running after the bound deletes its document when it ends, if the
   * document belongs to the channel. A document that cannot be deleted is counted and kept; the
   * removal itself always completes and records its event.
   */
  async removeChannel(id: string, options: { documents?: RemovedDocuments } = {}): Promise<ChannelRemovalResult> {
    const removing = options.documents ?? 'keep';
    const deleteDocument = this.options.deleteDocument;
    if (removing === 'delete' && !deleteDocument) throw new CollectorError('invalid_request', '這個知識庫不支援刪除文件。');
    const channel = (await this.store.list()).find((candidate) => candidate.id === id);
    if (!channel || !(await this.store.remove(id))) throw notFound();
    this.jobs.stopChannel(id, 'subscription_removed');
    let deleted = 0;
    let failed = 0;
    let incomplete = false;
    try {
      if (removing === 'delete' && deleteDocument) {
        const { channelVideos, singleVideos } = this.jobs.pendingCaptures(id);
        for (const video of channelVideos) {
          if (!video.source.id) continue;
          try {
            await this.options.recordDeletion?.({
              sourceType: 'youtube', sourceId: video.source.id, sourceUrl: video.source.url, title: video.source.title ?? video.source.id,
              publisherId: id, publisherName: channel.title,
            });
          } catch (error) {
            console.error('Deletion record for a capturing video failed', error);
          }
        }
        const unsettled = new Set(singleVideos.map((video) => video.id));
        const settling = [
          ...channelVideos.map((video) => this.jobs.whenSettled(video.id)),
          ...singleVideos.map((video) => this.jobs.whenSettled(video.id).finally(() => unsettled.delete(video.id))),
        ];
        await settleWithin(Promise.allSettled(settling), this.options.removalSettleMs ?? REMOVAL_SETTLE_MS);
        for (const jobId of unsettled) void this.deleteWhenSaved(jobId, id, deleteDocument);
        for (const document of await this.channelDocuments(id)) {
          const outcome = await deleteQuietly(deleteDocument, document.id);
          if (outcome === 'deleted') deleted += 1;
          else if (outcome === 'failed') failed += 1;
        }
      }
    } catch (error) {
      console.error('Deleting the documents of a removed subscription failed', error);
      incomplete = true;
    }
    const kept = await this.channelDocuments(id).then((documents) => documents.length, () => failed);
    if (incomplete) failed = Math.max(failed, kept);
    const message = removing === 'keep' ? `已移除「${channel.title}」，文件保留。`
      : failed > 0 ? `已移除「${channel.title}」，刪除 ${deleted} 份文件，${failed} 份無法刪除。`
        : `已移除「${channel.title}」，並刪除 ${deleted} 份文件。`;
    this.jobs.recordEvent({
      severity: failed > 0 ? 'warning' : 'info', eventType: 'subscription.removed', message,
      ...subject(id, channel.title),
    });
    return { documentsKept: kept, documentsDeleted: deleted, documentsFailed: failed };
  }

  /** Deletes the document a single-video request saves, once it ends, when it belongs to the removed channel. */
  private async deleteWhenSaved(jobId: string, channelId: string, deleteDocument: (id: string) => Promise<unknown>): Promise<void> {
    try {
      const job = await this.jobs.whenSettled(jobId);
      const documentId = job.result?.documentId;
      if (!documentId) return;
      const document = (await this.channelDocuments(channelId)).find((candidate) => candidate.id === documentId);
      if (document) await deleteQuietly(deleteDocument, document.id);
    } catch (error) {
      console.error('Deleting a document of a removed subscription failed', error);
    }
  }

  private async channelDocuments(id: string): Promise<DocumentMetadata[]> {
    return (await this.options.documents()).filter((document) => document.sourceType === 'youtube' && document.publisher.id === id);
  }

  /**
   * Submits one collection job per subscription: the listed ones, or every enabled one. A channel
   * whose job is still queued or running returns that job, so the check joins it. Each checked
   * subscription's next automatic check moves on, also when it joined an active job: a scheduled
   * check keeps its rhythm from the time that came due, any other dispatch counts an interval from now.
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
    for (const channel of selected) submissions.push(await this.jobs.submitChannel(channel, request.trigger));
    const ids = new Set(selected.map((channel) => channel.id));
    // Computed from the current rows, so a settings change made meanwhile keeps its interval and
    // a subscription paused meanwhile gets no next check.
    await this.store.updateWith((channels) => new Map(channels
      .filter((channel) => ids.has(channel.id) && channel.enabled)
      .map((channel) => [channel.id, {
        lastDispatchedAt: now.toISOString(), nextCheckAt: nextCheckAfterDispatch(channel, request.trigger, now).toISOString(),
      }] as const)));
    return submissions;
  }

  whenSettled(jobId: string): Promise<CollectionJob> {
    return this.jobs.whenSettled(jobId);
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

/**
 * What a subscription is doing now. Its own state comes first: paused, then a source that needs a
 * new sign-in. An active check shows as updating unless it waits for its turn: the check has not
 * started, none of the items it still has to collect is running because other work holds the
 * capture slot, or every such item waits for a cooldown or a retry. Then it is queued. Without a check,
 * automatic checks being off comes next; a check that came due and was not dispatched yet, or has
 * no time yet, is queued; otherwise the next check time shows. A failed last check does not change the status.
 */
export function checkStatus(
  channel: Pick<YouTubeChannel, 'enabled' | 'nextCheckAt'>,
  job: CollectionJob | null,
  context: { autoCheck: boolean; now: Date; loginRequired: boolean },
): SubscriptionCheckStatus {
  if (!channel.enabled) return { state: 'paused' };
  if (context.loginRequired) return { state: 'login_required' };
  if (job) {
    if (job.state === 'queued' || waitsForTurn(job)) return { state: 'queued' };
    return { state: 'updating', done: job.progress?.done ?? 0, total: job.progress?.total ?? 0 };
  }
  if (!context.autoCheck) return { state: 'auto_check_off' };
  const next = channel.nextCheckAt ?? null;
  // Without a time yet, the scheduler plans one at its next round, so the check waits like a due one.
  if (!next || new Date(next).getTime() <= context.now.getTime()) return { state: 'queued' };
  return { state: 'scheduled', nextCheckAt: next };
}

/**
 * A running channel job that is not collecting anything itself: its own step waits for a cooldown
 * or a retry, none of its unfinished items is running, or every unfinished item waits.
 */
function waitsForTurn(job: CollectionJob): boolean {
  if (job.wait || job.retry?.nextAttemptAt) return true;
  const unfinished = (job.items ?? []).filter((item) => item.state === 'queued' || item.state === 'running');
  if (unfinished.length === 0) return false;
  return unfinished.every((item) => item.state === 'queued' || item.wait || item.retry?.nextAttemptAt);
}

/** Deletes one document; one deleted meanwhile, such as by an Agent, counts as gone, and any other failure is logged. */
async function deleteQuietly(deleteDocument: (id: string) => Promise<unknown>, id: string): Promise<'deleted' | 'gone' | 'failed'> {
  try {
    await deleteDocument(id);
    return 'deleted';
  } catch (error) {
    if (error instanceof CollectorError && (error.code === 'document_deleted' || error.code === 'document_not_found')) return 'gone';
    console.error('Document deletion failed', error);
    return 'failed';
  }
}

/** Waits for `work` at most `timeoutMs`; only the end of the wait matters, not its result. */
async function settleWithin(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([work.then(() => undefined, () => undefined), timeout]).finally(() => clearTimeout(timer));
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function notFound(): CollectorError {
  return new CollectorError('channel_not_found', '找不到這個 YouTube 頻道訂閱。');
}

/** Runs `work` for at most `timeoutMs`; on timeout its signal aborts, so a request still waiting its turn is dropped. */
function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new CollectorError('network_error', '解析頻道逾時，請稍後再試。');
      abort.abort(error);
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([work(abort.signal), timeout]).finally(() => clearTimeout(timer));
}

/** The fields that tie a subscription event to its channel, so the activity view can show and filter it by source. */
function subject(id: string, title: string): { sourceId: string; sourceTitle: string; subscriptionId: string } {
  return { sourceId: id, sourceTitle: title, subscriptionId: id };
}
