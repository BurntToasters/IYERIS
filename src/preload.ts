import { contextBridge, ipcRenderer } from 'electron';
import type { ElectronAPI, Settings, UpdateDownloadProgress } from './types';

const electronAPI: ElectronAPI = {
  getDirectoryContents: (dirPath: string) => ipcRenderer.invoke('get-directory-contents', dirPath),
  getDrives: () => ipcRenderer.invoke('get-drives'),
  getHomeDirectory: () => ipcRenderer.invoke('get-home-directory'),
  openFile: (filePath: string) => ipcRenderer.invoke('open-file', filePath),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  openNewWindow: () => ipcRenderer.invoke('open-new-window'),
  createFolder: (parentPath: string, folderName: string) => ipcRenderer.invoke('create-folder', parentPath, folderName),
  createFile: (parentPath: string, fileName: string) => ipcRenderer.invoke('create-file', parentPath, fileName),
  deleteItem: (itemPath: string) => ipcRenderer.invoke('delete-item', itemPath),
  trashItem: (itemPath: string) => ipcRenderer.invoke('trash-item', itemPath),
  renameItem: (oldPath: string, newName: string) => ipcRenderer.invoke('rename-item', oldPath, newName),
  getItemProperties: (itemPath: string) => ipcRenderer.invoke('get-item-properties', itemPath),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: Settings) => ipcRenderer.invoke('save-settings', settings),
  resetSettings: () => ipcRenderer.invoke('reset-settings'),
  getSettingsPath: () => ipcRenderer.invoke('get-settings-path'),
  copyItems: (sourcePaths: string[], destPath: string) => ipcRenderer.invoke('copy-items', sourcePaths, destPath),
  moveItems: (sourcePaths: string[], destPath: string) => ipcRenderer.invoke('move-items', sourcePaths, destPath),
  searchFiles: (dirPath: string, query: string) => ipcRenderer.invoke('search-files', dirPath, query),
  openTerminal: (dirPath: string) => ipcRenderer.invoke('open-terminal', dirPath),
  getDiskSpace: (drivePath: string) => ipcRenderer.invoke('get-disk-space', drivePath),
  restartAsAdmin: () => ipcRenderer.invoke('restart-as-admin'),
  readFileContent: (filePath: string, maxSize?: number) => ipcRenderer.invoke('read-file-content', filePath, maxSize),
  getFileDataUrl: (filePath: string, maxSize?: number) => ipcRenderer.invoke('get-file-data-url', filePath, maxSize),
  getLicenses: () => ipcRenderer.invoke('get-licenses'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  checkFullDiskAccess: () => ipcRenderer.invoke('check-full-disk-access'),
  requestFullDiskAccess: () => ipcRenderer.invoke('request-full-disk-access'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => {
    ipcRenderer.on('update-download-progress', (_event, progress) => callback(progress));
  },
  undoAction: () => ipcRenderer.invoke('undo-action'),
  redoAction: () => ipcRenderer.invoke('redo-action'),
  getUndoRedoState: () => ipcRenderer.invoke('get-undo-redo-state')
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
