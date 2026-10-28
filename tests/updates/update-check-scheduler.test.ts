import { afterEach, expect, it, vi } from 'vitest';
import { startUpdateCheckScheduler, updateCheckTiming } from '../../src/electron/update-check-scheduler.js';

afterEach(() => vi.useRealTimers());

it('checks after 30 seconds, then waits 24 hours', async () => {
  vi.useFakeTimers();
  let lastAttempt: string | null = null;
  const check = vi.fn(async () => { lastAttempt = new Date(Date.now()).toISOString(); });
  const scheduler = startUpdateCheckScheduler({ check, lastAttemptAt: () => lastAttempt, available: () => true });
  await vi.advanceTimersByTimeAsync(updateCheckTiming.startupDelayMs - 1);
  expect(check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(updateCheckTiming.intervalMs - 1);
  expect(check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(check).toHaveBeenCalledTimes(2);
  scheduler.stop();
});

it('runs the startup check even when the previous process attempted an hour ago', async () => {
  vi.useFakeTimers();
  const start = new Date('2026-10-28T00:00:00.000Z'); vi.setSystemTime(start);
  let lastAttempt: string | null = new Date(start.getTime() - 60 * 60 * 1_000).toISOString();
  const check = vi.fn(async () => { lastAttempt = new Date(Date.now()).toISOString(); });
  const scheduler = startUpdateCheckScheduler({ check, lastAttemptAt: () => lastAttempt, available: () => true });
  await vi.advanceTimersByTimeAsync(updateCheckTiming.startupDelayMs);
  expect(check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(updateCheckTiming.intervalMs - 1);
  expect(check).toHaveBeenCalledTimes(1);
  scheduler.stop();
});

it('wake retries only when the last attempt is due, including after a failed check', async () => {
  vi.useFakeTimers();
  const now = new Date('2026-10-28T00:00:00.000Z');
  vi.setSystemTime(now);
  let lastAttempt = new Date(now.getTime() - updateCheckTiming.intervalMs).toISOString();
  const check = vi.fn(async () => { lastAttempt = new Date(Date.now()).toISOString(); throw new Error('offline'); });
  const scheduler = startUpdateCheckScheduler({ check, lastAttemptAt: () => lastAttempt, available: () => true });
  await expect(scheduler.wake()).rejects.toThrow('offline');
  expect(check).toHaveBeenCalledTimes(1);
  expect(await scheduler.wake()).toBe(false);
  vi.setSystemTime(new Date(now.getTime() + updateCheckTiming.intervalMs));
  await expect(scheduler.wake()).rejects.toThrow('offline');
  expect(check).toHaveBeenCalledTimes(2);
  scheduler.stop();
});

it('re-arms startup and interval timers from a newer manual attempt instead of checking early', async () => {
  vi.useFakeTimers();
  const start = new Date('2026-10-28T00:00:00.000Z'); vi.setSystemTime(start);
  let lastAttempt: string | null = null;
  const check = vi.fn(async () => undefined);
  const scheduler = startUpdateCheckScheduler({ check, lastAttemptAt: () => lastAttempt, available: () => true });
  lastAttempt = new Date(Date.now()).toISOString(); // manual check before the startup timer
  await vi.advanceTimersByTimeAsync(updateCheckTiming.startupDelayMs);
  expect(check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(updateCheckTiming.intervalMs - updateCheckTiming.startupDelayMs);
  expect(check).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date(Date.now() + updateCheckTiming.intervalMs - 60 * 60 * 1_000));
  lastAttempt = new Date(Date.now()).toISOString(); // manual check one hour before the old timer
  await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
  expect(check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(updateCheckTiming.intervalMs - 60 * 60 * 1_000);
  expect(check).toHaveBeenCalledTimes(2);
  scheduler.stop();
});

it('contains a rejected timer check and continues scheduling', async () => {
  vi.useFakeTimers();
  let attempts = 0; let lastAttempt: string | null = null;
  const scheduler = startUpdateCheckScheduler({ check: async () => { attempts += 1; lastAttempt = new Date(Date.now()).toISOString(); throw new Error('save failed'); },
    lastAttemptAt: () => lastAttempt, available: () => true });
  await vi.advanceTimersByTimeAsync(updateCheckTiming.startupDelayMs);
  expect(attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(updateCheckTiming.intervalMs);
  expect(attempts).toBe(2);
  scheduler.stop();
});
