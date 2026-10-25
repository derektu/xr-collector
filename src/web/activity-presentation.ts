import type { ActivityLogHealth, ActivityQuery, JobView, JobEvent } from '../core/types.js';
import { jobRole } from '../core/source-registry.js';
import { jobKindLabel, jobTitle } from './job-presentation.js';

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
  if (state.recordType === 'documents') query.eventType = ['document.saved'];
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
 * The log line: the source's title, the reason a channel job started it, then the message. A message
 * that already names the source, such as a subscription change, keeps its own wording.
 */
export function eventText(event: Pick<JobEvent, 'sourceTitle' | 'eventType' | 'message' | 'jobRole'>): string {
  const prefix = event.sourceTitle ? `${event.sourceTitle}：` : '';
  switch (event.eventType) {
    case 'job.accepted': return event.jobRole === 'add' ? `${prefix}訂閱請求已排入佇列。` : `${prefix}加入收集佇列。`;
    case 'job.started': return event.jobRole === 'add' ? `${prefix}開始新增訂閱。` : `${prefix}開始收集。`;
    case 'document.saved': return `${prefix}已新增文件。`;
    case 'subscription.added': return `新增訂閱${event.sourceTitle ? `：${event.sourceTitle}` : ''}。`;
    case 'job.failed': return `${prefix}發生錯誤：${event.message}`;
    case 'job.completed': {
      if (event.jobRole === 'add') return `${prefix}已新增訂閱。`;
      const completed = event.message.replace(/^收集完成，文件已保存/u, '完成收集').replace(/^收集完成/u, '完成收集');
      return `${prefix}${completed}`;
    }
    default: return `${event.sourceTitle && !event.message.includes(event.sourceTitle) ? prefix : ''}${event.message}`;
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

/** The warning above the log while events cannot be written, or after some were lost. */
export function logWarning(health: ActivityLogHealth | null): string | null {
  if (!health) return null;
  if (health.state === 'failing') {
    return `記錄暫時無法寫入，${health.pending} 筆記錄等待補寫${health.dropped > 0 ? `，${health.dropped} 筆已遺失` : ''}。`;
  }
  if (health.dropped > 0) return `有 ${health.dropped} 筆記錄未能寫入而遺失。`;
  return null;
}

/** Short kind label of a job row, e.g. "定時檢查" or "單篇". */
export function jobBadge(job: JobView): string {
  return jobRole(job.kind)?.role === 'item' ? '單篇' : jobKindLabel(job);
}

/** Plain-text diagnostics of a job for a bug report; event text is already masked by the service. */
export function diagnosticsText(job: JobView, events: JobEvent[]): string {
  const lines = [
    'XR Collector 工作診斷資訊',
    `工作：${job.id}`,
    `類型：${jobBadge(job)}（${job.kind}）`,
    `對象：${jobTitle(job)}`,
    `網址：${job.source.url}`,
    `狀態：${job.state}${job.phase ? `／${job.phase}` : ''}`,
    `建立：${job.createdAt}`,
    `開始：${job.startedAt ?? '—'}`,
    `結束：${job.finishedAt ?? '—'}`,
  ];
  if (job.error) lines.push(`錯誤：${job.error.code}：${job.error.message}`);
  if (job.retry) lines.push(`自動重試：已嘗試 ${job.retry.attempts}／${job.retry.maxAttempts} 次`);
  if (job.recovery) lines.push(`重新啟動後接續：${job.recovery.resumedCount} 次`);
  if (job.retryOf) lines.push(`重試自：${job.retryOf}`);
  if (job.retriedBy) lines.push(`已重試為：${job.retriedBy}`);
  lines.push('', '記錄：');
  for (const event of [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    lines.push(`${event.timestamp} ${eventLevel(event)} ${event.eventType}${event.errorCode ? ` [${event.errorCode}]` : ''} ${event.message}`);
    if (event.detail) lines.push(...event.detail.split('\n').map((line) => `    ${line}`));
  }
  return lines.join('\n');
}

/** Merges a fresh first page into the loaded log: new entries first, each entry once. */
export function mergeNewest(loaded: JobEvent[], fresh: JobEvent[]): JobEvent[] {
  const seen = new Set(fresh.map((event) => event.eventId));
  return [...fresh, ...loaded.filter((event) => !seen.has(event.eventId))];
}
