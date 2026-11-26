/**
 * Starts and cancels timers. A module that needs time takes one from its caller, so a test hands it
 * timers the test fires itself.
 */
export interface Timers {
  /** Runs `run` once after `ms`; the returned function cancels it. */
  after(ms: number, run: () => void): () => void;
  /** Runs `run` every `ms`; the returned function stops it. */
  every(ms: number, run: () => void): () => void;
}

type Handle = ReturnType<typeof setTimeout>;

// External: In Node a pending timer keeps the process running until `unref()` is called on it; browsers
// return a number with no such method. https://nodejs.org/docs/latest-v22.x/api/timers.html#timeoutunref
function unref(handle: Handle): void {
  const timer: unknown = handle;
  if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') timer.unref();
}

function timers(keepAlive: boolean): Timers {
  const started = (handle: Handle) => {
    if (!keepAlive) unref(handle);
    return handle;
  };
  return {
    after(ms, run) {
      const handle = started(setTimeout(run, ms));
      return () => clearTimeout(handle);
    },
    every(ms, run) {
      const handle = started(setInterval(run, ms));
      return () => clearInterval(handle);
    },
  };
}

/** The platform's timers. A pending one keeps a Node process running. */
export const systemTimers: Timers = timers(true);

/** The platform's timers, except that a pending one does not keep a Node process running. */
export const backgroundTimers: Timers = timers(false);

/**
 * A signal that aborts after `ms` with `reason`, or with a `TimeoutError` `DOMException` as
 * `AbortSignal.timeout` does. Its timer does not keep a Node process running.
 */
export function deadline(ms: number, reason?: unknown): AbortSignal {
  const controller = new AbortController();
  backgroundTimers.after(ms, () => controller.abort(reason ?? new DOMException('The operation timed out.', 'TimeoutError')));
  return controller.signal;
}

/** How `waitUntil` polls. */
export interface WaitUntilOptions {
  /** Milliseconds between two checks. */
  interval: number;
  /** Milliseconds after the first check when waiting gives up; one last check runs at that moment. */
  timeout: number;
  /** Names what is awaited in the error thrown when waiting gives up. */
  label: string;
  /**
   * Says which errors a check throws while the awaited state is not there yet. Such an error counts
   * as "not yet", and when waiting gives up the last one is thrown as it is. Any other error ends the
   * wait at once. Without it, every error ends the wait.
   */
  retryOn?: (error: unknown) => boolean;
}

type Falsy = false | 0 | '' | null | undefined;

/**
 * Checks an outside state every `interval` until `check` returns a truthy value, and returns that
 * value. After `timeout` it throws an error naming `label`, or the last error `retryOn` accepted.
 * There is no plain sleep: code waits for a state, an event or a promise, never for time alone.
 */
export async function waitUntil<T>(check: () => T | Falsy | Promise<T | Falsy>, options: WaitUntilOptions): Promise<T> {
  const end = Date.now() + options.timeout;
  let retried: { error: unknown } | null = null;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
      retried = null;
    } catch (error) {
      if (!options.retryOn?.(error)) throw error;
      retried = { error };
    }
    const remaining = end - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => { systemTimers.after(Math.min(options.interval, remaining), resolve); });
  }
  if (retried) throw retried.error;
  throw new Error(`Timed out after ${options.timeout} ms waiting for ${options.label}`);
}
