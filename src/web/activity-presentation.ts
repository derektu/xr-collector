import type { ActivityLogHealth, ActivityQuery, JobView, JobEvent, JobSummary } from '../core/types.js';
import { jobRole } from '../core/source-registry.js';
import { jobKindLabel, jobPhaseLabel, jobResultLabel, jobStateLabel, jobTitle, retryLabel, waitLabel } from './job-presentation.js';
import { triggerLabel } from './subscription-presentation.js';

export type ActivityLevel = 'all' | 'errors' | 'added';
export type ActivityRange = 'today' | '7d' | '30d';

/** The log filters the activity page keeps in its address, so a link can open it filtered. */
export interface ActivityViewState {
  level: ActivityLevel;
  /** Subscription (channel ID) whose activity is shown; null for every source. */
  source: string | null;
  range: ActivityRange;
  /** Job whose events are shown, with the videos it queued; null for every job. */
  job: string | null;
}

const LEVELS: readonly ActivityLevel[] = ['all', 'errors', 'added'];
const RANGES: readonly ActivityRange[] = ['today', '7d', '30d'];

export const LEVEL_OPTIONS: Array<{ value: ActivityLevel; label: string }> = [
  { value: 'all', label: '全部' }, { value: 'errors', label: '錯誤' }, { value: 'added', label: '新增' },
];
export const RANGE_OPTIONS: Array<{ value: ActivityRange; label: string }> = [
  { value: 'today', label: '今天' }, { value: '7d', label: '最近 7 天' }, { value: '30d', label: '30 天內' },
];

export function parseActivityState(search: string): ActivityViewState {
  const parameters = new URLSearchParams(search);
  const level = parameters.get('level') as ActivityLevel | null;
  const range = parameters.get('range') as ActivityRange | null;
  return {
    level: level && LEVELS.includes(level) ? level : 'all',
    source: parameters.get('source') || null,
    range: range && RANGES.includes(range) ? range : '30d',
    job: parameters.get('job') || null,
  };
}

export function activityStateSearch(state: ActivityViewState): string {
  const parameters = new URLSearchParams();
  if (state.level !== 'all') parameters.set('level', state.level);
  if (state.source) parameters.set('source', state.source);
  if (state.range !== '30d') parameters.set('range', state.range);
  if (state.job) parameters.set('job', state.job);
  const search = parameters.toString();
  return search ? `?${search}` : '';
}

/** Midnight of the local day `daysBack` days before `now`; the log stores UTC, the page counts local days. */
export function localDayStart(now: Date, daysBack = 0): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
}

/** The activity query for the page's filters. "Errors" covers warnings too: a retry or an interruption is a problem worth seeing. */
export function activityQuery(state: ActivityViewState, now: Date): ActivityQuery {
  const query: ActivityQuery = {};
  if (state.level === 'errors') query.severity = ['warning', 'error'];
  if (state.level === 'added') query.eventType = ['document.saved'];
  if (state.source) query.subscriptionId = state.source;
  if (state.job) query.jobId = state.job;
  if (state.range === 'today') query.since = localDayStart(now).toISOString();
  if (state.range === '7d') query.since = localDayStart(now, 6).toISOString();
  return query;
}

export type EventLevel = 'ERR' | 'WARN' | 'OK' | 'DONE' | 'SKIP' | 'INFO';

/** The log's level label, derived from severity, type and outcome; a skipped video is not an error. */
export function eventLevel(event: Pick<JobEvent, 'severity' | 'eventType' | 'outcome'>): EventLevel {
  if (event.severity === 'error') return 'ERR';
  if (event.severity === 'warning') return 'WARN';
  if (event.eventType === 'document.saved') return 'OK';
  if (event.eventType === 'job.completed') return event.outcome === 'skipped' ? 'SKIP' : 'DONE';
  return 'INFO';
}

/**
 * The log line: the source's title, the reason a channel job started it, then the message. A message
 * that already names the source, such as a subscription change, keeps its own wording.
 */
export function eventText(event: Pick<JobEvent, 'sourceTitle' | 'trigger' | 'eventType' | 'message' | 'parentJobId'>): string {
  const reason = event.trigger && !event.parentJobId && event.eventType === 'job.accepted' ? `${triggerLabel(event.trigger)}・` : '';
  const prefix = event.sourceTitle && !event.message.includes(event.sourceTitle) ? `${event.sourceTitle}：` : '';
  return `${prefix}${reason}${event.message}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local time of a log entry: "10-15 14:02:11". */
export function logTime(value: string): string {
  const date = new Date(value);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function summaryLabel(summary: Pick<JobSummary, 'active' | 'completed' | 'failed'>): string {
  return `進行中 ${summary.active} · 今天完成 ${summary.completed} · 失敗 ${summary.failed}`;
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

/** What a job row says on its right: progress while it runs, the reason when it failed, the result when it finished. */
export function jobStatusText(job: JobView): string {
  if (job.state === 'queued' || job.state === 'running') {
    const wait = job.state === 'queued' ? waitLabel(job.wait, job.source.type) : null;
    if (wait) return `${jobStateLabel(job)}・${wait}`;
    const retry = retryLabel(job.retry);
    if (retry) return retry;
    const phase = jobPhaseLabel(job) ?? jobStateLabel(job);
    const progress = job.progress && job.progress.total > 0 ? ` ${job.progress.done}／${job.progress.total}` : '';
    return `${phase}${progress}`;
  }
  if (job.state === 'completed' && jobRole(job.kind)?.role === 'item' && job.result?.outcome === 'created') {
    return job.result.indexed === false ? '已加入，搜尋更新失敗' : '已加入';
  }
  return jobResultLabel(job) ?? jobStateLabel(job);
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
