import { randomUUID } from 'node:crypto';
import { selectCandidates } from '../subscriptions/candidates.js';
import type { Collector } from '../core/collector.js';
import type { CollectionPause } from '../core/collection-pause.js';
import type { Connectivity } from '../core/connectivity.js';
import { jobKind, jobRole, subscriptionKindLabel } from '../core/source-registry.js';
import {
  CollectorError,
  type ChannelJobTrigger,
  type CollectionJob,
  isRetryable,
  type JobError,
  type JobItem,
  type JobOverview,
  type JobPage,
  type JobPhase,
  type JobProgress,
  type JobResult,
  type JobRetry,
  type JobRole,
  type JobState,
  type JobStopKind,
  type JobSubmission,
  type JobSummary,
  type ItemFailureEntry,
  MAX_CHECK_ATTEMPTS,
  type SkipReason,
  type SubscriptionSettings,
  type WorkStatus,
} from '../core/types.js';
import type { Pacing, PacingEvent } from '../pacing/pacing-gate.js';
import type { FailureClass, ItemRef, SourcePlugin, SubscriptionTarget } from '../plugins/types.js';
import { limitText, redact } from '../activity/redact.js';
import { failedJobs, jobOverview, workStatus } from './job-board.js';
import type { JobStore, NewJobEvent } from './job-store.js';
import type { CheckEnd, SubscriptionPort } from './subscription-port.js';
import { JobWaits, type WaitCondition } from './job-waits.js';

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

/**
 * Restarts that may find a job in the middle of a step before it stops resuming. A job that keeps
 * crashing the service would otherwise be resumed into the same crash on every start.
 */
export const MAX_UNCLEAN_STOPS = 3;

/** A limit reported without a cooldown end (no request channel) waits this long. */
const FALLBACK_COOLDOWN_MS = 5 * 60_000;

const INTERRUPTED_REPEATEDLY = 'interrupted_repeatedly';

/** Why a check stops without ending: its subscription was paused or removed, or a later job took over. */
const STOP_REASONS: ReadonlySet<SkipReason> = new Set(['subscription_paused', 'subscription_removed', 'superseded']);

