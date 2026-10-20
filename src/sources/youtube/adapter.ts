import type { CapturedTranscript, YouTubeChannel, YouTubeVideoRef } from '../../core/types.js';

export interface CaptureOptions {
  /** Skip, before downloading subtitles, a video published earlier than this time (error `out_of_range`). */
  publishedNotBefore?: string;
  /** Aborting it before a YouTube request starts leaves that request out; a running request finishes. */
  signal?: AbortSignal;
}

export interface YouTubeCapture {
  capture(video: YouTubeVideoRef, options?: CaptureOptions): Promise<CapturedTranscript>;
}

export interface ResolvedYouTubeChannel {
  id: string;
  title: string;
  url: string;
}

export interface DiscoveredYouTubeVideo {
  id: string;
  title: string;
  url: string;
  /** Approximate publish time derived from the listing's relative age; null when unavailable. */
  publishedAt: string | null;
  /** A scheduled premiere or a stream that is live now; neither has a transcript yet. */
  upcoming: boolean;
}

/** A slice of a channel's video listing, newest first. */
export interface ListingPage {
  offset: number;
  limit: number;
}

/**
 * `interactive` marks a request the user is waiting for, such as a channel preview; it goes before
 * queued background work and fails at once during a YouTube cooldown.
 */
export interface RequestOptions {
  priority?: 'interactive' | 'background';
  signal?: AbortSignal;
}

export interface YouTubeChannelSource {
  resolve(inputUrl: string, options?: RequestOptions): Promise<ResolvedYouTubeChannel>;
  listVideos(channel: YouTubeChannel, page: ListingPage, options?: RequestOptions): Promise<DiscoveredYouTubeVideo[]>;
}

/** Every YouTube network operation a collection job performs. Jobs and saving never call yt-dlp directly. */
export interface YouTubeSource {
  resolveChannel(url: string, options?: RequestOptions): Promise<ResolvedYouTubeChannel>;
  discover(channel: YouTubeChannel, page: ListingPage, options?: RequestOptions): Promise<DiscoveredYouTubeVideo[]>;
  capture(video: YouTubeVideoRef, options?: CaptureOptions): Promise<CapturedTranscript>;
}

export function youtubeSource(capture: YouTubeCapture, channels: YouTubeChannelSource): YouTubeSource {
  return {
    resolveChannel: (url, options) => channels.resolve(url, options),
    discover: (channel, page, options) => channels.listVideos(channel, page, options),
    capture: (video, options) => capture.capture(video, options),
  };
}
