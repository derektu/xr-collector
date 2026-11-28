import type { ActivityCheckSummary } from '../activity/activity-types.js';
import type { ConnectivityStatus } from '../api/device-types.js';
import type { DocumentSourceType, DocumentStatus } from '../documents/document-types.js';
import type { ChannelJobTrigger, JobError } from '../jobs/job-types.js';

export interface SubscriptionRecord {
  id: string;
  title: string;
  url: string;
  enabled: boolean;
  addedAt: string;
  /** When the person last set the title, URL, paused state or settings. */
  updatedAt: string;
  settings: SubscriptionSettings;
  /** When the scheduler checks this subscription next; null while it is paused or until the scheduler first plans it. */
  nextCheckAt?: string | null;
  lastDispatchedAt?: string | null;
  lastCheckedAt?: string | null;
  /** The checks in a row that failed; absent once a check succeeds. */
  checkFailures?: CheckFailures | undefined;
  autoPausedAt?: string | undefined;
  outOfRange?: OutOfRangeEntry[];
  failures?: ItemFailureEntry[] | undefined;
}

export interface CheckFailures {
  count: number;
  /** When the first of them ended. */
  since: string;
  /** Why the latest of them failed. */
  error: JobError;
}

/** The item key is stored under the field the source type's storage names, such as `videoId`. */
export interface ItemFailureEntry {
  /** The item's title as the listing reported it; empty when unknown. */
  title: string;
  /** Checks that tried the item and failed. */
  attempts: number;
  /** Error code of the latest failure; the source type's declaration names it in words. */
  errorCode: string;
  failedAt: string;
  skipped: boolean;
  /** The item's address, kept for a source type whose keys do not determine it. */
  url?: string;
  [keyField: string]: string | number | boolean | undefined;
}

/** The item key is stored under the field the source type's storage names, such as `videoId`. */
export interface OutOfRangeEntry {
  /** The range start of the check that skipped it; the item was published before this time. */
  before: string;
  [keyField: string]: string;
}

export type SubscriptionStatus = 'tracking' | 'collecting' | 'paused' | 'error';

export type RetryCause =
  | { reason: 'rate_limited' }
  | { reason: 'failed'; error: JobError; attempt: number; maxAttempts: number };

export type WorkStatus =
  | { state: 'queued' }
  | { state: 'checking' }
  | { state: 'downloading' }
  | { state: 'retrying'; at: string; cause: RetryCause };

export type SubscriptionCheckStatus =
  | { state: 'queued' }
  | { state: 'adding' }
  | { state: 'checking' }
  | { state: 'downloading'; done: number; total: number }
  | { state: 'retrying'; at: string; cause: RetryCause }
  | { state: 'scheduled'; nextCheckAt: string }
  | { state: 'failing'; failures: number; nextCheckAt: string | null }
  | { state: 'paused' }
  | { state: 'auto_paused'; failures: number }
  | { state: 'auto_check_off' }
  | { state: 'login_required' };

export interface Subscription extends Omit<SubscriptionRecord, 'checkFailures' | 'autoPausedAt'> {
  status: SubscriptionStatus;
  checkStatus: SubscriptionCheckStatus;
  capturing: boolean;
  lastError: JobError | null;
  checkFailures: CheckFailures | null;
  autoPausedAt: string | null;
  /** The check job still queued or running, with its item progress. */
  activeJob: { id: string; done: number; total: number } | null;
  documentCount: number;
  /** Collection time of the newest document from this subscription. */
  lastCollectedAt: string | null;
}

/**
 * The collection settings a source type declares: the check interval every type uses, and the fields
 * it defines for the range a check collects.
 */
export type SourceSettings = { intervalMinutes: number; [key: string]: string | number };

/**
 * Collection settings of one subscription: its source type's settings and the status of the
 * documents its checks save, which the core adds for every type. A stored subscription without
 * `documentStatus` reads as `published`.
 */
export type SubscriptionSettings = SourceSettings & { documentStatus: DocumentStatus };

export interface SubscriptionPreview {
  type: DocumentSourceType;
  /** The resolved subscription target; its ID is the subscription ID. */
  target: { id: string; title: string; url: string };
  /** The existing subscription of this target with its own settings, or null when it is not subscribed. */
  subscription: { enabled: boolean; settings: SubscriptionSettings } | null;
  /** The settings of the existing subscription, or the source type's defaults for a new one. */
  settings: SubscriptionSettings;
  autoCollection: boolean;
}

export interface SubscriptionEntry extends Subscription {
  type: DocumentSourceType;
  kind: string;
  kindLabel: string;
}

export interface PendingSubscription {
  type: DocumentSourceType;
  jobId: string;
  url: string;
  /** The target's title once resolved; null before. */
  title: string | null;
  checkStatus: SubscriptionCheckStatus;
}

export interface SubscriptionList {
  subscriptions: SubscriptionEntry[];
  /** Subscription requests accepted but not yet subscribed, oldest first. */
  pending: PendingSubscription[];
  /** Documents that belong to no current subscription. */
  unsubscribed: { documentCount: number; lastCollectedAt: string | null };
  types: Array<{ type: DocumentSourceType; count: number }>;
}

export type SubscriptionCollectionEntry =
  | { kind: 'collected'; at: string; key: string; title: string; documentId: string }
  | { kind: 'failed'; at: string; key: string; title: string; url: string; errorCode: string; reason: string; attempts: number; maxAttempts: number }
  | { kind: 'skipped'; at: string; key: string; title: string; url: string; errorCode: string; reason: string; attempts: number; skippedBy: 'limit' | 'failure' }
  | {
    kind: 'check'; at: string; jobId: string; trigger: ChannelJobTrigger | null;
    created: number; failed: number;
    /** Why the check could not list its subscription; null when it listed it. */
    error: JobError | null;
    groupId?: string;
  }
  | {
    kind: 'check-group'; at: string; firstAt: string; groupId: string; trigger: ChannelJobTrigger;
    result: ActivityCheckSummary['result']; count: number; errorCode?: string; message: string;
  };

export interface SubscriptionDetail {
  subscription: SubscriptionEntry;
  /** Newest first, at most 30 rows. */
  collection: SubscriptionCollectionEntry[];
}

export type CollectionScheduleStatus = 'paused' | 'scheduled';

export interface ScheduledCheck {
  type: DocumentSourceType;
  subscriptionId: string;
  title: string;
  at: string;
}

export interface CollectionSchedule {
  enabled: boolean;
  status: CollectionScheduleStatus;
  /** The subscription whose `lastCheckedAt` is the newest. */
  lastCheck: ScheduledCheck | null;
  /** The enabled subscription due first; null while automatic collection is off. */
  nextCheck: ScheduledCheck | null;
}

export interface CollectionScheduleView extends CollectionSchedule {
  connectivity: ConnectivityStatus;
}
