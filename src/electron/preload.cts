const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xrCollectorTheme', {
  read: () => ipcRenderer.invoke('xrCollector:theme:read'),
  write: (theme: 'dark' | 'light') => ipcRenderer.invoke('xrCollector:theme:write', theme),
});
