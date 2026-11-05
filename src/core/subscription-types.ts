import type { ActivityCheckSummary } from './activity-types.js';
import type { ConnectivityStatus } from './device-types.js';
import type { DocumentSourceType } from './document-types.js';
import type { ChannelJobTrigger, JobError } from './job-types.js';

/**
 * A subscription as its Vault file stores it: what it follows, its collection settings and its check
 * times. All of it is portable Vault data.
 */
export interface SubscriptionRecord {
  id: string;
  title: string;
  url: string;
  /** False while the subscription is paused. */
  enabled: boolean;
  addedAt: string;
  /**
   * When the person last set the title, URL, paused state or settings, starting with the
   * subscription itself. An import compares it with the other machine's time of the same
   * subscription; when absent, `addedAt` stands for it.
   */
  updatedAt?: string | null;
  /** Check interval and the range every check of this subscription collects. */
  settings: SubscriptionSettings;
  /**
   * When the scheduler checks this subscription next; null while it is paused or until the
   * scheduler first plans it. Automatic collection being off leaves the time in place.
   */
  nextCheckAt?: string | null;
  /** The last time a check of this subscription was submitted. */
  lastDispatchedAt?: string | null;
  /**
   * When the latest check ended, with its items or with a failure; a check stopped by a pause, a
   * removal or a later job does not count.
   */
  lastCheckedAt?: string | null;
  /** The checks in a row that failed; absent once a check succeeds. */
  checkFailures?: CheckFailures | undefined;
  /**
   * When the subscription paused itself because its checks kept failing; absent while it is
   * enabled and after a pause by the person.
   */
  autoPausedAt?: string | undefined;
  /**
   * Candidates whose exact publish time a capture found earlier than that check's range start,
   * `before`. Publish times do not change, so a check whose range starts no earlier than `before`
   * keeps such an item as a candidate it does not collect, without asking the source again. Only
   * items that are still candidates are kept.
   */
  outOfRange?: OutOfRangeEntry[];
  /**
   * Candidates whose collection failed in earlier checks, with the attempts so far. A later check
   * tries such an item again while it is a candidate and not `skipped`; a skipped item stays a
   * candidate that is not collected. Only items that are still candidates without a document are
   * kept.
   */
  failures?: ItemFailureEntry[] | undefined;
}

/**
 * Checks of one subscription that failed in a row. A failure the device's network or a source's
 * limit caused is not the subscription's own and is not counted; nor is a source that needs a new
 * sign-in, which concerns every subscription of its type.
 */
export interface CheckFailures {
  count: number;
  /** When the first of them ended. */
  since: string;
  /** Why the latest of them failed. */
  error: JobError;
}

/**
 * An item of a subscription that failed to be collected. The item key is stored under the field
 * the source type's storage names, such as `videoId`.
 */
export interface ItemFailureEntry {
  /** The item's title as the listing reported it; empty when unknown. */
  title: string;
  /** Checks that tried the item and failed. */
  attempts: number;
  /** Error code of the latest failure; the source type's declaration names it in words. */
  errorCode: string;
  failedAt: string;
  /** True once the item reached the attempt limit or failed in a way no retry changes; checks no longer try it. */
  skipped: boolean;
  /** The item's address, kept for a source type whose keys do not determine it. */
  url?: string;
  [keyField: string]: string | number | boolean | undefined;
}

/**
 * An item a check found to be published before its range start. The item key is stored under the
 * field the source type's storage names, such as `videoId`.
 */
export interface OutOfRangeEntry {
  /** The range start of the check that skipped it; the item was published before this time. */
  before: string;
  [keyField: string]: string;
}

/**
 * `error` marks an enabled subscription whose latest check failed in a way that counts and that
 * has no check running; the next successful check returns it to `tracking`.
 */
export type SubscriptionStatus = 'tracking' | 'collecting' | 'paused' | 'error';

/**
 * Why work that started cannot go on and goes on by itself later. `rate_limited`: the source
 * limited requests and the work continues when the cooldown ends. `failed`: a transient failure;
 * `attempt` of `maxAttempts` starts at the retry time.
 */
export type RetryCause =
  | { reason: 'rate_limited' }
  | { reason: 'failed'; error: JobError; attempt: number; maxAttempts: number };

/**
 * What unfinished top-level work is doing. `queued`: it has not started and waits for its turn.
 * `checking`: a check lists its subscription and knows no items to collect yet, or a subscription
 * request resolves its address. `downloading`: an item collects, or a check collects its items,
 * also while the capture slot serves other work. `retrying`: nothing can go on until `at`, because
 * the work's own step waits for a retry or a cooldown, or every item a check still collects does.
 */
