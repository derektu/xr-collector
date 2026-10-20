export type SubtitleKind = 'manual' | 'automatic';

export interface YouTubeVideoRef {
  videoId: string;
  canonicalUrl: string;
}

export interface CapturedTranscript {
  videoId: string;
  sourceUrl: string;
  title: string;
  channelId: string | null;
  channelTitle: string;
  publishedAt: string | null;
  languageCode: string;
  languageName: string | null;
  subtitleKind: SubtitleKind;
  bodyMarkdown: string;
}

/** Source types whose documents the Vault can hold; each adds its own metadata block. */
export type DocumentSourceType = 'youtube';

/** Who published a document; `id` is null for documents saved without a stable publisher ID. */
export interface DocumentPublisher {
  id: string | null;
  name: string;
}

/** Subtitle details that only YouTube transcripts carry. */
export interface YouTubeDocumentMetadata {
  languageCode: string;
  languageName: string | null;
  subtitleKind: SubtitleKind;
}

/** Source-independent document fields shared by browse, search and read. */
export interface DocumentMetadata {
  id: string;
  type: 'Transcript';
  sourceType: DocumentSourceType;
  sourceId: string;
  sourceUrl: string;
  title: string;
  publisher: DocumentPublisher;
  publishedAt: string | null;
  collectedAt: string;
  youtube?: YouTubeDocumentMetadata;
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
 * A subscribed YouTube channel. Its collection settings and check times are portable Vault data and
 * live with it.
 */
export interface YouTubeChannel {
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
  settings: CollectionPolicy;
  /**
   * When the scheduler checks this subscription next; null while it is paused or until the
   * scheduler first plans it. Automatic collection being off leaves the time in place.
   */
  nextCheckAt?: string | null;
  /** The last time a check of this subscription was submitted. */
  lastDispatchedAt?: string | null;
  /** The last discovery that finished listing the channel. */
  lastCheckedAt?: string | null;
  /**
   * Candidates whose exact publish time a capture found earlier than that check's range start,
   * `before`. Publish times do not change, so a check whose range starts no earlier than `before`
   * keeps such a video as a candidate it does not collect, without asking YouTube again. Only
   * videos that are still candidates are kept.
   */
  outOfRange?: OutOfRangeVideo[];
}

/** A video a check found to be published before its range start. */
export interface OutOfRangeVideo {
  videoId: string;
  /** The range start of the check that skipped it; the video was published before this time. */
  before: string;
}

/**
 * `error` marks an enabled subscription whose latest finished channel job failed and that has no
 * job running; the next successful job returns it to `tracking`.
 */
export type SubscriptionStatus = 'tracking' | 'collecting' | 'paused' | 'error';

/**
 * What a subscription is doing now, as its status column shows it. `updating`: a check or its
 * collection runs, `total` is 0 until the check knows how many items it collects. `queued`: a check
 * is due but waits for its turn, a YouTube cooldown or a retry. `scheduled`: nothing runs and the
 * next automatic check is at `nextCheckAt` (null until the scheduler plans it). `paused`: the user
 * paused it. `auto_check_off`: automatic checks are off for every subscription. `login_required`:
 * the source needs the user to sign in again.
 */
export type SubscriptionCheckStatus =
  | { state: 'updating'; done: number; total: number }
  | { state: 'queued' }
  | { state: 'scheduled'; nextCheckAt: string }
  | { state: 'paused' }
  | { state: 'auto_check_off' }
  | { state: 'login_required' };

/** A subscription as the Subscriptions page and Agents read it. */
export interface Subscription extends YouTubeChannel {
  status: SubscriptionStatus;
  /** The status UI and Agents show; computed by the service. */
  checkStatus: SubscriptionCheckStatus;
  /** Whether a video of this subscription is still capturing, also after a pause; it may still save a document. */
  capturing: boolean;
  /** Why the latest channel job failed; set only while `status` is `error`. */
  lastError: JobError | null;
  /** The channel collection job still queued or running, with its item progress. */
  activeJob: { id: string; done: number; total: number } | null;
  documentCount: number;
  /** Collection time of the newest document from this channel. */
  lastCollectedAt: string | null;
}

export type BackfillWindow = '1w' | '2w' | '1m' | '3m' | '6m';

/**
 * Collection settings of one subscription. Every check collects the newest `backfillMaxItems`
 * videos published within `backfillWindow` before the check, leaving out the ones already
 * collected or deleted.
 */
export interface CollectionPolicy {
  intervalMinutes: number;
  backfillWindow: BackfillWindow;
  backfillMaxItems: number;
}

export interface ChannelPreview {
  channel: { id: string; title: string; url: string };
  /** The existing subscription for this channel with its own settings, or null when it is not subscribed. */
  subscription: { enabled: boolean; settings: CollectionPolicy } | null;
  /** The settings of the existing subscription, or the source type's defaults for a new one. */
  settings: CollectionPolicy;
  /** Whether automatic collection is on. */
  autoCollection: boolean;
}

/** What one kind of address of a source type can do: collect a single item or subscribe to new ones. */
export type SourceCapability = 'single' | 'subscription';

export interface SourceKindInfo {
  id: string;
  /** Shown as the kind of a source row and a confirmation card, e.g. "YouTube 頻道". */
  label: string;
  capability: SourceCapability;
  /** What one collected item is called, e.g. "影片". */
  itemNoun: string;
}

export interface SourceSettingField {
  key: keyof CollectionPolicy;
  label: string;
  options: Array<{ value: string | number; label: string }>;
  /** The value a new subscription starts with. */
  default: string | number;
}

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
  /** The video or channel; a video's title is null because recognition does not contact the source. */
  target: { id: string; title: string | null; url: string } | null;
  /** The existing subscription of a recognized channel, with its own settings. */
  subscription: { id: string; enabled: boolean; settings: CollectionPolicy } | null;
  /** The settings a new subscription starts with: the source type's defaults. */
  settings: CollectionPolicy | null;
  /** Whether automatic collection is on; null when the address is not a subscription. */
  autoCollection: boolean | null;
  actions: RecognitionAction[];
  login: { sourceType: DocumentSourceType; label: string; message: string } | null;
  /** Why the address cannot be used, for `unsupported` and `unavailable`. */
  message: string | null;
}

