import type { SubscriptionStore } from './subscription-store.js';
import type { SubscriptionRemoval } from './subscription-files.js';
import type { CheckActivity, JobManager } from '../jobs/job-manager.js';
import type { CheckPlan, CheckReport, SubscribeResult, SubscriptionPort } from '../jobs/subscription-port.js';
import { requireDefinition, subscriptionKindLabel } from '../core/source-registry.js';
import type { FailureClass, SourceDefinition, SubscriptionDeclaration, SubscriptionTarget } from '../plugins/types.js';
import {
  CollectorError,
  type ChannelJobTrigger,
  type CollectionJob,
  type DocumentMetadata,
  type ItemFailureEntry,
  type JobError,
  type JobSubmission,
  MAX_CHECK_ATTEMPTS,
  type OutOfRangeEntry,
  type PendingSubscription,
  type Subscription,
  type SubscriptionCheckStatus,
  type SubscriptionPreview,
  type SubscriptionRecord,
  type SkipReason,
  type SubscriptionSettings,
} from '../core/types.js';

/** A preview resolves synchronously; a slower lookup reports a network problem instead of hanging. */
export const PREVIEW_TIMEOUT_MS = 60_000;

/** How long removing a subscription with its documents waits for the captures already running. */
export const REMOVAL_SETTLE_MS = 30_000;

/** What happens to a removed subscription's documents. */
export type RemovedDocuments = 'keep' | 'delete';

export interface SubscriptionRemovalResult {
  /** Documents of the subscription left in the Vault. */
  documentsKept: number;
  /**
   * Documents deleted with the subscription; each leaves a deletion record. A capture its deletion
   * record stopped from saving never became a document and is not counted; one that saved first is.
   */
  documentsDeleted: number;
  /** Documents the removal tried to delete and could not; they stay in the Vault. */
  documentsFailed: number;
}

/** A deletion record for an item that has no document yet. */
export interface PendingDeletion {
  sourceType: string;
  sourceId: string;
  sourceUrl: string;
  title: string;
  publisherId: string;
  publisherName: string;
}

export interface SubscriptionServiceOptions {
  /** Whether automatic collection is on; previews report it. */
  autoCollection: () => Promise<boolean>;
  /** Resolves a subscription address for a preview; aborting `signal` drops a request that has not started. */
  resolveTarget: (url: string, signal: AbortSignal) => Promise<SubscriptionTarget>;
  documents: () => Promise<DocumentMetadata[]>;
  /** Deletes one document as a user deletion does; required to remove a subscription with its documents. */
  deleteDocument?: (id: string) => Promise<unknown>;
  /** Records the deletion of an item still capturing, so it is not saved when the capture ends. */
  recordDeletion?: (entry: PendingDeletion) => Promise<unknown>;
  /** Whether the subscription's source needs the user to sign in again; a source without accounts never does. */
  loginRequired?: (subscription: SubscriptionRecord) => boolean;
  now?: () => Date;
  previewTimeoutMs?: number;
  /** Overrides REMOVAL_SETTLE_MS. */
  removalSettleMs?: number;
}

/** Which subscriptions of the service's type a check covers, and why it runs. */
export interface StartRunRequest {
  trigger: Extract<ChannelJobTrigger, 'scheduled' | 'manual'>;
  /** Only these subscriptions; by default every enabled one. */
  subscriptionIds?: string[];
}

/** What applying one subscription's settings to the others of its type changed. */
export interface ApplySettingsResult {
  /** Subscriptions that took the settings, paused ones included. */
  updated: number;
  /** How many of them are paused; they keep the settings for their next resume. */
  paused: number;
}

export interface EnabledResult {
  subscription: SubscriptionRecord;
  /** The check a resume started. */
  submission: JobSubmission | null;
}

/**
 * The subscriptions of one source type and the entry points that turn them into collection jobs.
 * Every subscription is known by its type and its ID within the type. The service is the only
 * writer of its subscriptions: it creates them, dispatches every check, which moves the dispatch
 * times, and records what checks report as collection progress.
 */
export class SubscriptionService {
  private readonly now: () => Date;
  private readonly definition: SourceDefinition;
  private readonly subscription: SubscriptionDeclaration;

