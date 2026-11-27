const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lets `ms` pass while a flow watches for something that must not happen in that window, such as a
 * screen reading on a timer. Only such a named observation window waits on time; every other wait
 * is for a state, through `waitFor`.
 */
export const observeFor = (ms) => sleep(ms);

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

/**
 * Checks `check` every `interval` ms until it returns a truthy value and returns that value; it
 * checks at least once, even with a `timeout` of 0. A throw counts as "not yet" unless
 * `fatal(error)` says otherwise. Fails with `label` after `timeout` ms.
 */
export async function waitFor(check, label, { timeout = 60_000, interval = 200, fatal = () => false } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      if (fatal(error)) throw error;
      last = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(interval);
  }
  throw new Error(`Timed out after ${timeout} ms waiting for ${label}${last ? ` (last error: ${last.message})` : ''}`);
}