/** A subscription as one row of the source list. */
export interface SourceEntry extends Subscription {
  type: DocumentSourceType;
  kind: string;
  kindLabel: string;
}

/** A subscription request still resolving its channel; it becomes a source once subscribed, or disappears when it fails. */
export interface PendingSubscription {
  jobId: string;
  url: string;
  /** The channel title once resolved; null before. */
  title: string | null;
  checkStatus: SubscriptionCheckStatus;
}

export interface SourceList {
  sources: SourceEntry[];
  /** Subscription requests accepted but not yet subscribed, oldest first. */
  pending: PendingSubscription[];
  /** Documents that belong to no current subscription. */
  unsubscribed: { documentCount: number; lastCollectedAt: string | null };
  /** Number of subscriptions of each declared source type. */
  types: Array<{ type: DocumentSourceType; count: number }>;
}

/** One channel job as a source's collection record. */
export interface SourceJobRecord {
  id: string;
  state: JobState;
  trigger: ChannelJobTrigger | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: JobProgress | null;
  outcome: JobOutcome | null;
  error: JobError | null;
  /** Transient failures so far; `nextAttemptAt` is set while the job waits for its next attempt. */
  retry: JobRetry | null;
  /** Times the job continued after the service restarted. */
  resumedCount: number;
}

export interface SourceDetail {
  source: SourceEntry;
  /** Newest collected first, at most five. */
  recentDocuments: DocumentMetadata[];
  /** Newest first, at most five. */
  recentJobs: SourceJobRecord[];
}