  constructor(
    readonly type: string,
    private readonly store: SubscriptionStore,
    private readonly jobs: JobManager,
    private readonly options: SubscriptionServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.definition = requireDefinition(type);
    if (!this.definition.subscription) throw new Error(`Source type ${type} has no subscriptions`);
    this.subscription = this.definition.subscription;
  }

  list(): Promise<SubscriptionRecord[]> {
    return this.store.list();
  }

  /** Subscriptions with their current job, check status, document count and newest collection time. */
  async listSubscriptions(): Promise<Subscription[]> {
    const [records, documents, autoCheck] = await Promise.all([this.store.list(), this.options.documents(), this.options.autoCollection()]);
    const counts = new Map<string, { count: number; latest: string | null }>();
    for (const document of documents) {
      if (document.sourceType !== this.type || !document.publisher.id) continue;
      const entry = counts.get(document.publisher.id) ?? { count: 0, latest: null };
      entry.count += 1;
      if (!entry.latest || document.collectedAt > entry.latest) entry.latest = document.collectedAt;
      counts.set(document.publisher.id, entry);
    }
    const work = this.jobs.subscriptionWork(this.type).subscriptions;
    const now = this.now();
    return records.map((record) => {
      const { check = null, capturing = false, lastCheck = null } = work.get(record.id) ?? {};
      const totals = counts.get(record.id);
      // An interrupted check says nothing about the source, so only a completed or failed one decides the error.
      const failed = record.enabled && !check && lastCheck?.state === 'failed';
      return {
        ...record,
        lastCheckedAt: record.lastCheckedAt ?? null,
        nextCheckAt: record.nextCheckAt ?? null,
        lastDispatchedAt: record.lastDispatchedAt ?? null,
        status: !record.enabled ? 'paused' : check ? 'collecting' : failed ? 'error' : 'tracking',
        checkStatus: checkStatus(record, check, { autoCheck, now, loginRequired: this.options.loginRequired?.(record) ?? false }),
        capturing,
        lastError: failed ? lastCheck.error ?? { code: 'capture_failed', message: '收集失敗。' } : null,
        activeJob: check ? { id: check.jobId, done: check.done, total: check.total } : null,
        documentCount: totals?.count ?? 0,
        lastCollectedAt: totals?.latest ?? null,
      };
    });
  }

  /**
   * Subscription requests still resolving their address. A request that already subscribed its
   * target is left out, since the subscription itself is listed.
   */
  async pendingSubscriptions(): Promise<PendingSubscription[]> {
    const subscribed = new Set((await this.store.list()).map((record) => record.id));
    return this.jobs.subscriptionWork(this.type).adds
      .filter((entry) => !entry.targetId || !subscribed.has(entry.targetId))
      .map(({ jobId, url, title, status }) => ({
        type: this.type, jobId, url, title,
        checkStatus: status.state === 'queued' || status.state === 'retrying' ? status : { state: 'adding' },
      }));
  }

  /** The Vault's removal records: subscriptions removed and not added again. */
  async listRemovals(): Promise<SubscriptionRemoval[]> {
    return await this.store.removals?.() ?? [];
  }

  /** Check jobs of one subscription, newest first, as far back as the job history keeps them. */
  checkJobs(id: string): CollectionJob[] {
    return this.jobs.checkJobs(this.type).get(id) ?? [];
  }

  /** Resolves a subscription address now and reports its subscription state and the settings it uses or would start with. */
  async preview(url: string): Promise<SubscriptionPreview> {
    const input = this.definition.classify(url);
    if (input.kind !== 'subscription') throw new CollectorError('invalid_subscription', this.definition.prompts.subscriptionInput);
    const target = await withTimeout(
      (signal) => this.options.resolveTarget(input.url, signal),
      this.options.previewTimeoutMs ?? PREVIEW_TIMEOUT_MS,
      `解析${this.subscription.targetNoun}逾時，請稍後再試。`,
    );
    const existing = (await this.store.list()).find((candidate) => candidate.id === target.id);
    return {
      type: this.type,
      target: { id: target.id, title: existing?.title ?? target.title, url: target.url },
      subscription: existing ? { enabled: existing.enabled, settings: existing.settings } : null,
      settings: existing?.settings ?? this.subscription.defaults,
      autoCollection: await this.options.autoCollection(),
    };
  }

