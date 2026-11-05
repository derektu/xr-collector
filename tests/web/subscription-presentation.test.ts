// How subscriptions read in the window: whether subscribing checks again on its own, the choices
// and result of removal with or without documents, and every subscription status with its
// progress, retry time, failures in a row, next check, and color.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Subscription } from '../../src/core/types.js';
import {
  asksAboutDocuments, removalOutcome, removeOptions, subscribePlan, subscriptionStatus, subscriptionStatusTone,
} from '../../src/web/subscription-presentation.js';

const settings = { intervalMinutes: 30, backfillDays: 30, backfillMaxItems: 10 };

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'UC1', title: 'Channel', url: 'https://www.youtube.com/channel/UC1/videos', enabled: true, addedAt: '2026-10-01T00:00:00.000Z',
    settings, status: 'tracking', checkStatus: { state: 'scheduled', nextCheckAt: '2026-10-15T10:52:00.000Z' }, capturing: false, lastError: null, activeJob: null, documentCount: 12, lastCollectedAt: null, ...overrides,
  };
}

describe('subscription presentation (A6)', () => {
  it('checks again at the subscription\'s interval only while automatic checks are on', () => {
    expect(subscribePlan(settings, true)).toEqual({ autoCheck: true, intervalMinutes: 30 });
    expect(subscribePlan({ ...settings, intervalMinutes: 1440 }, true)).toEqual({ autoCheck: true, intervalMinutes: 1440 });
    expect(subscribePlan(settings, false)).toEqual({ autoCheck: false });
  });

  it('counts the documents in the removal choices and states what removal did with them', () => {
    expect(removeOptions(subscription())).toEqual([{ value: 'keep', documents: 12 }, { value: 'delete', documents: 12 }]);
    expect(removeOptions(subscription({ documentCount: 0 }))).toEqual([{ value: 'keep', documents: null }, { value: 'delete', documents: null }]);
    expect(removalOutcome(null)).toEqual({ documents: 'kept' });
    expect(removalOutcome({ documentsDeleted: 12, documentsFailed: 0 })).toEqual({ documents: 'deleted', deleted: 12 });
    expect(removalOutcome({ documentsDeleted: 10, documentsFailed: 2 })).toEqual({ documents: 'partly_deleted', deleted: 10, failed: 2 });
  });

  it('asks about documents while the subscription has some or may still save one', () => {
    expect(asksAboutDocuments(subscription())).toBe(true);
    expect(asksAboutDocuments(subscription({ documentCount: 0 }))).toBe(false);
    expect(asksAboutDocuments(subscription({ documentCount: 0, capturing: true }))).toBe(true);
    expect(asksAboutDocuments(subscription({ documentCount: 0, checkStatus: { state: 'checking' } }))).toBe(true);
    expect(asksAboutDocuments(subscription({ documentCount: 0, checkStatus: { state: 'downloading', done: 1, total: 3 } }))).toBe(true);
    expect(asksAboutDocuments(subscription({ documentCount: 0, checkStatus: { state: 'retrying', at: '2026-10-15T06:02:00.000Z', cause: { reason: 'rate_limited' } } }))).toBe(true);
    expect(asksAboutDocuments(subscription({ documentCount: 0, checkStatus: { state: 'queued' } }))).toBe(true);
  });
});

describe('subscription status (N75-T4)', () => {
  const originalZone = process.env.TZ;
  beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
  afterEach(() => { process.env.TZ = originalZone; });

  it('carries every status with its progress, retry time, failures in a row and next check', () => {
    const now = new Date('2026-10-15T06:00:00.000Z'); // 14:00 in Taipei
    for (const state of ['queued', 'adding', 'checking', 'paused', 'auto_check_off', 'login_required'] as const) {
      expect(subscriptionStatus({ state }, now)).toEqual({ state });
    }
    expect(subscriptionStatus({ state: 'downloading', done: 3, total: 10 }, now)).toEqual({ state: 'downloading', done: 3, total: 10 });
    const error = { code: 'network_error', message: 'unreachable' };
    expect(subscriptionStatus({ state: 'retrying', at: '2026-10-15T06:02:00.000Z', cause: { reason: 'failed', error, attempt: 2, maxAttempts: 3 } }, now))
      .toEqual({ state: 'retrying', retryAt: '14:02' });
    expect(subscriptionStatus({ state: 'scheduled', nextCheckAt: '2026-10-15T10:52:00.000Z' }, now)).toEqual({ state: 'scheduled', next: { day: 'today', time: '18:52' } });
    expect(subscriptionStatus({ state: 'failing', failures: 3, nextCheckAt: '2026-10-16T00:05:00.000Z' }, now))
      .toEqual({ state: 'failing', streak: 3, retryAt: { day: 'tomorrow', time: '08:05' } });
    expect(subscriptionStatus({ state: 'failing', failures: 1, nextCheckAt: null }, now)).toEqual({ state: 'failing', streak: 1, retryAt: null });
    expect(subscriptionStatus({ state: 'auto_paused', failures: 5 }, now)).toEqual({ state: 'auto_paused', streak: 5 });
  });

  it('colors working, retrying, scheduled, waiting, stopped, failing and sign-in states apart', () => {
    expect(subscriptionStatusTone({ state: 'adding' })).toBe('collecting');
    expect(subscriptionStatusTone({ state: 'checking' })).toBe('collecting');
    expect(subscriptionStatusTone({ state: 'downloading', done: 0, total: 3 })).toBe('collecting');
    expect(subscriptionStatusTone({ state: 'retrying', at: '2026-10-15T06:02:00.000Z', cause: { reason: 'rate_limited' } })).toBe('retrying');
    expect(subscriptionStatusTone({ state: 'queued' })).toBe('queued');
    expect(subscriptionStatusTone({ state: 'scheduled', nextCheckAt: '2026-10-15T10:52:00.000Z' })).toBe('tracking');
    expect(subscriptionStatusTone({ state: 'paused' })).toBe('paused');
    expect(subscriptionStatusTone({ state: 'auto_check_off' })).toBe('paused');
    expect(subscriptionStatusTone({ state: 'login_required' })).toBe('error');
    expect(subscriptionStatusTone({ state: 'failing', failures: 1, nextCheckAt: null })).toBe('error');
    expect(subscriptionStatusTone({ state: 'auto_paused', failures: 5 })).toBe('error');
  });
});
