import { contextBridge, ipcRenderer } from 'electron';
import type { ElectronAPI, Settings, UpdateDownloadProgress, FolderSizeProgress, ChecksumResult, SearchFilters, DirectoryContentsProgress } from './types';

const electronAPI: ElectronAPI = {
  getDirectoryContents: (dirPath: string, operationId?: string) => ipcRenderer.invoke('get-directory-contents', dirPath, operationId),
  cancelDirectoryContents: (operationId: string) => ipcRenderer.invoke('cancel-directory-contents', operationId),
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
  relaunchApp: () => ipcRenderer.invoke('relaunch-app'),
  getSettingsPath: () => ipcRenderer.invoke('get-settings-path'),
  
  // Shared clipboard
  setClipboard: (clipboardData: { operation: 'copy' | 'cut'; paths: string[] } | null) => ipcRenderer.invoke('set-clipboard', clipboardData),
  getClipboard: () => ipcRenderer.invoke('get-clipboard'),
  onClipboardChanged: (callback: (clipboardData: { operation: 'copy' | 'cut'; paths: string[] } | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, clipboardData: { operation: 'copy' | 'cut'; paths: string[] } | null) => callback(clipboardData);
    ipcRenderer.on('clipboard-changed', handler);
    return () => ipcRenderer.removeListener('clipboard-changed', handler);
  },
  
  // Cross-window drag and drop
  setDragData: (paths: string[]) => ipcRenderer.invoke('set-drag-data', paths),
  getDragData: () => ipcRenderer.invoke('get-drag-data'),
  clearDragData: () => ipcRenderer.invoke('clear-drag-data'),
  
  // Settings sync
  onSettingsChanged: (callback: (settings: Settings) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: Settings) => callback(settings);
    ipcRenderer.on('settings-changed', handler);
    return () => ipcRenderer.removeListener('settings-changed', handler);
  },
  
  copyItems: (sourcePaths: string[], destPath: string) => ipcRenderer.invoke('copy-items', sourcePaths, destPath),
  moveItems: (sourcePaths: string[], destPath: string) => ipcRenderer.invoke('move-items', sourcePaths, destPath),
  searchFiles: (dirPath: string, query: string, filters?: SearchFilters, operationId?: string) => ipcRenderer.invoke('search-files', dirPath, query, filters, operationId),
  searchFilesWithContent: (dirPath: string, query: string, filters?: SearchFilters, operationId?: string) => ipcRenderer.invoke('search-files-content', dirPath, query, filters, operationId),
  searchFilesWithContentGlobal: (query: string, filters?: SearchFilters, operationId?: string) => ipcRenderer.invoke('search-files-content-global', query, filters, operationId),
  openTerminal: (dirPath: string) => ipcRenderer.invoke('open-terminal', dirPath),
  getDiskSpace: (drivePath: string) => ipcRenderer.invoke('get-disk-space', drivePath),
  restartAsAdmin: () => ipcRenderer.invoke('restart-as-admin'),
  readFileContent: (filePath: string, maxSize?: number) => ipcRenderer.invoke('read-file-content', filePath, maxSize),
  getFileDataUrl: (filePath: string, maxSize?: number) => ipcRenderer.invoke('get-file-data-url', filePath, maxSize),
  getLicenses: () => ipcRenderer.invoke('get-licenses'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  isMas: () => ipcRenderer.invoke('is-mas'),
  isFlatpak: () => ipcRenderer.invoke('is-flatpak'),
  isMsStore: () => ipcRenderer.invoke('is-ms-store'),
  checkFullDiskAccess: () => ipcRenderer.invoke('check-full-disk-access'),
  requestFullDiskAccess: () => ipcRenderer.invoke('request-full-disk-access'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: UpdateDownloadProgress) => callback(progress);
    ipcRenderer.on('update-download-progress', handler);
    return () => ipcRenderer.removeListener('update-download-progress', handler);
  },
  onUpdateAvailable: (callback: (info: any) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: any) => callback(info);
    ipcRenderer.on('update-available', handler);
    return () => ipcRenderer.removeListener('update-available', handler);
  },
  undoAction: () => ipcRenderer.invoke('undo-action'),
  redoAction: () => ipcRenderer.invoke('redo-action'),
  getUndoRedoState: () => ipcRenderer.invoke('get-undo-redo-state'),
  searchIndex: (query: string, operationId?: string) => ipcRenderer.invoke('search-index', query, operationId),
  cancelSearch: (operationId: string) => ipcRenderer.invoke('cancel-search', operationId),
  rebuildIndex: () => ipcRenderer.invoke('rebuild-index'),
  getIndexStatus: () => ipcRenderer.invoke('get-index-status'),
  compressFiles: (sourcePaths: string[], outputPath: string, format?: string, operationId?: string) => ipcRenderer.invoke('compress-files', sourcePaths, outputPath, format, operationId),
  extractArchive: (archivePath: string, destPath: string, operationId?: string) => ipcRenderer.invoke('extract-archive', archivePath, destPath, operationId),
  cancelArchiveOperation: (operationId: string) => ipcRenderer.invoke('cancel-archive-operation', operationId),
  onCompressProgress: (callback: (progress: {operationId?: string; current: number; total: number; name: string}) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: {operationId?: string; current: number; total: number; name: string}) => callback(progress);
    ipcRenderer.on('compress-progress', handler);
    return () => ipcRenderer.removeListener('compress-progress', handler);
  },
  onExtractProgress: (callback: (progress: {operationId?: string; current: number; total: number; name: string}) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: {operationId?: string; current: number; total: number; name: string}) => callback(progress);
    ipcRenderer.on('extract-progress', handler);
    return () => ipcRenderer.removeListener('extract-progress', handler);
  },
  onSystemResumed: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('system-resumed', handler);
    return () => ipcRenderer.removeListener('system-resumed', handler);
  },
  setZoomLevel: (zoomLevel: number) => ipcRenderer.invoke('set-zoom-level', zoomLevel),
  getZoomLevel: () => ipcRenderer.invoke('get-zoom-level'),
  calculateFolderSize: (folderPath: string, operationId: string) => ipcRenderer.invoke('calculate-folder-size', folderPath, operationId),
  cancelFolderSizeCalculation: (operationId: string) => ipcRenderer.invoke('cancel-folder-size-calculation', operationId),
  onFolderSizeProgress: (callback: (progress: FolderSizeProgress & {operationId: string}) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: FolderSizeProgress & {operationId: string}) => callback(progress);
    ipcRenderer.on('folder-size-progress', handler);
    return () => ipcRenderer.removeListener('folder-size-progress', handler);
  },
  onDirectoryContentsProgress: (callback: (progress: DirectoryContentsProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: DirectoryContentsProgress) => callback(progress);
    ipcRenderer.on('directory-contents-progress', handler);
    return () => ipcRenderer.removeListener('directory-contents-progress', handler);
  },
  calculateChecksum: (filePath: string, operationId: string, algorithms: string[]) => ipcRenderer.invoke('calculate-checksum', filePath, operationId, algorithms),
  cancelChecksumCalculation: (operationId: string) => ipcRenderer.invoke('cancel-checksum-calculation', operationId),
  onChecksumProgress: (callback: (progress: {operationId: string; percent: number; algorithm: string}) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: {operationId: string; percent: number; algorithm: string}) => callback(progress);
    ipcRenderer.on('checksum-progress', handler);
    return () => ipcRenderer.removeListener('checksum-progress', handler);
  },
  getGitStatus: (dirPath: string) => ipcRenderer.invoke('get-git-status', dirPath)
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
