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

/** Where incremental discovery of a subscription stops: the newest video already handed to a job. */
export interface ChannelCursor {
  videoId: string;
  /** Approximate publish time from the channel listing; null when the listing gave none. */
  publishedAt: string | null;
  /** Recently accepted or listed video IDs, newest first, so a deleted cursor video still ends discovery. */
  recentIds: string[];
}

/**
 * A subscribed YouTube channel. Its collection settings, discovery progress and check times are
 * portable Vault data and live with it.
 */
export interface YouTubeChannel {
  id: string;
  title: string;
  url: string;
  /** False while the subscription is paused. */
  enabled: boolean;
  addedAt: string;
  /** Check interval and backfill range of this subscription. */
  settings: CollectionPolicy;
  /**
   * When the scheduler checks this subscription next; null while it is paused or until the
   * scheduler first plans it. Automatic collection being off leaves the time in place.
   */
  nextCheckAt?: string | null;
  /** The last time a check of this subscription was submitted, by any trigger except a follow-up batch. */
  lastDispatchedAt?: string | null;
  /** Null until the first discovery, and again after a resume. */
  cursor?: ChannelCursor | null;
  /** The last discovery that finished listing the channel. */
  lastCheckedAt?: string | null;
  /** True when incremental discovery left newer videos for a follow-up batch. */
  backlog?: boolean;
}

/**
 * `error` marks an enabled subscription whose latest finished channel job failed and that has no
 * job running; the next successful job returns it to `tracking`.
 */
export type SubscriptionStatus = 'tracking' | 'collecting' | 'paused' | 'error';

/** A subscription as the Sources page and Agents read it. */
export interface Subscription extends YouTubeChannel {
  status: SubscriptionStatus;
  /** Why the latest channel job failed; set only while `status` is `error`. */
  lastError: JobError | null;
  /** The channel collection job still queued or running, with its item progress. */
  activeJob: { id: string; done: number; total: number } | null;
  documentCount: number;
  /** Collection time of the newest document from this channel. */
  lastCollectedAt: string | null;
}

export type BackfillWindow = '1w' | '2w' | '1m' | '3m' | '6m';

/** Collection settings of one subscription. */
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

export interface SourceList {
  sources: SourceEntry[];
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

/** Why a channel job was started; it decides the labels and, with the cursor, the discovery mode. */
export type ChannelJobTrigger = 'subscribe' | 'resume' | 'scheduled' | 'manual' | 'backlog';

/**
 * The discovery range a channel job accepted. Backfill takes the newest uncollected videos published
 * since `windowStart`, at most `maxItems`; incremental takes every video newer than `cursor`.
 * Later settings changes never alter an accepted scope.
 */
export interface ChannelJobScope {
  trigger: ChannelJobTrigger;
  mode: 'backfill' | 'incremental';
  windowStart: string;
  maxItems: number;
  cursor: ChannelCursor | null;
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

export type JobStopKind = 'shutdown' | 'crash';

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
  /** A channel job recorded its discovered videos; the subscription cursor follows them. */
  discovered?: { at: string; cursor: ChannelCursor | null; backlog: boolean; cursorSaved: boolean };
  /**
   * A channel job retrying the failed videos of an earlier one collects exactly these videos: it
   * runs no discovery, leaves the subscription cursor alone and applies no backfill bound.
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
  /** A channel job that left newer videos for a follow-up batch. */
  backlog?: boolean;
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
  /** The accepted discovery range of a channel or channel-add job. */
  scope?: ChannelJobScope;
  /** For a video found by backfill: videos published before this time are skipped. */
  publishedNotBefore?: string;
  items: JobItem[] | null;
  result: JobResult | null;
  error: JobError | null;
  retry?: JobRetry;
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
  | 'invalid_request';

/** Result of reading a directory before it is created or opened as a Vault. */
export type VaultInspection =
  | { kind: 'empty'; path: string; exists: boolean }
  | { kind: 'existing'; path: string; documentCount: number }
  | { kind: 'invalid'; path: string; reason: string };

export type VaultSetupAction = 'create' | 'open';

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

  constructor(code: CollectorErrorCode, message: string, options?: ErrorOptions & { detail?: string }) {
    super(message, options);
    this.name = 'CollectorError';
    this.code = code;
    this.detail = options?.detail;
  }
}

export type TransferOperation = 'export' | 'merge' | 'restore';

/**
 * Progress of the one Vault export, merge or restore that runs at a time. `waiting` means the
 * operation waits for the collection steps already running to finish; queued collection waits
 * until the operation ends.
 */
export interface TransferStatus {
  state: 'idle' | 'waiting' | 'exporting' | 'validating' | 'extracting' | 'indexing' | 'completed' | 'error';
  operation: TransferOperation | null;
  message: string;
  completedFiles: number;
  totalFiles: number;
  vaultPath: string;
  /** When this device last exported the active Vault; null when it never has. */
  lastExportedAt: string | null;
  /** What the last finished operation produced; null while one runs or after a failure. */
  result: TransferResult | null;
}

export interface TransferResult {
  /** Export: the written package file and its size. */
  exportPath?: string;
  exportBytes?: number;
  /** Merge: files written and the package of the Vault as it was before the merge. */
  writtenFiles?: number;
  mergeBackupPath?: string;
  /**
   * Restore: the Vault in use before the switch, which stays where it is, and how many of its
   * collection jobs stopped with the switch; they continue when that Vault is opened again.
   * The restored Vault starts with automatic collection paused.
   */
  previousVaultPath?: string;
  interruptedJobs?: number;
  autoCollectionPaused?: boolean;
}

export type MergeChoice = 'local' | 'incoming';
/**
 * One difference between the local Vault and an imported package. A `deletion` item pairs a
 * deletion record on one side with the document or nothing on the other side.
 */
export interface MergeItem {
  key: string;
  kind: 'document' | 'channel' | 'file' | 'deletion';
  label: string;
  state: 'new' | 'same' | 'conflict';
  localTime: string | null;
  incomingTime: string | null;
  localText: string;
  incomingText: string;
  /** Deletion items: which side holds the deletion record. */
  deletedOn?: 'local' | 'incoming';
}
export interface MergePreview {
  id: string;
  items: MergeItem[];
  /** The description a package carries, when it carries one. */
  package: { version: number; exportedAt: string | null; createdBy: string | null };
}

/**
 * A top-level job the user can retry: a failed one, or a channel job that completed with some of its
 * videos failing.
 */
export function isRetryable(job: Pick<CollectionJob, 'state' | 'kind' | 'parentId' | 'result'>): boolean {
  if (job.parentId !== null) return false;
  return job.state === 'failed' || (job.kind === 'youtube.channel' && job.state === 'completed' && job.result?.outcome === 'partial');
}
