import type { ChannelJobTrigger, ChannelSchedule, CollectionJob, CollectionPolicy, Subscription } from '../core/types.js';
import { BACKFILL_LIMITS, BACKFILL_WINDOWS, INTERVAL_OPTIONS, intervalLabel, windowLabel } from '../channels/collection-policy.js';
import { dateTimeLabel } from './document-presentation.js';

export { intervalLabel, windowLabel };

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

export function removeConfirmation(subscription: Pick<Subscription, 'documentCount'>): string {
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
  return triggerLabel(job.scope?.trigger ?? null);
}

export function triggerLabel(trigger: ChannelJobTrigger | null): string {
  return trigger ? TRIGGER_LABELS[trigger] : '頻道收集';
}
