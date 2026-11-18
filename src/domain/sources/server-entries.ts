/** The server entry of each source type: only the product's source list (`src/app/plugins/index.ts`) imports it. */
export { createRssPlugin, rssDefinition } from './rss/server.js';
export { createYouTubePlugin, youtubeDefinition } from './youtube/server.js';
