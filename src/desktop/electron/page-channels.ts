import type { IpcMain, WebContents } from 'electron';
import { isStoredTheme, type FileThemePreference } from './theme-preference.js';

export interface PageChannelOptions {
  ipc: Pick<IpcMain, 'handle' | 'on'>;
  theme: Pick<FileThemePreference, 'read' | 'write'>;
  navigationReady(sender: WebContents): void;
}

export function registerPageChannels(options: PageChannelOptions): void {
  const { ipc, theme } = options;
  ipc.handle('xrCollector:theme:read', () => theme.read());
  ipc.on('xrCollector:navigation:ready', (event) => options.navigationReady(event.sender));
  ipc.handle('xrCollector:theme:write', (_event, value: unknown) => {
    if (!isStoredTheme(value)) throw new Error('Unsupported theme preference');
    return theme.write(value).catch((error: unknown) => { console.warn('Unable to save theme preference', error); });
  });
}
