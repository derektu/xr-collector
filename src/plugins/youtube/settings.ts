import { rangeSettings, type RangeSettings } from '../../core/collection-settings.js';

/** Collection settings of one YouTube subscription. */
export type CollectionPolicy = RangeSettings;

/** The settings a new YouTube subscription starts with. */
export const DEFAULT_POLICY: CollectionPolicy = { intervalMinutes: 30, backfillDays: 30, backfillMaxItems: 10 };

export const YOUTUBE_SETTINGS = rangeSettings(DEFAULT_POLICY, { noun: '影片', measure: '支' });
