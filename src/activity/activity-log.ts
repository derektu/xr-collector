import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { eventSpec } from '../core/event-catalog.js';
import type { ActivityLogHealth, EventRecorder, JobEvent, NewJobEvent } from '../core/activity-types.js';
import { limitText, redact } from '../core/redact.js';

/** Activity is kept this many days and then removed. */
export const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const PURGE_INTERVAL_MS = 3_600_000;
/** Recorded events wait this long in memory and are then written together. */
const FLUSH_INTERVAL_MS = 1_000;
/** A failed write is tried again after this wait; events recorded meanwhile only join the queue. */
const RETRY_WRITE_MS = 30_000;
/** Events kept in memory while the log cannot be written; older ones beyond this are dropped. */
const PENDING_LIMIT = 1000;
const MESSAGE_LIMIT = 500;
const DETAIL_LIMIT = 2000;
const TITLE_LIMIT = 300;
/** An event ID is its sequence number in this many digits, then a random UUID. */
const SEQUENCE_DIGITS = 12;
const SEQUENCE = /^(\d{12})-/u;

const SEGMENT_DIRECTORY = 'events';
const SEGMENT_NAME = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;

export interface ActivityLogOptions {
  now?: () => Date;
  /** Starts a timer and returns its cancel function; purges, writes and write retries wait through it. */
  setTimer?: (callback: () => void, ms: number) => () => void;
  /** Appends text to a file; replaced in tests to make writes fail. */
  append?: (file: string, data: string) => Promise<void>;
  /** Called for each event dropped because too many events waited to be written. */
  onDropped?: (event: JobEvent) => void;
  /** Called after each event `event()` records, once readers can see it. */
  onRecorded?: (event: JobEvent) => void;
}

/**
 * Which Vault's activity a query reads: one Vault (with Vault-less events), or every event when
 * `vaultPath` is null. An event that carries a Vault ID belongs to the Vault with that ID wherever it
 * was recorded; an event without one belongs to the Vault at its path. `vaultId` null means the
 * Vault has no ID, so events of Vaults with IDs are not its own; leaving it out compares paths only.
 */
export interface ActivityScope {
  vaultPath: string | null;
  vaultId?: string | null;
}

function inScope(event: JobEvent, scope: ActivityScope): boolean {
  if (scope.vaultPath === null || event.vaultPath === null) return true;
  if (scope.vaultId !== undefined && event.vaultId) return event.vaultId === scope.vaultId;
  return event.vaultPath === scope.vaultPath;
}

interface CachedFile {
  size: number;
  events: JobEvent[];
  /** Bytes after the last newline; the rest of a line still being written. */
  rest: Buffer;
  skipped: number;
}

/**
 * The device activity log: one JSONL file per UTC day under the profile, kept for 30 days. It only
 * stores and reads events; `ActivityViews` pages and summarizes them. Events are masked before they
 * reach disk and written once a second; events that cannot be written wait in memory, are retried,
 * and the log reports the failure instead of losing them silently. Unfinished job state lives in the
 * job store, so removing old activity never affects what a restart resumes.
 *
 * The log is the source of event IDs. An ID starts with a sequence number that orders events of the
 * same millisecond; opening the log continues from the highest sequence among the events it still
 * holds, so a restart neither repeats nor skips a number. Once retention has removed every event,
 * the sequence starts over at 1; the random part keeps those IDs unique.
 */
export class ActivityLog implements EventRecorder {
  readonly now: () => Date;
  private sequence = 0;
  private readonly setTimer: (callback: () => void, ms: number) => () => void;
  private readonly append: (file: string, data: string) => Promise<void>;
  private readonly memory: JobEvent[] = [];
  private pending: JobEvent[] = [];
  private writeTail: Promise<void> = Promise.resolve();
  private readonly cache = new Map<string, CachedFile>();
  private cancelPurge: (() => void) | null = null;
  private cancelFlush: (() => void) | null = null;
  private cancelRetry: (() => void) | null = null;
  private closed = false;
  private healthValue: Omit<ActivityLogHealth, 'pending' | 'skippedLines'> = {
    state: 'ok', dropped: 0, lastFailureAt: null, lastError: null,
  };