export type WorkStatus =
  | { state: 'queued' }
  | { state: 'checking' }
  | { state: 'downloading' }
  | { state: 'retrying'; at: string; cause: RetryCause };

/**
 * What a subscription is doing now, as its status column shows it. While a check is unfinished:
 * `queued` before it starts, `checking` while it lists, `downloading` with `done` of `total` items
 * once it knows them, `retrying` while it cannot go on. A subscription request still resolving its
 * address is `adding`. Without a check: `queued` when a check is due and not dispatched yet,
 * `scheduled` with the next automatic check, `failing` with the checks in a row that failed and
 * the next automatic check (null while automatic checks are off), `paused` when the user paused it,
 * `auto_paused` when it paused itself after `failures` checks in a row failed, `auto_check_off`
 * when automatic checks are off for every subscription, `login_required` when the source needs the
 * user to sign in again.
 */
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

/** A subscription as the Subscriptions page and Agents read it. */
export interface Subscription extends Omit<SubscriptionRecord, 'checkFailures' | 'autoPausedAt'> {
  status: SubscriptionStatus;
  /** The status UI and Agents show; computed by the service. */
  checkStatus: SubscriptionCheckStatus;
  /** Whether an item of this subscription is still capturing, also after a pause; it may still save a document. */
  capturing: boolean;
  /** Why the latest check failed; set only while `status` is `error`. */
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
 * Collection settings of one subscription: the check interval every type uses, and the fields its
 * source type defines for the range a check collects.
 */
export type SubscriptionSettings = { intervalMinutes: number; [key: string]: string | number };

/** A resolved subscription address of a source type with its subscription state. */
export interface SubscriptionPreview {
  type: DocumentSourceType;
  /** The resolved subscription target; its ID is the subscription ID. */
  target: { id: string; title: string; url: string };
  /** The existing subscription of this target with its own settings, or null when it is not subscribed. */
  subscription: { enabled: boolean; settings: SubscriptionSettings } | null;
  /** The settings of the existing subscription, or the source type's defaults for a new one. */
  settings: SubscriptionSettings;
  /** Whether automatic collection is on. */
  autoCollection: boolean;
}

/** A subscription with its source type and kind, as the subscription list and detail return it. */
export interface SubscriptionEntry extends Subscription {
  type: DocumentSourceType;
  kind: string;
  kindLabel: string;
}

/** A subscription request still resolving its address; it joins the subscriptions once subscribed, or disappears when it fails. */
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
  /** Number of subscriptions of each declared source type. */
  types: Array<{ type: DocumentSourceType; count: number }>;
}

/**
 * One row of a subscription's collection record. Each item appears once, in its current state:
 * `collected` with its document, `failed` with the attempts so far, or `skipped` once checks no
 * longer try it (`skippedBy`: `limit` after the last attempt, `failure` for a failure no retry
 * changes). `check` sums up one finished check. `reason` names the error code in words.
 */
export type SubscriptionCollectionEntry =
  | { kind: 'collected'; at: string; key: string; title: string; documentId: string }
  | { kind: 'failed'; at: string; key: string; title: string; url: string; errorCode: string; reason: string; attempts: number; maxAttempts: number }
  | { kind: 'skipped'; at: string; key: string; title: string; url: string; errorCode: string; reason: string; attempts: number; skippedBy: 'limit' | 'failure' }
  | {
    kind: 'check'; at: string; jobId: string; trigger: ChannelJobTrigger | null;
    /** Items collected and failed by the check; both 0 when it found nothing new. */
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

/** `paused` while automatic collection is off; `scheduled` while it is on. */
export type CollectionScheduleStatus = 'paused' | 'scheduled';

/** One subscription's check time as the schedule summary reports it. */
export interface ScheduledCheck {
  type: DocumentSourceType;
  subscriptionId: string;
  title: string;
  at: string;
}

/** Automatic collection across subscriptions; each subscription keeps its own interval. */
export interface CollectionSchedule {
  /** The automatic collection switch. */
  enabled: boolean;
  status: CollectionScheduleStatus;
  /** The subscription whose `lastCheckedAt` is the newest. */
  lastCheck: ScheduledCheck | null;
  /** The enabled subscription due first; null while automatic collection is off. */
  nextCheck: ScheduledCheck | null;
}

/** The automatic collection schedule as the API returns it, with the network collection depends on. */
export interface CollectionScheduleView extends CollectionSchedule {
  connectivity: ConnectivityStatus;
}
