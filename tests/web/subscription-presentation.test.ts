import { describe, expect, it } from 'vitest';
import type { Subscription } from '../../src/core/types.js';
import { backfillPhrase, removeConfirmation, resumeSummary, subscribeSummary } from '../../src/web/subscription-presentation.js';

const settings = { intervalMinutes: 30, backfillWindow: '1m' as const, backfillMaxItems: 10 };

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'UC1', title: '頻道', url: 'https://www.youtube.com/channel/UC1/videos', enabled: true, addedAt: '2026-10-01T00:00:00.000Z',
    settings, status: 'tracking', lastError: null, activeJob: null, documentCount: 12, lastCollectedAt: null, ...overrides,
  };
}

describe('subscription presentation (A6)', () => {
  it('summarizes subscribing with the settings chosen on the card', () => {
    expect(subscribeSummary(settings, true))
      .toBe('訂閱後立即檢查，之後每 30 分鐘檢查一次；每次檢查收集最近 1 個月內最新的 10 支影片，已收集或刪除的不再收集。');
    expect(subscribeSummary({ intervalMinutes: 180, backfillWindow: '2w', backfillMaxItems: 5 }, true))
      .toBe('訂閱後立即檢查，之後每 3 小時檢查一次；每次檢查收集最近 2 週內最新的 5 支影片，已收集或刪除的不再收集。');
    expect(subscribeSummary({ ...settings, intervalMinutes: 1440 }, true)).toContain('之後每天檢查一次；');
    expect(subscribeSummary(settings, false)).toBe('訂閱後立即檢查，收集最近 1 個月內最新的 10 支影片。自動收集目前已暫停，開啟後才會定時檢查。');
  });

  it('words the range of every check, a resume and the removal confirmation', () => {
    expect(backfillPhrase({ backfillWindow: '1w', backfillMaxItems: 5 })).toBe('最近 1 週內最新的 5 支影片');
    expect(resumeSummary({ intervalMinutes: 60, backfillWindow: '3m', backfillMaxItems: 20 }))
      .toBe('這個訂閱已暫停。恢復後立即檢查，之後每 1 小時檢查一次；每次檢查收集最近 3 個月內最新的 20 支影片，已收集或刪除的不再收集。');
    expect(removeConfirmation(subscription())).toBe('停止自動收集，已收集的 12 份文件保留。');
  });
});
