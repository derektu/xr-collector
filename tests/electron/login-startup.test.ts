import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DesktopLoginStartup, isLoginStartupLaunch, LOGIN_STARTUP_ARGUMENT, LOGIN_STARTUP_NAME,
  type LoginItemAdapter, type LoginItemSettings,
} from '../../src/electron/login-startup.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class WindowsAdapter implements LoginItemAdapter {
  readonly platform = 'win32' as const;
  readonly isPackaged = true;
  /** Windows Run entries are keyed by registry value name, irrespective of path. */
  readonly items = new Map<string, { name: string; path: string; args: string[]; enabled: boolean; scope: 'user' | 'machine' }>();
  failEnablingPath: string | null = null;
  ignoreDisabling = false;
  constructor(readonly executablePath: string) {}
  get(options: { path?: string; args?: string[] } = {}): LoginItemSettings {
    // Electron 44 reads openAtLogin from the AppUserModelID-named value, with path/args comparison.
    const queriedPath = options.path?.startsWith('"')
      ? options.path.slice(1, options.path.indexOf('"', 1))
      : options.path?.split(' ')[0];
    const candidate = this.items.get(LOGIN_STARTUP_NAME);
    const item = candidate?.path.toLocaleLowerCase('en-US') === queriedPath?.toLocaleLowerCase('en-US')
      ? candidate : undefined;
    const commandMatches = item?.args.join('\0') === (options.args ?? []).join('\0');
    // Chromium CommandLine::GetArgs() omits switches. Electron therefore returns an empty args
    // array for our --login-startup command even while openAtLogin matches the complete command.
    const launchItem = item ? { ...item, args: item.args.filter((argument) => !argument.startsWith('--')) } : undefined;
    return {
      openAtLogin: Boolean(item && commandMatches),
      launchItems: launchItem ? [launchItem] : [],
    };
  }
  set(options: { openAtLogin: boolean; enabled?: boolean; path?: string; args?: string[]; name?: string }): void {
    if (options.openAtLogin && options.path === this.failEnablingPath) throw new Error('synthetic registry write failure');
    const item = { name: options.name ?? LOGIN_STARTUP_NAME, path: options.path!, args: options.args ?? [], enabled: options.enabled ?? options.openAtLogin, scope: 'user' as const };
    if (options.openAtLogin) this.items.set(item.name, item);
    else if (!this.ignoreDisabling) this.items.delete(item.name);
  }
}