  /**
   * Accepts a subscription address; the job resolves it, subscribes and runs the first check.
   * Settings left out of `settings` take the source type's defaults.
   */
  async add(inputUrl: string, settings: Partial<SubscriptionSettings> = {}): Promise<JobSubmission> {
    this.subscription.parseSettingsPatch(settings, { allowEmpty: true });
    return this.jobs.submitSubscriptionAdd(this.type, inputUrl, { ...this.subscription.defaults, ...settings } as SubscriptionSettings);
  }

  /**
   * Changes one subscription's settings. A new interval counts from the subscription's last check
   * and is due at once if that time has passed; a new range applies to every check whose discovery
   * starts afterwards, queued ones included. No work starts.
   */
  async updateSettings(id: string, patch: Partial<SubscriptionSettings>): Promise<SubscriptionRecord> {
    this.subscription.parseSettingsPatch(patch, { allowEmpty: true });
    const now = this.now();
    const [record] = await this.store.updateWith((records) => {
      const current = records.find((candidate) => candidate.id === id);
      return new Map(current ? [[id, settingsPatch(current, { ...current.settings, ...patch } as SubscriptionSettings, now)]] : []);
    });
    if (!record) throw this.notFound();
    this.jobs.recordEvent({ severity: 'info', eventType: 'subscription.settings_updated', message: `已更新「${record.title}」的收集設定。`, ...this.subject(id, record.title) });
    return record;
  }

  /**
   * Gives every other subscription of the same type this subscription's settings. Paused ones take
   * them too and stay paused, so the check a later resume starts uses them. No work starts.
   */
  async applySettingsToAll(id: string): Promise<ApplySettingsResult> {
    const now = this.now();
    let source: SubscriptionRecord | undefined;
    const updated = await this.store.updateWith((records) => {
      source = records.find((record) => record.id === id);
      const settings = source?.settings;
      if (!settings) return new Map();
      return new Map(records
        .filter((record) => record.id !== id)
        .map((record) => [record.id, settingsPatch(record, settings, now)] as const));
    });
    if (!source) throw this.notFound();
    const paused = updated.filter((record) => !record.enabled).length;
    this.jobs.recordEvent({
      severity: 'info', eventType: 'subscription.settings_applied',
      message: `已把「${source.title}」的收集設定套用到其他 ${updated.length} 個 ${subscriptionKindLabel(this.type)}。`, ...this.subject(id, source.title),
    });
    return { updated: updated.length, paused };
  }

  /**
   * Gives every enabled subscription a next check time an interval from now: all of them when
   * `reset` (automatic collection was turned on), otherwise those without one.
   */
  async planChecks(options: { reset: boolean }): Promise<void> {
    const now = this.now();
    await this.store.updateWith((records) => new Map(records
      .filter((record) => record.enabled && (options.reset || !record.nextCheckAt))
      .map((record) => [record.id, { nextCheckAt: addMinutes(now, record.settings.intervalMinutes).toISOString() }] as const)));
  }

  /**
   * Pausing stops the subscription's queued work; resuming starts a check. Setting the state it
   * already has changes nothing.
   */
  async setEnabled(id: string, enabled: boolean): Promise<EnabledResult> {
    const current = (await this.store.list()).find((record) => record.id === id);
    if (!current) throw this.notFound();
    if (current.enabled === enabled) return { subscription: current, submission: null };
    if (!enabled) {
      const record = await this.store.update(id, { enabled: false, nextCheckAt: null });
      if (!record) throw this.notFound();
      this.jobs.stopSubscription(this.type, id, 'subscription_paused');
      this.jobs.recordEvent({ severity: 'info', eventType: 'subscription.paused', message: `已暫停「${record.title}」。`, ...this.subject(id, record.title) });
      return { subscription: record, submission: null };
    }
    const now = this.now();
    const record = await this.store.update(id, {
      enabled: true,
      lastDispatchedAt: now.toISOString(), nextCheckAt: addMinutes(now, current.settings.intervalMinutes).toISOString(),
    });
    if (!record) throw this.notFound();
    this.jobs.recordEvent({ severity: 'info', eventType: 'subscription.resumed', message: `已恢復「${record.title}」。`, ...this.subject(id, record.title) });
    const submission = await this.jobs.submitCheck(this.type, record, 'resume');
    return { subscription: record, submission };
  }

