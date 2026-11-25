import { describe, expect, it, vi } from 'vitest';
import { LISTING_PAGE, youtubePlugin } from '../../../../src/domain/sources/youtube/server.js';
import type { DiscoveredYouTubeVideo, ListingPage } from '../../../../src/domain/sources/youtube/adapter.js';

const channel = { id: 'UCabcdefghijklmnopqrstuv', title: '頻道', url: 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv' };

describe('the listing a check reads', () => {
  it('keeps the platform order across pages, newest first, so a check stopping at the first video before its range misses none', async () => {
    const start = Date.UTC(2026, 9, 1);
    const videos: DiscoveredYouTubeVideo[] = Array.from({ length: LISTING_PAGE + 7 }, (_, index) => ({
      id: `video-${String(index).padStart(3, '0')}`, title: `第 ${index} 支`, url: `https://www.youtube.com/watch?v=${index}`,
      publishedAt: new Date(start - index * 86_400_000).toISOString(), upcoming: false,
    }));
    const discover = vi.fn(async (_target: unknown, page: ListingPage) => videos.slice(page.offset, page.offset + page.limit));
    const source = youtubePlugin({ capture: vi.fn(), resolveChannel: vi.fn(), discover });
    const keys: string[] = [];
    for await (const item of source.listSubscriptionItems!(channel, {})) keys.push(item.key);
    expect(keys).toEqual(videos.map((video) => video.id));
    expect(discover).toHaveBeenCalledTimes(2);
  });
});