/** Why a channel job was started; it decides the job's labels. Every trigger discovers videos the same way. */
export type ChannelJobTrigger = 'subscribe' | 'resume' | 'scheduled' | 'manual';

/**
 * What a channel job records about why it runs. The range it collects is not part of it: discovery
 * reads the subscription's settings when it starts and measures the range back from that moment.
 */
export interface ChannelJobScope {
  trigger: ChannelJobTrigger;
}

export type JobKind = 'youtube.video' | 'youtube.channel' | 'youtube.channel-add';
export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
export type JobPhase = 'resolve' | 'discover' | 'capture' | 'save' | 'index';
/** What a finished job produced; `empty` is a channel whose discovery found nothing to collect. */
export type JobOutcome = 'created' | 'existing' | 'partial' | 'failed' | 'empty' | 'skipped';

/**
 * Why work was skipped instead of collected. `superseded` is an interrupted job that a later job
 * of the same video or channel took over; `deleted` is an item the user deleted, which only an
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
 * Why a queued job waits without spending an attempt. `rate_limited`: YouTube limited requests and
 * every YouTube step waits until `until`, when the job continues by itself.
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
  /** A video job saved this document; a resume only updates the index. */
  savedDocumentId?: string;
  /**
   * The latest time the user submitted this video directly while this job was already queued: a
   * repeated direct submission of a video job, or a direct submission of a video a channel job
   * queued. That request is explicit, so it may collect the video again after a deletion made
   * before it.
   */
  claimedAt?: string;
  /** A channel-add job: the settings the new subscription starts with, chosen when the job was accepted. */
  settings?: CollectionPolicy;
  /** A channel-add job resolved this channel and is subscribing to it. */
  subscribing?: { channelId: string; title: string; url: string };
  /** A channel job recorded its discovered videos at this time; the subscription's last check time follows it. */
  discovered?: { at: string };
  /**
   * A channel job retrying the failed videos of an earlier one collects exactly these videos: it
   * runs no discovery, leaves the subscription's last check time alone and applies no range bound.
   */
  retryItems?: Array<{ sourceId: string; title: string; url: string }>;
}

/** One discovered video of a channel job and the video job that collects it. */
export interface JobItem {
  sourceId: string;
  title: string;
  url: string;
  jobId: string | null;
  state: JobState;
  outcome: 'created' | 'existing' | 'skipped' | null;
  skipReason?: SkipReason;
  error: JobError | null;
  /** Retry state of the video job that collects this item. */
  retry?: JobRetry;
  /** Cooldown wait of the video job that collects this item. */
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
  channelId?: string;
  /** The channel collection job a channel-add job started. */
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
    type: 'youtube';
    /** Video ID or channel ID; null until a channel URL has been resolved. */
    id: string | null;
    url: string;
    title: string | null;
  };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  progress: JobProgress | null;
  /** Why a channel job runs. */
  scope?: ChannelJobScope;
  /** For a video a channel job found: the start of that check's range; a video published earlier is skipped. */
  publishedNotBefore?: string;
  items: JobItem[] | null;
  result: JobResult | null;
  error: JobError | null;
  retry?: JobRetry;
  /** Set while the job is queued behind a YouTube cooldown. */
  wait?: JobWait;
  recovery?: JobRecovery;
  checkpoint?: JobCheckpoint;
  /** A video a channel job queued that the user also submitted directly; stopping the subscription never skips it. */
  claimedByUser?: boolean;
  /** The failed job this one retries at the user's request. */
  retryOf?: string;
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

export type EventSeverity = 'info' | 'warning' | 'error';

