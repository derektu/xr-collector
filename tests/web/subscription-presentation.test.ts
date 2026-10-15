import { describe, expect, it } from 'vitest';
import type { ChannelSchedule, Subscription } from '../../src/core/types.js';
import {
  checkTimes,
  intervalChoices,
  limitChoices,
  removeConfirmation,
  subscribeSummary,
  backfillPhrase,
  windowChoices,
} from '../../src/web/subscription-presentation.js';

const policy = { enabled: true, intervalMinutes: 30, backfillWindow: '1m' as const, backfillMaxItems: 10 };

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'UC1', title: '頻道', url: 'https://www.youtube.com/channel/UC1/videos', enabled: true, addedAt: '2026-10-01T00:00:00.000Z',
    status: 'tracking', lastError: null, activeJob: null, documentCount: 12, lastCollectedAt: null, ...overrides,
  };
}

describe('subscription presentation', () => {
  it('builds the subscribe summary from the current Global settings', () => {
    const summary = subscribeSummary(policy);
    expect(`${summary.text}${summary.settingsLead}設定${summary.settingsTail}`).toBe(
      '訂閱後，先收集最近 1 個月內最新的最多 10 支未收集影片，之後每 30 分鐘自動檢查新內容。所有訂閱共用自動收集設定，可在設定中調整。',
    );
    expect(subscribeSummary({ ...policy, backfillWindow: '2w', backfillMaxItems: 5, intervalMinutes: 180 }).text)
      .toBe('訂閱後，先收集最近 2 週內最新的最多 5 支未收集影片，之後每 3 小時自動檢查新內容。');
    expect(subscribeSummary({ ...policy, intervalMinutes: 1440 }).text).toContain('之後每天自動檢查新內容。');
    expect(subscribeSummary({ ...policy, enabled: false }).text).toContain('自動收集目前已暫停');
  });

  it('words the backfill range and the removal confirmation', () => {
    expect(backfillPhrase({ backfillWindow: '1w', backfillMaxItems: 5 })).toBe('最近 1 週內最新的最多 5 支未收集影片');
    expect(removeConfirmation(subscription())).toBe('停止自動收集，已收集的 12 份文件保留。');
  });

  it('offers exactly the values the API accepts', () => {
    expect(intervalChoices.map((choice) => choice.label)).toEqual(['15 分', '30 分', '1 小時', '3 小時', '6 小時', '12 小時', '每天']);
    expect(windowChoices.map((choice) => choice.label)).toEqual(['1 週', '2 週', '1 個月', '3 個月', '6 個月']);
    expect(limitChoices.map((choice) => choice.label)).toEqual(['5 則', '10 則', '20 則', '50 則']);
  });

  it('shows check times and a paused schedule', () => {
    const schedule: ChannelSchedule = {
      ...policy, status: 'scheduled', lastAttemptAt: null, lastCompletedAt: null, nextRunAt: null, lastResult: null,
    };
    expect(checkTimes(schedule)).toEqual({ last: '尚未檢查', next: '尚未排定' });
    expect(checkTimes({ ...schedule, enabled: false }).next).toBe('自動收集已暫停');
  });
});
