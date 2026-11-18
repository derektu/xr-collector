import type { IpcMain, WebContents } from 'electron';
import { isStoredTheme, type FileThemePreference } from './theme-preference.js';

export interface PageChannelOptions {
  ipc: Pick<IpcMain, 'handle' | 'on'>;
  theme: Pick<FileThemePreference, 'read' | 'write'>;
  /** A page announced that it listens for navigation. */
  pageReady(sender: WebContents): void;
}

/** The IPC the page itself uses: reading and saving the theme, and announcing that it listens. */
export function registerPageChannels(options: PageChannelOptions): void {
  const { ipc, theme } = options;
  ipc.handle('xrCollector:theme:read', () => theme.read());
  ipc.on('xrCollector:renderer:ready', (event) => options.pageReady(event.sender));
  ipc.handle('xrCollector:theme:write', (_event, value: unknown) => {
    if (!isStoredTheme(value)) throw new Error('Unsupported theme preference');
    return theme.write(value).catch((error: unknown) => { console.warn('Unable to save theme preference', error); });
  });
}
