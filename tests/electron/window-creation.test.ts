import { describe, expect, it, vi } from 'vitest';
import { shouldShowForActivation } from '../../src/electron/login-startup.js';
import { WindowCreationGate } from '../../src/electron/window-creation.js';

describe('login-startup window policy', () => {
  it('suppresses activation during login initialization but allows later Dock activation', () => {
    expect(shouldShowForActivation(true, false)).toBe(false);
    expect(shouldShowForActivation(true, true)).toBe(true);
    expect(shouldShowForActivation(false, false)).toBe(true);
  });

  it('coalesces an early manual-show request while the initial window is loading', async () => {
    let finish!: () => void;
    const loading = new Promise<void>((resolve) => { finish = resolve; });
    const createInitial = vi.fn(async () => loading);
    const createDuplicate = vi.fn(async () => undefined);
    const gate = new WindowCreationGate();

    const initial = gate.run(createInitial);
    const earlyManual = gate.run(createDuplicate);
    expect(earlyManual).toBe(initial);
    expect(createInitial).toHaveBeenCalledOnce();
    expect(createDuplicate).not.toHaveBeenCalled();
    finish();
    await earlyManual;
    expect(gate.current).toBeNull();
  });
});
