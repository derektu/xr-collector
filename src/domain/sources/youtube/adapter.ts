import type { SubscriptionTarget } from '../../../shared/sources/source-contract.js';
import type { YouTubeVideoRef } from './url.js';

export type SubtitleKind = 'manual' | 'automatic';

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

export interface CaptureOptions {
  publishedNotBefore?: string;
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
  publishedAt: string | null;
  upcoming: boolean;
}

export interface ListingPage {
  offset: number;
  limit: number;
}

export interface RequestOptions {
  priority?: 'interactive' | 'background';
  signal?: AbortSignal;
}

export interface YouTubeChannelSource {
  resolve(inputUrl: string, options?: RequestOptions): Promise<ResolvedYouTubeChannel>;
  listVideos(channel: SubscriptionTarget, page: ListingPage, options?: RequestOptions): Promise<DiscoveredYouTubeVideo[]>;
}

export interface YouTubeSource {
  resolveChannel(url: string, options?: RequestOptions): Promise<ResolvedYouTubeChannel>;
  discover(channel: SubscriptionTarget, page: ListingPage, options?: RequestOptions): Promise<DiscoveredYouTubeVideo[]>;
  capture(video: YouTubeVideoRef, options?: CaptureOptions): Promise<CapturedTranscript>;
}

export function youtubeSource(capture: YouTubeCapture, channels: YouTubeChannelSource): YouTubeSource {
  return {
    resolveChannel: (url, options) => channels.resolve(url, options),
    discover: (channel, page, options) => channels.listVideos(channel, page, options),
    capture: (video, options) => capture.capture(video, options),
  };
}
