// Broken, the Reader or a Vault import waits forever on a change it missed, or retries while offline more than one read at a time.
import { describe, expect, it } from 'vitest';
import { eventually } from '../../../support/wait.js';
import type { Change } from '../../../../src/transport/web/api/change-feed.js';
import { readUntil, type ChangeListener, type ChangeSource } from '../../../../src/transport/web/api/read-until.js';

function fakeHub() {
  const listeners = new Set<ChangeListener>();
  const hub: ChangeSource = {
    listen(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    hub,
    change(change: Change) { for (const listener of [...listeners]) listener({ kind: 'changes', changes: [change] }); },
    reconnect() { for (const listener of [...listeners]) listener({ kind: 'all' }); },
    listening: () => listeners.size,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const job: Change = { kind: 'job', id: 'j', parentId: null, state: 'completed' };
const isJob = (change: Change) => change.kind === 'job';

describe('readUntil', () => {
  it('reads again for a change that arrives while the first read is still running, so no change is missed', async () => {
    const feed = fakeHub();
    const answers = [deferred<string>(), deferred<string>()];
    let reads = 0;
    const result = readUntil(feed.hub, () => answers[reads++]!.promise, (value) => value === 'done', isJob);
    feed.change(job);
    answers[0]!.resolve('running');
    await eventually(() => expect(reads).toBe(2));
    answers[1]!.resolve('done');
    await expect(result).resolves.toBe('done');
    expect(feed.listening()).toBe(0);
  });

  it('retries a failed read only after a matching change or a reconnect, one read at a time', async () => {
    const feed = fakeHub();
    const answers = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];
    let reads = 0;
    let running = 0;
    let mostRunning = 0;
    const result = readUntil(feed.hub, () => {
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      return answers[reads++]!.promise.finally(() => { running -= 1; });
    }, (value) => value === 'done', isJob);
    answers[0]!.reject(new Error('offline'));
    await eventually(() => expect(running).toBe(0));
    feed.change({ kind: 'schedule' });
    feed.reconnect();
    await eventually(() => expect(running).toBe(1));
    expect(reads).toBe(2);
    answers[1]!.reject(new Error('offline'));
    await eventually(() => expect(running).toBe(0));
    feed.change(job);
    feed.change(job);
    expect(reads).toBe(3);
    answers[2]!.resolve('running');
    await eventually(() => expect(reads).toBe(4));
    answers[3]!.resolve('done');
    await expect(result).resolves.toBe('done');
    expect(reads).toBe(4);
    expect(mostRunning).toBe(1);
  });

  it('rejects only when the signal aborts', async () => {
    const feed = fakeHub();
    const controller = new AbortController();
    let settled = false;
    let reads = 0;
    const result = readUntil(feed.hub, () => { reads += 1; return Promise.reject(new Error('offline')); }, () => true, isJob, controller.signal);
    void result.then(() => { settled = true; }, () => { settled = true; });
    feed.reconnect();
    await eventually(() => expect(reads).toBe(2));
    expect(settled).toBe(false);
    controller.abort(new Error('closed'));
    await expect(result).rejects.toThrow('closed');
    expect(feed.listening()).toBe(0);
  });
});
