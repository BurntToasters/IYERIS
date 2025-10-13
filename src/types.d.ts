export interface Settings {
  transparency: boolean;
  theme: 'dark' | 'light' | 'default';
  sortBy: 'name' | 'date' | 'size' | 'type';
  sortOrder: 'asc' | 'desc';
  bookmarks: string[];
  viewMode: 'grid' | 'list';
}

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modified: Date;
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
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
