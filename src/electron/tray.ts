import path from 'node:path';
import { Menu, nativeImage, Tray } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import type { ChangeBatch } from '../core/changes.js';
import type { CollectionScheduleView, DeviceUpdateStatus, JobOverview } from '../core/types.js';
import type { NotificationState } from '../notifications/types.js';
import { menuStaleAfter, trayMenu } from './tray-menu.js';
import type { TrayAction, TrayIcon, TrayMenu, TrayState } from './tray-menu.js';

/** The shortest time between the starts of two state reads; changes meanwhile share the next read. */
export const READ_GAP_MS = 1000;

export interface AppTrayOptions {
  /** The app's own UI/API origin; the menu reads and changes state through the same API as the page. */
  serverUrl: string;
  /** Folder of the icon images (see scripts/render-tray-icons.mjs). */
  iconFolder: string;
  /** The runtime's change stream; the menu reads its state again after each change to what it shows. */
  changes: { subscribe(listener: (batch: ChangeBatch) => void): () => void };
  /** Opens the window, on a page when given. */
  show(page?: 'jobs' | 'activity' | 'settings' | 'update' | { notificationId: string }): void;
  quit(): void;
}

/**
 * The macOS menu bar item or Windows notification area icon: the open Vault's work at a glance and
 * the actions that do not need the window. It reads the app's API as the page does, after each change
 * to what it shows, at most once per `READ_GAP_MS`. At local midnight it draws the last state again,
 * so "明天" turns into today without a read.
 */
export class AppTray {
  private readonly tray: Tray;
  private menu: TrayMenu = trayMenu(null);
  private state: TrayState | null = null;
  private drawn = '';
  private reading: Promise<void> | null = null;
  private again = false;
  private lastRead = 0;
  private stopped = false;
  private midnight: ReturnType<typeof setTimeout> | undefined;
  private readonly stopFollowing: () => void;
  /** State reads since the tray was created; validation compares it across an idle period. */
  reads = 0;

  constructor(private readonly options: AppTrayOptions) {
    this.tray = new Tray(this.image('idle'));
    // Windows opens the window on a click and the menu on a right click; macOS opens the menu on a click.
    if (process.platform === 'win32') this.tray.on('click', () => options.show());
    this.draw();
    this.stopFollowing = options.changes.subscribe((batch) => { if (menuStaleAfter(batch.changes)) void this.refresh(); });
    void this.refresh();
    this.atMidnight();
  }

  /** The menu as last drawn. */
  current(): TrayMenu { return this.menu; }

  /**
   * Reads the state and redraws. One read runs at a time, starting at least `READ_GAP_MS` after the
   * previous one; a call during a read reads once more after it, and resolves once the menu shows a
   * state read after the call.
   */
  refresh(): Promise<void> {
    if (this.reading) { this.again = true; return this.reading; }
    this.reading = (async () => {
      try {
        do {
          const wait = this.lastRead + READ_GAP_MS - Date.now();
          if (wait > 0) await new Promise((resolve) => { setTimeout(resolve, wait); });
          if (this.stopped) return;
          // The read below starts after every change so far, including those during the wait.
          this.again = false;
          this.lastRead = Date.now();
          const state = await this.read();
          if (this.stopped) return;
          this.state = state;
          this.menu = trayMenu(state);
          this.draw();
        } while (this.again);
      } finally {
        // Cleared in the same step as the last check of `again`, so a later call starts a new read.
        this.reading = null;
      }
    })();
    return this.reading;
  }

  async run(action: TrayAction): Promise<void> {
    if (action.startsWith('subscription:')) { this.options.show({ notificationId: action.slice('subscription:'.length) }); return; }
    switch (action) {
      case 'open': this.options.show(); return;
      case 'jobs': this.options.show('jobs'); return;
      case 'activity': this.options.show('activity'); return;
      case 'check_app_update':
        if (this.state?.update && ['idle', 'up_to_date', 'error'].includes(this.state.update.phase)) {
          await this.send('POST', '/api/device/updates/check', undefined);
        }
        this.options.show('update');
        break;
      case 'quit': this.options.quit(); return;
      case 'check_now': await this.send('POST', '/api/subscription-checks', {}); break;
      case 'toggle_auto_check': await this.send('PUT', '/api/schedule', { enabled: !this.state?.schedule?.enabled }); break;
    }
    await this.refresh();
  }

  destroy(): void {
    this.stopped = true;
    clearTimeout(this.midnight);
    this.stopFollowing();
    this.tray.destroy();
  }

  private atMidnight(): void {
    const next = new Date();
    next.setHours(24, 0, 1, 0);
    this.midnight = setTimeout(() => {
      this.menu = trayMenu(this.state);
      this.draw();
      this.atMidnight();
    }, next.getTime() - Date.now());
  }

  private draw(): void {
    const key = JSON.stringify(this.menu);
    if (key === this.drawn) return;
    this.drawn = key;
    this.tray.setImage(this.image(this.menu.icon, this.menu.updateBadge));
    this.tray.setToolTip(this.menu.tooltip);
    this.tray.setContextMenu(Menu.buildFromTemplate(this.menu.items.map((item): MenuItemConstructorOptions => {
      if (item.kind === 'separator') return { type: 'separator' };
      if (item.kind === 'status') return { label: item.label, enabled: false };
      if (item.kind === 'submenu') return { label: item.label, submenu: item.items.map((child) => ({
        id: child.action, label: child.label,
        click: () => void this.run(child.action).catch((error: unknown) => console.warn(`Tray action ${child.action} failed`, error)),
      })) };
      const click = () => void this.run(item.action).catch((error: unknown) => console.warn(`Tray action ${item.action} failed`, error));
      return item.checked === undefined
        ? { id: item.action, label: item.label, click }
        : { id: item.action, label: item.label, type: 'checkbox', checked: item.checked, click };
    })));
  }

  /** The open Vault's work and schedule; null while no Vault is open, the routes then answer 404. */
  private async read(): Promise<TrayState | null> {
    this.reads += 1;
    try {
      const [update, notifications] = await Promise.all([
        this.get<{ update: DeviceUpdateStatus }>('/api/device/updates'),
        this.get<{ notifications: NotificationState }>('/api/device/notifications'),
      ]);
      try {
        const [overview, schedule] = await Promise.all([
          this.get<{ overview: JobOverview }>('/api/jobs/overview'),
          this.get<{ schedule: CollectionScheduleView }>('/api/schedule'),
        ]);
        return { overview: overview.overview, schedule: schedule.schedule, update: update.update,
          actionable: notifications.notifications.active };
      } catch { return { update: update.update, actionable: notifications.notifications.active }; }
    } catch {
      return null;
    }
  }

  private async get<T>(route: string): Promise<T> {
    const response = await fetch(new URL(route, this.options.serverUrl));
    if (!response.ok) throw new Error(`${route} answered ${response.status}`);
    return await response.json() as T;
  }

  private async send(method: 'POST' | 'PUT', route: string, body: unknown): Promise<void> {
    const response = await fetch(new URL(route, this.options.serverUrl), {
      method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${await response.text()}`);
  }

  /** macOS takes black template images it tints for the menu bar; Windows takes colored ones. */
  private image(icon: TrayIcon, updateBadge = false): Electron.NativeImage {
    const state = `${icon}${updateBadge ? '-update' : ''}`;
    const name = process.platform === 'darwin' ? `tray-${state}Template.png` : `tray-${state}.png`;
    return nativeImage.createFromPath(path.join(this.options.iconFolder, name));
  }
}
