import type { CapturedTranscript, YouTubeChannel, YouTubeVideoRef } from '../../core/types.js';

export interface CaptureOptions {
  /** Skip, before downloading subtitles, a video published earlier than this time (error `out_of_range`). */
  publishedNotBefore?: string;
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

export interface YouTubeChannelSource {
  resolve(inputUrl: string): Promise<ResolvedYouTubeChannel>;
  listVideos(channel: YouTubeChannel, page: ListingPage): Promise<DiscoveredYouTubeVideo[]>;
}

/** Every YouTube network operation a collection job performs. Jobs and saving never call yt-dlp directly. */
export interface YouTubeSource {
  resolveChannel(url: string): Promise<ResolvedYouTubeChannel>;
  discover(channel: YouTubeChannel, page: ListingPage): Promise<DiscoveredYouTubeVideo[]>;
  capture(video: YouTubeVideoRef, options?: CaptureOptions): Promise<CapturedTranscript>;
}

export function youtubeSource(capture: YouTubeCapture, channels: YouTubeChannelSource): YouTubeSource {
  return {
    resolveChannel: (url) => channels.resolve(url),
    discover: (channel, page) => channels.listVideos(channel, page),
    capture: (video, options) => capture.capture(video, options),
  };
}
