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
  openTrash: () => ipcRenderer.invoke('open-trash'),
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
  isMas: () => ipcRenderer.invoke('is-mas'),
  checkFullDiskAccess: () => ipcRenderer.invoke('check-full-disk-access'),
  requestFullDiskAccess: () => ipcRenderer.invoke('request-full-disk-access'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => {
    ipcRenderer.on('update-download-progress', (_event, progress) => callback(progress));
  },
  onUpdateAvailable: (callback: (info: any) => void) => {
    ipcRenderer.on('update-available', (_event, info) => callback(info));
  },
  undoAction: () => ipcRenderer.invoke('undo-action'),
  redoAction: () => ipcRenderer.invoke('redo-action'),
  getUndoRedoState: () => ipcRenderer.invoke('get-undo-redo-state'),
  searchIndex: (query: string) => ipcRenderer.invoke('search-index', query),
  rebuildIndex: () => ipcRenderer.invoke('rebuild-index'),
  getIndexStatus: () => ipcRenderer.invoke('get-index-status'),
  compressFiles: (sourcePaths: string[], outputPath: string, format?: string, operationId?: string) => ipcRenderer.invoke('compress-files', sourcePaths, outputPath, format, operationId),
  extractArchive: (archivePath: string, destPath: string, operationId?: string) => ipcRenderer.invoke('extract-archive', archivePath, destPath, operationId),
  cancelArchiveOperation: (operationId: string) => ipcRenderer.invoke('cancel-archive-operation', operationId),
  onCompressProgress: (callback: (progress: {operationId?: string; current: number; total: number; name: string}) => void) => {
    ipcRenderer.on('compress-progress', (_event, progress) => callback(progress));
  },
  onExtractProgress: (callback: (progress: {operationId?: string; current: number; total: number; name: string}) => void) => {
    ipcRenderer.on('extract-progress', (_event, progress) => callback(progress));
  },
  setZoomLevel: (zoomLevel: number) => ipcRenderer.invoke('set-zoom-level', zoomLevel),
  getZoomLevel: () => ipcRenderer.invoke('get-zoom-level')
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
