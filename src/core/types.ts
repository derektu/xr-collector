import { jobRole } from './source-registry.js';
import type { PauseReason } from './collection-pause.js';

/** ID of a source type whose documents the Vault can hold: the ID of a registered source plugin. */
export type DocumentSourceType = string;

/** Who published a document; `id` is null for documents saved without a stable publisher ID. */
export interface DocumentPublisher {
  id: string | null;
  name: string;
}

/**
 * Type-specific document details, each under a field named after its source type. Every source
 * plugin adds its own field to this interface; the core passes the field through untouched.
 */
export interface DocumentDetails {}

/**
 * How much of the item a document body holds: `full` for the whole content, `summary` for only the
 * summary the source offers.
 */
export type ContentExtent = 'full' | 'summary';

/** Source-independent document fields shared by browse, search and read. */
export interface DocumentMetadata extends DocumentDetails {
  id: string;
  /** The frontmatter `type` its source type gives its documents. */
  type: string;
  sourceType: DocumentSourceType;
  sourceId: string;
  sourceUrl: string;
  title: string;
  publisher: DocumentPublisher;
  publishedAt: string | null;
  collectedAt: string;
  /** Set on a document read from the Vault; browse and search results leave it out. */
  contentExtent?: ContentExtent;
}

export interface SavedDocument extends DocumentMetadata {
  bodyMarkdown: string;
}

export interface DocumentSummary extends DocumentMetadata {
  /** Plain-text opening of the body, not a generated summary. */
  excerpt: string;
}

/** Narrows browse and search to one source type, optionally one publisher within it. */
export interface DocumentFilter {
  sourceType?: DocumentSourceType;
  /** A publisher ID, or `none` for documents without one; requires `sourceType`. */
  publisherId?: string;
}

