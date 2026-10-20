import { readJsonFile, writeJsonFile } from '../channels/json-file.js';
import { CollectorError, type YouTubePacingStatus } from '../core/types.js';

/** `interactive` requests (a channel preview the user waits for) go before queued background work. */
export type GatePriority = 'interactive' | 'background';

export type PacingEvent =
  | { type: 'rate_limited'; until: string; level: number; detail?: string }
  | { type: 'cooldown_ended' };

/** What jobs and HTTP routes read from the YouTube request channel. */
export interface YouTubePacing {
  status(): YouTubePacingStatus;
  /** Calls `listener` when a cooldown starts or ends; returns the function that stops it. */
  subscribe(listener: (event: PacingEvent) => void): () => void;
}

export interface WaitRange {
  min: number;
  max: number;
}

export interface CooldownPolicy {
  /** The first cooldown after a limit. */
  initialMs: number;
  /** Each further consecutive limit doubles the cooldown up to this. */
  maxMs: number;
  /** A limit this long after the previous one starts again from `initialMs`. */
  resetAfterMs: number;
}

export const DEFAULT_WAIT_RANGE: WaitRange = { min: 4_000, max: 12_000 };
export const DEFAULT_COOLDOWN: CooldownPolicy = { initialMs: 5 * 60_000, maxMs: 60 * 60_000, resetAfterMs: 2 * 60 * 60_000 };

export interface YouTubeGateOptions {
  waitRangeMs?: WaitRange;
  cooldown?: Partial<CooldownPolicy>;
  /** File that keeps the cooldown across restarts; null keeps it in memory only. */
  statePath?: string | null;
  now?: () => Date;
  /** Returns a number in [0, 1). */
  random?: () => number;
  /** Starts a timer and returns its cancel function. */
  setTimer?: (callback: () => void, ms: number) => () => void;
}

interface StoredPacing {
  cooldownUntil: string | null;
  level: number;
  lastLimitedAt: string | null;
}

