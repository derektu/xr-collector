import type { SubscriptionStore } from './subscription-store.js';
import type { SubscriptionRemoval } from './subscription-files.js';
import { checkPlan } from './candidates.js';
import type { CheckActivity, JobManager, CheckEnd, CheckPlan, CheckReport, SubscribeResult, SubscriptionPort } from '../jobs/index.js';
import type { SourceDeclarations, SourceRegistry } from '../../shared/sources/source-registry.js';
import type { FailureClass, SourceDefinition, SubscriptionDeclaration, SubscriptionTarget } from '../../shared/sources/source-contract.js';
import { AUTO_PAUSE_AFTER_MS, AUTO_PAUSE_FAILURES, MAX_CHECK_ATTEMPTS } from '../../shared/subscriptions/subscription-limits.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { ChannelJobTrigger, JobView, JobError, JobSubmission, SkipReason } from '../../shared/jobs/job-types.js';
import type { DocumentMetadata } from '../../shared/documents/document-types.js';
import type {
  CheckFailures,
  ItemFailureEntry,
  OutOfRangeEntry,
  PendingSubscription,
  Subscription,
  SubscriptionCheckStatus,
  SubscriptionPreview,
  SubscriptionRecord,
  SubscriptionSettings,
} from '../../shared/subscriptions/subscription-types.js';

export const PREVIEW_TIMEOUT_MS = 60_000;

export type RemovedDocuments = 'keep' | 'delete';

export interface SubscriptionRemovalResult {
  documentsKept: number;
  documentsDeleted: number;
  documentsFailed: number;
}

export interface SubscriptionServiceOptions {
  sources: SourceRegistry;
  autoCollection: () => Promise<boolean>;
  resolveTarget: (url: string, signal: AbortSignal) => Promise<SubscriptionTarget>;
  documents: () => Promise<DocumentMetadata[]>;
  deleteDocument?: (id: string) => Promise<unknown>;
  loginRequired?: (subscription: SubscriptionRecord) => boolean;
  onAutoPaused?: (subscription: SubscriptionRecord) => void | Promise<void>;
  now?: () => Date;
  previewTimeoutMs?: number;
}

export interface StartRunRequest {
  trigger: Extract<ChannelJobTrigger, 'scheduled' | 'manual'>;
  subscriptionIds?: string[];
}

export interface ApplySettingsResult {
  updated: number;
  paused: number;
}

export interface EnabledResult {
  subscription: SubscriptionRecord;
  submission: JobSubmission | null;
}

export class SubscriptionService {
  private readonly now: () => Date;
  private readonly definition: SourceDefinition;
  private readonly subscription: SubscriptionDeclaration;
  private readonly storage: NonNullable<SourceDefinition['storage']>;

  constructor(
    readonly type: string,
    private readonly store: SubscriptionStore,
    private readonly jobs: JobManager,
    private readonly options: SubscriptionServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.definition = options.sources.require(type);
    if (!this.definition.subscription || !this.definition.storage) throw new Error(`Source type ${type} has no subscriptions`);
    this.subscription = this.definition.subscription;
    this.storage = this.definition.storage;
  }

