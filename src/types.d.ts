export interface Settings {
  transparency: boolean;
  theme: 'dark' | 'light' | 'default';
  sortBy: 'name' | 'date' | 'size' | 'type';
  sortOrder: 'asc' | 'desc';
  bookmarks: string[];
  viewMode: 'grid' | 'list';
  showDangerousOptions: boolean;
  startupPath: string;
  showHiddenFiles: boolean;
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

export interface UndoAction {
  type: 'delete' | 'rename' | 'move' | 'create';
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
  isFlatpak?: boolean;
  flatpakMessage?: string;
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
  createFolder: (parentPath: string, folderName: string) => Promise<PathResponse>;
  createFile: (parentPath: string, fileName: string) => Promise<PathResponse>;
  deleteItem: (itemPath: string) => Promise<ApiResponse>;
  trashItem: (itemPath: string) => Promise<ApiResponse>;
  renameItem: (oldPath: string, newName: string) => Promise<PathResponse>;
  getItemProperties: (itemPath: string) => Promise<PropertiesResponse>;
  getSettings: () => Promise<SettingsResponse>;
  saveSettings: (settings: Settings) => Promise<ApiResponse>;
  resetSettings: () => Promise<ApiResponse>;
  getSettingsPath: () => Promise<string>;
  copyItems: (sourcePaths: string[], destPath: string) => Promise<ApiResponse>;
  moveItems: (sourcePaths: string[], destPath: string) => Promise<ApiResponse>;
  searchFiles: (dirPath: string, query: string) => Promise<SearchResponse>;
  getDiskSpace: (drivePath: string) => Promise<{success: boolean; total?: number; free?: number; error?: string}>;
  restartAsAdmin: () => Promise<ApiResponse>;
  openTerminal: (dirPath: string) => Promise<ApiResponse>;
  readFileContent: (filePath: string, maxSize?: number) => Promise<{success: boolean; content?: string; error?: string; isTruncated?: boolean}>;
  getFileDataUrl: (filePath: string, maxSize?: number) => Promise<{success: boolean; dataUrl?: string; error?: string}>;
  getLicenses: () => Promise<{success: boolean; licenses?: any; error?: string}>;
  getPlatform: () => Promise<string>;
  checkFullDiskAccess: () => Promise<{success: boolean; hasAccess: boolean}>;
  requestFullDiskAccess: () => Promise<ApiResponse>;
  checkForUpdates: () => Promise<UpdateCheckResponse>;
  downloadUpdate: () => Promise<ApiResponse>;
  installUpdate: () => Promise<ApiResponse>;
  onUpdateDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => void;
  undoAction: () => Promise<UndoResponse>;
  redoAction: () => Promise<UndoResponse>;
  getUndoRedoState: () => Promise<{canUndo: boolean; canRedo: boolean}>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
