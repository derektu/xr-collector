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
  | 'no_subtitles'
  | 'video_unavailable'
  | 'network_error'
  | 'capture_failed'
  | 'document_not_found'
  | 'search_unavailable'
  | 'invalid_request';

export class CollectorError extends Error {
  readonly code: CollectorErrorCode;

  constructor(code: CollectorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CollectorError';
    this.code = code;
  }
}
