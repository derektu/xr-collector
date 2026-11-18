import type { SourcePluginDeclaration } from '../../shared/sources/source-contract.js';
import { rssDeclaration, youtubeDeclaration } from '../../domain/sources/declarations.js';

/**
 * The source types this product offers, in display order. The server assembly (`src/app/plugins/index.ts`)
 * and the web UI (`src/transport/web/plugins.tsx`) both take their types and order from this list; the module
 * holds no Node-only code, so the web build shares it. Adding a type means adding its declaration
 * here, its server entry to `src/app/plugins/index.ts`, its icon to `src/transport/web/plugins.tsx` and its badge
 * colors to `src/transport/web/plugins.css`.
 *
 * An address belongs to the first type that owns it, so RSS, which owns every web address, comes last.
 */
export const SOURCE_DECLARATIONS: readonly SourcePluginDeclaration[] = [
  youtubeDeclaration as SourcePluginDeclaration,
  rssDeclaration as SourcePluginDeclaration,
];
