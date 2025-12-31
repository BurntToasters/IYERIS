export interface CustomTheme {
  name: string;
  accentColor: string;
  bgPrimary: string;
  bgSecondary: string;
  textPrimary: string;
  textSecondary: string;
  glassBg: string;
  glassBorder: string;
}

export interface Tab {
  id: string;
  path: string;
  history: string[];
  historyIndex: number;
  selectedItems: string[];
  scrollPosition: number;
  cachedFiles?: FileItem[];
}

export interface TabState {
  tabs: Tab[];
  activeTabId: string;
}

export interface Settings {
  transparency: boolean;
  theme: 'dark' | 'light' | 'default' | 'custom';
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
  customTheme?: CustomTheme;
  launchCount?: number;
  supportPopupDismissed?: boolean;
  skipFullDiskAccessPrompt?: boolean;
  recentFiles?: string[];
  folderIcons?: { [path: string]: string };
  showRecentFiles: boolean;
  enableTabs: boolean;
  globalContentSearch: boolean;
  tabState?: TabState;
  enableSyntaxHighlighting: boolean;

  reduceMotion: boolean;
  highContrast: boolean;
  largeText: boolean;
  boldText: boolean;
  visibleFocus: boolean;
  reduceTransparency: boolean;
  updateChannel: 'auto' | 'beta' | 'stable';
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

export interface DirectoryContentsProgress {
  dirPath: string;
  items?: FileItem[];
  loaded: number;
  operationId?: string;
}

export interface SearchFilters {
  fileType?: string;
  minSize?: number;
  maxSize?: number;
  dateFrom?: string;
  dateTo?: string;
  searchInContents?: boolean;
}

export interface ContentSearchResult extends FileItem {
  matchContext?: string;
  matchLineNumber?: number;
}

export interface ContentSearchResponse extends ApiResponse {
  results?: ContentSearchResult[];
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

export interface FileTypeStats {
  extension: string;
  count: number;
  size: number;
}

export interface FolderSizeResult {
  totalSize: number;
  fileCount: number;
  folderCount: number;
  fileTypes?: FileTypeStats[];
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

export interface UndoCreateAction {
  type: 'create';
  data: { path: string; isDirectory: boolean };
}

export interface UndoRenameAction {
  type: 'rename';
  data: { oldPath: string; newPath: string; oldName: string; newName: string };
}

export interface UndoMoveAction {
  type: 'move';
  data: { sourcePaths: string[]; originalPaths?: string[]; originalParent?: string; destPath: string };
}

export interface UndoTrashAction {
  type: 'trash';
  data: { path: string; originalPath?: string };
}

export type UndoAction = UndoCreateAction | UndoRenameAction | UndoMoveAction | UndoTrashAction;

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
  isMsStore?: boolean;
  msStoreMessage?: string;
  isMsi?: boolean;
  msiMessage?: string;
}

export interface GitFileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'ignored' | 'conflict';
}

export interface GitStatusResponse extends ApiResponse {
  isGitRepo?: boolean;
  statuses?: GitFileStatus[];
}

export interface UpdateDownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface ElectronAPI {
  getDirectoryContents: (dirPath: string, operationId?: string) => Promise<DirectoryResponse>;
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
  searchFiles: (dirPath: string, query: string, filters?: SearchFilters) => Promise<SearchResponse>;
  searchFilesWithContent: (dirPath: string, query: string, filters?: SearchFilters) => Promise<ContentSearchResponse>;
  searchFilesWithContentGlobal: (query: string, filters?: SearchFilters) => Promise<ContentSearchResponse>;
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
  onDirectoryContentsProgress: (callback: (progress: DirectoryContentsProgress) => void) => () => void;
  calculateChecksum: (filePath: string, operationId: string, algorithms: string[]) => Promise<{success: boolean; result?: ChecksumResult; error?: string}>;
  cancelChecksumCalculation: (operationId: string) => Promise<ApiResponse>;
  onChecksumProgress: (callback: (progress: {operationId: string; percent: number; algorithm: string}) => void) => () => void;
  getGitStatus: (dirPath: string) => Promise<GitStatusResponse>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