export interface DocumentPage {
  documents: DocumentSummary[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
}

export interface DocumentSourcePublisher {
  id: string | null;
  name: string;
  count: number;
  /**
   * Whether the publisher is in the source's subscription list. False covers both a removed
   * subscription whose documents stay and a publisher only collected item by item; null when the
   * documents carry no publisher ID to match.
   */
  subscribed: boolean | null;
  /** The publisher's subscription was removed and not added again; its documents stay. */
  removed: boolean;
}

export interface DocumentSourceGroup {
  sourceType: DocumentSourceType;
  label: string;
  count: number;
  publishers: DocumentSourcePublisher[];
}

export interface DocumentSources {
  total: number;
  groups: DocumentSourceGroup[];
}

export interface SearchQuery extends DocumentFilter {
  query: string;
  offset?: number;
  limit?: number;
  publishedFrom?: string;
  publishedTo?: string;
}

export interface SearchHit extends DocumentMetadata {
  /** Cropped body text around the match, with matched terms wrapped in `<mark>` and `</mark>`. */
  snippet: string;
}

export interface SearchResponse {
  hits: SearchHit[];
  /** Exact number of matching documents. */
  total: number;
  offset: number;
  limit: number;
}

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
 * A subscription pauses itself once this many checks in a row failed and the first of them ended
 * at least AUTO_PAUSE_AFTER_MS earlier, so neither a burst of failures nor a long but rare outage
 * pauses it.
 */
export const AUTO_PAUSE_FAILURES = 5;
export const AUTO_PAUSE_AFTER_MS = 24 * 60 * 60_000;

/** Checks that may each try a failed item of a subscription before it is skipped. */
export const MAX_CHECK_ATTEMPTS = 3;

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

/** What one kind of address of a source type can do: collect a single item or subscribe to new ones. */
export type SourceCapability = 'single' | 'subscription';

export interface SourceKindInfo {
  id: string;
  /** Shown as the kind of a source row and a confirmation card. */
  label: string;
  capability: SourceCapability;
  /** What one collected item is called, e.g. "影片". */
  itemNoun: string;
}

/** A collection setting chosen from a list of values. */
export interface ChoiceSettingField {
  input: 'choice';
  key: string;
  label: string;
  options: Array<{ value: string | number; label: string }>;
  /** The value a new subscription starts with. */
  default: string | number;
}

/** A collection setting typed as a whole number from `min` to `max`. */
export interface NumberSettingField {
  input: 'number';
  key: string;
  label: string;
  min: number;
  max: number;
  /** What the number counts, shown after the input, e.g. "天" or "支影片". */
  unit: string;
  /** The value a new subscription starts with. */
  default: number;
}

export type SourceSettingField = ChoiceSettingField | NumberSettingField;

/** The public part of a source type declaration; the UI builds entry, filters and icons from it. */
export interface SourceTypeInfo {
  id: DocumentSourceType;
  label: string;
  /** Key of the icon the UI draws for this type. */
  icon: string;
  kinds: SourceKindInfo[];
  /** Collecting needs a signed-in account; such addresses are recognized but not resolved. */
  requiresLogin: boolean;
  /** Collection settings a subscription of this type uses. */
  settings: SourceSettingField[];
}

export type RecognitionStatus = 'ready' | 'login_required' | 'unsupported' | 'unavailable';

/** One step the recognized address offers, with the request that performs it. */
export interface RecognitionAction {
  id: 'collect' | 'subscribe' | 'resume';
  label: string;
  primary: boolean;
  request: { method: 'POST' | 'PATCH'; path: string; body: Record<string, unknown> };
}

/** What a pasted address is and what can be done with it. */
export interface UrlRecognition {
  status: RecognitionStatus;
  sourceType: DocumentSourceType | null;
  kind: string | null;
  kindLabel: string | null;
  /** The address the actions use; the input as given when nothing recognized it. */
  url: string;
  /** The item or subscription target; an item's title is null because recognition does not contact the source. */
  target: { id: string; title: string | null; url: string } | null;
  /** The existing subscription of a recognized subscription address, with its own settings. */
  subscription: { id: string; enabled: boolean; settings: SubscriptionSettings } | null;
  /** The settings a new subscription starts with: the source type's defaults. */
  settings: SubscriptionSettings | null;
  /** Whether automatic collection is on; null when the address is not a subscription. */
  autoCollection: boolean | null;
  actions: RecognitionAction[];
  login: { sourceType: DocumentSourceType; label: string; message: string } | null;
  /** Why the address cannot be used, for `unsupported` and `unavailable`. */
  message: string | null;
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

/**
 * How a job stopped: the service closed normally, ended abnormally, moved the Vault to another
 * location, or switched to another Vault.
 */
export type JobStopKind = 'shutdown' | 'crash' | 'vault_move' | 'vault_switch';

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

export interface JobSubmission {
  job: CollectionJob;
  /** True when an active job for the same item already existed and was returned instead. */
  deduplicated: boolean;
}

export interface JobPage {
  jobs: CollectionJob[];
  nextCursor: string | null;
}

/** A job as the HTTP API returns it, without the data that only serves restarts. */
export type JobView = Omit<CollectionJob, 'checkpoint' | 'claimedByUser'>;

export interface JobSubmissionView {
  job: JobView;
  /** True when an active job for the same item already existed and was returned instead. */
  deduplicated: boolean;
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

export interface JobPageView {
  jobs: JobView[];
  nextCursor: string | null;
}

export type EventSeverity = 'debug' | 'info' | 'warning' | 'error';

/** Device login-startup state, shared by the Settings UI and authorized Agents. */
export type LoginStartupState = 'enabled' | 'disabled' | 'requires_approval' | 'unavailable';

export interface LoginStartupStatus {
  supported: boolean;
  enabled: boolean;
  state: LoginStartupState;
  message: string;
}

/**
 * One entry of the device activity log. Severity says how serious the entry is; outcome says what a
 * finished job produced. Optional fields
 * appear when the entry concerns them.
 */
export interface JobEvent {
  eventId: string;
  timestamp: string;
  severity: EventSeverity;
  eventType: string;
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

/** Whether the device has a network, as collection needs to know it. */
export type ConnectivityState = 'online' | 'offline';

export interface ConnectivityStatus {
  state: ConnectivityState;
  /** The last confirmation of the device's network; null before the first one. */
  checkedAt: string | null;
}

/** The automatic collection schedule as the API returns it, with the network collection depends on. */
export interface CollectionScheduleView extends CollectionSchedule {
  connectivity: ConnectivityStatus;
}

export type SearchState = 'starting' | 'updating' | 'rebuilding' | 'ready' | 'error';

export interface SearchStatus {
  state: SearchState;
  indexedDocuments: number;
  /** When the index was last rebuilt from the Vault, including rebuilds at startup. */
  lastRebuiltAt: string | null;
  message?: string;
}

/** The result of deleting a document. */
export interface DocumentDeletion {
  deleted: { id: string; sourceType: DocumentSourceType; sourceId: string; title: string; deletedAt: string };
  /**
   * True when the search service excludes the document from results; its index entry is removed in
   * the background, and a failed removal is recorded as `document.index_remove_failed`. False when
   * no search service runs; the next search start compares the index with the Vault and leaves the
   * document out.
   */
  indexed: boolean;
  indexMessage?: string;
}

/** Search status as the HTTP API reports it, next to the Vault's own document count. */
export interface SearchStatusReport extends SearchStatus {
  vaultDocuments: number;
}

export interface TranscriptSearch {
  status(): SearchStatus;
  index(document: SavedDocument): Promise<void>;
  /** Removes a deleted document; it is excluded from results from the moment this is called. */
  remove(id: string): Promise<void>;
  search(query: SearchQuery): Promise<SearchResponse>;
  rebuild(): Promise<void>;
}

/**
 * The code of a `CollectorError`: one of the core's own codes, or a code a source type raises and
 * declares with its HTTP status (`errorStatus` of its definition).
 */
export type CollectorErrorCode = CoreErrorCode | (string & {});

/** The error codes the core raises, each with a fixed HTTP status. */
export type CoreErrorCode =
  | 'vault_busy'
  | 'vault_not_ready'
  | 'vault_invalid'
  | 'vault_already_set'
  | 'invalid_url'
  | 'invalid_subscription'
  | 'network_error'
  | 'offline'
  | 'rate_limited'
  | 'capture_failed'
  | 'document_not_found'
  | 'document_deleted'
  | 'search_unavailable'
  | 'subscription_not_found'
  | 'subscription_paused'
  | 'out_of_range'
  | 'job_not_found'
  | 'job_not_retryable'
  | 'job_not_dismissable'
  | 'unsupported_url'
  | 'queue_full'
  | 'file_exists'
  | 'transfer_cancelled'
  | 'vault_location_fixed'
  | 'insufficient_space'
  | 'activity_snapshot_expired'
  | 'activity_group_expired'
  | 'login_startup_unavailable'
  | 'login_startup_requires_approval'
  | 'login_startup_failed'
  | 'agent_connection_unavailable'
  | 'update_busy'
  | 'update_cancelled'
  | 'update_source_failed'
  | 'update_not_published'
  | 'update_metadata_invalid'
  | 'update_asset_missing'
  | 'update_not_available'
  | 'update_offer_changed'
  | 'update_download_failed'
  | 'update_integrity_failed'
  | 'update_not_ready'
  | 'update_install_unavailable'
  | 'update_apply_failed'
  | 'invalid_request';

/** Result of reading a directory before it is created or opened as a Vault. */
export type VaultInspection =
  | { kind: 'empty'; path: string; exists: boolean }
  | { kind: 'existing'; path: string; documentCount: number }
  | { kind: 'invalid'; path: string; reason: string };

export type VaultSetupAction = 'create' | 'open' | 'import';

/** Device-side Vault location state shared by Onboarding, Settings and Agents. */
export interface VaultSetupStatus {
  state: 'ready' | 'not_ready';
  vaultPath: string | null;
  suggestedPath: string;
  /** The previously selected Vault that could not be opened at startup. */
  failure: { path: string; reason: string } | null;
}

export interface VaultSetupResult {
  vault: VaultSetupStatus;
  documentCount: number;
}

export class CollectorError extends Error {
  readonly code: CollectorErrorCode;
  /** Diagnostic output of an external tool, such as its stderr; masked and shortened before it is recorded. */
  readonly detail: string | undefined;
  /** For `rate_limited`: when the source's requests continue. */
  readonly retryAt: string | undefined;

