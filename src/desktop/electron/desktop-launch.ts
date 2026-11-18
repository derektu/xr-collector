import { isLoginStartupLaunch, shouldShowForActivation } from './login-startup.js';

/** The data one process sends with the single-instance lock: why it was launched. */
interface LaunchData { xrCollectorStartedAtLogin: boolean }

/** The parts of Electron's app a launch reads and listens to. */
export interface LaunchHost {
  platform: NodeJS.Platform;
  argv: readonly string[];
  /** Whether macOS opened the app at login; Electron publishes it only once the app is ready. */
  openedAtLogin(): boolean;
  requestSingleInstanceLock(data: LaunchData): boolean;
  onSecondInstance(listener: (commandLine: string[], data: unknown) => void): void;
  onActivate(listener: () => void): void;
  quit(): void;
}

/** A launch that holds the single-instance lock. */
export interface Launch {
  readonly startedAtLogin: boolean;
  /** Startup has finished; activating the app shows the window from now on. */
  finish(): void;
}

/**
 * Claims the launch once the app is ready. Each process sends its own launch reason through the
 * single-instance lock; a process that loses the lock quits and returns null. A later manual launch
 * shows the one window, a later login launch does not; activating the app shows the window once
 * startup has finished, or at once for a launch that was not a login launch.
 */
export function claimLaunch(host: LaunchHost, show: () => void, quitting: () => boolean): Launch | null {
  // Electron only publishes macOS wasOpenedAtLogin while finishing launch, immediately before
  // ready, so it is read here and never earlier.
  const startedAtLogin = isLoginStartupLaunch(host.platform, host.argv,
    host.platform === 'darwin' ? host.openedAtLogin() : false);
  if (!host.requestSingleInstanceLock({ xrCollectorStartedAtLogin: startedAtLogin })) {
    host.quit();
    return null;
  }
  host.onSecondInstance((commandLine, data) => {
    const launchData = data as { xrCollectorStartedAtLogin?: unknown } | undefined;
    const secondStartedAtLogin = typeof launchData?.xrCollectorStartedAtLogin === 'boolean'
      ? launchData.xrCollectorStartedAtLogin
      : isLoginStartupLaunch(host.platform, commandLine);
    if (!secondStartedAtLogin) show();
  });
  let finished = false;
  host.onActivate(() => {
    if (shouldShowForActivation(startedAtLogin, finished) && !quitting()) show();
  });
  return { startedAtLogin, finish: () => { finished = true; } };
}
