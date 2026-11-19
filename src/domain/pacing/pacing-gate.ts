import { readJsonFile, writeJsonFile } from '../../shared/lib/json-file.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { PacingStatus } from '../../shared/jobs/job-types.js';
import type { PacingDeclaration } from '../../shared/sources/source-contract.js';

export type GatePriority = 'interactive' | 'background';

export type PacingEvent =
  | { type: 'rate_limited'; until: string; level: number; detail?: string }
  | { type: 'cooldown_ended' };

export interface Pacing {
  readonly group: string;
  status(): PacingStatus;
  subscribe(listener: (event: PacingEvent) => void): () => void;
}

interface WaitRange {
  min: number;
  max: number;
}

interface CooldownPolicy {
  initialMs: number;
  maxMs: number;
  resetAfterMs: number;
}

const DEFAULT_COOLDOWN: CooldownPolicy = { initialMs: 5 * 60_000, maxMs: 60 * 60_000, resetAfterMs: 2 * 60 * 60_000 };

export interface PacingGateOptions {
  waitRangeMs?: WaitRange;
  cooldown?: Partial<CooldownPolicy>;
  statePath?: string | null;
  now?: () => Date;
  random?: () => number;
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

export function waitRangeFromEnv(value: string | undefined): WaitRange | undefined {
  const match = /^\s*(\d+)\s*,\s*(\d+)\s*$/u.exec(value ?? '');
  if (!match) return undefined;
  const min = Number(match[1]);
  const max = Number(match[2]);
  return max >= min ? { min, max } : undefined;
}

export function pacingOptionsFromEnv(declaration: PacingDeclaration, env: NodeJS.ProcessEnv): Pick<PacingGateOptions, 'waitRangeMs'> {
  const waitRangeMs = declaration.envVar ? waitRangeFromEnv(env[declaration.envVar]) : undefined;
  return waitRangeMs ? { waitRangeMs } : {};
}

export function pacingStateFile(group: string): string {
  return `${group}-pacing.json`;
}

function clockTime(value: Date): string {
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

export class PacingGate implements Pacing {
  readonly group: string;
  private readonly label: string;
  private readonly waitRange: WaitRange;
  private readonly cooldown: CooldownPolicy | null;
  private readonly statePath: string | null;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => () => void;
  private readonly queue: Waiter[] = [];
  private readonly listeners = new Set<(event: PacingEvent) => void>();
  private active = false;
  private lastEndedAt: number | null = null;
  private nextGapMs = 0;
  private cancelWaitTimer: (() => void) | null = null;
  private cancelCooldownTimer: (() => void) | null = null;
  private stored: StoredPacing = { cooldownUntil: null, level: 0, lastLimitedAt: null };
  private writing: Promise<void> = Promise.resolve();

  private constructor(declaration: PacingDeclaration, options: PacingGateOptions) {
    this.group = declaration.group;
    this.label = declaration.label;
    this.waitRange = options.waitRangeMs ?? declaration.waitRangeMs;
    this.cooldown = declaration.cooldown === false ? null : { ...DEFAULT_COOLDOWN, ...declaration.cooldown, ...options.cooldown };
    this.statePath = this.cooldown ? options.statePath ?? null : null;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  }

  static async open(declaration: PacingDeclaration, options: PacingGateOptions = {}): Promise<PacingGate> {
    const gate = new PacingGate(declaration, options);
    if (gate.statePath) {
      try {
        const value = await readJsonFile(gate.statePath) as Partial<StoredPacing> | undefined;
        if (value && typeof value === 'object') {
          gate.stored = {
            cooldownUntil: typeof value.cooldownUntil === 'string' && !Number.isNaN(Date.parse(value.cooldownUntil)) ? value.cooldownUntil : null,
            level: typeof value.level === 'number' && value.level >= 0 ? Math.floor(value.level) : 0,
            lastLimitedAt: typeof value.lastLimitedAt === 'string' ? value.lastLimitedAt : null,
          };
        }
      } catch (error) {
        console.warn(`Pacing state of ${gate.group} could not be read; starting without a cooldown.`, error);
      }
    }
    gate.dropExpiredCooldown();
    gate.scheduleCooldownEnd();
    return gate;
  }

  status(): PacingStatus {
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
            const limited = this.cooldown && error instanceof CollectorError && error.code === 'rate_limited'
              ? this.limited(this.cooldown, error) : null;
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
      this.enqueue(waiter);
      this.pump();
    });
  }

  private enqueue(waiter: Waiter): void {
    const firstBackground = waiter.priority === 'interactive'
      ? this.queue.findIndex((candidate) => candidate.priority === 'background')
      : -1;
    if (firstBackground < 0) this.queue.push(waiter);
    else this.queue.splice(firstBackground, 0, waiter);
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

  private limited(cooldown: CooldownPolicy, error: CollectorError): CollectorError {
    const now = this.now();
    const last = this.stored.lastLimitedAt ? Date.parse(this.stored.lastLimitedAt) : Number.NaN;
    const fresh = Number.isNaN(last) || now.getTime() - last > cooldown.resetAfterMs;
    const level = fresh ? 1 : this.stored.level + 1;
    const duration = Math.min(cooldown.initialMs * 2 ** (level - 1), cooldown.maxMs);
    const until = new Date(now.getTime() + duration).toISOString();
    this.stored = { cooldownUntil: until, level, lastLimitedAt: now.toISOString() };
    this.persist();
    this.scheduleCooldownEnd();
    this.emit({ type: 'rate_limited', until, level, ...(error.detail ? { detail: error.detail } : {}) });
    return this.limitedError(until, error);
  }

  private limitedError(until: string, cause?: CollectorError): CollectorError {
    return new CollectorError('rate_limited', `${this.label} 暫時限制連線，約 ${clockTime(new Date(until))} 後自動繼續。`, {
      retryAt: until,
      ...(cause ? { cause, ...(cause.detail ? { detail: cause.detail } : {}) } : {}),
    });
  }

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
    this.cancelCooldownTimer = this.setTimer(end, remaining);
  }

  private dropExpiredCooldown(): void {
    if (!this.stored.cooldownUntil || this.coolingUntil()) return;
    this.stored = { ...this.stored, cooldownUntil: null };
    this.persist();
  }

  private emit(event: PacingEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch (error) { console.error(`Pacing listener of ${this.group} failed`, error); }
    }
  }

  private persist(): void {
    const statePath = this.statePath;
    if (!statePath) return;
    const value = { ...this.stored };
    this.writing = this.writing.then(() => writeJsonFile(statePath, value)).catch((error: unknown) => {
      console.error(`Pacing state of ${this.group} could not be saved`, error);
    });
  }

  flush(): Promise<void> {
    return this.writing;
  }
}
