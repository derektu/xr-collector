import { expect, it, vi } from 'vitest';
import { recoverNativeInstallations } from '../../src/electron/update-recovery.js';
import type { NativeInstallRecovery } from '../../src/updates/types.js';

function result(finalize: () => Promise<void>): NativeInstallRecovery {
  return { token: 'owned-attempt', phase: 'rolled_back', previousVersion: '0.1.0', previousBuildId: 'a',
    expectedVersion: '0.1.1', expectedBuildId: 'b', finalize };
}

it('waits for durable recovery consumption before removing the native journal', async () => {
  const order: string[] = [];
  const receipt = result(async () => { order.push('cleanup'); });
  const ready = await recoverNativeInstallations({ recover: async () => ({ launchReady: true, results: [receipt] }) },
    { consumeNativeRecovery: async () => { order.push('save'); return true; } }, vi.fn());
  expect(ready).toBe(true);
  expect(order).toEqual(['save', 'cleanup']);
});

it('retains a native journal when saving its result fails', async () => {
  const finalize = vi.fn(); const report = vi.fn();
  await expect(recoverNativeInstallations({ recover: async () => ({ launchReady: true, results: [result(finalize)] }) },
    { consumeNativeRecovery: async () => { throw new Error('disk full'); } }, report)).resolves.toBe(false);
  expect(finalize).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }));
});

it('does not finalize an unrelated result or one that still needs recovery', async () => {
  const finalize = vi.fn(); const receipt = result(finalize);
  await recoverNativeInstallations({ recover: async () => ({ launchReady: false, results: [receipt, { ...receipt, phase: 'recovery_required' }] }) },
    { consumeNativeRecovery: async () => false }, vi.fn());
  expect(finalize).not.toHaveBeenCalled();
});

it('reports cleanup failure without throwing into the running App startup rollback path', async () => {
  const report = vi.fn();
  await expect(recoverNativeInstallations({ recover: async () => ({ launchReady: true,
    results: [result(async () => { throw new Error('cleanup denied'); })] }) },
    { consumeNativeRecovery: async () => true }, report)).resolves.toBe(false);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'cleanup denied' }));
});
