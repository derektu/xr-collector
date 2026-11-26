import { describe, expect, it } from 'vitest';
import type { CollectionJob } from '../../../../src/shared/jobs/job-types.js';
import { jobKind, jobKindLabel } from '../../../../src/transport/web/jobs/job-presentation.js';
import { PRODUCT_DECLARATIONS } from '../../../support/product-sources.js';

function job(overrides: Partial<CollectionJob>): CollectionJob {
  return {
    id: 'job-1', kind: 'youtube.video', state: 'completed', phase: 'index', vaultPath: '/vault', vaultId: 'vault-id', parentId: null,
    source: { type: 'youtube', id: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Video' },
    createdAt: '2026-10-15T00:00:00.000Z', startedAt: null, finishedAt: null, updatedAt: '2026-10-15T00:00:00.000Z',
    progress: null, items: null, result: null, error: null, ...overrides,
  };
}

describe('job presentation', () => {
  it('labels channel jobs by why they ran', () => {
    expect(jobKind(PRODUCT_DECLARATIONS, job({ kind: 'youtube.channel', scope: { trigger: 'subscribe' } }))).toEqual({ kind: 'check', trigger: 'subscribe' });
    expect(jobKind(PRODUCT_DECLARATIONS, job({ kind: 'youtube.channel' }))).toEqual({ kind: 'check', trigger: null });
    expect(jobKind(PRODUCT_DECLARATIONS, job({}))).toEqual({ kind: 'item' });
    expect(jobKind(PRODUCT_DECLARATIONS, job({ kind: 'youtube.channel-add' }))).toEqual({ kind: 'subscribe' });
  });

  it('labels a job of an unregistered source type by its kind instead of calling it a subscription', () => {
    const unregistered = job({ kind: 'podcast.episode', source: { type: 'podcast', id: 'ep1', url: 'https://example.com/ep1', title: 'Episode' } });
    expect(jobKind(PRODUCT_DECLARATIONS, unregistered)).toEqual({ kind: 'unregistered' });
    expect(jobKindLabel(PRODUCT_DECLARATIONS, unregistered)).toBe('podcast.episode');
  });
});
