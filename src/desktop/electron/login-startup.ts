import path from 'node:path';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { LoginStartupStatus } from '../../shared/api/device-types.js';
import { loginStartupStatus, type LoginStartupAccess } from '../../shared/api/login-startup.js';

export const LOGIN_STARTUP_ARGUMENT = '--login-startup';

interface LaunchItem {
  name: string;
  path: string;
  args: string[];
  enabled: boolean;
  scope?: string;
}

export interface LoginItemSettings {
  openAtLogin: boolean;
  wasOpenedAtLogin?: boolean;
  status?: 'not-registered' | 'enabled' | 'requires-approval' | 'not-found' | 'unknown';
  launchItems?: LaunchItem[];
}

export interface LoginItemAdapter {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly executablePath: string;
  get(options?: { path?: string; args?: string[]; type?: 'mainAppService' }): LoginItemSettings;
  set(options: { openAtLogin: boolean; enabled?: boolean; path?: string; args?: string[]; name?: string; type?: 'mainAppService' }): void;
}

const WINDOWS_ARGS = [LOGIN_STARTUP_ARGUMENT];

export class DesktopLoginStartup implements LoginStartupAccess {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly adapter: LoginItemAdapter, private readonly appId: string) {}

  async status(): Promise<LoginStartupStatus> {
    if (!this.adapter.isPackaged || !['darwin', 'win32'].includes(this.adapter.platform)) return unavailableStatus();
    try {
      if (this.adapter.platform === 'darwin') return macStatus(this.adapter.get({ type: 'mainAppService' }));
      return windowsStatus(this.adapter.get(this.currentWindowsQueryOptions()), this.appId, this.adapter.executablePath);
    } catch (cause) {
      throw loginFailure('無法讀取作業系統的登入自啟狀態。', cause);
    }
  }

  async update(enabled: boolean): Promise<LoginStartupStatus> {
    return this.serial(async () => {
      if (!this.adapter.isPackaged || !['darwin', 'win32'].includes(this.adapter.platform)) {
        throw new CollectorError('login_startup_unavailable', unavailableStatus().message);
      }
      try {
        if (this.adapter.platform === 'darwin') {
          this.adapter.set({ openAtLogin: enabled, type: 'mainAppService' });
        } else {
          // On Windows, Electron's getLoginItemSettings reads openAtLogin from the Run value named by the AppUserModelId, never from `name`.
          // https://github.com/electron/electron/blob/v44.10.0/shell/browser/browser_win.cc
          this.adapter.set({ openAtLogin: enabled, enabled, ...this.currentWindowsOptions(), name: this.appId });
        }
        const result = await this.status();
        if (enabled && result.state === 'requires_approval') {
          throw new CollectorError('login_startup_requires_approval', result.message);
        }
        if (result.enabled !== enabled) {
          throw new CollectorError('login_startup_failed', enabled
            ? '作業系統沒有啟用登入自啟；請到系統設定允許 XR Collector。'
            : '作業系統仍顯示登入自啟已開啟，請到系統設定關閉 XR Collector。');
        }
        return result;
      } catch (cause) {
        if (cause instanceof CollectorError) throw cause;
        throw loginFailure('無法更新登入自啟設定，請稍後再試。', cause);
      }
    });
  }

  private currentWindowsOptions() {
    return { path: this.adapter.executablePath, args: WINDOWS_ARGS };
  }

  private currentWindowsQueryOptions() {
    return { path: `"${this.adapter.executablePath}"`, args: WINDOWS_ARGS };
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

function unavailableStatus(): LoginStartupStatus {
  return loginStartupStatus('unavailable');
}

function macStatus(settings: LoginItemSettings): LoginStartupStatus {
  if (settings.status === 'requires-approval') return loginStartupStatus('requires_approval');
  const enabled = settings.status ? settings.status === 'enabled' : settings.openAtLogin;
  return loginStartupStatus(enabled ? 'enabled' : 'disabled');
}

function windowsStatus(settings: LoginItemSettings, appId: string, executablePath: string): LoginStartupStatus {
  const owned = ownedWindowsItem(settings, appId, executablePath);
  return loginStartupStatus(settings.openAtLogin && owned?.enabled === true ? 'enabled' : 'disabled');
}

function ownedWindowsItem(settings: LoginItemSettings, appId: string, executablePath: string): LaunchItem | undefined {
  // On Windows, Electron fills launchItems[].args from Chromium's CommandLine::GetArgs(), which leaves out switches such as --login-startup.
  // https://github.com/electron/electron/blob/v44.10.0/shell/browser/browser_win.cc
  return settings.launchItems?.find((item) => item.name === appId
    && item.scope === 'user' && samePath(item.path, executablePath));
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLocaleLowerCase('en-US') === path.resolve(right).toLocaleLowerCase('en-US');
}

export function isLoginStartupLaunch(platform: NodeJS.Platform, argv: readonly string[], wasOpenedAtLogin = false): boolean {
  return platform === 'win32' ? argv.includes(LOGIN_STARTUP_ARGUMENT) : platform === 'darwin' && wasOpenedAtLogin;
}

export function shouldShowForActivation(startedAtLogin: boolean, startupFinished: boolean): boolean {
  return !startedAtLogin || startupFinished;
}

function loginFailure(message: string, cause: unknown): CollectorError {
  return new CollectorError('login_startup_failed', message, { cause });
}
