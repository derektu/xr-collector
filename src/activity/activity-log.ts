import { createHash } from 'node:crypto';
import { jobRole } from '../core/source-registry.js';
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CollectorError,
  type ActivityLogHealth,
  type ActivityPage,
  type ActivityQuery,
  type CollectionJob,
  type JobEvent,
} from '../core/types.js';
import { limitText, redact } from './redact.js';

/** Activity is kept this many days and then removed. */
export const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const PURGE_INTERVAL_MS = 3_600_000;
/** A failed write is tried again after this wait, even when no new event arrives. */
const RETRY_WRITE_MS = 30_000;
/** Events kept in memory while the log cannot be written; older ones beyond this are dropped. */
const PENDING_LIMIT = 1000;
const MESSAGE_LIMIT = 500;
const DETAIL_LIMIT = 2000;
const TITLE_LIMIT = 300;
const DEFAULT_LIMIT = 50;

const SEGMENT_DIRECTORY = 'events';
/** The single log file of earlier versions; read with the segments and pruned the same way. */
const LEGACY_FILE = 'events.jsonl';
const SEGMENT_NAME = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;

export interface ActivityLogOptions {
  now?: () => Date;
  /** Starts a timer and returns its cancel function; purges and write retries wait through it. */
  setTimer?: (callback: () => void, ms: number) => () => void;
  /** Appends text to a file; replaced in tests to make writes fail. */
  append?: (file: string, data: string) => Promise<void>;
  /** Called for each event dropped because too many events waited to be written. */
  onDropped?: (event: JobEvent) => void;
  /** Looks up the job an event belongs to, to fill in titles and parents older entries lack. */
  lookupJob?: (id: string) => CollectionJob | undefined;
}

/**
 * Which Vault's activity a query reads: one Vault (with Vault-less events), or every event when
 * `vaultPath` is null. An event that carries a Vault ID belongs to the Vault with that ID wherever it
 * was recorded; an event without one belongs to the Vault at its path, which includes the locations
 * the Vault was moved from (`previousPaths`). `vaultId` null means the Vault has no ID, so events of
 * Vaults with IDs are not its own; leaving it out compares paths only.
 */
export interface ActivityScope {
  vaultPath: string | null;
  vaultId?: string | null;
  previousPaths?: readonly string[];
}

function inScope(event: JobEvent, scope: ActivityScope): boolean {
  if (scope.vaultPath === null || event.vaultPath === null) return true;
  if (scope.vaultId !== undefined && event.vaultId) return event.vaultId === scope.vaultId;
  return event.vaultPath === scope.vaultPath || (scope.previousPaths ?? []).includes(event.vaultPath);
}

interface CachedFile {
  size: number;
  events: JobEvent[];
  /** Bytes after the last newline; the rest of a line still being written. */
  rest: Buffer;
  skipped: number;
}

/**
 * The device activity log: one JSONL file per UTC day under the profile, kept for 30 days. Events
 * are masked before they reach disk; events that cannot be written wait in memory, are retried,
 * and the log reports the failure instead of losing them silently. Unfinished job state lives in
 * the job store, so removing old activity never affects what a restart resumes.
 */
export class ActivityLog {
  private readonly now: () => Date;
  private readonly setTimer: (callback: () => void, ms: number) => () => void;
  private readonly append: (file: string, data: string) => Promise<void>;
  private readonly secrets = new Set<string>();
  private readonly memory: JobEvent[] = [];
  private pending: JobEvent[] = [];
  private writeTail: Promise<void> = Promise.resolve();
  private readonly cache = new Map<string, CachedFile>();
  private cancelPurge: (() => void) | null = null;
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

  /** Opens the log in `directory`, removes expired activity and purges again every hour. */
  static async open(directory: string, options: ActivityLogOptions = {}): Promise<ActivityLog> {
    const log = new ActivityLog(directory, options);
    await log.purge();
    log.schedulePurge();
    return log;
  }