  private constructor(private readonly directory: string | null, private readonly options: ActivityLogOptions) {
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return () => clearTimeout(timer);
    });
    this.append = options.append ?? ((file, data) => appendFile(file, data, { encoding: 'utf8', mode: 0o600 }));
  }

  /** Keeps events in memory; for tests and runtimes without a device profile. */
  static memory(options: ActivityLogOptions = {}): ActivityLog {
    return new ActivityLog(null, options);
  }

  /**
   * Opens the log in `directory`, removes expired activity, continues the event sequence and purges
   * again every hour.
   */
  static async open(directory: string, options: ActivityLogOptions = {}): Promise<ActivityLog> {
    const log = new ActivityLog(directory, options);
    await log.purge();
    for (const event of await log.readAll()) {
      const sequence = SEQUENCE.exec(event.eventId)?.[1];
      if (sequence) log.sequence = Math.max(log.sequence, Number(sequence));
    }
    log.schedulePurge();
    return log;
  }

  /** Records an emitter's event under the next ID, at the current time. */
  event(entry: NewJobEvent): void {
    const eventId = `${String(++this.sequence).padStart(SEQUENCE_DIGITS, '0')}-${randomUUID()}`;
    const event: JobEvent = {
      ...entry, eventId, timestamp: this.now().toISOString(), severity: entry.severity ?? eventSpec(entry.eventType)!.severity,
    };
    this.record(event);
    this.options.onRecorded?.(event);
  }

  /** Stores an event that already has its ID and time. */
  record(entry: JobEvent): void {
    const event = this.sanitize(entry);
    if (!this.directory) {
      this.memory.push(event);
      return;
    }
    this.pending.push(event);
    while (this.pending.length > PENDING_LIMIT) {
      const dropped = this.pending.shift()!;
      this.healthValue.dropped += 1;
      this.options.onDropped?.(dropped);
    }
    if (this.closed) this.kick();
    else this.scheduleFlush();
  }

  /**
   * Writes the waiting events now and resolves once they are written or the attempt failed. While a
   * failed write waits for its retry, it resolves without trying again.
   */
  async flush(): Promise<void> {
    if (this.directory) this.kick();
    await this.writeTail;
  }

  health(): ActivityLogHealth {
    let skippedLines = 0;
    for (const file of this.cache.values()) skippedLines += file.skipped;
    return { ...this.healthValue, pending: this.pending.length, skippedLines };
  }

  /** Events older than this are past retention; reads leave them out even before a purge removes them. */
  retentionStart(): Date {
    return new Date(this.now().getTime() - RETENTION_DAYS * DAY_MS);
  }

  /** The retained events of `scope`, masked, in no particular order. */
  async read(scope: ActivityScope): Promise<JobEvent[]> {
    const cutoff = this.retentionStart().toISOString();
    return (await this.readAll())
      .filter((event) => event.timestamp >= cutoff && inScope(event, scope))
      .map((event) => this.sanitize(event));
  }

  /** Removes activity older than the retention period. Days are UTC; the boundary day is cut at read time. */
  async purge(): Promise<void> {
    if (!this.directory) {
      const cutoff = this.retentionStart().toISOString();
      const kept = this.memory.filter((event) => event.timestamp >= cutoff);
      this.memory.splice(0, this.memory.length, ...kept);
      return;
    }
    const cutoff = this.retentionStart();
    const segments = path.join(this.directory, SEGMENT_DIRECTORY);
    let names: string[] = [];
    try {
      names = await readdir(segments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const name of names) {
      const day = SEGMENT_NAME.exec(name)?.[1];
      if (!day || Date.parse(`${day}T00:00:00.000Z`) + DAY_MS > cutoff.getTime()) continue;
      const file = path.join(segments, name);
      await rm(file, { force: true });
      this.cache.delete(file);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelPurge?.();
    this.cancelFlush?.();
    this.cancelFlush = null;
    this.cancelRetry?.();
    this.cancelRetry = null;
    await this.flush();
  }

  private schedulePurge(): void {
    if (this.closed) return;
    this.cancelPurge = this.setTimer(() => {
      void this.purge().catch((error: unknown) => console.error('Activity log purge failed', error))
        .finally(() => this.schedulePurge());
    }, PURGE_INTERVAL_MS);
  }

  private scheduleFlush(): void {
    if (this.cancelFlush || this.cancelRetry) return;
    this.cancelFlush = this.setTimer(() => {
      this.cancelFlush = null;
      this.kick();
    }, FLUSH_INTERVAL_MS);
  }

  private kick(): void {
    this.writeTail = this.writeTail.then(() => this.drain());
  }

  /**
   * Writes waiting events in order, one run of same-day events at a time, and stops at the first
   * failure. Nothing is written while a failed write waits for its retry.
   */
  private async drain(): Promise<void> {
    if (this.cancelRetry) return;
    const directory = path.join(this.directory!, SEGMENT_DIRECTORY);
    while (this.pending.length > 0) {
      const day = this.pending[0]!.timestamp.slice(0, 10);
      let count = 0;
      while (count < this.pending.length && this.pending[count]!.timestamp.slice(0, 10) === day) count += 1;
      const batch = this.pending.slice(0, count);
      try {
        await mkdir(directory, { recursive: true });
        const file = path.join(directory, `${day}.jsonl`);
        // A failed append can leave half a line; the next one starts on a fresh line so that the
        // half line stays a single unreadable line and the events after it remain readable.
        const separator = await endsMidLine(file) ? '\n' : '';
        await this.append(file, separator + batch.map((event) => `${JSON.stringify(event)}\n`).join(''));
      } catch (error) {
        this.healthValue = {
          ...this.healthValue,
          state: 'failing',
          lastFailureAt: this.now().toISOString(),
          lastError: redact(error instanceof Error ? error.message : String(error)),
        };
        console.error('Activity log write failed', error);
        this.scheduleRetry();
        return;
      }
      // Events dropped while the batch was written left the front of the queue already.
      const written = new Set(batch.map((event) => event.eventId));
      this.pending = this.pending.filter((event) => !written.has(event.eventId));
    }
    this.healthValue = { ...this.healthValue, state: 'ok' };
  }

  private scheduleRetry(): void {
    this.cancelFlush?.();
    this.cancelFlush = null;
    if (this.closed || this.cancelRetry) return;
    this.cancelRetry = this.setTimer(() => {
      this.cancelRetry = null;
      this.kick();
    }, RETRY_WRITE_MS);
  }

  /** Every stored event plus the ones still waiting to be written, each once. */
  private async readAll(): Promise<JobEvent[]> {
    if (!this.directory) return [...this.memory];
    const files: string[] = [];
    try {
      const names = (await readdir(path.join(this.directory, SEGMENT_DIRECTORY))).filter((name) => SEGMENT_NAME.test(name)).sort();
      files.push(...names.map((name) => path.join(this.directory!, SEGMENT_DIRECTORY, name)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const seen = new Set<string>();
    const events: JobEvent[] = [];
    const add = (event: JobEvent) => {
      if (seen.has(event.eventId)) return;
      seen.add(event.eventId);
      events.push(event);
    };
    for (const file of files) for (const event of await this.readFile(file)) add(event);
    for (const event of this.pending) add(event);
    return events;
  }

  /** Reads a log file, parsing only what was appended since the last read. */
  private async readFile(file: string): Promise<JobEvent[]> {
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.cache.delete(file);
      return [];
    }
    let cached = this.cache.get(file);
    if (!cached || size < cached.size) cached = { size: 0, events: [], rest: Buffer.alloc(0), skipped: 0 };
    if (size > cached.size) {
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(size - cached.size);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, cached.size);
        const data = Buffer.concat([cached.rest, buffer.subarray(0, bytesRead)]);
        const end = data.lastIndexOf(0x0a);
        const complete = end >= 0 ? data.subarray(0, end).toString('utf8') : '';
        const events = [...cached.events];
        let skipped = cached.skipped;
        for (const line of end >= 0 ? complete.split('\n') : []) {
          if (line.trim() === '') continue;
          const event = parseEvent(line);
          if (event) events.push(event);
          else skipped += 1;
        }
        cached = { size: cached.size + bytesRead, events, rest: end >= 0 ? data.subarray(end + 1) : data, skipped };
      } finally {
        await handle.close();
      }
    }
    this.cache.set(file, cached);
    return cached.events;
  }

  /** Masks and shortens free text; stored events are masked again when read, so a secret protected after they were written stays hidden. */
  private sanitize(event: JobEvent): JobEvent {
    const result: JobEvent = { ...event, message: limitText(redact(event.message), MESSAGE_LIMIT, 'head') };
    if (event.detail !== undefined) result.detail = limitText(redact(event.detail), DETAIL_LIMIT, 'tail');
    if (event.sourceTitle !== undefined) result.sourceTitle = limitText(event.sourceTitle, TITLE_LIMIT, 'head');
    return result;
  }
}

/** A stored line as an event; null for a line that is not one, or whose kind the event catalog does not list. */
function parseEvent(line: string): JobEvent | null {
  try {
    const value = JSON.parse(line) as Partial<JobEvent> | null;
    if (!value || typeof value !== 'object' || typeof value.eventId !== 'string' || typeof value.timestamp !== 'string'
      || typeof value.eventType !== 'string' || typeof value.message !== 'string' || Number.isNaN(Date.parse(value.timestamp))) return null;
    const spec = eventSpec(value.eventType);
    if (!spec) return null;
    return {
      ...value,
      severity: value.severity === 'debug' || value.severity === 'info' || value.severity === 'warning' || value.severity === 'error'
        ? value.severity : spec.severity,
      vaultPath: typeof value.vaultPath === 'string' ? value.vaultPath : null,
      ...(typeof value.vaultId === 'string' ? { vaultId: value.vaultId } : { vaultId: undefined }),
      jobId: typeof value.jobId === 'string' ? value.jobId : null,
      // Timestamps compare as text, so every one is stored in the same UTC form.
      timestamp: new Date(value.timestamp).toISOString(),
    } as JobEvent;
  } catch {
    return null;
  }
}

/** True when `file` exists and its last byte is not a line break. */
async function endsMidLine(file: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}
