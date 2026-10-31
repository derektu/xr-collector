import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentDay, watchDay } from '../../src/web/use-day.js';

describe('the day screens follow', () => {
  const timeZone = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = 'Asia/Taipei';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-24T23:59:00+08:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = timeZone;
  });

  it('changes at local midnight and tells each screen once a day', () => {
    const drawn: string[] = [];
    const stop = watchDay(() => drawn.push(currentDay()));
    expect(currentDay()).toBe(new Date('2026-10-24T23:59:00+08:00').toDateString());
    vi.advanceTimersByTime(59_000);
    expect(drawn).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(drawn).toEqual([new Date('2026-10-25T00:00:01+08:00').toDateString()]);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(drawn).toHaveLength(2);
    stop();
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(drawn).toHaveLength(2);
  });

  it('reads the date again when a screen starts following after the timer stopped', () => {
    watchDay(() => undefined)();
    vi.setSystemTime(new Date('2026-10-26T09:00:00+08:00'));
    const stop = watchDay(() => undefined);
    expect(currentDay()).toBe(new Date('2026-10-26T09:00:00+08:00').toDateString());
    stop();
  });
});
