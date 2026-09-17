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

export type CollectResult =
  | { status: 'created'; document: SavedDocument }
  | { status: 'existing'; document: SavedDocument };

export type CollectorErrorCode =
  | 'invalid_url'
  | 'no_subtitles'
  | 'video_unavailable'
  | 'network_error'
  | 'capture_failed'
  | 'document_not_found'
  | 'invalid_request';

export class CollectorError extends Error {
  readonly code: CollectorErrorCode;

  constructor(code: CollectorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CollectorError';
    this.code = code;
  }
}
