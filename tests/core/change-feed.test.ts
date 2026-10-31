import { describe, expect, it } from 'vitest';
import { ChangeFeed, parseCursor, type ChangeBatch } from '../../src/core/change-feed.js';

function manual(options: { keepBatches?: number; keepMs?: number; now?: () => Date } = {}) {
  const deferred: Array<() => void> = [];
  const feed = new ChangeFeed({ epoch: 'abc', defer: (publish) => deferred.push(publish), ...options });
  const batches: ChangeBatch[] = [];
  feed.subscribe((batch) => batches.push(batch));
  return { feed, batches, turn: () => { for (const publish of deferred.splice(0)) publish(); } };
}

describe('ChangeFeed', () => {
  it('publishes the changes of one turn under one revision, the last state of each resource once', () => {
    const { feed, batches, turn } = manual();
    feed.note({ kind: 'job', id: 'a', parentId: null, state: 'queued' });
    feed.note({ kind: 'document', id: 'youtube:1' });
    feed.note({ kind: 'job', id: 'a', parentId: null, state: 'running' });
    expect(feed.revision).toBe('abc:0');
    turn();
    expect(batches).toEqual([{
      revision: 'abc:1', at: expect.any(String),
      changes: [{ kind: 'document', id: 'youtube:1' }, { kind: 'job', id: 'a', parentId: null, state: 'running' }],
    }]);
    turn();
    expect(batches).toHaveLength(1);
  });

  it('numbers revisions one after another, and a flush publishes at once', () => {
    const { feed, batches, turn } = manual();
    feed.note({ kind: 'schedule' });
    expect(feed.flush()).toBe('abc:1');
    expect(feed.flush()).toBe('abc:1');
    feed.note({ kind: 'search' });
    turn();
    feed.note({ kind: 'update' });
    turn();
    expect(batches.map((batch) => batch.revision)).toEqual(['abc:1', 'abc:2', 'abc:3']);
  });

  it('hands a reader the batches after its revision, and reset once they are no longer all kept', () => {
    let now = 0;
    const { feed } = manual({ keepBatches: 3, keepMs: 10_000, now: () => new Date(now) });
    for (const id of ['1', '2', '3', '4']) { feed.note({ kind: 'document', id }); feed.flush(); }
    expect(feed.since({ epoch: 'abc', number: 2 })).toEqual({ kind: 'batches', batches: [
      expect.objectContaining({ revision: 'abc:3' }), expect.objectContaining({ revision: 'abc:4' }),
    ] });
    expect(feed.since({ epoch: 'abc', number: 1 })).toMatchObject({ kind: 'batches', batches: [{ revision: 'abc:2' }, { revision: 'abc:3' }, { revision: 'abc:4' }] });
    expect(feed.since({ epoch: 'abc', number: 0 })).toEqual({ kind: 'reset' });
    expect(feed.since({ epoch: 'abc', number: 4 })).toEqual({ kind: 'batches', batches: [] });
    expect(feed.since({ epoch: 'abc', number: 5 })).toEqual({ kind: 'reset' });
    expect(feed.since({ epoch: 'other', number: 4 })).toEqual({ kind: 'reset' });
    now = 10_001;
    expect(feed.since({ epoch: 'abc', number: 3 })).toEqual({ kind: 'reset' });
  });

  it('reads cursors only in their own format', () => {
    expect(parseCursor('abc:12')).toEqual({ epoch: 'abc', number: 12 });
    for (const value of ['abc', 'abc:-1', 'ABC:1', 'abc:01', ':1', 'abc:1:2', 12, null]) expect(parseCursor(value)).toBeNull();
  });
});
