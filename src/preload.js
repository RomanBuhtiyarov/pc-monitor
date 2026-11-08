const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  onStats: cb => ipcRenderer.on('stats', (_e, d) => cb(d)),
  kill: p => ipcRenderer.invoke('kill', p),
  unloadModel: p => ipcRenderer.invoke('unload-model', p),
  openPanel: () => ipcRenderer.send('open-panel'),
  closePanel: () => ipcRenderer.send('close-panel'),
  drag: (phase, x, y) => ipcRenderer.send('widget-drag', { phase, x, y }),
  widgetMenu: () => ipcRenderer.send('widget-menu'),
});
