import type { ChannelJobTrigger } from '../../shared/jobs/job-types.js';
import type { Subscription, SubscriptionCheckStatus, SubscriptionSettings } from '../../shared/subscriptions/subscription-types.js';
import { intervalLabel } from '../../shared/subscriptions/check-interval.js';
import { upcomingTime, upcomingTimeText, type UpcomingTime } from '../../shared/subscriptions/upcoming-time.js';
import type { SourceDeclarations } from '../../shared/sources/source-registry.js';
import type { SubscriptionDeclaration } from '../../shared/sources/source-contract.js';

export { intervalLabel };

function subscriptionOf(declarations: SourceDeclarations, type: string | null | undefined): SubscriptionDeclaration | undefined {
  return type ? declarations.get(type)?.subscription : undefined;
}

export function targetNoun(declarations: SourceDeclarations, type: string | null | undefined): string {
  return subscriptionOf(declarations, type)?.targetNoun ?? '';
}

export function itemNoun(declarations: SourceDeclarations, type: string | null | undefined): string {
  return (type ? declarations.get(type)?.item.noun : undefined) ?? '';
}

export function itemCount(declarations: SourceDeclarations, type: string | null | undefined, count: number): string {
  const item = type ? declarations.get(type)?.item : undefined;
  return `${count}${item ? ` ${item.measure}${item.noun}` : ''}`;
}

export function backfillPhrase(declarations: SourceDeclarations, settings: Partial<SubscriptionSettings>, type: string | null | undefined): string {
  return subscriptionOf(declarations, type)?.describeSettings(settings as SubscriptionSettings) ?? '';
}

export type SubscribePlan = { autoCheck: true; intervalMinutes: number } | { autoCheck: false };

export function subscribePlan(settings: SubscriptionSettings, autoCollection: boolean): SubscribePlan {
  return autoCollection ? { autoCheck: true, intervalMinutes: settings.intervalMinutes } : { autoCheck: false };
}

export function subscribeSummary(declarations: SourceDeclarations, settings: SubscriptionSettings, autoCollection: boolean, type: string | null | undefined): string {
  const plan = subscribePlan(settings, autoCollection);
  return plan.autoCheck
    ? `訂閱後立即檢查，之後${intervalLabel(plan.intervalMinutes)}檢查一次；每次檢查收集${backfillPhrase(declarations, settings, type)}，已收集或刪除的不再收集。`
    : `訂閱後立即檢查，收集${backfillPhrase(declarations, settings, type)}。自動檢查已關閉，開啟後才會定時檢查。`;
}

export function resumeSummary(declarations: SourceDeclarations, settings: SubscriptionSettings, type: string | null | undefined): string {
  return `這個訂閱已暫停。恢復後立即檢查，之後${intervalLabel(settings.intervalMinutes)}檢查一次；每次檢查收集${backfillPhrase(declarations, settings, type)}，已收集或刪除的不再收集。`;
}

export interface RemoveOption {
  value: 'keep' | 'delete';
  documents: number | null;
}

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

export function asksAboutDocuments(subscription: Pick<Subscription, 'documentCount' | 'checkStatus' | 'capturing'>): boolean {
  return subscription.documentCount > 0 || subscription.capturing || ACTIVE_STATES.has(subscription.checkStatus.state);
}

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

export function removedMessage(title: string, deleted: { documentsDeleted: number; documentsFailed: number } | null): string {
  const outcome = removalOutcome(deleted);
  switch (outcome.documents) {
    case 'kept': return `已移除「${title}」，文件保留。`;
    case 'partly_deleted': return `已移除「${title}」，刪除 ${outcome.deleted} 份文件，${outcome.failed} 份無法刪除。`;
    case 'deleted': return `已移除「${title}」，並刪除 ${outcome.deleted} 份文件。`;
  }
}

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

export function clockTime(value: string): string {
  const date = new Date(value);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function retryAtText(time: string): string {
  return `錯誤・${time} 重試`;
}

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

export function triggerLabel(declarations: SourceDeclarations, trigger: ChannelJobTrigger | null, type?: string | null): string {
  return (trigger && TRIGGER_LABELS[trigger]) || `${targetNoun(declarations, type)}收集`;
}
