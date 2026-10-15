import { CollectorError, type BackfillWindow, type CollectionPolicy } from '../core/types.js';

/** Check intervals the Settings page offers and the API accepts, in minutes. */
export const INTERVAL_OPTIONS = [15, 30, 60, 180, 360, 720, 1440] as const;
export const BACKFILL_WINDOWS: readonly BackfillWindow[] = ['1w', '2w', '1m', '3m', '6m'];
export const BACKFILL_LIMITS = [5, 10, 20, 50] as const;

export const DEFAULT_POLICY: CollectionPolicy = {
  intervalMinutes: 30,
  backfillWindow: '1m',
  backfillMaxItems: 10,
};

const HOUR_MS = 60 * 60_000;

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

export function assertPolicyPatch(patch: Partial<CollectionPolicy & { enabled: boolean }>): void {
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    throw new CollectorError('invalid_request', '自動收集開關必須是 true 或 false。');
  }
  if (patch.intervalMinutes !== undefined && !isIntervalOption(patch.intervalMinutes)) {
    throw new CollectorError('invalid_request', `檢查頻率必須是 ${INTERVAL_OPTIONS.join('、')} 分鐘之一。`);
  }
  if (patch.backfillWindow !== undefined && !isBackfillWindow(patch.backfillWindow)) {
    throw new CollectorError('invalid_request', `補收範圍必須是 ${BACKFILL_WINDOWS.join('、')} 之一。`);
  }
  if (patch.backfillMaxItems !== undefined && !isBackfillLimit(patch.backfillMaxItems)) {
    throw new CollectorError('invalid_request', `補收則數必須是 ${BACKFILL_LIMITS.join('、')} 之一。`);
  }
}

/**
 * Start of the backfill range ending at `now`, in the device's local time zone. Weeks are 7-day
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

/** A publish time as an instant. A date without a time means 00:00 UTC of that date, as YouTube reports it. */
export function publishedInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** True when the publish time is on or after `start`; an unknown time counts as inside the range. */
export function publishedSince(value: string | null | undefined, start: Date | string): boolean {
  const instant = publishedInstant(value);
  return instant === null || instant >= new Date(start).getTime();
}

/**
 * Without a successful check for this long, the next check is treated like a restart and uses the
 * backfill limits, so sleep or a long outage never replays every missed period.
 */
export function catchUpThresholdMs(intervalMinutes: number): number {
  return Math.max(24 * HOUR_MS, 3 * intervalMinutes * 60_000);
}

const WINDOW_LABELS: Record<BackfillWindow, string> = { '1w': '1 週', '2w': '2 週', '1m': '1 個月', '3m': '3 個月', '6m': '6 個月' };

/** Option label of a check interval, e.g. "30 分" or "每天". */
export function intervalLabel(minutes: number): string {
  if (minutes === 1440) return '每天';
  if (minutes % 60 === 0) return `${minutes / 60} 小時`;
  return `${minutes} 分`;
}

export function windowLabel(window: BackfillWindow): string {
  return WINDOW_LABELS[window];
}
