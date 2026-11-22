import { describe, expect, it } from 'vitest';
import type { CollectionJob } from '../../../src/shared/jobs/job-types.js';
import { jobKind } from '../../../src/transport/web/job-presentation.js';
import { PRODUCT_DECLARATIONS } from '../../support/product-sources.js';

function job(overrides: Partial<CollectionJob>): CollectionJob {
  return {
    id: 'job-1', kind: 'youtube.video', state: 'completed', phase: 'index', vaultPath: '/vault', parentId: null,
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
});
