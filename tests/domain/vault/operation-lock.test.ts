import { describe, expect, it, vi } from 'vitest';
import { VaultOperationLock } from '../../../src/domain/vault/operation-lock.js';

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
        successfulLock.enterWrite()();
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
    expect(() => successfulLock.enterWrite()()).not.toThrow();
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
    expect(() => failedLock.enterWrite()()).not.toThrow();
    await failedLock.start({
      operation: 'export', failed: failure, body: async () => ({ value: undefined, message: 'retry success' }),
    });
    expect(failedLock.status()).toMatchObject({ state: 'completed', message: 'retry success' });
  });

  it('refuses a second operation and a write while an operation runs, and an operation while a write is active', async () => {
    const gate = deferred();
    const held = lock();
    const running = held.value.start({
      operation: 'open', failed: failure,
      body: async () => { await gate.promise; return { value: undefined, message: 'done' }; },
    });
    expect(() => held.value.start({
      operation: 'export', failed: failure, body: async () => ({ value: undefined, message: 'done' }),
    })).toThrowError(/其他知識庫操作/u);
    expect(() => held.value.enterWrite()).toThrow(expect.objectContaining({ code: 'vault_busy' }));
    gate.resolve();
    await running;

    const release = held.value.enterWrite();
    expect(() => held.value.start({
      operation: 'export', failed: failure, body: async () => ({ value: undefined, message: 'done' }),
    })).toThrowError(/其他知識庫操作/u);
    release();
  });
});
