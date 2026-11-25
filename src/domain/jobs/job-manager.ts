import { randomUUID } from 'node:crypto';
import type { DocumentCollector } from '../../shared/documents/document-collector.js';
import type { CollectionPause } from '../../shared/jobs/collection-pause.js';
import type { Connectivity } from './connectivity.js';
import { isRetryable, jobEventSubject, jobKey, roleOf, roleView, subscriptionOf, workKey } from '../../shared/jobs/job-role.js';
import type { SourceDeclarations } from '../../shared/sources/source-registry.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type {
  ChannelJobTrigger,
  CollectionJob,
  JobError,
  JobItem,
  JobOverview,
  JobPage,
  JobPhase,
  JobResult,
  JobRole,
  JobStopKind,
  JobSubmission,
  JobView,
  JobSummary,
  SkipReason,
} from '../../shared/jobs/job-types.js';
import type { NewJobEvent } from '../../shared/activity/activity-types.js';
import type { JobListQuery } from '../../shared/api/api-routes.js';
import type { SubscriptionSettings, WorkStatus } from '../../shared/subscriptions/subscription-types.js';
import type { Pacing, PacingEvent } from '../pacing/index.js';
import type { FailureClass, ItemRef, SourcePlugin, SubscriptionTarget } from '../../shared/sources/source-contract.js';
import { limitText, redact } from '../../shared/lib/redact.js';
import { failedJobs, jobOverview, workStatus } from './job-board.js';
import type { JobStore } from './job-store.js';
import type { SubscriptionPort } from './subscription-port.js';
import { JobWaits, type WaitCondition } from './job-waits.js';
import { JobQueue, type QueuePlace } from './job-queue.js';
import { type InterruptedJob, resumeInterrupted, resumedRecord, resumeMessage } from './job-recovery.js';
import { SubscriptionReports } from './subscription-reports.js';
import { ACTIVE, progressOf, settledItem } from './check-items.js';

export interface JobLimits {
  discovery: number;
  capture: number;
  /** Jobs waiting in both queues together; further submissions are refused. */
  maxQueued: number;
}

export const DEFAULT_JOB_LIMITS: JobLimits = { discovery: 1, capture: 1, maxQueued: 500 };

export interface RetryPolicy {
  /** Attempts in total, the first one included. */
  maxAttempts: number;
  /** Wait before each retry; the last value repeats when attempts outnumber it. */
  delaysMs: number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, delaysMs: [30_000, 120_000] };

const COOLDOWN_WITHOUT_END_MS = 5 * 60_000;

export interface JobManagerOptions {
  vaultPath: string;
  vaultId: string;
  store: JobStore;
  sources: SourceDeclarations;
  plugins: readonly SourcePlugin[];
  documents: DocumentCollector;
  subscriptions?: SubscriptionPort;
  limits?: Partial<JobLimits>;
  retry?: Partial<RetryPolicy>;
  now?: () => Date;
  createId?: () => string;
  setTimer?: (callback: () => void, ms: number) => () => void;
  pacing?: readonly Pacing[];
  recentTarget?: (type: string, url: string) => SubscriptionTarget | undefined;
  pause?: CollectionPause;
  connectivity?: Pick<Connectivity, 'confirm'>;
}

export interface CheckActivity {
  jobId: string;
  status: WorkStatus;
  done: number;
  total: number;
}

export interface SubscriptionWork {
  check: CheckActivity | null;
  capturing: boolean;
}

export interface SubscriptionRequestWork {
  jobId: string;
  url: string;
  targetId: string | null;
  title: string | null;
  status: WorkStatus;
}

export interface SubscriptionWorkReport {
  subscriptions: Map<string, SubscriptionWork>;
  adds: SubscriptionRequestWork[];
}

export function checkActivity(sources: SourceDeclarations, job: CollectionJob): CheckActivity {
  return {
    jobId: job.id,
    status: workStatus(sources, job),
    done: job.progress?.done ?? 0,
    total: job.progress?.total ?? 0,
  };
}

export class JobManager {
  private readonly limits: JobLimits;
  private readonly retryPolicy: RetryPolicy;
  private readonly waits: JobWaits;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly jobs = new Map<string, CollectionJob>();
  private readonly keys = new Map<string, string>();
  private readonly activeByKey = new Map<string, string>();
  private readonly queue = new JobQueue();
  private readonly reports: SubscriptionReports;
  private runningDiscovery = 0;
  private runningCapture = 0;
  private readonly running = new Set<Promise<void>>();
  private readonly watchers = new Map<string, Set<string>>();
  private readonly settleWaiters = new Map<string, Array<(job: JobView) => void>>();
  private readonly stoppedRunning = new Map<string, SkipReason>();
  private readonly endingChecks = new Map<string, CollectionJob>();
  private closed = false;
  private resuming = false;
  private holds = 0;
  private waitingStepsAbort = new AbortController();
  private readonly plugins = new Map<string, SourcePlugin>();
  private readonly gates = new Map<string, Pacing>();
  private readonly unsubscribePacing: Array<() => void> = [];
  private readonly unsubscribePause: (() => void) | undefined;

