import { CancellationToken, MacUpdater, NsisUpdater, type AppUpdater as ElectronUpdater, type ProgressInfo } from 'electron-updater';
import { updateFeedUrl, type AppUpdater } from '../../domain/updates/index.js';

export interface DesktopUpdater extends AppUpdater {
  quitAndInstall(): void;
}

const unavailable: DesktopUpdater = {
  available: false,
  check: async () => null,
  download: async () => { throw new Error('此執行環境無法安裝更新。'); },
  quitAndInstall: () => undefined,
};

export function desktopUpdater(options: {
  packaged: boolean;
  platform: NodeJS.Platform;
  feedUrl: string | undefined;
  installFailed: (error: Error) => void;
}): DesktopUpdater {
  if (!options.packaged || (options.platform !== 'darwin' && options.platform !== 'win32')) return unavailable;
  const updater: ElectronUpdater = options.platform === 'darwin' ? new MacUpdater() : new NsisUpdater();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  if (options.feedUrl) updater.setFeedURL({ provider: 'generic', url: updateFeedUrl(options.feedUrl) });
  let installing = false;
  // External: electron-updater is an EventEmitter that reports failures as `error` events, and an `error` event without a listener throws.
  // https://nodejs.org/docs/latest-v22.x/api/events.html#error-events
  updater.on('error', (error: Error) => {
    if (!installing) return;
    installing = false;
    options.installFailed(error);
  });
  return {
    available: true,
    check: async () => {
      const result = await updater.checkForUpdates();
      if (!result?.isUpdateAvailable) return null;
      return { version: result.updateInfo.version };
    },
    download: async (progress, signal) => {
      const token = new CancellationToken();
      const cancel = () => token.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      const report = (info: ProgressInfo) => progress(info.transferred, info.total);
      updater.on('download-progress', report);
      try { await updater.downloadUpdate(token); }
      finally {
        updater.off('download-progress', report);
        signal.removeEventListener('abort', cancel);
      }
    },
    quitAndInstall: () => {
      installing = true;
      updater.quitAndInstall(true, true);
    },
  };
}
