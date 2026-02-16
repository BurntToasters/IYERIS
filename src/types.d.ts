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

export interface LicenseInfo {
  licenses?: string | string[];
  repository?: string | { url?: string; type?: string } | null;
  licenseText?: string;
  licenseFile?: string;
  publisher?: string;
  [key: string]: unknown;
}

export type LicensesData = Record<string, LicenseInfo>;

export interface ListColumnWidths {
  name?: number;
  type?: number;
  size?: number;
  modified?: number;
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
  _timestamp?: number;
  shortcuts: { [actionId: string]: string[] };
  theme:
    | 'dark'
    | 'light'
    | 'default'
    | 'custom'
    | 'nord'
    | 'catppuccin'
    | 'dracula'
    | 'solarized'
    | 'github';
  useSystemTheme: boolean;
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
  tourPromptDismissed?: boolean;
  tourCompleted?: boolean;
  skipFullDiskAccessPrompt?: boolean;
  recentFiles?: string[];
  folderIcons?: { [path: string]: string };
  showRecentFiles: boolean;
  showFolderTree: boolean;
  useLegacyTreeSpacing: boolean;
  enableTabs: boolean;
  globalContentSearch: boolean;
  globalClipboard: boolean;
  tabState?: TabState;
  enableSyntaxHighlighting: boolean;
  enableGitStatus: boolean;
  gitIncludeUntracked: boolean;
  showFileHoverCard: boolean;
  showFileCheckboxes: boolean;
  listColumnWidths?: ListColumnWidths;
  sidebarWidth?: number;
  previewPanelWidth?: number;

  reduceMotion: boolean;
  highContrast: boolean;
  largeText: boolean;
  boldText: boolean;
  visibleFocus: boolean;
  reduceTransparency: boolean;
  liquidGlassMode: boolean;
  uiDensity: 'compact' | 'default' | 'larger';
  updateChannel: 'auto' | 'beta' | 'stable';
  themedIcons: boolean;
  disableHardwareAcceleration: boolean;
  useSystemFontSize: boolean;

  confirmFileOperations: boolean;
  fileConflictBehavior: 'ask' | 'rename' | 'skip' | 'overwrite';
  skipElevationConfirmation: boolean;
  maxThumbnailSizeMB: number;
  thumbnailQuality: 'low' | 'medium' | 'high';
  autoPlayVideos: boolean;
  previewPanelPosition: 'right' | 'bottom';
  maxPreviewSizeMB: number;
  gridColumns: 'auto' | '2' | '3' | '4' | '5' | '6';
  iconSize: number;
  compactFileInfo: boolean;
  showFileExtensions: boolean;
  maxSearchHistoryItems: number;
  maxDirectoryHistoryItems: number;
}

