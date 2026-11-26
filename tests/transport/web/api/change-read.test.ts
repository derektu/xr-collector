import { describe, expect, it } from 'vitest';
import { createChangeRead, type ReadOutcome } from '../../../../src/transport/web/api/change-read.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness() {
  const requests: Array<{ signal: AbortSignal } & ReturnType<typeof deferred<string>>> = [];
  const answers: ReadOutcome<string>[] = [];
  const reads = createChangeRead((signal) => {
    const request = { signal, ...deferred<string>() };
    requests.push(request);
    return request.promise;
  }, (outcome) => answers.push(outcome));
  const settled = () => new Promise<void>((done) => { queueMicrotask(() => queueMicrotask(() => queueMicrotask(done))); });
  return { reads, requests, answers, settled };
}

describe('reads that follow changes', () => {
  it('keeps a slow read when changes keep coming, so the screen shows a complete answer, then reads once more for them', async () => {
    const { reads, requests, answers, settled } = harness();
    reads.read();
    reads.read();
    reads.read();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(false);
    requests[0]!.resolve('first');
    await settled();
    expect(answers).toEqual([{ value: 'first' }]);
    expect(requests).toHaveLength(2);
    requests[1]!.resolve('second');
    await settled();
    expect(answers).toEqual([{ value: 'first' }, { value: 'second' }]);
    expect(requests).toHaveLength(2);
  });

  it('answers a failed read with its error and still reads again for the changes that came meanwhile', async () => {
    const { reads, requests, answers, settled } = harness();
    reads.read();
    reads.read();
    const offline = new Error('offline');
    requests[0]!.reject(offline);
    await settled();
    expect(answers).toEqual([{ error: offline }]);
    expect(requests).toHaveLength(2);
  });

  it('aborts and ignores the read in flight on cancel, as when the screen asks for different data', async () => {
    const { reads, requests, answers, settled } = harness();
    reads.read();
    reads.read();
    reads.cancel();
    expect(requests[0]!.signal.aborted).toBe(true);
    requests[0]!.resolve('stale');
    await settled();
    expect(answers).toEqual([]);
    expect(requests).toHaveLength(1);
    reads.read();
    expect(requests).toHaveLength(2);
  });
});
