// The start-at-login setting reports only what the OS reads back. An unpackaged App cannot register,
// macOS approval is surfaced, and on Windows only the App's own Run entry with its current executable
// and login switch counts, so the setting never shows on while the OS would not start this App.
// A login launch is told apart from a manual one.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DesktopLoginStartup, isLoginStartupLaunch, LOGIN_STARTUP_ARGUMENT, LOGIN_STARTUP_NAME,
  type LoginItemAdapter, type LoginItemSettings,
} from '../../../src/desktop/electron/login-startup.js';
import { windowsAppId } from '../../../src/desktop/electron/desktop-environment.js';

type RunEntry = { name: string; path: string; args: string[]; enabled: boolean; scope: 'user' | 'machine' };

class WindowsAdapter implements LoginItemAdapter {
  readonly platform = 'win32' as const;
  readonly isPackaged = true;
  /** Windows Run entries are keyed by registry value name, irrespective of path. */
  readonly items = new Map<string, RunEntry>();
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
    const item = { name: options.name ?? LOGIN_STARTUP_NAME, path: options.path!, args: options.args ?? [], enabled: options.enabled ?? options.openAtLogin, scope: 'user' as const };
    if (options.openAtLogin) this.items.set(item.name, item);
    else this.items.delete(item.name);
  }
}

const EXECUTABLE = 'C:\\Program Files\\XR Collector\\XR Collector.exe';
const ownEntry = (more: Partial<RunEntry> = {}): RunEntry => ({
  name: LOGIN_STARTUP_NAME, path: EXECUTABLE, args: [LOGIN_STARTUP_ARGUMENT], enabled: true, scope: 'user', ...more,
});

describe('desktop login startup', () => {
  it('never lets an unpackaged development app register', async () => {
    const adapter: LoginItemAdapter = {
      platform: 'darwin', isPackaged: false, executablePath: '/Applications/XR Collector.app',
      get: () => ({ openAtLogin: false }), set: () => { throw new Error('must not write'); },
    };
    const service = new DesktopLoginStartup(adapter);
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
    const service = new DesktopLoginStartup(adapter);
    await expect(service.status()).resolves.toMatchObject({ supported: true, enabled: false, state: 'requires_approval' });
    await expect(service.update(true)).rejects.toMatchObject({ code: 'login_startup_requires_approval' });
    await expect(service.update(false)).resolves.toMatchObject({ state: 'disabled' });
  });

  it('registers the fixed Windows name, executable and login argument, then disables it', async () => {
    const adapter = new WindowsAdapter(EXECUTABLE);
    const service = new DesktopLoginStartup(adapter);
    await expect(service.update(true)).resolves.toMatchObject({ enabled: true, state: 'enabled' });
    expect([...adapter.items.values()]).toEqual([ownEntry()]);
    await expect(service.update(false)).resolves.toMatchObject({ enabled: false, state: 'disabled' });
  });

  it('names the Windows login item after the package appId, because Electron reads openAtLogin back from the AppUserModelId value', async () => {
    const packageMetadata: unknown = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(LOGIN_STARTUP_NAME).toBe(windowsAppId(packageMetadata));
  });

  it.each<[string, RunEntry, boolean]>([
    ['its own enabled entry counts as on', ownEntry(), true],
    ['another App\'s entry for the same executable does not count', ownEntry({ name: 'another-app' }), false],
    ['its own entry with another switch does not count', ownEntry({ args: ['--other-startup'] }), false],
    ['its own entry disabled in the OS settings does not count', ownEntry({ enabled: false }), false],
    ['its own entry for another location, after the App moved, does not count', ownEntry({ path: 'C:\\Old\\XR Collector.exe' }), false],
  ])('Windows status: %s', async (_rule, entry, enabled) => {
    const adapter = new WindowsAdapter(EXECUTABLE);
    adapter.items.set(entry.name, entry);
    await expect(new DesktopLoginStartup(adapter).status()).resolves.toMatchObject({ enabled, state: enabled ? 'enabled' : 'disabled' });
  });

  it('turning it on after the App moved points the single Run value at the current executable', async () => {
    const adapter = new WindowsAdapter(EXECUTABLE);
    adapter.items.set(LOGIN_STARTUP_NAME, ownEntry({ path: 'C:\\Old\\XR Collector.exe' }));
    await expect(new DesktopLoginStartup(adapter).update(true)).resolves.toMatchObject({ enabled: true });
    expect([...adapter.items.values()]).toEqual([ownEntry()]);
  });

  it.each<[NodeJS.Platform, string[], boolean, boolean]>([
    ['win32', ['app.exe', LOGIN_STARTUP_ARGUMENT], false, true],
    ['win32', ['app.exe'], false, false],
    ['darwin', ['app'], true, true],
    ['darwin', ['app'], false, false],
  ])('a %s launch with %j and macOS opened-at-login %s counts as a login launch: %s', (platform, argv, openedAtLogin, expected) => {
    expect(isLoginStartupLaunch(platform, argv, openedAtLogin)).toBe(expected);
  });
});
