import { registerSourceDeclarations } from '../core/source-registry.js';
import type { SourcePluginDeclaration } from '../plugins/types.js';
import { rssDeclaration } from '../plugins/rss/shared.js';
import { youtubeDeclaration } from '../plugins/youtube/shared.js';
import { registerIcons } from './icons.js';
import './plugins.css';

/**
 * The source types the UI offers, in display order: the web counterpart of `src/plugins/index.ts`.
 * The UI reads every type-specific word, settings sentence and document detail from these
 * declarations; adding a type means adding its declaration and its icon here, and its badge colors
 * to `plugins.css`.
 */
export const WEB_SOURCE_DECLARATIONS: readonly SourcePluginDeclaration[] = [
  youtubeDeclaration as SourcePluginDeclaration,
  rssDeclaration as SourcePluginDeclaration,
];

registerSourceDeclarations(WEB_SOURCE_DECLARATIONS);
registerIcons({
  youtube: <><rect x="2.5" y="5" width="19" height="14" rx="4" /><path d="M10 9l5 3-5 3z" /></>,
  rss: <><path d="M5 11a8 8 0 0 1 8 8" /><path d="M5 5a14 14 0 0 1 14 14" /><circle cx="6" cy="18" r="1.2" /></>,
});