export interface HomeSettings {
  showQuickAccess: boolean;
  showRecents: boolean;
  showBookmarks: boolean;
  showDrives: boolean;
  showDiskUsage: boolean;
  hiddenQuickAccessItems: string[];
  quickAccessOrder: string[];
  sectionOrder: string[];
  pinnedRecents: string[];
  compactCards: boolean;
  sidebarQuickAccessOrder: string[];
  hiddenSidebarQuickAccessItems: string[];
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

export interface DriveInfo {
  path: string;
  label: string;
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

export interface IpcSuccess {
  success: true;
  error?: undefined;
}

export interface IpcError {
  success: false;
  error: string;
}

export type IpcResult<TSuccess extends object = object> = (IpcSuccess & TSuccess) | IpcError;

export type ApiResponse<T = void> = T extends void ? IpcResult : IpcResult<{ data: T }>;

export type DirectoryResponse = IpcResult<{ contents: FileItem[] }>;

export type PropertiesResponse = IpcResult<{ properties: ItemProperties }>;

export type SettingsResponse = IpcResult<{ settings: Settings }>;

export type HomeSettingsResponse = IpcResult<{ settings: HomeSettings }>;

export type PathResponse = IpcResult<{ path: string }>;

export type SearchResponse = IpcResult<{ results: FileItem[] }>;

export type ContentSearchResponse = IpcResult<{ results: ContentSearchResult[] }>;

export type IndexSearchResponse = IpcResult<{ results: IndexEntry[] }>;

export type UndoResponse = IpcResult<{ canUndo: boolean; canRedo: boolean }>;

export type UpdateCheckResponse = IpcResult<{
  hasUpdate: boolean;
  updateInfo?: UpdateInfo;
  currentVersion: string;
  latestVersion: string;
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
}>;

export type GitStatusResponse = IpcResult<{
  isGitRepo: boolean;
  statuses: GitFileStatus[];
}>;

export type GitBranchResponse = IpcResult<{ branch: string }>;

export type ArchiveListResponse = IpcResult<{ entries: ArchiveEntry[] }>;

export type DiskSpaceResponse = IpcResult<{ total: number; free: number }>;

export type ZoomLevelResponse = IpcResult<{ zoomLevel: number }>;

export type FileContentResponse = IpcResult<{
  content: string;
  isTruncated: boolean;
}>;

export type FileDataUrlResponse = IpcResult<{ dataUrl: string }>;

export type LicensesResponse = IpcResult<{ licenses: LicensesData }>;

export type FullDiskAccessResponse = IpcResult<{ hasAccess: boolean }>;

export type IndexStatusResponse = IpcResult<{ status: IndexStatus }>;

export type FolderSizeResponse = IpcResult<{ result: FolderSizeResult }>;

export type ChecksumResponse = IpcResult<{ result: ChecksumResult }>;

export type ThumbnailCacheResponse = IpcResult<{ dataUrl: string }>;

export type ThumbnailSaveResponse = IpcResult;

export type ThumbnailClearResponse = IpcResult;

export type ThumbnailCacheSizeResponse = IpcResult<{
  sizeBytes: number;
  fileCount: number;
}>;

export type DiagnosticsResponse = IpcResult<{ path: string }>;

export type UndoRedoStateResponse = IpcResult<{
  canUndo: boolean;
  canRedo: boolean;
}>;

export type SystemAccentColorResponse = IpcResult<{
  accentColor: string;
  isDarkMode: boolean;
}>;

export type ConflictDialogResponse = 'rename' | 'skip' | 'overwrite' | 'cancel';

export interface ClipboardOperation {
  operation: 'copy' | 'cut';
  paths: string[];
}

export interface IndexEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modified: Date;
}

export interface AdvancedCompressOptions {
  compressionLevel?: number;
  method?: string;
  dictionarySize?: string;
  solidBlockSize?: string;
  cpuThreads?: string;
  password?: string;
  encryptionMethod?: string;
  encryptFileNames?: boolean;
  splitVolume?: string;
}

export interface IndexStatus {
  isIndexing: boolean;
  totalFiles: number;
  indexedFiles: number;
  lastIndexTime: Date | null;
}

export interface UndoCreateAction {
  type: 'create';
  data: { path: string; isDirectory: boolean; createdAtMs?: number };
}

export interface UndoRenameAction {
  type: 'rename';
  data: { oldPath: string; newPath: string; oldName: string; newName: string };
}

export interface UndoMoveAction {
  type: 'move';
  data: {
    sourcePaths: string[];
    originalPaths?: string[];
    originalParent?: string;
    destPath: string;
  };
}

export interface UndoTrashAction {
  type: 'trash';
  data: { path: string; originalPath?: string };
}

export type UndoAction = UndoCreateAction | UndoRenameAction | UndoMoveAction | UndoTrashAction;

export interface UpdateInfo {
  version: string;
  releaseDate: string;
  releaseNotes?: string;
}

export interface GitFileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'ignored' | 'conflict';
}

export interface ArchiveEntry {
  name: string;
  size: number;
  isDirectory: boolean;
}

export interface UpdateDownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface ArchiveProgress {
  operationId?: string;
  current: number;
  total: number;
  name: string;
}

export interface ChecksumProgress {
  operationId: string;
  percent: number;
  algorithm: string;
}

export type SpecialDirectory = 'desktop' | 'documents' | 'downloads' | 'music' | 'videos';

