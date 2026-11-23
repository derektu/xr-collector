import type { PauseReason } from '../jobs/collection-pause.js';
import type { DocumentSourceType } from '../documents/document-types.js';
import type { EventType } from './event-catalog.js';
import type { ChannelJobTrigger, JobOutcome, JobPhase, JobRole, JobStopKind, SkipReason } from '../jobs/job-types.js';

export type EventSeverity = 'debug' | 'info' | 'warning' | 'error';

export interface JobEvent {
  eventId: string;
  timestamp: string;
  severity: EventSeverity;
  eventType: EventType;
  message: string;
  /** Null for events that belong to no Vault. */
  vaultPath: string | null;
  /** ID of the Vault the event belongs to; an event without it belongs by `vaultPath`. */
  vaultId?: string;
  jobId: string | null;
  phase?: JobPhase;
  outcome?: JobOutcome;
  skipReason?: SkipReason;
  errorCode?: string;
  /**
   * Masked diagnostic output, such as the end of an external tool's stderr, or the value an event
   * sets, such as the new status of `document.status_changed`.
   */
  detail?: string;
  /** The failed attempt a retry event follows. */
  attempt?: number;
  nextAttemptAt?: string;
  /** `<pacing group>.rate_limited` and `job.deferred`: when the group's requests continue. */
  until?: string;
  /** `<pacing group>.rate_limited`: consecutive limits so far. */
  level?: number;
  /** `job.resumed`: how the job stopped. */
  stopReason?: JobStopKind;
  documentId?: string;
  sourceType?: DocumentSourceType;
  /** Item key or subscription ID the event concerns. */
  sourceId?: string;
  sourceTitle?: string;
  /** `message` already names the source that `sourceTitle` holds. */
  namesSource?: true;
  /** `job.completed` of an item: false when the document was stored but the search index was not updated. */
  indexed?: false;
  jobRole?: JobRole;
  subscriptionId?: string;
  parentJobId?: string;
  trigger?: ChannelJobTrigger;
  retryOf?: string;
  /** `collection.paused` and `collection.resumed`: the reason that came into force or lifted. */
  pauseReason?: PauseReason;
  /** Set on `job.completed` and `job.failed` of a subscription check. */
  check?: {
    trigger: ChannelJobTrigger;
    result: 'empty' | 'network_error' | 'other';
    created: number;
    existing: number;
    failed: number;
    skipped: number;
  };
}

/**
 * An event as its emitter gives it. The activity log assigns `eventId` and `timestamp`; a missing
 * `severity` is the catalog's default for the kind.
 */
export type NewJobEvent = Omit<JobEvent, 'eventId' | 'timestamp' | 'severity'> & { severity?: EventSeverity };

export interface EventRecorder {
  event(entry: NewJobEvent): void;
}

/** Filters of an activity query; every filter given must match. */
export interface ActivityQuery {
  /** Undefined means `raw`. */
  view?: 'raw' | 'summary';
  severity?: EventSeverity[];
  eventType?: string[];
  /** A job's own events, the events of the items it queued and of the job that retries it. */
  jobId?: string;
  subscriptionId?: string;
  sourceType?: DocumentSourceType;
  /** Inclusive lower bound, ISO time. */
  since?: string;
  /** Exclusive upper bound, ISO time. */
  until?: string;
  limit?: number;
  cursor?: string;
}

export interface ActivityCheckSummary {
  kind: 'check';
  groupId: string;
  /** The newest check the row folds in. */
  jobId: string;
  sourceType: DocumentSourceType;
  subscriptionId: string;
  sourceTitle: string | null;
  trigger: ChannelJobTrigger;
  result: 'empty' | 'network_error' | 'other';
  created: number;
  existing: number;
  failed: number;
  skipped: number;
  count: number;
  firstFinishedAt: string;
  lastFinishedAt: string;
  severity: EventSeverity;
  errorCode?: string;
  message: string;
}

export type ActivitySummaryEntry = { kind: 'event'; event: JobEvent } | ActivityCheckSummary;

export interface ActivitySummaryPage {
  view: 'summary';
  entries: ActivitySummaryEntry[];
  nextCursor: string | null;
  retentionDays: number;
  log: ActivityLogHealth;
}

export interface ActivityCheckDetail {
  jobId: string;
  finishedAt: string;
  result: ActivityCheckSummary['result'];
  created: number;
  existing: number;
  failed: number;
  skipped: number;
  errorCode?: string;
  message: string;
  events: JobEvent[];
}

export interface ActivityGroupPage {
  group: ActivityCheckSummary;
  checks: ActivityCheckDetail[];
  nextCursor: string | null;
  retentionDays: number;
}

export interface ActivityLogHealth {
  state: 'ok' | 'failing';
  /** Events waiting to be written after a failed write. */
  pending: number;
  /** Events lost because too many waited. */
  dropped: number;
  lastFailureAt: string | null;
  lastError: string | null;
  /** Unreadable lines found in the log files. */
  skippedLines: number;
}

export interface ActivityPage {
  view: 'raw';
  /** Newest first. */
  events: JobEvent[];
  nextCursor: string | null;
  retentionDays: number;
  log: ActivityLogHealth;
}

/** The device activity log, scoped to the active Vault; readable whatever state the Vault is in. */
export interface ActivityAccess {
  query(query: ActivityQuery): Promise<ActivityPage>;
  summary?(query: ActivityQuery): Promise<ActivitySummaryPage>;
  group?(groupId: string, limit?: number, cursor?: string, severity?: EventSeverity[]): Promise<ActivityGroupPage>;
  health(): ActivityLogHealth;
}