  list(): Promise<SubscriptionRecord[]> {
    return this.store.list();
  }

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
      const { check = null, capturing = false } = work.get(record.id) ?? {};
      const totals = counts.get(record.id);
      const failures = record.enabled && !check ? record.checkFailures : undefined;
      return {
        ...record,
        lastCheckedAt: record.lastCheckedAt ?? null,
        checkFailures: record.checkFailures ?? null,
        autoPausedAt: record.autoPausedAt ?? null,
        nextCheckAt: record.nextCheckAt ?? null,
        lastDispatchedAt: record.lastDispatchedAt ?? null,
        status: !record.enabled ? 'paused' : check ? 'collecting' : failures ? 'error' : 'tracking',
        checkStatus: checkStatus(record, check, { autoCheck, now, loginRequired: this.options.loginRequired?.(record) ?? false }),
        capturing,
        lastError: failures?.error ?? null,
        activeJob: check ? { id: check.jobId, done: check.done, total: check.total } : null,
        documentCount: totals?.count ?? 0,
        lastCollectedAt: totals?.latest ?? null,
      };
    });
  }

  async pendingSubscriptions(): Promise<PendingSubscription[]> {
    const subscribed = new Set((await this.store.list()).map((record) => record.id));
    return this.jobs.subscriptionWork(this.type).adds
      .filter((entry) => !entry.targetId || !subscribed.has(entry.targetId))
      .map(({ jobId, url, title, status }) => ({
        type: this.type, jobId, url, title,
        checkStatus: status.state === 'queued' || status.state === 'retrying' ? status : { state: 'adding' },
      }));
  }

  async listRemovals(): Promise<SubscriptionRemoval[]> {
    return await this.store.removals?.() ?? [];
  }

  checkJobs(id: string): JobView[] {
    return this.jobs.checkJobs(this.type).get(id) ?? [];
  }

  async preview(url: string): Promise<SubscriptionPreview> {
    const input = this.definition.classify(url);
    if (input.kind !== 'subscription') throw new CollectorError('invalid_subscription', this.definition.prompts.subscriptionInputHint);
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

  async add(inputUrl: string, settings: Partial<SubscriptionSettings> = {}): Promise<JobSubmission> {
    this.subscription.parseSettingsPatch(settings, { allowEmpty: true });
    return this.jobs.submitSubscriptionAdd(this.type, inputUrl, { ...this.subscription.defaults, ...settings } as SubscriptionSettings);
  }

  async updateSettings(id: string, patch: Partial<SubscriptionSettings>): Promise<SubscriptionRecord> {
    this.subscription.parseSettingsPatch(patch, { allowEmpty: true });
    const now = this.now();
    const [record] = await this.store.updateWith((records) => {
      const current = records.find((candidate) => candidate.id === id);
      return new Map(current ? [[id, settingsPatch(current, { ...current.settings, ...patch } as SubscriptionSettings, now)]] : []);
    });
    if (!record) throw this.notFound();
    this.jobs.recordEvent({ eventType: 'subscription.settings_updated', message: `已更新「${record.title}」的收集設定。`, ...this.subject(id, record.title) });
    return record;
  }

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
      eventType: 'subscription.settings_applied',
      message: `已把「${source.title}」的收集設定套用到其他 ${updated.length} 個 ${this.options.sources.subscriptionKindLabel(this.type)}。`, ...this.subject(id, source.title),
    });
    return { updated: updated.length, paused };
  }

  async planChecks(options: { overdue: boolean }): Promise<void> {
    const now = this.now();
    await this.store.updateWith((records) => new Map(records
      .filter((record) => record.enabled && (!record.nextCheckAt
        || (options.overdue && new Date(record.nextCheckAt).getTime() <= now.getTime())))
      .map((record) => [record.id, { nextCheckAt: addMinutes(now, record.settings.intervalMinutes).toISOString() }] as const)));
  }

  async setEnabled(id: string, enabled: boolean): Promise<EnabledResult> {
    const current = (await this.store.list()).find((record) => record.id === id);
    if (!current) throw this.notFound();
    if (current.enabled === enabled) return { subscription: current, submission: null };
    if (!enabled) {
      const record = await this.store.update(id, { enabled: false, nextCheckAt: null, autoPausedAt: undefined });
      if (!record) throw this.notFound();
      this.jobs.stopSubscription(this.type, id, 'subscription_paused');
      this.jobs.recordEvent({ eventType: 'subscription.paused', message: `已暫停「${record.title}」。`, ...this.subject(id, record.title) });
      return { subscription: record, submission: null };
    }
    const now = this.now();
    const record = await this.store.update(id, {
      enabled: true, checkFailures: undefined, autoPausedAt: undefined,
      lastDispatchedAt: now.toISOString(), nextCheckAt: addMinutes(now, current.settings.intervalMinutes).toISOString(),
    });
    if (!record) throw this.notFound();
    this.jobs.recordEvent({ eventType: 'subscription.resumed', message: `已恢復「${record.title}」。`, ...this.subject(id, record.title) });
    const submission = await this.jobs.submitCheck(this.type, record, 'resume');
    return { subscription: record, submission };
  }

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

  private async subscriptionDocuments(id: string): Promise<DocumentMetadata[]> {
    return (await this.options.documents()).filter((document) => document.sourceType === this.type && document.publisher.id === id);
  }

  async checkable(ids: readonly string[]): Promise<SubscriptionRecord[]> {
    const all = await this.store.list();
    return [...new Set(ids)].map((id) => {
      const record = all.find((candidate) => candidate.id === id);
      if (!record) throw this.notFound();
      if (!record.enabled) throw new CollectorError('subscription_paused', `「${record.title}」已暫停，請先恢復訂閱。`);
      return record;
    });
  }

  async startRun(request: StartRunRequest): Promise<JobSubmission[]> {
    let selected: SubscriptionRecord[];
    if (request.subscriptionIds && request.trigger === 'scheduled') {
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

  private async dispatch(selected: readonly SubscriptionRecord[], trigger: StartRunRequest['trigger']): Promise<JobSubmission[]> {
    const now = this.now();
    const submissions: JobSubmission[] = [];
    for (const record of selected) {
      submissions.push(await this.jobs.submitCheck(this.type, record, trigger));
    }
    const ids = new Set(selected.map((record) => record.id));
    await this.store.updateWith((records) => new Map(records
      .filter((record) => ids.has(record.id) && record.enabled)
      .map((record) => [record.id, {
        lastDispatchedAt: now.toISOString(), nextCheckAt: nextCheckAfterDispatch(record, trigger, now).toISOString(),
      }] as const)));
    return submissions;
  }

  async stopped(id: string): Promise<SkipReason | null> {
    const record = (await this.store.list()).find((candidate) => candidate.id === id);
    if (!record) return 'subscription_removed';
    return record.enabled ? null : 'subscription_paused';
  }

  async checkNow(id: string): Promise<JobSubmission> {
    return (await this.startRun({ trigger: 'manual', subscriptionIds: [id] }))[0]!;
  }

  async planCheck(id: string, at: Date): Promise<CheckPlan | { stopped: SkipReason }> {
    const record = (await this.store.list()).find((candidate) => candidate.id === id);
    if (!record?.enabled) return { stopped: record ? 'subscription_paused' : 'subscription_removed' };
    const range = this.subscription.checkRange(record.settings, at);
    const since = range.since.toISOString();
    const excluded = new Set((record.outOfRange ?? []).filter((entry) => entry.before <= since).map((entry) => entry[this.keyField]!));
    for (const entry of record.failures ?? []) if (entry.skipped) excluded.add(entry[this.keyField] as string);
    return checkPlan(record, range, excluded);
  }

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
      return Object.keys(patch).length > 0 ? new Map([[id, patch]]) : new Map();
    });
    const current = record ?? (await this.store.list()).find((candidate) => candidate.id === id);
    if (!current) return 'subscription_removed';
    return current.enabled ? null : 'subscription_paused';
  }

  async checkEnded(id: string, end: CheckEnd): Promise<void> {
    let paused: CheckFailures | undefined;
    const [record] = await this.store.updateWith((records) => {
      const current = records.find((candidate) => candidate.id === id);
      if (!current) return new Map();
      const patch: Partial<SubscriptionRecord> = {};
      if (!current.lastCheckedAt || current.lastCheckedAt < end.at) patch.lastCheckedAt = end.at;
      const countsTowardFailures = end.counted && end.failureClass !== 'login_required';
      if (countsTowardFailures && !end.error) {
        if (current.checkFailures) patch.checkFailures = undefined;
      } else if (countsTowardFailures && end.error) {
        const failures = {
          count: (current.checkFailures?.count ?? 0) + 1, since: current.checkFailures?.since ?? end.at, error: end.error,
        };
        patch.checkFailures = failures;
        if (current.enabled && failures.count >= AUTO_PAUSE_FAILURES
          && new Date(end.at).getTime() - new Date(failures.since).getTime() >= AUTO_PAUSE_AFTER_MS) {
          Object.assign(patch, { enabled: false, nextCheckAt: null, autoPausedAt: end.at });
          paused = failures;
        }
      }
      return Object.keys(patch).length > 0 ? new Map([[id, patch]]) : new Map();
    });
    if (!paused || !record) return;
    this.jobs.stopSubscription(this.type, id, 'subscription_paused');
    this.jobs.recordEvent({
      eventType: 'subscription.auto_paused',
      message: `「${record.title}」連續 ${paused.count} 次檢查失敗，已自動暫停：${paused.error.message}`,
      errorCode: paused.error.code, ...this.subject(id, record.title),
    });
    try { await this.options.onAutoPaused?.(record); }
    catch (error) { console.warn('Unable to send auto-pause notification', error); }
  }

  async itemCollected(id: string, itemKey: string): Promise<void> {
    await this.store.updateWith((records) => {
      const current = records.find((candidate) => candidate.id === id);
      if (!current?.failures?.some((entry) => entry[this.keyField] === itemKey)) return new Map();
      const failures = current.failures.filter((entry) => entry[this.keyField] !== itemKey);
      return new Map([[id, { failures: failures.length > 0 ? failures : undefined }]]);
    });
  }

  async itemFailed(id: string, item: { key: string; title: string | null; url: string }, error: JobError, failureClass: FailureClass): Promise<ItemFailureEntry | null> {
    if (failureClass === 'login_required' || failureClass === 'rate_limited') return null;
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

  async subscribe(target: SubscriptionTarget, settings: SubscriptionSettings): Promise<SubscribeResult> {
    const existing = (await this.store.list()).find((record) => record.id === target.id);
    if (existing) return { subscription: existing, outcome: 'existing', check: null };
    const now = this.now();
    const subscription = await this.store.add({
      id: target.id, title: target.title, url: target.url, enabled: true, addedAt: now.toISOString(), updatedAt: now.toISOString(), lastCheckedAt: null,
      settings: { ...settings }, lastDispatchedAt: now.toISOString(), nextCheckAt: addMinutes(now, settings.intervalMinutes).toISOString(),
    });
    this.jobs.recordEvent({ eventType: 'subscription.added', message: `已訂閱「${subscription.title}」。`, ...this.subject(subscription.id, subscription.title) });
    const check = await this.jobs.submitCheck(this.type, subscription, 'subscribe');
    return { subscription, outcome: 'created', check };
  }

  private get keyField(): string {
    return this.storage.outOfRangeKeyField;
  }

  private notFound(): CollectorError {
    return new CollectorError('subscription_not_found', `找不到這個 ${this.options.sources.subscriptionKindLabel(this.type)}訂閱。`);
  }

  private subject(id: string, title: string): { sourceType: string; sourceId: string; sourceTitle: string; subscriptionId: string; namesSource: true } {
    return { sourceType: this.type, sourceId: id, sourceTitle: title, subscriptionId: id, namesSource: true };
  }
}

