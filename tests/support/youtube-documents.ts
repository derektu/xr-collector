import type { CapturedDocument } from '../../src/shared/sources/source-contract.js';
import type { CapturedTranscript } from '../../src/domain/plugins/youtube/adapter.js';
import type { YouTubeDocumentMetadata } from '../../src/domain/plugins/youtube/shared.js';
import type { DocumentKey } from '../../src/shared/documents/document-types.js';

/** The YouTube transcript a captured document carries, for in-memory Vaults that store transcripts. */
export function transcriptOf(document: CapturedDocument): CapturedTranscript {
  const details = document.details as unknown as YouTubeDocumentMetadata;
  return {
    videoId: document.key,
    sourceUrl: document.sourceUrl,
    title: document.title,
    channelId: document.publisher.id,
    channelTitle: document.publisher.name,
    publishedAt: document.publishedAt,
    languageCode: details.languageCode,
    languageName: details.languageName,
    subtitleKind: details.subtitleKind,
    bodyMarkdown: document.bodyMarkdown,
  };
}

/** The document key of a YouTube video. */
export function youtubeKey(videoId: string): DocumentKey {
  return { sourceType: 'youtube', sourceId: videoId };
}
