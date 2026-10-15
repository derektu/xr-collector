const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xrCollectorTheme', {
  read: () => ipcRenderer.invoke('xrCollector:theme:read'),
  write: (theme: 'system' | 'dark' | 'light') => ipcRenderer.invoke('xrCollector:theme:write', theme),
});

contextBridge.exposeInMainWorld('xrCollectorDesktop', {
  chooseDirectory: (defaultPath?: string) => ipcRenderer.invoke('xrCollector:desktop:chooseDirectory', defaultPath),
});
