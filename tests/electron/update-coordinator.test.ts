import { describe, expect, it, vi } from 'vitest';
import { runUpdateCoordinator } from '../../src/electron/update-coordinator.js';
import type { NativeInstaller, UpdateApplyRequest } from '../../src/updates/types.js';

function request(events: string[], signal = new AbortController().signal): UpdateApplyRequest {
  return {
    offer: {} as UpdateApplyRequest['offer'], packageFile: '/private/update.zip', signal,
    recordAttempt: async () => { events.push('attempt'); },
    installing: () => { events.push('installing'); },
    failed: async (code, message) => { events.push(`failed:${code}:${message}`); },
  };
}

function installer(events: string[], overrides: Partial<NativeInstaller> = {}): NativeInstaller {
  return {
    available: true, validate: async () => undefined,
    prepare: async () => ({
      handoff: async () => { events.push('handoff'); },
      cancel: async () => { events.push('prepared-cancel'); },
    }),
    ...overrides,
  };
}

function runtime(events: string[], close = async () => { events.push('close'); }) {
  return {
    prepareUpdate: async () => ({
      cancel: () => { events.push('lease-cancel'); },
      transferToShutdown: () => { events.push('transfer'); },
    }),
    close,
  };
}

describe('update coordinator terminal boundary', () => {
  it('does not prepare a runtime or native installer for an already-aborted request', async () => {
    const events: string[] = []; const controller = new AbortController(); controller.abort(new Error('already cancelled'));
    const prepareUpdate = vi.fn(); const prepare = vi.fn();
    await runUpdateCoordinator(request(events, controller.signal), installer(events, { prepare }), { prepareUpdate, close: vi.fn() }, {
      shutdownOwned: vi.fn(), completed: vi.fn(), terminalFailure: vi.fn(),
    }, 1_000);
    expect(prepareUpdate).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(events).toEqual(['failed:update_apply_failed:already cancelled']);
  });

  it('cancels the acquired lease and leaves the runtime usable when preparation fails', async () => {
    const events: string[] = []; const terminal = vi.fn();
    await runUpdateCoordinator(request(events), installer(events, { prepare: async () => { throw new Error('helper unavailable'); } }), runtime(events), {
      shutdownOwned: () => events.push('owned'), completed: () => events.push('completed'), terminalFailure: terminal,
    }, 1_000);
    expect(events).toEqual(['lease-cancel', 'failed:update_apply_failed:helper unavailable']);
    expect(terminal).not.toHaveBeenCalled();
  });

  it('reports the localized safety deadline instead of a dependency AbortError before transfer', async () => {
    const events: string[] = []; const terminal = vi.fn(); let genericAbortThrown = false;
    const prepare: NativeInstaller['prepare'] = async (_offer, _file, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { genericAbortThrown = true; reject(new DOMException('The operation was aborted', 'AbortError')); }, { once: true });
    });
    await runUpdateCoordinator(request(events), installer(events, { prepare }), runtime(events), {
      shutdownOwned: () => events.push('owned'), completed: () => events.push('completed'), terminalFailure: terminal,
    }, 5);
    expect(events).toEqual([
      'lease-cancel',
      'failed:update_apply_failed:準備更新超過兩分鐘，已取消本次安裝；App 仍可使用，請稍後重試。',
    ]);
    expect(genericAbortThrown).toBe(true);
    expect(events.join('\n')).not.toContain('The operation was aborted');
    expect(terminal).not.toHaveBeenCalled();
  });

  it('persists failure and enters terminal UX when runtime close fails after transfer', async () => {
    const events: string[] = [];
    await runUpdateCoordinator(request(events), installer(events), runtime(events, async () => { events.push('close'); throw new Error('close failed'); }), {
      shutdownOwned: () => events.push('owned'), completed: () => events.push('completed'),
      terminalFailure: async (error) => { events.push(`terminal:${error.message}`); },
    }, 1_000);
    expect(events).toEqual([
      'attempt', 'transfer', 'owned', 'installing', 'close', 'prepared-cancel',
      'failed:update_apply_failed:close failed', 'terminal:close failed',
    ]);
    expect(events).not.toContain('lease-cancel');
    expect(events).not.toContain('completed');
  });

  it('hands off only after runtime close and then completes', async () => {
    const events: string[] = [];
    await runUpdateCoordinator(request(events), installer(events), runtime(events), {
      shutdownOwned: () => events.push('owned'), completed: () => events.push('completed'), terminalFailure: () => events.push('terminal'),
    }, 1_000);
    expect(events).toEqual(['attempt', 'transfer', 'owned', 'installing', 'close', 'handoff', 'completed']);
  });
});
