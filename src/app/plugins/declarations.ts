import type { SourcePluginDeclaration } from '../../shared/sources/source-contract.js';
import { rssDeclaration, youtubeDeclaration } from '../../domain/sources/declarations.js';

/** The source types this product offers, in display order. */
export const SOURCE_DECLARATIONS: readonly SourcePluginDeclaration[] = [
  youtubeDeclaration as SourcePluginDeclaration,
  rssDeclaration as SourcePluginDeclaration,
];
