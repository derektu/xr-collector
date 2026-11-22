import type { DesktopPlatform } from '../../shared/api/device-types.js';
const { contextBridge, ipcRenderer } = require('electron');
let navigationListener: ((_event: unknown, target: unknown) => void) | undefined;

contextBridge.exposeInMainWorld('xrCollectorTheme', {
  read: () => ipcRenderer.invoke('xrCollector:theme:read'),
  write: (theme: 'system' | 'dark' | 'light') => ipcRenderer.invoke('xrCollector:theme:write', theme),
});

contextBridge.exposeInMainWorld('xrCollectorDesktop', {
  chooseVaultLocation: (start?: string) => ipcRenderer.invoke('xrCollector:desktop:chooseVaultLocation', start),
  chooseVault: (start?: string) => ipcRenderer.invoke('xrCollector:desktop:chooseVault', start),
  chooseExportFile: () => ipcRenderer.invoke('xrCollector:desktop:chooseExportFile'),
  chooseImportFile: () => ipcRenderer.invoke('xrCollector:desktop:chooseImportFile'),
  revealVault: () => ipcRenderer.invoke('xrCollector:desktop:revealVault'),
  revealExport: () => ipcRenderer.invoke('xrCollector:desktop:revealExport'),
  platform: (process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'other') satisfies DesktopPlatform,
  navigationReady: () => ipcRenderer.send('xrCollector:navigation:ready'),
  onNavigate: (listener: (target: unknown) => void) => {
    if (navigationListener) ipcRenderer.removeListener('xrCollector:navigate', navigationListener);
    navigationListener = (_event: unknown, target: unknown) => listener(target);
    ipcRenderer.on('xrCollector:navigate', navigationListener);
  },
});
