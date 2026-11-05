import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from 'electron';
import type { AutoPauseNotification } from '../core/device-types.js';
import { notificationNavigation } from './notification-navigation.js';
import { WindowCreationGate } from './window-creation.js';

/** A page of the app the window opens on: a section, a subscription, or a message. */
export type DesktopTarget = 'jobs' | 'activity' | 'settings' | 'update'
  | { kind: 'source'; type: string; id: string } | { kind: 'message'; message: string };

/** What the window reads from the runtime once it has started. */
export interface WindowRuntime {
  /** The UI listener the window loads. */
  url: string;
  /** The notification an event ID names, or null when there is none. */
  resolveNotification(id: string): Promise<AutoPauseNotification | null>;
  activeVaultId(): string | null;
}

export interface MainWindowOptions {
  platform: NodeJS.Platform;
  /**
   * Background validation mode: the window is never shown or focused and keeps painting while
   * hidden, so Playwright drives and screenshots the page while the developer keeps working.
   */
  hidden: boolean;
  size: { width: number; height: number };
  /** The preload script of the window. */
  preload: string;
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  /** Brings the app to the front on macOS. */
  focusApp(): void;
  openExternal(url: string): void;
  /** The runtime, or null before it starts and once it stops. */
  runtime(): WindowRuntime | null;
  /** Whether the app is quitting; closing the window then closes it instead of hiding it. */
  quitting(): boolean;
  /** Windows ending the session (shut down, sign out) closes the window without a quit request. */
  sessionEnded(): void;
  /** The person closed the window, which only hides it. */
  closedByPerson(): void;
}

/**
 * The one main window: created on the runtime's UI listener, shown or kept hidden, and told which
 * page to open once its page listens. Requests made while the window loads are kept and carried
 * out once it has loaded; a request made before the runtime starts waits for it.
 */
export class MainWindow {
  private window: BrowserWindow | null = null;
  private readonly creation = new WindowCreationGate();
  private rendererReady = false;
  private pendingNavigation: DesktopTarget | undefined;
  private pendingNotificationId: string | undefined;
  /** Whether a request to show the window arrived, so a login launch shows it after loading. */
  private manualShow = false;
  /** Whether the app last showed or hid the window; a hidden validation run reports it without showing. */
  private shownValue = false;

  constructor(private readonly options: MainWindowOptions) {}

  get current(): BrowserWindow | null { return this.window; }
  get shown(): boolean { return this.shownValue; }

  /** Carries out a notification click that arrived before the runtime started. */
  runtimeStarted(): void {
    if (!this.pendingNotificationId) return;
    const id = this.pendingNotificationId;
    this.pendingNotificationId = undefined;
    this.show({ notificationId: id });
  }

  /**
   * Opens the window once the runtime has started: shown, or hidden for a login launch unless the
   * person asked for it meanwhile. A request that arrived while it loaded is carried out after.
   */
  async open(startedAtLogin: boolean): Promise<void> {
    const showInitially = !startedAtLogin || this.manualShow;
    await this.create(showInitially);
    // A tray request can arrive while the window is loading. Replay its latest page as well as the
    // show request after load; otherwise a device-level update click can land on the default page
    // (especially before a Vault exists).
    if (this.pendingNavigation || startedAtLogin && this.manualShow && !showInitially) this.show();
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
        // A hidden window keeps painting and running timers, so screenshots show the live page.
        backgroundThrottling: !this.options.hidden,
      },
    });
    this.rendererReady = false;
    // Publish the window before loading so an early second-instance request cannot create another.
    this.window = window;
    // The app has no menu commands of its own; macOS keeps the default menu for
    // standard Edit and Quit shortcuts.
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
    // Closing the window hides it and collection goes on; quitting is the tray menu's (or ⌘Q on macOS).
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

  /** Shows the window, on a page of the app when given; a hidden validation run only navigates. */
  show(page?: DesktopTarget | { notificationId: string }): void {
    this.manualShow = true;
    if (typeof page === 'object' && 'notificationId' in page) {
      const runtime = this.options.runtime();
      if (!runtime) { this.pendingNotificationId = page.notificationId; return; }
      void runtime.resolveNotification(page.notificationId).then((event) => {
        this.pendingNavigation = notificationNavigation(event, this.options.runtime()?.activeVaultId() ?? null);
        this.show();
      }).catch((error: unknown) => console.warn('Unable to resolve notification target', error));
      return;
    } else if (page) this.pendingNavigation = page;
    if (this.creation.current) {
      // The caller that began creation performs the one pending show after loading completes.
      return;
    }
    if (!this.window) {
      if (this.options.runtime() && !this.options.quitting()) void this.create(false).then(() => this.show()).catch((error) => console.error(error));
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

  /** The page of `sender` listens for navigation; a page of another window is ignored. */
  pageReady(sender: WebContents): void {
    if (this.window?.webContents !== sender) return;
    this.rendererReady = true;
    this.deliverPendingNavigation();
  }

  private deliverPendingNavigation(): void {
    if (!this.pendingNavigation || !this.rendererReady || !this.window) return;
    this.window.webContents.send('xrCollector:navigate', this.pendingNavigation);
    this.pendingNavigation = undefined;
  }

  /** Destroys the window without the close that only hides it. */
  destroy(): void {
    this.window?.destroy();
    this.window = null;
  }
}
