import type { PauseReason } from './collection-pause.js';
import type { DocumentSourceType } from './document-types.js';
import type { EventType } from './event-catalog.js';
import type { ChannelJobTrigger, JobOutcome, JobPhase, JobRole, JobStopKind, SkipReason } from './job-types.js';

export type EventSeverity = 'debug' | 'info' | 'warning' | 'error';

/**
 * One entry of the device activity log. Severity says how serious the entry is; outcome says what a
 * finished job produced. Optional fields
 * appear when the entry concerns them.
 */
export interface JobEvent {
  eventId: string;
  timestamp: string;
  severity: EventSeverity;
  /** The kind of event; `core/event-catalog.ts` lists every kind and how the activity log shows it. */
  eventType: EventType;
  message: string;
  /** Null for events that belong to no Vault. */
  vaultPath: string | null;
  /** ID of the Vault the event belongs to; absent for events of a Vault without an ID. */
  vaultId?: string;
  jobId: string | null;
  phase?: JobPhase;
  outcome?: JobOutcome;
  skipReason?: SkipReason;
  errorCode?: string;
  /** Masked diagnostic output, such as the end of an external tool's stderr. */
  detail?: string;
  /** The failed attempt a retry event follows. */
  attempt?: number;
  /** When a retried job starts its next attempt. */
  nextAttemptAt?: string;
  /** `<pacing group>.rate_limited` and `job.deferred`: when the group's requests continue. */
  until?: string;
  /** `<pacing group>.rate_limited`: consecutive limits so far; the cooldown doubles with each one. */
  level?: number;
  /** Why a resumed job stopped: a normal shutdown, an abnormal end, or `unknown` for a stop recorded without it. */
  stopReason?: JobStopKind | 'unknown';
  documentId?: string;
  /** The source type of the job or subscription the event concerns. */
  sourceType?: DocumentSourceType;
  /** Item key or subscription ID the event concerns. */
  sourceId?: string;
  /** Display title of the item or subscription target. */
  sourceTitle?: string;
  /** The message names the event's source itself, so a line showing it does not lead with `sourceTitle`. */
  namesSource?: true;
  /** `job.completed` of an item: false when the document was stored but the search index was not updated. */
  indexed?: false;
  /** Durable role of a job event, so summary projection does not depend on retained job records. */
  jobRole?: JobRole;
  /** The subscription the event belongs to, for check jobs and the items they queued. */
  subscriptionId?: string;
  /** The check job that queued this item job. */
  parentJobId?: string;
  trigger?: ChannelJobTrigger;
  /** The failed job a manual retry follows. */
  retryOf?: string;
  /** `collection.paused` and `collection.resumed`: the reason that came into force or lifted. */
  pauseReason?: PauseReason;
  /** Durable terminal metadata for a subscription check; unlike jobs.json, events live for 30 days. */
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

/** Where emitters send events: the device activity log. */
export interface EventRecorder {
  event(entry: NewJobEvent): void;
}

/** Filters of an activity query; every filter given must match. */
export interface ActivityQuery {
  /** Raw events by default; summary folds each completed subscription check into one row. */
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
  /** The newest terminal check in this row; for singleton rows this is the check itself. */
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

/** Whether the activity log keeps up with what happens. */
export interface ActivityLogHealth {
  state: 'ok' | 'failing';
  /** Events waiting to be written after a failed write. */
  pending: number;
  /** Events lost because too many waited; they never reach the log. */
  dropped: number;
  lastFailureAt: string | null;
  lastError: string | null;
  /** Unreadable lines found in the log files. */
  skippedLines: number;
}

export interface ActivityPage {
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
