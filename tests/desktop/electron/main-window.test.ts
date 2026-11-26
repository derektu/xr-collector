// Broken, a second App instance stays running, a login launch shows a window, or a notification clicked while loading is lost.
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain, WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import { claimLaunch, type LaunchHost } from '../../../src/desktop/electron/desktop-launch.js';
import { MainWindow, type WindowRuntime } from '../../../src/desktop/electron/main-window.js';
import { registerPageChannels } from '../../../src/desktop/electron/page-channels.js';
import { eventually } from '../../support/wait.js';
import { recordingLog } from '../../support/log.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function launchHost(options: { platform?: NodeJS.Platform; openedAtLogin?: boolean; lock?: boolean } = {}) {
  const listeners = { secondInstance: [] as ((commandLine: string[], data: unknown) => void)[], activate: [] as (() => void)[] };
  const host = {
    platform: options.platform ?? 'darwin',
    argv: ['XR Collector'],
    loginReads: 0,
    lockData: null as unknown,
    quits: 0,
    openedAtLogin: () => { host.loginReads += 1; return options.openedAtLogin ?? false; },
    requestSingleInstanceLock: (data: unknown) => { host.lockData = data; return options.lock ?? true; },
    onSecondInstance: (listener: (commandLine: string[], data: unknown) => void) => { listeners.secondInstance.push(listener); },
    onActivate: (listener: () => void) => { listeners.activate.push(listener); },
    quit: () => { host.quits += 1; },
    secondInstance: (startedAtLogin: boolean) => listeners.secondInstance.forEach((listener) => listener(['XR Collector'], { xrCollectorStartedAtLogin: startedAtLogin })),
    activate: () => listeners.activate.forEach((listener) => listener()),
  } satisfies LaunchHost & Record<string, unknown>;
  return host;
}

function windows() {
  const load = deferred();
  const created: FakeWindow[] = [];
  class FakeWindow {
    readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    readonly sent: unknown[] = [];
    shows = 0;
    readonly webContents = {
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      send: (_channel: string, value: unknown) => { this.sent.push(value); },
    };
    constructor(readonly options: BrowserWindowConstructorOptions) { created.push(this); }
    once(event: string, listener: (...args: unknown[]) => void) { this.on(event, listener); }
    on(event: string, listener: (...args: unknown[]) => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]); }
    async loadURL() {
      await load.promise;
      for (const listener of this.handlers.get('ready-to-show') ?? []) listener();
    }
    show() { this.shows += 1; }
    focus() {}
    hide() {}
    destroy() {}
    removeMenu() {}
    isMinimized() { return false; }
    restore() {}
  }
  const shows = () => created.reduce((sum, window) => sum + window.shows, 0);
  return { created, shows, finishLoading: load.resolve, create: (options: BrowserWindowConstructorOptions) => new FakeWindow(options) as unknown as BrowserWindow };
}

const runtime: WindowRuntime = {
  url: 'http://127.0.0.1:1',
  activeVaultId: () => 'vault-a',
};

function mainWindow(fakes: ReturnType<typeof windows>, started: () => WindowRuntime | null = () => runtime) {
  return new MainWindow({
    log: recordingLog(),
    platform: 'darwin', hidden: false, size: { width: 1240, height: 820 }, preload: '/app/preload.cjs',
    createWindow: fakes.create, focusApp: () => undefined, openExternal: () => undefined,
    runtime: started, quitting: () => false, sessionEnded: () => undefined, closedByPerson: () => undefined,
  });
}

