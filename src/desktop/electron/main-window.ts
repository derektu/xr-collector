import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from 'electron';
import { notificationNavigation, type NotificationTarget } from './notification-navigation.js';
import { WindowCreationGate } from './window-creation.js';
import type { LogWriter } from '../../shared/log/log-types.js';

export type DesktopTarget = 'jobs' | 'activity' | 'settings' | 'update'
  | { kind: 'source'; type: string; id: string } | { kind: 'message'; message: string };

export interface WindowRuntime {
  url: string;
  activeVaultId(): string | null;
}

export interface MainWindowOptions {
  platform: NodeJS.Platform;
  hidden: boolean;
  size: { width: number; height: number };
  preload: string;
  log: LogWriter;
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  focusApp(): void;
  openExternal(url: string): void;
  runtime(): WindowRuntime | null;
  quitting(): boolean;
  // External: On Windows, shutdown, restart or sign-out emits the window's 'session-end' and closes the app without emitting 'before-quit'.
  // https://www.electronjs.org/docs/latest/api/app#event-before-quit
  sessionEnded(): void;
  closedByPerson(): void;
}

export class MainWindow {
  private window: BrowserWindow | null = null;
  private readonly creation = new WindowCreationGate();
  private rendererReady = false;
  private pendingNavigation: DesktopTarget | undefined;
  private pendingNotification: NotificationTarget | undefined;
  private manualShow = false;
  private shownValue = false;

  constructor(private readonly options: MainWindowOptions) {}

  get current(): BrowserWindow | null { return this.window; }
  get shown(): boolean { return this.shownValue; }

  runtimeStarted(): void {
    if (!this.pendingNotification) return;
    const notification = this.pendingNotification;
    this.pendingNotification = undefined;
    this.show({ notification });
  }

  async open(startedAtLogin: boolean): Promise<void> {
    const showInitially = !startedAtLogin || this.manualShow;
    await this.create(showInitially);
    const showRequestedWhileLoading = !showInitially && this.manualShow;
    if (this.pendingNavigation || showRequestedWhileLoading) this.show();
  }

  private create(showInitially = true): Promise<void> {
    return this.creation.run(() => this.createOnce(showInitially));
  }

  private async createOnce(showInitially: boolean): Promise<void> {
    const runtime = this.options.runtime();
    if (!runtime) throw new Error('Runtime must start before the window');
    const serverUrl = runtime.url;
    const window = this.options.createWindow({
      width: this.options.size.width,
      height: this.options.size.height,
      minWidth: 880,
      minHeight: 620,
      show: false,
      title: 'XR Collector',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: this.options.preload,
        // External: Electron throttles a background page's timers and animations unless backgroundThrottling is false.
        // https://www.electronjs.org/docs/latest/api/structures/web-preferences
        backgroundThrottling: !this.options.hidden,
      },
    });
    this.rendererReady = false;
    this.window = window;
    // External: Electron creates a default application menu with Edit and Quit items when the app sets none, and on macOS Cmd+C/V/X/A and Cmd+Q work only through application menu items.
    // https://www.electronjs.org/docs/latest/api/menu#menusetapplicationmenumenu
    if (this.options.platform !== 'darwin') window.removeMenu();
    this.shownValue = showInitially;
    if (!this.options.hidden && showInitially) window.once('ready-to-show', () => window.show());
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) this.options.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(serverUrl)) event.preventDefault();
    });
    window.on('close', (event) => {
      if (this.options.quitting()) return;
      event.preventDefault();
      this.shownValue = false;
      window.hide();
      this.options.closedByPerson();
    });
    window.on('session-end', () => this.options.sessionEnded());
    window.on('closed', () => {
      this.window = null;
      this.rendererReady = false;
    });
    try {
      await window.loadURL(serverUrl);
    } catch (error) {
      if (this.window === window) this.window = null;
      window.destroy();
      throw error;
    }
  }

  show(page?: DesktopTarget | { notification: NotificationTarget }): void {
    this.manualShow = true;
    if (typeof page === 'object' && 'notification' in page) {
      const runtime = this.options.runtime();
      if (!runtime) { this.pendingNotification = page.notification; return; }
      this.pendingNavigation = notificationNavigation(page.notification, runtime.activeVaultId());
    } else if (page) this.pendingNavigation = page;
    if (this.creation.current) {
      return;
    }
    if (!this.window) {
      if (this.options.runtime() && !this.options.quitting()) void this.create(false).then(() => this.show()).catch((error: unknown) => this.options.log.write({ level: 'error', source: 'desktop', message: 'Unable to create the main window', error }));
      return;
    }
    this.deliverPendingNavigation();
    this.shownValue = true;
    if (this.options.hidden) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    if (this.options.platform === 'darwin') this.options.focusApp();
    this.window.focus();
  }

  navigationReady(sender: WebContents): void {
    if (this.window?.webContents !== sender) return;
    this.rendererReady = true;
    this.deliverPendingNavigation();
  }

  private deliverPendingNavigation(): void {
    if (!this.pendingNavigation || !this.rendererReady || !this.window) return;
    this.window.webContents.send('xrCollector:navigate', this.pendingNavigation);
    this.pendingNavigation = undefined;
  }

  destroy(): void {
    this.window?.destroy();
    this.window = null;
  }
}