  /** A value masked wherever it appears in an event, such as the Agent token. */
  protectSecret(secret: string): void {
    this.secrets.add(secret);
  }

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
    this.kick();
  }

  /** Resolves once every recorded event was written or the latest attempt failed. */
  async flush(): Promise<void> {
    await this.writeTail;
  }

  health(): ActivityLogHealth {
    let skippedLines = 0;
    for (const file of this.cache.values()) skippedLines += file.skipped;
    return { ...this.healthValue, pending: this.pending.length, skippedLines };
  }

  async query(request: ActivityQuery, scope: ActivityScope): Promise<ActivityPage> {
    // Bounds compare as text against stored UTC timestamps, so they take the same form.
    const query: ActivityQuery = {
      ...request,
      ...(request.since ? { since: new Date(request.since).toISOString() } : {}),
      ...(request.until ? { until: new Date(request.until).toISOString() } : {}),
    };
    const limit = query.limit ?? DEFAULT_LIMIT;
    const filterKey = filterHash(query);
    const after = query.cursor ? decodeCursor(query.cursor, filterKey) : null;
    const cutoff = this.cutoff().toISOString();
    const jobLinks = new Map<string, CollectionJob | undefined>();
    const lookup = (id: string) => {
      if (!jobLinks.has(id)) jobLinks.set(id, this.options.lookupJob?.(id));
      return jobLinks.get(id);
    };
    const matches: JobEvent[] = [];
    for (const stored of await this.readAll()) {
      if (stored.timestamp < cutoff) continue;
      if (!inScope(stored, scope)) continue;
      const event = this.enrich(stored, lookup);
      if (!matchesQuery(event, query, lookup)) continue;
      if (after && compareEvents(event, after) >= 0) continue;
      matches.push(event);
    }
    matches.sort((a, b) => compareEvents(b, a));
    const events = matches.slice(0, limit);
    const last = events[events.length - 1];
    return {
      events,
      nextCursor: matches.length > limit && last ? encodeCursor(last, filterKey) : null,
      retentionDays: RETENTION_DAYS,
      log: this.health(),
    };
  }

  /** Removes activity older than the retention period. Days are UTC; the boundary day is cut at query time. */
  async purge(): Promise<void> {
    if (!this.directory) {
      const cutoff = this.cutoff().toISOString();
      const kept = this.memory.filter((event) => event.timestamp >= cutoff);
      this.memory.splice(0, this.memory.length, ...kept);
      return;
    }
    const cutoff = this.cutoff();
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
    await this.pruneLegacy(cutoff.toISOString());
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelPurge?.();
    this.cancelRetry?.();
    await this.flush();
  }

  private cutoff(): Date {
    return new Date(this.now().getTime() - RETENTION_DAYS * DAY_MS);
  }

  private schedulePurge(): void {
    if (this.closed) return;
    this.cancelPurge = this.setTimer(() => {
      void this.purge().catch((error: unknown) => console.error('Activity log purge failed', error))
        .finally(() => this.schedulePurge());
    }, PURGE_INTERVAL_MS);
  }

  private kick(): void {
    this.writeTail = this.writeTail.then(() => this.drain());
  }

  /** Writes waiting events in order, one run of same-day events at a time, and stops at the first failure. */
  private async drain(): Promise<void> {
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
          lastError: redact(error instanceof Error ? error.message : String(error), this.secrets),
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
    if (this.closed || this.cancelRetry) return;
    this.cancelRetry = this.setTimer(() => {
      this.cancelRetry = null;
      this.kick();
    }, RETRY_WRITE_MS);
  }

  /** Every stored event plus the ones still waiting to be written, each once. */
  private async readAll(): Promise<JobEvent[]> {
    if (!this.directory) return [...this.memory];
    const files = [path.join(this.directory, LEGACY_FILE)];
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

  /** Keeps the lines of the earlier single log file that are still within the retention period. */
  private async pruneLegacy(cutoff: string): Promise<void> {
    const file = path.join(this.directory!, LEGACY_FILE);
    let contents: string;
    try {
      contents = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const lines = contents.split('\n').filter((line) => line.trim() !== '');
    // Unreadable lines stay, so the skipped count keeps reporting them until the file expires.
    const kept = lines.filter((line) => {
      const event = parseEvent(line);
      return event === null || event.timestamp >= cutoff;
    });
    if (kept.length === lines.length) return;
    this.cache.delete(file);
    if (!kept.some((line) => parseEvent(line) !== null)) {
      await rm(file, { force: true });
      return;
    }
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${kept.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Masks and shortens free text; events from older versions are masked again when read. */
  private sanitize(event: JobEvent): JobEvent {
    const result: JobEvent = { ...event, message: limitText(redact(event.message, this.secrets), MESSAGE_LIMIT, 'head') };
    if (event.detail !== undefined) result.detail = limitText(redact(event.detail, this.secrets), DETAIL_LIMIT, 'tail');
    if (event.sourceTitle !== undefined) result.sourceTitle = limitText(event.sourceTitle, TITLE_LIMIT, 'head');
    return result;
  }

  /** Fills in the title, parent, source type and subscription that entries written before they were recorded lack. */
  private enrich(stored: JobEvent, lookup: (id: string) => CollectionJob | undefined): JobEvent {
    const event = this.sanitize(stored);
    if (!event.subscriptionId && event.sourceId && event.eventType.startsWith('subscription.')) {
      event.subscriptionId = event.sourceId;
    }
    if (!event.jobId) return event;
    const job = lookup(event.jobId);
    if (!job) return event;
    if (!event.sourceTitle && job.source.title) event.sourceTitle = job.source.title;
    if (!event.parentJobId && job.parentId) event.parentJobId = job.parentId;
    if (!event.sourceType) event.sourceType = job.source.type;
    if (!event.subscriptionId) {
      const owner = job.parentId ? lookup(job.parentId) : job;
      const role = owner ? jobRole(owner.kind)?.role : undefined;
      if (role === 'check' && owner!.source.id) event.subscriptionId = owner!.source.id;
      else if (role === 'add' && owner!.result?.channelId) event.subscriptionId = owner!.result.channelId;
    }
    return event;
  }
}

function parseEvent(line: string): JobEvent | null {
  try {
    const value = JSON.parse(line) as Partial<JobEvent> | null;
    if (!value || typeof value !== 'object' || typeof value.eventId !== 'string' || typeof value.timestamp !== 'string'
      || typeof value.eventType !== 'string' || typeof value.message !== 'string' || Number.isNaN(Date.parse(value.timestamp))) return null;
    return {
      ...value,
      severity: value.severity === 'warning' || value.severity === 'error' ? value.severity : 'info',
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

function matchesQuery(event: JobEvent, query: ActivityQuery, lookup: (id: string) => CollectionJob | undefined): boolean {
  if (query.severity && !query.severity.includes(event.severity)) return false;
  if (query.eventType && !query.eventType.includes(event.eventType)) return false;
  if (query.subscriptionId && event.subscriptionId !== query.subscriptionId) return false;
  if (query.since && event.timestamp < query.since) return false;
  if (query.until && event.timestamp >= query.until) return false;
  if (query.jobId) {
    const id = query.jobId;
    const related = event.jobId === id || event.parentJobId === id || event.retryOf === id
      || (event.jobId !== null && lookup(event.jobId)?.parentId === id);
    if (!related) return false;
  }
  return true;
}

/** Newest-first order: timestamp, then event ID for entries of the same millisecond. */
function compareEvents(a: Pick<JobEvent, 'timestamp' | 'eventId'>, b: Pick<JobEvent, 'timestamp' | 'eventId'>): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  if (a.eventId === b.eventId) return 0;
  return a.eventId < b.eventId ? -1 : 1;
}

function filterHash(query: ActivityQuery): string {
  const normalized = {
    severity: query.severity ? [...query.severity].sort() : null,
    eventType: query.eventType ? [...query.eventType].sort() : null,
    jobId: query.jobId ?? null,
    subscriptionId: query.subscriptionId ?? null,
    since: query.since ?? null,
    until: query.until ?? null,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('base64url').slice(0, 12);
}

function encodeCursor(event: JobEvent, filter: string): string {
  return Buffer.from(JSON.stringify({ t: event.timestamp, id: event.eventId, f: filter })).toString('base64url');
}

function decodeCursor(cursor: string, filter: string): Pick<JobEvent, 'timestamp' | 'eventId'> {
  const invalid = () => new CollectorError('invalid_request', '記錄的分頁位置無效，請重新讀取第一頁。');
  let value: { t?: unknown; id?: unknown; f?: unknown };
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof value;
  } catch {
    throw invalid();
  }
  if (!value || typeof value.t !== 'string' || typeof value.id !== 'string' || value.f !== filter) throw invalid();
  return { timestamp: value.t, eventId: value.id };
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
