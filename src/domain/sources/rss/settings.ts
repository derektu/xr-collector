import { rangeSettings, type RangeSettings } from '../../../shared/sources/collection-settings.js';

export type RssSettings = RangeSettings;

export const DEFAULT_SETTINGS: RssSettings = { intervalMinutes: 60, backfillDays: 7, backfillMaxItems: 30 };

export const RSS_SETTINGS = rangeSettings(DEFAULT_SETTINGS, { noun: '文章', measureWord: '篇' });
