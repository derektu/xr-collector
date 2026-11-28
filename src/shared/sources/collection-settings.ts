import type { SourcePluginDeclaration, SubscriptionDeclaration } from './source-contract.js';
import { intervalLabel } from '../subscriptions/check-interval.js';
import { CollectorError } from '../lib/collector-error.js';
import type { ChoiceSettingField, SourceSettingField } from './source-info-types.js';
import type { SubscriptionSettings } from '../subscriptions/subscription-types.js';
import type { DocumentStatus } from '../documents/document-types.js';
import { parseDocumentStatus } from '../documents/document-status.js';

export const INTERVAL_OPTIONS = [15, 30, 60, 180, 360, 720, 1440] as const;
export const BACKFILL_DAYS = { min: 1, max: 60 } as const;
export const BACKFILL_MAX_ITEMS = { min: 1, max: 100 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RangeSettings = {
  intervalMinutes: number;
  backfillDays: number;
  backfillMaxItems: number;
};

export const DOCUMENT_STATUS_OPTIONS: ReadonlyArray<{ value: DocumentStatus; label: string }> = [
  { value: 'published', label: '正式' },
  { value: 'draft', label: '草稿' },
];

export const DOCUMENT_STATUS_FIELD: ChoiceSettingField = {
  input: 'choice', key: 'documentStatus', label: '預設狀態', default: 'published', options: [...DOCUMENT_STATUS_OPTIONS],
};

/** Null when `value` is valid for `field`; otherwise the reason, in words that name the allowed values. */
export function settingFieldError(field: SourceSettingField, value: unknown): string | null {
  if (field.input === 'number') {
    return typeof value === 'number' && Number.isInteger(value) && value >= field.min && value <= field.max
      ? null : `${field.label}必須是 ${field.min}–${field.max} 的整數。`;
  }
  return field.options.some((option) => option.value === value) ? null : choiceMessage(field);
}

function choiceMessage(field: ChoiceSettingField): string {
  return `${field.label}必須是 ${field.options.map((option) => option.value).join('、')} 之一。`;
}

function requestedDocumentStatus(value: unknown): DocumentStatus {
  const status = parseDocumentStatus(value);
  if (!status) throw new CollectorError('invalid_request', choiceMessage(DOCUMENT_STATUS_FIELD));
  return status;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function settingsErrors(fields: readonly SourceSettingField[], settings: Readonly<Record<string, unknown>>): Array<{ key: string; message: string }> {
  return fields.flatMap((field) => {
    const message = settingFieldError(field, settings[field.key]);
    return message ? [{ key: field.key, message }] : [];
  });
}

export function isValidSettings(fields: readonly SourceSettingField[], value: unknown): boolean {
  return isPlainObject(value) && settingsErrors(fields, value).length === 0;
}

export function parseSettingsPatch(
  fields: readonly SourceSettingField[], value: unknown, options: { allowEmpty?: boolean } = {},
): Partial<SubscriptionSettings> {
  if (!isPlainObject(value)) throw new CollectorError('invalid_request', '收集設定必須是 JSON 物件。');
  const keys = Object.keys(value);
  const unknown = keys.find((key) => !fields.some((field) => field.key === key));
  if (unknown) throw new CollectorError('invalid_request', `不支援的設定欄位：${unknown}`);
  if (keys.length === 0 && !options.allowEmpty) throw new CollectorError('invalid_request', '請提供至少一個要修改的設定。');
  for (const field of fields) {
    const message = field.key in value ? settingFieldError(field, value[field.key]) : null;
    if (message) throw new CollectorError('invalid_request', message);
  }
  return value as Partial<SubscriptionSettings>;
}

export function rangeSettings(defaults: RangeSettings, item: { noun: string; measureWord: string }): {
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
      unit: `${item.measureWord}${item.noun}`, default: defaults.backfillMaxItems,
    },
  ];
  return {
    fields,
    subscription: {
      defaults,
      isValidSettings: (value) => isValidSettings(fields, value),
      parseSettingsPatch: (value, options) => parseSettingsPatch(fields, value, options) as Partial<RangeSettings>,
      describeSettings: (settings) => `最近 ${settings.backfillDays} 天內最新的 ${settings.backfillMaxItems} ${item.measureWord}${item.noun}`,
      checkRange: (settings, now) => ({ since: new Date(now.getTime() - settings.backfillDays * DAY_MS), maxItems: settings.backfillMaxItems }),
      sentence: ['收集最近', { field: 'backfillDays' }, '內最新的', { field: 'backfillMaxItems' }],
    },
  };
}

type DeclaredSettings = Pick<SourcePluginDeclaration, 'settings' | 'subscription'>;

export type WithCommonSettings<D extends DeclaredSettings> = Omit<D, 'subscription'> & { subscription?: SubscriptionDeclaration<SubscriptionSettings> };

/**
 * `declaration` with the settings every subscribing source type has besides its own: the field list,
 * defaults, validation and patch reading gain `documentStatus`, `published` for a new subscription.
 * A declaration without subscriptions is returned as it is.
 */
export function withCommonSettings<D extends DeclaredSettings>(declaration: D): WithCommonSettings<D> {
  const own = declaration.subscription;
  if (!own) {
    const { subscription: _none, ...rest } = declaration;
    return rest;
  }
  const subscription: SubscriptionDeclaration<SubscriptionSettings> = {
    ...own,
    defaults: { ...own.defaults, documentStatus: 'published' },
    isValidSettings(value) {
      if (!isPlainObject(value)) return false;
      const { documentStatus, ...rest } = value;
      return parseDocumentStatus(documentStatus) !== null && own.isValidSettings(rest);
    },
    parseSettingsPatch(value, options = {}) {
      if (!isPlainObject(value) || !('documentStatus' in value)) return own.parseSettingsPatch(value, options);
      const { documentStatus, ...rest } = value;
      return { ...own.parseSettingsPatch(rest, { allowEmpty: true }), documentStatus: requestedDocumentStatus(documentStatus) };
    },
  };
  return { ...declaration, settings: [...declaration.settings, DOCUMENT_STATUS_FIELD], subscription };
}