/**
 * One entry of the device activity log. Severity says how serious the entry is; outcome says what a
 * finished job produced, so a skipped video is an `info` entry with outcome `skipped`. Optional fields
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
  /** `youtube.rate_limited` and `job.deferred`: when YouTube requests continue. */
  until?: string;
  /** `youtube.rate_limited`: consecutive limits so far; the cooldown doubles with each one. */
  level?: number;
  /** Why a resumed job stopped: a normal shutdown, an abnormal end, or `unknown` for a stop recorded without it. */
  stopReason?: JobStopKind | 'unknown';
  documentId?: string;
  /** Video ID or channel ID the event concerns. */
  sourceId?: string;
  /** Display title of the video or channel. */
  sourceTitle?: string;
  /** The subscription (channel ID) the event belongs to, for channel jobs and the videos they queued. */
  subscriptionId?: string;
  /** The channel job that queued this video job. */
  parentJobId?: string;
  trigger?: ChannelJobTrigger;
  /** The failed job a manual retry follows. */
  retryOf?: string;
}

/** Filters of an activity query; every filter given must match. */
export interface ActivityQuery {
  severity?: EventSeverity[];
  eventType?: string[];
  /** A job's own events, the events of the videos it queued and of the job that retries it. */
  jobId?: string;
  subscriptionId?: string;
  /** Inclusive lower bound, ISO time. */
  since?: string;
  /** Exclusive upper bound, ISO time. */
  until?: string;
  limit?: number;
  cursor?: string;
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

/** `paused` while automatic collection is off; `scheduled` while it is on. */
/**
 * The YouTube request channel of this device. `cooldown`: YouTube limited requests and none is sent
 * before `cooldownUntil`; `busy`: a request runs; `waiting`: requests wait for their turn; `idle`:
 * nothing is pending. `level` counts consecutive limits; `waitRangeMs` is the random gap between
 * two requests.
 */
export interface YouTubePacingStatus {
  state: 'idle' | 'busy' | 'waiting' | 'cooldown';
  cooldownUntil: string | null;
  level: number;
  waitRangeMs: { min: number; max: number };
}

export type ChannelScheduleStatus = 'paused' | 'scheduled';

/** One subscription's check time as the schedule summary reports it. */
export interface ScheduledCheck {
  channelId: string;
  title: string;
  at: string;
}

/** Automatic collection across subscriptions; each subscription keeps its own interval. */
export interface ChannelSchedule {
  /** The automatic collection switch. */
  enabled: boolean;
  status: ChannelScheduleStatus;
  /** The subscription whose `lastCheckedAt` is the newest. */
  lastCheck: ScheduledCheck | null;
  /** The enabled subscription due first; null while automatic collection is off. */
  nextCheck: ScheduledCheck | null;
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

export type CollectorErrorCode =
  | 'vault_busy'
  | 'vault_not_ready'
  | 'vault_invalid'
  | 'vault_already_set'
  | 'invalid_url'
  | 'invalid_channel'
  | 'no_subtitles'
  | 'video_unavailable'
  | 'network_error'
  | 'rate_limited'
  | 'capture_failed'
  | 'document_not_found'
  | 'document_deleted'
  | 'search_unavailable'
  | 'channel_not_found'
  | 'channel_paused'
  | 'out_of_range'
  | 'job_not_found'
  | 'job_not_retryable'
  | 'unsupported_url'
  | 'queue_full'
  | 'file_exists'
  | 'transfer_cancelled'
  | 'vault_location_fixed'
  | 'insufficient_space'
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
  /** Diagnostic output of an external tool, such as yt-dlp stderr; masked and shortened before it is recorded. */
  readonly detail: string | undefined;
  /** For `rate_limited`: when YouTube requests continue. */
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
   * count. Writing them keeps those videos from being collected again and coming back on later imports.
   */
  mergeRecords: boolean;
}

/**
 * A top-level job the user can retry: a failed one, or a channel job that completed with some of its
 * videos failing.
 */
export function isRetryable(job: Pick<CollectionJob, 'state' | 'kind' | 'parentId' | 'result'>): boolean {
  if (job.parentId !== null) return false;
  return job.state === 'failed' || (job.kind === 'youtube.channel' && job.state === 'completed' && job.result?.outcome === 'partial');
}
