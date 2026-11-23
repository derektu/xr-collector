import { createHash } from 'node:crypto';
import { eventSpec } from '../../shared/activity/event-catalog.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type {
  ActivityCheckDetail,
  ActivityCheckSummary,
  ActivityGroupPage,
  ActivityLogHealth,
  ActivityPage,
  ActivityQuery,
  ActivitySummaryEntry,
  ActivitySummaryPage,
  JobEvent,
} from '../../shared/activity/activity-types.js';
import { RETENTION_DAYS, type ActivityLog, type ActivityScope } from './activity-log.js';

const DEFAULT_LIMIT = 50;
const HIDDEN_SKIPS: ReadonlySet<string> = new Set(['subscription_paused', 'subscription_removed']);
const GROUP_SEPARATOR = '.';

export interface ActivityViewsOptions {
  sourceTitle?: (jobId: string) => string | undefined;
}

type CheckEvent = JobEvent & { check: NonNullable<JobEvent['check']> };

interface CheckTerminal {
  event: CheckEvent;
  detail: ActivityCheckDetail;
  hidden: boolean;
}

interface Positioned {
  entry: ActivitySummaryEntry;
  timestamp: string;
  eventId: string;
}

export class ActivityViews {
  constructor(private readonly log: ActivityLog, private readonly options: ActivityViewsOptions = {}) {}

  health(): ActivityLogHealth {
    return this.log.health();
  }

  async query(request: ActivityQuery, scope: ActivityScope): Promise<ActivityPage> {
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
      view: 'raw',
      events,
      nextCursor: matches.length > limit && last ? encodeCursor(last, filterKey) : null,
      retentionDays: RETENTION_DAYS,
      log: this.log.health(),
    };
  }

  async summary(request: ActivityQuery, scope: ActivityScope): Promise<ActivitySummaryPage> {
    const query: ActivityQuery = {
      ...request, view: 'summary',
      ...(request.since ? { since: new Date(request.since).toISOString() } : {}),
      ...(request.until ? { until: new Date(request.until).toISOString() } : {}),
    };
    const limit = query.limit ?? DEFAULT_LIMIT;
    const filterKey = filterHash(query);
    const after = query.cursor ? decodeCursor(query.cursor, filterKey) : null;
    const positioned = (await this.summaryEntries(query, scope)).filter((item) => !after || compareEvents(item, after) < 0);
    const page = positioned.slice(0, limit);
    const last = page[page.length - 1];
    return {
      view: 'summary',
      entries: page.map((item) => item.entry),
      nextCursor: positioned.length > limit && last ? encodeCursor(last, filterKey) : null,
      retentionDays: RETENTION_DAYS,
      log: this.log.health(),
    };
  }

  async group(groupId: string, scope: ActivityScope, limit = DEFAULT_LIMIT, cursor?: string, severity?: ActivityQuery['severity']): Promise<ActivityGroupPage> {
    const [firstJobId, lastJobId = firstJobId] = groupId.split(GROUP_SEPARATOR);
    const all = await this.events(scope);
    const terminals = checkTerminals(eventsByRoot(all), all);
    const first = terminals.get(firstJobId!)?.event;
    const last = terminals.get(lastJobId!)?.event;
    if (!first || !last) throw new CollectorError('activity_group_expired', '這組檢查的記錄已超過 30 天保留期限。');
    const run = [...terminals.values()].filter(({ event, hidden }) => !hidden && event.sourceType === last.sourceType
      && event.subscriptionId === last.subscriptionId && compareEvents(event, first) >= 0 && compareEvents(event, last) <= 0).sort(byFinish);
    const details = run.map((terminal) => terminal.detail).reverse();
    const offset = cursor ? decodeGroupCursor(cursor, groupId) : 0;
    const checks = details.slice(offset, offset + limit).map((check) => ({
      ...check,
      events: severity ? check.events.filter((event) => severity.includes(event.severity)) : check.events,
    }));
    const next = offset + checks.length;
    return {
      group: runSummary(run), checks,
      nextCursor: next < details.length ? encodeGroupCursor(groupId, next) : null,
      retentionDays: RETENTION_DAYS,
    };
  }

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

  private async summaryEntries(query: ActivityQuery, scope: ActivityScope): Promise<Positioned[]> {
    const all = await this.events(scope);
    const base = all.filter((event) => (!query.since || event.timestamp >= query.since)
      && (!query.until || event.timestamp < query.until)
      && (!query.subscriptionId || event.subscriptionId === query.subscriptionId)
      && (!query.sourceType || event.sourceType === query.sourceType));
    const roots = eventsByRoot(all);
    const terminals = checkTerminals(roots, base);
    const bySubscription = new Map<string, CheckTerminal[]>();
    for (const terminal of terminals.values()) {
      const key = `${terminal.event.sourceType}\u0000${terminal.event.subscriptionId}`;
      const list = bySubscription.get(key) ?? [];
      list.push(terminal);
      bySubscription.set(key, list);
    }
    const checkEntries: Array<Positioned & { entry: ActivityCheckSummary }> = [];
    for (const checks of bySubscription.values()) {
      checks.sort(byFinish);
      let run: CheckTerminal[] = [];
      const flush = () => {
        if (run.length === 0) return;
        const last = run[run.length - 1]!;
        checkEntries.push({ entry: runSummary(run), timestamp: last.event.timestamp, eventId: last.event.eventId });
        run = [];
      };
      for (const item of checks) {
        if (item.hidden) { flush(); continue; }
        if (!isUneventfulScheduledCheck(item.event)) { flush(); run = [item]; flush(); continue; }
        if (run.length > 0 && run[run.length - 1]!.event.check.result !== item.event.check.result) flush();
        run.push(item);
      }
      flush();
    }
    const checkJobIds = new Set(terminals.keys());
    const meaningfulStartJobIds = new Set([...terminals]
      .filter(([, terminal]) => !terminal.hidden && !isUneventfulScheduledCheck(terminal.event))
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
        && event.jobId && roots.get(event.jobId)?.some((related) => related.eventType === 'document.saved')) return false;
      return true;
    })
      .filter((event) => !query.severity || query.severity.includes(event.severity))
      .filter((event) => !query.eventType || query.eventType.includes(event.eventType))
      .map((event): Positioned => ({ entry: { kind: 'event', event }, timestamp: event.timestamp, eventId: event.eventId }));
    const summaries = query.eventType ? [] : checkEntries.filter((item) => !query.severity || query.severity.includes(item.entry.severity));
    return [...independent, ...summaries].sort((a, b) => compareEvents(b, a));
  }
}