function settingsPatch(record: SubscriptionRecord, settings: SubscriptionSettings, now: Date): Partial<SubscriptionRecord> {
  const patch: Partial<SubscriptionRecord> = { settings: { ...settings } };
  if (record.enabled && settings.intervalMinutes !== record.settings.intervalMinutes) {
    const next = addMinutes(record.lastDispatchedAt ? new Date(record.lastDispatchedAt) : now, settings.intervalMinutes);
    patch.nextCheckAt = (next.getTime() < now.getTime() ? now : next).toISOString();
  }
  return patch;
}

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

export function checkStatus(
  record: Pick<SubscriptionRecord, 'enabled' | 'nextCheckAt' | 'checkFailures' | 'autoPausedAt'>,
  check: CheckActivity | null,
  context: StatusContext,
): SubscriptionCheckStatus {
  if (!record.enabled) {
    return record.autoPausedAt && record.checkFailures ? { state: 'auto_paused', failures: record.checkFailures.count } : { state: 'paused' };
  }
  if (context.loginRequired) return { state: 'login_required' };
  if (check) return check.status.state === 'downloading' ? { state: 'downloading', done: check.done, total: check.total } : check.status;
  if (!context.autoCheck) {
    return record.checkFailures ? { state: 'failing', failures: record.checkFailures.count, nextCheckAt: null } : { state: 'auto_check_off' };
  }
  const next = record.nextCheckAt ?? null;
  if (next === null || new Date(next).getTime() <= context.now.getTime()) return { state: 'queued' };
  if (record.checkFailures) return { state: 'failing', failures: record.checkFailures.count, nextCheckAt: next };
  return { state: 'scheduled', nextCheckAt: next };
}

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

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

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

