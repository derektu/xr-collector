import path from 'node:path';
import { Menu, nativeImage, Tray } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import type { ChangeBatch } from '../../shared/api/changes.js';
import { API_ROUTES, type ApiRoute, type BodyOf, type ResponseOf } from '../../shared/api/api-routes.js';
import { menuStaleAfter, trayMenuText, trayModel } from './tray-menu.js';
import type { TrayAction, TrayIcon, TrayMenu, TrayModel, TrayState } from './tray-menu.js';
import type { DesktopTarget } from './main-window.js';
import type { NotificationTarget } from './notification-navigation.js';

export const READ_GAP_MS = 1000;

export interface AppTrayOptions {
  platform: NodeJS.Platform;
  serverUrl: string;
  iconFolder: string;
  changes: { subscribe(listener: (batch: ChangeBatch) => void): () => void };
  show(page?: Extract<DesktopTarget, string> | { notification: NotificationTarget }): void;
  quit(): void;
}

export class AppTray {
  private readonly tray: Tray;
  private shown: TrayModel = trayModel(null);
  private menu: TrayMenu = trayMenuText(this.shown);
  private state: TrayState | null = null;
  private drawn = '';
  private pending: Promise<void> | null = null;
  private again = false;
  private lastRead = 0;
  private stopped = false;
  private midnight: ReturnType<typeof setTimeout> | undefined;
  private readonly stopFollowing: () => void;
  reads = 0;

  constructor(private readonly options: AppTrayOptions) {
    this.tray = new Tray(this.image('idle'));
    // Windows shows a notification area icon's context menu on right click and leaves left click to the app;
    // macOS opens a menu bar item's menu on left click.
    if (options.platform === 'win32') this.tray.on('click', () => options.show());
    this.draw();
    this.stopFollowing = options.changes.subscribe((batch) => { if (menuStaleAfter(batch.changes)) void this.refresh(); });
    void this.refresh();
    this.atMidnight();
  }

  current(): TrayMenu { return this.menu; }

  model(): TrayModel { return this.shown; }

  get reading(): boolean { return this.pending !== null; }

  refresh(): Promise<void> {
    if (this.pending) { this.again = true; return this.pending; }
    this.pending = (async () => {
      try {
        do {
          const wait = this.lastRead + READ_GAP_MS - Date.now();
          if (wait > 0) await new Promise((resolve) => { setTimeout(resolve, wait); });
          if (this.stopped) return;
          this.again = false;
          this.lastRead = Date.now();
          const state = await this.read();
          if (this.stopped) return;
          this.state = state;
          this.show(trayModel(state));
        } while (this.again);
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  async run(action: TrayAction): Promise<void> {
    if (action.startsWith('subscription:')) {
      const id = action.slice('subscription:'.length);
      const notification = this.state?.actionable?.find((event) => event.id === id);
      if (notification) this.options.show({ notification });
      return;
    }
    switch (action) {
      case 'open': this.options.show(); return;
      case 'jobs': this.options.show('jobs'); return;
      case 'activity': this.options.show('activity'); return;
      case 'check_app_update':
        if (this.state?.update && ['idle', 'up_to_date', 'error'].includes(this.state.update.phase)) {
          await this.send(API_ROUTES.checkUpdate, undefined);
        }
        this.options.show('update');
        break;
      case 'quit': this.options.quit(); return;
      case 'check_now': await this.send(API_ROUTES.checkSubscriptions, undefined); break;
      case 'toggle_auto_check': await this.send(API_ROUTES.setSchedule, { enabled: !this.state?.schedule?.enabled }); break;
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
      this.show(trayModel(this.state));
      this.atMidnight();
    }, next.getTime() - Date.now());
  }

  private show(model: TrayModel): void {
    this.shown = model;
    this.menu = trayMenuText(model);
    this.draw();
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

  private async read(): Promise<TrayState | null> {
    this.reads += 1;
    try {
      const [update, notifications] = await Promise.all([
        this.get(API_ROUTES.update),
        this.get(API_ROUTES.notifications),
      ]);
      try {
        const [overview, schedule] = await Promise.all([
          this.get(API_ROUTES.jobOverview),
          this.get(API_ROUTES.schedule),
        ]);
        return { overview: overview.overview, schedule: schedule.schedule, update: update.update,
          actionable: notifications.notifications.active };
      } catch { return { update: update.update, actionable: notifications.notifications.active }; }
    } catch {
      return null;
    }
  }

  private async get<Route extends ApiRoute<unknown, unknown, unknown>>(route: Route): Promise<ResponseOf<Route>> {
    const response = await fetch(new URL(route.path, this.options.serverUrl));
    if (!response.ok) throw new Error(`${route.path} answered ${response.status}`);
    return await response.json() as ResponseOf<Route>;
  }

  private async send<Route extends ApiRoute<unknown, unknown, unknown>>(route: Route, body: BodyOf<Route>): Promise<void> {
    const response = await fetch(new URL(route.path, this.options.serverUrl), {
      method: route.method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${route.method} ${route.path} answered ${response.status}: ${await response.text()}`);
  }

  // macOS tints menu bar template images: black plus alpha, file name ending in Template.
  // https://www.electronjs.org/docs/latest/api/native-image#template-image-macos
  private image(icon: TrayIcon, updateBadge = false): Electron.NativeImage {
    const state = `${icon}${updateBadge ? '-update' : ''}`;
    const name = this.options.platform === 'darwin' ? `tray-${state}Template.png` : `tray-${state}.png`;
    return nativeImage.createFromPath(path.join(this.options.iconFolder, name));
  }
}