  /**
   * Stops collecting a subscription. With `documents: 'keep'` its documents stay in the Vault. With
   * `'delete'`, the items of the subscription still capturing (from any of its checks, a stopped one
   * included) first get deletion records, so one that finishes at any later time is not saved.
   * The removal then waits a bounded time for those captures and for single-item requests, whose
   * publisher is known only after capture, and deletes every document of the subscription one by
   * one as a user deletion does: each leaves a deletion record, leaves the search and records its
   * own event. A single-item request still running after the bound deletes its document when it
   * ends, if the document belongs to the subscription. A document that cannot be deleted is counted
   * and kept; the removal itself always completes and records its event.
   */
  async remove(id: string, options: { documents?: RemovedDocuments } = {}): Promise<SubscriptionRemovalResult> {
    const removing = options.documents ?? 'keep';
    const deleteDocument = this.options.deleteDocument;
    if (removing === 'delete' && !deleteDocument) throw new CollectorError('invalid_request', '這個知識庫不支援刪除文件。');
    const record = (await this.store.list()).find((candidate) => candidate.id === id);
    if (!record || !(await this.store.remove(id))) throw this.notFound();
    this.jobs.stopSubscription(this.type, id, 'subscription_removed');
    let deleted = 0;
    let failed = 0;
    let incomplete = false;
    try {
      if (removing === 'delete' && deleteDocument) {
        const { checkItems, singleItems } = this.jobs.pendingCaptures(this.type, id);
        for (const item of checkItems) {
          if (!item.source.id) continue;
          try {
            await this.options.recordDeletion?.({
              sourceType: this.type, sourceId: item.source.id, sourceUrl: item.source.url, title: item.source.title ?? item.source.id,
              publisherId: id, publisherName: record.title,
            });
          } catch (error) {
            console.error('Deletion record for a capturing item failed', error);
          }
        }
        const unsettled = new Set(singleItems.map((item) => item.id));
        const settling = [
          ...checkItems.map((item) => this.jobs.whenSettled(item.id)),
          ...singleItems.map((item) => this.jobs.whenSettled(item.id).finally(() => unsettled.delete(item.id))),
        ];
        await settleWithin(Promise.allSettled(settling), this.options.removalSettleMs ?? REMOVAL_SETTLE_MS);
        for (const jobId of unsettled) void this.deleteWhenSaved(jobId, id, deleteDocument);
        for (const document of await this.subscriptionDocuments(id)) {
          const outcome = await deleteQuietly(deleteDocument, document.id);
          if (outcome === 'deleted') deleted += 1;
          else if (outcome === 'failed') failed += 1;
        }
      }
    } catch (error) {
      console.error('Deleting the documents of a removed subscription failed', error);
      incomplete = true;
    }
    const kept = await this.subscriptionDocuments(id).then((documents) => documents.length, () => failed);
    if (incomplete) failed = Math.max(failed, kept);
    const message = removing === 'keep' ? `已移除「${record.title}」，文件保留。`
      : failed > 0 ? `已移除「${record.title}」，刪除 ${deleted} 份文件，${failed} 份無法刪除。`
        : `已移除「${record.title}」，並刪除 ${deleted} 份文件。`;
    this.jobs.recordEvent({
      severity: failed > 0 ? 'warning' : 'info', eventType: 'subscription.removed', message,
      ...this.subject(id, record.title),
    });
    return { documentsKept: kept, documentsDeleted: deleted, documentsFailed: failed };
  }

  /** Deletes the document a single-item request saves, once it ends, when it belongs to the removed subscription. */
  private async deleteWhenSaved(jobId: string, subscriptionId: string, deleteDocument: (id: string) => Promise<unknown>): Promise<void> {
    try {
      const job = await this.jobs.whenSettled(jobId);
      const documentId = job.result?.documentId;
      if (!documentId) return;
      const document = (await this.subscriptionDocuments(subscriptionId)).find((candidate) => candidate.id === documentId);
      if (document) await deleteQuietly(deleteDocument, document.id);
    } catch (error) {
      console.error('Deleting a document of a removed subscription failed', error);
    }
  }

  private async subscriptionDocuments(id: string): Promise<DocumentMetadata[]> {
    return (await this.options.documents()).filter((document) => document.sourceType === this.type && document.publisher.id === id);
  }

