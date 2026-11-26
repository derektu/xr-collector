// Broken, a subscription's next check or retry, or the tray's next check, shows the wrong day or time around midnight or
// the end of a month or year.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upcomingTime, upcomingTimeText } from '../../../src/shared/subscriptions/upcoming-time.js';

describe('upcoming time', () => {
  const originalZone = process.env.TZ;
  beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
  afterEach(() => { process.env.TZ = originalZone; });

  it('tells a coming time by local day: today or already past, tomorrow, or a later date', () => {
    const taipei1400 = new Date('2026-10-15T06:00:00.000Z');
    expect(upcomingTime('2026-10-15T10:52:00.000Z', taipei1400)).toEqual({ day: 'today', time: '18:52' });
    expect(upcomingTime('2026-10-15T15:59:00.000Z', taipei1400)).toEqual({ day: 'today', time: '23:59' });
    expect(upcomingTime('2026-10-14T23:00:00.000Z', taipei1400)).toEqual({ day: 'today', time: '07:00' });
    expect(upcomingTime('2026-10-12T01:00:00.000Z', taipei1400)).toEqual({ day: 'today', time: '09:00' });
    expect(upcomingTime('2026-10-15T16:00:00.000Z', taipei1400)).toEqual({ day: 'tomorrow', time: '00:00' });
    expect(upcomingTime('2026-10-16T15:59:00.000Z', taipei1400)).toEqual({ day: 'tomorrow', time: '23:59' });
    expect(upcomingTime('2026-10-16T16:30:00.000Z', taipei1400)).toEqual({ day: 'later', date: '10-17', time: '00:30' });
  });

  it('counts tomorrow across the end of a month and of a year', () => {
    const endOfMonth = new Date('2026-10-31T14:00:00.000Z');
    expect(upcomingTime('2026-10-31T16:30:00.000Z', endOfMonth)).toEqual({ day: 'tomorrow', time: '00:30' });
    expect(upcomingTime('2026-11-01T16:30:00.000Z', endOfMonth)).toEqual({ day: 'later', date: '11-02', time: '00:30' });
    const endOfYear = new Date('2026-12-31T14:00:00.000Z');
    expect(upcomingTime('2026-12-31T23:00:00.000Z', endOfYear)).toEqual({ day: 'tomorrow', time: '07:00' });
    expect(upcomingTime('2027-01-01T16:00:00.000Z', endOfYear)).toEqual({ day: 'later', date: '01-02', time: '00:00' });
  });

  it("writes today's time alone, tomorrow with 明天 and a later day with its month and day", () => {
    expect(upcomingTimeText({ day: 'today', time: '18:52' })).toBe('18:52');
    expect(upcomingTimeText({ day: 'tomorrow', time: '08:00' })).toBe('明天 08:00');
    expect(upcomingTimeText({ day: 'later', date: '10-24', time: '08:00' })).toBe('10-24 08:00');
  });
});
