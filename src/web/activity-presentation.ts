import type { EventType } from '../core/event-catalog.js';
import type { SourceDeclarations } from '../core/source-registry.js';
import type { ActivityLogHealth, ActivityQuery, JobEvent } from '../core/activity-types.js';
import type { JobError, JobPhase, JobState, JobView } from '../core/job-types.js';
import { jobKind, jobKindLabel, jobTitle } from './job-presentation.js';
import { itemCount, itemNoun } from './subscription-presentation.js';

export type ActivityRecordType = 'all' | 'documents';
export type ActivityMinLevel = 'debug' | 'info' | 'warning' | 'error';
export type ActivityRange = 'today' | '7d' | '30d';

/** The log filters the activity page keeps in its address, so a link can open it filtered. */
export interface ActivityViewState {
  mode: 'summary' | 'raw';
  recordType: ActivityRecordType;
  minLevel: ActivityMinLevel;
  /** Subscription (channel ID) whose activity is shown; null for every source. */
  source: string | null;
  range: ActivityRange;
  /** Job whose events are shown, with the videos it queued; null for every job. */
  job: string | null;
  group: string | null;
  returnTo: string | null;
}

const RECORD_TYPES: readonly ActivityRecordType[] = ['all', 'documents'];
const MIN_LEVELS: readonly ActivityMinLevel[] = ['debug', 'info', 'warning', 'error'];
const RANGES: readonly ActivityRange[] = ['today', '7d', '30d'];

export const RECORD_TYPE_OPTIONS: Array<{ value: ActivityRecordType; label: string }> = [
  { value: 'all', label: '全部' }, { value: 'documents', label: '新增文件' },
];
export const MIN_LEVEL_OPTIONS: Array<{ value: ActivityMinLevel; label: string }> = [
  { value: 'debug', label: 'DEBUG 以上' }, { value: 'info', label: 'INFO 以上' },
  { value: 'warning', label: 'WARN 以上' }, { value: 'error', label: 'ERROR' },
];
export const RANGE_OPTIONS: Array<{ value: ActivityRange; label: string }> = [
  { value: 'today', label: '今天' }, { value: '7d', label: '最近 7 天' }, { value: '30d', label: '30 天內' },
];

export function parseActivityState(search: string): ActivityViewState {
  const parameters = new URLSearchParams(search);
  const recordType = parameters.get('type') as ActivityRecordType | null;
  const minLevel = parameters.get('minLevel') as ActivityMinLevel | null;
  const range = parameters.get('range') as ActivityRange | null;
  return {
    mode: parameters.get('mode') === 'raw' ? 'raw' : 'summary',
    recordType: recordType && RECORD_TYPES.includes(recordType) ? recordType : 'all',
    minLevel: minLevel && MIN_LEVELS.includes(minLevel) ? minLevel : 'info',
    source: parameters.get('source') || null,
    range: range && RANGES.includes(range) ? range : '30d',
    job: parameters.get('job') || null,
    group: parameters.get('group') || null,
    returnTo: parameters.get('return') || null,
  };
}

export function activityStateSearch(state: ActivityViewState): string {
  const parameters = new URLSearchParams();
  if (state.mode === 'raw') parameters.set('mode', 'raw');
  if (state.recordType !== 'all') parameters.set('type', state.recordType);
  if (state.minLevel !== 'info') parameters.set('minLevel', state.minLevel);
  if (state.source) parameters.set('source', state.source);
  if (state.range !== '30d') parameters.set('range', state.range);
  if (state.job) parameters.set('job', state.job);
  if (state.group) parameters.set('group', state.group);
  if (state.returnTo) parameters.set('return', state.returnTo);
  const search = parameters.toString();
  return search ? `?${search}` : '';
}

/** Midnight of the local day `daysBack` days before `now`; the log stores UTC, the page counts local days. */
export function localDayStart(now: Date, daysBack = 0): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
}

/** The events the "新增文件" record type lists. */
const DOCUMENT_EVENTS: readonly EventType[] = ['document.saved'];

/** The activity query for the page's record type and inclusive minimum severity. */
export function activityQuery(state: ActivityViewState, now: Date): ActivityQuery {
  const query: ActivityQuery = {};
  const severity = {
    debug: ['debug', 'info', 'warning', 'error'],
    info: ['info', 'warning', 'error'],
    warning: ['warning', 'error'],
    error: ['error'],
  } as const;
  query.severity = [...severity[state.minLevel]];
  if (state.recordType === 'documents') query.eventType = [...DOCUMENT_EVENTS];
  if (state.source) query.subscriptionId = state.source;
  if (state.job) query.jobId = state.job;
  if (state.range === 'today') query.since = localDayStart(now).toISOString();
  if (state.range === '7d') query.since = localDayStart(now, 6).toISOString();
  return query;
}

