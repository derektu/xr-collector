/**
 * Resolves after `ms`. Only a retry loop that counts its attempts and lets its caller replace the
 * pause uses it; everything else waits for a state through `waitFor`.
 */
export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The error `waitFor` throws when the awaited state does not come in time. */
export class WaitTimeout extends Error {}

/**
 * Checks `check` every `interval` ms until it returns a truthy value, and returns that value. An
 * error `retryOn(error)` accepts counts as "not yet"; any other error ends the wait at once. After
 * `timeout` ms, with one last check at that moment, it throws the last error `retryOn` accepted, or
 * a `WaitTimeout` naming `label`.
 */
export async function waitFor(check, label, { timeout = 60_000, interval = 200, retryOn = () => false } = {}) {
  const end = Date.now() + timeout;
  let retried = null;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
      retried = null;
    } catch (error) {
      if (!retryOn(error)) throw error;
      retried = { error };
    }
    const remaining = end - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(interval, remaining));
  }
  if (retried) throw retried.error;
  throw new WaitTimeout(`Timed out after ${timeout} ms waiting for ${label}`);
}

/**
 * A signal that aborts after `ms` with `reason`, or with a `TimeoutError` `DOMException` as
 * `AbortSignal.timeout` does. Its timer does not keep the process running.
 */
export function deadline(ms, reason = new DOMException('The operation timed out.', 'TimeoutError')) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(reason), ms).unref();
  return controller.signal;
}

/**
 * Settles like the first of `promises` to settle, or with `onTimeout` after `ms`. The timer is
 * cleared either way, so a race that ended early never keeps the process alive.
 */
export async function raceWithTimeout(promises, ms, onTimeout) {
  let timer;
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout), ms); });
  try {
    return await Promise.race([...promises, limit]);
  } finally {
    clearTimeout(timer);
  }
}
