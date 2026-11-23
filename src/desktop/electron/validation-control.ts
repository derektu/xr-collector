import type { DeviceUpdateStatus } from '../../shared/api/update-types.js';
import type { MainWindow } from './main-window.js';
import type { AppTray } from './tray.js';
import type { TrayAction } from './tray-menu.js';
import type { NotificationTarget } from './notification-navigation.js';

export interface ValidationControlOptions {
  tray: AppTray;
  window: Pick<MainWindow, 'current' | 'shown' | 'show'>;
  notifications(): readonly { id?: string; title: string; content: string }[];
  update(): DeviceUpdateStatus | null;
}

declare global {
  var __xrCollectorValidation: unknown;
}

export function exposeValidationControl(options: ValidationControlOptions): void {
  const { tray, window } = options;
  globalThis.__xrCollectorValidation = {
    tray: async () => { await tray.refresh(); return tray.current(); },
    trayShown: () => ({ menu: tray.current(), reads: tray.reads, reading: tray.reading }),
    click: (action: TrayAction) => tray.run(action),
    notifications: () => [...options.notifications()],
    activateNotification: (notification: NotificationTarget) => window.show({ notification }),
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
