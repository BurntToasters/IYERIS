import type { Settings } from './settings';
import type {
  FileItem,
  DirectoryContentsProgress,
  IndexStatus,
  FolderSizeProgress,
  FolderSizeResult,
  ChecksumResult
} from './files';
import type { SearchFilters } from './search';
import type { UpdateInfo, UpdateDownloadProgress } from './updates';
import type {
  ApiResponse,
  DirectoryResponse,
  PropertiesResponse,
  SettingsResponse,
  PathResponse,
  SearchResponse,
  ContentSearchResponse,
  IndexSearchResponse,
  UndoResponse,
  UpdateCheckResponse,
  GitStatusResponse
} from './api';

export interface ElectronAPI {
  getDirectoryContents: (dirPath: string, operationId?: string, includeHidden?: boolean) => Promise<DirectoryResponse>;
  cancelDirectoryContents: (operationId: string) => Promise<ApiResponse>;
  getDrives: () => Promise<string[]>;
  getHomeDirectory: () => Promise<string>;
  openFile: (filePath: string) => Promise<ApiResponse>;
  selectFolder: () => Promise<PathResponse>;
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  openNewWindow: () => Promise<void>;
  createFolder: (parentPath: string, folderName: string) => Promise<PathResponse>;
  createFile: (parentPath: string, fileName: string) => Promise<PathResponse>;
  deleteItem: (itemPath: string) => Promise<ApiResponse>;
  trashItem: (itemPath: string) => Promise<ApiResponse>;
  openTrash: () => Promise<ApiResponse>;
  renameItem: (oldPath: string, newName: string) => Promise<PathResponse>;
  getItemProperties: (itemPath: string) => Promise<PropertiesResponse>;
  getSettings: () => Promise<SettingsResponse>;
  saveSettings: (settings: Settings) => Promise<ApiResponse>;
  resetSettings: () => Promise<ApiResponse>;
  relaunchApp: () => Promise<void>;
  getSettingsPath: () => Promise<string>;

  setClipboard: (clipboardData: { operation: 'copy' | 'cut'; paths: string[] } | null) => Promise<void>;
  getClipboard: () => Promise<{ operation: 'copy' | 'cut'; paths: string[] } | null>;
  onClipboardChanged: (callback: (clipboardData: { operation: 'copy' | 'cut'; paths: string[] } | null) => void) => () => void;

  setDragData: (paths: string[]) => Promise<void>;
  getDragData: () => Promise<{ paths: string[] } | null>;
  clearDragData: () => Promise<void>;

  onSettingsChanged: (callback: (settings: Settings) => void) => () => void;

  copyItems: (sourcePaths: string[], destPath: string) => Promise<ApiResponse>;
  moveItems: (sourcePaths: string[], destPath: string) => Promise<ApiResponse>;
  searchFiles: (dirPath: string, query: string, filters?: SearchFilters, operationId?: string) => Promise<SearchResponse>;
  searchFilesWithContent: (dirPath: string, query: string, filters?: SearchFilters, operationId?: string) => Promise<ContentSearchResponse>;
  searchFilesWithContentGlobal: (query: string, filters?: SearchFilters, operationId?: string) => Promise<ContentSearchResponse>;
  getDiskSpace: (drivePath: string) => Promise<{success: boolean; total?: number; free?: number; error?: string}>;
  restartAsAdmin: () => Promise<ApiResponse>;
  openTerminal: (dirPath: string) => Promise<ApiResponse>;
  readFileContent: (filePath: string, maxSize?: number) => Promise<{success: boolean; content?: string; error?: string; isTruncated?: boolean}>;
  getFileDataUrl: (filePath: string, maxSize?: number) => Promise<{success: boolean; dataUrl?: string; error?: string}>;
  getLicenses: () => Promise<{ success: boolean; licenses?: any; error?: string }>;
  getPlatform: () => Promise<string>;
  isMas: () => Promise<boolean>;
  isFlatpak: () => Promise<boolean>;
  isMsStore: () => Promise<boolean>;
  checkFullDiskAccess: () => Promise<{ success: boolean; hasAccess: boolean }>;
  requestFullDiskAccess: () => Promise<ApiResponse>;
  checkForUpdates: () => Promise<UpdateCheckResponse>;
  downloadUpdate: () => Promise<ApiResponse>;
  installUpdate: () => Promise<ApiResponse>;
  onUpdateDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => () => void;
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void;
  undoAction: () => Promise<UndoResponse>;
  redoAction: () => Promise<UndoResponse>;
  getUndoRedoState: () => Promise<{canUndo: boolean; canRedo: boolean}>;
  searchIndex: (query: string, operationId?: string) => Promise<IndexSearchResponse>;
  cancelSearch: (operationId: string) => Promise<ApiResponse>;
  rebuildIndex: () => Promise<ApiResponse>;
  getIndexStatus: () => Promise<{success: boolean; status?: IndexStatus; error?: string}>;
  compressFiles: (sourcePaths: string[], outputPath: string, format?: string, operationId?: string) => Promise<ApiResponse>;
  extractArchive: (archivePath: string, destPath: string, operationId?: string) => Promise<ApiResponse>;
  cancelArchiveOperation: (operationId: string) => Promise<ApiResponse>;
  onCompressProgress: (callback: (progress: {operationId?: string; current: number; total: number; name: string}) => void) => () => void;
  onExtractProgress: (callback: (progress: {operationId?: string; current: number; total: number; name: string}) => void) => () => void;
  onSystemResumed: (callback: () => void) => () => void;
  setZoomLevel: (zoomLevel: number) => Promise<ApiResponse>;
  getZoomLevel: () => Promise<{success: boolean; zoomLevel?: number; error?: string}>;
  calculateFolderSize: (folderPath: string, operationId: string) => Promise<{success: boolean; result?: FolderSizeResult; error?: string}>;
  cancelFolderSizeCalculation: (operationId: string) => Promise<ApiResponse>;
  onFolderSizeProgress: (callback: (progress: FolderSizeProgress & {operationId: string}) => void) => () => void;
  onDirectoryContentsProgress: (callback: (progress: DirectoryContentsProgress) => void) => () => void;
  calculateChecksum: (filePath: string, operationId: string, algorithms: string[]) => Promise<{success: boolean; result?: ChecksumResult; error?: string}>;
  cancelChecksumCalculation: (operationId: string) => Promise<ApiResponse>;
  onChecksumProgress: (callback: (progress: {operationId: string; percent: number; algorithm: string}) => void) => () => void;
  getGitStatus: (dirPath: string) => Promise<GitStatusResponse>;
  runElevated: (action: 'copy' | 'move' | 'delete' | 'createFolder' | 'createFile', args: string[]) => Promise<ApiResponse>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export type DialogType = 'info' | 'warning' | 'error' | 'success' | 'question';
