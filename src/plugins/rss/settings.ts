import { intervalLabel } from '../../core/check-interval.js';
import { CollectorError, type SourceSettingField } from '../../core/types.js';

export type RssWindow = '1w' | '2w' | '1m' | '3m' | '6m';

/**
 * Collection settings of one RSS subscription. Every check collects the newest `backfillMaxItems`
 * articles published within `backfillWindow` before the check, leaving out the ones already
 * collected or deleted.
 */
export type RssSettings = {
  intervalMinutes: number;
  backfillWindow: RssWindow;
  backfillMaxItems: number;
};

/** Check intervals a subscription may use, in minutes. */
export const INTERVAL_OPTIONS = [15, 30, 60, 180, 360, 720, 1440] as const;
export const WINDOWS: readonly RssWindow[] = ['1w', '2w', '1m', '3m', '6m'];
export const LIMITS = [5, 10, 20, 50] as const;

/** The settings a new RSS subscription starts with. */
export const DEFAULT_SETTINGS: RssSettings = { intervalMinutes: 60, backfillWindow: '1m', backfillMaxItems: 10 };

const WINDOW_LABELS: Record<RssWindow, string> = { '1w': '1 週', '2w': '2 週', '1m': '1 個月', '3m': '3 個月', '6m': '6 個月' };
const KEYS: ReadonlySet<string> = new Set(['intervalMinutes', 'backfillWindow', 'backfillMaxItems']);

export const SETTING_FIELDS: SourceSettingField[] = [
  {
    key: 'intervalMinutes', label: '檢查頻率', default: DEFAULT_SETTINGS.intervalMinutes,
    options: INTERVAL_OPTIONS.map((value) => ({ value, label: intervalLabel(value) })),
  },
  {
    key: 'backfillWindow', label: '時間範圍', default: DEFAULT_SETTINGS.backfillWindow,
    options: WINDOWS.map((value) => ({ value, label: WINDOW_LABELS[value] })),
  },
  {
    key: 'backfillMaxItems', label: '數量上限', default: DEFAULT_SETTINGS.backfillMaxItems,
    options: LIMITS.map((value) => ({ value, label: `${value} 篇文章` })),
  },
];

const isInterval = (value: unknown) => INTERVAL_OPTIONS.includes(value as (typeof INTERVAL_OPTIONS)[number]);
const isWindow = (value: unknown) => WINDOWS.includes(value as RssWindow);
const isLimit = (value: unknown) => LIMITS.includes(value as (typeof LIMITS)[number]);

export function isRssSettings(value: unknown): value is RssSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const settings = value as Partial<RssSettings>;
  return isInterval(settings.intervalMinutes) && isWindow(settings.backfillWindow) && isLimit(settings.backfillMaxItems);
}

/**
 * Reads settings from a request body: an object with any of the three settings and nothing else.
 * Throws `invalid_request` for other keys or values, and for an empty object unless `allowEmpty`.
 */
export function parseSettingsPatch(value: unknown, options: { allowEmpty?: boolean } = {}): Partial<RssSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CollectorError('invalid_request', '收集設定必須是 JSON 物件。');
  const keys = Object.keys(value);
  const unknown = keys.find((key) => !KEYS.has(key));
  if (unknown) throw new CollectorError('invalid_request', `不支援的設定欄位：${unknown}`);
  if (keys.length === 0 && !options.allowEmpty) throw new CollectorError('invalid_request', '請提供至少一個要修改的設定。');
  const patch = value as Partial<RssSettings>;
  if (patch.intervalMinutes !== undefined && !isInterval(patch.intervalMinutes)) {
    throw new CollectorError('invalid_request', `檢查頻率必須是 ${INTERVAL_OPTIONS.join('、')} 分鐘之一。`);
  }
  if (patch.backfillWindow !== undefined && !isWindow(patch.backfillWindow)) {
    throw new CollectorError('invalid_request', `時間範圍必須是 ${WINDOWS.join('、')} 之一。`);
  }
  if (patch.backfillMaxItems !== undefined && !isLimit(patch.backfillMaxItems)) {
    throw new CollectorError('invalid_request', `數量上限必須是 ${LIMITS.join('、')} 之一。`);
  }
  return patch;
}

/**
 * Start of the collection range ending at `now`, in the device's local time zone. Weeks are 7-day
 * steps; months are calendar months, and a day the earlier month lacks becomes its last day.
 */
export function windowStart(now: Date, window: RssWindow): Date {
  const amount = Number(window.slice(0, -1));
  if (window.endsWith('w')) {
    const start = new Date(now);
    start.setDate(start.getDate() - 7 * amount);
    return start;
  }
  const first = new Date(now.getFullYear(), now.getMonth() - amount, 1);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(
    first.getFullYear(), first.getMonth(), Math.min(now.getDate(), lastDay),
    now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds(),
  );
}

/** The range every check collects, in words, e.g. "最近 1 個月內最新的 10 篇文章". */
export function describeSettings(settings: Pick<RssSettings, 'backfillWindow' | 'backfillMaxItems'>): string {
  return `最近 ${WINDOW_LABELS[settings.backfillWindow]}內最新的 ${settings.backfillMaxItems} 篇文章`;
}
