import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  appHandlers: new Map<string, ((...args: any[]) => void)[]>(),
  ipcHandlers: new Map<string, ((...args: any[]) => void)[]>(),
  notifications: [] as any[],
  sent: [] as unknown[],
  systemNotifications: null as any,
  windows: [] as any[],
  shows: 0,
  trays: 0,
  runtimeStarts: 0,
  wasOpenedAtLogin: false,
  readySettled: false,
  loginReadsBeforeReady: 0,
  lockGranted: true,
  quits: 0,
  packageMetadata: { name: 'xr-collector' } as Record<string, unknown>,
  updateRepositories: [] as string[],
  appIds: [] as string[],
  lockData: null as Record<string, unknown> | null,
  readyPromise: Promise.resolve() as Promise<void>,
  readyResolve: (() => undefined) as () => void,
  loadPromise: Promise.resolve() as Promise<void>,
  loadResolve: (() => undefined) as () => void,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: (file: Parameters<typeof actual.readFileSync>[0], options?: Parameters<typeof actual.readFileSync>[1]) =>
    String(file) === '/tmp/xr-main-wiring/app/package.json' ? JSON.stringify(harness.packageMetadata) : actual.readFileSync(file, options as never) };
});

vi.mock('electron', () => {
  class FakeBrowserWindow {
    readonly handlers = new Map<string, ((...args: any[]) => void)[]>();
    readonly webContents = {
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      send: (_channel: string, value: unknown) => { harness.sent.push(value); },
      getURL: () => 'http://127.0.0.1:1',
    };
    constructor() { harness.windows.push(this); }
    static fromWebContents() { return null; }
    once(event: string, listener: (...args: any[]) => void) { this.on(event, listener); }
    on(event: string, listener: (...args: any[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
    }
    async loadURL() {
      await harness.loadPromise;
      for (const listener of this.handlers.get('ready-to-show') ?? []) listener();
    }
    show() { harness.shows += 1; }
    focus() {}
    hide() {}
    destroy() {}
    removeMenu() {}
    isMinimized() { return false; }
    restore() {}
    isVisible() { return harness.shows > 0; }
    isFocused() { return harness.shows > 0; }
    close() {}
  }
  const app = {
    isPackaged: false,
    dock: { hide: () => undefined },
    setPath: () => undefined,
    setAppUserModelId: (value: string) => { harness.appIds.push(value); },
    requestSingleInstanceLock: (data: Record<string, unknown>) => { harness.lockData = data; return harness.lockGranted; },
    quit: () => { harness.quits += 1; },
    on: (event: string, listener: (...args: any[]) => void) => {
      harness.appHandlers.set(event, [...(harness.appHandlers.get(event) ?? []), listener]);
    },
    whenReady: () => harness.readyPromise,
    getLoginItemSettings: () => {
      if (!harness.readySettled) {
        harness.loginReadsBeforeReady += 1;
        throw new Error('wasOpenedAtLogin is not initialized before ready');
      }
      return { openAtLogin: harness.wasOpenedAtLogin, wasOpenedAtLogin: harness.wasOpenedAtLogin, status: 'not-registered' };
    },
    setLoginItemSettings: () => undefined,
    getPath: (name: string) => `/tmp/xr-main-wiring/${name}`,
    getAppPath: () => '/tmp/xr-main-wiring/app',
    getVersion: () => '0.1.0-test',
    focus: () => undefined,
  };
  return {
    app,
    BrowserWindow: FakeBrowserWindow,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
    ipcMain: {
      handle: () => undefined,
      on: (event: string, listener: (...args: any[]) => void) => harness.ipcHandlers.set(event, [...(harness.ipcHandlers.get(event) ?? []), listener]),
    },
    net: { fetch: async () => new Response(), isOnline: () => true },
    Notification: class extends EventEmitter {
      id: string;
      constructor(options: { id?: string } = {}) { super(); this.id = options.id ?? ''; harness.notifications.push(this); }
      show() { this.emit('show'); }
    },
    powerMonitor: { on: () => undefined, removeListener: () => undefined },
    shell: { openExternal: async () => undefined, showItemInFolder: () => undefined },
  };
});

vi.mock('../../src/plugins/index.js', () => ({
  createSourcePlugins: async () => ({ plugins: [], pacing: {} }),
}));
vi.mock('../../src/updates/sources.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/updates/sources.js')>();
  return { ...actual, GitHubReleasesSource: class { constructor(repository: string) { harness.updateRepositories.push(repository); } } };
});
vi.mock('../../src/updates/windows-installer.js', () => ({ WindowsNativeInstaller: class {} }));
vi.mock('../../src/runtime/collector-runtime.js', () => ({
  CollectorRuntime: {
    start: async (options: any) => {
      harness.runtimeStarts += 1;
      harness.systemNotifications = options.systemNotifications;
      return {
        server: { url: 'http://127.0.0.1:1' },
        connectivity: { check: async () => undefined },
        recordDeviceEvent: () => undefined,
        close: async () => undefined,
        workspace: { activeVaultId: () => 'vault-a', status: () => ({ vaultPath: '/vault' }) },
        resolveNotification: async () => ({ id: 'event', vaultId: 'vault-a', sourceType: 'youtube', subscriptionId: 'a' }),
      };
    },
  },
}));
vi.mock('../../src/electron/tray.js', () => ({
  AppTray: class {
    constructor() { harness.trays += 1; }
    destroy() {}
    async refresh() {}
    current() { return {}; }
    run() {}
  },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function emitApp(event: string, ...args: any[]) {
  for (const listener of harness.appHandlers.get(event) ?? []) listener(...args);
}

async function loadMain(startedAtLogin: boolean) {
  harness.wasOpenedAtLogin = startedAtLogin;
  await import('../../src/electron/main.js');
  harness.readyResolve();
  await vi.waitFor(() => expect(harness.windows).toHaveLength(1));
}

const originalArgv = [...process.argv];
let restorePlatform = () => undefined;
beforeEach(() => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  restorePlatform = () => platform.mockRestore();
  vi.resetModules();
  harness.appHandlers.clear();
  harness.ipcHandlers.clear();
  harness.windows.splice(0);
  harness.notifications.splice(0);
  harness.sent.splice(0);
  harness.systemNotifications = null;
  harness.shows = 0;
  harness.trays = 0;
  harness.runtimeStarts = 0;
  harness.wasOpenedAtLogin = false;
  harness.readySettled = false;
  harness.loginReadsBeforeReady = 0;
  harness.lockGranted = true;
  harness.quits = 0;
  harness.packageMetadata = { name: 'xr-collector' };
  harness.updateRepositories.splice(0);
  harness.appIds.splice(0);
  harness.lockData = null;
  const ready = deferred();
  harness.readyPromise = ready.promise;
  harness.readyResolve = () => { harness.readySettled = true; ready.resolve(); };
  const load = deferred();
  harness.loadPromise = load.promise;
  harness.loadResolve = load.resolve;
  delete process.env.XR_COLLECTOR_PROFILE;
  delete process.env.XR_COLLECTOR_VALIDATION_HIDDEN;
  delete process.env.XR_COLLECTOR_VALIDATION_CONTROL;
});

afterEach(async () => {
  emitApp('before-quit', { preventDefault: () => undefined });
  await Promise.resolve();
  process.argv = [...originalArgv];
  restorePlatform();
});

describe('Electron main login-startup wiring', () => {
  it('reads the macOS launch reason only after ready and sends that process reason with the lock', async () => {
    await loadMain(true);
    expect(harness.loginReadsBeforeReady).toBe(0);
    expect(harness.lockData).toEqual({ xrCollectorStartedAtLogin: true });
    harness.loadResolve();
    await vi.waitFor(() => expect(harness.trays).toBe(1));
  });

  it('quits a process that loses the ready-time lock without starting a runtime or window', async () => {
    harness.lockGranted = false;
    harness.wasOpenedAtLogin = true;
    await import('../../src/electron/main.js');
    expect(harness.loginReadsBeforeReady).toBe(0);
    harness.readyResolve();
    await vi.waitFor(() => expect(harness.quits).toBe(1));
    expect(harness.lockData).toEqual({ xrCollectorStartedAtLogin: true });
    expect(harness.runtimeStarts).toBe(0);
    expect(harness.windows).toHaveLength(0);
  });

  it('keeps initial activation and login second-instances hidden, but shows for later manual requests', async () => {
    await loadMain(true);

    emitApp('activate');
    emitApp('second-instance', {}, ['XR Collector'], '', { xrCollectorStartedAtLogin: true });
    expect(harness.shows).toBe(0);

    harness.loadResolve();
    await vi.waitFor(() => expect(harness.trays).toBe(1));
    expect(harness.runtimeStarts).toBe(1);
    expect(harness.shows).toBe(0);

    emitApp('second-instance', {}, ['XR Collector'], '', { xrCollectorStartedAtLogin: false });
    expect(harness.shows).toBe(1);
    emitApp('activate');
    expect(harness.shows).toBe(2);
  });

  it('coalesces an early manual second-instance into the BrowserWindow already loading', async () => {
    await loadMain(false);
    emitApp('second-instance', {}, ['XR Collector'], '', { xrCollectorStartedAtLogin: false });
    expect(harness.windows).toHaveLength(1);

    harness.loadResolve();
    await vi.waitFor(() => expect(harness.shows).toBe(1));
    expect(harness.windows).toHaveLength(1);
    expect(harness.runtimeStarts).toBe(1);
  });

  it('uses the repository and Windows app id baked into a validation package without inherited environment', async () => {
    restorePlatform();
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    restorePlatform = () => platform.mockRestore();
    harness.packageMetadata = { name: 'xr-collector', xrCollectorUpdateRepository: 'derektu/xr-collector-test',
      xrCollectorAppId: 'com.xrcollector.verify.public.chinese' };

    await loadMain(false);
    await vi.waitFor(() => expect(harness.updateRepositories).toEqual(['derektu/xr-collector-test']));
    expect(harness.appIds).toEqual(['com.xrcollector.verify.public.chinese']);
  });

  it('keeps a notification target clicked while loading until the renderer listener is ready', async () => {
    await loadMain(false);
    await harness.systemNotifications.show({
      id: 'event', vaultId: 'vault-a', sourceType: 'youtube', subscriptionId: 'a', title: 'A', failureCount: 5,
      error: { code: 'network_error', message: 'failed' }, autoPausedAt: '2026-10-28T00:00:00.000Z', delivery: 'pending', deliveryMessage: null,
    });
    harness.notifications[0].emit('click');
    await Promise.resolve();
    expect(harness.sent).toEqual([]);
    harness.loadResolve();
    await vi.waitFor(() => expect(harness.trays).toBe(1));
    const window = harness.windows[0];
    for (const listener of harness.ipcHandlers.get('xrCollector:renderer:ready') ?? []) listener({ sender: window.webContents });
    expect(harness.sent).toEqual([{ kind: 'source', type: 'youtube', id: 'a' }]);
  });
});
