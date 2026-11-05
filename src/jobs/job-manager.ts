import { randomUUID } from 'node:crypto';
import type { Collector } from '../core/collector.js';
import type { CollectionPause } from '../core/collection-pause.js';
import type { Connectivity } from '../core/connectivity.js';
import { isRetryable, jobEventSubject, jobKey, roleOf, roleView, workKey } from '../core/job-role.js';
import type { SourceDeclarations } from '../core/source-registry.js';
import {
  CollectorError,
  type ChannelJobTrigger,
  type CollectionJob,
  type JobError,
  type JobItem,
  type JobOverview,
  type JobPage,
  type JobPhase,
  type JobResult,
  type JobRetry,
  type JobRole,
  type JobStopKind,
  type JobSubmission,
  type JobView,
  type JobSummary,
  type NewJobEvent,
  type SkipReason,
  type SubscriptionSettings,
  type WorkStatus,
} from '../core/types.js';
import type { Pacing, PacingEvent } from '../pacing/pacing-gate.js';
import type { FailureClass, ItemRef, SourcePlugin, SubscriptionTarget } from '../core/source-contract.js';
import { limitText, redact } from '../core/redact.js';
import { failedJobs, jobOverview, workStatus } from './job-board.js';
import type { JobStore } from './job-store.js';
import type { SubscriptionPort } from './subscription-port.js';
import { JobWaits, type WaitCondition } from './job-waits.js';
import { JobQueue, type QueuePlace } from './job-queue.js';
import { resumeInterrupted, resumedRecord, resumeMessage, storedItem } from './job-recovery.js';
import { SubscriptionReports } from './subscription-reports.js';
import { ACTIVE, progressOf, settledItem } from './check-items.js';

export interface JobLimits {
  /** Subscription resolution and discovery running at once. */
  discovery: number;
  /**
   * Single-item captures running at once. Every request of a source also passes its pacing group's
   * one request channel, so a higher number only lets a capture wait there for its turn.
   */
  capture: number;
  /** Jobs waiting in both queues together; further submissions are refused. */
  maxQueued: number;
}

export const DEFAULT_JOB_LIMITS: JobLimits = { discovery: 1, capture: 1, maxQueued: 500 };

/**
 * Automatic retries after a failure its source classifies as `retry_now`. A source's limit
 * (`rate_limited`) is not a failed attempt: the job waits for the cooldown and continues.
 */
export interface RetryPolicy {
  /** Attempts in total, the first one included. */
  maxAttempts: number;
  /** Wait before each retry; the last value repeats when attempts outnumber it. */
  delaysMs: number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, delaysMs: [30_000, 120_000] };

/** A limit reported without a cooldown end (no request channel) waits this long. */
const FALLBACK_COOLDOWN_MS = 5 * 60_000;

export interface JobManagerOptions {
  /** The Vault every job of this manager writes to. */
  vaultPath: string;
  /** ID of that Vault; null for a Vault without an ID, whose jobs are then known by path alone. */
  vaultId?: string | null;
  store: JobStore;
  /** The source types whose job kinds the manager reads; a job of a kind none of them has is kept as it is and not run. */
  sources: SourceDeclarations;
  /** The assembled source plugins; a job of any other type is kept as it is and not run. */
  plugins: readonly SourcePlugin[];
  documents: Collector;
  /** What subscription work reads from and reports to its subscriptions; required for subscription jobs. */
  subscriptions?: SubscriptionPort;
  limits?: Partial<JobLimits>;
  retry?: Partial<RetryPolicy>;
  now?: () => Date;
  createId?: () => string;
  /** Starts a timer and returns its cancel function; retries wait through it. */
  setTimer?: (callback: () => void, ms: number) => () => void;
  /** The device's request channels, one per pacing group; a group's cooldown pauses the steps of that group only. */
  pacing?: readonly Pacing[];
  /** A target a preview recently resolved for a classified subscription address; a subscription request accepted for it resolves no more. */
  recentTarget?: (type: string, url: string) => SubscriptionTarget | undefined;
  /**
   * While collection is paused no queued step starts, steps waiting for their turn at a source
   * return to the queue, and a transient failure returns its job to the queue without spending an
   * attempt; everything continues once collection does.
   */
  pause?: CollectionPause;
  /**
   * Confirms the device's network after a step fails with `network_error`. When the device is
   * offline the pause above is in force, so the failure returns the job to the queue.
   */
  connectivity?: Pick<Connectivity, 'confirm'>;
}

export interface JobListQuery {
  state?: 'active' | 'all';
  limit?: number;
  cursor?: string;
}

/** A check in progress: what it is doing and its item progress. */
export interface CheckActivity {
  jobId: string;
  status: WorkStatus;
  done: number;
  total: number;
}

/** What the jobs of one subscription are doing. */
export interface SubscriptionWork {
  /** The check queued or running for the subscription; null without one. */
  check: CheckActivity | null;
  /** Whether an item a check of the subscription queued is still capturing, a stopped check's included. */
  capturing: boolean;
}

/** A subscription request still resolving its address or subscribing. */
export interface SubscriptionRequestWork {
  jobId: string;
  url: string;
  /** The subscription it resolved to so far; null before resolution. */
  targetId: string | null;
  title: string | null;
  status: WorkStatus;
}

