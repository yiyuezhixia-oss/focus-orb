const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getInitial: () => ipcRenderer.invoke('get-initial'),

  startSession: (cfg) => ipcRenderer.send('start-session', cfg),
  openSetup: () => ipcRenderer.send('open-setup'),
  endSession: () => ipcRenderer.send('end-session'),
  minimize: () => ipcRenderer.send('win-minimize'),
  closeWindow: () => ipcRenderer.send('win-close'),

  scanApps: () => ipcRenderer.invoke('scan-apps'),
  openApps: (selected) => ipcRenderer.send('open-apps', selected),
  appsReady: () => ipcRenderer.send('apps-ready'),
  onAppsInit: (cb) => ipcRenderer.on('apps-init', (_e, data) => cb(data)),
  appsConfirm: (list) => ipcRenderer.send('apps-confirm', list),
  appsCancel: () => ipcRenderer.send('apps-cancel'),
  closeApps: () => ipcRenderer.send('close-apps'),
  onAppsSelected: (cb) => ipcRenderer.on('apps-selected', (_e, data) => cb(data)),

  orbReady: () => ipcRenderer.send('orb-ready'),
  onSessionData: (cb) => ipcRenderer.on('session-data', (_e, data) => cb(data)),
  onOrbCommand: (cb) => ipcRenderer.on('orb-command', (_e, cmd) => cb(cmd)),
  orbState: (st) => ipcRenderer.send('orb-state', st),
  orbDragStart: () => ipcRenderer.send('orb-drag-start'),
  orbDragMove: () => ipcRenderer.send('orb-drag-move'),
  orbDragEnd: () => ipcRenderer.send('orb-drag-end'),
  orbMenu: (st) => ipcRenderer.send('orb-menu', st),
  showNotice: (payload) => ipcRenderer.send('show-notice', payload),
  hideNotice: () => ipcRenderer.send('hide-notice'),
  sessionFinished: () => ipcRenderer.send('session-finished'),

  onNoticeData: (cb) => ipcRenderer.on('notice-data', (_e, data) => cb(data)),
  onNoticeHide: (cb) => ipcRenderer.on('notice-hide', () => cb())
});
