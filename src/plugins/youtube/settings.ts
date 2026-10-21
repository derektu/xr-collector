import { CollectorError } from '../../core/types.js';

export type BackfillWindow = '1w' | '2w' | '1m' | '3m' | '6m';

/**
 * Collection settings of one YouTube subscription. Every check collects the newest
 * `backfillMaxItems` videos published within `backfillWindow` before the check, leaving out the
 * ones already collected or deleted.
 */
export type CollectionPolicy = {
  intervalMinutes: number;
  backfillWindow: BackfillWindow;
  backfillMaxItems: number;
};

/** Check intervals a subscription may use, in minutes. */
export const INTERVAL_OPTIONS = [15, 30, 60, 180, 360, 720, 1440] as const;
export const BACKFILL_WINDOWS: readonly BackfillWindow[] = ['1w', '2w', '1m', '3m', '6m'];
export const BACKFILL_LIMITS = [5, 10, 20, 50] as const;

/** The settings a new YouTube subscription starts with. */
export const DEFAULT_POLICY: CollectionPolicy = {
  intervalMinutes: 30,
  backfillWindow: '1m',
  backfillMaxItems: 10,
};

export function isIntervalOption(value: unknown): value is number {
  return INTERVAL_OPTIONS.includes(value as (typeof INTERVAL_OPTIONS)[number]);
}

export function isBackfillWindow(value: unknown): value is BackfillWindow {
  return BACKFILL_WINDOWS.includes(value as BackfillWindow);
}

export function isBackfillLimit(value: unknown): value is number {
  return BACKFILL_LIMITS.includes(value as (typeof BACKFILL_LIMITS)[number]);
}

/** The smallest offered interval not shorter than `minutes`; longer values become the longest option. */
export function normalizeInterval(minutes: number): number {
  return INTERVAL_OPTIONS.find((option) => option >= minutes) ?? INTERVAL_OPTIONS[INTERVAL_OPTIONS.length - 1]!;
}

const POLICY_KEYS: ReadonlySet<string> = new Set(['intervalMinutes', 'backfillWindow', 'backfillMaxItems']);

export function isCollectionPolicy(value: unknown): value is CollectionPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const policy = value as Partial<CollectionPolicy>;
  return isIntervalOption(policy.intervalMinutes) && isBackfillWindow(policy.backfillWindow) && isBackfillLimit(policy.backfillMaxItems);
}

/**
 * Reads settings from a request body: an object with any of the three settings and nothing else.
 * Throws `invalid_request` for other keys or other values, and for an empty object unless
 * `allowEmpty`, where it means the source type's defaults.
 */
export function parsePolicyPatch(value: unknown, options: { allowEmpty?: boolean } = {}): Partial<CollectionPolicy> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CollectorError('invalid_request', '收集設定必須是 JSON 物件。');
  }
  const keys = Object.keys(value);
  const unknown = keys.find((key) => !POLICY_KEYS.has(key));
  if (unknown) throw new CollectorError('invalid_request', `不支援的設定欄位：${unknown}`);
  if (keys.length === 0 && !options.allowEmpty) throw new CollectorError('invalid_request', '請提供至少一個要修改的設定。');
  const patch = value as Partial<CollectionPolicy>;
  assertPolicyPatch(patch);
  return patch;
}

export function assertPolicyPatch(patch: Partial<CollectionPolicy>): void {
  if (patch.intervalMinutes !== undefined && !isIntervalOption(patch.intervalMinutes)) {
    throw new CollectorError('invalid_request', `檢查頻率必須是 ${INTERVAL_OPTIONS.join('、')} 分鐘之一。`);
  }
  if (patch.backfillWindow !== undefined && !isBackfillWindow(patch.backfillWindow)) {
    throw new CollectorError('invalid_request', `時間範圍必須是 ${BACKFILL_WINDOWS.join('、')} 之一。`);
  }
  if (patch.backfillMaxItems !== undefined && !isBackfillLimit(patch.backfillMaxItems)) {
    throw new CollectorError('invalid_request', `數量上限必須是 ${BACKFILL_LIMITS.join('、')} 之一。`);
  }
}

/**
 * Start of the collection range ending at `now`, in the device's local time zone. Weeks are 7-day
 * steps; months are calendar months, and a day the earlier month lacks becomes its last day
 * (31 March minus one month is 28 or 29 February).
 */
export function backfillWindowStart(now: Date, window: BackfillWindow): Date {
  const amount = Number(window.slice(0, -1));
  if (window.endsWith('w')) {
    const start = new Date(now);
    start.setDate(start.getDate() - 7 * amount);
    return start;
  }
  const targetMonth = now.getMonth() - amount;
  const firstOfTarget = new Date(now.getFullYear(), targetMonth, 1);
  const lastDay = new Date(firstOfTarget.getFullYear(), firstOfTarget.getMonth() + 1, 0).getDate();
  return new Date(
    firstOfTarget.getFullYear(), firstOfTarget.getMonth(), Math.min(now.getDate(), lastDay),
    now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds(),
  );
}

const WINDOW_LABELS: Record<BackfillWindow, string> = { '1w': '1 週', '2w': '2 週', '1m': '1 個月', '3m': '3 個月', '6m': '6 個月' };

export function windowLabel(window: BackfillWindow): string {
  return WINDOW_LABELS[window];
}

/** The range every check collects, in words, e.g. "最近 1 個月內最新的 10 支影片". */
export function backfillPhrase(settings: Pick<CollectionPolicy, 'backfillWindow' | 'backfillMaxItems'>): string {
  return `最近 ${windowLabel(settings.backfillWindow)}內最新的 ${settings.backfillMaxItems} 支影片`;
}
