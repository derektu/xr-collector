import { isLoginStartupLaunch, shouldShowForActivation } from './login-startup.js';

interface LaunchData { xrCollectorStartedAtLogin: boolean }

function isLaunchData(data: unknown): data is LaunchData {
  return typeof data === 'object' && data !== null
    && 'xrCollectorStartedAtLogin' in data && typeof data.xrCollectorStartedAtLogin === 'boolean';
}

export interface LaunchHost {
  platform: NodeJS.Platform;
  argv: readonly string[];
  openedAtLogin(): boolean;
  requestSingleInstanceLock(data: LaunchData): boolean;
  onSecondInstance(listener: (commandLine: string[], data: unknown) => void): void;
  onActivate(listener: () => void): void;
  quit(): void;
}

export interface Launch {
  readonly startedAtLogin: boolean;
  startupFinished(): void;
}

export function claimLaunch(host: LaunchHost, show: () => void, quitting: () => boolean): Launch | null {
  // Electron records macOS's launched-as-login-item flag, which wasOpenedAtLogin reports, in
  // applicationDidFinishLaunching just before it emits ready.
  // https://github.com/electron/electron/blob/v44.10.0/shell/browser/mac/electron_application_delegate.mm#L88-L97
  const startedAtLogin = isLoginStartupLaunch(host.platform, host.argv,
    host.platform === 'darwin' ? host.openedAtLogin() : false);
  if (!host.requestSingleInstanceLock({ xrCollectorStartedAtLogin: startedAtLogin })) {
    host.quit();
    return null;
  }
  host.onSecondInstance((commandLine, data) => {
    const secondStartedAtLogin = isLaunchData(data)
      ? data.xrCollectorStartedAtLogin
      : isLoginStartupLaunch(host.platform, commandLine);
    if (!secondStartedAtLogin) show();
  });
  let finished = false;
  host.onActivate(() => {
    if (shouldShowForActivation(startedAtLogin, finished) && !quitting()) show();
  });
  return { startedAtLogin, startupFinished: () => { finished = true; } };
}
