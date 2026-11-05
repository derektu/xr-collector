import type { ChannelJobTrigger, Subscription, SubscriptionCheckStatus, SubscriptionSettings } from '../core/types.js';
import { intervalLabel } from '../core/check-interval.js';
import { upcomingTime, upcomingTimeText, type UpcomingTime } from '../core/upcoming-time.js';
import { sourceDeclaration } from '../core/source-registry.js';
import type { SubscriptionDeclaration } from '../core/source-contract.js';

export { intervalLabel };

/** The subscription declaration of a registered type; undefined without one. */
function subscriptionOf(type: string | null | undefined): SubscriptionDeclaration | undefined {
  return type ? sourceDeclaration(type)?.subscription : undefined;
}

/** What a subscription of the type follows, e.g. "頻道"; empty without a registered type. */
export function targetNoun(type: string | null | undefined): string {
  return subscriptionOf(type)?.targetNoun ?? '';
}

/** What one item of the type is called, e.g. "影片"; empty without a registered type. */
export function itemNoun(type: string | null | undefined): string {
  return (type ? sourceDeclaration(type)?.item.noun : undefined) ?? '';
}

/** A source-neutral item count, e.g. "2 支影片" or "3 篇文章". */
export function itemCount(type: string | null | undefined, count: number): string {
  const item = type ? sourceDeclaration(type)?.item : undefined;
  return `${count}${item ? ` ${item.measure}${item.noun}` : ''}`;
}

/** The range every check collects, in words, as the source type describes its settings. */
export function backfillPhrase(settings: Partial<SubscriptionSettings>, type: string | null | undefined): string {
  return subscriptionOf(type)?.describeSettings(settings as SubscriptionSettings) ?? '';
}

/** What subscribing does after its first check: check again at the subscription's interval, or wait until automatic checks are on. */
export type SubscribePlan = { autoCheck: true; intervalMinutes: number } | { autoCheck: false };

export function subscribePlan(settings: SubscriptionSettings, autoCollection: boolean): SubscribePlan {
  return autoCollection ? { autoCheck: true, intervalMinutes: settings.intervalMinutes } : { autoCheck: false };
}

/** What subscribing with `settings` does, as the confirmation card says it. */
export function subscribeSummary(settings: SubscriptionSettings, autoCollection: boolean, type: string | null | undefined): string {
  const plan = subscribePlan(settings, autoCollection);
  return plan.autoCheck
    ? `訂閱後立即檢查，之後${intervalLabel(plan.intervalMinutes)}檢查一次；每次檢查收集${backfillPhrase(settings, type)}，已收集或刪除的不再收集。`
    : `訂閱後立即檢查，收集${backfillPhrase(settings, type)}。自動檢查已關閉，開啟後才會定時檢查。`;
}

/** What resuming a paused subscription does with its own settings. */
export function resumeSummary(settings: SubscriptionSettings, type: string | null | undefined): string {
  return `這個訂閱已暫停。恢復後立即檢查，之後${intervalLabel(settings.intervalMinutes)}檢查一次；每次檢查收集${backfillPhrase(settings, type)}，已收集或刪除的不再收集。`;
}

/** A choice of removing a subscription for its documents, with their count; null when it has none. */
export interface RemoveOption {
  value: 'keep' | 'delete';
  documents: number | null;
}

/** The two choices of removing a subscription for its documents; keeping them is the default. */
export function removeOptions(subscription: Pick<Subscription, 'documentCount'>): RemoveOption[] {
  const documents = subscription.documentCount > 0 ? subscription.documentCount : null;
  return [{ value: 'keep', documents }, { value: 'delete', documents }];
}

export function removeChoices(subscription: Pick<Subscription, 'documentCount'>): Array<{ value: 'keep' | 'delete'; label: string }> {
  return removeOptions(subscription).map((option) => ({ value: option.value, label: removeOptionText(option) }));
}

function removeOptionText(option: RemoveOption): string {
  if (option.value === 'keep') return option.documents === null ? '保留文件' : `保留 ${option.documents} 份文件`;
  return option.documents === null ? '一併刪除文件' : `一併刪除 ${option.documents} 份文件`;
}

const ACTIVE_STATES: ReadonlySet<SubscriptionCheckStatus['state']> = new Set(['queued', 'checking', 'downloading', 'retrying']);

/**
 * Whether removing the subscription asks about its documents: it has some, or a check or a
 * capture of it is still running and may save one.
 */
export function asksAboutDocuments(subscription: Pick<Subscription, 'documentCount' | 'checkStatus' | 'capturing'>): boolean {
  return subscription.documentCount > 0 || subscription.capturing || ACTIVE_STATES.has(subscription.checkStatus.state);
}

/** What happened to a removed subscription's documents. */
export type RemovalOutcome =
  | { documents: 'kept' }
  | { documents: 'deleted'; deleted: number }
  | { documents: 'partly_deleted'; deleted: number; failed: number };

export function removalOutcome(deleted: { documentsDeleted: number; documentsFailed: number } | null): RemovalOutcome {
  if (deleted === null) return { documents: 'kept' };
  return deleted.documentsFailed > 0
    ? { documents: 'partly_deleted', deleted: deleted.documentsDeleted, failed: deleted.documentsFailed }
    : { documents: 'deleted', deleted: deleted.documentsDeleted };
}

