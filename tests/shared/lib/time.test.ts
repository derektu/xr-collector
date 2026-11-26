// Broken, startup or collection hangs on an outside process that never answers, or the timeout error does not say what it waited for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deadline, waitUntil } from '../../../src/shared/lib/time.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('waitUntil, so polling an outside state never waits forever', () => {
  it('returns what the check returns once it is truthy', async () => {
    let checks = 0;
    const waiting = waitUntil(() => (++checks === 3 ? { ready: true } : null), { interval: 50, timeout: 1_000, label: 'the engine' });

    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toEqual({ ready: true });
  });

  it('gives up after the timeout with an error naming what it waited for', async () => {
    const waiting = waitUntil(() => false, { interval: 50, timeout: 1_000, label: 'the engine' });
    const settled = expect(waiting).rejects.toThrow('waiting for the engine');

    await vi.advanceTimersByTimeAsync(1_000);

    await settled;
  });

  it('checks one last time when the timeout comes', async () => {
    const start = Date.now();
    const waiting = waitUntil(() => Date.now() >= start + 1_000, { interval: 300, timeout: 1_000, label: 'the end' });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(waiting).resolves.toBe(true);
  });

  it('ends at once on an error retryOn does not accept', async () => {
    const check = vi.fn(() => { throw new Error('broken'); });

    await expect(waitUntil(check, { interval: 50, timeout: 1_000, label: 'x', retryOn: () => false })).rejects.toThrow('broken');
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('throws the last error retryOn accepted when the timeout comes', async () => {
    let attempt = 0;
    const waiting = waitUntil(() => { throw new Error(`busy ${++attempt}`); }, { interval: 500, timeout: 1_000, label: 'x', retryOn: () => true });
    const settled = expect(waiting).rejects.toThrow('busy 3');

    await vi.advanceTimersByTimeAsync(1_000);

    await settled;
  });
});

describe('deadline, so an outside operation that hangs ends', () => {
  it('aborts with a TimeoutError when the time is up', async () => {
    const signal = deadline(1_000);

    await vi.advanceTimersByTimeAsync(999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(signal.reason).toMatchObject({ name: 'TimeoutError' });
  });

  it('aborts with the reason it was given', async () => {
    const reason = new Error('the feed took too long');
    const signal = deadline(1_000, reason);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(signal.reason).toBe(reason);
  });
});