export type ConflictBehavior = 'ask' | 'rename' | 'skip' | 'overwrite';

export interface ElectronAPI {
  getDirectoryContents: (
    dirPath: string,
    operationId?: string,
    includeHidden?: boolean,
    streamOnly?: boolean
  ) => Promise<DirectoryResponse>;
  cancelDirectoryContents: (operationId: string) => Promise<IpcResult>;
  getDrives: () => Promise<string[]>;
  getDriveInfo: () => Promise<DriveInfo[]>;
  getHomeDirectory: () => Promise<string>;
  getSpecialDirectory: (directory: SpecialDirectory) => Promise<PathResponse>;
  openFile: (filePath: string) => Promise<IpcResult>;
  selectFolder: () => Promise<PathResponse>;
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  openNewWindow: () => Promise<void>;
  createFolder: (parentPath: string, folderName: string) => Promise<PathResponse>;
  createFile: (parentPath: string, fileName: string) => Promise<PathResponse>;
  deleteItem: (itemPath: string) => Promise<IpcResult>;
  trashItem: (itemPath: string) => Promise<IpcResult>;
  openTrash: () => Promise<IpcResult>;
  renameItem: (oldPath: string, newName: string) => Promise<PathResponse>;
  getItemProperties: (itemPath: string) => Promise<PropertiesResponse>;
  getSettings: () => Promise<SettingsResponse>;
  saveSettings: (settings: Settings) => Promise<IpcResult>;
  saveSettingsSync: (settings: Settings) => IpcResult;
  resetSettings: () => Promise<IpcResult>;
  relaunchApp: () => Promise<void>;
  getSettingsPath: () => Promise<string>;
  getHomeSettings: () => Promise<HomeSettingsResponse>;
  saveHomeSettings: (settings: HomeSettings) => Promise<IpcResult>;
  resetHomeSettings: () => Promise<IpcResult>;
  getHomeSettingsPath: () => Promise<string>;

  setClipboard: (clipboardData: ClipboardOperation | null) => Promise<void>;
  getClipboard: () => Promise<ClipboardOperation | null>;
  getSystemClipboardFiles: () => Promise<string[]>;
  onClipboardChanged: (callback: (clipboardData: ClipboardOperation | null) => void) => () => void;

  setDragData: (paths: string[]) => Promise<void>;
  getDragData: () => Promise<{ paths: string[] } | null>;
  clearDragData: () => Promise<void>;

  onSettingsChanged: (callback: (settings: Settings) => void) => () => void;
  onHomeSettingsChanged: (callback: (settings: HomeSettings) => void) => () => void;

