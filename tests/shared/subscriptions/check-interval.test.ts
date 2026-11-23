import { describe, expect, it } from 'vitest';
import { intervalLabel } from '../../../src/shared/subscriptions/check-interval.js';

describe('check interval label', () => {
  it('names a day 每天, whole hours in hours and other intervals in minutes', () => {
    expect(intervalLabel(1440)).toBe('每天');
    expect(intervalLabel(60)).toBe('每 1 小時');
    expect(intervalLabel(180)).toBe('每 3 小時');
    expect(intervalLabel(2880)).toBe('每 48 小時');
    expect(intervalLabel(30)).toBe('每 30 分鐘');
    expect(intervalLabel(90)).toBe('每 90 分鐘');
  });
});
