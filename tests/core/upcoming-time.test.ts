// When a coming time is shown as today, tomorrow or a later date, as the subscription status column
// and the tray's next check say it: a wrong day sends the user to look for a check that already ran
// or is a day away.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upcomingTime } from '../../src/core/upcoming-time.js';

describe('upcoming time', () => {
  const originalZone = process.env.TZ;
  beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
  afterEach(() => { process.env.TZ = originalZone; });

  it('tells a coming time by local day: today or already past, tomorrow, or a later date', () => {
    const now = new Date('2026-10-15T06:00:00.000Z'); // 14:00 in Taipei
    expect(upcomingTime('2026-10-15T10:52:00.000Z', now)).toEqual({ day: 'today', time: '18:52' });
    expect(upcomingTime('2026-10-15T15:59:00.000Z', now)).toEqual({ day: 'today', time: '23:59' });
    expect(upcomingTime('2026-10-14T23:00:00.000Z', now)).toEqual({ day: 'today', time: '07:00' });
    expect(upcomingTime('2026-10-12T01:00:00.000Z', now)).toEqual({ day: 'today', time: '09:00' });
    expect(upcomingTime('2026-10-15T16:00:00.000Z', now)).toEqual({ day: 'tomorrow', time: '00:00' });
    expect(upcomingTime('2026-10-16T15:59:00.000Z', now)).toEqual({ day: 'tomorrow', time: '23:59' });
    expect(upcomingTime('2026-10-16T16:30:00.000Z', now)).toEqual({ day: 'later', date: '10-17', time: '00:30' });
  });

  it('counts tomorrow across the end of a month and of a year', () => {
    const endOfMonth = new Date('2026-10-31T14:00:00.000Z'); // 10-31 22:00 in Taipei
    expect(upcomingTime('2026-10-31T16:30:00.000Z', endOfMonth)).toEqual({ day: 'tomorrow', time: '00:30' });
    expect(upcomingTime('2026-11-01T16:30:00.000Z', endOfMonth)).toEqual({ day: 'later', date: '11-02', time: '00:30' });
    const endOfYear = new Date('2026-12-31T14:00:00.000Z');
    expect(upcomingTime('2026-12-31T23:00:00.000Z', endOfYear)).toEqual({ day: 'tomorrow', time: '07:00' });
    expect(upcomingTime('2027-01-01T16:00:00.000Z', endOfYear)).toEqual({ day: 'later', date: '01-02', time: '00:00' });
  });
});
