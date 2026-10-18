import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backfillWindowStart,
  normalizeInterval,
  publishedSince,
} from '../../src/channels/collection-policy.js';

const originalZone = process.env.TZ;

function inZone(zone: string, run: () => void): void {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { run(); } finally { process.env.TZ = previous; }
}

describe('backfill time boundaries', () => {
  beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
  afterEach(() => { process.env.TZ = originalZone; });

  it('subtracts calendar months in local time and clamps to the earlier month\'s last day', () => {
    // 2026-03-31 09:30 in Taipei.
    const now = new Date('2026-03-31T01:30:00.000Z');
    expect(backfillWindowStart(now, '1m').toISOString()).toBe('2026-02-28T01:30:00.000Z');
    expect(backfillWindowStart(new Date('2028-03-31T01:30:00.000Z'), '1m').toISOString()).toBe('2028-02-29T01:30:00.000Z');
    expect(backfillWindowStart(now, '3m').toISOString()).toBe('2025-12-31T01:30:00.000Z');
    expect(backfillWindowStart(now, '6m').toISOString()).toBe('2025-09-30T01:30:00.000Z');
    // Early on the 1st in Taipei is still the previous day in UTC; the month is the local one.
    expect(backfillWindowStart(new Date('2026-02-28T17:00:00.000Z'), '1m').toISOString()).toBe('2026-01-31T17:00:00.000Z');
  });

  it('uses whole 7-day steps for weeks', () => {
    const now = new Date('2026-10-15T04:00:00.000Z');
    expect(backfillWindowStart(now, '1w').toISOString()).toBe('2026-10-08T04:00:00.000Z');
    expect(backfillWindowStart(now, '2w').toISOString()).toBe('2026-10-01T04:00:00.000Z');
  });

  it('applies the device time zone, not UTC, to the month boundary', () => {
    const now = new Date('2026-03-30T20:00:00.000Z'); // 31 March 04:00 in Taipei, 30 March in UTC.
    expect(backfillWindowStart(now, '1m').toISOString()).toBe('2026-02-27T20:00:00.000Z');
    inZone('UTC', () => {
      expect(backfillWindowStart(now, '1m').toISOString()).toBe('2026-02-28T20:00:00.000Z');
      expect(backfillWindowStart(new Date('2026-05-31T12:00:00.000Z'), '1m').toISOString()).toBe('2026-04-30T12:00:00.000Z');
    });
    expect(backfillWindowStart(new Date('2026-05-31T12:00:00.000Z'), '1m').toISOString()).toBe('2026-04-30T12:00:00.000Z');
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

describe('policy limits', () => {
  it('maps any stored interval to an offered one', () => {
    expect([1, 15, 16, 30, 45, 60, 61, 180, 200, 720, 1000, 1440, 10_080].map(normalizeInterval))
      .toEqual([15, 15, 30, 30, 60, 60, 180, 180, 360, 720, 1440, 1440, 1440]);
  });
});
