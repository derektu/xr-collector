import type { CollectionSchedule, JobView, PendingSubscription, RecognitionAction, RetryCause, SubscriptionEntry, SubscriptionCollectionEntry, Subscription, UrlRecognition } from '../core/types.js';
import { sourceDeclaration, sourceDeclarations } from '../core/source-registry.js';
import type { SourcePluginDeclaration } from '../plugins/types.js';
import { itemNoun, triggerLabel } from './subscription-presentation.js';

/** A compact local time: "今天 13:30", "昨天 21:05", "10-14 08:00" this year, "2025-12-31" before. */
export function shortTimeLabel(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = (offset: number) => {
    const reference = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return date.getFullYear() === reference.getFullYear() && date.getMonth() === reference.getMonth() && date.getDate() === reference.getDate();
  };
  if (day(0)) return `今天 ${time}`;
  if (day(-1)) return `昨天 ${time}`;
  if (date.getFullYear() === now.getFullYear()) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function calendarDate(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Type and name filters of the Sources page; the URL carries them so returning restores the list. */
export interface SourceListState {
  /** '' for every type. */
  type: string;
  query: string;
}

export function parseSourceListState(search: string): SourceListState {
  const parameters = new URLSearchParams(search);
  return { type: parameters.get('type') ?? '', query: parameters.get('q') ?? '' };
}

export function sourceListSearch(state: SourceListState): string {
  const parameters = new URLSearchParams();
  if (state.type) parameters.set('type', state.type);
  if (state.query) parameters.set('q', state.query);
  const text = parameters.toString();
  return text ? `?${text}` : '';
}

/** Sources of the chosen type whose name contains the query, ignoring case. */
export function filterSources(sources: SubscriptionEntry[], state: SourceListState): SubscriptionEntry[] {
  const query = state.query.trim().toLocaleLowerCase();
  return sources.filter((source) => (!state.type || source.type === state.type)
    && (!query || source.title.toLocaleLowerCase().includes(query)));
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

/** Top-level jobs still queued or running; a channel job counts once however many videos it holds. */
export function activeJobs(jobs: JobView[]): JobView[] {
  return jobs.filter((job) => job.parentId === null && (job.state === 'queued' || job.state === 'running'));
}

/** First letters of a source name for its avatar. */
export function initials(title: string): string {
  const letters = [...title.replace(/[【】\s]/gu, '')];
  return letters.slice(0, 2).join('').toUpperCase() || '?';
}

/**
 * The source type of a subscription request, told by which type owns its address, with the label of
 * that type's subscription kind; undefined when no registered type owns it.
 */
export function pendingOwner(entry: Pick<PendingSubscription, 'url'>): { declaration: SourcePluginDeclaration; kindLabel: string } | undefined {
  let url: URL | null = null;
  try { url = new URL(entry.url); } catch { url = null; }
  const declaration = sourceDeclarations().find((candidate) => candidate.subscription && candidate.owns(entry.url, url));
  if (!declaration) return undefined;
  const kind = declaration.kinds.find((candidate) => candidate.capability === 'subscription');
  return { declaration, kindLabel: kind?.label ?? declaration.label };
}

/** A subscription address as shown under a source name, without the scheme and the listing suffix. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/u, '').replace(/\/videos\/?$/u, '');
}

/** A failure in the source type's own short words, or its message when the type has none for its code. */
export function failureLabel(type: string, error: { code: string; message: string }): string {
  return sourceDeclaration(type)?.failureLabels?.[error.code] ?? error.message;
}

/** Why work waits for a retry: the failure with the attempt that comes next, "網路錯誤（第 2／3 次）", or "<source> 限制連線". */
export function retryCauseLabel(type: string, cause: RetryCause): string {
  if (cause.reason === 'rate_limited') return `${sourceDeclaration(type)?.label ?? type} 限制連線`;
  return `${failureLabel(type, cause.error)}（第 ${cause.attempt}／${cause.maxAttempts} 次）`;
}

/**
 * One row of a subscription's collection record: an item with its state ("沒有字幕・已試 2/3 次",
 * "已略過・影片不存在") or a check's summary ("定時檢查・收集 2 支", "定時檢查・沒有新影片").
 */
export function collectionEntryLabel(entry: SubscriptionCollectionEntry, type: string): { title: string; detail: string } {
  switch (entry.kind) {
    case 'collected': return { title: entry.title, detail: '' };
    case 'failed': return { title: entry.title || displayUrl(entry.url), detail: `${entry.reason}・已試 ${entry.attempts}/${entry.maxAttempts} 次` };
    case 'skipped': return {
      title: entry.title || displayUrl(entry.url),
      detail: entry.skippedBy === 'failure' ? `已略過・${entry.reason}` : `已略過・已試 ${entry.attempts} 次`,
    };
    case 'check': {
      const measure = sourceDeclaration(type)?.item.measure ?? '';
      const parts = entry.error ? [`檢查失敗・${failureLabel(type, entry.error)}`]
        : entry.created === 0 && entry.failed === 0 ? [`沒有新${itemNoun(type)}`]
          : [...(entry.created > 0 ? [`收集 ${entry.created} ${measure}`] : []), ...(entry.failed > 0 ? [`失敗 ${entry.failed} ${measure}`] : [])];
      return { title: [triggerLabel(entry.trigger, type), ...parts].join('・'), detail: '' };
    }
  }
}

/**
 * The check times under the subscription list: the newest finished check and the subscription due
 * next, each with its name, so both match that subscription's detail page.
 */
export function checkTimesLine(schedule: Pick<CollectionSchedule, 'enabled' | 'lastCheck' | 'nextCheck'>, now: Date = new Date()): string {
  const last = schedule.lastCheck ? `${shortTimeLabel(schedule.lastCheck.at, now)}（${schedule.lastCheck.title}）` : '尚未檢查';
  if (!schedule.enabled) return `上次檢查 ${last} · 自動檢查已關閉`;
  if (!schedule.nextCheck) return `上次檢查 ${last}`;
  return `上次檢查 ${last} · 下次檢查 ${shortTimeLabel(schedule.nextCheck.at, now)}（${schedule.nextCheck.title}）`;
}

/** When one subscription is checked next, as its detail page shows it. */
export function nextCheckLabel(source: Pick<Subscription, 'enabled' | 'nextCheckAt'>, autoCollection: boolean | null, now: Date = new Date()): string {
  if (!source.enabled) return '已暫停';
  if (autoCollection === false) return '自動檢查已關閉';
  return source.nextCheckAt ? shortTimeLabel(source.nextCheckAt, now) : '排隊中';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The recognition answer that applies to the address now in the input, with its primary action.
 * An answer for an earlier address is not returned, so it can never act on the wrong URL.
 */
export function currentRecognition(answer: { input: string; recognition: UrlRecognition } | null, input: string): { recognition: UrlRecognition; primary: RecognitionAction | null } | null {
  if (!answer || answer.input !== input.trim()) return null;
  return { recognition: answer.recognition, primary: answer.recognition.actions.find((action) => action.primary) ?? null };
}
