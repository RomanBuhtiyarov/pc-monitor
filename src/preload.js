const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  onStats: cb => ipcRenderer.on('stats', (_e, d) => cb(d)),
  kill: p => ipcRenderer.invoke('kill', p),
  setKey: (provider, key) => ipcRenderer.invoke('key-set', { provider, key }),
  clearKey: provider => ipcRenderer.invoke('key-clear', { provider }),
  refreshSpend: () => ipcRenderer.invoke('spend-refresh'),
  widgetSize: h => ipcRenderer.send('widget-size', h),
  speedStart: () => ipcRenderer.invoke('speedtest-start'),
  unloadModel: p => ipcRenderer.invoke('unload-model', p),
  setScanInterval: sec => ipcRenderer.invoke('scan-interval', sec),
  openPanel: () => ipcRenderer.send('open-panel'),
  closePanel: () => ipcRenderer.send('close-panel'),
  drag: (phase, x, y) => ipcRenderer.send('widget-drag', { phase, x, y }),
  widgetMenu: () => ipcRenderer.send('widget-menu'),
});
