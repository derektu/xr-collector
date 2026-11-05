// How a collection job reads in the window: what it saved and indexed, a channel's step, progress
// and skipped work, why a channel job ran, failures with their error, and whether it resumed after
// a restart.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CollectionJob } from '../../src/core/job-types.js';
import { jobKind, jobProgress, jobResult, jobStep, recovery } from '../../src/web/job-presentation.js';
import { PRODUCT_DECLARATIONS } from '../support/product-sources.js';

const originalZone = process.env.TZ;
beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
afterEach(() => { process.env.TZ = originalZone; });

function job(overrides: Partial<CollectionJob>): CollectionJob {
  return {
    id: 'job-1', kind: 'youtube.video', state: 'completed', phase: 'index', vaultPath: '/vault', parentId: null,
    source: { type: 'youtube', id: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Video' },
    createdAt: '2026-10-15T00:00:00.000Z', startedAt: null, finishedAt: null, updatedAt: '2026-10-15T00:00:00.000Z',
    progress: null, items: null, result: null, error: null, ...overrides,
  };
}

describe('job presentation', () => {
  it('states saving and indexing separately for an item', () => {
    expect(jobResult(PRODUCT_DECLARATIONS, job({ result: { outcome: 'created', saved: true, indexed: true } }))).toEqual({ result: 'item', stored: 'created', indexed: true });
    expect(jobResult(PRODUCT_DECLARATIONS, job({ result: { outcome: 'created', saved: true, indexed: false } }))).toEqual({ result: 'item', stored: 'created', indexed: false });
    expect(jobResult(PRODUCT_DECLARATIONS, job({ result: { outcome: 'existing', saved: true } }))).toEqual({ result: 'item', stored: 'existing', indexed: false });
    expect(jobResult(PRODUCT_DECLARATIONS, job({ result: { outcome: 'skipped', skipReason: 'out_of_range' } }))).toEqual({ result: 'skipped', reason: 'out_of_range' });
  });

  it('states what a check collected and whether a subscription request subscribed', () => {
    const check = (outcome: 'created' | 'existing' | 'partial' | 'empty' | 'skipped') => jobResult(PRODUCT_DECLARATIONS, job({ kind: 'youtube.channel', result: { outcome, skipReason: 'subscription_paused' } }));
    expect(check('created')).toEqual({ result: 'collected' });
    expect(check('partial')).toEqual({ result: 'partial' });
    expect(check('empty')).toEqual({ result: 'nothing_new' });
    expect(check('existing')).toEqual({ result: 'nothing_new' });
    expect(check('skipped')).toEqual({ result: 'skipped', reason: 'subscription_paused' });
    expect(jobResult(PRODUCT_DECLARATIONS, job({ kind: 'rss.feed-add', result: { outcome: 'created' } }))).toEqual({ result: 'subscribed' });
    expect(jobResult(PRODUCT_DECLARATIONS, job({ kind: 'rss.feed-add', result: { outcome: 'existing' } }))).toEqual({ result: 'already_subscribed' });
  });

  it('describes channel steps, progress and failures', () => {
    const channel = job({ kind: 'youtube.channel', state: 'running', phase: 'capture', progress: { total: 10, done: 3, created: 2, existing: 0, failed: 1 } });
    expect(jobStep(PRODUCT_DECLARATIONS, channel)).toBe('collect_items');
    expect(jobStep(PRODUCT_DECLARATIONS, job({ state: 'running', phase: 'capture' }))).toBe('capture');
    expect(jobStep(PRODUCT_DECLARATIONS, job({ kind: 'youtube.channel', state: 'running', phase: 'discover' }))).toBe('discover');
    expect(jobStep(PRODUCT_DECLARATIONS, job({ kind: 'youtube.channel', state: 'queued', phase: 'capture' }))).toBeNull();
    expect(jobProgress(channel)).toEqual({ total: 10, done: 3, created: 2, existing: 0, failed: 1, skipped: null });
    expect(jobProgress(job({ progress: { total: 3, done: 3, created: 1, existing: 0, failed: 0, skipped: 2 } }))).toMatchObject({ skipped: 2 });
    expect(jobProgress(job({}))).toBeNull();
    const error = { code: 'no_subtitles', message: 'no subtitles' };
    expect(jobResult(PRODUCT_DECLARATIONS, job({ state: 'failed', error }))).toEqual({ result: 'failed', error });
    expect(jobResult(PRODUCT_DECLARATIONS, job({ state: 'running' }))).toBeNull();
  });

  it('labels channel jobs by why they ran', () => {
    expect(jobKind(PRODUCT_DECLARATIONS, job({ kind: 'youtube.channel', scope: { trigger: 'subscribe' } }))).toEqual({ kind: 'check', trigger: 'subscribe' });
    expect(jobKind(PRODUCT_DECLARATIONS, job({ kind: 'youtube.channel' }))).toEqual({ kind: 'check', trigger: null });
    expect(jobKind(PRODUCT_DECLARATIONS, job({}))).toEqual({ kind: 'item' });
    expect(jobKind(PRODUCT_DECLARATIONS, job({ kind: 'youtube.channel-add' }))).toEqual({ kind: 'subscribe' });
  });

  it('states restarts and their outcome', () => {
    const resumed = { resumedCount: 1, uncleanStops: 0, lastInterruptedAt: '2026-10-15T06:00:00.000Z', lastResumedAt: '2026-10-15T06:01:00.000Z' };
    expect(recovery(job({ state: 'running', recovery: resumed }))).toBe('continuing');
    expect(recovery(job({ state: 'queued', recovery: resumed }))).toBe('continuing');
    expect(recovery(job({ state: 'completed', recovery: resumed }))).toBe('continued');
    expect(recovery(job({ state: 'running', recovery: { ...resumed, resumedCount: 0 } }))).toBeNull();
    expect(recovery(job({ state: 'completed' }))).toBeNull();
    expect(jobResult(PRODUCT_DECLARATIONS, job({ state: 'interrupted', error: { code: 'interrupted', message: 'stopped' } }))).toEqual({ result: 'interrupted' });
  });
});
