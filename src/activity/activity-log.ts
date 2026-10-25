import { createHash, randomUUID } from 'node:crypto';
import { jobRole } from '../core/source-registry.js';
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CollectorError,
  type ActivityCheckDetail,
  type ActivityCheckSummary,
  type ActivityGroupPage,
  type ActivityLogHealth,
  type ActivityPage,
  type ActivityQuery,
  type ActivitySummaryEntry,
  type ActivitySummaryPage,
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
const SNAPSHOT_TTL_MS = 30 * 60_000;
const SNAPSHOT_LIMIT = 50;

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

function scopeKey(scope: ActivityScope): string {
  return JSON.stringify({ vaultPath: scope.vaultPath, vaultId: scope.vaultId ?? null, previousPaths: [...(scope.previousPaths ?? [])].sort() });
}

interface CachedFile {
  size: number;
  events: JobEvent[];
  /** Bytes after the last newline; the rest of a line still being written. */
  rest: Buffer;
  skipped: number;
}

interface SummarySnapshot {
  createdAt: number;
  oldestAt: string | null;
  filter: string;
  scope: string;
  entries: ActivitySummaryEntry[];
  groups: Map<string, { summary: ActivityCheckSummary; checks: ActivityCheckDetail[] }>;
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
  private readonly snapshots = new Map<string, SummarySnapshot>();
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

  /** Completed checks folded before pagination; the snapshot freezes rows and group membership. */
  async summary(request: ActivityQuery, scope: ActivityScope): Promise<ActivitySummaryPage> {
    const query: ActivityQuery = {
      ...request, view: 'summary',
      ...(request.since ? { since: new Date(request.since).toISOString() } : {}),
      ...(request.until ? { until: new Date(request.until).toISOString() } : {}),
    };
    const limit = query.limit ?? DEFAULT_LIMIT;
    const filter = filterHash(query);
    let snapshotId: string;
    let offset = 0;
    let snapshot: SummarySnapshot | undefined;
    if (query.cursor) {
      ({ snapshotId, offset } = decodeSummaryCursor(query.cursor, filter));
      snapshot = this.snapshots.get(snapshotId);
      if (!snapshot || snapshot.filter !== filter || snapshot.scope !== scopeKey(scope)
        || this.now().getTime() - snapshot.createdAt > SNAPSHOT_TTL_MS
        || (snapshot.oldestAt !== null && snapshot.oldestAt < this.cutoff().toISOString())) {
        this.snapshots.delete(snapshotId);
        throw new CollectorError('activity_snapshot_expired', '記錄摘要已更新，請重新讀取第一頁。');
      }
    } else {
      snapshotId = randomUUID();
      snapshot = await this.buildSummary(query, scope, snapshotId);
      this.keepSnapshot(snapshotId, snapshot);
    }
    const entries = snapshot.entries.slice(offset, offset + limit);
    const next = offset + entries.length;
    return {
      entries,
      nextCursor: next < snapshot.entries.length ? encodeSummaryCursor(snapshotId, next, filter) : null,
      retentionDays: RETENTION_DAYS,
      log: this.health(),
    };
  }