describe('desktop login startup', () => {
  it('never lets an unpackaged development app register', async () => {
    const adapter: LoginItemAdapter = {
      platform: 'darwin', isPackaged: false, executablePath: '/Applications/XR Collector.app',
      get: () => ({ openAtLogin: false }), set: () => { throw new Error('must not write'); },
    };
    const service = new DesktopLoginStartup(adapter, '/unused');
    await expect(service.status()).resolves.toMatchObject({ supported: false, enabled: false, state: 'unavailable' });
    await expect(service.update(true)).rejects.toMatchObject({ code: 'login_startup_unavailable' });
  });

  it('maps macOS approval and verifies the OS read-back', async () => {
    let value: LoginItemSettings = { openAtLogin: false, status: 'requires-approval' };
    const adapter: LoginItemAdapter = {
      platform: 'darwin', isPackaged: true, executablePath: '/Applications/XR Collector.app',
      get: () => value,
      set: ({ openAtLogin }) => { value = openAtLogin ? { openAtLogin: false, status: 'requires-approval' } : { openAtLogin: false, status: 'not-registered' }; },
    };
    const service = new DesktopLoginStartup(adapter, '/unused');
    await expect(service.status()).resolves.toMatchObject({ supported: true, enabled: false, state: 'requires_approval' });
    await expect(service.update(true)).rejects.toMatchObject({ code: 'login_startup_requires_approval' });
    await expect(service.update(false)).resolves.toMatchObject({ state: 'disabled' });
  });

  it('does not report a macOS disable while an approval-pending registration remains', async () => {
    const adapter: LoginItemAdapter = {
      platform: 'darwin', isPackaged: true, executablePath: '/Applications/XR Collector.app',
      get: () => ({ openAtLogin: false, status: 'requires-approval' }),
      set: () => undefined,
    };
    await expect(new DesktopLoginStartup(adapter, '/unused').update(false))
      .rejects.toMatchObject({ code: 'login_startup_failed' });
  });

  it('registers the fixed Windows name, executable and login argument, then disables it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-login-')); roots.push(root);
    const adapter = new WindowsAdapter('C:\\Program Files\\XR Collector\\XR Collector.exe');
    const service = new DesktopLoginStartup(adapter, path.join(root, 'login-startup.json'));
    await expect(service.update(true)).resolves.toMatchObject({ enabled: true, state: 'enabled' });
    expect([...adapter.items.values()]).toContainEqual({
      name: LOGIN_STARTUP_NAME, path: adapter.executablePath, args: [LOGIN_STARTUP_ARGUMENT], enabled: true,
      scope: 'user',
    });
    await expect(service.update(false)).resolves.toMatchObject({ enabled: false, state: 'disabled' });
  });

  it('does not report a Windows disable while its disabled owned Run value remains', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-login-')); roots.push(root);
    const adapter = new WindowsAdapter('C:\\Program Files\\XR Collector\\XR Collector.exe');
    const service = new DesktopLoginStartup(adapter, path.join(root, 'login-startup.json'));
    await service.update(true);
    adapter.items.get(LOGIN_STARTUP_NAME)!.enabled = false;
    adapter.ignoreDisabling = true;
    await expect(service.update(false)).rejects.toMatchObject({ code: 'login_startup_failed' });
    expect(adapter.items.get(LOGIN_STARTUP_NAME)).toMatchObject({ enabled: false });
  });

  it('checks the remembered path when a moved Windows registration silently survives deletion', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-login-')); roots.push(root);
    const record = path.join(root, 'login-startup.json');
    const old = new WindowsAdapter('C:\\Old App\\XR Collector.exe');
    await new DesktopLoginStartup(old, record).update(true);
    const moved = new WindowsAdapter('D:\\New App\\XR Collector.exe');
    moved.items.set(LOGIN_STARTUP_NAME, { ...old.items.get(LOGIN_STARTUP_NAME)!, enabled: false });
    moved.ignoreDisabling = true;
    await expect(new DesktopLoginStartup(moved, record).update(false))
      .rejects.toMatchObject({ code: 'login_startup_failed' });
    expect(moved.items.get(LOGIN_STARTUP_NAME)).toMatchObject({ path: old.executablePath, enabled: false });
  });

  it('removes a remembered moved Windows registration and returns the final disabled message', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-login-')); roots.push(root);
    const record = path.join(root, 'login-startup.json');
    const old = new WindowsAdapter('C:\\Old App\\XR Collector.exe');
    await new DesktopLoginStartup(old, record).update(true);
    const moved = new WindowsAdapter('D:\\New App\\XR Collector.exe');
    moved.items.set(LOGIN_STARTUP_NAME, old.items.get(LOGIN_STARTUP_NAME)!);
    await expect(new DesktopLoginStartup(moved, record).update(false)).resolves.toMatchObject({
      enabled: false, state: 'disabled', message: '登入自啟已關閉。',
    });
    expect(moved.items.has(LOGIN_STARTUP_NAME)).toBe(false);
  });

  it('does not report a Windows disable when Electron omits the launch-item read-back', async () => {
    const adapter: LoginItemAdapter = {
      platform: 'win32', isPackaged: true, executablePath: 'C:\\XR Collector.exe',
      get: () => ({ openAtLogin: false }),
      set: () => undefined,
    };
    await expect(new DesktopLoginStartup(adapter, '/unused').update(false))
      .rejects.toMatchObject({ code: 'login_startup_failed' });
  });

  it('repairs a moved owned registration only while the old OS entry remains enabled', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-login-')); roots.push(root);
    const record = path.join(root, 'login-startup.json');
    const oldAdapter = new WindowsAdapter('C:\\old\\XR Collector.exe');
    await new DesktopLoginStartup(oldAdapter, record).update(true);
    const moved = new WindowsAdapter('D:\\apps\\XR Collector.exe');
    moved.items.set(LOGIN_STARTUP_NAME, [...oldAdapter.items.values()][0]!);
    const service = new DesktopLoginStartup(moved, record);
    await expect(service.repairMovedRegistration()).resolves.toMatchObject({ repaired: true, status: { enabled: true } });
    expect(moved.items.get(LOGIN_STARTUP_NAME)).toMatchObject({ path: moved.executablePath, enabled: true });

    const movedAgain = new WindowsAdapter('E:\\XR Collector.exe');
    for (const [itemKey, item] of moved.items) movedAgain.items.set(itemKey, { ...item, enabled: false });
    const movedAgainService = new DesktopLoginStartup(movedAgain, record);
    await expect(movedAgainService.status()).resolves.toMatchObject({ enabled: false, message: expect.stringContaining('位置已變更') });
    await expect(movedAgainService.repairMovedRegistration()).resolves.toMatchObject({
      repaired: false,
      status: { enabled: false, message: expect.stringContaining('位置已變更') },
    });
    expect([...movedAgain.items.values()].some((item) => item.path === movedAgain.executablePath && item.enabled)).toBe(false);
  });

  it('does not mistake another Windows startup entry for this App', async () => {
    const adapter = new WindowsAdapter('C:\\XR Collector.exe');
    adapter.items.set('another-app', {
      name: 'another-app', path: adapter.executablePath, args: [LOGIN_STARTUP_ARGUMENT], enabled: true, scope: 'user',
    });
    await expect(new DesktopLoginStartup(adapter, '/unused').status()).resolves.toMatchObject({ enabled: false, state: 'disabled' });
  });

  it('does not accept an owned Windows entry whose complete command has the wrong switch', async () => {
    const adapter = new WindowsAdapter('C:\\XR Collector.exe');
    adapter.items.set(LOGIN_STARTUP_NAME, {
      name: LOGIN_STARTUP_NAME, path: adapter.executablePath, args: ['--other-startup'], enabled: true, scope: 'user',
    });
    await expect(new DesktopLoginStartup(adapter, '/unused').status())
      .resolves.toMatchObject({ enabled: false, state: 'disabled' });
  });

  it('respects an externally disabled owned Windows entry even when the complete command matches', async () => {
    const adapter = new WindowsAdapter('C:\\XR Collector.exe');
    adapter.items.set(LOGIN_STARTUP_NAME, {
      name: LOGIN_STARTUP_NAME, path: adapter.executablePath, args: [LOGIN_STARTUP_ARGUMENT], enabled: false, scope: 'user',
    });
    await expect(new DesktopLoginStartup(adapter, '/unused').status())
      .resolves.toMatchObject({ enabled: false, state: 'disabled' });
  });

  it('best-effort restores the old enabled Windows value when relocation replacement fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-login-')); roots.push(root);
    const record = path.join(root, 'login-startup.json');
    const old = new WindowsAdapter('C:\\old\\XR Collector.exe');
    await new DesktopLoginStartup(old, record).update(true);
    const moved = new WindowsAdapter('D:\\broken\\XR Collector.exe');
    moved.items.set(LOGIN_STARTUP_NAME, [...old.items.values()][0]!);
    moved.failEnablingPath = moved.executablePath;
    await expect(new DesktopLoginStartup(moved, record).repairMovedRegistration()).rejects.toMatchObject({ code: 'login_startup_failed' });
    expect(moved.items.get(LOGIN_STARTUP_NAME)).toMatchObject({ path: old.executablePath, enabled: true });
  });

  it('distinguishes first and second login launches without reusing the first launch reason', () => {
    expect(isLoginStartupLaunch('win32', ['app.exe', LOGIN_STARTUP_ARGUMENT])).toBe(true);
    expect(isLoginStartupLaunch('win32', ['app.exe'])).toBe(false);
    expect(isLoginStartupLaunch('darwin', ['app'], true)).toBe(true);
    expect(isLoginStartupLaunch('darwin', ['app'], false)).toBe(false);
  });
});

