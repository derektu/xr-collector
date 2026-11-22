import type {
  CollectionSchedule,
  PendingSubscription,
  RetryCause,
  SubscriptionEntry,
  SubscriptionCollectionEntry,
  Subscription,
} from '../../shared/subscriptions/subscription-types.js';
import type { JobError, JobView } from '../../shared/jobs/job-types.js';
import type { RecognitionAction, UrlRecognition } from '../../shared/sources/source-info-types.js';
import type { SourceDeclarations } from '../../shared/sources/source-registry.js';
import { itemCount, itemNoun } from './subscription-presentation.js';

export type ShortTime =
  | { day: 'today' | 'yesterday'; time: string }
  | { day: 'this_year'; date: string; time: string }
  | { day: 'earlier'; date: string };

export function shortTime(value: string, now: Date = new Date()): ShortTime {
  const date = new Date(value);
  const time = clock(date);
  if (sameDay(date, now, 0)) return { day: 'today', time };
  if (sameDay(date, now, -1)) return { day: 'yesterday', time };
  if (date.getFullYear() === now.getFullYear()) return { day: 'this_year', date: monthDay(date), time };
  return { day: 'earlier', date: `${date.getFullYear()}-${monthDay(date)}` };
}

export function shortTimeText(at: ShortTime): string {
  switch (at.day) {
    case 'today': return `今天 ${at.time}`;
    case 'yesterday': return `昨天 ${at.time}`;
    case 'this_year': return `${at.date} ${at.time}`;
    case 'earlier': return at.date;
  }
}

export function shortTimeLabel(value: string, now: Date = new Date()): string {
  return shortTimeText(shortTime(value, now));
}

export type RangeEnd = { day: 'today' | 'yesterday'; time: string } | { day: 'date'; date: string; time: string };

export type TimeSpan = { sameDay: true; start: RangeEnd; endTime: string } | { sameDay: false; start: RangeEnd; end: RangeEnd };

export function timeSpan(first: string, last: string, now: Date = new Date()): TimeSpan {
  const start = new Date(first);
  const end = new Date(last);
  const rangeEnd = (date: Date, forceYear: boolean): RangeEnd => {
    const time = clock(date);
    if (!forceYear && sameDay(date, now, 0)) return { day: 'today', time };
    if (!forceYear && sameDay(date, now, -1)) return { day: 'yesterday', time };
    const withYear = forceYear || date.getFullYear() !== now.getFullYear();
    return { day: 'date', date: withYear ? `${date.getFullYear()}-${monthDay(date)}` : monthDay(date), time };
  };
  if (sameDay(start, end, 0)) return { sameDay: true, start: rangeEnd(start, false), endTime: clock(end) };
  const crossYear = start.getFullYear() !== end.getFullYear();
  return { sameDay: false, start: rangeEnd(start, crossYear), end: rangeEnd(end, crossYear) };
}

function rangeEndDay(end: RangeEnd): string {
  switch (end.day) {
    case 'today': return '今天';
    case 'yesterday': return '昨天';
    case 'date': return end.date;
  }
}

export function timeSpanText(span: TimeSpan): string {
  if (span.sameDay) return `${rangeEndDay(span.start)} ${span.start.time}–${span.endTime}`;
  return `${rangeEndDay(span.start)} ${span.start.time}–${rangeEndDay(span.end)} ${span.end.time}`;
}

export function summaryTimeRange(first: string, last: string, now: Date = new Date()): string {
  return timeSpanText(timeSpan(first, last, now));
}

function sameDay(date: Date, reference: Date, offset: number): boolean {
  const day = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + offset);
  return date.getFullYear() === day.getFullYear() && date.getMonth() === day.getMonth() && date.getDate() === day.getDate();
}

