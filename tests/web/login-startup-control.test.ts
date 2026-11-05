// The login startup switch shows what the operating system reports. Without these rules a refused
// write leaves the switch on although the OS kept it off, a change made in the OS settings stays
// hidden until the page reloads, and a slow read started before a write puts the old value back.
import { describe, expect, it } from 'vitest';
import { LoginStartupControl, loginStartupNote, type LoginStartupPort } from '../../src/web/login-startup-control.js';
import type { LoginStartupStatus } from '../../src/core/types.js';
import { eventually } from '../support/wait.js';

const status = (enabled: boolean): LoginStartupStatus => ({
  supported: true, enabled, state: enabled ? 'enabled' : 'disabled', message: enabled ? '已在登入電腦時自動啟動。' : '登入自啟已關閉。',
});

/** An OS whose reads and writes wait until the test answers them. */
function heldOs() {
  const calls: Array<{ kind: 'read' | 'write'; enabled?: boolean; signal: AbortSignal; answer: (value: LoginStartupStatus) => void; fail: (error: Error) => void }> = [];
  const call = (kind: 'read' | 'write', signal: AbortSignal, enabled?: boolean) => new Promise<LoginStartupStatus>((resolve, reject) => {
    calls.push({ kind, enabled, signal, answer: resolve, fail: reject });
  });
  const port: LoginStartupPort = { read: (signal) => call('read', signal), write: (enabled, signal) => call('write', signal, enabled) };
  const written: boolean[] = [];
  const control = new LoginStartupControl(port, () => undefined, (enabled) => written.push(enabled));
  return { control, calls, written };
}

describe('login startup control', () => {
  it('reads the OS state again after a refused write instead of keeping the requested value', async () => {
    const { control, calls, written } = heldOs();
    const started = control.start();
    calls[0]!.answer(status(true));
    await started;

    const writing = control.write(false);
    expect(control.current().pending).toBe(true);
    calls[1]!.fail(new Error('作業系統拒絕更新登入自啟。'));
    await eventually(() => expect(calls[2]?.kind).toBe('read'));
    calls[2]!.answer(status(true));
    await writing;

    expect(control.current()).toMatchObject({ status: { enabled: true }, pending: false, error: '作業系統拒絕更新登入自啟。' });
    expect(written).toEqual([]);
  });

  it('reads the OS state again when the window regains focus, but not while a write is on its way', async () => {
    const { control, calls } = heldOs();
    const started = control.start();
    calls[0]!.answer(status(true));
    await started;

    const refreshed = control.focus();
    expect(calls[1]?.kind).toBe('read');
    calls[1]!.answer(status(false));
    await refreshed;
    expect(control.current().status?.enabled).toBe(false);

    const writing = control.write(true);
    const ignored = control.focus();
    expect(calls.map((entry) => entry.kind)).toEqual(['read', 'read', 'write']);
    calls[2]!.answer(status(true));
    await writing;
    await ignored;
    expect(control.current().status?.enabled).toBe(true);
  });

  it('keeps a newer write when a read started before it answers late', async () => {
    const { control, calls, written } = heldOs();
    const started = control.start();
    calls[0]!.answer(status(false));
    await started;

    const slowRead = control.focus();
    const writing = control.write(true);
    calls[2]!.answer(status(true));
    await writing;
    calls[1]!.answer(status(false));
    await slowRead;

    expect(calls[1]!.signal.aborted).toBe(true);
    expect(control.current()).toMatchObject({ status: { enabled: true }, pending: false, error: null });
    expect(written).toEqual([true]);
  });

  it('ignores answers after the screen closed and shows the state again when it comes back', async () => {
    const { control, calls } = heldOs();
    const first = control.start();
    control.close();
    calls[0]!.answer(status(true));
    await first;
    expect(control.current().status).toBeNull();

    const again = control.start();
    calls[1]!.answer(status(false));
    await again;
    expect(control.current().status?.enabled).toBe(false);
  });

  // The note follows the state the OS reports; the server's message only ever shows, so rewording it
  // never brings the routine states back below the switch.
  it('shows guidance for states other than on and off, whatever the message says', () => {
    const reported = (state: LoginStartupStatus['state'], message: string): LoginStartupStatus => ({
      supported: state !== 'unavailable', enabled: state === 'enabled', state, message,
    });
    const shown = (status: LoginStartupStatus | null, more: { pending?: boolean; error?: string } = {}) =>
      loginStartupNote({ status, pending: more.pending ?? false, error: more.error ?? null });
    expect(shown(reported('enabled', 'reworded on'))).toBeNull();
    expect(shown(reported('disabled', 'reworded off'))).toBeNull();
    expect(shown(reported('requires_approval', 'approve it'))).toEqual({ kind: 'status', message: 'approve it' });
    expect(shown(reported('relocated', 'moved'))).toEqual({ kind: 'status', message: 'moved' });
    expect(shown(reported('unavailable', 'any'))).toEqual({ kind: 'unavailable' });
    expect(shown(null)).toEqual({ kind: 'loading' });
    expect(shown(reported('enabled', 'on'), { error: 'refused' })).toEqual({ kind: 'error', message: 'refused' });
    expect(shown(reported('enabled', 'on'), { pending: true, error: 'refused' })).toEqual({ kind: 'pending' });
  });
});
