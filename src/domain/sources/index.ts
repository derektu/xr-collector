/**
 * The sources module as other modules use it: address recognition and the subscription catalog
 * across every source type, and the server entry of each type. The web page takes the types'
 * declarations from `declarations.ts`, which holds no Node code.
 */
export { SourceCatalog } from './source-catalog.js';
export { addressOwner, recognizeUrl, sourceTypeDeclarations, sourceTypeInfo, type SourceTypeDeclaration } from './source-types.js';
export { createRssPlugin, rssDefinition } from './rss/server.js';
export { createYouTubePlugin, youtubeDefinition } from './youtube/server.js';