  copyItems: (
    sourcePaths: string[],
    destPath: string,
    conflictBehavior?: ConflictBehavior
  ) => Promise<IpcResult>;
  moveItems: (
    sourcePaths: string[],
    destPath: string,
    conflictBehavior?: ConflictBehavior
  ) => Promise<IpcResult>;
  showConflictDialog: (
    fileName: string,
    operation: 'copy' | 'move'
  ) => Promise<ConflictDialogResponse>;
  searchFiles: (
    dirPath: string,
    query: string,
    filters?: SearchFilters,
    operationId?: string
  ) => Promise<SearchResponse>;
  searchFilesWithContent: (
    dirPath: string,
    query: string,
    filters?: SearchFilters,
    operationId?: string
  ) => Promise<ContentSearchResponse>;
  searchFilesWithContentGlobal: (
    query: string,
    filters?: SearchFilters,
    operationId?: string
  ) => Promise<ContentSearchResponse>;
  getDiskSpace: (drivePath: string) => Promise<DiskSpaceResponse>;
  restartAsAdmin: () => Promise<IpcResult>;
  openTerminal: (dirPath: string) => Promise<IpcResult>;
  elevatedCopy: (sourcePath: string, destPath: string) => Promise<IpcResult>;
  elevatedMove: (sourcePath: string, destPath: string) => Promise<IpcResult>;
  elevatedDelete: (itemPath: string) => Promise<IpcResult>;
  elevatedRename: (itemPath: string, newName: string) => Promise<IpcResult>;
  readFileContent: (filePath: string, maxSize?: number) => Promise<FileContentResponse>;
  getFileDataUrl: (filePath: string, maxSize?: number) => Promise<FileDataUrlResponse>;
  getLicenses: () => Promise<LicensesResponse>;
  getPlatform: () => Promise<string>;
  getAppVersion: () => Promise<string>;
  getSystemAccentColor: () => Promise<{ accentColor: string; isDarkMode: boolean }>;
  isMas: () => Promise<boolean>;
  isFlatpak: () => Promise<boolean>;
  isMsStore: () => Promise<boolean>;
  getSystemTextScale: () => Promise<number>;
  checkFullDiskAccess: () => Promise<FullDiskAccessResponse>;
  requestFullDiskAccess: () => Promise<IpcResult>;
  checkForUpdates: () => Promise<UpdateCheckResponse>;
  downloadUpdate: () => Promise<IpcResult>;
  installUpdate: () => Promise<IpcResult>;
  onUpdateDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => () => void;
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => () => void;
  undoAction: () => Promise<UndoResponse>;
  redoAction: () => Promise<UndoResponse>;
  getUndoRedoState: () => Promise<UndoRedoStateResponse>;
  searchIndex: (query: string, operationId?: string) => Promise<IndexSearchResponse>;
  cancelSearch: (operationId: string) => Promise<IpcResult>;
  rebuildIndex: () => Promise<IpcResult>;
  getIndexStatus: () => Promise<IndexStatusResponse>;
  compressFiles: (
    sourcePaths: string[],
    outputPath: string,
    format?: string,
    operationId?: string,
    advancedOptions?: AdvancedCompressOptions
  ) => Promise<IpcResult>;
  extractArchive: (
    archivePath: string,
    destPath: string,
    operationId?: string
  ) => Promise<IpcResult>;
  cancelArchiveOperation: (operationId: string) => Promise<IpcResult>;
  onCompressProgress: (callback: (progress: ArchiveProgress) => void) => () => void;
  onExtractProgress: (callback: (progress: ArchiveProgress) => void) => () => void;
  onSystemResumed: (callback: () => void) => () => void;
  onSystemThemeChanged: (callback: (data: { isDarkMode: boolean }) => void) => () => void;
  setZoomLevel: (zoomLevel: number) => Promise<IpcResult>;
  getZoomLevel: () => Promise<ZoomLevelResponse>;
  calculateFolderSize: (folderPath: string, operationId: string) => Promise<FolderSizeResponse>;
  cancelFolderSizeCalculation: (operationId: string) => Promise<IpcResult>;
  onFolderSizeProgress: (
    callback: (progress: FolderSizeProgress & { operationId: string }) => void
  ) => () => void;
  onDirectoryContentsProgress: (
    callback: (progress: DirectoryContentsProgress) => void
  ) => () => void;
  calculateChecksum: (
    filePath: string,
    operationId: string,
    algorithms: string[]
  ) => Promise<ChecksumResponse>;
  cancelChecksumCalculation: (operationId: string) => Promise<IpcResult>;
  onChecksumProgress: (callback: (progress: ChecksumProgress) => void) => () => void;
  getGitStatus: (dirPath: string, includeUntracked?: boolean) => Promise<GitStatusResponse>;
  getGitBranch: (dirPath: string) => Promise<GitBranchResponse>;
  listArchiveContents: (archivePath: string) => Promise<ArchiveListResponse>;

  getCachedThumbnail: (filePath: string) => Promise<ThumbnailCacheResponse>;
  saveCachedThumbnail: (filePath: string, dataUrl: string) => Promise<ThumbnailSaveResponse>;
  clearThumbnailCache: () => Promise<ThumbnailClearResponse>;
  getThumbnailCacheSize: () => Promise<ThumbnailCacheSizeResponse>;

  getLogsPath: () => Promise<string>;
  openLogsFolder: () => Promise<IpcResult>;
  exportDiagnostics: () => Promise<DiagnosticsResponse>;
  getLogFileContent: () => Promise<FileContentResponse>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
