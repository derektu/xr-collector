import type { IpcMain, WebContents } from 'electron';
import { isStoredTheme, type FileThemePreference } from './theme-preference.js';
import type { LogWriter } from '../../shared/log/log-types.js';

export interface PageChannelOptions {
  ipc: Pick<IpcMain, 'handle' | 'on'>;
  theme: Pick<FileThemePreference, 'read' | 'write'>;
  navigationReady(sender: WebContents): void;
  log: LogWriter;
}

export function registerPageChannels(options: PageChannelOptions): void {
  const { ipc, theme, log } = options;
  ipc.handle('xrCollector:theme:read', () => theme.read());
  ipc.on('xrCollector:navigation:ready', (event) => options.navigationReady(event.sender));
  ipc.handle('xrCollector:theme:write', (_event, value: unknown) => {
    if (!isStoredTheme(value)) throw new Error('Unsupported theme preference');
    return theme.write(value).catch((error: unknown) => { log.write({ level: 'warn', source: 'desktop', message: 'Unable to save theme preference', error }); });
  });
}