export class SubscriptionServices implements SubscriptionPort {
  private readonly byType: Map<string, SubscriptionService>;

  constructor(private readonly sources: SourceDeclarations, services: Iterable<SubscriptionService>) {
    this.byType = new Map([...services].map((service) => [service.type, service]));
  }

  of(type: string): SubscriptionService | null {
    return this.byType.get(type) ?? null;
  }

  all(): SubscriptionService[] {
    return [...this.byType.values()];
  }

  async startChecks(listed: ReadonlyArray<{ type: string; id: string }>): Promise<JobSubmission[]> {
    return startChecks(this.sources, (type) => this.of(type), listed);
  }

  planCheck(type: string, id: string, at: Date): Promise<CheckPlan | { stopped: SkipReason }> {
    return this.require(type).planCheck(id, at);
  }

  checked(type: string, id: string, report: CheckReport): Promise<SkipReason | null> {
    return this.require(type).checked(id, report);
  }

  checkEnded(type: string, id: string, end: CheckEnd): Promise<void> {
    return this.require(type).checkEnded(id, end);
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

  subscribe(type: string, target: SubscriptionTarget, settings: SubscriptionSettings): Promise<SubscribeResult> {
    return this.require(type).subscribe(target, settings);
  }

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

export interface CheckEntry {
  checkable(ids: readonly string[]): Promise<SubscriptionRecord[]>;
  startRun(request: StartRunRequest): Promise<JobSubmission[]>;
}

export async function startChecks(
  sources: SourceDeclarations,
  serviceOf: (type: string) => CheckEntry | null,
  listed: ReadonlyArray<{ type: string; id: string }>,
): Promise<JobSubmission[]> {
  const byType = new Map<string, string[]>();
  for (const { type, id } of listed) byType.set(type, [...byType.get(type) ?? [], id]);
  const runs = await Promise.all([...byType].map(async ([type, ids]) => {
    const service = serviceOf(type);
    if (!service) throw new CollectorError('subscription_not_found', `找不到這個 ${sources.subscriptionKindLabel(type)}訂閱。`);
    await service.checkable(ids);
    return { service, ids };
  }));
  const submissions: JobSubmission[] = [];
  for (const { service, ids } of runs) submissions.push(...await service.startRun({ trigger: 'manual', subscriptionIds: ids }));
  return submissions;
}
