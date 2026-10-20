const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('goldenHandAdmin', Object.freeze({
  getCredentialStatus: () => ipcRenderer.invoke('admin:get-credential-status'),
  configureCredentials: () => ipcRenderer.invoke('admin:configure-credentials'),
  getUserCreationTimes: (request) => ipcRenderer.invoke('admin:get-user-creation-times', request),
  deleteUserCompletely: (request) => ipcRenderer.invoke('admin:delete-user-completely', request),
  openSeylanBank: () => ipcRenderer.invoke('portal:open-seylan'),
  getUpdateStatus: () => ipcRenderer.invoke('updater:get-status'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdateStatus: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('updater:status', (_event, state) => callback(state));
  },
}));
