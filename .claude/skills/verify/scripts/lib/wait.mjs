export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `check` until it returns a truthy value and returns that value. A throw counts as "not yet"
 * unless `fatal(error)` says otherwise. Fails with `label` after `timeout` ms.
 */
export async function waitFor(check, label, { timeout = 60_000, interval = 200, fatal = () => false } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      if (fatal(error)) throw error;
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out after ${timeout} ms waiting for ${label}${last ? ` (last error: ${last.message})` : ''}`);
}
