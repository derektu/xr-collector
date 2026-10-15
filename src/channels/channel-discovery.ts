import type { ChannelCursor, ChannelJobScope, YouTubeChannel } from '../core/types.js';
import type { DiscoveredYouTubeVideo, YouTubeSource } from '../sources/youtube/adapter.js';
import { publishedInstant, publishedSince } from './collection-policy.js';

/** Videos read per listing request. */
export const LISTING_PAGE = 50;
/** Backfill reads at most this many listed videos looking for uncollected ones in range. */
export const BACKFILL_SCAN_LIMIT = 200;
/** Incremental discovery that reads this many videos without reaching the cursor falls back to backfill. */
export const INCREMENTAL_SCAN_LIMIT = 500;
/** Videos one incremental job accepts; the rest wait for a follow-up batch. */
export const INCREMENTAL_BATCH = 50;
const RECENT_ID_LIMIT = 200;
/** Listing times are rounded relative ages, so the cursor's time only ends discovery past this margin. */
const CURSOR_TIME_MARGIN_MS = 2 * 24 * 60 * 60_000;

export interface DiscoveryResult {
  /** The mode that ran; incremental falls back to backfill when it cannot find its cursor. */
  mode: ChannelJobScope['mode'];
  /** Videos to collect, newest first. */
  videos: DiscoveredYouTubeVideo[];
  /** Earliest publish time a backfill video may have; null for incremental videos. */
  publishedNotBefore: string | null;
  /** The cursor after this job's videos are accepted; null keeps the previous one. */
  cursor: ChannelCursor | null;
  /** Newer videos remain for a follow-up batch. */
  backlog: boolean;
}

type ListingSource = Pick<YouTubeSource, 'discover'>;

/**
 * Decides which videos one channel job collects, following the scope it accepted. The cursor it
 * returns covers only the accepted videos, so anything newer is found again by a later job.
 */
export async function discoverChannelVideos(
  source: ListingSource,
  channel: YouTubeChannel,
  scope: ChannelJobScope,
  isCollected: (videoId: string) => Promise<boolean>,
): Promise<DiscoveryResult> {
  if (scope.mode === 'incremental' && scope.cursor) {
    const incremental = await discoverIncremental(source, channel, scope.cursor, isCollected);
    if (incremental) return incremental;
  }
  return discoverBackfill(source, channel, scope, isCollected);
}

async function discoverBackfill(
  source: ListingSource,
  channel: YouTubeChannel,
  scope: ChannelJobScope,
  isCollected: (videoId: string) => Promise<boolean>,
): Promise<DiscoveryResult> {
  const picked: DiscoveredYouTubeVideo[] = [];
  let newest: DiscoveredYouTubeVideo[] = [];
  scan: for (let offset = 0; offset < BACKFILL_SCAN_LIMIT; offset += LISTING_PAGE) {
    const page = await source.discover(channel, { offset, limit: LISTING_PAGE });
    if (offset === 0) newest = page.filter((video) => !video.upcoming);
    for (const video of page) {
      if (video.upcoming) continue;
      // The listing is newest first, so the first video before the range ends the scan.
      if (!publishedSince(video.publishedAt, scope.windowStart)) break scan;
      if (await isCollected(video.id)) continue;
      picked.push(video);
      if (picked.length >= scope.maxItems) break scan;
    }
    if (page.length < LISTING_PAGE) break;
  }
  const top = newest[0];
  return {
    mode: 'backfill',
    videos: picked,
    publishedNotBefore: scope.windowStart,
    // Backfill deliberately leaves older videos behind: tracking continues from the newest listed one.
    cursor: top ? {
      videoId: top.id,
      publishedAt: top.publishedAt,
      recentIds: newest.map((video) => video.id).slice(0, RECENT_ID_LIMIT),
    } : null,
    backlog: false,
  };
}

/** Returns null when the cursor is not found within the scan limit. */
async function discoverIncremental(
  source: ListingSource,
  channel: YouTubeChannel,
  cursor: ChannelCursor,
  isCollected: (videoId: string) => Promise<boolean>,
): Promise<DiscoveryResult | null> {
  const known = new Set([cursor.videoId, ...cursor.recentIds]);
  const cursorTime = publishedInstant(cursor.publishedAt);
  const fresh: DiscoveredYouTubeVideo[] = [];
  let reached = false;
  scan: for (let offset = 0; offset < INCREMENTAL_SCAN_LIMIT; offset += LISTING_PAGE) {
    const page = await source.discover(channel, { offset, limit: LISTING_PAGE });
    for (const video of page) {
      if (video.upcoming) continue;
      const time = publishedInstant(video.publishedAt);
      if (known.has(video.id) || (cursorTime !== null && time !== null && time < cursorTime - CURSOR_TIME_MARGIN_MS)) {
        reached = true;
        break scan;
      }
      fresh.push(video);
    }
    if (page.length < LISTING_PAGE) {
      reached = true;
      break;
    }
  }
  if (!reached) return null;
  // The oldest new videos go first, so the cursor only ever moves past accepted ones.
  const batch = fresh.slice(-INCREMENTAL_BATCH);
  const top = batch[0];
  const videos: DiscoveredYouTubeVideo[] = [];
  for (const video of batch) if (!(await isCollected(video.id))) videos.push(video);
  return {
    mode: 'incremental',
    videos,
    publishedNotBefore: null,
    cursor: top ? {
      videoId: top.id,
      publishedAt: top.publishedAt,
      recentIds: [...batch.map((video) => video.id), ...cursor.recentIds].slice(0, RECENT_ID_LIMIT),
    } : null,
    backlog: fresh.length > batch.length,
  };
}