  /**
   * The listed subscriptions a manual check covers, each checked before any job starts: a missing
   * or paused one refuses the whole request.
   */
  async checkable(ids: readonly string[]): Promise<SubscriptionRecord[]> {
    const all = await this.store.list();
    return [...new Set(ids)].map((id) => {
      const record = all.find((candidate) => candidate.id === id);
      if (!record) throw this.notFound();
      if (!record.enabled) throw new CollectorError('subscription_paused', `「${record.title}」已暫停，請先恢復訂閱。`);
      return record;
    });
  }

  /**
   * Dispatches one check per subscription: the listed ones, or every enabled one. A subscription
   * whose job is still queued or running returns that job, so the check joins it. Each checked
   * subscription's next automatic check moves on, also when it joined an active job: a scheduled
   * check keeps its rhythm from the time that came due, any other dispatch counts an interval from now.
   */
  async startRun(request: StartRunRequest): Promise<JobSubmission[]> {
    let selected: SubscriptionRecord[];
    if (request.subscriptionIds && request.trigger === 'scheduled') {
      // Due subscriptions were read a moment ago; one paused or removed since then is left out.
      const ids = new Set(request.subscriptionIds);
      selected = (await this.store.list()).filter((record) => ids.has(record.id) && record.enabled);
    } else if (request.subscriptionIds) {
      selected = await this.checkable(request.subscriptionIds);
    } else {
      selected = (await this.store.list()).filter((record) => record.enabled);
    }
    if (selected.length === 0) {
      if (request.trigger === 'scheduled') return [];
      throw new CollectorError('invalid_request', '沒有可檢查的訂閱。');
    }
    return this.dispatch(selected, request.trigger);
  }

  /** Submits a check of each subscription and records the dispatch. */
  private async dispatch(selected: readonly SubscriptionRecord[], trigger: StartRunRequest['trigger']): Promise<JobSubmission[]> {
    const now = this.now();
    const submissions: JobSubmission[] = [];
    for (const record of selected) submissions.push(await this.jobs.submitCheck(this.type, record, trigger));
    const ids = new Set(selected.map((record) => record.id));
    // Computed from the current rows, so a settings change made meanwhile keeps its interval and
    // a subscription paused meanwhile gets no next check.
    await this.store.updateWith((records) => new Map(records
      .filter((record) => ids.has(record.id) && record.enabled)
      .map((record) => [record.id, {
        lastDispatchedAt: now.toISOString(), nextCheckAt: nextCheckAfterDispatch(record, trigger, now).toISOString(),
      }] as const)));
    return submissions;
  }

  /** Port entry: why a subscription's work stops, or null while it exists and is enabled. */
  async stopped(id: string): Promise<SkipReason | null> {
    const record = (await this.store.list()).find((candidate) => candidate.id === id);
    if (!record) return 'subscription_removed';
    return record.enabled ? null : 'subscription_paused';
  }

  /** Port entry: a manual check of one subscription, such as retrying a check whose listing failed. */
  async checkNow(id: string): Promise<JobSubmission> {
    return (await this.startRun({ trigger: 'manual', subscriptionIds: [id] }))[0]!;
  }

  /**
   * Port entry: the plan of a check whose discovery starts at `at`. The range comes from the
   * subscription's settings now. An item stays out while it is out of range for a range that starts
   * no earlier than the one that left it out, and while it is skipped after failing.
   */
  async planCheck(id: string, at: Date): Promise<CheckPlan | { stopped: SkipReason }> {
    const record = (await this.store.list()).find((candidate) => candidate.id === id);
    if (!record?.enabled) return { stopped: record ? 'subscription_paused' : 'subscription_removed' };
    const range = this.subscription.checkRange(record.settings, at);
    const since = range.since.toISOString();
    const excluded = new Set((record.outOfRange ?? []).filter((entry) => entry.before <= since).map((entry) => entry[this.keyField]!));
    for (const entry of record.failures ?? []) if (entry.skipped) excluded.add(entry[this.keyField] as string);
    return { target: record, range, excluded };
  }

