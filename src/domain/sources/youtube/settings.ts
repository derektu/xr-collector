import { rangeSettings, type RangeSettings } from '../../../shared/sources/collection-settings.js';

export type CollectionPolicy = RangeSettings;

export const DEFAULT_POLICY: CollectionPolicy = { intervalMinutes: 30, backfillDays: 30, backfillMaxItems: 10 };

export const YOUTUBE_SETTINGS = rangeSettings(DEFAULT_POLICY, { noun: '影片', measure: '支' });
