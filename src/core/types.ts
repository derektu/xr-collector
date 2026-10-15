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

export interface YouTubeChannel {
  id: string;
  title: string;
  url: string;
  enabled: boolean;
  addedAt: string;
}

export type JobKind = 'youtube.video' | 'youtube.channel' | 'youtube.channel-add';
export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
export type JobPhase = 'resolve' | 'discover' | 'capture' | 'save' | 'index';
/** What a finished job produced; `empty` is a channel whose discovery found nothing to collect. */
export type JobOutcome = 'created' | 'existing' | 'partial' | 'failed' | 'empty';

export interface JobError {
  code: string;
  message: string;
}

/** One discovered video of a channel job and the video job that collects it. */
export interface JobItem {
  sourceId: string;
  title: string;
  url: string;
  jobId: string | null;
  state: JobState;
  outcome: 'created' | 'existing' | null;
  error: JobError | null;
}

export interface JobProgress {
  total: number;
  done: number;
  created: number;
  existing: number;
  failed: number;
}

export interface JobResult {
  outcome: JobOutcome;
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
  items: JobItem[] | null;
  result: JobResult | null;
  error: JobError | null;
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

/** Minimal durable timeline entry that the Activity view reads later. */
export interface JobEvent {
  eventId: string;
  timestamp: string;
  severity: 'info' | 'warning' | 'error';
  eventType: string;
  message: string;
  vaultPath: string | null;
  jobId: string | null;
  phase?: JobPhase;
  outcome?: JobOutcome;
  errorCode?: string;
  documentId?: string;
  sourceId?: string;
}

export type ChannelScheduleStatus = 'paused' | 'scheduled' | 'running';

export interface ChannelScheduleLastResult {
  runId: string | null;
  created: number;
  existing: number;
  failed: number;
  error?: string;
}

export interface ChannelSchedule {
  enabled: boolean;
  intervalMinutes: number;
  status: ChannelScheduleStatus;
  lastAttemptAt: string | null;
  lastCompletedAt: string | null;
  nextRunAt: string | null;
  lastResult: ChannelScheduleLastResult | null;
}

export type SearchState = 'starting' | 'updating' | 'rebuilding' | 'ready' | 'error';

export interface SearchStatus {
  state: SearchState;
  indexedDocuments: number;
  /** When the index was last rebuilt from the Vault, including rebuilds at startup. */
  lastRebuiltAt: string | null;
  message?: string;
}

/** Search status as the HTTP API reports it, next to the Vault's own document count. */
export interface SearchStatusReport extends SearchStatus {
  vaultDocuments: number;
}

export interface TranscriptSearch {
  status(): SearchStatus;
  index(document: SavedDocument): Promise<void>;
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
  | 'search_unavailable'
  | 'channel_not_found'
  | 'job_not_found'
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

  constructor(code: CollectorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CollectorError';
    this.code = code;
  }
}

export interface TransferStatus {
  state: 'idle' | 'exporting' | 'validating' | 'extracting' | 'indexing' | 'completed' | 'error';
  message: string;
  completedFiles: number;
  totalFiles: number;
  vaultPath: string;
}

export type MergeChoice = 'local' | 'incoming';
export interface MergeItem {
  key: string;
  kind: 'document' | 'channel' | 'schedule' | 'file';
  label: string;
  state: 'new' | 'same' | 'conflict';
  localTime: string | null;
  incomingTime: string | null;
  localText: string;
  incomingText: string;
}
export interface MergePreview {
  id: string;
  items: MergeItem[];
}