  async group(groupId: string, scope: ActivityScope, limit = DEFAULT_LIMIT, cursor?: string, severity?: ActivityQuery['severity']): Promise<ActivityGroupPage> {
    const snapshotId = groupId.split(':')[0];
    const snapshot = snapshotId ? this.snapshots.get(snapshotId) : undefined;
    if (!snapshot || snapshot.scope !== scopeKey(scope)) {
      if (snapshotId) this.snapshots.delete(snapshotId);
      throw new CollectorError('activity_group_expired', '此查詢連結已失效，請返回並重新整理。');
    }
    const group = snapshot.groups.get(groupId);
    if (!group) throw new CollectorError('activity_group_expired', '此查詢連結已失效，請返回並重新整理。');
    const oldestDetailAt = group.checks.reduce((oldest, check) => check.events.reduce(
      (value, event) => event.timestamp < value ? event.timestamp : value, oldest), group.summary.firstFinishedAt);
    if (oldestDetailAt < this.cutoff().toISOString()) {
      throw new CollectorError('activity_group_expired', '檢查細節已超過 30 天保留期限。');
    }
    if (this.now().getTime() - snapshot.createdAt > SNAPSHOT_TTL_MS) {
      this.snapshots.delete(snapshotId!);
      throw new CollectorError('activity_group_expired', '此查詢連結已失效，請返回並重新整理。');
    }
    const offset = cursor ? decodeGroupCursor(cursor, groupId) : 0;
    const checks = group.checks.slice(offset, offset + limit).map((check) => ({
      ...check,
      events: severity ? check.events.filter((event) => severity.includes(event.severity)) : check.events,
    }));
    const next = offset + checks.length;
    return {
      group: group.summary, checks,
      nextCursor: next < group.checks.length ? encodeGroupCursor(groupId, next) : null,
      retentionDays: RETENTION_DAYS,
    };
  }

