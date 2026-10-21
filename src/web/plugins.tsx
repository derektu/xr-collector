import { registerSourceDeclarations } from '../core/source-registry.js';
import type { SourcePluginDeclaration } from '../plugins/types.js';
import { youtubeDeclaration } from '../plugins/youtube/shared.js';
import { registerIcons } from './icons.js';
import './plugins.css';

/**
 * The source types the UI offers, in display order: the web counterpart of `src/plugins/index.ts`.
 * The UI reads every type-specific word, settings sentence and document detail from these
 * declarations; adding a type means adding its declaration and its icon here, and its badge colors
 * to `plugins.css`.
 */
export const WEB_SOURCE_DECLARATIONS: readonly SourcePluginDeclaration[] = [youtubeDeclaration as SourcePluginDeclaration];

registerSourceDeclarations(WEB_SOURCE_DECLARATIONS);
registerIcons({
  youtube: <><rect x="2.5" y="5" width="19" height="14" rx="4" /><path d="M10 9l5 3-5 3z" /></>,
});
