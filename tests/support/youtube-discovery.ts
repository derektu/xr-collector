import type { SubscriptionTarget } from '../../src/plugins/types.js';
import type { DiscoveredYouTubeVideo, RequestOptions, YouTubeSource } from '../../src/plugins/youtube/adapter.js';
import { channelItems } from '../../src/plugins/youtube/server.js';
import { selectCandidates } from '../../src/subscriptions/candidates.js';

/** The range one check collects, in the terms of a YouTube channel. */
export interface DiscoveryRange {
  /** Videos published before this time are outside the range. */
  windowStart: Date;
  /** The newest videos within the range that are candidates. */
  maxItems: number;
}

/**
 * One check's selection over a channel's listing, as the core makes it for the YouTube plugin: the
 * candidates, the videos to collect and the range start a capture confirms. See `selectCandidates`.
 */
export async function discoverChannelVideos(
  source: Pick<YouTubeSource, 'discover'>,
  channel: SubscriptionTarget,
  range: DiscoveryRange,
  isKnown: (videoId: string) => Promise<boolean>,
  request: RequestOptions = {},
): Promise<{ candidates: string[]; videos: DiscoveredYouTubeVideo[]; publishedNotBefore: string }> {
  const selection = await selectCandidates(
    channelItems(source, channel, request), { since: range.windowStart, maxItems: range.maxItems }, isKnown,
  );
  return {
    candidates: selection.candidates,
    videos: selection.items.map((item) => ({ id: item.key, title: item.title ?? '', url: item.url, publishedAt: item.publishedAt, upcoming: !item.eligible })),
    publishedNotBefore: selection.publishedNotBefore,
  };
}