  constructor(private readonly options: JobManagerOptions) {
    this.limits = { ...DEFAULT_JOB_LIMITS, ...options.limits };
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => randomUUID());
    this.waits = new JobWaits({
      now: this.now,
      setTimer: options.setTimer ?? ((callback, ms) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      }),
      gates: this.gates,
      groupOf: (job) => this.groupOf(job),
      held: () => this.held,
      onCooldownEnded: (group) => this.endCooldown(group),
      onRetryDue: (id) => this.retryDue(id),
    });
    this.reports = new SubscriptionReports({
      sources: options.sources,
      port: () => this.subscriptions,
      parentOf: (id) => this.parentOf(id),
      classify: (job, error) => this.classify(job, error),
      failureLabel: (type, code) => this.plugin(type)?.failureLabels?.[code],
      stoppedCheck: (id) => this.stoppedRunning.has(id),
      event: (job, entry) => this.event(job, entry),
    });
    for (const plugin of options.plugins) this.plugins.set(plugin.id, plugin);
    for (const gate of options.pacing ?? []) {
      this.gates.set(gate.group, gate);
      this.unsubscribePacing.push(gate.subscribe((event) => this.onPacing(gate.group, event)));
      const until = gate.status().cooldownUntil;
      if (until) this.enterCooldown(gate.group, until);
    }
    this.unsubscribePause = options.pause?.subscribe(({ paused }) => {
      if (paused) this.stopWaitingSteps('收集已暫停。');
      else this.continueSteps();
    });
  }

  private onPacing(group: string, event: PacingEvent): void {
    if (this.closed) return;
    const label = this.pacingLabel(group);
    if (event.type === 'rate_limited') {
      this.recordEvent({
        severity: 'warning', eventType: `${group}.rate_limited`,
        message: `${label} 暫時限制連線，${clockTime(event.until)} 前暫停所有 ${label} 請求。`,
        until: event.until, level: event.level, ...(event.detail ? { detail: event.detail } : {}),
      });
      this.enterCooldown(group, event.until);
      return;
    }
    this.recordEvent({ severity: 'info', eventType: `${group}.cooldown_ended`, message: `${label} 限制已解除，繼續收集。` });
    this.endCooldown(group);
  }

  private pacingLabel(group: string): string {
    for (const plugin of this.plugins.values()) if (plugin.pacing?.group === group) return plugin.pacing.label;
    return group;
  }

  private plugin(type: string): SourcePlugin | undefined {
    return this.plugins.get(type);
  }

  private requirePlugin(type: string): SourcePlugin {
    const plugin = this.plugins.get(type);
    if (!plugin) throw new Error(`Source type ${type} is not assembled`);
    return plugin;
  }

  private groupOf(job: CollectionJob): string | null {
    return this.plugins.get(job.source.type)?.pacing?.group ?? null;
  }

  private get subscriptions(): SubscriptionPort {
    const port = this.options.subscriptions;
    if (!port) throw new Error('This job manager runs no subscription work');
    return port;
  }

  private enterCooldown(group: string, until: string): void {
    if (this.waits.extendCooldown(group, until) === 'already_later') return;
    for (const job of this.jobs.values()) {
      if (job.state === 'queued' && this.groupOf(job) === group) this.markWaiting(job);
    }
  }

  private markWaiting(job: CollectionJob): void {
    const group = this.groupOf(job);
    const until = group ? this.waits.cooldownUntil(group) : null;
    if (!until || job.wait?.until === until) return;
    this.update(job, { wait: { reason: 'rate_limited', until } });
    this.syncItemWait(job);
  }

  private endCooldown(group: string): void {
    this.waits.endCooldown(group);
    if (this.closed) return;
    for (const job of this.jobs.values()) {
      if (!job.wait || this.groupOf(job) !== group) continue;
      this.clearWait(job);
    }
    this.pump();
  }

  private clearWait(job: CollectionJob): void {
    if (!job.wait) return;
    delete job.wait;
    this.update(job, {});
    this.syncItemWait(job);
  }

  private syncItemWait(child: CollectionJob): void {
    for (const checkId of this.watchers.get(child.id) ?? []) {
      const check = this.jobs.get(checkId);
      if (!check?.items) continue;
      this.update(check, {
        items: check.items.map((item) => {
          if (item.jobId !== child.id) return item;
          const next = { ...item };
          delete next.wait;
          return child.wait ? { ...next, wait: child.wait } : next;
        }),
      });
    }
  }

  get vaultPath(): string { return this.options.vaultPath; }

  private async flushThenPump(): Promise<void> {
    try {
      await this.options.store.flush();
    } finally {
      this.pump();
    }
  }

  private get vaultId(): string { return this.options.vaultId; }

  private owns(job: CollectionJob): boolean {
    return job.vaultPath === this.options.vaultPath && job.vaultId === this.vaultId;
  }

  async submit(type: string, url: string): Promise<JobSubmission> {
    const input = this.requirePlugin(type).classify(url);
    return input.kind === 'item' ? this.submitItem(type, input.ref.url) : this.submitSubscriptionAdd(type, input.url);
  }

  async submitItem(type: string, url: string): Promise<JobSubmission> {
    const submission = this.enqueueItem(type, this.requirePlugin(type).parseItem(url), null);
    await this.flushThenPump();
    return submission;
  }

  /**
   * A new subscription starts with `settings`, the source type's defaults when omitted; an existing
   * subscription keeps its own state and settings.
   */
  async submitSubscriptionAdd(type: string, url: string, settings?: SubscriptionSettings): Promise<JobSubmission> {
    const plugin = this.requirePlugin(type);
    const input = plugin.classify(url);
    const kind = this.options.sources.jobKind(type, 'add');
    if (input.kind !== 'subscription' || !kind || !plugin.subscription) {
      throw new CollectorError('invalid_subscription', plugin.prompts.subscriptionInputHint);
    }
    const accepted = settings ?? plugin.subscription.defaults;
    const target = this.options.recentTarget?.(type, input.url);
    const submission = this.enqueue(kind, type, workKey(type, 'add', input.url), {
      id: null, url: input.url, title: target?.title ?? null,
    }, null, {
      scope: { trigger: 'subscribe' },
      checkpoint: { settings: { ...accepted }, ...(target ? { target: { id: target.id, title: target.title, url: target.url } } : {}) },
    });
    await this.flushThenPump();
    return submission;
  }

  /** Only the subscriptions dispatch checks. */
  async submitCheck(type: string, subscription: SubscriptionTarget, trigger: ChannelJobTrigger): Promise<JobSubmission> {
    const submission = this.enqueueCheck(type, subscription, trigger);
    await this.flushThenPump();
    return submission;
  }

  get(id: string): JobView {
    const job = this.options.store.get(id);
    if (!job || !this.owns(job)) {
      throw new CollectorError('job_not_found', '找不到這個收集工作。');
    }
    return jobView(job);
  }

  list(query: JobListQuery = {}): JobPage {
    const limit = query.limit ?? 20;
    let jobs = this.options.store.list(this.options.vaultPath, this.vaultId).filter((job) => job.parentId === null);
    if (query.state === 'active') jobs = jobs.filter((job) => ACTIVE.has(job.state));
    if (query.cursor) {
      const index = jobs.findIndex((job) => job.id === query.cursor);
      if (index < 0) throw new CollectorError('invalid_request', '分頁位置已失效，請重新讀取第一頁。');
      jobs = jobs.slice(index + 1);
    }
    const page = jobs.slice(0, limit).map((job) => this.withLiveItems(jobView(job)));
    return { jobs: page, nextCursor: jobs.length > limit ? page[page.length - 1]!.id : null };
  }

  /** Grouped by subscription ID, each group newest first. */
  checkJobs(type: string): Map<string, JobView[]> {
    const bySubscription = new Map<string, JobView[]>();
    for (const job of this.options.store.list(this.options.vaultPath, this.vaultId)) {
      if (!isRole(this.options.sources, job, type, 'check') || !job.source.id) continue;
      const jobs = bySubscription.get(job.source.id) ?? [];
      jobs.push(jobView(job));
      bySubscription.set(job.source.id, jobs);
    }
    return bySubscription;
  }

  /** `adds` are the subscription requests still resolving or subscribing, oldest first. */
  subscriptionWork(type: string): SubscriptionWorkReport {
    const subscriptions = new Map<string, SubscriptionWork>();
    const entry = (id: string): SubscriptionWork => {
      let work = subscriptions.get(id);
      if (!work) subscriptions.set(id, work = { check: null, capturing: false });
      return work;
    };
    for (const job of this.jobs.values()) {
      if (!isRole(this.options.sources, job, type, 'check') || !job.source.id) continue;
      const work = entry(job.source.id);
      if (!this.stoppedRunning.has(job.id) && !work.check) work.check = checkActivity(this.options.sources, this.withLiveItems(job));
    }
    for (const job of this.jobs.values()) {
      if (!isRole(this.options.sources, job, type, 'item')) continue;
      const subscriptionId = subscriptionOf(this.options.sources, job, this.parentOf);
      if (subscriptionId) entry(subscriptionId).capturing = true;
    }
    const adds = [...this.jobs.values()]
      .filter((job) => isRole(this.options.sources, job, type, 'add'))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((job): SubscriptionRequestWork => {
        const view = roleView(this.options.sources, job);
        const request = view?.role === 'add' ? view : null;
        return {
          jobId: job.id, url: job.source.url,
          targetId: request?.subscriptionId ?? null,
          title: request?.title ?? null,
          status: workStatus(this.options.sources, job),
        };
      });
    return { subscriptions, adds };
  }

  private withLiveItems<T extends JobView>(job: T): T {
    if (!job.items) return job;
    return {
      ...job,
      items: job.items.map((item) => item.state === 'queued' && item.jobId && this.jobs.get(item.jobId)?.state === 'running'
        ? { ...item, state: 'running' } : item),
    };
  }

  stopSubscription(type: string, id: string, reason: SkipReason): void {
    for (const job of [...this.jobs.values()]) {
      if (!isRole(this.options.sources, job, type, 'check') || job.source.id !== id) continue;
      if (job.state === 'queued') {
        this.queue.remove(job.id, this.placeOf(job));
        this.finish(job, 'completed', { outcome: 'skipped', skipReason: reason }, null);
        continue;
      }
      this.stoppedRunning.set(job.id, reason);
      const key = this.keys.get(job.id);
      if (key && this.activeByKey.get(key) === job.id) this.activeByKey.delete(key);
    }
    for (const item of [...this.jobs.values()]) {
      if (!isRole(this.options.sources, item, type, 'item') || subscriptionOf(this.options.sources, item, this.parentOf) !== id) continue;
      if (item.state === 'queued') {
        this.queue.remove(item.id, this.placeOf(item));
        this.finish(item, 'completed', { outcome: 'skipped', skipReason: reason }, null);
      } else if (reason === 'subscription_removed') {
        this.stoppedRunning.set(item.id, reason);
      }
    }
    this.releaseEndingCheckKeys(type, id);
    void this.options.store.flush().catch((error: unknown) => console.error('Job store flush failed', error));
  }

  async retry(id: string): Promise<JobSubmission> {
    const job = this.options.store.get(id);
    if (!job || !this.owns(job)) throw new CollectorError('job_not_found', '找不到這個收集工作。');
    const type = job.source.type;
    const role = roleOf(this.options.sources, job);
    const plugin = this.plugin(type);
    if (!role || !plugin) throw new CollectorError('job_not_retryable', '這個工作無法重試。');
    const { noun } = plugin.item;
    const target = plugin.subscription?.targetNoun ?? '訂閱';
    if (job.parentId !== null) {
      throw new CollectorError('job_not_retryable', `${target}收集中的${noun}隨${target}工作處理，請重試${target}工作。`);
    }
    if (!isRetryable(this.options.sources, job)) throw new CollectorError('job_not_retryable', `只有失敗或有${noun}失敗的工作可以重試。`);
    let submission: JobSubmission;
    if (role === 'item') {
      submission = this.enqueueItem(type, itemRefOf(job, plugin), null, null, { retryOf: job.id }, job.source.title);
    } else if (role === 'add') {
      const settings = this.acceptedSettings(job);
      submission = this.enqueue(job.kind, type, jobKey(this.options.sources, job), { id: null, url: job.source.url, title: null }, null, {
        scope: { trigger: 'subscribe' }, checkpoint: { settings: { ...settings } }, retryOf: job.id,
      });
    } else {
      if (!this.options.subscriptions || !job.source.id) throw new CollectorError('job_not_retryable', '這個工作無法重試。');
      submission = await this.subscriptions.checkNow(type, job.source.id);
      const started = this.jobs.get(submission.job.id);
      if (started && !submission.deduplicated) {
        this.update(started, { retryOf: job.id });
        submission = { ...submission, job: this.get(started.id) };
      }
    }
    this.updateStored(job, { retriedBy: submission.job.id, updatedAt: this.now().toISOString() });
    const retried = this.jobs.get(submission.job.id) ?? this.requireStored(submission.job.id);
    this.event(retried, {
      eventType: 'job.retry_requested', retryOf: job.id,
      message: submission.deduplicated ? '已手動重試，併入進行中的工作。' : '已手動重試，重新排入收集。',
    });
    await this.flushThenPump();
    return submission;
  }

  async overview(): Promise<JobOverview> {
    const jobs = this.options.store.list(this.options.vaultPath, this.vaultId)
      .map((job) => this.withLiveItems(jobView(this.jobs.get(job.id) ?? job)));
    return jobOverview(jobs, {
      now: this.now(),
      sources: this.options.sources,
      queueJoinOrder: (job) => this.queue.joinOrder(job.id),
      hasDocument: (type, key) => this.hasDocument(type, key),
    });
  }

  async dismiss(id: string): Promise<JobView> {
    const job = this.options.store.get(id);
    if (!job || !this.owns(job)) throw new CollectorError('job_not_found', '找不到這個收集工作。');
    const listed = await failedJobs(this.options.store.list(this.options.vaultPath, this.vaultId), {
      sources: this.options.sources, now: this.now(), hasDocument: (type, key) => this.hasDocument(type, key),
    });
    if (!listed.some((candidate) => candidate.id === id)) {
      throw new CollectorError('job_not_dismissable', '只有失敗清單中的工作可以移除。');
    }
    const timestamp = this.now().toISOString();
    this.updateStored(job, { dismissedAt: timestamp, updatedAt: timestamp });
    this.event(job, { eventType: 'job.dismissed', message: '已從失敗清單移除。' });
    await this.options.store.flush();
    return jobView(this.requireStored(id));
  }

  private async hasDocument(type: string, key: string): Promise<boolean> {
    return (await this.options.documents.findExisting({ sourceType: type, sourceId: key })) !== null;
  }

  summary(since: string): JobSummary {
    const bound = new Date(since).toISOString();
    const summary: JobSummary = { active: 0, completed: 0, failed: 0, since: bound };
    for (const job of this.options.store.list(this.options.vaultPath, this.vaultId)) {
      if (job.parentId !== null) continue;
      if (ACTIVE.has(job.state)) summary.active += 1;
      else if (!job.finishedAt || job.finishedAt < bound) continue;
      else if (job.state === 'completed') summary.completed += 1;
      else if (job.state === 'failed' && !job.retriedBy && !job.dismissedAt) summary.failed += 1;
    }
    return summary;
  }

  recordEvent(entry: Omit<NewJobEvent, 'vaultPath' | 'jobId'>): void {
    this.options.store.event({ ...entry, vaultPath: this.options.vaultPath, vaultId: this.vaultId, jobId: null });
  }

  /**
   * Stops starting queued steps, aborts the steps waiting for their turn, and resolves once the
   * steps already running have finished, with a function that lifts the hold. Queued jobs keep
   * their place and continue after the last hold is lifted.
   */
  async hold(): Promise<() => void> {
    this.holds += 1;
    this.stopWaitingSteps('收集步驟已暫停。');
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      this.continueSteps();
    };
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
    return release;
  }

  private releaseEndingCheckKeys(type: string, id: string): void {
    for (const job of this.endingChecks.values()) {
      if (!isRole(this.options.sources, job, type, 'check') || job.source.id !== id) continue;
      const key = this.keys.get(job.id);
      if (key && this.activeByKey.get(key) === job.id) this.activeByKey.delete(key);
    }
  }

  private requireStored(id: string): CollectionJob {
    const job = this.options.store.get(id);
    if (!job) throw new Error(`Job ${id} is missing from the job store`);
    return job;
  }

  private get held(): boolean {
    return this.holds > 0 || this.options.pause?.paused === true;
  }

  private stopWaitingSteps(message: string): void {
    if (!this.waitingStepsAbort.signal.aborted) this.waitingStepsAbort.abort(new CollectorError('vault_busy', message));
  }

  private continueSteps(): void {
    if (this.held) return;
    if (this.waitingStepsAbort.signal.aborted) this.waitingStepsAbort = new AbortController();
    this.pump();
  }

  /** Number of top-level jobs that are queued, running or waiting for their items. */
  unfinishedCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) if (job.parentId === null) count += 1;
    return count;
  }

  /** True while any job of this Vault is queued, running or waiting for its items. */
  isBusy(): boolean {
    return this.jobs.size > 0;
  }

  /** Resolves when the job finishes, fails or is interrupted. */
  whenSettled(id: string): Promise<JobView> {
    if (!this.jobs.has(id) && !this.endingChecks.has(id)) return Promise.resolve(this.get(id));
    return new Promise((resolve) => {
      const waiters = this.settleWaiters.get(id) ?? [];
      waiters.push(resolve);
      this.settleWaiters.set(id, waiters);
    });
  }

  /** Called once when the Vault opens, before the scheduler starts. */
  async resume(): Promise<void> {
    if (this.closed) return;
    this.resuming = true;
    try {
      await resumeInterrupted({
        sources: this.options.sources,
        stored: () => this.options.store.list(this.options.vaultPath, this.vaultId),
        runs: (type) => this.plugin(type) !== undefined,
        stopped: (type, id) => this.subscriptions.stopped(type, id),
        settle: (job, state, result, error) => {
          this.jobs.set(job.id, job);
          this.finish(job, state, result, error);
        },
        restore: (job) => this.restore(job),
      });
      await this.options.store.flush().catch((error: unknown) => console.error('Resumed jobs are not written', error));
    } finally {
      this.resuming = false;
    }
    this.pump();
  }

  private restore(stored: InterruptedJob): void {
    const job = resumedRecord(this.options.sources, stored, this.now().toISOString());
    const key = jobKey(this.options.sources, job);
    this.jobs.set(job.id, job);
    this.keys.set(job.id, key);
    this.activeByKey.set(key, job.id);
    const waits = this.waits.unexpiredWaitsOf(job);
    const group = this.groupOf(job);
    if (job.wait) {
      if (group && waits.cooldown) this.enterCooldown(group, waits.cooldown.until);
      else delete job.wait;
    }
    this.options.store.put(job);
    const stopReason = job.recovery.lastStop;
    this.event(job, {
      severity: job.parentId ? 'debug' : 'info', eventType: 'job.resumed', stopReason, message: resumeMessage(stopReason),
    });
    this.markWaiting(job);
    if (waits.retry) this.waitFor(job, waits.retry);
    else this.requeue(job);
  }

  private updateStored(job: CollectionJob, patch: Partial<CollectionJob>): void {
    Object.assign(job, patch);
    this.options.store.put(job);
  }

  /** Waits for running steps, then records what is left as interrupted with `message`. */
  async close(message = '服務停止時工作尚未完成；已保存的內容保留。', stop: JobStopKind = 'shutdown'): Promise<void> {
    this.closed = true;
    this.waitingStepsAbort.abort(new CollectorError('vault_busy', '服務正在停止。'));
    for (const unsubscribe of this.unsubscribePacing) unsubscribe();
    this.unsubscribePause?.();
    this.waits.close();
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
    for (const job of [...this.jobs.values()]) {
      this.options.store.interrupt(job, message, { stop });
      this.release(job);
      this.notifySettled(this.requireStored(job.id));
    }
    this.queue.clear();
    await this.options.store.flush().catch((error: unknown) => console.error('Interrupted jobs are not written', error));
  }

  private enqueueItem(
    type: string, ref: Pick<ItemRef, 'key' | 'url'>, parentId: string | null, publishedNotBefore: string | null = null,
    extra: Pick<CollectionJob, 'retryOf'> = {}, title: string | null = null,
  ): JobSubmission {
    return this.enqueue(this.options.sources.jobKind(type, 'item')!, type, workKey(type, 'item', ref.key), {
      id: ref.key, url: ref.url, title,
    }, parentId, { ...(publishedNotBefore ? { publishedNotBefore } : {}), ...extra });
  }

  private enqueueCheck(type: string, subscription: SubscriptionTarget, trigger: ChannelJobTrigger): JobSubmission {
    const kind = this.options.sources.jobKind(type, 'check');
    if (!kind) throw new Error(`Source type ${type} has no check jobs`);
    return this.enqueue(kind, type, workKey(type, 'check', subscription.id), {
      id: subscription.id, url: subscription.url, title: subscription.title,
    }, null, { scope: { trigger } });
  }

  private enqueue(
    kind: string,
    type: string,
    key: string,
    source: Omit<CollectionJob['source'], 'type'>,
    parentId: string | null,
    extra: Pick<CollectionJob, 'scope' | 'publishedNotBefore' | 'checkpoint' | 'retryOf'> = {},
  ): JobSubmission {
    if (this.closed) throw new CollectorError('vault_busy', '服務正在停止，無法接受新的收集工作。');
    const activeId = this.activeByKey.get(key);
    if (activeId) return { job: this.get(activeId), deduplicated: true };
    if (this.queue.size >= this.limits.maxQueued) {
      throw new CollectorError('queue_full', '等待中的收集工作已達上限，請等目前的工作完成後再試。');
    }
    const timestamp = this.now().toISOString();
    const job: CollectionJob = {
      id: this.createId(),
      kind,
      state: 'queued',
      phase: null,
      vaultPath: this.options.vaultPath,
      vaultId: this.vaultId,
      parentId,
      source: { type, ...source },
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
    this.event(job, { eventType: 'job.accepted', message: '已接受收集工作。', ...(job.retryOf ? { retryOf: job.retryOf } : {}) });
    return { job: jobView(structuredClone(job)), deduplicated: false };
  }

  private requeue(job: CollectionJob, front = false): void {
    this.queue.add(job.id, this.placeOf(job), front);
  }

  private placeOf(job: CollectionJob): QueuePlace {
    return roleOf(this.options.sources, job) === 'item' ? { line: 'capture', lane: job.parentId ?? job.id } : { line: 'discovery' };
  }

  private waitFor(job: CollectionJob, condition: WaitCondition): void {
    if (this.closed) return;
    if (condition.kind === 'retry') {
      this.waits.startRetry(job.id, condition.until);
      return;
    }
    this.syncItemWait(job);
    this.requeue(job, true);
  }

  private retryDue(id: string): void {
    const job = this.jobs.get(id);
    if (this.closed || !job) return;
    this.requeue(job);
    this.pump();
  }

  private returnToQueue(job: CollectionJob): void {
    this.update(job, { state: 'queued' });
    this.waitFor(job, { kind: 'held' });
  }

  private deferForCooldown(job: CollectionJob, retryAt: string | undefined): void {
    const group = this.groupOf(job);
    const until = retryAt ?? (group ? this.waits.cooldownUntil(group) : null)
      ?? new Date(this.now().getTime() + COOLDOWN_WITHOUT_END_MS).toISOString();
    if (group) this.enterCooldown(group, until);
    this.update(job, { state: 'queued', wait: { reason: 'rate_limited', until } });
    this.event(job, {
      eventType: 'job.deferred',
      message: `${group ? this.pacingLabel(group) : this.plugin(job.source.type)?.label ?? job.source.type} 暫時限制連線，約 ${clockTime(until)} 自動繼續。`,
      until, ...(job.phase ? { phase: job.phase } : {}),
    });
    this.waitFor(job, { kind: 'cooldown', until });
  }

  private async handledInterruption(job: CollectionJob, error: unknown, signal: AbortSignal): Promise<boolean> {
    if (error instanceof CollectorError && error.code === 'network_error' && !this.options.pause?.paused && !(signal.aborted && error === signal.reason)) {
      await this.options.connectivity?.confirm();
      if (this.closed) return true;
    }
    if (signal.aborted && error === signal.reason) {
      if (!this.closed) this.returnToQueue(job);
      return true;
    }
    if (this.options.pause?.paused && error instanceof CollectorError && this.classify(job, error) === 'retry_now') {
      if (!this.closed) this.returnToQueue(job);
      return true;
    }
    if (error instanceof CollectorError && this.classify(job, error) === 'rate_limited') {
      if (!this.closed) this.deferForCooldown(job, error.retryAt);
      return true;
    }
    return false;
  }

  private ready(id: string): boolean {
    const job = this.jobs.get(id);
    return !job || this.waits.conditionOf(job) === null;
  }

  private pump(): void {
    if (this.closed || this.resuming) return;
    while (this.runningDiscovery < this.limits.discovery) {
      const id = this.queue.nextDiscovery((candidate) => this.ready(candidate));
      if (!id) break;
      this.runningDiscovery += 1;
      this.track(this.runDiscovery(id).finally(() => { this.runningDiscovery -= 1; this.pump(); }));
    }
    while (this.runningCapture < this.limits.capture) {
      const id = this.queue.nextCapture((candidate) => this.ready(candidate));
      if (!id) break;
      this.runningCapture += 1;
      this.track(this.runItem(id).finally(() => { this.runningCapture -= 1; this.pump(); }));
    }
  }

  private track(work: Promise<void>): void {
    this.running.add(work);
    void work.finally(() => this.running.delete(work)).catch(() => undefined);
  }

  private async runItem(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    const savedEarlier = job.checkpoint?.savedDocumentId !== undefined || job.phase === 'save';
    if (this.stoppedRunning.get(job.id) === 'subscription_removed') {
      this.finish(job, 'completed', { outcome: 'skipped', skipReason: 'subscription_removed' }, null);
      return;
    }
    const { signal } = this.waitingStepsAbort;
    this.start(job, 'capture');
    try {
      const plugin = this.requirePlugin(job.source.type);
      const ref = itemRefOf(job, plugin);
      const key = { sourceType: plugin.id, sourceId: ref.key };
      const { documents } = this.options;
      let document = await documents.findExisting(key);
      let outcome: 'created' | 'existing' = document && savedEarlier ? 'created' : 'existing';
      if (!document && await documents.isDeletedFor(key, { explicitAt: explicitRequestTime(this.options.sources, job) })) {
        this.finish(job, 'completed', { outcome: 'skipped', skipReason: 'deleted' }, null);
        return;
      }
      if (!document) {
        const subscription = this.reports.targetOf(job);
        const captured = await plugin.captureItem(ref, {
          ...(job.publishedNotBefore ? { publishedNotBefore: job.publishedNotBefore } : {}),
          ...(subscription ? { subscription } : {}),
          signal,
        });
        if (this.stoppedRunning.get(job.id) === 'subscription_removed') {
          this.finish(job, 'completed', { outcome: 'skipped', skipReason: 'subscription_removed' }, null);
          return;
        }
        this.update(job, { phase: 'save', source: { ...job.source, title: captured.title, publisher: captured.publisher.name } });
        await this.options.store.flush();
        const saved = await documents.save({ sourceType: plugin.id, ...captured }, { explicitAt: explicitRequestTime(this.options.sources, job) });
        document = saved.document;
        outcome = 'created';
        this.update(job, { checkpoint: { ...job.checkpoint, savedDocumentId: document.id } });
        this.event(job, {
          eventType: 'document.saved', message: '文件已保存。', phase: 'save', documentId: document.id,
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
          eventType: 'document.index_failed', message: '文件已保存，搜尋更新失敗。',
          phase: 'index', documentId: document.id,
        });
      }
      await this.reports.collected(job);
      if (this.jobs.get(job.id) !== job) return;
      this.finish(job, 'completed', {
        outcome, documentId: document.id, saved: true, indexed: index.indexed,
        ...(index.message ? { indexMessage: index.message } : {}),
      }, null);
    } catch (error) {
      if (error instanceof CollectorError && (error.code === 'out_of_range' || error.code === 'document_deleted')) {
        if (error.code === 'out_of_range') await this.reports.outOfRange(job);
        this.finish(job, 'completed', { outcome: 'skipped', skipReason: error.code === 'out_of_range' ? 'out_of_range' : 'deleted' }, null);
        return;
      }
      if (await this.handledInterruption(job, error, signal)) return;
      await this.failOrRetry(job, redactedJobError(error), diagnosticDetail(error));
    }
  }

  private async runDiscovery(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    const { signal } = this.waitingStepsAbort;
    try {
      if (roleOf(this.options.sources, job) === 'add') await this.addSubscription(job, signal);
      else await this.discover(job, signal);
    } catch (error) {
      if (this.closed) return;
      if (await this.handledInterruption(job, error, signal)) return;
      await this.failOrRetry(job, redactedJobError(error), diagnosticDetail(error));
    }
  }

  private async failOrRetry(job: CollectionJob, error: JobError, detail?: string): Promise<void> {
    const attempts = (job.retry?.attempts ?? 0) + 1;
    const failureClass = this.classify(job, error);
    if (failureClass !== 'retry_now') {
      await this.reports.failed(job, error, failureClass);
      if (this.jobs.get(job.id) !== job) return;
      this.finish(job, 'failed', { outcome: 'failed' }, error, detail);
      return;
    }
    const maxAttempts = this.retryPolicy.maxAttempts;
    if (attempts >= maxAttempts) {
      this.update(job, { retry: { attempts, maxAttempts, nextAttemptAt: null, lastError: error } });
      this.notifyItemRetry(job);
      await this.reports.failed(job, error, 'retry_next_check');
      if (this.jobs.get(job.id) !== job) return;
      const message = attempts > 1 ? `${error.message}（已嘗試 ${attempts} 次）` : error.message;
      this.finish(job, 'failed', { outcome: 'failed' }, { code: error.code, message }, detail);
      return;
    }
    const delays = this.retryPolicy.delaysMs;
    const delay = delays[Math.min(attempts - 1, delays.length - 1)] ?? 0;
    const nextAttemptAt = new Date(this.now().getTime() + delay).toISOString();
    this.update(job, { state: 'queued', retry: { attempts, maxAttempts, nextAttemptAt, lastError: error } });
    this.event(job, {
      eventType: 'job.retry_scheduled',
      message: `第 ${attempts} 次嘗試失敗，稍後自動重試：${error.message}`,
      errorCode: error.code, attempt: attempts, nextAttemptAt, ...(job.phase ? { phase: job.phase } : {}),
      ...(detail ? { detail } : {}),
    });
    this.notifyItemRetry(job);
    this.waitFor(job, { kind: 'retry', until: nextAttemptAt });
  }

  private notifyItemRetry(child: CollectionJob): void {
    if (!child.retry) return;
    for (const checkId of this.watchers.get(child.id) ?? []) {
      const check = this.jobs.get(checkId);
      if (!check?.items) continue;
      this.update(check, {
        items: check.items.map((item) => item.jobId === child.id ? { ...item, retry: child.retry! } : item),
      });
    }
  }

  private async addSubscription(job: CollectionJob, signal: AbortSignal): Promise<void> {
    this.start(job, 'resolve');
    const plugin = this.requirePlugin(job.source.type);
    const target = job.checkpoint?.target ?? await plugin.resolveTarget!(job.source.url, { signal });
    if (this.closed) return;
    const result = await this.subscriptions.subscribe(job.source.type, target, this.acceptedSettings(job));
    const { subscription, check } = result;
    this.update(job, { source: { ...job.source, id: subscription.id, title: subscription.title } });
    this.finish(job, 'completed', {
      outcome: result.outcome, subscriptionId: subscription.id, ...(check ? { followUpJobId: check.job.id } : {}),
    }, null);
  }

  private acceptedSettings(job: CollectionJob): SubscriptionSettings {
    return job.checkpoint?.settings ?? { ...this.requirePlugin(job.source.type).subscription!.defaults };
  }

  private async discover(job: CollectionJob, signal: AbortSignal): Promise<void> {
    this.start(job, 'discover');
    const type = job.source.type;
    const id = job.source.id!;
    const plugin = this.requirePlugin(type);
    const plan = await this.subscriptions.planCheck(type, id, this.now());
    if ('stopped' in plan) {
      this.finish(job, 'completed', { outcome: 'skipped', skipReason: plan.stopped }, null);
      return;
    }
    const target = { ...plan.target, title: job.source.title ?? plan.target.title, url: job.source.url };
    const discovery = await plan.select(
      plugin.listSubscriptionItems!(target, { signal }),
      (key) => this.options.documents.isKnown({ sourceType: type, sourceId: key }),
    );
    if (this.closed) return;
    const reason = this.stoppedRunning.get(job.id) ?? await this.subscriptions.stopped(type, id);
    if (reason) {
      this.finish(job, 'completed', { outcome: 'skipped', skipReason: reason }, null);
      return;
    }
    this.event(job, {
      eventType: 'channel.discovered', message: `發現 ${discovery.items.length} ${plugin.item.measureWord}${plugin.item.noun}。`, phase: 'discover',
    });
    const items: JobItem[] = discovery.items.map((found) => {
      const title = found.title ?? '';
      const item: JobItem = {
        sourceId: found.key, title, url: found.url, jobId: null, state: 'queued', outcome: null, error: null,
      };
      try {
        const submission = this.enqueueItem(type, found, job.id, discovery.publishedNotBefore, {}, title || null);
        item.jobId = submission.job.id;
        item.state = submission.job.state;
        if (submission.job.wait) item.wait = submission.job.wait;
        const watching = this.watchers.get(submission.job.id) ?? new Set<string>();
        watching.add(job.id);
        this.watchers.set(submission.job.id, watching);
      } catch (error) {
        item.state = 'failed';
        item.error = redactedJobError(error);
      }
      return item;
    });
    this.update(job, { phase: 'capture', items, progress: progressOf(items) });
    await this.options.store.flush();
    if (this.stoppedRunning.has(job.id)) {
      this.completeCheckIfDone(job);
      return;
    }
    const stopped = await this.subscriptions.checked(type, id, {
      candidates: new Set(discovery.candidates), collecting: new Set(discovery.items.map((item) => item.key)),
    });
    if (stopped) this.stopSubscription(type, id, stopped);
    if (this.jobs.has(job.id)) this.completeCheckIfDone(job);
  }

  private readonly parentOf = (id: string): CollectionJob | undefined => this.jobs.get(id) ?? this.options.store.get(id);

  private onItemSettled(child: CollectionJob): void {
    const watching = this.watchers.get(child.id);
    if (!watching) return;
    this.watchers.delete(child.id);
    for (const checkId of watching) {
      const check = this.jobs.get(checkId);
      if (!check?.items) continue;
      const items = check.items.map((item) => item.jobId === child.id ? settledItem(item, child) : item);
      this.update(check, { items, progress: progressOf(items) });
      this.completeCheckIfDone(check);
    }
  }

  private completeCheckIfDone(job: CollectionJob): void {
    const items = job.items ?? [];
    if (items.some((item) => ACTIVE.has(item.state))) return;
    const progress = progressOf(items);
    if (items.length === 0) {
      this.finish(job, 'completed', { outcome: 'empty' }, null);
    } else {
      const outcome = progress.failed > 0 ? 'partial' : progress.created > 0 ? 'created'
        : progress.existing > 0 ? 'existing' : 'skipped';
      const skipReason = outcome === 'skipped' ? items.find((item) => item.skipReason)?.skipReason : undefined;
      this.finish(job, 'completed', { outcome, ...(skipReason ? { skipReason } : {}) }, null);
    }
  }

  private start(job: CollectionJob, phase: JobPhase): void {
    const timestamp = this.now().toISOString();
    const firstStart = job.startedAt === null;
    if (job.wait) delete job.wait;
    this.update(job, {
      state: 'running', phase, startedAt: job.startedAt ?? timestamp,
      ...(job.retry ? { retry: { ...job.retry, nextAttemptAt: null } } : {}),
    });
    this.notifyItemRetry(job);
    this.syncItemWait(job);
    const role = roleOf(this.options.sources, job);
    const majorStart = firstStart && role !== 'add' && !(role === 'item' && job.parentId !== null);
    this.event(job, { severity: majorStart ? 'info' : 'debug', eventType: 'job.started', message: '開始執行收集工作。', phase });
  }

  private finish(job: CollectionJob, state: 'completed' | 'failed', result: JobResult, error: JobError | null, detail?: string): void {
    const finishedAt = this.now().toISOString();
    const end = this.reports.checkEnd({ ...job, state, result, error, finishedAt });
    if (!end) {
      this.settle(job, state, result, error, finishedAt, detail);
      return;
    }
    const key = this.keys.get(job.id);
    this.release(job);
    if (key) { this.keys.set(job.id, key); this.activeByKey.set(key, job.id); }
    this.endingChecks.set(job.id, job);
    this.track(Promise.resolve()
      .then(() => this.subscriptions.checkEnded(job.source.type, job.source.id!, end))
      .catch((reason: unknown) => console.error('Subscription check record update failed', reason))
      .then(() => {
        this.endingChecks.delete(job.id);
        this.settle(job, state, result, error, finishedAt, detail);
      }));
  }

  private settle(job: CollectionJob, state: 'completed' | 'failed', result: JobResult, error: JobError | null, finishedAt: string, detail?: string): void {
    this.update(job, { state, result, error, finishedAt });
    const progress = job.progress ?? { total: 0, done: 0, created: 0, existing: 0, failed: 0, skipped: 0 };
    const check = roleOf(this.options.sources, job) === 'check' && job.scope ? {
      trigger: job.scope.trigger,
      result: (state === 'failed' && error?.code === 'network_error' ? 'network_error'
        : state === 'completed' && result.outcome !== 'skipped'
          && progress.created === 0 && progress.failed === 0 && progress.skipped === 0
          ? 'empty' : 'other') as 'empty' | 'network_error' | 'other',
      created: progress.created, existing: progress.existing, failed: progress.failed, skipped: progress.skipped,
    } : undefined;
    const role = roleOf(this.options.sources, job);
    const completedSeverity = role === 'check'
      ? (result.outcome === 'partial' || progress.failed > 0 ? 'warning' : result.outcome === 'skipped' ? 'debug' : 'info')
      : role === 'add' || job.parentId !== null || result.outcome === 'created' || result.outcome === 'skipped'
        ? 'debug' : 'info';
    this.event(job, state === 'completed'
      ? {
        severity: completedSeverity, eventType: 'job.completed', message: this.completionMessage(job, result), outcome: result.outcome,
        ...(check ? { check } : {}),
        ...(result.skipReason ? { skipReason: result.skipReason } : {}),
        ...(result.documentId ? { documentId: result.documentId } : {}),
        ...(role === 'item' && result.indexed === false ? { indexed: false as const } : {}),
      }
      : {
        eventType: 'job.failed', message: error?.message ?? '收集工作失敗。', outcome: result.outcome,
        ...(check ? { check } : {}),
        ...(error ? { errorCode: error.code } : {}), ...(detail ? { detail } : {}),
      });
    this.release(job);
    const settled = this.requireStored(job.id);
    this.onItemSettled(settled);
    this.notifySettled(settled);
  }

  private release(job: CollectionJob): void {
    this.waits.endRetry(job.id);
    this.jobs.delete(job.id);
    this.stoppedRunning.delete(job.id);
    this.queue.forget(job.id);
    const key = this.keys.get(job.id);
    this.keys.delete(job.id);
    if (key && this.activeByKey.get(key) === job.id) this.activeByKey.delete(key);
  }

  private notifySettled(job: CollectionJob): void {
    const waiters = this.settleWaiters.get(job.id) ?? [];
    this.settleWaiters.delete(job.id);
    for (const resolve of waiters) resolve(jobView(job));
  }

  private update(job: CollectionJob, patch: Partial<CollectionJob>): void {
    Object.assign(job, patch, { updatedAt: this.now().toISOString() });
    this.options.store.put(job);
  }

  private event(job: CollectionJob, entry: Omit<NewJobEvent, 'vaultPath' | 'jobId'>): void {
    this.options.store.event({ ...entry, ...jobEventSubject(this.options.sources, job, this.parentOf) });
  }

  private classify(job: CollectionJob, error: { code: string }): FailureClass {
    return this.plugin(job.source.type)?.classifyFailure(error) ?? 'skip';
  }

  private completionMessage(job: CollectionJob, result: JobResult): string {
    if (result.outcome === 'skipped') return `略過：${SKIP_MESSAGES[result.skipReason ?? 'out_of_range']}。`;
    const role = roleOf(this.options.sources, job);
    const plugin = this.plugin(job.source.type);
    if (role === 'item') {
      const stored = result.outcome === 'created' ? '收集完成' : '文件已存在';
      return result.indexed === false ? `${stored}，搜尋更新失敗。` : `${stored}。`;
    }
    if (role === 'add') {
      return result.outcome === 'created' ? '已新增訂閱。' : `這個${plugin?.subscription?.targetNoun ?? '訂閱'}已在訂閱清單中。`;
    }
    if (result.outcome === 'empty') return `收集完成，沒有新${plugin?.item.noun ?? '項目'}。`;
    const progress = job.progress;
    if (!progress) return '收集完成。';
    const count = (value: number) => `${value}${plugin ? ` ${plugin.item.measureWord}${plugin.item.noun}` : ''}`;
    const parts = progress.created ? [`新增 ${count(progress.created)}`] : [];
    if (progress.existing) parts.push(`已存在 ${count(progress.existing)}`);
    if (progress.skipped) parts.push(`略過 ${count(progress.skipped)}`);
    if (progress.failed) parts.push(`失敗 ${count(progress.failed)}`);
    if (parts.length === 0) return '收集完成。';
    return `收集完成：${parts.join('・')}。`;
  }
}

