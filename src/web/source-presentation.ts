import type { ChannelSchedule, CollectionJob, RecognitionAction, SourceEntry, SourceJobRecord, Subscription, UrlRecognition } from '../core/types.js';
import { triggerLabel } from './subscription-presentation.js';

/** Label of a source's status chip; a running job shows its item progress. */
export function sourceStatusLabel(source: Pick<Subscription, 'status' | 'activeJob'>): string {
  if (source.status === 'paused') return '已暫停';
  if (source.status === 'error') return '錯誤';
  if (source.status === 'collecting') {
    const job = source.activeJob;
    return job && job.total > 0 ? `收集中 ${job.done}／${job.total}` : '收集中';
  }
  return '追蹤中';
}

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
export function filterSources(sources: SourceEntry[], state: SourceListState): SourceEntry[] {
  const query = state.query.trim().toLocaleLowerCase();
  return sources.filter((source) => (!state.type || source.type === state.type)
    && (!query || source.title.toLocaleLowerCase().includes(query)));
}

/** The single-item row is not a source of any type, so only the unfiltered list shows it. */
export function showsSingleItems(state: SourceListState, documentCount: number): boolean {
  return documentCount > 0 && !state.type && state.query.trim() === '';
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
export function activeJobs(jobs: CollectionJob[]): CollectionJob[] {
  return jobs.filter((job) => job.parentId === null && (job.state === 'queued' || job.state === 'running'));
}

/** The sidebar's background state: collecting now, waiting for the next automatic check, or paused. */
export function backgroundStatus(activeCount: number, schedule: Pick<ChannelSchedule, 'enabled'> | null): { tone: 'busy' | 'on' | 'off'; text: string } {
  if (activeCount > 0) return { tone: 'busy', text: '背景收集中' };
  if (schedule && !schedule.enabled) return { tone: 'off', text: '自動收集已暫停' };
  return { tone: 'on', text: '自動收集開啟' };
}

/** "正在收集 2 項：A（4／10）、B" for the banner above the source list. */
export function collectingSummary(jobs: CollectionJob[]): string {
  const parts = jobs.map((job) => {
    const title = job.source.title ?? job.source.url;
    return job.progress && job.progress.total > 0 ? `${title}（${job.progress.done}／${job.progress.total}）` : title;
  });
  return `正在收集 ${jobs.length} 項：${parts.join('、')}`;
}

/** First letters of a source name for its avatar. */
export function initials(title: string): string {
  const letters = [...title.replace(/[【】\s]/gu, '')];
  return letters.slice(0, 2).join('').toUpperCase() || '?';
}

/** A channel address as shown under a source name, without the scheme and the listing suffix. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/u, '').replace(/\/videos\/?$/u, '');
}

/** One line of a source's collection record. */
export function jobRecordLabel(record: SourceJobRecord, now: Date = new Date()): { title: string; detail: string; active: boolean } {
  const title = triggerLabel(record.trigger);
  const progress = record.progress;
  const resumed = record.resumedCount > 0;
  if (record.state === 'queued' || record.state === 'running') {
    const notes = [
      progress && progress.total > 0 ? `${progress.done}／${progress.total}` : '準備中',
      ...(record.retry?.nextAttemptAt ? ['等待重試'] : []),
      ...(resumed ? ['已接續'] : []),
    ];
    return { title, detail: notes.join(' · '), active: true };
  }
  const when = shortTimeLabel(record.finishedAt ?? record.createdAt, now);
  if (record.state === 'interrupted') return { title, detail: `${when} · 已中斷，重新開啟時接續`, active: false };
  if (record.state === 'failed') {
    return { title, detail: `${when} · ${record.error?.message ?? '收集失敗'}`, active: false };
  }
  const suffix = resumed ? '・曾中斷後接續' : '';
  if (record.outcome === 'skipped') return { title, detail: `${when} · 已略過${suffix}`, active: false };
  const created = progress?.created ?? 0;
  return { title, detail: `${when} · ${created > 0 ? `新增 ${created}` : '沒有新影片'}${suffix}`, active: false };
}

/**
 * The check times under the source list: the newest finished check and the subscription due
 * next, each with its source name, so both match that source's detail page.
 */
export function checkTimesLine(schedule: Pick<ChannelSchedule, 'enabled' | 'lastCheck' | 'nextCheck'>, now: Date = new Date()): string {
  const last = schedule.lastCheck ? `${shortTimeLabel(schedule.lastCheck.at, now)}（${schedule.lastCheck.title}）` : '尚未檢查';
  if (!schedule.enabled) return `上次檢查 ${last} · 自動收集已暫停`;
  const next = schedule.nextCheck ? `${shortTimeLabel(schedule.nextCheck.at, now)}（${schedule.nextCheck.title}）` : '沒有追蹤中的來源';
  return `上次檢查 ${last} · 下一個檢查 ${next}`;
}

/** When one source is checked next, as its detail page shows it. */
export function nextCheckLabel(source: Pick<Subscription, 'enabled' | 'nextCheckAt'>, autoCollection: boolean | null, now: Date = new Date()): string {
  if (!source.enabled) return '已暫停';
  if (autoCollection === false) return '自動收集已暫停';
  return source.nextCheckAt ? shortTimeLabel(source.nextCheckAt, now) : '尚未排定';
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
