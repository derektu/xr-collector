import type { DeviceUpdateStatus } from '../core/update-types.js';
import type { MainWindow } from './main-window.js';
import type { AppTray } from './tray.js';
import type { TrayAction } from './tray-menu.js';

export interface ValidationControlOptions {
  tray: AppTray;
  window: Pick<MainWindow, 'current' | 'shown' | 'show'>;
  /** The system notifications shown so far, including the first-close hint. */
  notifications(): readonly { id?: string; title: string; content: string }[];
  update(): DeviceUpdateStatus | null;
}

/**
 * The validation control channel, for native acceptance runs only: Playwright reads and drives the
 * tray and the window through `globalThis.__xrCollectorValidation` in this process. The caller
 * opens it only when the run asks for it.
 */
export function exposeValidationControl(options: ValidationControlOptions): void {
  const { tray, window } = options;
  (globalThis as { __xrCollectorValidation?: unknown }).__xrCollectorValidation = {
    tray: async () => { await tray.refresh(); return tray.current(); },
    trayShown: () => ({ menu: tray.current(), reads: tray.reads, reading: tray.reading }),
    click: (action: TrayAction) => tray.run(action),
    notifications: () => [...options.notifications()],
    activateNotification: (id: string) => window.show({ notificationId: id }),
    window: () => {
      const current = window.current;
      return {
        exists: Boolean(current),
        shown: Boolean(current) && window.shown,
        visible: current?.isVisible() ?? false,
        focused: current?.isFocused() ?? false,
        url: current?.webContents.getURL() ?? null,
      };
    },
    closeWindow: () => window.current?.close(),
    update: () => options.update(),
  };
}
