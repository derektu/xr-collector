import { sourceDeclaration } from '../core/source-registry.js';
import type { JobError, JobOverviewEntry } from '../core/types.js';
import { displayUrl, failureLabel, retryCause, retryCauseText } from './source-presentation.js';
import type { RetryCauseView } from './source-presentation.js';
import { clockTime, retryAtText, targetNoun } from './subscription-presentation.js';

/** The row of a jobs page entry: its type's icon, its title, the lines under it, and its status beside it. */
export interface JobEntryLabel {
  /** The icon of the entry's source type, whatever the work is. */
  icon: string;
  /** The item's or subscription's title; the address while it is unknown. */
  title: string;
  /** False when the title is the address. */
  named: boolean;
  /** What a check or subscription request follows and does, such as "頻道・檢查" or "頻道・新增訂閱"; the publisher for an item; null when unknown. */
  subtitle: string | null;
  /** What started work is doing, such as "下載中 3/5" or "錯誤・10:35 重試"; null for work that has not started and for failed work. */
  status: { text: string; tone: 'collecting' | 'retrying' } | null;
  /** Why work waits for a retry, such as "網路錯誤（第 2／3 次）"; null otherwise. */
  retryReason: string | null;
  /** Why a failed entry failed, in the source type's short words. */
  reason: string | null;
}

/** What started work is doing: a check listing (or a subscription request resolving), a download with its progress once known, or a wait for a retry at a time. */
export type JobEntryStatus =
  | { state: 'checking'; adding: boolean }
  | { state: 'downloading'; progress: { done: number; total: number } | null }
  | { state: 'retrying'; retryAt: string };

/** A jobs page row as data; `jobEntryLabel` puts it into words. */
export interface JobEntryView {
  icon: string;
  title: string;
  named: boolean;
  /** A check or subscription request with what its type follows (null for a type without one), or an item with its publisher (null while unknown). */
  work: { role: 'check' | 'add'; target: string | null } | { role: 'item'; publisher: string | null };
  status: JobEntryStatus | null;
  retry: RetryCauseView | null;
  failure: JobError | null;
}

export function jobEntry(entry: JobOverviewEntry): JobEntryView {
  return {
    icon: sourceDeclaration(entry.type)?.icon ?? 'file',
    title: entry.title ?? displayUrl(entry.url),
    named: Boolean(entry.title),
    work: entry.role === 'item' ? { role: 'item', publisher: entry.publisher } : { role: entry.role, target: targetNoun(entry.type) || null },
    status: statusOf(entry),
    retry: entry.status?.state === 'retrying' ? retryCause(entry.type, entry.status.cause) : null,
    failure: entry.error,
  };
}

function statusOf(entry: JobOverviewEntry): JobEntryStatus | null {
  switch (entry.status?.state) {
    case 'checking': return { state: 'checking', adding: entry.role === 'add' };
    case 'downloading': return { state: 'downloading', progress: entry.progress?.total ? entry.progress : null };
    case 'retrying': return { state: 'retrying', retryAt: clockTime(entry.status.at) };
    default: return null;
  }
}

export function jobEntryLabel(entry: JobOverviewEntry): JobEntryLabel {
  const view = jobEntry(entry);
  return {
    icon: view.icon,
    title: view.title,
    named: view.named,
    subtitle: subtitleText(view.work),
    status: view.status ? { text: statusText(view.status), tone: view.status.state === 'retrying' ? 'retrying' : 'collecting' } : null,
    retryReason: view.retry ? retryCauseText(entry.type, view.retry) : null,
    reason: view.failure ? failureLabel(entry.type, view.failure) : null,
  };
}

function subtitleText(work: JobEntryView['work']): string | null {
  if (work.role === 'item') return work.publisher;
  const action = work.role === 'check' ? '檢查' : '新增訂閱';
  return work.target ? `${work.target}・${action}` : action;
}

function statusText(status: JobEntryStatus): string {
  switch (status.state) {
    case 'checking': return status.adding ? '新增中' : '檢查中';
    case 'downloading': return status.progress ? `下載中 ${status.progress.done}/${status.progress.total}` : '下載中';
    case 'retrying': return retryAtText(status.retryAt);
  }
}
