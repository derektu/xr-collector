import { rangeSettings, type RangeSettings } from '../../core/collection-settings.js';

/** Collection settings of one RSS subscription. */
export type RssSettings = RangeSettings;

/** The settings a new RSS subscription starts with. */
export const DEFAULT_SETTINGS: RssSettings = { intervalMinutes: 60, backfillDays: 7, backfillMaxItems: 30 };

export const RSS_SETTINGS = rangeSettings(DEFAULT_SETTINGS, { noun: '文章', measure: '篇' });