describe('Electron main login-startup wiring', () => {
  it('reads the macOS launch reason when it claims the launch and sends that process reason with the lock; on Windows it never asks Electron', () => {
    const host = launchHost({ openedAtLogin: true });
    expect(host.loginReads).toBe(0);
    const launch = claimLaunch(host, () => undefined, () => false);
    expect(host.loginReads).toBe(1);
    expect(launch?.startedAtLogin).toBe(true);
    expect(host.lockData).toEqual({ xrCollectorStartedAtLogin: true });

    const windowsHost = launchHost({ platform: 'win32', openedAtLogin: true });
    expect(claimLaunch(windowsHost, () => undefined, () => false)?.startedAtLogin).toBe(false);
    expect(windowsHost.loginReads).toBe(0);
  });

  it('quits a process that loses the lock without listening for later launches', () => {
    const host = launchHost({ openedAtLogin: true, lock: false });
    let shows = 0;
    expect(claimLaunch(host, () => { shows += 1; }, () => false)).toBeNull();
    expect(host.quits).toBe(1);
    expect(host.lockData).toEqual({ xrCollectorStartedAtLogin: true });
    host.secondInstance(false);
    host.activate();
    expect(shows).toBe(0);
  });

  it('keeps initial activation and login second-instances hidden, but shows for later manual requests', async () => {
    const host = launchHost({ openedAtLogin: true });
    const fakes = windows();
    const window = mainWindow(fakes);
    const launch = claimLaunch(host, () => window.show(), () => false)!;

    host.activate();
    host.secondInstance(true);
    const opening = window.open(launch.startedAtLogin);
    fakes.finishLoading();
    await opening;
    launch.startupFinished();
    expect(fakes.created).toHaveLength(1);
    expect(fakes.shows()).toBe(0);
    expect(window.shown).toBe(false);

    host.secondInstance(false);
    expect(fakes.shows()).toBe(1);
    host.activate();
    expect(fakes.shows()).toBe(2);
    expect(window.shown).toBe(true);
  });

  it('coalesces an early manual second-instance into the BrowserWindow already loading', async () => {
    const host = launchHost();
    const fakes = windows();
    const window = mainWindow(fakes);
    const launch = claimLaunch(host, () => window.show(), () => false)!;
    const opening = window.open(launch.startedAtLogin);
    host.secondInstance(false);
    expect(fakes.created).toHaveLength(1);

    fakes.finishLoading();
    await opening;
    expect(fakes.shows()).toBe(1);
    expect(fakes.created).toHaveLength(1);
  });

  it('keeps a notification target clicked while loading until the renderer listener is ready', async () => {
    const fakes = windows();
    let started: WindowRuntime | null = null;
    const window = mainWindow(fakes, () => started);
    const readyListeners: ((event: { sender: WebContents }) => void)[] = [];
    registerPageChannels({
      log: recordingLog(),
      ipc: {
        handle: () => undefined,
        on: (channel: string, listener: (event: { sender: WebContents }) => void) => { if (channel === 'xrCollector:navigation:ready') readyListeners.push(listener); },
      } as unknown as Pick<IpcMain, 'handle' | 'on'>,
      theme: { read: async () => 'system', write: async () => undefined },
      navigationReady: (sender) => window.navigationReady(sender),
    });

    window.show({ notification: { vaultId: 'vault-a', sourceType: 'youtube', subscriptionId: 'a' } });
    started = runtime;
    window.runtimeStarted();
    const opening = window.open(false);
    await eventually(() => expect(fakes.created).toHaveLength(1));
    const [page] = fakes.created;
    expect(page!.sent).toEqual([]);
    fakes.finishLoading();
    await opening;
    expect(page!.sent).toEqual([]);

    for (const listener of readyListeners) listener({ sender: {} as WebContents });
    expect(page!.sent).toEqual([]);
    for (const listener of readyListeners) listener({ sender: page!.webContents as unknown as WebContents });
    expect(page!.sent).toEqual([{ kind: 'source', type: 'youtube', id: 'a' }]);
  });

  it('opens the page a tray click asked for while the window was loading, even before a Vault exists', async () => {
    const fakes = windows();
    const window = mainWindow(fakes, () => ({ ...runtime, activeVaultId: () => null }));
    const opening = window.open(false);
    const [page] = fakes.created;
    window.navigationReady(page!.webContents as unknown as WebContents);
    window.show('update');
    expect(page!.sent).toEqual([]);

    fakes.finishLoading();
    await opening;
    expect(page!.sent).toEqual(['update']);
  });

  it('shows a window started at login when a manual request arrives while it loads', async () => {
    const fakes = windows();
    const window = mainWindow(fakes);
    const opening = window.open(true);
    window.show();
    expect(fakes.shows()).toBe(0);

    fakes.finishLoading();
    await opening;
    expect(fakes.shows()).toBe(1);
    expect(window.shown).toBe(true);
  });
});
