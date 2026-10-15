import type { BackfillWindow, ChannelSchedule, CollectionJob, CollectionPolicy, Subscription } from '../core/types.js';
import { BACKFILL_LIMITS, BACKFILL_WINDOWS, INTERVAL_OPTIONS } from '../channels/collection-policy.js';
import { dateTimeLabel } from './document-presentation.js';

const WINDOW_LABELS: Record<BackfillWindow, string> = { '1w': '1 週', '2w': '2 週', '1m': '1 個月', '3m': '3 個月', '6m': '6 個月' };

export function intervalLabel(minutes: number): string {
  if (minutes === 1440) return '每天';
  if (minutes % 60 === 0) return `${minutes / 60} 小時`;
  return `${minutes} 分`;
}

export function windowLabel(window: BackfillWindow): string {
  return WINDOW_LABELS[window];
}

export const intervalChoices = INTERVAL_OPTIONS.map((value) => ({ value, label: intervalLabel(value) }));
export const windowChoices = BACKFILL_WINDOWS.map((value) => ({ value, label: windowLabel(value) }));
export const limitChoices = BACKFILL_LIMITS.map((value) => ({ value, label: `${value} 則` }));

/** "每 30 分鐘" style wording for sentences. */
function intervalPhrase(minutes: number): string {
  if (minutes === 1440) return '每天';
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小時`;
  return `每 ${minutes} 分鐘`;
}

/** The backfill range in words, e.g. "最近 1 個月內最新的最多 10 支未收集影片". */
export function backfillPhrase(policy: Pick<CollectionPolicy, 'backfillWindow' | 'backfillMaxItems'>): string {
  return `最近 ${windowLabel(policy.backfillWindow)}內最新的最多 ${policy.backfillMaxItems} 支未收集影片`;
}

/** What subscribing does under the current Global settings; the part after it links to Settings. */
export function subscribeSummary(policy: CollectionPolicy & { enabled: boolean }): { text: string; settingsLead: string; settingsTail: string } {
  const tracking = policy.enabled
    ? `之後${intervalPhrase(policy.intervalMinutes)}自動檢查新內容。`
    : '自動收集目前已暫停，恢復後才會定時檢查新內容。';
  return {
    text: `訂閱後，先收集${backfillPhrase(policy)}，${tracking}`,
    settingsLead: '所有訂閱共用自動收集設定，可在',
    settingsTail: '中調整。',
  };
}

export function subscriptionStatusLabel(subscription: Subscription): string {
  if (subscription.status === 'paused') return '已暫停';
  if (subscription.status === 'collecting') {
    const job = subscription.activeJob;
    return job && job.total > 0 ? `收集中 ${job.done}／${job.total}` : '收集中';
  }
  return '追蹤中';
}

/** Secondary line of a subscription row. */
export function subscriptionDetail(subscription: Subscription, policy: CollectionPolicy | null): string {
  if (subscription.status === 'paused') {
    return policy ? `恢復後補收${backfillPhrase(policy)}。` : '恢復後依自動收集設定補收。';
  }
  const added = subscription.lastCollectedAt ? `最近新增 ${dateTimeLabel(subscription.lastCollectedAt)}` : '尚未新增文件';
  return `${subscription.documentCount} 份文件・${added}`;
}

export function removeConfirmation(subscription: Subscription): string {
  return `停止自動收集，已收集的 ${subscription.documentCount} 份文件保留。`;
}

/** Last and next check times shown in the subscription list header and the Settings card. */
export function checkTimes(schedule: ChannelSchedule): { last: string; next: string } {
  return {
    last: schedule.lastAttemptAt ? dateTimeLabel(schedule.lastAttemptAt) : '尚未檢查',
    next: !schedule.enabled ? '自動收集已暫停' : schedule.nextRunAt ? dateTimeLabel(schedule.nextRunAt) : '尚未排定',
  };
}

const TRIGGER_LABELS = {
  subscribe: '首次收集', resume: '恢復補收', scheduled: '定時檢查', manual: '立即檢查', backlog: '接續收集',
} as const;

/** The reason a channel job ran, for the job list. */
export function channelJobLabel(job: CollectionJob): string {
  return job.scope ? TRIGGER_LABELS[job.scope.trigger] : '頻道收集';
}