  /**
   * Port entry: records a check that started at `at`, keeping a later check time already recorded;
   * recording the same check again changes nothing. With the check's candidates, out-of-range items
   * that are no longer candidates are forgotten, and so are failed items that are no longer
   * candidates or already have a document: a failure stays only while the item is skipped or among
   * the items the check collects. Returns why the subscription's work stops, if it does.
   */
  async checked(id: string, report: CheckReport): Promise<SkipReason | null> {
    const { candidates, collecting } = report;
    const key = (entry: OutOfRangeEntry | ItemFailureEntry) => entry[this.keyField] as string;
    const [record] = await this.store.updateWith((records) => {
      const current = records.find((candidate) => candidate.id === id);
      if (!current) return new Map();
      const patch: Partial<SubscriptionRecord> = {};
      if (candidates && current.outOfRange?.some((entry) => !candidates.has(key(entry)))) {
        patch.outOfRange = current.outOfRange.filter((entry) => candidates.has(key(entry)));
      }
      if (candidates && collecting) {
        const kept = (entry: ItemFailureEntry) => candidates.has(key(entry)) && (entry.skipped || collecting.has(key(entry)));
        if (current.failures?.some((entry) => !kept(entry))) {
          const failures = current.failures.filter(kept);
          patch.failures = failures.length > 0 ? failures : undefined;
        }
      }
      if (!current.lastCheckedAt || current.lastCheckedAt < report.at) patch.lastCheckedAt = report.at;
      return Object.keys(patch).length > 0 ? new Map([[id, patch]]) : new Map();
    });
    const current = record ?? (await this.store.list()).find((candidate) => candidate.id === id);
    if (!current) return 'subscription_removed';
    return current.enabled ? null : 'subscription_paused';
  }

  /** Port entry: a collected item no longer counts as failed. */
  async itemCollected(id: string, itemKey: string): Promise<void> {
    await this.store.updateWith((records) => {
      const current = records.find((candidate) => candidate.id === id);
      if (!current?.failures?.some((entry) => entry[this.keyField] === itemKey)) return new Map();
      const failures = current.failures.filter((entry) => entry[this.keyField] !== itemKey);
      return new Map([[id, { failures: failures.length > 0 ? failures : undefined }]]);
    });
  }

  /**
   * Port entry: counts one failed check of an item. `skip`, and reaching MAX_CHECK_ATTEMPTS, mark
   * it skipped. Returns the item's failure record, or null when the subscription is gone.
   */
  async itemFailed(id: string, item: { key: string; title: string | null; url: string }, error: JobError, failureClass: FailureClass): Promise<ItemFailureEntry | null> {
    let recorded: ItemFailureEntry | null = null;
    await this.store.updateWith((records) => {
      const current = records.find((candidate) => candidate.id === id);
      if (!current) return new Map();
      const entries = current.failures ?? [];
      const previous = entries.find((entry) => entry[this.keyField] === item.key);
      const attempts = (previous?.attempts ?? 0) + 1;
      recorded = {
        [this.keyField]: item.key, title: item.title ?? previous?.title ?? '', attempts, errorCode: error.code,
        failedAt: this.now().toISOString(), skipped: failureClass === 'skip' || attempts >= MAX_CHECK_ATTEMPTS,
        ...(this.definition.item.urlForKey ? {} : { url: item.url }),
      };
      return new Map([[id, { failures: [...entries.filter((entry) => entry !== previous), recorded] }]]);
    });
    return recorded;
  }

  /** Port entry: remembers an item published before the range start `before` of the check that found it. */
  async itemOutOfRange(id: string, itemKey: string, before: string): Promise<void> {
    await this.store.updateWith((records) => {
      const current = records.find((candidate) => candidate.id === id);
      if (!current) return new Map();
      const outOfRange = [
        ...(current.outOfRange ?? []).filter((entry) => entry[this.keyField] !== itemKey),
        { [this.keyField]: itemKey, before } as OutOfRangeEntry,
      ];
      return new Map([[id, { outOfRange }]]);
    });
  }

