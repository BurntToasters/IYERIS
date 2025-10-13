const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDirectoryContents: (dirPath) => ipcRenderer.invoke('get-directory-contents', dirPath),
  getDrives: () => ipcRenderer.invoke('get-drives'),
  getHomeDirectory: () => ipcRenderer.invoke('get-home-directory'),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  createFolder: (parentPath, folderName) => ipcRenderer.invoke('create-folder', parentPath, folderName),
  createFile: (parentPath, fileName) => ipcRenderer.invoke('create-file', parentPath, fileName),
  deleteItem: (itemPath) => ipcRenderer.invoke('delete-item', itemPath),
  renameItem: (oldPath, newName) => ipcRenderer.invoke('rename-item', oldPath, newName),
  getItemProperties: (itemPath) => ipcRenderer.invoke('get-item-properties', itemPath),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  resetSettings: () => ipcRenderer.invoke('reset-settings'),
  getSettingsPath: () => ipcRenderer.invoke('get-settings-path')
});

