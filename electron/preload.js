const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('goldenHandAdmin', Object.freeze({
  getCredentialStatus: () => ipcRenderer.invoke('admin:get-credential-status'),
  configureCredentials: () => ipcRenderer.invoke('admin:configure-credentials'),
  deleteUserCompletely: (request) => ipcRenderer.invoke('admin:delete-user-completely', request),
  openSeylanBank: () => ipcRenderer.invoke('portal:open-seylan'),
}));