function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function monthDay(date: Date): string {
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function calendarDate(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface SourceListState {
  type: string | null;
  query: string;
}

export function parseSourceListState(search: string): SourceListState {
  const parameters = new URLSearchParams(search);
  return { type: parameters.get('type') || null, query: parameters.get('q') ?? '' };
}

export function sourceListSearch(state: SourceListState): string {
  const parameters = new URLSearchParams();
  if (state.type) parameters.set('type', state.type);
  if (state.query) parameters.set('q', state.query);
  const text = parameters.toString();
  return text ? `?${text}` : '';
}

function sourceListMatcher(state: SourceListState): (type: string, name: string) => boolean {
  const query = state.query.trim().toLocaleLowerCase();
  return (type, name) => (state.type === null || type === state.type) && (!query || name.toLocaleLowerCase().includes(query));
}

export function filterSources(sources: SubscriptionEntry[], state: SourceListState): SubscriptionEntry[] {
  const matches = sourceListMatcher(state);
  return sources.filter((source) => matches(source.type, source.title));
}

export function filterPending(pending: PendingSubscription[], state: SourceListState): PendingSubscription[] {
  const matches = sourceListMatcher(state);
  return pending.filter((entry) => matches(entry.type, entry.title ?? entry.url));
}

export function sourcePath(type: string, id: string): string {
  return `/sources/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
}

export function sourceRouteForPath(pathname: string): { type: string; id: string } | null {
  const match = /^\/sources\/([^/]+)\/([^/]+)\/?$/u.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  try {
    return { type: decodeURIComponent(match[1]), id: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

export function activeJobs(jobs: JobView[]): JobView[] {
  return jobs.filter((job) => job.parentId === null && (job.state === 'queued' || job.state === 'running'));
}

export function initials(title: string): string {
  const letters = [...title.replace(/[【】\s]/gu, '')];
  return letters.slice(0, 2).join('').toUpperCase() || '?';
}

export function subscriptionKindLabel(declarations: SourceDeclarations, type: string): string | undefined {
  const declaration = declarations.get(type);
  return declaration?.kinds.find((candidate) => candidate.capability === 'subscription')?.label ?? declaration?.label;
}

export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/u, '').replace(/\/videos\/?$/u, '');
}

export function failureLabel(declarations: SourceDeclarations, type: string, error: { code: string; message: string }): string {
  return declarations.get(type)?.failureLabels?.[error.code] ?? error.message;
}

export type RetryCauseView =
  | { reason: 'rate_limited'; source: string }
  | { reason: 'failed'; error: JobError; attempt: number; maxAttempts: number };

export function retryCause(declarations: SourceDeclarations, type: string, cause: RetryCause): RetryCauseView {
  if (cause.reason === 'rate_limited') return { reason: 'rate_limited', source: declarations.get(type)?.label ?? type };
  return { reason: 'failed', error: cause.error, attempt: cause.attempt, maxAttempts: cause.maxAttempts };
}

export function retryCauseLabel(declarations: SourceDeclarations, type: string, cause: RetryCause): string {
  return retryCauseText(declarations, type, retryCause(declarations, type, cause));
}

export function retryCauseText(declarations: SourceDeclarations, type: string, view: RetryCauseView): string {
  if (view.reason === 'rate_limited') return `${view.source} 限制連線`;
  return `${failureLabel(declarations, type, view.error)}（第 ${view.attempt}／${view.maxAttempts} 次）`;
}

export type CollectionRow =
  | { kind: 'collected'; title: string }
  | { kind: 'failed'; title: string; reason: string; attempts: number; maxAttempts: number }
  | { kind: 'skipped'; title: string; skippedBy: 'failure'; reason: string }
  | { kind: 'skipped'; title: string; skippedBy: 'limit'; attempts: number }
  | { kind: 'check'; outcome: 'error'; error: JobError }
  | { kind: 'check'; outcome: 'empty' }
  | { kind: 'check'; outcome: 'collected'; parts: Array<{ result: 'created' | 'failed'; count: number }> }
  | { kind: 'check-group'; result: 'empty' | 'network_error' | 'other'; message: string; count: number; span: TimeSpan | null };

export function collectionRow(entry: SubscriptionCollectionEntry, now: Date = new Date()): CollectionRow {
  switch (entry.kind) {
    case 'collected': return { kind: 'collected', title: entry.title };
    case 'failed': return { kind: 'failed', title: entry.title || displayUrl(entry.url), reason: entry.reason, attempts: entry.attempts, maxAttempts: entry.maxAttempts };
    case 'skipped': {
      const title = entry.title || displayUrl(entry.url);
      return entry.skippedBy === 'failure'
        ? { kind: 'skipped', title, skippedBy: 'failure', reason: entry.reason }
        : { kind: 'skipped', title, skippedBy: 'limit', attempts: entry.attempts };
    }
    case 'check':
      if (entry.error) return { kind: 'check', outcome: 'error', error: entry.error };
      if (entry.created === 0 && entry.failed === 0) return { kind: 'check', outcome: 'empty' };
      return { kind: 'check', outcome: 'collected', parts: [
        ...(entry.created > 0 ? [{ result: 'created' as const, count: entry.created }] : []),
        ...(entry.failed > 0 ? [{ result: 'failed' as const, count: entry.failed }] : []),
      ] };
    case 'check-group': return {
      kind: 'check-group',
      result: entry.result === 'empty' || entry.result === 'network_error' ? entry.result : 'other',
      message: entry.message,
      count: entry.count,
      span: entry.count > 1 ? timeSpan(entry.firstAt, entry.at, now) : null,
    };
  }
}

export function collectionEntryLabel(declarations: SourceDeclarations, entry: SubscriptionCollectionEntry, type: string, now: Date = new Date()): { title: string; detail: string } {
  const row = collectionRow(entry, now);
  switch (row.kind) {
    case 'collected': return { title: row.title, detail: '' };
    case 'failed': return { title: row.title, detail: `${row.reason}・已試 ${row.attempts}/${row.maxAttempts} 次` };
    case 'skipped': return { title: row.title, detail: row.skippedBy === 'failure' ? `已略過・${row.reason}` : `已略過・已試 ${row.attempts} 次` };
    case 'check': {
      if (row.outcome === 'error') return { title: `發生錯誤：${failureLabel(declarations, type, row.error)}`, detail: '' };
      if (row.outcome === 'empty') return { title: `完成檢查：沒有新${itemNoun(declarations, type)}`, detail: '' };
      const parts = row.parts.map((part) => `${part.result === 'created' ? '新增' : '失敗'} ${itemCount(declarations, type, part.count)}`);
      return { title: `完成收集：${parts.join('・')}`, detail: '' };
    }
    case 'check-group': {
      const result = row.result === 'empty' ? `完成檢查：沒有新${itemNoun(declarations, type)}`
        : row.result === 'network_error' ? '發生錯誤：網路錯誤' : `完成收集：${row.message}`;
      return {
        title: `${result}${row.count > 1 ? `・${row.count} 次` : ''}`,
        detail: row.span ? timeSpanText(row.span) : '',
      };
    }
  }
}

export interface NamedCheck {
  at: ShortTime;
  title: string;
}

export interface CheckTimes {
  last: NamedCheck | null;
  next: { state: 'auto_check_off' } | { state: 'none' } | ({ state: 'scheduled' } & NamedCheck);
}

export function checkTimes(schedule: Pick<CollectionSchedule, 'enabled' | 'lastCheck' | 'nextCheck'>, now: Date = new Date()): CheckTimes {
  const last = schedule.lastCheck ? { at: shortTime(schedule.lastCheck.at, now), title: schedule.lastCheck.title } : null;
  if (!schedule.enabled) return { last, next: { state: 'auto_check_off' } };
  if (!schedule.nextCheck) return { last, next: { state: 'none' } };
  return { last, next: { state: 'scheduled', at: shortTime(schedule.nextCheck.at, now), title: schedule.nextCheck.title } };
}

export function checkTimesLine(schedule: Pick<CollectionSchedule, 'enabled' | 'lastCheck' | 'nextCheck'>, now: Date = new Date()): string {
  const times = checkTimes(schedule, now);
  const named = (check: NamedCheck) => `${shortTimeText(check.at)}（${check.title}）`;
  const last = `上次檢查 ${times.last ? named(times.last) : '尚未檢查'}`;
  switch (times.next.state) {
    case 'auto_check_off': return `${last} · 自動檢查已關閉`;
    case 'none': return last;
    case 'scheduled': return `${last} · 下次檢查 ${named(times.next)}`;
  }
}

export type NextCheck = { state: 'paused' | 'auto_check_off' | 'queued' } | { state: 'scheduled'; at: ShortTime };

export function nextCheck(source: Pick<Subscription, 'enabled' | 'nextCheckAt'>, autoCollection: boolean | null, now: Date = new Date()): NextCheck {
  if (!source.enabled) return { state: 'paused' };
  if (autoCollection === false) return { state: 'auto_check_off' };
  return source.nextCheckAt ? { state: 'scheduled', at: shortTime(source.nextCheckAt, now) } : { state: 'queued' };
}

export function nextCheckLabel(source: Pick<Subscription, 'enabled' | 'nextCheckAt'>, autoCollection: boolean | null, now: Date = new Date()): string {
  const next = nextCheck(source, autoCollection, now);
  switch (next.state) {
    case 'paused': return '已暫停';
    case 'auto_check_off': return '自動檢查已關閉';
    case 'queued': return '排隊中';
    case 'scheduled': return shortTimeText(next.at);
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function currentRecognition(answer: { input: string; recognition: UrlRecognition } | null, input: string): { recognition: UrlRecognition; primary: RecognitionAction | null } | null {
  if (!answer || answer.input !== input.trim()) return null;
  return { recognition: answer.recognition, primary: answer.recognition.actions.find((action) => action.primary) ?? null };
}

export function typedNumber(text: string): string | number {
  const trimmed = text.trim();
  return /^[0-9]+$/u.test(trimmed) ? Number(trimmed) : text;
}
