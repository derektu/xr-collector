import { describe, expect, it } from 'vitest';
import { caughtUp, receive, staleAfter } from '../../src/web/change-feed.js';

describe('change stream on screen', () => {
  it('makes each screen stale only after changes to what it shows, and every screen after a replaced Vault', () => {
    const jobs = staleAfter(['jobs']);
    expect(jobs({ kind: 'job', id: 'j', parentId: null, state: 'running' })).toBe(true);
    expect(jobs({ kind: 'document', id: 'd' })).toBe(false);
    expect(jobs({ kind: 'vault', scope: 'transfer' })).toBe(false);
    expect(jobs({ kind: 'vault', scope: 'contents' })).toBe(true);
    expect(staleAfter(['transfer'])({ kind: 'vault', scope: 'transfer' })).toBe(true);
    expect(staleAfter(['documents', 'search'])({ kind: 'search' })).toBe(true);
  });

  it('follows batches in order, ignores ones already received and reads everything again on reset or another instance', () => {
    const batch = (revision: string) => ({ type: 'change' as const, batch: { revision, at: '', changes: [{ kind: 'schedule' as const }] } });
    let state = receive(null, { type: 'hello', revision: 'ab:3' });
    expect(state).toEqual({ revision: 'ab:3', refresh: { kind: 'none' } });
    state = receive(state.revision, batch('ab:4'));
    expect(state).toEqual({ revision: 'ab:4', refresh: { kind: 'changes', changes: [{ kind: 'schedule' }] } });
    expect(receive(state.revision, batch('ab:4')).refresh).toEqual({ kind: 'none' });
    expect(receive(state.revision, { type: 'hello', revision: 'ab:4' }).refresh).toEqual({ kind: 'none' });
    expect(receive(state.revision, { type: 'hello', revision: 'cd:0' })).toEqual({ revision: 'cd:0', refresh: { kind: 'all' } });
    expect(receive(state.revision, { type: 'reset', revision: 'ab:9' })).toEqual({ revision: 'ab:9', refresh: { kind: 'all' } });
  });

  it('counts a screen caught up only at the same instance and an equal or newer revision', () => {
    expect(caughtUp('ab:4', 'ab:4')).toBe(true);
    expect(caughtUp('ab:5', 'ab:4')).toBe(true);
    expect(caughtUp('ab:3', 'ab:4')).toBe(false);
    expect(caughtUp('cd:9', 'ab:4')).toBe(false);
    expect(caughtUp(null, 'ab:4')).toBe(false);
  });
});
