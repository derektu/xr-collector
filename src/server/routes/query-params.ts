import { CollectorError } from '../../core/collector-error.js';
import type { DocumentFilter } from '../../core/document-types.js';
import type { SourceRegistry } from '../../core/source-registry.js';

/** Rejects repeated query parameters so each filter has exactly one value. */
export function singleValues(query: Record<string, unknown>): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string') {
      throw new CollectorError('invalid_request', '每個查詢參數只能提供一個值。');
    }
    values[key] = value;
  }
  return values;
}

export function pagination(query: { offset?: string | undefined; limit?: string | undefined }): { offset: number; limit: number } {
  const parse = (value: string | undefined, fallback: number, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
      throw new CollectorError('invalid_request', '分頁參數必須是整數。');
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
      throw new CollectorError('invalid_request', 'offset 必須介於 0 到 1000000，limit 必須介於 1 到 100。');
    }
    return number;
  };
  return { offset: parse(query.offset, 0, 0, 1_000_000), limit: parse(query.limit, 50, 1, 100) };
}

/** An ISO date-time with an explicit offset or Z, so the instant does not depend on the server's time zone. */
export function isInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && !Number.isNaN(Date.parse(value));
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/** Source filters use stable IDs; publisher names are display text and never filter. */
export function documentFilter(sources: SourceRegistry, query: Record<string, string | undefined>): DocumentFilter {
  if (query.channel !== undefined) {
    throw new CollectorError('invalid_request', '不支援以頻道名稱篩選，請改用 sourceType 與 publisherId。');
  }
  const { sourceType, publisherId } = query;
  if (sourceType !== undefined && !sources.get(sourceType)) {
    throw new CollectorError('invalid_request', '不支援的 sourceType。');
  }
  if (publisherId !== undefined && (sourceType === undefined || publisherId === '' || publisherId.length > 200)) {
    throw new CollectorError('invalid_request', 'publisherId 需要搭配 sourceType，且長度須在 1 到 200 之間。');
  }
  return {
    ...(sourceType ? { sourceType } : {}),
    ...(publisherId ? { publisherId } : {}),
  };
}