/** What removing a subscription did, as its log entry also says it. */
export function removedMessage(title: string, deleted: { documentsDeleted: number; documentsFailed: number } | null): string {
  const outcome = removalOutcome(deleted);
  switch (outcome.documents) {
    case 'kept': return `已移除「${title}」，文件保留。`;
    case 'partly_deleted': return `已移除「${title}」，刪除 ${outcome.deleted} 份文件，${outcome.failed} 份無法刪除。`;
    case 'deleted': return `已移除「${title}」，並刪除 ${outcome.deleted} 份文件。`;
  }
}

/**
 * A subscription's status column as data: the status state, with the download's progress, the time
 * a retry or the next check runs, and the failures in a row (`streak`).
 */
export type SubscriptionStatusView =
  | { state: 'queued' | 'adding' | 'checking' | 'paused' | 'auto_check_off' | 'login_required' }
  | { state: 'downloading'; done: number; total: number }
  | { state: 'retrying'; retryAt: string }
  | { state: 'scheduled'; next: UpcomingTime }
  | { state: 'failing'; streak: number; retryAt: UpcomingTime | null }
  | { state: 'auto_paused'; streak: number };

export function subscriptionStatus(status: SubscriptionCheckStatus, now: Date = new Date()): SubscriptionStatusView {
  switch (status.state) {
    case 'downloading': return { state: 'downloading', done: status.done, total: status.total };
    case 'retrying': return { state: 'retrying', retryAt: clockTime(status.at) };
    case 'scheduled': return { state: 'scheduled', next: upcomingTime(status.nextCheckAt, now) };
    case 'failing': return { state: 'failing', streak: status.failures, retryAt: status.nextCheckAt ? upcomingTime(status.nextCheckAt, now) : null };
    case 'auto_paused': return { state: 'auto_paused', streak: status.failures };
    default: return { state: status.state };
  }
}

/**
 * A subscription's status column: "排隊中", "新增中", "檢查中", "下載中 3/10", "錯誤・14:02 重試",
 * "下次 18:52", "下次 明天 08:00", "下次 10-24 08:00", "錯誤（連續 3 次）・19:44 重試",
 * "錯誤（連續 3 次）" while automatic checks are off, "已暫停", "已暫停・連續失敗 5 次",
 * "自動檢查已關閉" or "需要重新登入".
 */
export function subscriptionStatusText(status: SubscriptionCheckStatus, now: Date = new Date()): string {
  const view = subscriptionStatus(status, now);
  switch (view.state) {
    case 'queued': return '排隊中';
    case 'adding': return '新增中';
    case 'checking': return '檢查中';
    case 'downloading': return `下載中 ${view.done}/${view.total}`;
    case 'retrying': return retryAtText(view.retryAt);
    case 'scheduled': return `下次 ${upcomingTimeText(view.next)}`;
    case 'failing': {
      const failing = `錯誤（連續 ${view.streak} 次）`;
      return view.retryAt ? `${failing}・${upcomingTimeText(view.retryAt)} 重試` : failing;
    }
    case 'paused': return '已暫停';
    case 'auto_paused': return `已暫停・連續失敗 ${view.streak} 次`;
    case 'auto_check_off': return '自動檢查已關閉';
    case 'login_required': return '需要重新登入';
  }
}

/** The local hour and minute of a time, "14:02". */
export function clockTime(value: string): string {
  const date = new Date(value);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Work that waits for a retry or a cooldown until `time`: "錯誤・14:02 重試". */
export function retryAtText(time: string): string {
  return `錯誤・${time} 重試`;
}

/** The status chip's color class for a subscription status; queued and paused chips stay gray, failures are red. */
export function subscriptionStatusTone(status: SubscriptionCheckStatus): 'queued' | 'collecting' | 'retrying' | 'tracking' | 'paused' | 'error' {
  switch (status.state) {
    case 'queued': return 'queued';
    case 'adding': case 'checking': case 'downloading': return 'collecting';
    case 'retrying': return 'retrying';
    case 'scheduled': return 'tracking';
    case 'failing': case 'auto_paused': case 'login_required': return 'error';
    default: return 'paused';
  }
}

/**
 * A status chip's state as data attributes, for readers that need the state rather than its words:
 * `data-phase` is the status state, a download adds `data-done` and `data-total`, a failure count
 * `data-failures`.
 */
export function subscriptionStatusData(status: SubscriptionCheckStatus): Record<string, string> {
  return {
    'data-phase': status.state,
    ...(status.state === 'downloading' ? { 'data-done': String(status.done), 'data-total': String(status.total) } : {}),
    ...('failures' in status ? { 'data-failures': String(status.failures) } : {}),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

const TRIGGER_LABELS: Record<ChannelJobTrigger, string> = {
  subscribe: '首次收集', resume: '恢復後檢查', scheduled: '定時檢查', manual: '立即檢查',
};

export function triggerLabel(trigger: ChannelJobTrigger | null, type?: string | null): string {
  return (trigger && TRIGGER_LABELS[trigger]) || `${targetNoun(type)}收集`;
}
