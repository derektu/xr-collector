import { describe, expect, it } from 'vitest';
import { inOwnStep, workKey, type RoleJob } from '../../../src/shared/jobs/job-role.js';
import type { CollectionJob, JobPhase } from '../../../src/shared/jobs/job-types.js';
import { PRODUCT_DECLARATIONS } from '../../support/product-sources.js';

function running(kind: string, phase: JobPhase | null): RoleJob & Pick<CollectionJob, 'state' | 'phase'> {
  return {
    kind, state: 'running', phase, parentId: null, progress: null, result: null,
    source: { type: kind.slice(0, kind.indexOf('.')), id: 'UC1', url: 'https://www.youtube.com/@one', title: null },
  };
}

describe('inOwnStep', () => {
  it('counts a check past discovery as not in its own step, since it only waits for its items', () => {
    expect(inOwnStep(PRODUCT_DECLARATIONS, running('youtube.channel', 'discover'))).toBe(true);
    expect(inOwnStep(PRODUCT_DECLARATIONS, running('youtube.channel', 'capture'))).toBe(false);
  });

  it('counts a running job of an unregistered type as in its own step whenever it has a phase, so a stop during it counts as unclean', () => {
    for (const phase of ['resolve', 'discover', 'capture', 'save', 'index'] as const) {
      expect(inOwnStep(PRODUCT_DECLARATIONS, running('gone.item', phase))).toBe(true);
    }
    expect(inOwnStep(PRODUCT_DECLARATIONS, running('gone.item', null))).toBe(false);
  });
});

describe('workKey', () => {
  it('treats subscription addresses differing only in letter case as the same request, while item keys and subscription IDs keep their case since source IDs can differ by case alone', () => {
    expect(workKey('youtube', 'add', 'https://www.YouTube.com/@One')).toBe(workKey('youtube', 'add', 'https://www.youtube.com/@one'));
    expect(workKey('youtube', 'item', 'AbCdEfGhIjK')).not.toBe(workKey('youtube', 'item', 'abcdefghijk'));
    expect(workKey('youtube', 'check', 'UCAbC')).not.toBe(workKey('youtube', 'check', 'UCabc'));
  });
});
