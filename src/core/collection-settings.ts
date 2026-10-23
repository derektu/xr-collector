import type { SubscriptionDeclaration } from '../plugins/types.js';
import { intervalLabel } from './check-interval.js';
import { CollectorError, type SourceSettingField, type SubscriptionSettings } from './types.js';

/** Check intervals a subscription may use, in minutes. */
export const INTERVAL_OPTIONS = [15, 30, 60, 180, 360, 720, 1440] as const;
/** How many days before a check its range reaches, the same for every source type. */
export const BACKFILL_DAYS = { min: 1, max: 60 } as const;
/** How many of the newest items within the range one check collects, the same for every source type. */
export const BACKFILL_MAX_ITEMS = { min: 1, max: 100 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Settings of a subscription whose every check collects the newest `backfillMaxItems` items
 * published within the `backfillDays` days before the check, leaving out the ones already
 * collected or deleted.
 */
export type RangeSettings = {
  intervalMinutes: number;
  backfillDays: number;
  backfillMaxItems: number;
};

/** Why `value` is not a valid value of `field`, in words that name the allowed values; null when it is valid. */
export function settingFieldError(field: SourceSettingField, value: unknown): string | null {
  if (field.input === 'number') {
    return Number.isInteger(value) && (value as number) >= field.min && (value as number) <= field.max
      ? null : `${field.label}必須是 ${field.min}–${field.max} 的整數。`;
  }
  return field.options.some((option) => option.value === value)
    ? null : `${field.label}必須是 ${field.options.map((option) => option.value).join('、')} 之一。`;
}

/** The fields of `settings` that hold an invalid value, each with its reason. */
export function settingsErrors(fields: readonly SourceSettingField[], settings: Partial<SubscriptionSettings>): Array<{ key: string; message: string }> {
  return fields.flatMap((field) => {
    const message = settingFieldError(field, settings[field.key]);
    return message ? [{ key: field.key, message }] : [];
  });
}

/** Whether a stored value holds a valid value of every field. */
export function isValidSettings(fields: readonly SourceSettingField[], value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return settingsErrors(fields, value as Partial<SubscriptionSettings>).length === 0;
}

/**
 * Reads settings from a request body: an object with any of the fields and nothing else. Throws
 * `invalid_request` for other keys or invalid values, and for an empty object unless `allowEmpty`,
 * where it means the source type's defaults.
 */
export function parseSettingsPatch(
  fields: readonly SourceSettingField[], value: unknown, options: { allowEmpty?: boolean } = {},
): Partial<SubscriptionSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CollectorError('invalid_request', '收集設定必須是 JSON 物件。');
  const patch = value as Record<string, unknown>;
  const keys = Object.keys(patch);
  const unknown = keys.find((key) => !fields.some((field) => field.key === key));
  if (unknown) throw new CollectorError('invalid_request', `不支援的設定欄位：${unknown}`);
  if (keys.length === 0 && !options.allowEmpty) throw new CollectorError('invalid_request', '請提供至少一個要修改的設定。');
  for (const field of fields) {
    const message = field.key in patch ? settingFieldError(field, patch[field.key]) : null;
    if (message) throw new CollectorError('invalid_request', message);
  }
  return patch as Partial<SubscriptionSettings>;
}

/**
 * The settings fields and subscription rules of a source type whose checks collect by
 * `RangeSettings`. `item` names what the type collects, as in "10 支影片".
 */
export function rangeSettings(defaults: RangeSettings, item: { noun: string; measure: string }): {
  fields: SourceSettingField[];
  subscription: Pick<SubscriptionDeclaration<RangeSettings>, 'defaults' | 'isValidSettings' | 'parseSettingsPatch' | 'describeSettings' | 'checkRange' | 'sentence'>;
} {
  const fields: SourceSettingField[] = [
    {
      input: 'choice', key: 'intervalMinutes', label: '檢查頻率', default: defaults.intervalMinutes,
      options: INTERVAL_OPTIONS.map((value) => ({ value, label: intervalLabel(value) })),
    },
    { input: 'number', key: 'backfillDays', label: '時間範圍', ...BACKFILL_DAYS, unit: '天', default: defaults.backfillDays },
    {
      input: 'number', key: 'backfillMaxItems', label: '數量上限', ...BACKFILL_MAX_ITEMS,
      unit: `${item.measure}${item.noun}`, default: defaults.backfillMaxItems,
    },
  ];
  return {
    fields,
    subscription: {
      defaults,
      isValidSettings: (value) => isValidSettings(fields, value),
      parseSettingsPatch: (value, options) => parseSettingsPatch(fields, value, options) as Partial<RangeSettings>,
      describeSettings: (settings) => `最近 ${settings.backfillDays} 天內最新的 ${settings.backfillMaxItems} ${item.measure}${item.noun}`,
      checkRange: (settings, now) => ({ since: new Date(now.getTime() - settings.backfillDays * DAY_MS), maxItems: settings.backfillMaxItems }),
      sentence: ['收集最近', { field: 'backfillDays' }, '內最新的', { field: 'backfillMaxItems' }],
    },
  };
}