function clockTime(value: string): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function jobView(job: CollectionJob): JobView {
  const { checkpoint: _checkpoint, ...view } = job;
  return view;
}

function itemRefOf(job: CollectionJob, plugin: SourcePlugin): ItemRef {
  if (job.source.id) return { key: job.source.id, url: job.source.url, title: job.source.title };
  return plugin.parseItem(job.source.url);
}

function isRole(sources: SourceDeclarations, job: CollectionJob, type: string, role: JobRole): boolean {
  return job.source.type === type && roleOf(sources, job) === role;
}

const SKIP_MESSAGES: Record<SkipReason, string> = {
  out_of_range: '超出收集範圍', subscription_paused: '訂閱已暫停', subscription_removed: '訂閱已移除', deleted: '文件已刪除',
};

function explicitRequestTime(sources: SourceDeclarations, job: CollectionJob): string | null {
  return roleOf(sources, job) === 'item' && job.parentId === null ? job.createdAt : null;
}

function diagnosticDetail(error: unknown): string | undefined {
  return error instanceof CollectorError && error.detail ? error.detail : undefined;
}

function redactedJobError(error: unknown): JobError {
  if (error instanceof CollectorError) return { code: error.code, message: limitText(redact(error.message), 500, 'head') };
  return { code: 'capture_failed', message: '收集失敗，請稍後再試。' };
}

