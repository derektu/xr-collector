import { vi } from 'vitest';

/**
 * How long a test waits for a state before it reports the state never came. The bound says when a
 * break is reported, not how long the work takes: an idle machine reaches every state these tests
 * wait for within a few hundred milliseconds, and a loaded one, with test files running in parallel
 * workers or x64 Node emulated on ARM64 Windows, may take several times longer.
 */
export const WAIT_LIMIT_MS = 10_000;

/**
 * Retries `check` until it stops throwing and returns its result. Tests wait through this for a
 * state the product reports only by being read; where the product or a test double offers a promise
 * or event for the moment, the test awaits that instead.
 */
export function eventually<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: WAIT_LIMIT_MS, interval: 20 });
}
