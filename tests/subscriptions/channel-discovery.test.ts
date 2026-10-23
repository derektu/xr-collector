import { describe, expect, it } from 'vitest';
import type { SubscriptionRecord } from '../../src/core/types.js';
import { SyntheticYouTube } from './synthetic-youtube.js';
import { discoverChannelVideos, type DiscoveryRange } from '../support/youtube-discovery.js';

const NOW = new Date('2026-10-15T04:00:00.000Z');
const DAY = 24 * 60 * 60_000;

function setup() {
  const source = new SyntheticYouTube();
  const id = source.addChannel('discovery');
  const channel: SubscriptionRecord = {
    id, title: '合成頻道', url: `https://www.youtube.com/channel/${id}/videos`, enabled: true, addedAt: NOW.toISOString(),
    settings: { intervalMinutes: 30, backfillDays: 30, backfillMaxItems: 10 },
  };
  return { source, id, channel };
}

function range(windowDays: number, maxItems: number): DiscoveryRange {
  return { windowStart: new Date(NOW.getTime() - windowDays * DAY), maxItems };
}

const nothingKnown = async () => false;

describe('channel discovery', () => {
  it('collects the newest videos in range, never replacing known ones with older videos (R-01, R-08)', async () => {
    const { source, id, channel } = setup();
    const ids = source.publish(id, 'a', NOW, Array.from({ length: 120 }, (_, index) => 1 + index * 0.2));
    source.channels.get(id)!.videos.unshift({ id: 'premiere000', publishedAt: new Date(NOW.getTime() + DAY).toISOString(), upcoming: true });
    const known = new Set([ids[0], ids[2]]);

    const result = await discoverChannelVideos(source, channel, range(30, 10), async (videoId) => known.has(videoId));
    // The upcoming stream takes no place; the two known candidates are dropped, not replaced.
    expect(result.videos.map((video) => video.id)).toEqual([ids[1], ...ids.slice(3, 10)]);
    expect(result.publishedNotBefore).toBe(range(30, 10).windowStart.toISOString());
    // Ten candidates fit in the first page, so the listing is read once.
    expect(source.listingRequests).toHaveLength(1);

    const allKnown = await discoverChannelVideos(source, channel, range(30, 10), async () => true);
    expect(allKnown.videos).toEqual([]);
  });

  it('stops at the first video before the range start, also when the range holds fewer videos than the limit', async () => {
    const { source, id, channel } = setup();
    const ids = source.publish(id, 'a', NOW, [1, 2, 3, 8, 9, 40]);
    const result = await discoverChannelVideos(source, channel, range(7, 50), nothingKnown);
    expect(result.videos.map((video) => video.id)).toEqual(ids.slice(0, 3));
  });

  it('takes only the newest limit when more new videos than the limit were published (R-03)', async () => {
    const { source, id, channel } = setup();
    const older = source.publish(id, 'a', NOW, [10, 11, 12]);
    const fresh = source.publish(id, 'b', NOW, Array.from({ length: 15 }, (_, index) => 0.1 + index * 0.1));
    const known = new Set(older);
    const result = await discoverChannelVideos(source, channel, range(30, 10), async (videoId) => known.has(videoId));
    expect(result.videos.map((video) => video.id)).toEqual(fresh.slice(0, 10));
  });

  it('counts a listed video without a publish time as inside the range and lets the capture confirm it (R-08)', async () => {
    const { source, id, channel } = setup();
    const ids = source.publish(id, 'a', NOW, [1, 2, 31]);
    // The listing shows no time for the newest video and a rounded time inside the range for the oldest.
    source.channels.get(id)!.videos[0]!.listedAt = null;
    source.channels.get(id)!.videos[2]!.listedAt = new Date(NOW.getTime() - 29 * DAY).toISOString();
    const result = await discoverChannelVideos(source, channel, range(30, 10), nothingKnown);
    expect(result.videos.map((video) => video.id)).toEqual(ids);
    await expect(source.capture(
      { videoId: ids[2]!, canonicalUrl: `https://www.youtube.com/watch?v=${ids[2]}` },
      { publishedNotBefore: result.publishedNotBefore },
    )).rejects.toMatchObject({ code: 'out_of_range' });
  });

  it('reads further pages while upcoming streams fill them, up to the scan limit', async () => {
    const { source, id, channel } = setup();
    const ids = source.publish(id, 'a', NOW, [1, 2]);
    const upcoming = Array.from({ length: 60 }, (_, index) => ({
      id: `up${String(index).padStart(9, '0')}`, publishedAt: new Date(NOW.getTime() + DAY).toISOString(), upcoming: true,
    }));
    source.channels.get(id)!.videos.unshift(...upcoming);
    const result = await discoverChannelVideos(source, channel, range(30, 10), nothingKnown);
    expect(result.videos.map((video) => video.id)).toEqual(ids);
    expect(source.listingRequests.map((request) => request.offset)).toEqual([0, 50]);
  });
});
