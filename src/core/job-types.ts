import type { DocumentSourceType } from './document-types.js';
import type { SubscriptionSettings, WorkStatus } from './subscription-types.js';

/** Why a check job was started; it decides the job's labels. Every trigger discovers items the same way. */
export type ChannelJobTrigger = 'subscribe' | 'resume' | 'scheduled' | 'manual';

/**
 * What a check job records about why it runs. The range it collects is not part of it: discovery
 * reads the subscription's settings when it starts and measures the range back from that moment.
 */
export interface ChannelJobScope {
  trigger: ChannelJobTrigger;
}

/**
 * `<source type>.<name>`, with the name the source type declares for its item, check or add jobs.
 */
export type JobKind = string;

/** What a job does, whatever its source type: collect one item, check a subscription, or subscribe to an address. */
export type JobRole = 'item' | 'check' | 'add';

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';

export type JobPhase = 'resolve' | 'discover' | 'capture' | 'save' | 'index';

/** What a finished job produced; `empty` is a check whose discovery found nothing to collect. */
export type JobOutcome = 'created' | 'existing' | 'partial' | 'failed' | 'empty' | 'skipped';

/**
 * Why work was skipped instead of collected. `superseded` is an interrupted job that a later job
 * of the same item or subscription took over; `deleted` is an item the user deleted, which only an
 * explicit single-item collection started after the deletion collects again.
 */
export type SkipReason = 'out_of_range' | 'subscription_paused' | 'subscription_removed' | 'superseded' | 'deleted';

export interface JobError {
  code: string;
  message: string;
}

/**
 * Automatic retries after transient failures such as a lost connection. `attempts` counts failed
 * attempts and survives restarts, so a restart never grants a job more attempts.
 */
export interface JobRetry {
  attempts: number;
  maxAttempts: number;
  /** When the next attempt starts; null while an attempt runs or after the last one. */
  nextAttemptAt: string | null;
  lastError: JobError;
}

/**
 * Why a queued job waits without spending an attempt. `rate_limited`: the source limited requests
 * and every step of its pacing group waits until `until`, when the job continues by itself.
 */
export interface JobWait {
  reason: 'rate_limited';
  until: string;
}

/** How a job continued across service restarts. */
export interface JobRecovery {
  resumedCount: number;
  /**
   * Restarts that found the job in the middle of a step, which a clean shutdown never leaves.
   * A job that keeps stopping the service this way stops resuming automatically.
   */
  uncleanStops: number;
  lastInterruptedAt: string;
  lastResumedAt: string | null;
  /** How the service stopped last time: closed normally or ended abnormally. Absent for jobs stopped before this was recorded. */
  lastStop?: JobStopKind;
}

/** How a job stopped: the service closed normally, ended abnormally, or switched to another Vault. */
export type JobStopKind = 'shutdown' | 'crash' | 'vault_switch';

/** What a restart needs to continue a job without repeating finished steps. Internal to the service. */
export interface JobCheckpoint {
  /** An item job saved this document; a resume only updates the index. */
  savedDocumentId?: string;
  /**
   * The latest time the user submitted this item directly while this job was already queued: a
   * repeated direct submission of an item job, or a direct submission of an item a check job
   * queued. That request is explicit, so it may collect the item again after a deletion made
   * before it.
   */
  claimedAt?: string;
  /** An add job: the settings the new subscription starts with, chosen when the job was accepted. */
  settings?: SubscriptionSettings;
  /** An add job: the target a preview resolved for its address before the job was accepted; the job subscribes to it without resolving. */
  target?: { id: string; title: string; url: string };
  /** An add job resolved this target and is subscribing to it; `subscriptionId` is the target's ID. */
  subscribing?: { subscriptionId: string; title: string; url: string };
  /**
   * A check job retrying the failed items of an earlier one collects exactly these items: it
   * runs no discovery, leaves the subscription's last check time alone and applies no range bound.
   */
  retryItems?: Array<{ sourceId: string; title: string; url: string }>;
}

/** One discovered item of a check job and the item job that collects it. */
export interface JobItem {
  sourceId: string;
  title: string;
  url: string;
  jobId: string | null;
  state: JobState;
  outcome: 'created' | 'existing' | 'skipped' | null;
  skipReason?: SkipReason;
  error: JobError | null;
  /** Retry state of the item job that collects this item. */
  retry?: JobRetry;
  /** Cooldown wait of the item job that collects this item. */
  wait?: JobWait;
}

export interface JobProgress {
  total: number;
  done: number;
  created: number;
  existing: number;
  failed: number;
  /** Items left uncollected on purpose; absent in jobs recorded before skipping existed. */
  skipped?: number;
}

