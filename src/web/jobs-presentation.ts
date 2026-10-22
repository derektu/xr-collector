import { sourceDeclaration } from '../core/source-registry.js';
import type { JobOverviewEntry } from '../core/types.js';
import { displayUrl, failureLabel, retryCauseLabel } from './source-presentation.js';
import { retryingText, targetNoun } from './subscription-presentation.js';

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

export function jobEntryLabel(entry: JobOverviewEntry): JobEntryLabel {
  const named = Boolean(entry.title);
  const action = entry.role === 'check' ? '檢查' : entry.role === 'add' ? '新增訂閱' : null;
  const noun = targetNoun(entry.type);
  return {
    icon: sourceDeclaration(entry.type)?.icon ?? 'file',
    title: entry.title ?? displayUrl(entry.url),
    named,
    subtitle: action ? (noun ? `${noun}・${action}` : action) : entry.publisher,
    status: statusOf(entry),
    retryReason: entry.status?.state === 'retrying' ? retryCauseLabel(entry.type, entry.status.cause) : null,
    reason: entry.error ? failureLabel(entry.type, entry.error) : null,
  };
}

function statusOf(entry: JobOverviewEntry): JobEntryLabel['status'] {
  switch (entry.status?.state) {
    case 'checking': return { text: entry.role === 'add' ? '新增中' : '檢查中', tone: 'collecting' };
    case 'downloading': return { text: entry.progress?.total ? `下載中 ${entry.progress.done}/${entry.progress.total}` : '下載中', tone: 'collecting' };
    case 'retrying': return { text: retryingText(entry.status.at), tone: 'retrying' };
    default: return null;
  }
}