export type EventLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** The log's level label from the severity persisted with the event. */
export function eventLevel(event: Pick<JobEvent, 'severity'>): EventLevel {
  if (event.severity === 'error') return 'ERROR';
  if (event.severity === 'warning') return 'WARN';
  if (event.severity === 'debug') return 'DEBUG';
  return 'INFO';
}

/**
 * What a log line says. `source` is the source's title that leads the line; an event whose message
 * names its source itself (`namesSource`) keeps its own wording and has none. `adding` marks a
 * subscription request. `collected` is a completion that collected: an item stored new, or a check
 * that was not skipped and recorded its counts. Any other completion keeps its message.
 */
export type EventLine =
  | { line: 'accepted' | 'started'; source: string | null; adding: boolean }
  | { line: 'document_saved' | 'subscribed'; source: string | null }
  | { line: 'subscription_added'; source: string | null }
  | { line: 'collected'; source: string | null; collected: Collected }
  | { line: 'failed' | 'completed' | 'message'; source: string | null; message: string };

/**
 * What a collection produced: an item stored (`indexed` false when search was not updated), a check
 * that found nothing new, or a check's counts of items.
 */
export type Collected =
  | { result: 'stored'; indexed: boolean }
  | { result: 'nothing_new' }
  | { result: 'counts'; created: number; existing: number; skipped: number; failed: number };

type LineEvent = Pick<JobEvent, 'sourceTitle' | 'eventType' | 'message' | 'jobRole' | 'outcome' | 'check' | 'indexed' | 'namesSource'>;

function collected(event: LineEvent): Collected | null {
  if (event.jobRole === 'item') return event.outcome === 'created' ? { result: 'stored', indexed: event.indexed !== false } : null;
  if (event.jobRole !== 'check' || !event.check || event.outcome === undefined || event.outcome === 'skipped') return null;
  if (event.outcome === 'empty') return { result: 'nothing_new' };
  const { created, existing, skipped, failed } = event.check;
  return { result: 'counts', created, existing, skipped, failed };
}

export function eventLine(event: LineEvent): EventLine {
  const source = event.sourceTitle || null;
  const adding = event.jobRole === 'add';
  switch (event.eventType) {
    case 'job.accepted': return { line: 'accepted', source, adding };
    case 'job.started': return { line: 'started', source, adding };
    case 'document.saved': return { line: 'document_saved', source };
    case 'subscription.added': return { line: 'subscription_added', source };
    case 'job.failed': return { line: 'failed', source, message: event.message };
    case 'job.completed': {
      if (adding) return { line: 'subscribed', source };
      const result = collected(event);
      return result ? { line: 'collected', source, collected: result } : { line: 'completed', source, message: event.message };
    }
    default: return { line: 'message', source: event.namesSource ? null : source, message: event.message };
  }
}

function collectedText(declarations: SourceDeclarations, sourceType: string | undefined, result: Collected): string {
  if (result.result === 'stored') return result.indexed ? '。' : '，搜尋更新失敗。';
  if (result.result === 'nothing_new') return `，沒有新${itemNoun(declarations, sourceType) || '項目'}。`;
  const parts = [
    ...(result.created ? [`新增 ${itemCount(declarations, sourceType, result.created)}`] : []),
    ...(result.existing ? [`已存在 ${itemCount(declarations, sourceType, result.existing)}`] : []),
    ...(result.skipped ? [`略過 ${itemCount(declarations, sourceType, result.skipped)}`] : []),
    ...(result.failed ? [`失敗 ${itemCount(declarations, sourceType, result.failed)}`] : []),
  ];
  return parts.length ? `：${parts.join('・')}。` : '。';
}

/**
 * The log line: the source's title, the reason a channel job started it, then the message. A message
 * that already names the source, such as a subscription change, keeps its own wording.
 */
