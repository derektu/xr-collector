import type { ChannelJobTrigger, JobView, Subscription, SubscriptionCheckStatus, SubscriptionSettings } from '../core/types.js';
import { intervalLabel } from '../core/check-interval.js';
import { sourceDeclaration } from '../core/source-registry.js';
import type { SubscriptionDeclaration } from '../plugins/types.js';

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

/** The range every check collects, in words, as the source type describes its settings. */
export function backfillPhrase(settings: Partial<SubscriptionSettings>, type: string | null | undefined): string {
  return subscriptionOf(type)?.describeSettings(settings as SubscriptionSettings) ?? '';
}

/** What subscribing with `settings` does, as the confirmation card says it. */
export function subscribeSummary(settings: SubscriptionSettings, autoCollection: boolean, type: string | null | undefined): string {
  return autoCollection
    ? `訂閱後立即檢查，之後${intervalLabel(settings.intervalMinutes)}檢查一次；每次檢查收集${backfillPhrase(settings, type)}，已收集或刪除的不再收集。`
    : `訂閱後立即檢查，收集${backfillPhrase(settings, type)}。自動檢查已關閉，開啟後才會定時檢查。`;
}

/** What resuming a paused subscription does with its own settings. */
export function resumeSummary(settings: SubscriptionSettings, type: string | null | undefined): string {
  return `這個訂閱已暫停。恢復後立即檢查，之後${intervalLabel(settings.intervalMinutes)}檢查一次；每次檢查收集${backfillPhrase(settings, type)}，已收集或刪除的不再收集。`;
}

/** The two choices of removing a subscription for its documents; keeping them is the default. */
export function removeChoices(subscription: Pick<Subscription, 'documentCount'>): Array<{ value: 'keep' | 'delete'; label: string }> {
  const count = subscription.documentCount;
  return [
    { value: 'keep', label: count > 0 ? `保留 ${count} 份文件` : '保留文件' },
    { value: 'delete', label: count > 0 ? `一併刪除 ${count} 份文件` : '一併刪除文件' },
  ];
}

const ACTIVE_STATES: ReadonlySet<SubscriptionCheckStatus['state']> = new Set(['queued', 'checking', 'downloading', 'retrying']);

/**
 * Whether removing the subscription asks about its documents: it has some, or a check or a
 * capture of it is still running and may save one.
 */
export function asksAboutDocuments(subscription: Pick<Subscription, 'documentCount' | 'checkStatus' | 'capturing'>): boolean {
  return subscription.documentCount > 0 || subscription.capturing || ACTIVE_STATES.has(subscription.checkStatus.state);
}

/** What removing a subscription did, as its log entry also says it. */
export function removedMessage(title: string, deleted: { documentsDeleted: number; documentsFailed: number } | null): string {
  if (deleted === null) return `已移除「${title}」，文件保留。`;
  return deleted.documentsFailed > 0
    ? `已移除「${title}」，刪除 ${deleted.documentsDeleted} 份文件，${deleted.documentsFailed} 份無法刪除。`
    : `已移除「${title}」，並刪除 ${deleted.documentsDeleted} 份文件。`;
}

/**
 * A subscription's status column: "排隊中", "新增中", "檢查中", "下載中 3/10", "錯誤・14:02 重試",
 * "下次 18:52", "下次 明天 08:00", "下次 10-24 08:00", "已暫停", "自動檢查已關閉" or "需要重新登入".
 */
export function subscriptionStatusText(status: SubscriptionCheckStatus, now: Date = new Date()): string {
  switch (status.state) {
    case 'queued': return '排隊中';
    case 'adding': return '新增中';
    case 'checking': return '檢查中';
    case 'downloading': return `下載中 ${status.done}/${status.total}`;
    case 'retrying': return retryingText(status.at);
    case 'scheduled': return `下次 ${nextTimeLabel(status.nextCheckAt, now)}`;
    case 'paused': return '已暫停';
    case 'auto_check_off': return '自動檢查已關閉';
    case 'login_required': return '需要重新登入';
  }
}

/** Work that waits for a retry or a cooldown: "錯誤・14:02 重試". */
export function retryingText(at: string): string {
  const date = new Date(at);
  return `錯誤・${pad(date.getHours())}:${pad(date.getMinutes())} 重試`;
}

/** The status chip's color class for a subscription status; queued and paused chips stay gray. */
export function subscriptionStatusTone(status: SubscriptionCheckStatus): 'queued' | 'collecting' | 'retrying' | 'tracking' | 'paused' | 'error' {
  switch (status.state) {
    case 'queued': return 'queued';
    case 'adding': case 'checking': case 'downloading': return 'collecting';
    case 'retrying': return 'retrying';
    case 'scheduled': return 'tracking';
    case 'login_required': return 'error';
    default: return 'paused';
  }
}

/** A coming time: "18:52" today, "明天 08:00", "10-24 08:00" on a later day. */
function nextTimeLabel(value: string, now: Date): string {
  const date = new Date(value);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = (offset: number) => {
    const reference = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return date.getFullYear() === reference.getFullYear() && date.getMonth() === reference.getMonth() && date.getDate() === reference.getDate();
  };
  if (sameDay(0) || date.getTime() < now.getTime()) return time;
  if (sameDay(1)) return `明天 ${time}`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

const TRIGGER_LABELS: Record<ChannelJobTrigger, string> = {
  subscribe: '首次收集', resume: '恢復後檢查', scheduled: '定時檢查', manual: '立即檢查',
};

/** The reason a check job ran, for the job list. */
export function channelJobLabel(job: JobView): string {
  return triggerLabel(job.scope?.trigger ?? null, job.source.type);
}

export function triggerLabel(trigger: ChannelJobTrigger | null, type?: string | null): string {
  return (trigger && TRIGGER_LABELS[trigger]) || `${targetNoun(type)}收集`;
}