interface Waiter {
  priority: GatePriority;
  start: () => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

/** Reads `XR_COLLECTOR_YOUTUBE_WAIT_MS=min,max` (milliseconds), used by tests and acceptance runs. */
export function waitRangeFromEnv(value: string | undefined): WaitRange | undefined {
  const match = /^\s*(\d+)\s*,\s*(\d+)\s*$/u.exec(value ?? '');
  if (!match) return undefined;
  const min = Number(match[1]);
  const max = Number(match[2]);
  return max >= min ? { min, max } : undefined;
}

/** Gate options a process takes from its environment; only acceptance runs and tests set them. */
export function youtubeGateOptionsFromEnv(env: NodeJS.ProcessEnv): Pick<YouTubeGateOptions, 'waitRangeMs'> {
  const waitRangeMs = waitRangeFromEnv(env.XR_COLLECTOR_YOUTUBE_WAIT_MS);
  return waitRangeMs ? { waitRangeMs } : {};
}

function clockTime(value: Date): string {
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

/**
 * The one channel every YouTube request of this process goes through. One request runs at a time;
 * consecutive requests are spaced by a random wait counted from the end of the previous request, so
 * the timing has no fixed rhythm. When YouTube limits requests, the channel cools down: nothing is
 * sent until the cooldown ends, and requests asked for meanwhile fail at once with `rate_limited`.
 * The cooldown starts at 5 minutes, doubles with each consecutive limit up to 60 minutes, and
 * starts over after a successful request or after 2 hours without a limit.
 */
export class YouTubeGate implements YouTubePacing {
  private readonly waitRange: WaitRange;
  private readonly cooldown: CooldownPolicy;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => () => void;
  private readonly queue: Waiter[] = [];
  private readonly listeners = new Set<(event: PacingEvent) => void>();
  private active = false;
  private lastEndedAt: number | null = null;
  /** The gap before the next request, drawn when the previous one ended. */
  private nextGapMs = 0;
  private cancelWaitTimer: (() => void) | null = null;
  private cancelCooldownTimer: (() => void) | null = null;
  private stored: StoredPacing = { cooldownUntil: null, level: 0, lastLimitedAt: null };
  private writing: Promise<void> = Promise.resolve();

  private constructor(private readonly options: YouTubeGateOptions) {
    this.waitRange = options.waitRangeMs ?? DEFAULT_WAIT_RANGE;
    this.cooldown = { ...DEFAULT_COOLDOWN, ...options.cooldown };
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  }

  /** Opens the channel with the cooldown its state file recorded; a missing or unreadable file starts fresh. */
  static async open(options: YouTubeGateOptions = {}): Promise<YouTubeGate> {
    const gate = new YouTubeGate(options);
    if (options.statePath) {
      try {
        const value = await readJsonFile(options.statePath) as Partial<StoredPacing> | undefined;
        if (value && typeof value === 'object') {
          gate.stored = {
            cooldownUntil: typeof value.cooldownUntil === 'string' && !Number.isNaN(Date.parse(value.cooldownUntil)) ? value.cooldownUntil : null,
            level: typeof value.level === 'number' && value.level >= 0 ? Math.floor(value.level) : 0,
            lastLimitedAt: typeof value.lastLimitedAt === 'string' ? value.lastLimitedAt : null,
          };
        }
      } catch (error) {
        console.warn('YouTube pacing state could not be read; starting without a cooldown.', error);
      }
    }
    gate.scheduleCooldownEnd();
    return gate;
  }

  status(): YouTubePacingStatus {
    const cooling = this.coolingUntil() !== null;
    return {
      state: cooling ? 'cooldown' : this.active ? 'busy' : this.queue.length > 0 ? 'waiting' : 'idle',
      cooldownUntil: cooling ? this.stored.cooldownUntil : null,
      level: this.stored.level,
      waitRangeMs: { ...this.waitRange },
    };
  }

  subscribe(listener: (event: PacingEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Runs one YouTube request when its turn comes. Aborting `signal` before the request starts
   * removes it from the queue and rejects with the signal's reason; a request already running
   * finishes. A `rate_limited` failure starts the cooldown and is rethrown with its end time.
   */
  run<T>(priority: GatePriority, request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const until = this.coolingUntil();
    if (until) return Promise.reject(this.limitedError(until));
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        reject,
        signal,
        onAbort: undefined,
        start: () => {
          this.active = true;
          void request().then((value) => {
            this.succeeded();
            this.ended();
            resolve(value);
          }, (error: unknown) => {
            const limited = error instanceof CollectorError && error.code === 'rate_limited' ? this.limited(error) : null;
            this.ended();
            reject(limited ?? error);
          });
        },
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(signal.reason);
          this.pump();
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      // Interactive requests go after earlier interactive ones and before all background work.
      const position = priority === 'interactive'
        ? this.queue.findIndex((candidate) => candidate.priority === 'background')
        : -1;
      if (position >= 0) this.queue.splice(position, 0, waiter);
      else this.queue.push(waiter);
      this.pump();
    });
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return;
    const until = this.coolingUntil();
    if (until) {
      for (const waiter of this.queue.splice(0)) this.drop(waiter, this.limitedError(until));
      return;
    }
    const delay = this.lastEndedAt === null ? 0 : this.lastEndedAt + this.nextGapMs - this.now().getTime();
    if (delay > 0) {
      if (!this.cancelWaitTimer) {
        this.cancelWaitTimer = this.setTimer(() => {
          this.cancelWaitTimer = null;
          this.pump();
        }, delay);
      }
      return;
    }
    this.cancelWaitTimer?.();
    this.cancelWaitTimer = null;
    const waiter = this.queue.shift()!;
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.start();
  }

  private drop(waiter: Waiter, reason: unknown): void {
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.reject(reason);
  }

  private ended(): void {
    this.active = false;
    this.lastEndedAt = this.now().getTime();
    const { min, max } = this.waitRange;
    this.nextGapMs = min + Math.floor(this.random() * (max - min + 1));
    this.pump();
  }

  private succeeded(): void {
    if (this.stored.level === 0) return;
    this.stored = { ...this.stored, level: 0 };
    this.persist();
  }

  /** Starts a cooldown after a limit and returns the error the request fails with. */
  private limited(error: CollectorError): CollectorError {
    const now = this.now();
    const last = this.stored.lastLimitedAt ? Date.parse(this.stored.lastLimitedAt) : Number.NaN;
    const fresh = Number.isNaN(last) || now.getTime() - last > this.cooldown.resetAfterMs;
    const level = fresh ? 1 : this.stored.level + 1;
    const duration = Math.min(this.cooldown.initialMs * 2 ** (level - 1), this.cooldown.maxMs);
    const until = new Date(now.getTime() + duration).toISOString();
    this.stored = { cooldownUntil: until, level, lastLimitedAt: now.toISOString() };
    this.persist();
    this.scheduleCooldownEnd();
    this.emit({ type: 'rate_limited', until, level, ...(error.detail ? { detail: error.detail } : {}) });
    return this.limitedError(until, error);
  }

  private limitedError(until: string, cause?: CollectorError): CollectorError {
    return new CollectorError('rate_limited', `YouTube 暫時限制連線，約 ${clockTime(new Date(until))} 後自動繼續。`, {
      retryAt: until,
      ...(cause ? { cause, ...(cause.detail ? { detail: cause.detail } : {}) } : {}),
    });
  }

  /** The end of the cooldown in force, or null. */
  private coolingUntil(): string | null {
    const until = this.stored.cooldownUntil;
    return until && Date.parse(until) > this.now().getTime() ? until : null;
  }

  private scheduleCooldownEnd(): void {
    this.cancelCooldownTimer?.();
    this.cancelCooldownTimer = null;
    const until = this.stored.cooldownUntil;
    if (!until) return;
    const remaining = Date.parse(until) - this.now().getTime();
    const end = () => {
      this.cancelCooldownTimer = null;
      this.stored = { ...this.stored, cooldownUntil: null };
      this.persist();
      this.emit({ type: 'cooldown_ended' });
      this.pump();
    };
    if (remaining <= 0) {
      // A cooldown that ended while the service was stopped ends silently.
      this.stored = { ...this.stored, cooldownUntil: null };
      this.persist();
      return;
    }
    this.cancelCooldownTimer = this.setTimer(end, remaining);
  }

  private emit(event: PacingEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch (error) { console.error('YouTube pacing listener failed', error); }
    }
  }

  private persist(): void {
    const statePath = this.options.statePath;
    if (!statePath) return;
    const value = { ...this.stored };
    this.writing = this.writing.then(() => writeJsonFile(statePath, value)).catch((error: unknown) => {
      console.error('YouTube pacing state could not be saved', error);
    });
  }

  /** Resolves once the state file reflects every change so far. */
  flush(): Promise<void> {
    return this.writing;
  }
}