  private async buildSummary(query: ActivityQuery, scope: ActivityScope, snapshotId: string): Promise<SummarySnapshot> {
    const cutoff = this.cutoff().toISOString();
    const jobLinks = new Map<string, CollectionJob | undefined>();
    const lookup = (id: string) => {
      if (!jobLinks.has(id)) jobLinks.set(id, this.options.lookupJob?.(id));
      return jobLinks.get(id);
    };
    const all = (await this.readAll()).filter((event) => event.timestamp >= cutoff && inScope(event, scope))
      .map((event) => this.enrich(event, lookup));
    const base = all.filter((event) => (!query.since || event.timestamp >= query.since)
      && (!query.until || event.timestamp < query.until)
      && (!query.subscriptionId || event.subscriptionId === query.subscriptionId)
      && (!query.sourceType || event.sourceType === query.sourceType));
    const eventsByRoot = new Map<string, JobEvent[]>();
    for (const event of all) {
      const root = event.parentJobId ?? event.jobId;
      if (!root) continue;
      const list = eventsByRoot.get(root) ?? [];
      list.push(event);
      eventsByRoot.set(root, list);
    }
    const terminals = new Map<string, { event: JobEvent; detail: ActivityCheckDetail; hidden: boolean }>();
    for (const event of base) {
      if (!event.jobId || (event.eventType !== 'job.completed' && event.eventType !== 'job.failed')) continue;
      const check = event.check;
      if (!check || !event.subscriptionId || !event.sourceType) continue;
      terminals.set(event.jobId, {
        event: { ...event, check },
        hidden: event.outcome === 'skipped' && event.skipReason !== undefined
          && new Set(['subscription_paused', 'subscription_removed', 'superseded']).has(event.skipReason),
        detail: {
          jobId: event.jobId, finishedAt: event.timestamp, result: check.result,
          created: check.created, existing: check.existing, failed: check.failed, skipped: check.skipped,
          ...(event.errorCode ? { errorCode: event.errorCode } : {}), message: event.message,
          events: (eventsByRoot.get(event.jobId) ?? [])
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.eventId.localeCompare(b.eventId)),
        },
      });
    }
    const bySubscription = new Map<string, Array<{ event: JobEvent; detail: ActivityCheckDetail; hidden: boolean }>>();
    for (const terminal of terminals.values()) {
      const key = `${terminal.event.sourceType}\u0000${terminal.event.subscriptionId}`;
      const list = bySubscription.get(key) ?? [];
      list.push(terminal);
      bySubscription.set(key, list);
    }
    const groups = new Map<string, { summary: ActivityCheckSummary; checks: ActivityCheckDetail[] }>();
    const checkEntries: ActivityCheckSummary[] = [];
    const checkEntryEventIds = new Map<string, string>();
    let groupIndex = 0;
    for (const checks of bySubscription.values()) {
      checks.sort((a, b) => a.event.timestamp.localeCompare(b.event.timestamp) || a.event.eventId.localeCompare(b.event.eventId));
      let run: typeof checks = [];
      const flush = () => {
        if (run.length === 0) return;
        const first = run[0]!;
        const last = run[run.length - 1]!;
        const check = last.event.check!;
        const groupId = `${snapshotId}:${groupIndex++}`;
        const summary: ActivityCheckSummary = {
          kind: 'check', groupId, jobId: last.event.jobId!, sourceType: last.event.sourceType!, subscriptionId: last.event.subscriptionId!,
          sourceTitle: last.event.sourceTitle ?? null, trigger: check.trigger, result: check.result,
          created: check.created, existing: check.existing, failed: check.failed, skipped: check.skipped,
          count: run.length, firstFinishedAt: first.event.timestamp, lastFinishedAt: last.event.timestamp,
          severity: last.event.severity, ...(last.event.errorCode ? { errorCode: last.event.errorCode } : {}), message: last.event.message,
        };
        checkEntries.push(summary);
        checkEntryEventIds.set(groupId, last.event.eventId);
        groups.set(groupId, { summary, checks: run.map((entry) => entry.detail).reverse() });
        run = [];
      };
      for (const item of checks) {
        if (item.hidden) { flush(); continue; }
        const check = item.event.check!;
        const eligible = eligibleRoutineCheck(item.event);
        if (!eligible) { flush(); run = [item]; flush(); continue; }
        if (run.length > 0 && run[run.length - 1]!.event.check!.result !== check.result) flush();
        run.push(item);
      }
      flush();
    }
    const checkJobIds = new Set(terminals.keys());
    const meaningfulStartJobIds = new Set([...terminals]
      .filter(([, terminal]) => !terminal.hidden && !eligibleRoutineCheck(terminal.event))
      .map(([jobId]) => jobId));
    const visibleChild = (event: JobEvent) => event.eventType.startsWith('document.') || event.eventType.startsWith('subscription.item_')
      || event.eventType === 'job.failed';
    const independent = base.filter((event) => {
      if (event.eventType === 'schedule.dispatched') return false;
      if (event.jobId && checkJobIds.has(event.jobId)) {
        return event.eventType === 'job.started' && meaningfulStartJobIds.has(event.jobId);
      }
      if (event.parentJobId) return visibleChild(event);
      if (event.jobRole === 'add') return event.eventType === 'job.failed';
      if (event.jobRole === 'check') return event.eventType === 'job.failed'
        || (event.eventType === 'job.started' && event.trigger !== undefined && event.trigger !== 'scheduled');
      if (event.eventType === 'job.accepted') return false;
      if (event.jobRole === 'item' && event.eventType === 'job.completed' && event.outcome === 'created'
        && event.jobId && eventsByRoot.get(event.jobId)?.some((related) => related.eventType === 'document.saved')) return false;
      return true;
    })
      .filter((event) => !query.severity || query.severity.includes(event.severity))
      .filter((event) => !query.eventType || query.eventType.includes(event.eventType))
      .map((event): ActivitySummaryEntry => ({ kind: 'event', event }));
    const summaries = query.eventType ? [] : checkEntries.filter((entry) => !query.severity || query.severity.includes(entry.severity));
    const entries: ActivitySummaryEntry[] = [...independent, ...summaries]
      .sort((a, b) => summaryTime(b).localeCompare(summaryTime(a))
        || summaryEventId(b, checkEntryEventIds).localeCompare(summaryEventId(a, checkEntryEventIds)));
    const oldestAt = entries.reduce<string | null>((oldest, entry) => {
      const value = entry.kind === 'event' ? entry.event.timestamp : entry.firstFinishedAt;
      return oldest === null || value < oldest ? value : oldest;
    }, null);
    return { createdAt: this.now().getTime(), oldestAt, filter: filterHash(query), scope: scopeKey(scope), entries, groups };
  }

  private keepSnapshot(id: string, snapshot: SummarySnapshot): void {
    for (const [key, value] of this.snapshots) if (this.now().getTime() - value.createdAt > SNAPSHOT_TTL_MS) this.snapshots.delete(key);
    this.snapshots.set(id, snapshot);
    while (this.snapshots.size > SNAPSHOT_LIMIT) this.snapshots.delete(this.snapshots.keys().next().value!);
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
    const role = jobRole(job.kind)?.role;
    if (!event.jobRole && role) event.jobRole = role;
    if (!event.parentJobId && job.parentId) event.parentJobId = job.parentId;
    if (!event.sourceType) event.sourceType = job.source.type;
    if (!event.subscriptionId) {
      const owner = job.parentId ? lookup(job.parentId) : job;
      const role = owner ? jobRole(owner.kind)?.role : undefined;
      if (role === 'check' && owner!.source.id) event.subscriptionId = owner!.source.id;
      else if (role === 'add' && owner!.result?.subscriptionId) event.subscriptionId = owner!.result.subscriptionId;
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
      severity: value.severity === 'debug' || value.severity === 'warning' || value.severity === 'error' ? value.severity : 'info',
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

/** Routine checks whose process noise is represented by one durable summary row. */
function eligibleRoutineCheck(event: JobEvent): boolean {
  const check = event.check;
  return check !== undefined && check.trigger === 'scheduled' && (check.result === 'empty' || check.result === 'network_error')
    && check.created === 0 && check.failed === 0 && check.skipped === 0;
}

function matchesQuery(event: JobEvent, query: ActivityQuery, lookup: (id: string) => CollectionJob | undefined): boolean {
  if (query.severity && !query.severity.includes(event.severity)) return false;
  if (query.eventType && !query.eventType.includes(event.eventType)) return false;
  if (query.subscriptionId && event.subscriptionId !== query.subscriptionId) return false;
  if (query.sourceType && event.sourceType !== query.sourceType) return false;
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
    view: query.view ?? 'raw',
    severity: query.severity ? [...query.severity].sort() : null,
    eventType: query.eventType ? [...query.eventType].sort() : null,
    jobId: query.jobId ?? null,
    subscriptionId: query.subscriptionId ?? null,
    sourceType: query.sourceType ?? null,
    since: query.since ?? null,
    until: query.until ?? null,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('base64url').slice(0, 12);
}

function summaryTime(entry: ActivitySummaryEntry): string {
  return entry.kind === 'event' ? entry.event.timestamp : entry.lastFinishedAt;
}

function summaryEventId(entry: ActivitySummaryEntry, checks: ReadonlyMap<string, string>): string {
  return entry.kind === 'event' ? entry.event.eventId : checks.get(entry.groupId) ?? '';
}

function encodeSummaryCursor(snapshotId: string, offset: number, filter: string): string {
  return Buffer.from(JSON.stringify({ s: snapshotId, o: offset, f: filter })).toString('base64url');
}

function decodeSummaryCursor(cursor: string, filter: string): { snapshotId: string; offset: number } {
  const invalid = () => new CollectorError('invalid_request', '記錄摘要的分頁位置無效，請重新讀取第一頁。');
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown; o?: unknown; f?: unknown };
    if (typeof value.s !== 'string' || !Number.isSafeInteger(value.o) || (value.o as number) < 0 || value.f !== filter) throw invalid();
    return { snapshotId: value.s, offset: value.o as number };
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    throw invalid();
  }
}

function encodeGroupCursor(groupId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ g: groupId, o: offset })).toString('base64url');
}

function decodeGroupCursor(cursor: string, groupId: string): number {
  const invalid = () => new CollectorError('invalid_request', '檢查細節的分頁位置無效，請重新讀取。');
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { g?: unknown; o?: unknown };
    if (value.g !== groupId || !Number.isSafeInteger(value.o) || (value.o as number) < 0) throw invalid();
    return value.o as number;
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    throw invalid();
  }
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
