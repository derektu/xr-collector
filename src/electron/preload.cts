const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xrCollectorTheme', {
  read: () => ipcRenderer.invoke('xrCollector:theme:read'),
  write: (theme: 'system' | 'dark' | 'light') => ipcRenderer.invoke('xrCollector:theme:write', theme),
});

contextBridge.exposeInMainWorld('xrCollectorDesktop', {
  chooseDirectory: (defaultPath?: string) => ipcRenderer.invoke('xrCollector:desktop:chooseDirectory', defaultPath),
  chooseExportFile: () => ipcRenderer.invoke('xrCollector:desktop:chooseExportFile'),
  chooseImportFile: () => ipcRenderer.invoke('xrCollector:desktop:chooseImportFile'),
  revealVault: () => ipcRenderer.invoke('xrCollector:desktop:revealVault'),
  platform: process.platform,
});
