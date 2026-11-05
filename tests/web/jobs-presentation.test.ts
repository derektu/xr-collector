// What each row of the Jobs page shows: the title or the address while the title is unknown, the
// source type's icon, the status of started work, when and why it retries, and why it failed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobOverviewEntry } from '../../src/core/types.js';
import { youtubeDeclaration } from '../../src/plugins/youtube/shared.js';
import { jobEntry } from '../../src/web/jobs-presentation.js';
import { PRODUCT_DECLARATIONS } from '../support/product-sources.js';

const target = youtubeDeclaration.subscription?.targetNoun;

const entry = (overrides: Partial<JobOverviewEntry>): JobOverviewEntry => ({
  jobId: 'j', type: 'youtube', role: 'item', title: null, url: 'https://www.youtube.com/watch?v=dQ8vR2kLm4E', publisher: null,
  progress: null, status: null, error: null, failedAt: null, ...overrides,
});

describe('jobs page rows (N69-T11)', () => {
  const timeZone = process.env.TZ;
  beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
  afterEach(() => { process.env.TZ = timeZone; });

  it('names a check, a subscription request and an item, with the address while the title is unknown', () => {
    expect(jobEntry(PRODUCT_DECLARATIONS, entry({ role: 'check', title: 'All-In Podcast' }))).toMatchObject({ title: 'All-In Podcast', named: true, work: { role: 'check', target } });
    expect(jobEntry(PRODUCT_DECLARATIONS, entry({ role: 'add', url: 'https://www.youtube.com/@acquired' }))).toMatchObject({ title: 'youtube.com/@acquired', named: false, work: { role: 'add', target } });
    expect(jobEntry(PRODUCT_DECLARATIONS, entry({}))).toMatchObject({ title: 'youtube.com/watch?v=dQ8vR2kLm4E', named: false, work: { role: 'item', publisher: null } });
    expect(jobEntry(PRODUCT_DECLARATIONS, entry({ title: 'Big Ideas 2026', publisher: 'ARK Invest' }))).toMatchObject({ title: 'Big Ideas 2026', work: { role: 'item', publisher: 'ARK Invest' } });
  });

  it('draws every entry with its source type\'s icon, whatever the work is', () => {
    for (const role of ['check', 'add', 'item'] as const) expect(jobEntry(PRODUCT_DECLARATIONS, entry({ role })).icon).toBe('youtube');
    expect(jobEntry(PRODUCT_DECLARATIONS, entry({ type: 'unregistered', role: 'check', title: 'x' }))).toMatchObject({ icon: 'file', work: { role: 'check', target: null } });
  });

  it('says what started work does, why it waits for a retry and when, and why failed work failed', () => {
    const lastError = { code: 'network_error', message: 'unreachable' };
    const retrying = { state: 'retrying' as const, at: '2026-10-20T02:35:00.000Z', cause: { reason: 'failed' as const, error: lastError, attempt: 2, maxAttempts: 3 } };
    expect(jobEntry(PRODUCT_DECLARATIONS, entry({ status: { state: 'queued' } }))).toMatchObject({ status: null, retry: null, failure: null });
    expect(jobEntry(PRODUCT_DECLARATIONS, entry({ role: 'check', status: { state: 'checking' } })).status).toEqual({ state: 'checking', adding: false });
    expect(jobEntry(PRODUCT_DECLARATIONS, entry({ role: 'add', status: { state: 'checking' } })).status).toEqual({ state: 'checking', adding: true });
    expect(jobEntry(PRODUCT_DECLARATIONS, entry({ role: 'check', status: { state: 'downloading' }, progress: { done: 2, total: 5 } })).status).toEqual({ state: 'downloading', progress: { done: 2, total: 5 } });
    expect(jobEntry(PRODUCT_DECLARATIONS, entry({ status: { state: 'downloading' }, progress: { done: 0, total: 0 } })).status).toEqual({ state: 'downloading', progress: null });
    expect(jobEntry(PRODUCT_DECLARATIONS, entry({ status: retrying }))).toMatchObject({ status: { state: 'retrying', retryAt: '10:35' }, retry: { reason: 'failed', error: lastError, attempt: 2, maxAttempts: 3 } });
    expect(jobEntry(PRODUCT_DECLARATIONS, entry({ status: { state: 'retrying', at: '2026-10-20T02:42:00.000Z', cause: { reason: 'rate_limited' } } })))
      .toMatchObject({ status: { state: 'retrying', retryAt: '10:42' }, retry: { reason: 'rate_limited', source: 'YouTube' } });
    const error = { code: 'no_subtitles', message: 'no subtitles' };
    expect(jobEntry(PRODUCT_DECLARATIONS, entry({ error }))).toMatchObject({ status: null, failure: error });
  });
});