function eventsByRoot(all: readonly JobEvent[]): Map<string, JobEvent[]> {
  const roots = new Map<string, JobEvent[]>();
  for (const event of all) {
    const root = event.parentJobId ?? event.jobId;
    if (!root) continue;
    const list = roots.get(root) ?? [];
    list.push(event);
    roots.set(root, list);
  }
  return roots;
}

function checkTerminals(roots: ReadonlyMap<string, JobEvent[]>, base: readonly JobEvent[]): Map<string, CheckTerminal> {
  const terminals = new Map<string, CheckTerminal>();
  for (const event of base) {
    if (!event.jobId || (event.eventType !== 'job.completed' && event.eventType !== 'job.failed')) continue;
    const check = event.check;
    if (!check || !event.subscriptionId || !event.sourceType) continue;
    terminals.set(event.jobId, {
      event: { ...event, check },
      hidden: event.outcome === 'skipped' && event.skipReason !== undefined && HIDDEN_SKIPS.has(event.skipReason),
      detail: {
        jobId: event.jobId, finishedAt: event.timestamp, result: check.result,
        created: check.created, existing: check.existing, failed: check.failed, skipped: check.skipped,
        ...(event.errorCode ? { errorCode: event.errorCode } : {}), message: event.message,
        events: [...roots.get(event.jobId) ?? []]
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.eventId.localeCompare(b.eventId)),
      },
    });
  }
  return terminals;
}

function byFinish(a: CheckTerminal, b: CheckTerminal): number {
  return compareEvents(a.event, b.event);
}

function runSummary(run: readonly CheckTerminal[]): ActivityCheckSummary {
  const first = run[0]!.event;
  const last = run[run.length - 1]!.event;
  const { check } = last;
  return {
    kind: 'check',
    groupId: first.jobId === last.jobId ? last.jobId! : `${first.jobId}${GROUP_SEPARATOR}${last.jobId}`,
    jobId: last.jobId!, sourceType: last.sourceType!, subscriptionId: last.subscriptionId!,
    sourceTitle: last.sourceTitle ?? null, trigger: check.trigger, result: check.result,
    created: check.created, existing: check.existing, failed: check.failed, skipped: check.skipped,
    count: run.length, firstFinishedAt: first.timestamp, lastFinishedAt: last.timestamp,
    severity: last.severity, ...(last.errorCode ? { errorCode: last.errorCode } : {}), message: last.message,
  };
}

function isUneventfulScheduledCheck(event: JobEvent): boolean {
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

function encodeCursor(event: Pick<JobEvent, 'timestamp' | 'eventId'>, filter: string): string {
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
