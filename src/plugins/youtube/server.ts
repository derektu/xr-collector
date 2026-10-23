import type {
  CapturedDocument,
  CapturedItem,
  FailureClass,
  ListedItem,
  PluginRuntime,
  RequestContext,
  SourceDefinition,
  SourcePlugin,
  SubscriptionTarget,
} from '../types.js';
import { youtubeSource, type CapturedTranscript, type DiscoveredYouTubeVideo, type RequestOptions, type YouTubeSource } from './adapter.js';
import type { CollectionPolicy } from './settings.js';
import { youtubeDeclaration, type YouTubeDocumentMetadata } from './shared.js';
import { YtDlpCapture } from './ytdlp-capture.js';
import { YtDlpChannelSource } from './ytdlp-channel-source.js';

/** Videos read per listing request. */
export const LISTING_PAGE = 50;
/** Listed videos one check reads at most, so a listing full of upcoming streams still ends. */
export const LISTING_SCAN_LIMIT = 200;

const FAILURES: Readonly<Record<string, FailureClass>> = {
  network_error: 'retry_now',
  rate_limited: 'rate_limited',
  no_subtitles: 'retry_next_check',
  capture_failed: 'retry_next_check',
  video_unavailable: 'skip',
};

interface StoredSubtitle {
  language_code: string;
  language_name?: string;
  kind: YouTubeDocumentMetadata['subtitleKind'];
}

/**
 * The server definition of YouTube: the declaration, how its failures are treated, the request
 * pacing every YouTube request shares, where its subscriptions live and the subtitle block of its
 * documents' frontmatter.
 */
export const youtubeDefinition: SourceDefinition<CollectionPolicy> = {
  ...youtubeDeclaration,
  classifyFailure: (error) => FAILURES[error.code] ?? 'skip',
  pacing: {
    group: 'youtube',
    label: 'YouTube',
    waitRangeMs: { min: 4_000, max: 12_000 },
    envVar: 'XR_COLLECTOR_YOUTUBE_WAIT_MS',
  },
  storage: {
    subscriptionsFile: 'settings/youtube-channels.json',
    version: 3,
    listKey: 'channels',
    outOfRangeKeyField: 'videoId',
    description: 'YouTube channel',
  },
  vaultFormatVersion: 1,
  packageFormatVersion: 1,
  errorStatus: { no_subtitles: 422, video_unavailable: 422 },
  frontmatter: {
    write(details) {
      const youtube = details as unknown as YouTubeDocumentMetadata;
      const subtitle: StoredSubtitle = { language_code: youtube.languageCode, kind: youtube.subtitleKind };
      if (youtube.languageName) subtitle.language_name = youtube.languageName;
      return { subtitle };
    },
    read(collector) {
      const subtitle = collector.subtitle as StoredSubtitle;
      const details: YouTubeDocumentMetadata = {
        languageCode: subtitle.language_code,
        languageName: subtitle.language_name ?? null,
        subtitleKind: subtitle.kind,
      };
      return details as unknown as Record<string, unknown>;
    },
  },
};

/** The pacing group every YouTube request goes through. */
export const YOUTUBE_PACING = youtubeDefinition.pacing!;

/** A captured transcript as the item the core saves. */
export function transcriptItem(transcript: CapturedTranscript): CapturedItem {
  const details: YouTubeDocumentMetadata = {
    languageCode: transcript.languageCode,
    languageName: transcript.languageName,
    subtitleKind: transcript.subtitleKind,
  };
  return {
    key: transcript.videoId,
    sourceUrl: transcript.sourceUrl,
    title: transcript.title,
    publisher: { id: transcript.channelId, name: transcript.channelTitle },
    publishedAt: transcript.publishedAt,
    bodyMarkdown: transcript.bodyMarkdown,
    details: details as unknown as Record<string, unknown>,
  };
}

/** A captured transcript as a YouTube document to save. */
export function transcriptDocument(transcript: CapturedTranscript): CapturedDocument {
  return { sourceType: youtubeDefinition.id, ...transcriptItem(transcript) };
}

function listedItem(video: DiscoveredYouTubeVideo): ListedItem {
  return { key: video.id, url: video.url, title: video.title, publishedAt: video.publishedAt, eligible: !video.upcoming };
}

/**
 * A channel's videos, newest first, read a page at a time and at most `LISTING_SCAN_LIMIT` of them.
 * Pages are requested only as the reader asks for more items.
 */
export async function* listChannelVideos(source: Pick<YouTubeSource, 'discover'>, channel: SubscriptionTarget, request: RequestOptions = {}): AsyncGenerator<DiscoveredYouTubeVideo> {
  for (let offset = 0; offset < LISTING_SCAN_LIMIT; offset += LISTING_PAGE) {
    const page = await source.discover(channel, { offset, limit: LISTING_PAGE }, request);
    yield* page;
    if (page.length < LISTING_PAGE) return;
  }
}

/** A channel's listing as the items the core selects from, newest first. */
export async function* channelItems(source: Pick<YouTubeSource, 'discover'>, channel: SubscriptionTarget, request: RequestOptions = {}): AsyncGenerator<ListedItem> {
  for await (const video of listChannelVideos(source, channel, request)) yield listedItem(video);
}

/**
 * The YouTube plugin over a source of YouTube requests. Every request the plugin makes passes the
 * request context on unchanged, so its abort signal and priority reach the YouTube request channel.
 */
export function youtubePlugin(source: YouTubeSource): SourcePlugin<CollectionPolicy> {
  return {
    ...youtubeDefinition,
    async captureItem(ref, context: RequestContext) {
      return transcriptItem(await source.capture({ videoId: ref.key, canonicalUrl: ref.url }, context));
    },
    resolveTarget: (url, context) => source.resolveChannel(url, context),
    listSubscriptionItems: (target, context) => channelItems(source, target, context),
  };
}

/** The YouTube plugin of the product: yt-dlp, with Deno for YouTube's scripts, behind the `youtube` request channel. */
export function createYouTubePlugin(runtime: PluginRuntime): SourcePlugin<CollectionPolicy> {
  const ytdlp = {
    // The official folder build: the executable beside its `_internal` libraries.
    binaryPath: runtime.program('yt-dlp/yt-dlp', 'XR_COLLECTOR_YTDLP'),
    javaScriptRuntimePath: runtime.program('deno', 'XR_COLLECTOR_DENO'),
    gate: runtime.gate(YOUTUBE_PACING.group),
  };
  return youtubePlugin(youtubeSource(new YtDlpCapture(ytdlp), new YtDlpChannelSource(ytdlp)));
}
