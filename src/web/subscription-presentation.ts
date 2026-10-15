import type { ChannelJobTrigger, CollectionJob, CollectionPolicy, Subscription } from '../core/types.js';
import { intervalLabel, windowLabel } from '../channels/collection-policy.js';

export { intervalLabel, windowLabel };

/** The backfill range in words, e.g. "最近 1 個月內最新的 10 支影片". */
export function backfillPhrase(settings: Pick<CollectionPolicy, 'backfillWindow' | 'backfillMaxItems'>): string {
  return `最近 ${windowLabel(settings.backfillWindow)}內最新的 ${settings.backfillMaxItems} 支影片`;
}

/** What subscribing with `settings` does, as the confirmation card says it. */
export function subscribeSummary(settings: CollectionPolicy, autoCollection: boolean): string {
  return autoCollection
    ? `訂閱後先收集${backfillPhrase(settings)}，之後${intervalLabel(settings.intervalMinutes)}檢查新影片。`
    : `訂閱後先收集${backfillPhrase(settings)}。自動收集目前已暫停，開啟後才會定時檢查新影片。`;
}

/** What resuming a paused subscription does with its own settings. */
export function resumeSummary(settings: CollectionPolicy): string {
  return `這個訂閱已暫停。恢復後補收${backfillPhrase(settings)}，之後${intervalLabel(settings.intervalMinutes)}檢查新影片。`;
}

export function removeConfirmation(subscription: Pick<Subscription, 'documentCount'>): string {
  return `停止自動收集，已收集的 ${subscription.documentCount} 份文件保留。`;
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