  /**
   * Port entry: subscribes a resolved target with the settings accepted with the request and
   * dispatches its first check; the next check is an interval later. An existing subscription keeps
   * its own state and settings and gets no check, unless the request that created it was interrupted
   * before its first check (`resumed`).
   */
  async subscribe(target: SubscriptionTarget, settings: SubscriptionSettings, options: { resumed: boolean; beforeCreate: () => Promise<void> }): Promise<SubscribeResult> {
    const existing = (await this.store.list()).find((record) => record.id === target.id);
    if (existing && !options.resumed) return { subscription: existing, outcome: 'existing', check: null };
    let subscription = existing;
    if (!subscription) {
      await options.beforeCreate();
      const now = this.now();
      subscription = await this.store.add({
        id: target.id, title: target.title, url: target.url, enabled: true, addedAt: now.toISOString(), lastCheckedAt: null,
        settings: { ...settings }, lastDispatchedAt: now.toISOString(), nextCheckAt: addMinutes(now, settings.intervalMinutes).toISOString(),
      });
      this.jobs.recordEvent({ severity: 'info', eventType: 'subscription.added', message: `已訂閱「${subscription.title}」。`, ...this.subject(subscription.id, subscription.title) });
    }
    // The dispatch times were written with the subscription, so a first check resumed after a stop keeps them.
    const check = await this.jobs.submitCheck(this.type, subscription, 'subscribe');
    return { subscription, outcome: 'created', check };
  }

  private get keyField(): string {
    return this.definition.storage!.outOfRangeKeyField;
  }

  whenSettled(jobId: string): Promise<CollectionJob> {
    return this.jobs.whenSettled(jobId);
  }

  private notFound(): CollectorError {
    return new CollectorError('subscription_not_found', `找不到這個 ${subscriptionKindLabel(this.type)}訂閱。`);
  }

  /** The fields that tie a subscription event to its subscription, so the activity view can show and filter it by source. */
  private subject(id: string, title: string): { sourceType: string; sourceId: string; sourceTitle: string; subscriptionId: string } {
    return { sourceType: this.type, sourceId: id, sourceTitle: title, subscriptionId: id };
  }
}

/**
 * The store change that gives `record` new settings. A new interval on an enabled subscription
 * counts from its last dispatch and is due at once if that time has passed.
 */
function settingsPatch(record: SubscriptionRecord, settings: SubscriptionSettings, now: Date): Partial<SubscriptionRecord> {
  const patch: Partial<SubscriptionRecord> = { settings: { ...settings } };
  if (record.enabled && settings.intervalMinutes !== record.settings.intervalMinutes) {
    const next = addMinutes(record.lastDispatchedAt ? new Date(record.lastDispatchedAt) : now, settings.intervalMinutes);
    patch.nextCheckAt = (next.getTime() < now.getTime() ? now : next).toISOString();
  }
  return patch;
}

/**
 * A scheduled check keeps the subscription's rhythm: the next check is whole intervals after the
 * one that came due, the first of them after `now`, so polling delay never accumulates and missed
 * periods are not checked one by one. Any other dispatch counts an interval from `now`.
 */
function nextCheckAfterDispatch(record: SubscriptionRecord, trigger: StartRunRequest['trigger'], now: Date): Date {
  const interval = record.settings.intervalMinutes * 60_000;
  if (trigger !== 'scheduled' || !record.nextCheckAt) return new Date(now.getTime() + interval);
  const due = new Date(record.nextCheckAt).getTime();
  const periods = Math.max(1, Math.floor((now.getTime() - due) / interval) + 1);
  return new Date(due + periods * interval);
}

interface StatusContext {
  autoCheck: boolean;
  now: Date;
  loginRequired: boolean;
}

/**
 * What a subscription is doing now. Its own state comes first: paused, then a source that needs a
 * new sign-in. An active check shows what it is doing, with its item progress while it downloads.
 * Without a check, automatic checks being off comes next;
 * a check that came due and was not dispatched yet, or has no time yet, is queued; otherwise the
 * next check time shows. A failed last check does not change the status.
 */
export function checkStatus(
  record: Pick<SubscriptionRecord, 'enabled' | 'nextCheckAt'>,
  check: CheckActivity | null,
  context: StatusContext,
): SubscriptionCheckStatus {
  if (!record.enabled) return { state: 'paused' };
  if (context.loginRequired) return { state: 'login_required' };
  if (check) return check.status.state === 'downloading' ? { state: 'downloading', done: check.done, total: check.total } : check.status;
  if (!context.autoCheck) return { state: 'auto_check_off' };
  const next = record.nextCheckAt ?? null;
  // Without a time yet, the scheduler plans one at its next round, so the check waits like a due one.
  if (!next || new Date(next).getTime() <= context.now.getTime()) return { state: 'queued' };
  return { state: 'scheduled', nextCheckAt: next };
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

/** Runs `work` for at most `timeoutMs`; on timeout its signal aborts, so a request still waiting its turn is dropped. */
function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new CollectorError('network_error', message);
      abort.abort(error);
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([work(abort.signal), timeout]).finally(() => clearTimeout(timer));
}

