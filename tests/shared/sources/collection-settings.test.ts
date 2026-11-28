// Broken, a subscription collects outside the time range or item limit the user set.
import { describe, expect, it } from 'vitest';
import {
  isValidSettings,
  parseSettingsPatch,
  rangeSettings,
  settingFieldError,
  settingsErrors,
  withCommonSettings,
} from '../../../src/shared/sources/collection-settings.js';
import { publishedSince } from '../../../src/shared/documents/published.js';
import { CollectorError } from '../../../src/shared/lib/collector-error.js';

const { fields, subscription } = rangeSettings({ intervalMinutes: 30, backfillDays: 30, backfillMaxItems: 10 }, { noun: '影片', measureWord: '支' });
const field = (key: string) => fields.find((candidate) => candidate.key === key)!;
const declared = { targetNoun: '頻道', ...subscription };

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
  it('accepts whole numbers within the limits and nothing else', () => {
    for (const value of [1, 2, 59, 60]) expect(settingFieldError(field('backfillDays'), value)).toBeNull();
    for (const value of [0, 61, -1, 1.5, '30', '', null, undefined, Number.NaN]) {
      expect(settingFieldError(field('backfillDays'), value)).toBe('時間範圍必須是 1–60 的整數。');
    }
    for (const value of [1, 100]) expect(settingFieldError(field('backfillMaxItems'), value)).toBeNull();
    for (const value of [0, 101, 10.5, 'abc']) expect(settingFieldError(field('backfillMaxItems'), value)).toBe('數量上限必須是 1–100 的整數。');
    expect(settingFieldError(field('intervalMinutes'), 45)).toBe('檢查頻率必須是 15、30、60、180、360、720、1440 之一。');
    expect(settingsErrors(fields, { intervalMinutes: 30, backfillDays: 0, backfillMaxItems: 'x', documentStatus: 'published' })).toEqual([
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
    expect(isValidSettings(fields, { intervalMinutes: 30, backfillDays: 60, backfillMaxItems: 100, documentStatus: 'published' })).toBe(true);
    expect(isValidSettings(fields, { intervalMinutes: 30, backfillWindow: '1m', backfillMaxItems: 10 })).toBe(false);
    expect(isValidSettings(fields, { intervalMinutes: 30, backfillDays: 61, backfillMaxItems: 10, documentStatus: 'published' })).toBe(false);
    expect(isValidSettings(fields, null)).toBe(false);
  });

  it('gives every subscribing type a documentStatus field, starting as published, without the type declaring it', () => {
    const common = withCommonSettings({ settings: fields, subscription: declared });
    expect(fields.map((candidate) => candidate.key)).not.toContain('documentStatus');
    expect(common.settings.map((candidate) => candidate.key)).toEqual([...fields.map((candidate) => candidate.key), 'documentStatus']);
    expect(common.subscription?.defaults).toEqual({ ...subscription.defaults, documentStatus: 'published' });
    expect(withCommonSettings({ settings: [] })).toEqual({ settings: [] });
  });

  it.each([
    ['published', true],
    ['draft', true],
    ['final', false],
    ['Draft', false],
    [undefined, false],
  ])('accepts only published or draft as documentStatus, so a subscription saves documents in a status the Vault knows: %s → %s', (value, valid) => {
    const common = withCommonSettings({ settings: fields, subscription: declared }).subscription!;
    expect(common.isValidSettings({ ...subscription.defaults, documentStatus: value })).toBe(valid);
    if (valid) expect(common.parseSettingsPatch({ documentStatus: value })).toEqual({ documentStatus: value });
    else expect(rejection(() => common.parseSettingsPatch({ documentStatus: value }))).toEqual({ code: 'invalid_request', message: '預設狀態必須是 published、draft 之一。' });
  });

  it('reads the type\'s own fields of a patch by the type, beside documentStatus', () => {
    const common = withCommonSettings({ settings: fields, subscription: declared }).subscription!;
    expect(common.parseSettingsPatch({ backfillDays: 14, documentStatus: 'draft' })).toEqual({ backfillDays: 14, documentStatus: 'draft' });
    expect(rejection(() => common.parseSettingsPatch({ backfillDays: 61, documentStatus: 'draft' })).code).toBe('invalid_request');
    expect(rejection(() => common.parseSettingsPatch({})).code).toBe('invalid_request');
    expect(common.isValidSettings({ ...subscription.defaults, documentStatus: 'draft', backfillDays: 61 })).toBe(false);
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
