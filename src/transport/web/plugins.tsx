import type { ReactNode } from 'react';
import { SourceDeclarations } from '../../shared/sources/source-registry.js';
import { SOURCE_DECLARATIONS } from '../../app/plugins/declarations.js';
import { registerIcons } from './shell/icons.js';
import './plugins.css';

export const PRODUCT_SOURCES = new SourceDeclarations(SOURCE_DECLARATIONS);

export const SOURCE_ICONS: Readonly<Record<string, ReactNode>> = {
  youtube: <><rect x="2.5" y="5" width="19" height="14" rx="4" /><path d="M10 9l5 3-5 3z" /></>,
  rss: <><path d="M5 11a8 8 0 0 1 8 8" /><path d="M5 5a14 14 0 0 1 14 14" /><circle cx="6" cy="18" r="1.2" /></>,
};

registerIcons(SOURCE_ICONS);
