const { contextBridge, ipcRenderer } = require('electron');
type NavigationPage = 'jobs' | 'activity' | 'settings' | 'update';
const navigationListeners = new Set<(page: NavigationPage) => void>();
let pendingNavigation: NavigationPage | undefined;
ipcRenderer.on('xrCollector:navigate', (_event: unknown, page: NavigationPage) => {
  if (navigationListeners.size === 0) pendingNavigation = page;
  else for (const listener of navigationListeners) listener(page);
});

contextBridge.exposeInMainWorld('xrCollectorTheme', {
  read: () => ipcRenderer.invoke('xrCollector:theme:read'),
  write: (theme: 'system' | 'dark' | 'light') => ipcRenderer.invoke('xrCollector:theme:write', theme),
});

contextBridge.exposeInMainWorld('xrCollectorDesktop', {
  chooseDirectory: (defaultPath?: string) => ipcRenderer.invoke('xrCollector:desktop:chooseDirectory', defaultPath),
  chooseExportFile: () => ipcRenderer.invoke('xrCollector:desktop:chooseExportFile'),
  chooseImportFile: () => ipcRenderer.invoke('xrCollector:desktop:chooseImportFile'),
  revealVault: () => ipcRenderer.invoke('xrCollector:desktop:revealVault'),
  revealExport: () => ipcRenderer.invoke('xrCollector:desktop:revealExport'),
  platform: process.platform,
  onNavigate: (listener: (page: NavigationPage) => void) => {
    navigationListeners.add(listener);
    if (pendingNavigation) { const page = pendingNavigation; pendingNavigation = undefined; listener(page); }
  },
});
