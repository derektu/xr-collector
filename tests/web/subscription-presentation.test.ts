import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Subscription } from '../../src/core/types.js';
import { asksAboutDocuments, backfillPhrase, removeChoices, removedMessage, resumeSummary, subscribeSummary, subscriptionStatusText, subscriptionStatusTone } from '../../src/web/subscription-presentation.js';

const settings = { intervalMinutes: 30, backfillDays: 30, backfillMaxItems: 10 };

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'UC1', title: '頻道', url: 'https://www.youtube.com/channel/UC1/videos', enabled: true, addedAt: '2026-10-01T00:00:00.000Z',
    settings, status: 'tracking', checkStatus: { state: 'scheduled', nextCheckAt: '2026-10-15T10:52:00.000Z' }, capturing: false, lastError: null, activeJob: null, documentCount: 12, lastCollectedAt: null, ...overrides,
  };
}

describe('subscription presentation (A6)', () => {
  it('summarizes subscribing with the settings chosen on the card', () => {
    expect(subscribeSummary(settings, true, 'youtube'))
      .toBe('訂閱後立即檢查，之後每 30 分鐘檢查一次；每次檢查收集最近 30 天內最新的 10 支影片，已收集或刪除的不再收集。');
    expect(subscribeSummary({ intervalMinutes: 180, backfillDays: 14, backfillMaxItems: 5 }, true, 'youtube'))
      .toBe('訂閱後立即檢查，之後每 3 小時檢查一次；每次檢查收集最近 14 天內最新的 5 支影片，已收集或刪除的不再收集。');
    expect(subscribeSummary({ ...settings, intervalMinutes: 1440 }, true, 'youtube')).toContain('之後每天檢查一次；');
    expect(subscribeSummary(settings, false, 'youtube')).toBe('訂閱後立即檢查，收集最近 30 天內最新的 10 支影片。自動檢查已關閉，開啟後才會定時檢查。');
  });

  it('words the range of every check, a resume and the removal choices', () => {
    expect(backfillPhrase({ backfillDays: 7, backfillMaxItems: 5 }, 'youtube')).toBe('最近 7 天內最新的 5 支影片');
    expect(resumeSummary({ intervalMinutes: 60, backfillDays: 45, backfillMaxItems: 20 }, 'youtube'))
      .toBe('這個訂閱已暫停。恢復後立即檢查，之後每 1 小時檢查一次；每次檢查收集最近 45 天內最新的 20 支影片，已收集或刪除的不再收集。');
    expect(removeChoices(subscription())).toEqual([
      { value: 'keep', label: '保留 12 份文件' },
      { value: 'delete', label: '一併刪除 12 份文件' },
    ]);
    expect(removedMessage('頻道', null)).toBe('已移除「頻道」，文件保留。');
    expect(removedMessage('頻道', { documentsDeleted: 12, documentsFailed: 0 })).toBe('已移除「頻道」，並刪除 12 份文件。');
    expect(removedMessage('頻道', { documentsDeleted: 10, documentsFailed: 2 })).toBe('已移除「頻道」，刪除 10 份文件，2 份無法刪除。');
    expect(removeChoices(subscription({ documentCount: 0 }))).toEqual([{ value: 'keep', label: '保留文件' }, { value: 'delete', label: '一併刪除文件' }]);
    expect(asksAboutDocuments(subscription())).toBe(true);
    expect(asksAboutDocuments(subscription({ documentCount: 0 }))).toBe(false);
    expect(asksAboutDocuments(subscription({ documentCount: 0, capturing: true }))).toBe(true);
    expect(asksAboutDocuments(subscription({ documentCount: 0, checkStatus: { state: 'checking' } }))).toBe(true);
    expect(asksAboutDocuments(subscription({ documentCount: 0, checkStatus: { state: 'downloading', done: 1, total: 3 } }))).toBe(true);
    expect(asksAboutDocuments(subscription({ documentCount: 0, checkStatus: { state: 'retrying', at: '2026-10-15T06:02:00.000Z', cause: { reason: 'rate_limited' } } }))).toBe(true);
    expect(asksAboutDocuments(subscription({ documentCount: 0, checkStatus: { state: 'queued' } }))).toBe(true);
  });
});

describe('subscription status text (N75-T4)', () => {
  const originalZone = process.env.TZ;
  beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
  afterEach(() => { process.env.TZ = originalZone; });

  it('words every status, progress once the total is known, and the next check by day', () => {
    const now = new Date('2026-10-15T06:00:00.000Z'); // 14:00 in Taipei
    expect(subscriptionStatusText({ state: 'queued' }, now)).toBe('排隊中');
    expect(subscriptionStatusText({ state: 'adding' }, now)).toBe('新增中');
    expect(subscriptionStatusText({ state: 'checking' }, now)).toBe('檢查中');
    expect(subscriptionStatusText({ state: 'downloading', done: 3, total: 10 }, now)).toBe('下載中 3/10');
    const error = { code: 'network_error', message: '無法連線到 YouTube。' };
    expect(subscriptionStatusText({ state: 'retrying', at: '2026-10-15T06:02:00.000Z', cause: { reason: 'failed', error, attempt: 2, maxAttempts: 3 } }, now)).toBe('錯誤・14:02 重試');
    expect(subscriptionStatusText({ state: 'scheduled', nextCheckAt: '2026-10-15T10:52:00.000Z' }, now)).toBe('下次 18:52');
    expect(subscriptionStatusText({ state: 'scheduled', nextCheckAt: '2026-10-16T00:05:00.000Z' }, now)).toBe('下次 明天 08:05');
    expect(subscriptionStatusText({ state: 'scheduled', nextCheckAt: '2026-10-16T16:30:00.000Z' }, now)).toBe('下次 10-17 00:30');
    expect(subscriptionStatusText({ state: 'paused' }, now)).toBe('已暫停');
    expect(subscriptionStatusText({ state: 'auto_check_off' }, now)).toBe('自動檢查已關閉');
    expect(subscriptionStatusText({ state: 'login_required' }, now)).toBe('需要重新登入');
  });

  it('colors working, retrying, scheduled, waiting, stopped and sign-in states apart', () => {
    expect(subscriptionStatusTone({ state: 'adding' })).toBe('collecting');
    expect(subscriptionStatusTone({ state: 'checking' })).toBe('collecting');
    expect(subscriptionStatusTone({ state: 'downloading', done: 0, total: 3 })).toBe('collecting');
    expect(subscriptionStatusTone({ state: 'retrying', at: '2026-10-15T06:02:00.000Z', cause: { reason: 'rate_limited' } })).toBe('retrying');
    expect(subscriptionStatusTone({ state: 'queued' })).toBe('queued');
    expect(subscriptionStatusTone({ state: 'scheduled', nextCheckAt: '2026-10-15T10:52:00.000Z' })).toBe('tracking');
    expect(subscriptionStatusTone({ state: 'paused' })).toBe('paused');
    expect(subscriptionStatusTone({ state: 'auto_check_off' })).toBe('paused');
    expect(subscriptionStatusTone({ state: 'login_required' })).toBe('error');
  });
});
