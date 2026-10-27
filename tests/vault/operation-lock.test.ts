import { describe, expect, it, vi } from 'vitest';
import { CollectorError } from '../../src/core/types.js';
import { VaultOperationLock } from '../../src/vault/operation-lock.js';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function lock(overrides: Partial<ConstructorParameters<typeof VaultOperationLock>[0]> = {}) {
  const suspended: boolean[] = [];
  const release = vi.fn();
  const value = new VaultOperationLock({
    hold: async () => release,
    idle: async () => undefined,
    suspend: (state) => { suspended.push(state); },
    ...overrides,
  });
  return { value, suspended, release };
}

const failure = (error: unknown) => ({ message: error instanceof Error ? error.message : 'failed', result: null });

describe('Vault operation lock', () => {
  it('releases collection and accepts another write before success or failure becomes observable', async () => {
    let successAtRelease: string | null = null;
    let successWriteAccepted = false;
    let successfulLock!: VaultOperationLock;
    successfulLock = new VaultOperationLock({
      hold: async () => () => {
        successAtRelease = successfulLock.status().state;
        successfulLock.enter('vault-write')();
        successWriteAccepted = true;
      },
      idle: async () => undefined,
      suspend: () => undefined,
    });
    await successfulLock.start({
      operation: 'export', failed: failure,
      body: async (reporter) => {
        reporter.progress('exporting', 'working');
        return { value: undefined, message: 'done' };
      },
    });
    expect(successAtRelease).toBe('exporting');
    expect(successWriteAccepted).toBe(true);
    expect(successfulLock.status().state).toBe('completed');
    expect(() => successfulLock.enter('vault-write')()).not.toThrow();
    await successfulLock.start({
      operation: 'export', failed: failure, body: async () => ({ value: undefined, message: 'second success' }),
    });
    expect(successfulLock.status().message).toBe('second success');

    let failureAtRelease: string | null = null;
    let failedLock!: VaultOperationLock;
    failedLock = new VaultOperationLock({
      hold: async () => () => { failureAtRelease = failedLock.status().state; },
      idle: async () => undefined,
      suspend: () => undefined,
    });
    await expect(failedLock.start({
      operation: 'export', failed: failure,
      body: async (reporter) => { reporter.progress('validating', 'checking'); throw new Error('broken'); },
    })).rejects.toThrow('broken');
    expect(failureAtRelease).toBe('validating');
    expect(failedLock.status()).toMatchObject({ state: 'error', message: 'broken' });
    expect(() => failedLock.enter('vault-write')()).not.toThrow();
    await failedLock.start({
      operation: 'export', failed: failure, body: async () => ({ value: undefined, message: 'retry success' }),
    });
    expect(failedLock.status()).toMatchObject({ state: 'completed', message: 'retry success' });
  });

  it('isolates a cancelled wait from an operation started before the old hold unwinds', async () => {
    const firstHold = deferred<() => void>();
    const secondBody = deferred();
    const oldRelease = vi.fn();
    const firstCancelled = vi.fn();
    let holds = 0;
    const held = lock({
      hold: async () => {
        holds += 1;
        return holds === 1 ? firstHold.promise : () => undefined;
      },
    });
    const first = held.value.start({
      operation: 'move', failed: failure,
      body: async () => ({ value: undefined, message: 'old done' }),
      cancelled: firstCancelled,
    });
    held.value.cancelWait();
    expect(firstCancelled).toHaveBeenCalledOnce();
    const second = held.value.start({
      operation: 'export', failed: failure,
      body: async (reporter) => {
        reporter.progress('exporting', 'new operation');
        await secondBody.promise;
        return { value: undefined, message: 'new done' };
      },
    });
    await vi.waitFor(() => expect(held.value.status()).toMatchObject({ state: 'exporting', message: 'new operation' }));
    secondBody.resolve();
    await second;
    expect(held.value.status()).toMatchObject({ state: 'completed', message: 'new done' });
    firstHold.resolve(oldRelease);
    await expect(first).rejects.toMatchObject({ code: 'transfer_cancelled' });
    expect(firstCancelled).toHaveBeenCalledOnce();
    expect(oldRelease).toHaveBeenCalledOnce();
    expect(held.value.status()).toMatchObject({ state: 'completed', message: 'new done' });
  });

  it('cancels only while waiting, returns to idle and resumes collection without running the body', async () => {
    const body = vi.fn();
    const held = lock({
      hold: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    const running = held.value.start({ operation: 'move', failed: failure, body });
    expect(held.value.status().state).toBe('waiting');
    expect(held.value.cancelWait()).toMatchObject({ state: 'idle', operation: null, message: expect.stringContaining('已取消') });
    await expect(running).rejects.toMatchObject({ code: 'transfer_cancelled' });
    await held.value.finished();
    expect(body).not.toHaveBeenCalled();
    expect(held.suspended).toEqual([true, false]);
    expect(() => held.value.enter('vault-write')()).not.toThrow();
  });

  it('does not enter the body when cancellation wins after the idle promise resolves', async () => {
    const idle = deferred();
    const idleStarted = deferred();
    const body = vi.fn(async () => ({ value: undefined, message: 'must not run' }));
    const held = lock({ idle: () => { idleStarted.resolve(); return idle.promise; } });
    const running = held.value.start({ operation: 'move', failed: failure, body });
    await idleStarted.promise;

    // Promise resolution queues the settle continuation; cancelling in this same turn must still
    // prevent that continuation from crossing the body boundary.
    idle.resolve();
    held.value.cancelWait();

    await expect(running).rejects.toMatchObject({ code: 'transfer_cancelled' });
    expect(body).not.toHaveBeenCalled();
    expect(held.value.status()).toMatchObject({ state: 'idle', message: expect.stringContaining('已取消') });
  });

  it('blocks Vault reads only after the body upgrades the lock and restores them at the end', async () => {
    const gate = deferred();
    const held = lock();
    const running = held.value.start({
      operation: 'import', failed: failure,
      body: async (reporter) => {
        reporter.blockReads();
        await gate.promise;
        return { value: undefined, message: 'done' };
      },
    });
    await vi.waitFor(() => expect(() => held.value.enter('vault-read')).toThrowError(/稍後再讀取/u));
    expect(() => held.value.enter('device-data')()).not.toThrow();
    gate.resolve();
    await running;
    expect(() => held.value.enter('vault-read')()).not.toThrow();
  });

  it('keeps reads, writes and collection stopped when a body cannot safely finish', async () => {
    const held = lock();
    await expect(held.value.start({
      operation: 'import', failed: failure,
      body: async (reporter) => {
        reporter.blockReads();
        reporter.stop(new CollectorError('vault_busy', '請重新啟動程式'));
      },
    })).rejects.toMatchObject({ code: 'vault_busy' });
    expect(held.value.status()).toMatchObject({ state: 'error', errorCode: 'vault_busy', message: '請重新啟動程式' });
    expect(() => held.value.enter('vault-read')).toThrowError(/稍後再讀取/u);
    expect(() => held.value.enter('vault-write')).toThrowError(/匯出或匯入/u);
    expect(held.suspended).toEqual([true]);
  });

  it('refuses a second operation and refuses acquisition while a write is active', async () => {
    const gate = deferred();
    const held = lock();
    const running = held.value.start({
      operation: 'move', failed: failure,
      body: async () => { await gate.promise; return { value: undefined, message: 'done' }; },
    });
    expect(() => held.value.start({
      operation: 'export', failed: failure, body: async () => ({ value: undefined, message: 'done' }),
    })).toThrowError(/其他知識庫操作/u);
    gate.resolve();
    await running;

    const release = held.value.enter('vault-write');
    expect(() => held.value.start({
      operation: 'export', failed: failure, body: async () => ({ value: undefined, message: 'done' }),
    })).toThrowError(/其他知識庫操作/u);
    release();
  });

  it('gates new work, drains old writes, and transfers a hold without joining transfer completion', async () => {
    const held = lock();
    const releaseWrite = held.value.enter('vault-write');
    const prepared = held.value.prepareUpdate(new AbortController().signal);
    expect(() => held.value.enter('vault-write')).toThrowError(/更新/u);
    expect(() => held.value.start({ operation: 'move', failed: failure,
      body: async () => ({ value: undefined, message: 'must not run' }) })).toThrowError(/更新/u);
    let settled = false; void prepared.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    releaseWrite();
    const lease = await prepared;
    expect(held.suspended).toEqual([true]);
    lease.transferToShutdown();
    await expect(held.value.finished()).resolves.toBeUndefined();
    expect(held.release).not.toHaveBeenCalled();
    expect(() => held.value.enter('vault-write')).toThrowError(/更新/u);
  });

  it('cancels only its own update gate and hold', async () => {
    const held = lock();
    const lease = await held.value.prepareUpdate(new AbortController().signal);
    lease.cancel(); lease.cancel();
    expect(held.release).toHaveBeenCalledOnce();
    expect(held.suspended).toEqual([true, false]);
    expect(() => held.value.enter('vault-write')()).not.toThrow();
  });
});
