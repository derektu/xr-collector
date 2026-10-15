import { describe, expect, it } from 'vitest';
import { discoverChannelVideos, INCREMENTAL_BATCH } from '../../src/channels/channel-discovery.js';
import type { ChannelJobScope, YouTubeChannel } from '../../src/core/types.js';
import { SyntheticYouTube } from './synthetic-youtube.js';

const NOW = new Date('2026-10-15T04:00:00.000Z');
const DAY = 24 * 60 * 60_000;

function setup() {
  const source = new SyntheticYouTube();
  const id = source.addChannel('discovery');
  const channel: YouTubeChannel = { id, title: '合成頻道', url: `https://www.youtube.com/channel/${id}/videos`, enabled: true, addedAt: NOW.toISOString() };
  return { source, id, channel };
}

function backfill(windowDays: number, maxItems: number): ChannelJobScope {
  return { trigger: 'subscribe', mode: 'backfill', windowStart: new Date(NOW.getTime() - windowDays * DAY).toISOString(), maxItems, cursor: null };
}

const nothingCollected = async () => false;

describe('channel discovery', () => {
  it('backfills the newest uncollected videos in range, skipping premieres, and stops reading at the range start', async () => {
    const { source, id, channel } = setup();
    const ids = source.publish(id, 'a', NOW, Array.from({ length: 120 }, (_, index) => 1 + index));
    source.channels.get(id)!.videos.unshift({ id: 'premiere000', publishedAt: new Date(NOW.getTime() + DAY).toISOString(), upcoming: true });
    const collected = new Set([ids[0], ids[2]]);

    const result = await discoverChannelVideos(source, channel, backfill(30, 10), async (videoId) => collected.has(videoId));
    expect(result.mode).toBe('backfill');
    expect(result.videos.map((video) => video.id)).toEqual([ids[1], ...ids.slice(3, 12)]);
    expect(result.cursor).toMatchObject({ videoId: ids[0] });
    expect(result.cursor!.recentIds).not.toContain('premiere000');

    source.listingRequests.length = 0;
    const narrow = await discoverChannelVideos(source, channel, backfill(7, 50), async (videoId) => collected.has(videoId));
    expect(narrow.videos.map((video) => video.id)).toEqual([ids[1], ...ids.slice(3, 7)]);
    // Videos are newest first, so the first one before the range ends the scan after one page.
    expect(source.listingRequests).toHaveLength(1);
  });

  it('takes every video newer than the cursor, oldest batch first, and keeps the rest for a follow-up', async () => {
    const { source, id, channel } = setup();
    source.publish(id, 'old', NOW, [10, 11, 12]);
    const first = await discoverChannelVideos(source, channel, backfill(30, 10), nothingCollected);
    const fresh = source.publish(id, 'new', NOW, Array.from({ length: 70 }, (_, index) => index / 100));

    const scope: ChannelJobScope = { ...backfill(7, 5), trigger: 'scheduled', mode: 'incremental', cursor: first.cursor };
    const batch = await discoverChannelVideos(source, channel, scope, nothingCollected);
    expect(batch).toMatchObject({ mode: 'incremental', backlog: true, publishedNotBefore: null });
    expect(batch.videos.map((video) => video.id)).toEqual(fresh.slice(-INCREMENTAL_BATCH));
    expect(batch.cursor!.videoId).toBe(fresh[fresh.length - INCREMENTAL_BATCH]);

    const rest = await discoverChannelVideos(source, channel, { ...scope, cursor: batch.cursor }, nothingCollected);
    expect(rest.backlog).toBe(false);
    expect(rest.videos.map((video) => video.id)).toEqual(fresh.slice(0, fresh.length - INCREMENTAL_BATCH));
    expect(rest.cursor!.videoId).toBe(fresh[0]);
  });

  it('stops at the cursor time when the cursor videos were deleted', async () => {
    const { source, id, channel } = setup();
    source.publish(id, 'old', NOW, [20, 21, 22, 23]);
    const scope: ChannelJobScope = {
      ...backfill(30, 10), trigger: 'scheduled', mode: 'incremental',
      cursor: { videoId: 'deleted0000', publishedAt: new Date(NOW.getTime() - 5 * DAY).toISOString(), recentIds: ['deleted0000', 'deleted0001'] },
    };
    const fresh = source.publish(id, 'new', NOW, [1, 2]);
    const result = await discoverChannelVideos(source, channel, scope, nothingCollected);
    expect(result.mode).toBe('incremental');
    expect(result.videos.map((video) => video.id)).toEqual(fresh);
  });

  it('falls back to backfill when the cursor is not found within the scan limit', async () => {
    const { source, id, channel } = setup();
    // 600 videos all newer than the cursor, e.g. a channel that uploaded in bulk while the service was off.
    const listed = source.publish(id, 'bulk', NOW, Array.from({ length: 600 }, (_, index) => index / 1000));
    const scope: ChannelJobScope = {
      ...backfill(30, 10), trigger: 'scheduled', mode: 'incremental',
      cursor: { videoId: 'gone0000000', publishedAt: new Date(NOW.getTime() - 3 * DAY).toISOString(), recentIds: [] },
    };
    const result = await discoverChannelVideos(source, channel, scope, nothingCollected);
    expect(result.mode).toBe('backfill');
    expect(result.videos.map((video) => video.id)).toEqual(listed.slice(0, 10));
    expect(result.publishedNotBefore).toBe(scope.windowStart);
  });
});