export interface JobResult {
  outcome: JobOutcome;
  skipReason?: SkipReason;
  documentId?: string;
  /** The document is stored in the Vault. */
  saved?: boolean;
  /** The search projection includes the saved document. */
  indexed?: boolean;
  indexMessage?: string;
  /** The subscription an add job subscribed to or found. */
  subscriptionId?: string;
  /** The check job an add job started. */
  followUpJobId?: string;
}

/** A durable unit of collection work bound to the Vault it was submitted for. */
export interface CollectionJob {
  id: string;
  kind: JobKind;
  state: JobState;
  phase: JobPhase | null;
  vaultPath: string;
  /**
   * ID of the Vault the job belongs to. A job counts as the Vault's only when both its path and ID
   * match, so another Vault later placed at the same path, or a copy of the Vault elsewhere, never
   * continues it. Absent for a job of a Vault without an ID.
   */
  vaultId?: string;
  parentId: string | null;
  source: {
    /** The source type, whose plugin runs the job. */
    type: DocumentSourceType;
    /** Item key or subscription ID; null until a subscription address has been resolved. */
    id: string | null;
    url: string;
    title: string | null;
    /** Who published an item, once a capture reported it. */
    publisher?: string;
  };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  progress: JobProgress | null;
  /** Why a check job runs. */
  scope?: ChannelJobScope;
  /** For an item a check job found: the start of that check's range; an item published earlier is skipped. */
  publishedNotBefore?: string;
  items: JobItem[] | null;
  result: JobResult | null;
  error: JobError | null;
  retry?: JobRetry;
  /** Set while the job is queued behind its pacing group's cooldown. */
  wait?: JobWait;
  recovery?: JobRecovery;
  checkpoint?: JobCheckpoint;
  /** An item a check job queued that the user also submitted directly; stopping the subscription never skips it. */
  claimedByUser?: boolean;
  /** The failed job this one retries at the user's request. */
  retryOf?: string;
  /** When the user removed this failed single item from the jobs page's failed section. */
  dismissedAt?: string;
  /** The job that retries this failed one; a job is retried once. */
  retriedBy?: string;
  /** Some of this job's activity events could not be written to the device log. */
  activityIncomplete?: boolean;
}

/** A job as the job manager, the UI and Agents read it, without the data that only serves restarts. */
export type JobView = Omit<CollectionJob, 'checkpoint' | 'claimedByUser'>;

export interface JobSubmission {
  job: JobView;
  /** True when an active job for the same item already existed and was returned instead. */
  deduplicated: boolean;
}

export interface JobPage {
  jobs: JobView[];
  nextCursor: string | null;
}

/**
 * One unfinished or failed piece of work on the jobs page. `role` tells an item from a check of a
 * subscription or a subscription request; `title` is null until the item or target is known, and
 * the page shows `url` instead.
 */
export interface JobOverviewEntry {
  jobId: string;
  type: DocumentSourceType;
  role: JobRole;
  title: string | null;
  url: string;
  /** Who published an item, once known; null for subscription work. */
  publisher: string | null;
  /** A check's items so far; null for other work and before the check knows its items. */
  progress: { done: number; total: number } | null;
  /** What unfinished work is doing; null for a failed entry. */
  status: WorkStatus | null;
  /** Why a failed entry failed. */
  error: JobError | null;
  failedAt: string | null;
}

/**
 * Everything the app is doing now, from the UI or an Agent. `running`: work that started and has
 * not finished, including work waiting for a retry or a cooldown. `queued`: work that has not
 * started, in the order it starts. `failed`: single items and subscription requests that
 * failed, until a retry succeeds, the user removes them, the item has a document or 7 days pass.
 */
export interface JobOverview {
  running: JobOverviewEntry[];
  queued: JobOverviewEntry[];
  failed: JobOverviewEntry[];
}

/** Top-level job counts of the active Vault. */
export interface JobSummary {
  active: number;
  /** Completed since `since`. */
  completed: number;
  /** Failed since `since` and not retried. */
  failed: number;
  since: string;
}

/**
 * The request channel of one pacing group on this device. `cooldown`: the source limited requests
 * and none is sent before `cooldownUntil`; `busy`: a request runs; `waiting`: requests wait for their
 * turn; `idle`: nothing is pending. `level` counts consecutive limits; `waitRangeMs` is the random
 * gap between two requests.
 */
export interface PacingStatus {
  state: 'idle' | 'busy' | 'waiting' | 'cooldown';
  cooldownUntil: string | null;
  level: number;
  waitRangeMs: { min: number; max: number };
}
