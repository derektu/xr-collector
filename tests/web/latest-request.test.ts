import { describe, expect, it } from 'vitest';
import { createLatestRequest } from '../../src/web/latest-request.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('createLatestRequest', () => {
  it('drops an older response that arrives after a newer request and aborts the older request', async () => {
    const requests = createLatestRequest();
    const slow = deferred<string>();
    const fast = deferred<string>();
    let firstSignal: AbortSignal | undefined;

    const first = requests.run((signal) => { firstSignal = signal; return slow.promise; });
    const second = requests.run(() => fast.promise);
    fast.resolve('B 的結果');
    slow.resolve('A 的結果');

    await expect(second).resolves.toEqual({ current: true, value: 'B 的結果' });
    await expect(first).resolves.toEqual({ current: false });
    expect(firstSignal?.aborted).toBe(true);
  });

  it('reports errors only for the current request', async () => {
    const requests = createLatestRequest();
    const stale = requests.run(async () => { await Promise.resolve(); throw new Error('舊查詢失敗'); });
    const current = requests.run(async () => 'ok');
    await expect(stale).resolves.toEqual({ current: false });
    await expect(current).resolves.toEqual({ current: true, value: 'ok' });
    await expect(requests.run(async () => { throw new Error('目前查詢失敗'); })).rejects.toThrow('目前查詢失敗');
  });

  it('ignores every pending response after cancel', async () => {
    const requests = createLatestRequest();
    const pending = deferred<string>();
    const run = requests.run(() => pending.promise);
    requests.cancel();
    pending.resolve('late');
    await expect(run).resolves.toEqual({ current: false });
  });
});
