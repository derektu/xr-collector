import type { Timers } from '../../src/shared/lib/time.js';

/**
 * Timers whose one-shot timers the test starts itself. A repeating timer fails the test, since the
 * modules these tests drive never ask for one.
 */
export function timersAfter(after: Timers['after']): Timers {
  return { after, every: () => { throw new Error('This test hands out one-shot timers only.'); } };
}

export const stoppedTimers: Timers = { after: () => () => undefined, every: () => () => undefined };
