import { createHash, randomUUID } from 'node:crypto';
import { eventSpec } from '../core/event-catalog.js';
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
  type JobEvent,
} from '../core/types.js';
import { RETENTION_DAYS, type ActivityLog, type ActivityScope } from './activity-log.js';

const DEFAULT_LIMIT = 50;
const SNAPSHOT_TTL_MS = 30 * 60_000;
const SNAPSHOT_LIMIT = 50;

export interface ActivityViewsOptions {
  /**
   * The title of a job's item or target, for events written before the job knew it. The activity
   * log stores events as they were recorded; the job record is where a title learned later lives.
   */
  sourceTitle?: (jobId: string) => string | undefined;
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
 * The pages read from the activity log: raw events newest first, and the summary that folds routine
 * subscription checks into one row each. The summary relies only on fields an event carries from
 * the moment it is recorded (`jobRole`, `parentJobId`, `trigger`, `check`) and on the event catalog,
 * so it reads the same after a restart and after the job records are pruned.
 */
export class ActivityViews {
  private readonly snapshots = new Map<string, SummarySnapshot>();

  constructor(private readonly log: ActivityLog, private readonly options: ActivityViewsOptions = {}) {}

  health(): ActivityLogHealth {
    return this.log.health();
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
    const matches: JobEvent[] = [];
    for (const event of await this.events(scope)) {
      if (!matchesQuery(event, query)) continue;
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
      log: this.log.health(),
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
        || this.log.now().getTime() - snapshot.createdAt > SNAPSHOT_TTL_MS
        || (snapshot.oldestAt !== null && snapshot.oldestAt < this.log.retentionStart().toISOString())) {
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
      log: this.log.health(),
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
    if (oldestDetailAt < this.log.retentionStart().toISOString()) {
      throw new CollectorError('activity_group_expired', '檢查細節已超過 30 天保留期限。');
    }
    if (this.log.now().getTime() - snapshot.createdAt > SNAPSHOT_TTL_MS) {
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

  /** The retained events of `scope`, each with the title its job learned after the event was written. */
  private async events(scope: ActivityScope): Promise<JobEvent[]> {
    const titles = new Map<string, string | undefined>();
    const title = (jobId: string) => {
      if (!titles.has(jobId)) titles.set(jobId, this.options.sourceTitle?.(jobId));
      return titles.get(jobId);
    };
    return (await this.log.read(scope)).map((event) => {
      if (event.sourceTitle || !event.jobId) return event;
      const learned = title(event.jobId);
      return learned ? { ...event, sourceTitle: learned } : event;
    });
  }

  private async buildSummary(query: ActivityQuery, scope: ActivityScope, snapshotId: string): Promise<SummarySnapshot> {
    const all = await this.events(scope);
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
    const independent = base.filter((event) => {
      const spec = eventSpec(event.eventType);
      if (!spec?.summary) return false;
      if (event.jobId && checkJobIds.has(event.jobId)) {
        return event.eventType === 'job.started' && meaningfulStartJobIds.has(event.jobId);
      }
      if (event.parentJobId) return spec.child;
      if (event.jobRole === 'add') return event.eventType === 'job.failed';
      if (event.jobRole === 'check') return event.eventType === 'job.failed'
        || (event.eventType === 'job.started' && event.trigger !== undefined && event.trigger !== 'scheduled');
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
    return { createdAt: this.log.now().getTime(), oldestAt, filter: filterHash(query), scope: scopeKey(scope), entries, groups };
  }

  private keepSnapshot(id: string, snapshot: SummarySnapshot): void {
    const now = this.log.now().getTime();
    for (const [key, value] of this.snapshots) if (now - value.createdAt > SNAPSHOT_TTL_MS) this.snapshots.delete(key);
    this.snapshots.set(id, snapshot);
    while (this.snapshots.size > SNAPSHOT_LIMIT) this.snapshots.delete(this.snapshots.keys().next().value!);
  }
}

function scopeKey(scope: ActivityScope): string {
  return JSON.stringify({ vaultPath: scope.vaultPath, vaultId: scope.vaultId ?? null });
}

/** Routine checks whose process noise is represented by one durable summary row. */
function eligibleRoutineCheck(event: JobEvent): boolean {
  const check = event.check;
  return check !== undefined && check.trigger === 'scheduled' && (check.result === 'empty' || check.result === 'network_error')
    && check.created === 0 && check.failed === 0 && check.skipped === 0;
}

function matchesQuery(event: JobEvent, query: ActivityQuery): boolean {
  if (query.severity && !query.severity.includes(event.severity)) return false;
  if (query.eventType && !query.eventType.includes(event.eventType)) return false;
  if (query.subscriptionId && event.subscriptionId !== query.subscriptionId) return false;
  if (query.sourceType && event.sourceType !== query.sourceType) return false;
  if (query.since && event.timestamp < query.since) return false;
  if (query.until && event.timestamp >= query.until) return false;
  if (query.jobId) {
    const id = query.jobId;
    if (event.jobId !== id && event.parentJobId !== id && event.retryOf !== id) return false;
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
