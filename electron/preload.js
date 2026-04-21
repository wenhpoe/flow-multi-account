const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flowApi', {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  deleteProfile: (name) => ipcRenderer.invoke('profiles:delete', name),
  importProfiles: () => ipcRenderer.invoke('profiles:import'),
  exportProfiles: (names) => ipcRenderer.invoke('profiles:export', { names }),
  openProfile: (name) => ipcRenderer.invoke('flow:open', name),
  closeFlowWindow: () => ipcRenderer.invoke('flow:close'),
  closeFlowSession: (sessionId) => ipcRenderer.invoke('flow:closeSession', sessionId),
  focusFlowSession: (sessionId) => ipcRenderer.invoke('flow:focusSession', sessionId),
  quitBrowser: () => ipcRenderer.invoke('flow:quit'),
  getStatus: () => ipcRenderer.invoke('app:status'),
  startCapture: (name) => ipcRenderer.invoke('capture:start', name),
  finishCapture: () => ipcRenderer.invoke('capture:finish'),
  cancelCapture: () => ipcRenderer.invoke('capture:cancel'),
  openProfilesFolder: () => ipcRenderer.invoke('app:openProfilesFolder'),
  openDownloadsFolder: () => ipcRenderer.invoke('app:openDownloadsFolder'),
  chooseDownloadsFolder: () => ipcRenderer.invoke('app:chooseDownloadsFolder'),
  resetDownloadsFolder: () => ipcRenderer.invoke('app:resetDownloadsFolder'),
  activateDevice: (activationCode, serverUrl) =>
    ipcRenderer.invoke('device:activate', { activationCode, serverUrl }),
  setServerUrl: (serverUrl) => ipcRenderer.invoke('device:setServerUrl', { serverUrl }),
  syncDeviceProfiles: () => ipcRenderer.invoke('device:sync')
});
