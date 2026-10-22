// Builders for the synthetic catalog that server.mts reads (<run>/catalog.json). Everything synthetic
// is titled 【合成】 so screenshots never pass for a real source. Video IDs are 11 characters and
// channel IDs `UC` + 22, the shapes the YouTube plugin's URL recognition accepts.

const DAY = 24 * 60 * 60_000;

/** A channel with `count` videos, newest first, one per day before `now`. */
export function channel(letter, count, label = `頻道 ${letter}`, now = Date.now()) {
  return {
    id: `UCverify${letter.repeat(16)}`,
    handle: `verify-${letter.toLowerCase()}`,
    title: `【合成】${label}`,
    videos: Array.from({ length: count }, (_, index) => ({
      id: `v${letter}${String(index + 1).padStart(9, '0')}`,
      title: `【合成】${label} 第 ${index + 1} 集`,
      publishedAt: new Date(now - (index + 1) * DAY).toISOString(),
    })),
  };
}

/** `count` feed articles, newest first, each with full content. */
export function articles(prefix, count, now = Date.now()) {
  return Array.from({ length: count }, (_, index) => ({
    title: `【合成】${prefix} 第 ${index + 1} 篇`,
    link: `https://example.com/${encodeURIComponent(prefix)}/${index + 1}`,
    guid: `verify-${prefix}-${index + 1}`,
    publishedAt: new Date(now - (index + 1) * DAY).toISOString(),
    content: `<p>【合成文章】${prefix} 第 ${index + 1} 篇的內容。</p><h2>小節</h2><p>用來檢查閱讀頁與搜尋。</p>`,
  }));
}

/**
 * The catalog every synthetic launch starts with: channels A (5 videos) and B (3) to subscribe to,
 * channel D whose videos are collected one at a time, an RSS 2.0 feed, an Atom feed, and a page that
 * announces the RSS feed.
 */
export function defaultCatalog(now = Date.now()) {
  return {
    youtube: {
      channels: [channel('A', 5, '頻道 A', now), channel('B', 3, '頻道 B', now), channel('D', 3, '單支影片頻道 D', now)],
      failListing: null, failVideo: null, rateLimitNext: false, captureDelayMs: 600,
    },
    feeds: {
      '/feed.xml': { kind: 'rss2', title: '【合成】RSS 部落格', articles: articles('RSS 部落格', 4, now) },
      '/atom.xml': { kind: 'atom', title: '【合成】Atom 部落格', articles: articles('Atom 部落格', 3, now) },
      '/blog': { kind: 'page', title: '【合成】部落格首頁', feeds: [{ href: '/feed.xml' }] },
    },
  };
}

export const channelUrl = (source) => `https://www.youtube.com/@${source.handle}`;
export const videoUrl = (video) => `https://www.youtube.com/watch?v=${video.id}`;

/** The addresses a synthetic run answers, for flows and for `launch` output. */
export function syntheticAddresses(catalog, feedsOrigin) {
  return {
    channels: catalog.youtube.channels.map((source) => ({ title: source.title, url: channelUrl(source), videos: source.videos.length })),
    videos: catalog.youtube.channels.flatMap((source) => source.videos.slice(0, 1).map((video) => ({ title: video.title, url: videoUrl(video) }))),
    feeds: Object.entries(catalog.feeds).map(([pathname, route]) => ({ kind: route.kind, title: route.title, url: `${feedsOrigin}${pathname}` })),
  };
}

/** Real sources for `--data real`: a short public video with manual subtitles and a stable feed. */
export const REAL = {
  video: 'https://www.youtube.com/watch?v=iG9CE55wbtY',
  feed: 'https://github.blog/feed/',
};