export interface JobManagerOptions {
  /** The Vault every job of this manager writes to. */
  vaultPath: string;
  /** ID of that Vault; null for a Vault without an ID, whose jobs are then known by path alone. */
  vaultId?: string | null;
  store: JobStore;
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
export function checkActivity(job: CollectionJob): CheckActivity {
  return {
    jobId: job.id,
    status: workStatus(job),
    done: job.progress?.done ?? 0,
    total: job.progress?.total ?? 0,
  };
}

const ACTIVE: ReadonlySet<JobState> = new Set(['queued', 'running']);
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
  private readonly discoveryQueue: string[] = [];
  private readonly captureLanes = new Map<string, string[]>();
  /** When each job last joined its queue; a job put back at the head gets a number before all others. */
  private readonly queueOrder = new Map<string, number>();
  private queueBack = 0;
  private queueFront = 0;
  private laneOrder: string[] = [];
  private runningDiscovery = 0;
  private runningCapture = 0;
  private readonly running = new Set<Promise<void>>();
  /** Check jobs that wait for an item job, keyed by the item job. */
  private readonly watchers = new Map<string, Set<string>>();
  private readonly settleWaiters = new Map<string, Array<(job: CollectionJob) => void>>();
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
    const kind = jobKind(type, 'add');
    if (input.kind !== 'subscription' || !kind || !plugin.subscription) {
      throw new CollectorError('invalid_subscription', plugin.prompts.subscriptionInput);
    }
    const accepted = settings ?? plugin.subscription.defaults;
    const target = this.options.recentTarget?.(type, input.url);
    const submission = this.enqueue(kind, type, `${type}:add:${input.url.toLowerCase()}`, {
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
   * instead, so the check joins it. Only the subscriptions dispatch checks.
   */
  async submitCheck(type: string, subscription: SubscriptionTarget, trigger: ChannelJobTrigger): Promise<JobSubmission> {
    const submission = this.enqueueCheck(type, subscription, trigger);
    await this.options.store.flush();
    this.pump();
    return submission;
  }

  get(id: string): CollectionJob {
    const job = this.options.store.get(id);
    if (!job || !this.owns(job)) {
      throw new CollectorError('job_not_found', '找不到這個收集工作。');
    }
    return publicJob(job);
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
    const page = jobs.slice(0, limit).map((job) => this.withLiveItems(publicJob(job)));
    return { jobs: page, nextCursor: jobs.length > limit ? page[page.length - 1]!.id : null };
  }

  /**
   * Check jobs of one source type in the active Vault, grouped by subscription, newest first.
   * Finished jobs are kept up to the job store's limit, so older records drop out.
   */
  checkJobs(type: string): Map<string, CollectionJob[]> {
    const bySubscription = new Map<string, CollectionJob[]>();
    for (const job of this.options.store.list(this.options.vaultPath, this.vaultId)) {
      if (!isRole(job, type, 'check') || !job.source.id) continue;
      const jobs = bySubscription.get(job.source.id) ?? [];
      jobs.push(job);
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
      if (!isRole(job, type, 'check') || !job.source.id) continue;
      // A stopped check is no check in progress, but its items may still be capturing.
      const work = entry(job.source.id);
      if (!this.stoppedJobs.has(job.id) && !work.check) work.check = checkActivity(this.withLiveItems(job));
    }
    for (const [id, work] of subscriptions) work.capturing = this.pendingCaptures(type, id).checkItems.length > 0;
    const adds = [...this.jobs.values()]
      .filter((job) => isRole(job, type, 'add'))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((job): SubscriptionRequestWork => {
        const subscribing = job.checkpoint?.subscribing;
        return {
          jobId: job.id, url: job.source.url,
          targetId: job.result?.subscriptionId ?? subscribing?.subscriptionId ?? null,
          title: job.source.title ?? subscribing?.title ?? null,
          status: workStatus(job),
        };
      });
    return { subscriptions, adds };
  }

  /** Items record their item job's outcome when it ends; meanwhile a running item shows as `running`. */
  private withLiveItems(job: CollectionJob): CollectionJob {
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
      if (!isRole(job, type, 'check') || job.source.id !== id) continue;
      for (const item of job.items ?? []) if (item.jobId) checkItemIds.add(item.jobId);
    }
    const checkItems: CollectionJob[] = [];
    const singleItems: CollectionJob[] = [];
    for (const job of this.jobs.values()) {
      if (!isRole(job, type, 'item') || !ACTIVE.has(job.state)) continue;
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
      if (!isRole(job, type, 'check') || job.source.id !== id) continue;
      const key = this.keys.get(job.id);
      if (key && this.activeByKey.get(key) === job.id) this.activeByKey.delete(key);
    }
    for (const job of [...this.jobs.values()]) {
      if (!isRole(job, type, 'check') || job.source.id !== id) continue;
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
        const child = item.jobId ? this.jobs.get(item.jobId) : undefined;
        if (!child || child.parentId !== job.id || child.state !== 'queued' || this.manualClaims.has(child.id)) continue;
        this.removeFromLane(child);
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
    const role = jobRole(job.kind)?.role;
    const plugin = this.plugin(type);
    if (!role || !plugin) throw new CollectorError('job_not_retryable', '這個工作無法重試。');
    const { noun } = plugin.item;
    const target = plugin.subscription?.targetNoun ?? '訂閱';
    if (job.parentId !== null) {
      throw new CollectorError('job_not_retryable', `${target}收集中的${noun}隨${target}工作處理，請重試${target}工作。`);
    }
    if (!isRetryable(job)) throw new CollectorError('job_not_retryable', `只有失敗或有${noun}失敗的工作可以重試。`);
    if (job.retriedBy) throw new CollectorError('job_not_retryable', '這個工作已經重試過，請查看重試的工作。');
    let submission: JobSubmission;
    if (role === 'item') {
      submission = this.enqueueItem(type, itemRefOf(job, plugin), null, null, { retryOf: job.id }, job.source.title);
    } else if (role === 'add') {
      const settings = this.acceptedSettings(job);
      submission = this.enqueue(job.kind, type, jobKey(job), { id: null, url: job.source.url, title: null }, null, {
        scope: { trigger: 'subscribe' }, checkpoint: { settings: { ...settings } }, retryOf: job.id,
      });
    } else if (job.items && job.items.length > 0) {
      const retryItems = job.items.filter((item) => item.state === 'failed')
        .map((item) => ({ sourceId: item.sourceId, title: item.title, url: item.url }));
      if (retryItems.length === 0) throw new CollectorError('job_not_retryable', `這個工作沒有失敗的${noun}。`);
      // Collecting failed items again is not a check: no dispatch, and the subscription's check time stays.
      const stopped = await this.subscriptions.stopped(type, job.source.id!);
      if (stopped === 'subscription_removed') throw new CollectorError('subscription_not_found', `找不到這個 ${subscriptionKindLabel(type)}訂閱。`);
      if (stopped) throw new CollectorError('subscription_paused', `「${job.source.title ?? job.source.id}」已暫停，請先恢復訂閱。`);
      submission = this.enqueue(job.kind, type, jobKey(job), {
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
      severity: 'info', eventType: 'job.retry_requested', retryOf: job.id,
      message: submission.deduplicated ? '已手動重試，併入進行中的工作。' : '已手動重試，重新排入收集。',
    });
    await this.options.store.flush();
    this.pump();
    return submission;
  }

  /** The jobs page: what runs now, what waits in the order it starts, and the failed section. */
  async overview(): Promise<JobOverview> {
    const jobs = this.options.store.list(this.options.vaultPath, this.vaultId)
      .map((job) => this.withLiveItems(publicJob(this.jobs.get(job.id) ?? job)));
    return jobOverview(jobs, {
      now: this.now(),
      queuePosition: (job) => this.queueOrder.get(job.id),
      hasDocument: (type, key) => this.hasDocument(type, key),
    });
  }

  /**
   * Removes a failed single item or subscription request from the failed section; its record and
   * activity stay. Any other job is not in that section and cannot be removed.
   */
  async dismiss(id: string): Promise<CollectionJob> {
    const job = this.options.store.get(id);
    if (!job || !this.owns(job)) throw new CollectorError('job_not_found', '找不到這個收集工作。');
    const listed = await failedJobs(this.options.store.list(this.options.vaultPath, this.vaultId), {
      now: this.now(), hasDocument: (type, key) => this.hasDocument(type, key),
    });
    if (!listed.some((candidate) => candidate.id === id)) {
      throw new CollectorError('job_not_dismissable', '只有失敗清單中的工作可以移除。');
    }
    const timestamp = this.now().toISOString();
    this.updateStored(job, { dismissedAt: timestamp, updatedAt: timestamp });
    this.event(job, { severity: 'info', eventType: 'job.dismissed', message: '已從失敗清單移除。' });
    await this.options.store.flush();
    return publicJob(this.options.store.get(id)!);
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
  whenSettled(id: string): Promise<CollectionJob> {
    if (!this.jobs.has(id) && !this.endingChecks.has(id)) return Promise.resolve(this.get(id));
    return new Promise((resolve) => {
      const waiters = this.settleWaiters.get(id) ?? [];
      waiters.push(resolve);
      this.settleWaiters.set(id, waiters);
    });
  }

  /**
   * Continues the Vault's interrupted jobs; called once when the Vault opens, before the scheduler
   * starts. Each job keeps its trigger, finished items, saved documents and failed attempts; a
   * check job that had not recorded its items discovers them as any check starting now would.
   * A job that a later job of the same item or subscription took over, a check job whose
   * subscription was paused or removed, and a job that kept stopping the service in mid-step end
   * instead. A job of a source type this process does not run stays interrupted, untouched.
   */
  async resume(): Promise<void> {
    if (this.closed) return;
    // Work the subscriptions dispatch meanwhile waits in line until every interrupted job is back.
    this.resuming = true;
    try {
      await this.resumeJobs();
    } finally {
      this.resuming = false;
    }
    this.pump();
  }

  private async resumeJobs(): Promise<void> {
    const { store } = this.options;
    const superseded: CollectionJob[] = [];
    const pending: CollectionJob[] = [];
    const seen = new Set<string>();
    const unknownTypes = new Set<string>();
    // The list is newest first, so a job whose key was already seen has a later job of the same target.
    for (const job of store.list(this.options.vaultPath, this.vaultId)) {
      if (job.state === 'interrupted' && (!jobRole(job.kind) || !this.plugin(job.source.type))) {
        unknownTypes.add(job.kind);
        continue;
      }
      const key = jobKey(job);
      const later = seen.has(key);
      seen.add(key);
      if (job.state === 'interrupted') (later ? superseded : pending).push(job);
    }
    for (const kind of unknownTypes) console.warn(`Interrupted ${kind} jobs are kept and not resumed: their source type is not available`);
    pending.reverse();
    const settled = new Set<string>();
    const settle = (job: CollectionJob, state: 'completed' | 'failed', result: JobResult, error: JobError | null) => {
      settled.add(job.id);
      this.jobs.set(job.id, job);
      this.finish(job, state, result, error);
    };
    /** Ends a check job and the items it queued, except items the user also submitted. */
    const skipCheck = (job: CollectionJob, reason: SkipReason) => {
      for (const child of pending) {
        if (child.parentId === job.id && !child.claimedByUser && !settled.has(child.id)) {
          settle(child, 'completed', { outcome: 'skipped', skipReason: reason }, null);
        }
      }
      if (job.items) {
        const items = job.items.map((item) => {
          const child = item.jobId ? store.get(item.jobId) : undefined;
          // An item the user also submitted continues as the user's own job.
          if (child?.claimedByUser && child.state === 'interrupted') {
            return { ...item, state: 'completed' as const, outcome: 'skipped' as const, skipReason: reason, error: null };
          }
          return this.storedItem(job, item);
        });
        this.updateStored(job, { items, progress: progressOf(items) });
      }
      settle(job, 'completed', { outcome: 'skipped', skipReason: reason }, null);
    };
    const tooManyStops = (job: CollectionJob) => (job.recovery?.uncleanStops ?? 0) >= MAX_UNCLEAN_STOPS;
    const repeated: JobError = { code: INTERRUPTED_REPEATEDLY, message: '工作多次在執行中被中斷，已停止自動接續。可重新提交。' };

    for (const job of superseded) {
      if (roleOf(job) === 'check') skipCheck(job, 'superseded');
      else if (!settled.has(job.id)) settle(job, 'completed', { outcome: 'skipped', skipReason: 'superseded' }, null);
    }
    const checkJobs: CollectionJob[] = [];
    // Subscription work first, so its items follow the subscription's state.
    for (const job of pending) {
      const role = roleOf(job);
      if (role === 'item' || settled.has(job.id)) continue;
      if (tooManyStops(job)) {
        settle(job, 'failed', { outcome: 'failed' }, repeated);
        continue;
      }
      if (role === 'check') {
        const reason = await this.subscriptions.stopped(job.source.type, job.source.id!);
        if (reason) {
          skipCheck(job, reason);
          continue;
        }
        checkJobs.push(job);
      }
      const subscribing = role === 'add' ? job.checkpoint?.subscribing : undefined;
      if (subscribing && await this.subscriptions.stopped(job.source.type, subscribing.subscriptionId) !== 'subscription_removed') {
        // The subscription was written before the stop; its first check is dispatched now, before the
        // scheduler can start a check of the same subscription, so that check joins it.
        const restored = this.restore(job, { queue: false });
        await this.subscribeResolved(restored, { id: subscribing.subscriptionId, title: subscribing.title, url: subscribing.url });
        continue;
      }
      this.restore(job);
    }
    for (const job of pending) {
      if (roleOf(job) !== 'item' || settled.has(job.id)) continue;
      if (tooManyStops(job)) settle(job, 'failed', { outcome: 'failed' }, repeated);
      else this.restore(job);
    }
    // Check jobs past discovery wait for their items again.
    for (const stored of checkJobs) {
      const job = this.jobs.get(stored.id);
      if (!job?.items) continue;
      const items = job.items.map((item) => {
        const child = item.jobId ? this.jobs.get(item.jobId) : undefined;
        if (!child) return this.storedItem(job, item);
        const watching = this.watchers.get(child.id) ?? new Set<string>();
        watching.add(job.id);
        this.watchers.set(child.id, watching);
        return { ...item, state: child.state, ...(child.retry ? { retry: child.retry } : {}) };
      });
      this.update(job, { items, progress: progressOf(items) });
      if (this.jobs.has(job.id)) this.completeCheckIfDone(job);
    }
    await store.flush();
  }

  /**
   * Makes an interrupted job active again and, unless told otherwise, returns it to the queue or to
   * waiting for its next attempt.
   */
  private restore(stored: CollectionJob, options: { queue: boolean } = { queue: true }): CollectionJob {
    const timestamp = this.now().toISOString();
    const waitsForItems = roleOf(stored) === 'check' && stored.items !== null;
    const job: CollectionJob = {
      ...stored,
      state: waitsForItems ? 'running' : 'queued',
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
    const waits = this.waits.stored(job);
    const group = this.groupOf(job);
    if (job.wait) {
      if (group && waits.cooldown) this.enterCooldown(group, waits.cooldown.until);
      else delete job.wait;
    }
    this.options.store.put(job);
    const stopReason = job.recovery?.lastStop ?? 'unknown';
    this.event(job, {
      severity: job.parentId ? 'debug' : 'info', eventType: 'job.resumed', stopReason,
      message: stopReason === 'shutdown' ? '服務正常關閉後重新啟動，接續收集工作。'
        : stopReason === 'crash' ? '服務異常結束後重新啟動，接續收集工作。'
          : stopReason === 'vault_move' ? '知識庫搬移完成，接續收集工作。'
            : stopReason === 'vault_switch' ? '回到這個知識庫，接續收集工作。' : '服務重新啟動後接續收集工作。',
    });
    if (waitsForItems || !options.queue) return job;
    this.markWaiting(job);
    if (waits.retry) this.waitFor(job, waits.retry);
    else this.requeue(job);
    return job;
  }

  /** An item of a check job whose item job is not running here, as that job's record says it ended. */
  private storedItem(check: CollectionJob, item: JobItem): JobItem {
    const child = item.jobId ? this.options.store.get(item.jobId) : undefined;
    if (child && child.state !== 'interrupted' && !ACTIVE.has(child.state)) return settledItem(item, child);
    if (!ACTIVE.has(item.state) && item.state !== 'interrupted') return item;
    const declaration = this.plugin(check.source.type)?.item;
    const subject = declaration ? `這${declaration.measure}${declaration.noun}` : '這個項目';
    return { ...item, state: 'failed', error: { code: 'interrupted', message: `找不到${subject}的收集紀錄。` } };
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
    this.discoveryQueue.length = 0;
    this.captureLanes.clear();
    this.laneOrder = [];
    await this.options.store.flush();
  }

  private enqueueItem(
    type: string, ref: Pick<ItemRef, 'key' | 'url'>, parentId: string | null, publishedNotBefore: string | null = null,
    extra: Pick<CollectionJob, 'retryOf'> = {}, title: string | null = null,
  ): JobSubmission {
    return this.enqueue(jobKind(type, 'item')!, type, `${type}:item:${ref.key}`, {
      id: ref.key, url: ref.url, title,
    }, parentId, { ...(publishedNotBefore ? { publishedNotBefore } : {}), ...extra });
  }

  private enqueueCheck(type: string, subscription: SubscriptionTarget, trigger: ChannelJobTrigger): JobSubmission {
    const kind = jobKind(type, 'check');
    if (!kind) throw new Error(`Source type ${type} has no check jobs`);
    return this.enqueue(kind, type, `${type}:check:${subscription.id}`, {
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
      if (active && parentId === null && roleOf(active) === 'item') {
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
    this.event(job, { severity: 'debug', eventType: 'job.accepted', message: '已接受收集工作。', ...(job.retryOf ? { retryOf: job.retryOf } : {}) });
    return { job: structuredClone(job), deduplicated: false };
  }

  /**
   * Puts a job back in line: items in their lane, subscription work in the discovery queue.
   * `front` returns a step that was stopped before it reached its source to the head of the line.
   */
  private requeue(job: CollectionJob, front = false): void {
    this.queueOrder.set(job.id, front ? --this.queueFront : ++this.queueBack);
    if (roleOf(job) !== 'item') {
      if (front) this.discoveryQueue.unshift(job.id);
      else this.discoveryQueue.push(job.id);
      return;
    }
    const lane = job.parentId ?? job.id;
    const queue = this.captureLanes.get(lane);
    if (queue) {
      if (front) queue.unshift(job.id);
      else queue.push(job.id);
    } else {
      this.captureLanes.set(lane, [job.id]);
      if (front) this.laneOrder.unshift(lane);
      else this.laneOrder.push(lane);
    }
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
      severity: 'debug', eventType: 'job.deferred',
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

  private queuedCount(): number {
    let count = this.discoveryQueue.length;
    for (const queue of this.captureLanes.values()) count += queue.length;
    return count;
  }

  /** Whether a queued step may start now; the ID of a job that ended meanwhile is dropped when its turn comes. */
  private ready(id: string): boolean {
    const job = this.jobs.get(id);
    return !job || this.waits.conditionOf(job) === null;
  }

  private pump(): void {
    if (this.closed || this.resuming) return;
    while (this.runningDiscovery < this.limits.discovery) {
      const index = this.discoveryQueue.findIndex((id) => this.ready(id));
      if (index < 0) break;
      const [id] = this.discoveryQueue.splice(index, 1);
      this.runningDiscovery += 1;
      this.track(this.runDiscovery(id!).finally(() => { this.runningDiscovery -= 1; this.pump(); }));
    }
    while (this.runningCapture < this.limits.capture) {
      const id = this.nextCapture();
      if (!id) break;
      this.runningCapture += 1;
      this.track(this.runItem(id).finally(() => { this.runningCapture -= 1; this.pump(); }));
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

  /** The head of the first lane, in rotation order, whose head job may start. */
  private nextCapture(): string | undefined {
    for (let position = 0; position < this.laneOrder.length; position += 1) {
      const lane = this.laneOrder[position]!;
      const queue = this.captureLanes.get(lane)!;
      // Every job of a lane is of one source type, so the head waits for whatever holds the rest.
      if (!this.ready(queue[0]!)) continue;
      this.laneOrder.splice(position, 1);
      const id = queue.shift();
      if (queue.length > 0) this.laneOrder.push(lane);
      else this.captureLanes.delete(lane);
      return id;
    }
    return undefined;
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
      if (!document && await documents.isDeletedFor(key, { explicitAt: explicitRequestTime(job) })) {
        // A deleted item is skipped before capture, so the source is not asked for content the save would refuse.
        this.finish(job, 'completed', { outcome: 'skipped', skipReason: 'deleted' }, null);
        return;
      }
      if (!document) {
        const subscription = this.subscriptionTargetOf(job);
        const captured = await plugin.captureItem(ref, {
          ...(job.publishedNotBefore ? { publishedNotBefore: job.publishedNotBefore } : {}),
          ...(subscription ? { subscription } : {}),
          signal,
        });
        this.update(job, { phase: 'save', source: { ...job.source, title: captured.title, publisher: captured.publisher.name } });
        // The save phase is on disk before the document is, so a restart knows who saved it.
        await this.options.store.flush();
        const saved = await documents.save({ sourceType: plugin.id, ...captured }, { explicitAt: explicitRequestTime(job) });
        document = saved.document;
        outcome = 'created';
        this.update(job, { checkpoint: { ...job.checkpoint, savedDocumentId: document.id } });
        this.event(job, {
          severity: 'info', eventType: 'document.saved', message: '文件已保存。', phase: 'save', documentId: document.id,
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
          severity: 'warning', eventType: 'document.index_failed', message: '文件已保存，搜尋更新失敗。',
          phase: 'index', documentId: document.id,
        });
      }
      await this.reportCollected(job);
      if (this.jobs.get(job.id) !== job) return;
      this.finish(job, 'completed', {
        outcome, documentId: document.id, saved: true, indexed: index.indexed,
        ...(index.message ? { indexMessage: index.message } : {}),
      }, null);
    } catch (error) {
      if (error instanceof CollectorError && (error.code === 'out_of_range' || error.code === 'document_deleted')) {
        if (error.code === 'out_of_range') await this.reportOutOfRange(job);
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
      if (roleOf(job) === 'add') await this.addSubscription(job, signal);
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
      await this.reportFailure(job, error, failureClass);
      if (this.jobs.get(job.id) !== job) return;
      this.finish(job, 'failed', { outcome: 'failed' }, error, detail);
      return;
    }
    const maxAttempts = this.retryPolicy.maxAttempts;
    if (attempts >= maxAttempts) {
      this.update(job, { retry: { attempts, maxAttempts, nextAttemptAt: null, lastError: error } });
      this.notifyItemRetry(job);
      // Transient failures that outlast the attempts of one check leave the item to the next check.
      await this.reportFailure(job, error, 'retry_next_check');
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
      severity: 'warning', eventType: 'job.retry_scheduled',
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
    const plan = await this.subscriptions.planCheck(type, id, this.now());
    if ('stopped' in plan) {
      this.finish(job, 'completed', { outcome: 'skipped', skipReason: plan.stopped }, null);
      return;
    }
    const target = { ...plan.target, title: job.source.title ?? plan.target.title, url: job.source.url };
    const discovery = retryItems
      ? {
        candidates: null,
        items: retryItems.map((item) => ({ key: item.sourceId, title: item.title, url: item.url })),
        publishedNotBefore: null,
      }
      : await selectCandidates(
        plugin.listSubscriptionItems!(target, { signal }), plan.range,
        // Collected, deleted, out-of-range and skipped items stay candidates that are not collected, so they still fill the item limit.
        async (key) => plan.excluded.has(key) || this.options.documents.isKnown({ sourceType: type, sourceId: key }),
      );
    // The service stopped while discovering; close() records the job as interrupted.
    if (this.closed) return;
    const reason = this.stoppedJobs.get(job.id) ?? await this.subscriptions.stopped(type, id);
    if (reason) {
      this.finish(job, 'completed', { outcome: 'skipped', skipReason: reason }, null);
      return;
    }
    this.event(job, {
      severity: 'debug', eventType: 'channel.discovered', message: `發現 ${discovery.items.length} ${plugin.item.measure}${plugin.item.noun}。`, phase: 'discover',
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

  /** The check job's subscription an item job collects for, with the item's key; null for any other job. */
  private checkItemOf(item: CollectionJob): { type: string; subscriptionId: string; key: string } | null {
    if (roleOf(item) !== 'item' || !item.parentId || !item.source.id) return null;
    const parent = this.jobs.get(item.parentId) ?? this.options.store.get(item.parentId);
    if (!parent || roleOf(parent) !== 'check' || !parent.source.id) return null;
    return { type: item.source.type, subscriptionId: parent.source.id, key: item.source.id };
  }

  /** The target of the subscription whose check found an item; undefined for an item submitted on its own. */
  private subscriptionTargetOf(item: CollectionJob): SubscriptionTarget | undefined {
    const parent = item.parentId ? this.jobs.get(item.parentId) ?? this.options.store.get(item.parentId) : undefined;
    if (!parent || roleOf(parent) !== 'check' || !parent.source.id) return undefined;
    return { id: parent.source.id, title: parent.source.title ?? '', url: parent.source.url };
  }

  /** Reports a check item's range start that its publish time came before. */
  private async reportOutOfRange(item: CollectionJob): Promise<void> {
    const target = this.checkItemOf(item);
    if (!target || !item.publishedNotBefore) return;
    await this.subscriptions.itemOutOfRange(target.type, target.subscriptionId, target.key, item.publishedNotBefore);
  }

  /** Reports a collected check item. */
  private async reportCollected(item: CollectionJob): Promise<void> {
    const target = this.checkItemOf(item);
    if (!target) return;
    await this.quietly(() => this.subscriptions.itemCollected(target.type, target.subscriptionId, target.key));
  }

  /**
   * Reports a check item that failed for good within this job, with its source's failure class, and
   * records the failure count the subscription keeps across checks. A limit or a source that needs a
   * new sign-in is no failure of the item.
   */
  private async reportFailure(item: CollectionJob, error: JobError, failureClass: FailureClass): Promise<void> {
    if (failureClass === 'login_required' || failureClass === 'rate_limited') return;
    const target = this.checkItemOf(item);
    if (!target) return;
    let entry: ItemFailureEntry | null = null;
    // A failure record that cannot be written leaves the item to be tried as if it had not failed.
    await this.quietly(async () => {
      entry = await this.subscriptions.itemFailed(target.type, target.subscriptionId, {
        key: target.key, title: item.source.title, url: item.source.url,
      }, error, failureClass);
    });
    const recorded = entry as ItemFailureEntry | null;
    if (!recorded) return;
    const label = this.plugin(item.source.type)?.failureLabels?.[error.code] ?? '收集失敗';
    const name = item.source.title ? `「${item.source.title}」` : item.source.url;
    this.event(item, recorded.skipped
      ? {
        severity: 'warning', eventType: 'subscription.item_skipped', outcome: 'skipped', errorCode: error.code, attempt: recorded.attempts,
        message: `${name}已略過・${failureClass === 'skip' ? label : `已試 ${recorded.attempts} 次`}`,
      }
      : {
        severity: 'warning', eventType: 'subscription.item_failed', errorCode: error.code, attempt: recorded.attempts,
        message: `${name}${label}・已試 ${recorded.attempts}/${MAX_CHECK_ATTEMPTS} 次`,
      });
  }

  private async quietly(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      console.error('Subscription failure record update failed', error);
    }
  }

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
    const role = roleOf(job);
    const majorStart = firstStart && role !== 'add' && !(role === 'item' && job.parentId !== null);
    this.event(job, { severity: majorStart ? 'info' : 'debug', eventType: 'job.started', message: '開始執行收集工作。', phase });
  }

  private finish(job: CollectionJob, state: 'completed' | 'failed', result: JobResult, error: JobError | null, detail?: string): void {
    const finishedAt = this.now().toISOString();
    const end = this.checkEnd({ ...job, state, result, error, finishedAt });
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
    const check = roleOf(job) === 'check' && job.scope ? {
      trigger: job.scope.trigger,
      result: (state === 'failed' && error?.code === 'network_error' ? 'network_error'
        : state === 'completed' && result.outcome !== 'skipped'
          && progress.created === 0 && progress.failed === 0 && (progress.skipped ?? 0) === 0
          ? 'empty' : 'other') as 'empty' | 'network_error' | 'other',
      created: progress.created, existing: progress.existing, failed: progress.failed, skipped: progress.skipped ?? 0,
    } : undefined;
    const role = roleOf(job);
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
      }
      : {
        severity: 'error', eventType: 'job.failed', message: error?.message ?? '收集工作失敗。', outcome: result.outcome,
        ...(check ? { check } : {}),
        ...(error ? { errorCode: error.code } : {}), ...(detail ? { detail } : {}),
      });
    this.release(job);
    const settled = this.options.store.get(job.id)!;
    this.onItemSettled(settled);
    this.notifySettled(settled);
  }

  /**
   * How a finished check ended for its subscription; null for a check a pause, a removal or a later
   * job skipped before it collected anything, and for a retry of earlier items, which lists nothing.
   */
  private checkEnd(job: CollectionJob): CheckEnd | null {
    if (roleOf(job) !== 'check' || !job.source.id || !job.finishedAt || job.checkpoint?.retryItems) return null;
    if (job.state !== 'completed' && job.state !== 'failed') return null;
    if (job.result?.skipReason && STOP_REASONS.has(job.result.skipReason)) return null;
    const error = job.state === 'failed' ? job.error ?? null : null;
    const counted = !this.stoppedJobs.has(job.id)
      && (job.state === 'completed'
        || (error !== null && error.code !== INTERRUPTED_REPEATEDLY && this.classify(job, error) !== 'login_required'));
    return { at: job.finishedAt, error, counted };
  }

  private release(job: CollectionJob): void {
    this.waits.endRetry(job.id);
    this.jobs.delete(job.id);
    this.stoppedJobs.delete(job.id);
    this.manualClaims.delete(job.id);
    this.queueOrder.delete(job.id);
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

  /**
   * Records an event of `job` with what the activity view shows and filters by: source type, title,
   * subscription, parent and trigger.
   */
  private event(job: CollectionJob, entry: Omit<NewJobEvent, 'vaultPath' | 'jobId'>): void {
    const subscriptionId = this.subscriptionOf(job);
    const role = roleOf(job);
    this.options.store.event({
      ...entry, vaultPath: job.vaultPath, ...(job.vaultId ? { vaultId: job.vaultId } : {}), jobId: job.id,
      ...(role ? { jobRole: role } : {}),
      sourceType: job.source.type,
      ...(job.source.id ? { sourceId: job.source.id } : {}),
      ...(job.source.title ? { sourceTitle: job.source.title } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      ...(job.parentId ? { parentJobId: job.parentId } : {}),
      ...(job.scope ? { trigger: job.scope.trigger } : {}),
    });
  }

  /** The subscription a job collects for: its own, its parent check job's, or the one a subscription request added. */
  private subscriptionOf(job: CollectionJob): string | null {
    const role = roleOf(job);
    if (role === 'check') return job.source.id;
    if (role === 'add') return job.result?.subscriptionId ?? job.checkpoint?.subscribing?.subscriptionId ?? null;
    if (!job.parentId) return null;
    const parent = this.jobs.get(job.parentId) ?? this.options.store.get(job.parentId);
    return parent && roleOf(parent) === 'check' ? parent.source.id : null;
  }

  /** How the job's source type treats a failure; an unregistered type's failures are not retried. */
  private classify(job: CollectionJob, error: { code: string }): FailureClass {
    return this.plugin(job.source.type)?.classifyFailure(error) ?? 'skip';
  }

  /** What a finished job's activity entry says; skip reasons and counts make the log readable on its own. */
  private completionMessage(job: CollectionJob, result: JobResult): string {
    if (result.outcome === 'skipped') return `略過：${SKIP_MESSAGES[result.skipReason ?? 'out_of_range']}。`;
    const role = roleOf(job);
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

/** A check job's item once the item job that collects it has finished. */
function settledItem(item: JobItem, child: CollectionJob): JobItem {
  const { wait: _wait, ...rest } = item;
  return {
    ...rest,
    state: child.state,
    outcome: child.result?.outcome === 'created' || child.result?.outcome === 'existing' || child.result?.outcome === 'skipped'
      ? child.result.outcome : null,
    ...(child.result?.skipReason ? { skipReason: child.result.skipReason } : {}),
    error: child.error,
    ...(child.retry ? { retry: child.retry } : {}),
  };
}

/** The job as UI and Agents read it; the checkpoint and the user-claim flag only serve restarts. */
function publicJob(job: CollectionJob): CollectionJob {
  const copy = { ...job };
  delete copy.checkpoint;
  delete copy.claimedByUser;
  return copy;
}

/**
 * The item an item job collects. Its key is the one recorded when the job was queued, so an item
 * whose key its address does not determine keeps the key its listing gave it.
 */
function itemRefOf(job: CollectionJob, plugin: SourcePlugin): ItemRef {
  if (job.source.id) return { key: job.source.id, url: job.source.url, title: job.source.title };
  return plugin.parseItem(job.source.url);
}

/** The role of a job's kind; undefined for a kind of an unregistered type. */
function roleOf(job: CollectionJob): JobRole | undefined {
  return jobRole(job.kind)?.role;
}

function isRole(job: CollectionJob, type: string, role: JobRole): boolean {
  return job.source.type === type && roleOf(job) === role;
}

/**
 * The dedupe key an accepted job holds while it is unfinished: `<type>:item:<key>`,
 * `<type>:check:<subscription ID>` or `<type>:add:<address>`. The keys live in memory only.
 */
function jobKey(job: CollectionJob): string {
  const type = job.source.type;
  const role = roleOf(job);
  if (role === 'item') return `${type}:item:${job.source.id}`;
  if (role === 'check') return `${type}:check:${job.source.id}`;
  if (role === 'add') return `${type}:add:${job.source.url.toLowerCase()}`;
  return `${job.kind}:${job.source.id ?? job.source.url}`;
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

const SKIP_MESSAGES: Record<SkipReason, string> = {
  out_of_range: '超出收集範圍', subscription_paused: '訂閱已暫停', subscription_removed: '訂閱已移除',
  superseded: '已由較新的工作接續', deleted: '文件已刪除',
};

/**
 * The latest time the user asked for this item by itself: a direct submission or a retry of one,
 * including a later direct submission merged into the same job, or an item a check job queued
 * when the user also submitted it. Null for subscription work.
 */
function explicitRequestTime(job: CollectionJob): string | null {
  if (roleOf(job) !== 'item') return null;
  if (job.parentId === null) return job.checkpoint?.claimedAt ?? job.createdAt;
  return job.claimedByUser ? job.checkpoint?.claimedAt ?? null : null;
}

/** External tool output carried by the error, for the activity log's diagnostic detail. */
function diagnosticDetail(error: unknown): string | undefined {
  return error instanceof CollectorError && error.detail ? error.detail : undefined;
}

function errorDetails(error: unknown): JobError {
  // Job errors reach the UI, Agents and diagnostics, so credentials in a source's message are masked here too.
  if (error instanceof CollectorError) return { code: error.code, message: limitText(redact(error.message), 500, 'head') };
  return { code: 'capture_failed', message: '收集失敗，請稍後再試。' };
}

