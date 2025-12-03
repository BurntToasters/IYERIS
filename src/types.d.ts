export interface Settings {
  transparency: boolean;
  theme: 'dark' | 'light' | 'default';
  sortBy: 'name' | 'date' | 'size' | 'type';
  sortOrder: 'asc' | 'desc';
  bookmarks: string[];
  viewMode: 'grid' | 'list' | 'column';
  showDangerousOptions: boolean;
  startupPath: string;
  showHiddenFiles: boolean;
  enableSearchHistory: boolean;
  searchHistory: string[];
  directoryHistory: string[];
  enableIndexer: boolean;
  minimizeToTray: boolean;
  startOnLogin: boolean;
  autoCheckUpdates: boolean;
}

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modified: Date;
  isHidden: boolean;
}

export interface ItemProperties {
  path: string;
  name: string;
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  created: Date;
  modified: Date;
  accessed: Date;
}

export interface FolderSizeProgress {
  calculatedSize: number;
  fileCount: number;
  folderCount: number;
  currentPath: string;
}

export interface FolderSizeResult {
  totalSize: number;
  fileCount: number;
  folderCount: number;
}

export interface ChecksumResult {
  md5?: string;
  sha256?: string;
  error?: string;
}

export interface ApiResponse<T = void> {
  success: boolean;
  error?: string;
  data?: T;
}

export interface DirectoryResponse extends ApiResponse {
  contents?: FileItem[];
}

export interface PropertiesResponse extends ApiResponse {
  properties?: ItemProperties;
}

export interface SettingsResponse extends ApiResponse {
  settings?: Settings;
}

export interface PathResponse extends ApiResponse {
  path?: string;
}

export interface ClipboardOperation {
  operation: 'copy' | 'cut';
  paths: string[];
}

export interface SearchResponse extends ApiResponse {
  results?: FileItem[];
}

export interface IndexEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modified: Date;
}

export interface IndexStatus {
  isIndexing: boolean;
  totalFiles: number;
  indexedFiles: number;
  lastIndexTime: Date | null;
}

export interface IndexSearchResponse extends ApiResponse {
  results?: IndexEntry[];
}

export interface UndoAction {
  type: 'trash' | 'rename' | 'move' | 'create';
  data: any;
}

export interface UndoResponse extends ApiResponse {
  canUndo?: boolean;
  canRedo?: boolean;
}

export interface UpdateInfo {
  version: string;
  releaseDate: string;
  releaseNotes?: string;
}

export interface UpdateCheckResponse extends ApiResponse {
  hasUpdate?: boolean;
  updateInfo?: UpdateInfo;
  currentVersion?: string;
  latestVersion?: string;
  releaseUrl?: string;
  isBeta?: boolean;
  isFlatpak?: boolean;
  flatpakMessage?: string;
  isMas?: boolean;
  masMessage?: string;
  isMsi?: boolean;
  msiMessage?: string;
}

export interface UpdateDownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface ElectronAPI {
  getDirectoryContents: (dirPath: string) => Promise<DirectoryResponse>;
  getDrives: () => Promise<string[]>;
  getHomeDirectory: () => Promise<string>;
  openFile: (filePath: string) => Promise<void>;
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
  copyItems: (sourcePaths: string[], destPath: string) => Promise<ApiResponse>;
  moveItems: (sourcePaths: string[], destPath: string) => Promise<ApiResponse>;
  searchFiles: (dirPath: string, query: string) => Promise<SearchResponse>;
  getDiskSpace: (drivePath: string) => Promise<{success: boolean; total?: number; free?: number; error?: string}>;
  restartAsAdmin: () => Promise<ApiResponse>;
  openTerminal: (dirPath: string) => Promise<ApiResponse>;
  readFileContent: (filePath: string, maxSize?: number) => Promise<{success: boolean; content?: string; error?: string; isTruncated?: boolean}>;
  getFileDataUrl: (filePath: string, maxSize?: number) => Promise<{success: boolean; dataUrl?: string; error?: string}>;
  getLicenses: () => Promise<{ success: boolean; licenses?: any; error?: string }>;
  getPlatform: () => Promise<string>;
  isMas: () => Promise<boolean>;
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
  searchIndex: (query: string) => Promise<IndexSearchResponse>;
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
  calculateChecksum: (filePath: string, operationId: string, algorithms: string[]) => Promise<{success: boolean; result?: ChecksumResult; error?: string}>;
  cancelChecksumCalculation: (operationId: string) => Promise<ApiResponse>;
  onChecksumProgress: (callback: (progress: {operationId: string; percent: number; algorithm: string}) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
