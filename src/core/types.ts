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

export interface SavedDocument {
  id: string;
  type: 'Transcript';
  title: string;
  sourceUrl: string;
  sourceId: string;
  channelId: string | null;
  channelTitle: string;
  publishedAt: string | null;
  collectedAt: string;
  languageCode: string;
  languageName: string | null;
  subtitleKind: SubtitleKind;
  bodyMarkdown: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  channelTitle: string;
  publishedAt: string | null;
  collectedAt: string;
  languageCode: string;
  subtitleKind: SubtitleKind;
}

export interface SearchQuery {
  query: string;
  offset?: number;
  limit?: number;
  channel?: string;
  publishedFrom?: string;
  publishedTo?: string;
}

export interface SearchHit extends DocumentSummary {
  snippet: string;
}

export interface SearchResponse {
  hits: SearchHit[];
  estimatedTotalHits: number;
}

export interface YouTubeChannel {
  id: string;
  title: string;
  url: string;
  enabled: boolean;
  addedAt: string;
}

export interface AddChannelResult {
  status: 'created' | 'existing';
  channel: YouTubeChannel;
}

export interface ChannelRunResult {
  channelId: string;
  channelTitle: string;
  videoId: string | null;
  videoTitle: string;
  url: string;
  status: 'created' | 'existing' | 'failed';
  error?: {
    code: string;
    message: string;
  };
}

export interface ChannelRun {
  id: string;
  status: 'queued' | 'running' | 'completed';
  channelIds: string[];
  currentChannelId: string | null;
  totalVideos: number;
  processedVideos: number;
  created: number;
  existing: number;
  failed: number;
  results: ChannelRunResult[];
  startedAt: string;
  completedAt: string | null;
}

export type ChannelScheduleStatus = 'paused' | 'scheduled' | 'running' | 'waiting_for_run';

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
  message?: string;
}

export interface TranscriptSearch {
  status(): SearchStatus;
  index(document: SavedDocument): Promise<void>;
  search(query: SearchQuery): Promise<SearchResponse>;
  rebuild(): Promise<void>;
}

export interface CollectResult {
  status: 'created' | 'existing';
  document: SavedDocument;
  searchStatus: SearchStatus;
}

export type CollectorErrorCode =
  | 'invalid_url'
  | 'invalid_channel'
  | 'no_subtitles'
  | 'video_unavailable'
  | 'network_error'
  | 'capture_failed'
  | 'document_not_found'
  | 'search_unavailable'
  | 'channel_not_found'
  | 'channel_run_not_found'
  | 'invalid_request';

export class CollectorError extends Error {
  readonly code: CollectorErrorCode;

  constructor(code: CollectorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CollectorError';
    this.code = code;
  }
}
