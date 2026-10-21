import { sourceDeclaration } from '../core/source-registry.js';
import type { JobOverviewEntry } from '../core/types.js';
import { displayUrl, failureLabel } from './source-presentation.js';
import { targetNoun } from './subscription-presentation.js';

/** The row of a jobs page entry: its type's icon, its title, the line under it, and the wait or failure beside it. */
export interface JobEntryLabel {
  /** The icon of the entry's source type, whatever the work is. */
  icon: string;
  /** The item's or subscription's title; the address while it is unknown. */
  title: string;
  /** False when the title is the address. */
  named: boolean;
  /** What a check or subscription request follows and does, such as "頻道・檢查" or "頻道・新增訂閱"; the publisher for an item; null when unknown. */
  subtitle: string | null;
  /** Why queued work waits and when it goes on, such as "網路錯誤・10:35 重試"; null when it waits for its turn only. */
  waiting: { text: string; tone: 'retry' | 'cooldown' } | null;
  /** Why a failed entry failed, in the source type's short words. */
  reason: string | null;
}

export function jobEntryLabel(entry: JobOverviewEntry): JobEntryLabel {
  const named = Boolean(entry.title);
  const action = entry.role === 'check' ? '檢查' : entry.role === 'add' ? '新增訂閱' : null;
  const noun = targetNoun(entry.type);
  const subtitle = action ? (noun ? `${noun}・${action}` : action) : entry.publisher;
  let waiting: JobEntryLabel['waiting'] = null;
  if (entry.wait) {
    waiting = { text: `${sourceDeclaration(entry.type)?.label ?? entry.type} 限制連線・${clock(entry.wait.until)} 繼續`, tone: 'cooldown' };
  } else if (entry.retry) {
    waiting = { text: `${failureLabel(entry.type, entry.retry.lastError)}・${clock(entry.retry.nextAttemptAt)} 重試`, tone: 'retry' };
  }
  return {
    icon: sourceDeclaration(entry.type)?.icon ?? 'file',
    title: entry.title ?? displayUrl(entry.url),
    named,
    subtitle,
    waiting,
    reason: entry.error ? failureLabel(entry.type, entry.error) : null,
  };
}

function clock(value: string): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