  constructor(code: CollectorErrorCode, message: string, options?: ErrorOptions & { detail?: string; retryAt?: string }) {
    super(message, options);
    this.name = 'CollectorError';
    this.code = code;
    this.detail = options?.detail;
    this.retryAt = options?.retryAt;
  }
}

export type TransferOperation = 'export' | 'import' | 'move' | 'open';

/**
 * Progress of the one Vault export, import, move or switch that runs at a time. `waiting` means the
 * operation waits for the collection steps already running to finish; queued collection waits until
 * the operation ends.
 */
export interface TransferStatus {
  state: 'idle' | 'waiting' | 'exporting' | 'validating' | 'extracting' | 'copying' | 'verifying' | 'indexing' | 'cleaning'
    | 'completed' | 'error';
  operation: TransferOperation | null;
  message: string;
  completedFiles: number;
  totalFiles: number;
  vaultPath: string;
  /** What the last finished operation produced; null while one runs or after a failure. */
  result: TransferResult | null;
  /** The error code of a failed operation, such as `vault_busy`; null unless `state` is `error`. */
  errorCode: CollectorErrorCode | null;
  /** Why the active Vault cannot be moved or another Vault opened; null when both are possible. */
  relocationUnavailable: { code: CollectorErrorCode; message: string } | null;
}

export interface TransferResult {
  /** Export: the written export file and its size. */
  exportPath?: string;
  exportBytes?: number;
  /** Export: files in the Vault folder that belong to no record of the Vault and are not in the export. */
  unregisteredFiles?: number;
  /** Import: how it was applied, the changes it made, and the export of the Vault as it was before. */
  importMode?: ImportMode;
  imported?: ChangeCounts;
  writtenFiles?: number;
  backupPath?: string;
  /** Import: the files are in place but the search index could not be updated; the person rebuilds it. */
  searchRebuildNeeded?: boolean;
  /**
   * Open: the Vault in use before the switch, which stays where it is, and how many of its
   * collection jobs stopped with the switch; they continue when that Vault is opened again.
   */
  previousVaultPath?: string;
  interruptedJobs?: number;
  /** Move and open: unfinished jobs of the Vault now in use that continue after the switch. */
  resumedJobs?: number;
  /** Move: a part of the previous location that could not be removed and is left for the person to delete. */
  leftoverPath?: string;
}

/** Where a move would place the active Vault and the space it needs there. */
export interface MoveCheck {
  targetPath: string;
  requiredBytes: number;
  availableBytes: number;
}

/** Where an export goes when no other place is chosen: the export folder and a file name of today. */
export interface ExportSuggestion {
  folder: string;
  path: string;
}

export type ImportMode = 'merge' | 'replace';

/** Items an import adds, updates and removes, for one kind of item. */
export interface ItemCounts { added: number; updated: number; removed: number }

/** What an import changes, by kind of item. */
export interface ChangeCounts { documents: ItemCounts; subscriptions: ItemCounts }

/**
 * What importing an export file into the active Vault would change. Every document and
 * subscription carries the time of its last change, and a deletion or removal is a change of its
 * own; for each item the newer state wins, and a tie keeps the local one.
 */
export interface ImportPreview {
  id: string;
  /** The machine name is for diagnosis; the app does not show it. */
  package: { fileName: string; exportedAt: string | null; machine: string | null };
  /** What a merge changes: the items whose state in the file is newer. */
  merge: ChangeCounts;
  /** What replacing the Vault with the file's content changes; `removed` includes the items only the Vault has. */
  replace: ChangeCounts;
  /** Items that differ from the file where the Vault holds the newer state, including items only the Vault has. */
  localNewer: number;
  /**
   * A merge still writes deletion records of documents the Vault never had, which `merge` does not
   * count. Writing them keeps those items from being collected again and coming back on later imports.
   */
  mergeRecords: boolean;
}

/**
 * A top-level job the user can retry: a failed one, or a check job that completed with some of its
 * items failing.
 */
export function isRetryable(job: Pick<CollectionJob, 'state' | 'kind' | 'parentId' | 'result'>): boolean {
  if (job.parentId !== null) return false;
  return job.state === 'failed' || (jobRole(job.kind)?.role === 'check' && job.state === 'completed' && job.result?.outcome === 'partial');
}

/** The immutable artifact identity shared by the UI and authorized Agents. */
export interface BuildInfo {
  schemaVersion: 1;
  kind: 'development' | 'packaged';
  version: string;
  builtAt: string;
  commit: string | null;
  buildId: string;
  target: string;
  /** Null means source identity could not be determined; it never means a clean checkout. */
  sourceDirty: boolean | null;
}

export type UpdatePhase = 'idle' | 'checking' | 'up_to_date' | 'available' | 'downloading' | 'verifying'
  | 'ready' | 'waiting' | 'installing' | 'error';

export interface UpdateAsset { name: string; url: string; bytes: number; sha256: string }

/** One immutable release choice. Latest discovery never changes an offer after it is selected. */
export interface UpdateOffer {
  version: string;
  commit: string;
  target: string;
  releaseNotes: string;
  source: { id: string; indexUrl: string };
  payload: UpdateAsset;
  buildInfo: BuildInfo;
}

export interface UpdateInstallAttempt {
  id: string;
  version: string;
  buildId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'pending' | 'succeeded' | 'failed' | 'unknown';
  message: string;
}

/** Device-level update state shared by the UI, tray and authorized Agent API. */
export interface DeviceUpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  target: string;
  installerAvailable: boolean;
  offer: UpdateOffer | null;
  ready: UpdateOffer | null;
  lastAttempt: UpdateInstallAttempt | null;
  progress: { transferred: number; total: number; percent: number } | null;
  /** Most recent check attempt, successful or failed; scheduling uses this to avoid retry storms. */
  lastCheckAttemptAt: string | null;
  /** Most recent successful check. */
  checkedAt: string | null;
  message: string;
  errorCode: string | null;
}