export function eventText(declarations: SourceDeclarations, event: LineEvent & Pick<JobEvent, 'sourceType'>): string {
  const line = eventLine(event);
  const prefix = line.source ? `${line.source}：` : '';
  switch (line.line) {
    case 'accepted': return line.adding ? `${prefix}訂閱請求已排入佇列。` : `${prefix}加入收集佇列。`;
    case 'started': return line.adding ? `${prefix}開始新增訂閱。` : `${prefix}開始收集。`;
    case 'document_saved': return `${prefix}已新增文件。`;
    case 'subscription_added': return `新增訂閱${line.source ? `：${line.source}` : ''}。`;
    case 'failed': return `${prefix}發生錯誤：${line.message}`;
    case 'subscribed': return `${prefix}已新增訂閱。`;
    case 'collected': return `${prefix}完成收集${collectedText(declarations, event.sourceType, line.collected)}`;
    case 'completed': return `${prefix}${line.message}`;
    case 'message': return `${prefix}${line.message}`;
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local time of a log entry: "10-15 14:02:11". */
export function logTime(value: string): string {
  const date = new Date(value);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** A check run's inclusive completed-at range, retaining both dates across midnight. */
export function summaryRange(first: string, last: string): string {
  if (first === last) return logTime(last);
  return `${logTime(first)}–${logTime(last)}`;
}

/** Why the log may miss events: writes fail with events waiting (`dropped` null while none were lost), or some were lost earlier. */
export type LogProblem = { state: 'failing'; pending: number; dropped: number | null } | { state: 'lost'; dropped: number };

export function logProblem(health: ActivityLogHealth | null): LogProblem | null {
  if (!health) return null;
  if (health.state === 'failing') return { state: 'failing', pending: health.pending, dropped: health.dropped > 0 ? health.dropped : null };
  if (health.dropped > 0) return { state: 'lost', dropped: health.dropped };
  return null;
}

/** The warning above the log while events cannot be written, or after some were lost. */
export function logWarning(health: ActivityLogHealth | null): string | null {
  const problem = logProblem(health);
  if (!problem) return null;
  if (problem.state === 'failing') {
    return `記錄暫時無法寫入，${problem.pending} 筆記錄等待補寫${problem.dropped !== null ? `，${problem.dropped} 筆已遺失` : ''}。`;
  }
  return `有 ${problem.dropped} 筆記錄未能寫入而遺失。`;
}

/** Short kind label of a job row, e.g. "定時檢查" or "單篇". */
export function jobBadge(declarations: SourceDeclarations, job: JobView): string {
  return jobKind(declarations, job).kind === 'item' ? '單篇' : jobKindLabel(declarations, job);
}

/** A job's diagnostics as data: its record, what is known of failures, retries and restarts, and its events oldest first. */
export interface Diagnostics {
  id: string;
  kind: string;
  url: string;
  state: JobState;
  phase: JobPhase | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: JobError | null;
  retry: { attempts: number; maxAttempts: number } | null;
  resumedCount: number | null;
  retryOf: string | null;
  retriedBy: string | null;
  events: Array<{ timestamp: string; level: EventLevel; eventType: string; errorCode: string | null; message: string; detail: string[] }>;
}

export function diagnostics(job: JobView, events: JobEvent[]): Diagnostics {
  return {
    id: job.id,
    kind: job.kind,
    url: job.source.url,
    state: job.state,
    phase: job.phase,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error ?? null,
    retry: job.retry ? { attempts: job.retry.attempts, maxAttempts: job.retry.maxAttempts } : null,
    resumedCount: job.recovery ? job.recovery.resumedCount : null,
    retryOf: job.retryOf || null,
    retriedBy: job.retriedBy || null,
    events: [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).map((event) => ({
      timestamp: event.timestamp,
      level: eventLevel(event),
      eventType: event.eventType,
      errorCode: event.errorCode || null,
      message: event.message,
      detail: event.detail ? event.detail.split('\n') : [],
    })),
  };
}

/** Plain-text diagnostics of a job for a bug report; event text is already masked by the service. */
export function diagnosticsText(declarations: SourceDeclarations, job: JobView, events: JobEvent[]): string {
  const data = diagnostics(job, events);
  const lines = [
    'XR Collector 工作診斷資訊',
    `工作：${data.id}`,
    `類型：${jobBadge(declarations, job)}（${data.kind}）`,
    `對象：${jobTitle(job)}`,
    `網址：${data.url}`,
    `狀態：${data.state}${data.phase ? `／${data.phase}` : ''}`,
    `建立：${data.createdAt}`,
    `開始：${data.startedAt ?? '—'}`,
    `結束：${data.finishedAt ?? '—'}`,
  ];
  if (data.error) lines.push(`錯誤：${data.error.code}：${data.error.message}`);
  if (data.retry) lines.push(`自動重試：已嘗試 ${data.retry.attempts}／${data.retry.maxAttempts} 次`);
  if (data.resumedCount !== null) lines.push(`重新啟動後接續：${data.resumedCount} 次`);
  if (data.retryOf) lines.push(`重試自：${data.retryOf}`);
  if (data.retriedBy) lines.push(`已重試為：${data.retriedBy}`);
  lines.push('', '記錄：');
  for (const event of data.events) {
    lines.push(`${event.timestamp} ${event.level} ${event.eventType}${event.errorCode ? ` [${event.errorCode}]` : ''} ${event.message}`);
    lines.push(...event.detail.map((line) => `    ${line}`));
  }
  return lines.join('\n');
}

/** Merges a fresh first page into the loaded log: new entries first, each entry once. */
export function mergeNewest(loaded: JobEvent[], fresh: JobEvent[]): JobEvent[] {
  const seen = new Set(fresh.map((event) => event.eventId));
  return [...fresh, ...loaded.filter((event) => !seen.has(event.eventId))];
}
