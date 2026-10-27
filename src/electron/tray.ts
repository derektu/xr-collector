import path from 'node:path';
import { Menu, nativeImage, Tray } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import type { CollectionScheduleView, DeviceUpdateStatus, JobOverview } from '../core/types.js';
import { trayMenu } from './tray-menu.js';
import type { TrayAction, TrayIcon, TrayMenu, TrayState } from './tray-menu.js';

const BUSY_POLL_MS = 1500;
const IDLE_POLL_MS = 2000;

export interface AppTrayOptions {
  /** The app's own UI/API origin; the menu reads and changes state through the same API as the page. */
  serverUrl: string;
  /** Folder of the icon images (see scripts/render-tray-icons.mjs). */
  iconFolder: string;
  /** Opens the window, on a page when given. */
  show(page?: 'jobs' | 'activity' | 'settings' | 'update'): void;
  quit(): void;
}

/**
 * The macOS menu bar item or Windows notification area icon: the open Vault's work at a glance and
 * the actions that do not need the window. It polls the app's API as the page does, quickly while
 * work runs.
 */
export class AppTray {
  private readonly tray: Tray;
  private menu: TrayMenu = trayMenu(null);
  private state: TrayState | null = null;
  private drawn = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly options: AppTrayOptions) {
    this.tray = new Tray(this.image('idle'));
    // Windows opens the window on a click and the menu on a right click; macOS opens the menu on a click.
    if (process.platform === 'win32') this.tray.on('click', () => options.show());
    this.draw();
    void this.refresh();
  }

  /** The menu as last drawn. */
  current(): TrayMenu { return this.menu; }

  /** Reads the state now and redraws; the regular polling continues from here. */
  async refresh(): Promise<void> {
    clearTimeout(this.timer);
    this.state = await this.read();
    if (this.stopped) return;
    this.menu = trayMenu(this.state);
    this.draw();
    this.timer = setTimeout(() => void this.refresh(), this.menu.icon === 'collecting' ? BUSY_POLL_MS : IDLE_POLL_MS);
  }

  async run(action: TrayAction): Promise<void> {
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
    clearTimeout(this.timer);
    this.tray.destroy();
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
      const click = () => void this.run(item.action).catch((error: unknown) => console.warn(`Tray action ${item.action} failed`, error));
      return item.checked === undefined
        ? { id: item.action, label: item.label, click }
        : { id: item.action, label: item.label, type: 'checkbox', checked: item.checked, click };
    })));
  }

  /** The open Vault's work and schedule; null while no Vault is open, the routes then answer 404. */
  private async read(): Promise<TrayState | null> {
    try {
      const update = await this.get<{ update: DeviceUpdateStatus }>('/api/device/updates');
      try {
        const [overview, schedule] = await Promise.all([
          this.get<{ overview: JobOverview }>('/api/jobs/overview'),
          this.get<{ schedule: CollectionScheduleView }>('/api/schedule'),
        ]);
        return { overview: overview.overview, schedule: schedule.schedule, update: update.update };
      } catch { return { update: update.update }; }
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
