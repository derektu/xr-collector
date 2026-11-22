// How the window follows the server's change stream: a screen reloads only after changes to what
// it shows, and every screen after the Vault's contents change; batches already received are
// skipped, and a reset or another server instance reloads everything.
import { describe, expect, it } from 'vitest';
import { caughtUp, receive, staleAfter } from '../../../src/transport/web/change-feed.js';

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

  it('re-reads subscriptions after job, document, pacing and schedule changes because their status and counts come from them', () => {
    const subscriptions = staleAfter(['subscriptions']);
    expect(subscriptions({ kind: 'job', id: 'j', parentId: null, state: 'completed' })).toBe(true);
    expect(subscriptions({ kind: 'document', id: 'd' })).toBe(true);
    expect(subscriptions({ kind: 'pacing', group: 'youtube' })).toBe(true);
    expect(subscriptions({ kind: 'schedule' })).toBe(true);
  });

  it('keeps the last revision on a same-instance hello that is ahead, so the batches replayed after it still refresh the screen', () => {
    const hello = receive('ab:4', { type: 'hello', revision: 'ab:7' });
    expect(hello).toEqual({ revision: 'ab:4', refresh: { kind: 'none' } });
    const replayed = receive(hello.revision, { type: 'change', batch: { revision: 'ab:5', at: '', changes: [{ kind: 'document', id: 'd' }] } });
    expect(replayed.refresh).toEqual({ kind: 'changes', changes: [{ kind: 'document', id: 'd' }] });
  });

  it('counts a screen caught up only at the same instance and an equal or newer revision', () => {
    expect(caughtUp('ab:4', 'ab:4')).toBe(true);
    expect(caughtUp('ab:5', 'ab:4')).toBe(true);
    expect(caughtUp('ab:3', 'ab:4')).toBe(false);
    expect(caughtUp('cd:9', 'ab:4')).toBe(false);
    expect(caughtUp(null, 'ab:4')).toBe(false);
  });
});