/**
 * The subscription services of one Vault, one per source type with subscriptions, in registration
 * order. HTTP routes and the scheduler reach a subscription through its type's service; the job
 * manager reaches every type through this object as its subscription port.
 */
export class SubscriptionServices implements SubscriptionPort {
  private readonly byType: Map<string, SubscriptionService>;

  constructor(services: Iterable<SubscriptionService>) {
    this.byType = new Map([...services].map((service) => [service.type, service]));
  }

  /** The service of a type; null for a type without subscriptions or not registered. */
  of(type: string): SubscriptionService | null {
    return this.byType.get(type) ?? null;
  }

  all(): SubscriptionService[] {
    return [...this.byType.values()];
  }

  /**
   * Checks the listed subscriptions of any types now. The whole list is validated first, so a
   * missing or paused subscription, or a type without subscriptions, refuses the request before
   * any job starts.
   */
  async startChecks(listed: ReadonlyArray<{ type: string; id: string }>): Promise<JobSubmission[]> {
    return startChecks((type) => this.of(type), listed);
  }

  planCheck(type: string, id: string, at: Date): Promise<CheckPlan | { stopped: SkipReason }> {
    return this.require(type).planCheck(id, at);
  }

  checked(type: string, id: string, report: CheckReport): Promise<SkipReason | null> {
    return this.require(type).checked(id, report);
  }

  itemCollected(type: string, id: string, key: string): Promise<void> {
    return this.require(type).itemCollected(id, key);
  }

  itemFailed(type: string, id: string, item: { key: string; title: string | null; url: string }, error: JobError, failureClass: FailureClass): Promise<ItemFailureEntry | null> {
    return this.require(type).itemFailed(id, item, error, failureClass);
  }

  itemOutOfRange(type: string, id: string, key: string, before: string): Promise<void> {
    return this.require(type).itemOutOfRange(id, key, before);
  }

  subscribe(type: string, target: SubscriptionTarget, settings: SubscriptionSettings, options: { resumed: boolean; beforeCreate: () => Promise<void> }): Promise<SubscribeResult> {
    return this.require(type).subscribe(target, settings, options);
  }

  /** A type without subscriptions here has none to stop, so its work counts as removed. */
  async stopped(type: string, id: string): Promise<SkipReason | null> {
    return this.of(type)?.stopped(id) ?? 'subscription_removed';
  }

  checkNow(type: string, id: string): Promise<JobSubmission> {
    return this.require(type).checkNow(id);
  }

  private require(type: string): SubscriptionService {
    const service = this.of(type);
    if (!service) throw new Error(`Source type ${type} has no subscription service`);
    return service;
  }
}

/** The part of a type's subscription service a manual check of listed subscriptions uses. */
export interface CheckEntry {
  checkable(ids: readonly string[]): Promise<SubscriptionRecord[]>;
  startRun(request: StartRunRequest): Promise<JobSubmission[]>;
}

/**
 * Checks listed subscriptions of any types: every type's list is validated before the first job
 * starts, so a refused request starts nothing.
 */
export async function startChecks(
  serviceOf: (type: string) => CheckEntry | null,
  listed: ReadonlyArray<{ type: string; id: string }>,
): Promise<JobSubmission[]> {
  const byType = new Map<string, string[]>();
  for (const { type, id } of listed) byType.set(type, [...byType.get(type) ?? [], id]);
  const runs = await Promise.all([...byType].map(async ([type, ids]) => {
    const service = serviceOf(type);
    if (!service) throw new CollectorError('subscription_not_found', `找不到這個 ${subscriptionKindLabel(type)}訂閱。`);
    await service.checkable(ids);
    return { service, ids };
  }));
  const submissions: JobSubmission[] = [];
  for (const { service, ids } of runs) submissions.push(...await service.startRun({ trigger: 'manual', subscriptionIds: ids }));
  return submissions;
}
