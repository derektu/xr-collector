import type { ReactNode } from 'react';
import { SourceDeclarations } from '../core/source-registry.js';
import { SOURCE_DECLARATIONS } from '../plugins/declarations.js';
import { registerIcons } from './icons.js';
import './plugins.css';

/**
 * The web assembly of the source types: the UI reads every type-specific word, settings sentence and
 * document detail from the product's declarations (`src/plugins/declarations.ts`), which `main.tsx`
 * provides to the components as `PRODUCT_SOURCES` (`source-declarations.tsx`), and draws each type with its icon
 * here and its badge colors from `plugins.css`. Every declared type has both
 * (tests/plugins/source-list.test.ts).
 */

/** The product's source types, as the components read them. */
export const PRODUCT_SOURCES = new SourceDeclarations(SOURCE_DECLARATIONS);

/** The icon of each source type, by the declaration's `icon` key. */
export const SOURCE_ICONS: Readonly<Record<string, ReactNode>> = {
  youtube: <><rect x="2.5" y="5" width="19" height="14" rx="4" /><path d="M10 9l5 3-5 3z" /></>,
  rss: <><path d="M5 11a8 8 0 0 1 8 8" /><path d="M5 5a14 14 0 0 1 14 14" /><circle cx="6" cy="18" r="1.2" /></>,
};

registerIcons(SOURCE_ICONS);
