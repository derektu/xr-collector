import { describe, expect, it } from 'vitest';
import {
  BACKFILL_DAYS,
  BACKFILL_MAX_ITEMS,
  isValidSettings,
  parseSettingsPatch,
  rangeSettings,
  settingFieldError,
  settingsErrors,
} from '../../src/core/collection-settings.js';
import { publishedSince } from '../../src/core/published.js';
import { CollectorError } from '../../src/core/types.js';
import { rssDeclaration } from '../../src/plugins/rss/shared.js';
import { youtubeDeclaration } from '../../src/plugins/youtube/shared.js';

const { fields, subscription } = rangeSettings({ intervalMinutes: 30, backfillDays: 30, backfillMaxItems: 10 }, { noun: '影片', measure: '支' });
const field = (key: string) => fields.find((candidate) => candidate.key === key)!;

function rejection(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof CollectorError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('Expected a rejection');
}

describe('range settings fields', () => {
  it('declares the same limits for every source type and each type its own defaults', () => {
    expect(BACKFILL_DAYS).toEqual({ min: 1, max: 60 });
    expect(BACKFILL_MAX_ITEMS).toEqual({ min: 1, max: 100 });
    for (const declaration of [youtubeDeclaration, rssDeclaration]) {
      expect(declaration.settings.map((candidate) => candidate.input)).toEqual(['choice', 'number', 'number']);
      expect(declaration.settings[1]).toMatchObject({ key: 'backfillDays', min: 1, max: 60, unit: '天' });
      expect(declaration.settings[2]).toMatchObject({ key: 'backfillMaxItems', min: 1, max: 100 });
    }
    expect(youtubeDeclaration.subscription!.defaults).toEqual({ intervalMinutes: 30, backfillDays: 30, backfillMaxItems: 10 });
    expect(youtubeDeclaration.settings.map((candidate) => candidate.default)).toEqual([30, 30, 10]);
    expect(youtubeDeclaration.settings[2]).toMatchObject({ unit: '支影片' });
    expect(rssDeclaration.subscription!.defaults).toEqual({ intervalMinutes: 60, backfillDays: 7, backfillMaxItems: 30 });
    expect(rssDeclaration.settings.map((candidate) => candidate.default)).toEqual([60, 7, 30]);
    expect(rssDeclaration.settings[2]).toMatchObject({ unit: '篇文章' });
  });

  it('accepts whole numbers within the limits and nothing else', () => {
    for (const value of [1, 2, 59, 60]) expect(settingFieldError(field('backfillDays'), value)).toBeNull();
    for (const value of [0, 61, -1, 1.5, '30', '', null, undefined, Number.NaN]) {
      expect(settingFieldError(field('backfillDays'), value)).toBe('時間範圍必須是 1–60 的整數。');
    }
    for (const value of [1, 100]) expect(settingFieldError(field('backfillMaxItems'), value)).toBeNull();
    for (const value of [0, 101, 10.5, 'abc']) expect(settingFieldError(field('backfillMaxItems'), value)).toBe('數量上限必須是 1–100 的整數。');
    expect(settingFieldError(field('intervalMinutes'), 45)).toBe('檢查頻率必須是 15、30、60、180、360、720、1440 之一。');
    expect(settingsErrors(fields, { intervalMinutes: 30, backfillDays: 0, backfillMaxItems: 'x' })).toEqual([
      { key: 'backfillDays', message: '時間範圍必須是 1–60 的整數。' },
      { key: 'backfillMaxItems', message: '數量上限必須是 1–100 的整數。' },
    ]);
  });

  it('reads a request patch by the declared fields', () => {
    expect(parseSettingsPatch(fields, { backfillDays: 60, backfillMaxItems: 100 })).toEqual({ backfillDays: 60, backfillMaxItems: 100 });
    expect(parseSettingsPatch(fields, {}, { allowEmpty: true })).toEqual({});
    expect(rejection(() => parseSettingsPatch(fields, { backfillDays: 61 }))).toEqual({ code: 'invalid_request', message: '時間範圍必須是 1–60 的整數。' });
    expect(rejection(() => parseSettingsPatch(fields, { backfillMaxItems: 0 }))).toEqual({ code: 'invalid_request', message: '數量上限必須是 1–100 的整數。' });
    expect(rejection(() => parseSettingsPatch(fields, { backfillWindow: '1m' }))).toEqual({ code: 'invalid_request', message: '不支援的設定欄位：backfillWindow' });
    expect(rejection(() => parseSettingsPatch(fields, {})).code).toBe('invalid_request');
    expect(rejection(() => parseSettingsPatch(fields, [])).code).toBe('invalid_request');
  });

  it('treats stored settings as valid only when every field holds a valid value', () => {
    expect(isValidSettings(fields, { intervalMinutes: 30, backfillDays: 60, backfillMaxItems: 100 })).toBe(true);
    expect(isValidSettings(fields, { intervalMinutes: 30, backfillWindow: '1m', backfillMaxItems: 10 })).toBe(false);
    expect(isValidSettings(fields, { intervalMinutes: 30, backfillDays: 61, backfillMaxItems: 10 })).toBe(false);
    expect(isValidSettings(fields, null)).toBe(false);
  });

  it('reaches back the given number of whole days from the check and describes the range', () => {
    const now = new Date('2026-10-15T04:00:00.000Z');
    expect(subscription.checkRange({ intervalMinutes: 30, backfillDays: 1, backfillMaxItems: 5 }, now))
      .toEqual({ since: new Date('2026-10-14T04:00:00.000Z'), maxItems: 5 });
    expect(subscription.checkRange({ intervalMinutes: 30, backfillDays: 60, backfillMaxItems: 100 }, now))
      .toEqual({ since: new Date('2026-08-16T04:00:00.000Z'), maxItems: 100 });
    expect(subscription.describeSettings({ intervalMinutes: 30, backfillDays: 45, backfillMaxItems: 20 })).toBe('最近 45 天內最新的 20 支影片');
  });

  it('includes the boundary instant, reads dates as 00:00 UTC and keeps unknown dates', () => {
    const start = '2026-09-15T04:00:00.000Z';
    expect(publishedSince('2026-09-15T04:00:00.000Z', start)).toBe(true);
    expect(publishedSince('2026-09-15T03:59:59.000Z', start)).toBe(false);
    expect(publishedSince('2026-09-16', start)).toBe(true);
    expect(publishedSince('2026-09-15', start)).toBe(false);
    expect(publishedSince('2026-09-15', '2026-09-15T00:00:00.000Z')).toBe(true);
    expect(publishedSince(null, start)).toBe(true);
  });
});