export interface SubscriptionWorkReport {
  /** Keyed by subscription ID; a subscription without any check job is absent. */
  subscriptions: Map<string, SubscriptionWork>;
  adds: SubscriptionRequestWork[];
}

/** What a queued or running check job is doing; items show `running` while their item job runs. */
export function checkActivity(sources: SourceDeclarations, job: CollectionJob): CheckActivity {
  return {
    jobId: job.id,
    status: workStatus(sources, job),
    done: job.progress?.done ?? 0,
    total: job.progress?.total ?? 0,
  };
}

/** How long a hold waits for running steps before giving up. */
export const HOLD_TIMEOUT_MS = 2 * 60_000;

/**
 * Accepts collection work for one Vault, runs it in bounded queues and records every state change.
 * A job's kind names its source type and role: `item` collects one item, `check` lists a
 * subscription and queues one item job per item found, `add` resolves an address and subscribes.
 * Discovery (resolution and listing) and single-item capture use separate queues; captures rotate
 * between the jobs that queued them so one large subscription cannot hold every slot. A source's
 * cooldown holds back only the jobs of its pacing group.
 */
export class JobManager {
  private readonly limits: JobLimits;
  private readonly retryPolicy: RetryPolicy;
  /** What each queued job waits for, and the timers that end the timed waits. */
  private readonly waits: JobWaits;
  private readonly now: () => Date;
  private readonly createId: () => string;
  /** Unfinished jobs, including check jobs waiting for their items. */
  private readonly jobs = new Map<string, CollectionJob>();
  private readonly keys = new Map<string, string>();
  private readonly activeByKey = new Map<string, string>();
  /** The newest check of each subscription that listed its source, and when its listing began, by dedupe key. */
  private readonly listings = new Map<string, { jobId: string; at: number }>();
  /** The order in which queued jobs start. */
  private readonly queue = new JobQueue();
  /** What check jobs and their items report to the subscriptions. */
  private readonly reports: SubscriptionReports;
  private runningDiscovery = 0;
  private runningCapture = 0;
  private readonly running = new Set<Promise<void>>();
  /** Check jobs that wait for an item job, keyed by the item job. */
  private readonly watchers = new Map<string, Set<string>>();
  private readonly settleWaiters = new Map<string, Array<(job: JobView) => void>>();
  /**
   * Running check jobs of a paused or removed subscription, with the reason. They no longer hold
   * the subscription's dedupe key, so a resume or new subscription starts its own job at once.
   */
  private readonly stoppedJobs = new Map<string, SkipReason>();
  /** Items a check job queued that the user then submitted directly; pausing never skips them. */
  private readonly manualClaims = new Set<string>();
  /** Finished check jobs whose end the subscription has not recorded yet; their waiters wait for it. */
  private readonly endingChecks = new Map<string, CollectionJob>();
  private closed = false;
  private resuming = false;
  /** Number of holds in force; while any is, no queued step starts. */
  private holds = 0;
  /**
   * Aborted by a hold or close: steps still waiting for their turn at a source give it up and return
   * to the queue (or are left for close() to record), so neither waits on a request channel.
   */
  private stepAbort = new AbortController();
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
      blocked: () => this.blocked,
      onCooldownEnded: (group) => this.endCooldown(group),
      onRetryDue: (id) => this.retryDue(id),
    });
    this.reports = new SubscriptionReports({
      sources: options.sources,
      port: () => this.subscriptions,
      parentOf: (id) => this.parentOf(id),
      classify: (job, error) => this.classify(job, error),
      failureLabel: (type, code) => this.plugin(type)?.failureLabels?.[code],
      stoppedCheck: (id) => this.stoppedJobs.has(id),
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

  /** Records a pacing group's cooldowns in this Vault's activity and follows them. */
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

  /** How cooldown messages name the source of a pacing group. */
  private pacingLabel(group: string): string {
    for (const plugin of this.plugins.values()) if (plugin.pacing?.group === group) return plugin.pacing.label;
    return group;
  }

  /** The plugin of a registered, assembled source type. */
  private plugin(type: string): SourcePlugin | undefined {
    return this.plugins.get(type);
  }

  private requirePlugin(type: string): SourcePlugin {
    const plugin = this.plugins.get(type);
    if (!plugin) throw new Error(`Source type ${type} is not assembled`);
    return plugin;
  }

  /** The pacing group a job's requests go through; null for a type without pacing. */
  private groupOf(job: CollectionJob): string | null {
    return this.plugins.get(job.source.type)?.pacing?.group ?? null;
  }

  private get subscriptions(): SubscriptionPort {
    const port = this.options.subscriptions;
    if (!port) throw new Error('This job manager runs no subscription work');
    return port;
  }

  /**
   * Starts or extends a group's cooldown; every queued job of the group then waits for it, as the
   * job that hit the limit does.
   */
  private enterCooldown(group: string, until: string): void {
    if (!this.waits.startCooldown(group, until)) return;
    for (const job of this.jobs.values()) {
      if (job.state === 'queued' && this.groupOf(job) === group) this.markWaiting(job);
    }
  }

  /** Gives a queued job the wait of its group's cooldown in force; outside a cooldown it does nothing. */
  private markWaiting(job: CollectionJob): void {
    const group = this.groupOf(job);
    const until = group ? this.waits.cooldownUntil(group) : null;
    if (!until || job.wait?.until === until) return;
    this.update(job, { wait: { reason: 'rate_limited', until } });
    this.syncItemWait(job);
  }

  /** Ends a group's cooldown: its waiting jobs drop their wait and queued steps start again. */
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

  /** Check jobs show the cooldown wait of each of their items. */
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

  private get vaultId(): string | null { return this.options.vaultId ?? null; }

  private vaultTag(): { vaultId?: string } {
    return this.vaultId ? { vaultId: this.vaultId } : {};
  }

  /** Whether a stored job belongs to this manager's Vault: the same path and the same Vault ID. */
  private owns(job: CollectionJob): boolean {
    return job.vaultPath === this.options.vaultPath && (job.vaultId ?? null) === this.vaultId;
  }

  /** Accepts a pasted address of a source type according to its syntax: one item, or a subscription. */
  async submit(type: string, url: string): Promise<JobSubmission> {
    const input = this.requirePlugin(type).classify(url);
    return input.kind === 'item' ? this.submitItem(type, input.ref.url) : this.submitSubscriptionAdd(type, input.url);
  }

  async submitItem(type: string, url: string): Promise<JobSubmission> {
    const submission = this.enqueueItem(type, this.requirePlugin(type).parseItem(url), null);
    await this.options.store.flush();
    this.pump();
    return submission;
  }

  /**
   * Resolves a subscription address and subscribes to it. A new subscription starts with
   * `settings` (the source type's defaults when omitted) and its first check follows them; an
   * existing subscription keeps its own state and settings. An address a preview resolved recently
   * keeps that target from acceptance on, so the job is named while it waits and resolves no more.
   */
  async submitSubscriptionAdd(type: string, url: string, settings?: SubscriptionSettings): Promise<JobSubmission> {
    const plugin = this.requirePlugin(type);
    const input = plugin.classify(url);
    const kind = this.options.sources.jobKind(type, 'add');
    if (input.kind !== 'subscription' || !kind || !plugin.subscription) {
      throw new CollectorError('invalid_subscription', plugin.prompts.subscriptionInput);
    }
    const accepted = settings ?? plugin.subscription.defaults;
    const target = this.options.recentTarget?.(type, input.url);
    const submission = this.enqueue(kind, type, workKey(type, 'add', input.url), {
      id: null, url: input.url, title: target?.title ?? null,
    }, null, {
      scope: { trigger: 'subscribe' },
      checkpoint: { settings: { ...accepted }, ...(target ? { target: { id: target.id, title: target.title, url: target.url } } : {}) },
    });
    await this.options.store.flush();
    this.pump();
    return submission;
  }

  /**
   * Starts one check of a subscription; an active job of the same subscription is returned
   * instead, so the check joins it. A check for the time the subscription came due (`dueAt`) is
   * also served by the subscription's newest check when that one began listing no earlier, however
   * long it waited before it listed. Only the subscriptions dispatch checks.
   */
  async submitCheck(type: string, subscription: SubscriptionTarget, trigger: ChannelJobTrigger, dueAt?: string): Promise<JobSubmission> {
    const submission = this.enqueueCheck(type, subscription, trigger, dueAt);
    await this.options.store.flush();
    this.pump();
    return submission;
  }

  get(id: string): JobView {
    const job = this.options.store.get(id);
    if (!job || !this.owns(job)) {
      throw new CollectorError('job_not_found', '找不到這個收集工作。');
    }
    return jobView(job);
  }

  /**
   * Top-level jobs, newest first. Items a check job started appear as that job's items, shown
   * `running` while their item job runs.
   */
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

  /**
   * Check jobs of one source type in the active Vault, grouped by subscription, newest first.
   * Finished jobs are kept up to the job store's limit, so older records drop out.
   */
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

  /**
   * What the jobs of one source type are doing for its subscriptions: per subscription, the check in
   * progress and whether any of its items is capturing; and the subscription requests still
   * resolving or subscribing, oldest first.
   */
  subscriptionWork(type: string): SubscriptionWorkReport {
    const subscriptions = new Map<string, SubscriptionWork>();
    const entry = (id: string): SubscriptionWork => {
      let work = subscriptions.get(id);
      if (!work) subscriptions.set(id, work = { check: null, capturing: false });
      return work;
    };
    for (const job of this.jobs.values()) {
      if (!isRole(this.options.sources, job, type, 'check') || !job.source.id) continue;
      // A stopped check is no check in progress, but its items may still be capturing.
      const work = entry(job.source.id);
      if (!this.stoppedJobs.has(job.id) && !work.check) work.check = checkActivity(this.options.sources, this.withLiveItems(job));
    }
    for (const [id, work] of subscriptions) work.capturing = this.pendingCaptures(type, id).checkItems.length > 0;
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

  /** Items record their item job's outcome when it ends; meanwhile a running item shows as `running`. */
  private withLiveItems<T extends JobView>(job: T): T {
    if (!job.items) return job;
    return {
      ...job,
      items: job.items.map((item) => item.state === 'queued' && item.jobId && this.jobs.get(item.jobId)?.state === 'running'
        ? { ...item, state: 'running' } : item),
    };
  }

  /**
   * Item captures still queued or running that may save a document of this subscription: the
   * items a check of the subscription requested, stopped jobs included, and every single-item
   * request of the type, whose publisher is known only once it is captured.
   */
  pendingCaptures(type: string, id: string): { checkItems: CollectionJob[]; singleItems: CollectionJob[] } {
    const checkItemIds = new Set<string>();
    for (const job of this.jobs.values()) {
      if (!isRole(this.options.sources, job, type, 'check') || job.source.id !== id) continue;
      for (const item of job.items ?? []) if (item.jobId) checkItemIds.add(item.jobId);
    }
    const checkItems: CollectionJob[] = [];
    const singleItems: CollectionJob[] = [];
    for (const job of this.jobs.values()) {
      if (!isRole(this.options.sources, job, type, 'item') || !ACTIVE.has(job.state)) continue;
      if (checkItemIds.has(job.id)) checkItems.push(structuredClone(job));
      else if (job.parentId === null) singleItems.push(structuredClone(job));
    }
    return { checkItems, singleItems };
  }

  /**
   * Converges a paused or removed subscription: its queued check job and the items it queued that
   * have not started end as skipped. An item already capturing finishes and is saved; a discovery
   * in progress sees the change before accepting any item.
   */
  stopSubscription(type: string, id: string, reason: SkipReason): void {
    // A check recording its end takes no more work; its source is free for the next check at once.
    for (const job of this.endingChecks.values()) {
      if (!isRole(this.options.sources, job, type, 'check') || job.source.id !== id) continue;
      const key = this.keys.get(job.id);
      if (key && this.activeByKey.get(key) === job.id) this.activeByKey.delete(key);
    }
    for (const job of [...this.jobs.values()]) {
      if (!isRole(this.options.sources, job, type, 'check') || job.source.id !== id) continue;
      if (job.state === 'queued') {
        this.queue.remove(job.id, this.placeOf(job));
        this.finish(job, 'completed', { outcome: 'skipped', skipReason: reason }, null);
        continue;
      }
      this.stoppedJobs.set(job.id, reason);
      const key = this.keys.get(job.id);
      if (key && this.activeByKey.get(key) === job.id) this.activeByKey.delete(key);
      for (const item of job.items ?? []) {
        const child = item.jobId ? this.jobs.get(item.jobId) : undefined;
        if (!child || child.parentId !== job.id || child.state !== 'queued' || this.manualClaims.has(child.id)) continue;
        this.queue.remove(child.id, this.placeOf(child));
        this.finish(child, 'completed', { outcome: 'skipped', skipReason: reason }, null);
      }
    }
    void this.options.store.flush().catch((error: unknown) => console.error('Job store flush failed', error));
  }

  /**
   * Retries a failed top-level job at the user's request with a new job and a fresh attempt budget.
   * An item is collected again and a subscription request subscribes with the settings it was
   * accepted with. A check job whose discovery failed checks its subscription now; one that
   * recorded items, failed or completed with some of them failing, collects those failed items
   * again. The new job records `retryOf`, the earlier one `retriedBy`; an active job of the same
   * target is returned as a duplicate instead.
   */
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
    if (job.retriedBy) throw new CollectorError('job_not_retryable', '這個工作已經重試過，請查看重試的工作。');
    let submission: JobSubmission;
    if (role === 'item') {
      submission = this.enqueueItem(type, itemRefOf(job, plugin), null, null, { retryOf: job.id }, job.source.title);
    } else if (role === 'add') {
      const settings = this.acceptedSettings(job);
      submission = this.enqueue(job.kind, type, jobKey(this.options.sources, job), { id: null, url: job.source.url, title: null }, null, {
        scope: { trigger: 'subscribe' }, checkpoint: { settings: { ...settings } }, retryOf: job.id,
      });
    } else if (job.items && job.items.length > 0) {
      const retryItems = job.items.filter((item) => item.state === 'failed')
        .map((item) => ({ sourceId: item.sourceId, title: item.title, url: item.url }));
      if (retryItems.length === 0) throw new CollectorError('job_not_retryable', `這個工作沒有失敗的${noun}。`);
      // Collecting failed items again is not a check: no dispatch, and the subscription's check time stays.
      const stopped = await this.subscriptions.stopped(type, job.source.id!);
      if (stopped === 'subscription_removed') throw new CollectorError('subscription_not_found', `找不到這個 ${this.options.sources.subscriptionKindLabel(type)}訂閱。`);
      if (stopped) throw new CollectorError('subscription_paused', `「${job.source.title ?? job.source.id}」已暫停，請先恢復訂閱。`);
      submission = this.enqueue(job.kind, type, jobKey(this.options.sources, job), {
        id: job.source.id, url: job.source.url, title: job.source.title,
      }, null, { scope: { trigger: 'manual' }, checkpoint: { retryItems }, retryOf: job.id });
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
    const retried = this.jobs.get(submission.job.id) ?? this.options.store.get(submission.job.id)!;
    this.event(retried, {
      eventType: 'job.retry_requested', retryOf: job.id,
      message: submission.deduplicated ? '已手動重試，併入進行中的工作。' : '已手動重試，重新排入收集。',
    });
    await this.options.store.flush();
    this.pump();
    return submission;
  }

  /** The jobs page: what runs now, what waits in the order it starts, and the failed section. */
  async overview(): Promise<JobOverview> {
    const jobs = this.options.store.list(this.options.vaultPath, this.vaultId)
      .map((job) => this.withLiveItems(jobView(this.jobs.get(job.id) ?? job)));
    return jobOverview(jobs, {
      now: this.now(),
      sources: this.options.sources,
      queuePosition: (job) => this.queue.position(job.id),
      hasDocument: (type, key) => this.hasDocument(type, key),
    });
  }

  /**
   * Removes a failed single item or subscription request from the failed section; its record and
   * activity stay. Any other job is not in that section and cannot be removed.
   */
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
    return jobView(this.options.store.get(id)!);
  }

  private async hasDocument(type: string, key: string): Promise<boolean> {
    return (await this.options.documents.findExisting({ sourceType: type, sourceId: key })) !== null;
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
      else if (job.state === 'failed' && !job.retriedBy && !job.dismissedAt) summary.failed += 1;
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
    // Steps waiting for their turn at a source go back to the queue instead of holding this up.
    this.stopWaitingSteps('收集步驟已暫停。');
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      this.continueSteps();
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

  /** True while a hold or the collection pause keeps queued steps from starting. */
  private get blocked(): boolean {
    return this.holds > 0 || this.options.pause?.paused === true;
  }

  /** Steps waiting for their turn at a source give it up and return to the queue. */
  private stopWaitingSteps(message: string): void {
    if (!this.stepAbort.signal.aborted) this.stepAbort.abort(new CollectorError('vault_busy', message));
  }

  /** Once nothing blocks them, queued steps start again. */
  private continueSteps(): void {
    if (this.blocked) return;
    if (this.stepAbort.signal.aborted) this.stepAbort = new AbortController();
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

  /**
   * Continues the Vault's interrupted jobs (see `resumeInterrupted`); called once when the Vault
   * opens, before the scheduler starts.
   */
  async resume(): Promise<void> {
    if (this.closed) return;
    // Work the subscriptions dispatch meanwhile waits in line until every interrupted job is back.
    this.resuming = true;
    try {
      await resumeInterrupted({
        sources: this.options.sources,
        stored: () => this.options.store.list(this.options.vaultPath, this.vaultId),
        storedJob: (id) => this.options.store.get(id),
        runs: (type) => this.plugin(type) !== undefined,
        itemName: (type) => this.itemName(type),
        stopped: (type, id) => this.subscriptions.stopped(type, id),
        settle: (job, state, result, error) => {
          this.jobs.set(job.id, job);
          this.finish(job, state, result, error);
        },
        updateStored: (job, patch) => this.updateStored(job, patch),
        restore: (job, options) => this.restore(job, options),
        subscribeResolved: (job, target) => this.subscribeResolved(job, target),
        watchItems: (id) => this.watchItems(id),
      });
      await this.options.store.flush();
    } finally {
      this.resuming = false;
    }
    this.pump();
  }

  /**
   * Makes an interrupted job active again and, unless told otherwise, returns it to the queue or to
   * waiting for its next attempt.
   */
  private restore(stored: CollectionJob, options: { queue: boolean } = { queue: true }): CollectionJob {
    const job = resumedRecord(this.options.sources, stored, this.now().toISOString());
    // A check past discovery runs again at once, waiting for its items.
    const waitsForItems = job.state === 'running';
    const key = jobKey(this.options.sources, job);
    this.jobs.set(job.id, job);
    this.keys.set(job.id, key);
    this.activeByKey.set(key, job.id);
    if (job.claimedByUser) this.manualClaims.add(job.id);
    const waits = this.waits.stored(job);
    const group = this.groupOf(job);
    if (job.wait) {
      if (group && waits.cooldown) this.enterCooldown(group, waits.cooldown.until);
      else delete job.wait;
    }
    this.options.store.put(job);
    const stopReason = job.recovery?.lastStop ?? 'unknown';
    this.event(job, {
      severity: job.parentId ? 'debug' : 'info', eventType: 'job.resumed', stopReason, message: resumeMessage(stopReason),
    });
    if (waitsForItems || !options.queue) return job;
    this.markWaiting(job);
    if (waits.retry) this.waitFor(job, waits.retry);
    else this.requeue(job);
    return job;
  }

  /** A restored check past discovery waits for its restored items again; one with none left ends. */
  private watchItems(id: string): void {
    const job = this.jobs.get(id);
    if (!job?.items) return;
    const items = job.items.map((item) => {
      const child = item.jobId ? this.jobs.get(item.jobId) : undefined;
      if (!child) return storedItem({ storedJob: (childId) => this.options.store.get(childId), itemName: (type) => this.itemName(type) }, job, item);
      const watching = this.watchers.get(child.id) ?? new Set<string>();
      watching.add(job.id);
      this.watchers.set(child.id, watching);
      return { ...item, state: child.state, ...(child.retry ? { retry: child.retry } : {}) };
    });
    this.update(job, { items, progress: progressOf(items) });
    if (this.jobs.has(job.id)) this.completeCheckIfDone(job);
  }

  /** How a source type names one item in a message. */
  private itemName(type: string): string {
    const declaration = this.plugin(type)?.item;
    return declaration ? `這${declaration.measure}${declaration.noun}` : '這個項目';
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
    for (const unsubscribe of this.unsubscribePacing) unsubscribe();
    this.unsubscribePause?.();
    this.waits.close();
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
    for (const job of [...this.jobs.values()]) {
      this.options.store.interrupt(job, reason, { stop });
      this.release(job);
      this.notifySettled(this.options.store.get(job.id)!);
    }
    this.queue.clear();
    await this.options.store.flush();
  }

  private enqueueItem(
    type: string, ref: Pick<ItemRef, 'key' | 'url'>, parentId: string | null, publishedNotBefore: string | null = null,
    extra: Pick<CollectionJob, 'retryOf'> = {}, title: string | null = null,
  ): JobSubmission {
    return this.enqueue(this.options.sources.jobKind(type, 'item')!, type, workKey(type, 'item', ref.key), {
      id: ref.key, url: ref.url, title,
    }, parentId, { ...(publishedNotBefore ? { publishedNotBefore } : {}), ...extra });
  }

  private enqueueCheck(type: string, subscription: SubscriptionTarget, trigger: ChannelJobTrigger, dueAt?: string): JobSubmission {
    const kind = this.options.sources.jobKind(type, 'check');
    if (!kind) throw new Error(`Source type ${type} has no check jobs`);
    const key = workKey(type, 'check', subscription.id);
    const listing = dueAt && !this.activeByKey.has(key) ? this.listings.get(key) : undefined;
    if (listing && listing.at >= new Date(dueAt!).getTime() && this.options.store.get(listing.jobId)) {
      return { job: this.get(listing.jobId), deduplicated: true };
    }
    return this.enqueue(kind, type, key, {
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
    if (activeId) {
      const active = this.jobs.get(activeId);
      if (active && parentId === null && roleOf(this.options.sources, active) === 'item') {
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
      ...this.vaultTag(),
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

  /**
   * Puts a job back in line: items in their lane, subscription work in the discovery queue.
   * `front` returns a step that was stopped before it reached its source to the head of the line.
   */
  private requeue(job: CollectionJob, front = false): void {
    this.queue.add(job.id, this.placeOf(job), front);
  }

  /** The line a job waits in: an item in the lane of the check that queued it, or its own. */
  private placeOf(job: CollectionJob): QueuePlace {
    return roleOf(this.options.sources, job) === 'item' ? { line: 'capture', lane: job.parentId ?? job.id } : { line: 'discovery' };
  }

  /**
   * Puts a job whose step cannot go on back in line to wait for `condition`; a closing manager
   * leaves it for close() to record. A step a hold, the collection pause or a cooldown stopped had
   * its turn, so it returns to the head of its queue. A job waiting for its next attempt leaves the
   * queue and joins its back once the time comes.
   */
  private waitFor(job: CollectionJob, condition: WaitCondition): void {
    if (this.closed) return;
    if (condition.kind === 'retry') {
      this.waits.startRetry(job.id, condition.until);
      return;
    }
    this.syncItemWait(job);
    this.requeue(job, true);
  }

  /** A job's retry time came: it joins the back of its queue. */
  private retryDue(id: string): void {
    const job = this.jobs.get(id);
    if (this.closed || !job) return;
    this.requeue(job);
    this.pump();
  }

  /** A step stopped by a hold or the collection pause returns to the queue without spending an attempt. */
  private returnToQueue(job: CollectionJob): void {
    this.update(job, { state: 'queued' });
    this.waitFor(job, { kind: 'collection' });
  }

  /**
   * The source limited requests: the job waits in the queue for its group's cooldown and continues
   * by itself. Its attempts are unchanged.
   */
  private deferForCooldown(job: CollectionJob, retryAt: string | undefined): void {
    const group = this.groupOf(job);
    const until = retryAt ?? (group ? this.waits.cooldownUntil(group) : null)
      ?? new Date(this.now().getTime() + FALLBACK_COOLDOWN_MS).toISOString();
    if (group) this.enterCooldown(group, until);
    this.update(job, { state: 'queued', wait: { reason: 'rate_limited', until } });
    this.event(job, {
      eventType: 'job.deferred',
      message: `${group ? this.pacingLabel(group) : this.plugin(job.source.type)?.label ?? job.source.type} 暫時限制連線，約 ${clockTime(until)} 自動繼續。`,
      until, ...(job.phase ? { phase: job.phase } : {}),
    });
    this.waitFor(job, { kind: 'cooldown', until });
  }

  /** How a step that threw ended when the throw was not its own failure; true when handled. */
  private async handledInterruption(job: CollectionJob, error: unknown, signal: AbortSignal): Promise<boolean> {
    // A failure for lack of a network confirms the device's network first, unless collection is
    // already paused and the failure returns to the queue anyway. A close while it waits leaves the
    // job for close() to record as interrupted.
    if (error instanceof CollectorError && error.code === 'network_error' && !this.options.pause?.paused && !(signal.aborted && error === signal.reason)) {
      await this.options.connectivity?.confirm();
      if (this.closed) return true;
    }
    if (signal.aborted && error === signal.reason) {
      // A close records the job as interrupted; a hold or the collection pause puts it back in line.
      if (!this.closed) this.returnToQueue(job);
      return true;
    }
    // A transient failure while collection is paused, such as a lost network, is the pause's doing,
    // not the source's.
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

  /** Whether a queued step may start now; the ID of a job that ended meanwhile is dropped when its turn comes. */
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
    // A job that reached the save phase, or recorded the saved document, before it stopped created
    // whatever document findExisting now returns for this item; that document is its own result.
    const savedEarlier = job.checkpoint?.savedDocumentId !== undefined || job.phase === 'save';
    const { signal } = this.stepAbort;
    this.start(job, 'capture');
    try {
      const plugin = this.requirePlugin(job.source.type);
      const ref = itemRefOf(job, plugin);
      const key = { sourceType: plugin.id, sourceId: ref.key };
      const { documents } = this.options;
      let document = await documents.findExisting(key);
      let outcome: 'created' | 'existing' = document && savedEarlier ? 'created' : 'existing';
      if (!document && await documents.isDeletedFor(key, { explicitAt: explicitRequestTime(this.options.sources, job) })) {
        // A deleted item is skipped before capture, so the source is not asked for content the save would refuse.
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
        this.update(job, { phase: 'save', source: { ...job.source, title: captured.title, publisher: captured.publisher.name } });
        // The save phase is on disk before the document is, so a restart knows who saved it.
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
      await this.failOrRetry(job, errorDetails(error), diagnosticDetail(error));
    }
  }

  private async runDiscovery(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    const { signal } = this.stepAbort;
    try {
      if (roleOf(this.options.sources, job) === 'add') await this.addSubscription(job, signal);
      else await this.discover(job, signal);
    } catch (error) {
      // A step cut short by shutdown is left for close() to record as interrupted.
      if (this.closed) return;
      if (await this.handledInterruption(job, error, signal)) return;
      await this.failOrRetry(job, errorDetails(error), diagnosticDetail(error));
    }
  }

  /**
   * Schedules another attempt after a transient failure while attempts remain; otherwise the job
   * fails, and a job that was retried says how many attempts it made. A failed item of a check
   * counts one attempt of its subscription's failure record first.
   */
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
      // Transient failures that outlast the attempts of one check leave the item to the next check.
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

  /** Check jobs show the retry state of each of their items. */
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
    // A job interrupted while subscribing already knows its target and may have added it; a job
    // accepted after a preview subscribes to the previewed target.
    const subscribing = job.checkpoint?.subscribing;
    const resolved = subscribing
      ? { id: subscribing.subscriptionId, title: subscribing.title, url: subscribing.url }
      : job.checkpoint?.target ?? await plugin.resolveTarget!(job.source.url, { signal });
    // The service stopped while resolving; close() records the job as interrupted.
    if (this.closed) return;
    await this.subscribeResolved(job, resolved);
  }

  /**
   * Hands a subscription request's resolved target and accepted settings to the subscriptions,
   * which subscribe it and dispatch its first check, and ends the request with that check.
   */
  private async subscribeResolved(job: CollectionJob, target: SubscriptionTarget): Promise<void> {
    const result = await this.subscriptions.subscribe(job.source.type, target, this.acceptedSettings(job), {
      resumed: Boolean(job.checkpoint?.subscribing),
      beforeCreate: async () => {
        this.update(job, {
          source: { ...job.source, id: target.id, title: target.title },
          checkpoint: { ...job.checkpoint, subscribing: { subscriptionId: target.id, title: target.title, url: target.url } },
        });
        await this.options.store.flush();
      },
    });
    const { subscription, check } = result;
    this.update(job, { source: { ...job.source, id: subscription.id, title: subscription.title } });
    this.finish(job, 'completed', {
      outcome: result.outcome, subscriptionId: subscription.id, ...(check ? { followUpJobId: check.job.id } : {}),
    }, null);
  }

  /** The settings a subscription job subscribes with: the ones accepted with it, else the source type's defaults. */
  private acceptedSettings(job: CollectionJob): SubscriptionSettings {
    return job.checkpoint?.settings ?? { ...this.requirePlugin(job.source.type).subscription!.defaults };
  }

  /**
   * Lists the subscription and queues one item job per item found. The plan comes from the
   * subscription at this moment and its range is measured back from now, so a job that waited in
   * the queue or across a restart checks the range a check started now would.
   */
  private async discover(job: CollectionJob, signal: AbortSignal): Promise<void> {
    this.start(job, 'discover');
    const type = job.source.type;
    const id = job.source.id!;
    const plugin = this.requirePlugin(type);
    const retryItems = job.checkpoint?.retryItems;
    const at = this.now();
    const plan = await this.subscriptions.planCheck(type, id, at);
    if ('stopped' in plan) {
      this.finish(job, 'completed', { outcome: 'skipped', skipReason: plan.stopped }, null);
      return;
    }
    // Collecting failed items again lists nothing.
    if (!retryItems) this.listings.set(jobKey(this.options.sources, job), { jobId: job.id, at: at.getTime() });
    const target = { ...plan.target, title: job.source.title ?? plan.target.title, url: job.source.url };
    const discovery = retryItems
      ? {
        candidates: null,
        items: retryItems.map((item) => ({ key: item.sourceId, title: item.title, url: item.url })),
        publishedNotBefore: null,
      }
      : await plan.select(
        plugin.listSubscriptionItems!(target, { signal }),
        (key) => this.options.documents.isKnown({ sourceType: type, sourceId: key }),
      );
    // The service stopped while discovering; close() records the job as interrupted.
    if (this.closed) return;
    const reason = this.stoppedJobs.get(job.id) ?? await this.subscriptions.stopped(type, id);
    if (reason) {
      this.finish(job, 'completed', { outcome: 'skipped', skipReason: reason }, null);
      return;
    }
    this.event(job, {
      eventType: 'channel.discovered', message: `發現 ${discovery.items.length} ${plugin.item.measure}${plugin.item.noun}。`, phase: 'discover',
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
        // An item that could not be queued (for example, a full queue) fails here; the next check finds it again while it is a candidate.
        item.state = 'failed';
        item.error = errorDetails(error);
      }
      return item;
    });
    this.update(job, { phase: 'capture', items, progress: progressOf(items) });
    // The check is reported only after the accepted items are recorded, so a stop in between finds them again.
    await this.options.store.flush();
    if (this.stoppedJobs.has(job.id) || retryItems) {
      // A job stopped while its items were being recorded leaves the subscription to the later job;
      // a retry of earlier items is not a check.
      this.completeCheckIfDone(job);
      return;
    }
    const stopped = await this.subscriptions.checked(type, id, {
      candidates: new Set(discovery.candidates ?? []), collecting: new Set(discovery.items.map((item) => item.key)),
    });
    if (stopped) this.stopSubscription(type, id, stopped);
    if (this.jobs.has(job.id)) this.completeCheckIfDone(job);
  }

  /** A job's parent, live or stored. */
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
      // Failed items are left to later checks of the subscription; they never fail the check itself.
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
    // Check items stop showing the wait once the next attempt starts.
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
    // The subscription records the check's end before the job reads as finished anywhere, so whoever
    // sees the job finished reads its subscription with the end recorded. Meanwhile the job takes no
    // more work, but a submission for the same source still joins it.
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
          && progress.created === 0 && progress.failed === 0 && (progress.skipped ?? 0) === 0
          ? 'empty' : 'other') as 'empty' | 'network_error' | 'other',
      created: progress.created, existing: progress.existing, failed: progress.failed, skipped: progress.skipped ?? 0,
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
    const settled = this.options.store.get(job.id)!;
    this.onItemSettled(settled);
    this.notifySettled(settled);
  }

  private release(job: CollectionJob): void {
    this.waits.endRetry(job.id);
    this.jobs.delete(job.id);
    this.stoppedJobs.delete(job.id);
    this.manualClaims.delete(job.id);
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

  /**
   * Records an event of `job` with what the activity view shows and filters by: source type, title,
   * subscription, parent and trigger.
   */
  private event(job: CollectionJob, entry: Omit<NewJobEvent, 'vaultPath' | 'jobId'>): void {
    this.options.store.event({ ...entry, ...jobEventSubject(this.options.sources, job, this.parentOf) });
  }

  /** How the job's source type treats a failure; an unregistered type's failures are not retried. */
  private classify(job: CollectionJob, error: { code: string }): FailureClass {
    return this.plugin(job.source.type)?.classifyFailure(error) ?? 'skip';
  }

  /** What a finished job's activity entry says; skip reasons and counts make the log readable on its own. */
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
    const count = (value: number) => `${value}${plugin ? ` ${plugin.item.measure}${plugin.item.noun}` : ''}`;
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

/** The job as UI and Agents read it; the checkpoint and the user-claim flag only serve restarts. */
function jobView(job: CollectionJob): JobView {
  const { checkpoint: _checkpoint, claimedByUser: _claimed, ...view } = job;
  return view;
}

/**
 * The item an item job collects. Its key is the one recorded when the job was queued, so an item
 * whose key its address does not determine keeps the key its listing gave it.
 */
function itemRefOf(job: CollectionJob, plugin: SourcePlugin): ItemRef {
  if (job.source.id) return { key: job.source.id, url: job.source.url, title: job.source.title };
  return plugin.parseItem(job.source.url);
}

function isRole(sources: SourceDeclarations, job: CollectionJob, type: string, role: JobRole): boolean {
  return job.source.type === type && roleOf(sources, job) === role;
}

const SKIP_MESSAGES: Record<SkipReason, string> = {
  out_of_range: '超出收集範圍', subscription_paused: '訂閱已暫停', subscription_removed: '訂閱已移除',
  superseded: '已由較新的工作接續', deleted: '文件已刪除',
};

/**
 * The latest time the user asked for this item by itself: a direct submission or a retry of one,
 * including a later direct submission merged into the same job, or an item a check job queued
 * when the user also submitted it. Null for subscription work.
 */
function explicitRequestTime(sources: SourceDeclarations, job: CollectionJob): string | null {
  if (roleOf(sources, job) !== 'item') return null;
  if (job.parentId === null) return job.checkpoint?.claimedAt ?? job.createdAt;
  return job.claimedByUser ? job.checkpoint?.claimedAt ?? null : null;
}

/** External tool output carried by the error, for the activity log's diagnostic detail. */
function diagnosticDetail(error: unknown): string | undefined {
  return error instanceof CollectorError && error.detail ? error.detail : undefined;
}

function errorDetails(error: unknown): JobError {
  // Job errors are written to the job store and the Vault's subscription files and reach the UI and Agents.
  if (error instanceof CollectorError) return { code: error.code, message: limitText(redact(error.message), 500, 'head') };
  return { code: 'capture_failed', message: '收集失敗，請稍後再試。' };
}

