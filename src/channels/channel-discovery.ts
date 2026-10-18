import type { YouTubeChannel } from '../core/types.js';
import type { DiscoveredYouTubeVideo, YouTubeSource } from '../sources/youtube/adapter.js';
import { publishedSince } from './collection-policy.js';

/** Videos read per listing request. */
export const LISTING_PAGE = 50;
/** Listed videos one check reads at most, so a listing full of upcoming streams still ends. */
export const LISTING_SCAN_LIMIT = 200;

/** The range one check collects. */
export interface DiscoveryRange {
  /** Videos published before this time are outside the range. */
  windowStart: Date;
  /** The newest videos within the range that are candidates. */
  maxItems: number;
}

export interface DiscoveryResult {
  /** Videos to collect, newest first. */
  videos: DiscoveredYouTubeVideo[];
  /** The start of the range; a capture skips a video whose exact publish time is earlier. */
  publishedNotBefore: string;
}

type ListingSource = Pick<YouTubeSource, 'discover'>;

/**
 * Decides which videos one check of a channel collects. The candidates are the newest `maxItems`
 * listed videos published since `windowStart`, upcoming streams left out; of them, the ones
 * `isKnown` reports (collected or deleted) are dropped and the rest collected. A dropped candidate
 * is never replaced by an older video, so a check collects nothing older than the newest
 * `maxItems` videos of its range.
 *
 * Listing publish times are approximate. A video without one counts as inside the range, and the
 * capture confirms the exact time against `publishedNotBefore`.
 */
export async function discoverChannelVideos(
  source: ListingSource,
  channel: YouTubeChannel,
  range: DiscoveryRange,
  isKnown: (videoId: string) => Promise<boolean>,
): Promise<DiscoveryResult> {
  const candidates: DiscoveredYouTubeVideo[] = [];
  scan: for (let offset = 0; offset < LISTING_SCAN_LIMIT && candidates.length < range.maxItems; offset += LISTING_PAGE) {
    const page = await source.discover(channel, { offset, limit: LISTING_PAGE });
    for (const video of page) {
      if (video.upcoming) continue;
      // The listing is newest first, so the first video before the range ends the scan.
      if (!publishedSince(video.publishedAt, range.windowStart)) break scan;
      candidates.push(video);
      if (candidates.length >= range.maxItems) break scan;
    }
    if (page.length < LISTING_PAGE) break;
  }
  const videos: DiscoveredYouTubeVideo[] = [];
  for (const video of candidates) if (!(await isKnown(video.id))) videos.push(video);
  return { videos, publishedNotBefore: range.windowStart.toISOString() };
}
