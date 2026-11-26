// Broken, a screen keeps showing outdated data or reloads on unrelated changes.
import { describe, expect, it } from 'vitest';
import { staleAfter, type Change, type Resource } from '../../../../src/transport/web/api/change-feed.js';

const job: Change = { kind: 'job', id: 'j', parentId: null, state: 'running' };

describe('change stream on screen', () => {
  it.each<[string, Resource[], Change, boolean]>([
    ['the jobs screen reads again after a job change', ['jobs'], job, true],
    ['the jobs screen ignores a document change', ['jobs'], { kind: 'document', id: 'd' }, false],
    ['the jobs screen ignores a transfer status change', ['jobs'], { kind: 'vault', scope: 'transfer' }, false],
    ['every screen reads again after the Vault contents are replaced', ['jobs'], { kind: 'vault', scope: 'contents' }, true],
    ['the transfer screen reads again after a transfer status change', ['transfer'], { kind: 'vault', scope: 'transfer' }, true],
    ['a screen showing several resources reads again after a change to any of them', ['documents', 'search'], { kind: 'search' }, true],
    ['subscriptions read again after a job change because their status comes from jobs', ['subscriptions'], { ...job, state: 'completed' }, true],
    ['subscriptions read again after a document change because their counts come from documents', ['subscriptions'], { kind: 'document', id: 'd' }, true],
    ['subscriptions read again after a pacing change because their status shows cooldowns', ['subscriptions'], { kind: 'pacing', group: 'youtube' }, true],
    ['subscriptions read again after a schedule change because their next check comes from it', ['subscriptions'], { kind: 'schedule' }, true],
  ])('%s', (_rule, resources, change, stale) => {
    expect(staleAfter(resources)(change)).toBe(stale);
  });
});
