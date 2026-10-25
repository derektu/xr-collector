import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CollectorError, type LoginStartupStatus } from '../core/types.js';
import type { LoginStartupAccess } from '../core/login-startup.js';

export const LOGIN_STARTUP_ARGUMENT = '--login-startup';
/** Matches the AppUserModelID so Electron's Windows openAtLogin read-back addresses this value. */
export const LOGIN_STARTUP_NAME = 'com.moneydj.xrcollector';

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

interface RegistrationRecord {
  version: 1;
  path: string;
  args: string[];
}

const WINDOWS_ARGS = [LOGIN_STARTUP_ARGUMENT];

/** Electron's packaged login-item API, with conservative repair of an owned Windows registration after relocation. */
export class DesktopLoginStartup implements LoginStartupAccess {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly adapter: LoginItemAdapter, private readonly recordPath: string) {}

  async status(): Promise<LoginStartupStatus> {
    if (!this.adapter.isPackaged || !['darwin', 'win32'].includes(this.adapter.platform)) return unavailableStatus();
    try {
      if (this.adapter.platform === 'darwin') return macStatus(this.adapter.get({ type: 'mainAppService' }));
      const current = windowsStatus(this.adapter.get(this.currentWindowsQueryOptions()), this.adapter.executablePath);
      if (!current.enabled) {
        const remembered = await this.readRecord();
        if (remembered && !samePath(remembered.path, this.adapter.executablePath)) return {
          ...current,
          message: 'XR Collector 的 App 位置已變更；如要使用登入自啟，請在此重新開啟。',
        };
      }
      return current;
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
          if (!enabled) await this.disableRememberedRegistration();
          this.adapter.set({ openAtLogin: enabled, enabled, ...this.currentWindowsOptions(), name: LOGIN_STARTUP_NAME });
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
        if (!enabled && !await this.registrationWasRemoved()) {
          throw new CollectorError('login_startup_failed', '作業系統仍保留 XR Collector 的登入項目，請到系統設定移除。');
        }
        if (this.adapter.platform === 'win32') {
          if (enabled) await this.writeRecord({ version: 1, path: this.adapter.executablePath, args: WINDOWS_ARGS });
          else {
            await rm(this.recordPath, { force: true });
            return this.status();
          }
        }
        return result;
      } catch (cause) {
        if (cause instanceof CollectorError) throw cause;
        throw loginFailure('無法更新登入自啟設定，請稍後再試。', cause);
      }
    });
  }

  /** Called only on a manual packaged launch. Never overrides an OS-disabled registration. */
  async repairMovedRegistration(): Promise<{ repaired: boolean; status: LoginStartupStatus }> {
    return this.serial(async () => {
      let removed: RegistrationRecord | null = null;
      try {
        const current = await this.status();
        if (this.adapter.platform !== 'win32' || !this.adapter.isPackaged || current.enabled) return { repaired: false, status: current };
        const remembered = await this.readRecord();
        if (!remembered || samePath(remembered.path, this.adapter.executablePath)) return { repaired: false, status: current };
        const old = this.adapter.get(this.windowsQueryOptions(remembered.path, remembered.args));
        const owned = ownedWindowsItem(old, remembered.path);
        if (!owned?.enabled || !old.openAtLogin) return { repaired: false, status: current };
        // Windows identifies a Run value by name, not path. Remove the proven old value first,
        // then create and verify the new value so the removal cannot delete the repaired entry.
        this.adapter.set({ openAtLogin: false, enabled: false, path: remembered.path, args: remembered.args, name: LOGIN_STARTUP_NAME });
        removed = remembered;
        this.adapter.set({ openAtLogin: true, enabled: true, ...this.currentWindowsOptions(), name: LOGIN_STARTUP_NAME });
        const repaired = await this.status();
        if (!repaired.enabled) throw new Error('read-back stayed disabled');
        await this.writeRecord({ version: 1, path: this.adapter.executablePath, args: WINDOWS_ARGS });
        return { repaired: true, status: repaired };
      } catch (cause) {
        // Best effort: a failed replacement must not intentionally leave a previously enabled
        // owned item removed. Restoring the old path is safer than claiming the repair succeeded.
        if (removed) {
          try {
            this.adapter.set({ openAtLogin: true, enabled: true, path: removed.path, args: removed.args, name: LOGIN_STARTUP_NAME });
            const restored = this.adapter.get(this.windowsQueryOptions(removed.path, removed.args));
            const owned = ownedWindowsItem(restored, removed!.path);
            if (!restored.openAtLogin || !owned?.enabled) throw new Error('old registration read-back stayed disabled');
          } catch { /* the failure reported below remains authoritative */ }
        }
        if (cause instanceof CollectorError) throw cause;
        throw loginFailure('XR Collector 已搬到新位置，但無法修復登入自啟；請重新開啟設定。', cause);
      }
    });
  }

  private currentWindowsOptions() {
    return { path: this.adapter.executablePath, args: WINDOWS_ARGS };
  }

  private currentWindowsQueryOptions() {
    return this.windowsQueryOptions(this.adapter.executablePath, WINDOWS_ARGS);
  }

  private windowsQueryOptions(executablePath: string, args: string[]) {
    // Electron 44 parses get(options.path) as a command line before extracting the program. A raw
    // path containing spaces is truncated, so quote queries only; set() receives the raw path.
    return { path: `"${executablePath}"`, args };
  }

  /** A false enabled bit is insufficient: disabling must remove this App's owned OS registration. */
  private async registrationWasRemoved(): Promise<boolean> {
    if (this.adapter.platform === 'darwin') {
      return this.adapter.get({ type: 'mainAppService' }).status === 'not-registered';
    }
    const remembered = await this.readRecord();
    const registrations = [
      this.currentWindowsQueryOptions(),
      ...(remembered && !samePath(remembered.path, this.adapter.executablePath)
        ? [this.windowsQueryOptions(remembered.path, remembered.args)] : []),
    ];
    return registrations.every((registration) => {
      const settings = this.adapter.get(registration);
      return Array.isArray(settings.launchItems)
        && !settings.launchItems.some((item) => item.name === LOGIN_STARTUP_NAME && item.scope === 'user');
    });
  }

  private async disableRememberedRegistration(): Promise<void> {
    const remembered = await this.readRecord();
    if (remembered && !samePath(remembered.path, this.adapter.executablePath)) {
      this.adapter.set({ openAtLogin: false, enabled: false, path: remembered.path, args: remembered.args, name: LOGIN_STARTUP_NAME });
    }
  }

  private async readRecord(): Promise<RegistrationRecord | null> {
    try {
      const value = JSON.parse(await readFile(this.recordPath, 'utf8')) as Partial<RegistrationRecord>;
      return value.version === 1 && typeof value.path === 'string' && Array.isArray(value.args)
        && value.args.every((argument) => typeof argument === 'string')
        ? { version: 1, path: value.path, args: value.args } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private async writeRecord(record: RegistrationRecord): Promise<void> {
    await mkdir(path.dirname(this.recordPath), { recursive: true });
    const temporary = `${this.recordPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.recordPath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
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
  return { supported: false, enabled: false, state: 'unavailable', message: '登入自啟只可在已安裝的 macOS 或 Windows App 中設定。' };
}

function macStatus(settings: LoginItemSettings): LoginStartupStatus {
  if (settings.status === 'requires-approval') return {
    supported: true, enabled: false, state: 'requires_approval',
    message: '請到「系統設定 → 一般 → 登入項目與延伸功能」允許 XR Collector。',
  };
  const enabled = settings.status ? settings.status === 'enabled' : settings.openAtLogin;
  return { supported: true, enabled, state: enabled ? 'enabled' : 'disabled', message: enabled ? '已在登入電腦時自動啟動。' : '登入自啟已關閉。' };
}

function windowsStatus(settings: LoginItemSettings, executablePath: string): LoginStartupStatus {
  const owned = ownedWindowsItem(settings, executablePath);
  const enabled = settings.openAtLogin && owned?.enabled === true;
  return { supported: true, enabled, state: enabled ? 'enabled' : 'disabled', message: enabled ? '已在登入電腦時自動啟動。' : '登入自啟已關閉。' };
}

function ownedWindowsItem(settings: LoginItemSettings, executablePath: string): LaunchItem | undefined {
  // Electron's Windows launchItems come from Chromium CommandLine::GetArgs(), which omits
  // --switches such as our --login-startup marker. openAtLogin already proves the complete
  // path-and-args command matches; the launch item independently proves ownership and OS approval.
  return settings.launchItems?.find((item) => item.name === LOGIN_STARTUP_NAME
    && item.scope === 'user' && samePath(item.path, executablePath));
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLocaleLowerCase('en-US') === path.resolve(right).toLocaleLowerCase('en-US');
}

/** Distinguishes an OS login launch from a manual first or second launch. */
export function isLoginStartupLaunch(platform: NodeJS.Platform, argv: readonly string[], wasOpenedAtLogin = false): boolean {
  return platform === 'win32' ? argv.includes(LOGIN_STARTUP_ARGUMENT) : platform === 'darwin' && wasOpenedAtLogin;
}

/** An activation during login-startup initialization is not a request to show the window; later Dock activations are. */
export function shouldShowForActivation(startedAtLogin: boolean, startupFinished: boolean): boolean {
  return !startedAtLogin || startupFinished;
}

function loginFailure(message: string, cause: unknown): CollectorError {
  return new CollectorError('login_startup_failed', message, { cause });
}
