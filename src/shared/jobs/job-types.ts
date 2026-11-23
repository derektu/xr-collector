import type { DocumentSourceType } from '../documents/document-types.js';
import type { SubscriptionSettings, WorkStatus } from '../subscriptions/subscription-types.js';

export type ChannelJobTrigger = 'subscribe' | 'resume' | 'scheduled' | 'manual';

export interface ChannelJobScope {
  trigger: ChannelJobTrigger;
}

export type JobKind = string;

export type JobRole = 'item' | 'check' | 'add';

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';

export type JobPhase = 'resolve' | 'discover' | 'capture' | 'save' | 'index';

/** `empty`: a check whose discovery found nothing to collect. */
export type JobOutcome = 'created' | 'existing' | 'partial' | 'failed' | 'empty' | 'skipped';

export type SkipReason = 'out_of_range' | 'subscription_paused' | 'subscription_removed' | 'superseded' | 'deleted';

export interface JobError {
  code: string;
  message: string;
}

export interface JobRetry {
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: JobError;
}

export interface JobWait {
  reason: 'rate_limited';
  until: string;
}

export interface JobRecovery {
  resumedCount: number;
  uncleanStops: number;
  lastInterruptedAt: string;
  lastResumedAt: string | null;
  lastStop: JobStopKind;
}

export type JobStopKind = 'shutdown' | 'crash' | 'vault_switch';

export interface JobCheckpoint {
  savedDocumentId?: string;
  claimedAt?: string;
  settings?: SubscriptionSettings;
  target?: { id: string; title: string; url: string };
  subscribing?: { subscriptionId: string; title: string; url: string };
  retryItems?: Array<{ sourceId: string; title: string; url: string }>;
}

export interface JobItem {
  sourceId: string;
  title: string;
  url: string;
  jobId: string | null;
  state: JobState;
  outcome: 'created' | 'existing' | 'skipped' | null;
  skipReason?: SkipReason;
  error: JobError | null;
  retry?: JobRetry;
  wait?: JobWait;
}

export interface JobProgress {
  total: number;
  done: number;
  created: number;
  existing: number;
  failed: number;
  skipped: number;
}

export interface JobResult {
  outcome: JobOutcome;
  skipReason?: SkipReason;
  documentId?: string;
  saved?: boolean;
  indexed?: boolean;
  indexMessage?: string;
  subscriptionId?: string;
  followUpJobId?: string;
}

export interface CollectionJob {
  id: string;
  kind: JobKind;
  state: JobState;
  phase: JobPhase | null;
  vaultPath: string;
  vaultId: string;
  parentId: string | null;
  source: {
    type: DocumentSourceType;
    /** Item key or subscription ID; null until a subscription address has been resolved. */
    id: string | null;
    url: string;
    title: string | null;
    /** Absent until a capture reports who published the item. */
    publisher?: string;
  };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  progress: JobProgress | null;
  scope?: ChannelJobScope;
  publishedNotBefore?: string;
  items: JobItem[] | null;
  result: JobResult | null;
  error: JobError | null;
  retry?: JobRetry;
  wait?: JobWait;
  recovery?: JobRecovery;
  checkpoint?: JobCheckpoint;
  claimedByUser?: boolean;
  retryOf?: string;
  dismissedAt?: string;
  retriedBy?: string;
  activityIncomplete?: boolean;
}

export type JobView = Omit<CollectionJob, 'checkpoint' | 'claimedByUser'>;

export interface JobSubmission {
  job: JobView;
  deduplicated: boolean;
}

export interface JobPage {
  jobs: JobView[];
  nextCursor: string | null;
}

export interface JobOverviewEntry {
  jobId: string;
  type: DocumentSourceType;
  role: JobRole;
  title: string | null;
  url: string;
  /** Null for subscription work, and for an item until its publisher is known. */
  publisher: string | null;
  /** Null for work other than a check, and before the check knows its items. */
  progress: { done: number; total: number } | null;
  status: WorkStatus | null;
  error: JobError | null;
  failedAt: string | null;
}

export interface JobOverview {
  running: JobOverviewEntry[];
  queued: JobOverviewEntry[];
  failed: JobOverviewEntry[];
}

export interface JobSummary {
  active: number;
  completed: number;
  failed: number;
  since: string;
}

/**
 * `cooldown`: the source limited requests and none is sent before `cooldownUntil`; `busy`: a
 * request runs; `waiting`: requests wait for their turn; `idle`: nothing is pending.
 */
export interface PacingStatus {
  state: 'idle' | 'busy' | 'waiting' | 'cooldown';
  cooldownUntil: string | null;
  level: number;
  waitRangeMs: { min: number; max: number };
}
