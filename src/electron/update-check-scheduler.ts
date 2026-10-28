const STARTUP_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface UpdateCheckSchedulerOptions {
  check(): Promise<unknown>;
  lastAttemptAt(): string | null;
  available(): boolean;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

/** Schedules one startup check and at most one check per 24 hours, including wake events after failures. */
export function startUpdateCheckScheduler(options: UpdateCheckSchedulerOptions): { wake(): Promise<boolean>; stop(): void } {
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  const startedAt = now();
  let stopped = false;
  let running: Promise<unknown> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const attempt = async (): Promise<boolean> => {
    if (stopped || !options.available() || running) return false;
    running = options.check();
    try { await running; } finally { running = null; if (!stopped) arm(CHECK_INTERVAL_MS); }
    return true;
  };
  const arm = (delay: number, startup = false) => {
    if (timer) cancel(timer);
    timer = schedule(() => {
      timer = null;
      const lastAttempt = attemptTime();
      // Every process gets its promised startup check. Only an attempt made
      // during this same process suppresses the duplicate 30-second check.
      if (startup && (lastAttempt === null || lastAttempt < startedAt)) {
        void attempt().catch(() => {});
        return;
      }
      const remaining = dueIn();
      if (remaining > 0) { arm(remaining); return; }
      void attempt().catch(() => {});
    }, delay);
  };
  const attemptTime = (): number | null => {
    const value = options.lastAttemptAt();
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const dueIn = () => {
    const value = attemptTime();
    if (value === null) return 0;
    return Math.max(0, CHECK_INTERVAL_MS - (now() - value));
  };

  arm(STARTUP_DELAY_MS, true);
  return {
    wake: async () => dueIn() === 0 ? attempt() : false,
    stop: () => { stopped = true; if (timer) cancel(timer); timer = null; },
  };
}

export const updateCheckTiming = { startupDelayMs: STARTUP_DELAY_MS, intervalMs: CHECK_INTERVAL_MS };
