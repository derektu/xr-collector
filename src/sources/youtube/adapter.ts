import type { CapturedTranscript, YouTubeChannel, YouTubeVideoRef } from '../../core/types.js';

export interface YouTubeCapture {
  capture(video: YouTubeVideoRef): Promise<CapturedTranscript>;
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
}

export interface YouTubeChannelSource {
  resolve(inputUrl: string): Promise<ResolvedYouTubeChannel>;
  listVideos(channel: YouTubeChannel, limit: number): Promise<DiscoveredYouTubeVideo[]>;
}

/** Every YouTube network operation a collection job performs. Jobs and saving never call yt-dlp directly. */
export interface YouTubeSource {
  resolveChannel(url: string): Promise<ResolvedYouTubeChannel>;
  discover(channel: YouTubeChannel, limit: number): Promise<DiscoveredYouTubeVideo[]>;
  capture(video: YouTubeVideoRef): Promise<CapturedTranscript>;
}

export function youtubeSource(capture: YouTubeCapture, channels: YouTubeChannelSource): YouTubeSource {
  return {
    resolveChannel: (url) => channels.resolve(url),
    discover: (channel, limit) => channels.listVideos(channel, limit),
    capture: (video) => capture.capture(video),
  };
}
