import type {
  Settings,
  FileItem,
  ItemProperties,
  CustomTheme,
  ContentSearchResult,
  GitStatusResponse,
  GitFileStatus,
  SpecialDirectory,
  DriveInfo,
  ListColumnWidths,
} from './types';
import { createFolderTreeManager } from './folderDir.js';
import { escapeHtml, getErrorMessage, ignoreError, isRecord } from './shared.js';
import { clearHtml, getById } from './rendererDom.js';
import {
  buildPathFromSegments,
  createNavigationController,
  parsePath,
} from './rendererNavigation.js';
import { createPreviewController } from './rendererPreviews.js';
import { createSearchController } from './rendererSearch.js';
import { createSelectionController } from './rendererSelection.js';
import { createToastManager } from './rendererToasts.js';
import { createHoverCardController } from './rendererHoverCard.js';
import { createTypeaheadController } from './rendererTypeahead.js';
import { createArchiveOperationsController } from './rendererArchiveOperations.js';
import { createTabsController, type TabData } from './rendererTabs.js';
import { createCommandPaletteController } from './rendererCommandPalette.js';
import { createShortcutsUiController } from './rendererShortcutsUi.js';
import { createSettingsUiController } from './rendererSettingsUi.js';
import { createSettingsModalController } from './rendererSettingsModal.js';
import { createSettingsActionsController } from './rendererSettingsActions.js';
import { createSupportUiController } from './rendererSupportUi.js';
import { createExternalLinksController } from './rendererExternalLinks.js';
import { generatePdfThumbnailPdfJs } from './rendererPdfViewer.js';
import {
  activateModal,
  deactivateModal,
  showAlert,
  showConfirm,
  showDialog,
} from './rendererModals.js';
import { initTooltipSystem } from './rendererTooltips.js';
import {
  encodeFileUrl,
  isWindowsPath,
  normalizeWindowsPath,
  rendererPath as path,
  twemojiImg,
} from './rendererUtils.js';
import { createDefaultSettings } from './settings.js';
import { SHORTCUT_DEFINITIONS, getDefaultShortcuts } from './shortcuts.js';
import type { ShortcutBinding, ShortcutDefinition } from './shortcuts.js';
import {
  createHomeController,
  getPathDisplayValue,
  HOME_VIEW_LABEL,
  HOME_VIEW_PATH,
  HOME_QUICK_ACCESS_ITEMS,
  isHomeViewPath,
} from './home.js';
import { createTourController, type TourController } from './tour.js';
import {
  FILE_ICON_MAP,
  IMAGE_EXTENSIONS,
  RAW_EXTENSIONS,
  ANIMATED_IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  PDF_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  ARCHIVE_SUFFIXES,
  TEXT_EXTENSIONS,
  WORD_EXTENSIONS,
  SPREADSHEET_EXTENSIONS,
  PRESENTATION_EXTENSIONS,
  SOURCE_CODE_EXTENSIONS,
  WEB_EXTENSIONS,
  DATA_EXTENSIONS,
  VIDEO_MIME_TYPES,
  AUDIO_MIME_TYPES,
} from './fileTypes.js';

const THUMBNAIL_MAX_SIZE = 10 * 1024 * 1024;
const SEARCH_DEBOUNCE_MS = 300;
const SETTINGS_SAVE_DEBOUNCE_MS = 1000;
const TOAST_DURATION_MS = 3000;
const SEARCH_HISTORY_MAX = 5;
const DIRECTORY_HISTORY_MAX = 5;
const RENDER_BATCH_SIZE = 50;
const VIRTUALIZE_THRESHOLD = 2000;
const VIRTUALIZE_BATCH_SIZE = 200;
const THUMBNAIL_ROOT_MARGIN = '100px';
const THUMBNAIL_CACHE_MAX = 100;
const THUMBNAIL_CONCURRENT_LOADS = 4;
const THUMBNAIL_QUEUE_MAX = 100;
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const THEME_VALUES = [
  'dark',
  'light',
  'default',
  'custom',
  'nord',
  'catppuccin',
  'dracula',
  'solarized',
  'github',
] as const;
const SORT_BY_VALUES = ['name', 'date', 'size', 'type'] as const;
const SORT_ORDER_VALUES = ['asc', 'desc'] as const;
const FILE_CONFLICT_VALUES = ['ask', 'rename', 'skip', 'overwrite'] as const;
const THUMBNAIL_QUALITY_VALUES = ['low', 'medium', 'high'] as const;
const PREVIEW_POSITION_VALUES = ['right', 'bottom'] as const;
const GRID_COLUMNS_VALUES = ['auto', '2', '3', '4', '5', '6'] as const;
const VIEW_MODE_VALUES = ['grid', 'list', 'column'] as const;
const UPDATE_CHANNEL_VALUES = ['auto', 'beta', 'stable'] as const;

function isOneOf<T extends readonly string[]>(value: string, options: T): value is T[number] {
  return (options as readonly string[]).includes(value);
}
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const DISK_SPACE_CACHE_TTL_MS = 60000;
const GIT_STATUS_CACHE_TTL_MS = 3000;
const LIST_COLUMN_MIN_WIDTHS: Record<string, number> = {
  name: 180,
  type: 120,
  size: 80,
  modified: 140,
};
const SPECIAL_DIRECTORY_ACTIONS: Record<string, { key: SpecialDirectory; label: string }> = {
  desktop: { key: 'desktop', label: 'Desktop' },
  documents: { key: 'documents', label: 'Documents' },
  downloads: { key: 'downloads', label: 'Downloads' },
  music: { key: 'music', label: 'Music' },
  videos: { key: 'videos', label: 'Videos' },
};
const LIST_COLUMN_MAX_WIDTHS: Record<string, number> = {
  name: 640,
  type: 320,
  size: 200,
  modified: 320,
};

const thumbnailCache = new Map<string, string>();
let activeThumbnailLoads = 0;
const pendingThumbnailLoads: Array<() => void> = [];
const fileElementMap: Map<string, HTMLElement> = new Map();
let cutPaths = new Set<string>();
const gitIndicatorPaths = new Set<string>();
const driveLabelByPath = new Map<string, string>();
let cachedDriveInfo: DriveInfo[] = [];
const diskSpaceCache = new Map<string, { timestamp: number; total: number; free: number }>();
const DISK_SPACE_CACHE_MAX = 50;
const gitStatusCache = new Map<
  string,
  { timestamp: number; isGitRepo: boolean; statuses: GitFileStatus[] }
>();
const GIT_STATUS_CACHE_MAX = 100;
const gitStatusInFlight = new Map<string, Promise<GitStatusResponse>>();

function cacheDriveInfo(drives: DriveInfo[]): void {
  cachedDriveInfo = drives;
  driveLabelByPath.clear();
  drives.forEach((drive) => {
    if (drive?.path) {
      driveLabelByPath.set(drive.path, drive.label || drive.path);
    }
  });
}

// throttle concurrent thumbnail loads
function enqueueThumbnailLoad(loadFn: () => Promise<void>): void {
  const execute = async () => {
    activeThumbnailLoads++;
    try {
      await loadFn();
    } finally {
      activeThumbnailLoads--;
      if (pendingThumbnailLoads.length > 0) {
        const next = pendingThumbnailLoads.shift();
        if (next) next();
      }
    }
  };

  if (activeThumbnailLoads < THUMBNAIL_CONCURRENT_LOADS) {
    execute();
  } else if (pendingThumbnailLoads.length < THUMBNAIL_QUEUE_MAX) {
    pendingThumbnailLoads.push(execute);
  }
}

function updateVersionDisplays(appVersion: string): void {
  const rawVersion = appVersion.trim();
  const versionTag = rawVersion.startsWith('v') ? rawVersion : `v${rawVersion}`;
  const statusVersion = getById('status-version');
  if (statusVersion) {
    statusVersion.textContent = versionTag;
    statusVersion.setAttribute('title', `Version ${rawVersion}`);
  }
  const aboutVersion = getById('about-version-display');
  if (aboutVersion) {
    aboutVersion.textContent = `Version ${rawVersion}`;
  }
}

async function saveSettingsWithTimestamp(settings: Settings) {
  if (isResettingSettings) {
    return { success: true };
  }
  settings._timestamp = Date.now();
  return window.electronAPI.saveSettings(settings);
}

let settingsSaveTimeout: ReturnType<typeof setTimeout> | null = null;
function debouncedSaveSettings(delay: number = SETTINGS_SAVE_DEBOUNCE_MS) {
  if (settingsSaveTimeout) {
    clearTimeout(settingsSaveTimeout);
  }
  settingsSaveTimeout = setTimeout(async () => {
    await saveSettingsWithTimestamp(currentSettings);
    settingsSaveTimeout = null;
  }, delay);
}

type ViewMode = 'grid' | 'list' | 'column';

const ipcCleanupFunctions: (() => void)[] = [];

const archiveOperationsController = createArchiveOperationsController({
  cancelArchiveOperation: (operationId) => window.electronAPI.cancelArchiveOperation(operationId),
});

const {
  generateOperationId,
  addOperation,
  updateOperation,
  removeOperation,
  getOperation,
  cleanup: cleanupArchiveOperations,
} = archiveOperationsController;

let currentPath: string = '';
let history: string[] = [];
let historyIndex: number = -1;
let selectedItems: Set<string> = new Set();
let viewMode: ViewMode = 'grid';
let contextMenuData: FileItem | null = null;
let clipboard: { operation: 'copy' | 'cut'; paths: string[] } | null = null;
let allFiles: FileItem[] = [];
let hiddenFilesCount = 0;
let platformOS: string = '';
let canUndo: boolean = false;
let canRedo: boolean = false;
let folderTreeEnabled: boolean = true;
let currentZoomLevel: number = 1.0;
let zoomPopupTimeout: NodeJS.Timeout | null = null;
let indexStatusInterval: NodeJS.Timeout | null = null;

let springLoadedTimeout: NodeJS.Timeout | null = null;
let springLoadedFolder: HTMLElement | null = null;
const SPRING_LOAD_DELAY = 800;
let activeListResizeColumn: string | null = null;
let listResizeStartX = 0;
let listResizeStartWidth = 0;
let listResizeCurrentWidth = 0;
let bookmarksDropReady = false;

function getFileItemsArray(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.file-item')) as HTMLElement[];
}

let tabs: TabData[] = [];
let activeTabId: string = '';
let tabsEnabled: boolean = false;
let tabNewButtonListenerAttached: boolean = false;

const MAX_CACHED_TABS = 5;
const MAX_CACHED_FILES_PER_TAB = 10000;
let tabCacheAccessOrder: string[] = [];
let saveTabStateTimeout: NodeJS.Timeout | null = null;
const addressInput = document.getElementById('address-input') as HTMLInputElement;
const fileGrid = document.getElementById('file-grid') as HTMLElement;
fileGrid?.setAttribute('role', 'listbox');
fileGrid?.setAttribute('aria-label', 'File list');
const fileView = document.getElementById('file-view') as HTMLElement;
const columnView = document.getElementById('column-view') as HTMLElement;
const homeView = document.getElementById('home-view') as HTMLElement;
const loading = document.getElementById('loading') as HTMLElement;
const loadingText = document.getElementById('loading-text') as HTMLElement;
const emptyState = document.getElementById('empty-state') as HTMLElement;
const backBtn = document.getElementById('back-btn') as HTMLButtonElement;
const forwardBtn = document.getElementById('forward-btn') as HTMLButtonElement;
const upBtn = document.getElementById('up-btn') as HTMLButtonElement;
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
const newFileBtn = document.getElementById('new-file-btn') as HTMLButtonElement;
const newFolderBtn = document.getElementById('new-folder-btn') as HTMLButtonElement;
const viewToggleBtn = document.getElementById('view-toggle-btn') as HTMLButtonElement;
const viewOptions = document.getElementById('view-options') as HTMLElement;
const listHeader = document.getElementById('list-header') as HTMLElement;
const folderTree = document.getElementById('folder-tree') as HTMLElement;
const sidebarResizeHandle = document.getElementById('sidebar-resize-handle') as HTMLElement;
const drivesList = document.getElementById('drives-list') as HTMLElement;
const sortBtn = document.getElementById('sort-btn') as HTMLButtonElement;
const bookmarksList = document.getElementById('bookmarks-list') as HTMLElement;
const bookmarkAddBtn = document.getElementById('bookmark-add-btn') as HTMLButtonElement;
const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
const dropIndicator = document.getElementById('drop-indicator') as HTMLElement;
const dropIndicatorAction = document.getElementById('drop-indicator-action') as HTMLElement;
const dropIndicatorPath = document.getElementById('drop-indicator-path') as HTMLElement;
const previewResizeHandle = document.getElementById('preview-resize-handle') as HTMLElement;
const selectionCopyBtn = document.getElementById('selection-copy-btn') as HTMLButtonElement;
const selectionCutBtn = document.getElementById('selection-cut-btn') as HTMLButtonElement;
const selectionMoveBtn = document.getElementById('selection-move-btn') as HTMLButtonElement;
const selectionRenameBtn = document.getElementById('selection-rename-btn') as HTMLButtonElement;
const selectionDeleteBtn = document.getElementById('selection-delete-btn') as HTMLButtonElement;
const statusItems = document.getElementById('status-items') as HTMLElement;
const statusSelected = document.getElementById('status-selected') as HTMLElement;
const statusSearch = document.getElementById('status-search') as HTMLElement;
const statusSearchText = document.getElementById('status-search-text') as HTMLElement;
const selectionIndicator = document.getElementById('selection-indicator') as HTMLElement;
const selectionCount = document.getElementById('selection-count') as HTMLElement;
const statusHidden = document.getElementById('status-hidden') as HTMLElement;

const folderTreeManager = createFolderTreeManager({
  folderTree,
  nameCollator: NAME_COLLATOR,
  getFolderIcon,
  getBasename: (value) => driveLabelByPath.get(value) ?? path.basename(value),
  navigateTo: (value) => navigateTo(value),
  handleDrop,
  getDraggedPaths,
  getDragOperation,
  scheduleSpringLoad,
  clearSpringLoad,
  showDropIndicator,
  hideDropIndicator,
  createDirectoryOperationId,
  getDirectoryContents: (dirPath, operationId, showHidden) =>
    window.electronAPI.getDirectoryContents(dirPath, operationId, showHidden),
  parsePath,
  buildPathFromSegments,
  getCurrentPath: () => currentPath,
  shouldShowHidden: () => currentSettings.showHiddenFiles,
});

let activeDirectoryProgressPath: string | null = null;
let activeDirectoryProgressOperationId: string | null = null;
let activeDirectoryOperationId: string | null = null;
let directoryRequestId = 0;
let directoryProgressCount = 0;
let lastDirectoryProgressUpdate = 0;

window.electronAPI.onDirectoryContentsProgress((progress) => {
  if (activeDirectoryProgressOperationId) {
    if (progress.operationId !== activeDirectoryProgressOperationId) return;
  } else if (!activeDirectoryProgressPath || progress.dirPath !== activeDirectoryProgressPath) {
    return;
  }
  directoryProgressCount = progress.loaded;
  const now = Date.now();
  if (now - lastDirectoryProgressUpdate < 100) return;
  lastDirectoryProgressUpdate = now;
  if (loadingText) {
    loadingText.textContent = `Loading... (${directoryProgressCount.toLocaleString()} items)`;
  }
});

function createDirectoryOperationId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function startDirectoryRequest(path: string): { requestId: number; operationId: string } {
  const requestId = ++directoryRequestId;
  if (activeDirectoryOperationId) {
    window.electronAPI.cancelDirectoryContents(activeDirectoryOperationId).catch(ignoreError);
  }
  const operationId = createDirectoryOperationId('dir');
  activeDirectoryOperationId = operationId;
  activeDirectoryProgressOperationId = operationId;
  activeDirectoryProgressPath = path;
  directoryProgressCount = 0;
  lastDirectoryProgressUpdate = 0;
  if (loadingText) loadingText.textContent = 'Loading...';
  return { requestId, operationId };
}

function finishDirectoryRequest(requestId: number): void {
  if (requestId !== directoryRequestId) return;
  activeDirectoryOperationId = null;
  activeDirectoryProgressOperationId = null;
  activeDirectoryProgressPath = null;
  directoryProgressCount = 0;
  lastDirectoryProgressUpdate = 0;
  if (loadingText) loadingText.textContent = 'Loading...';
}

function showLoading(context?: string): void {
  if (loading) loading.style.display = 'flex';
  if (loadingText) loadingText.textContent = context || 'Loading...';
  if (emptyState) emptyState.style.display = 'none';
}

function hideLoading(): void {
  if (loading) loading.style.display = 'none';
  if (loadingText) loadingText.textContent = 'Loading...';
}

function cancelDirectoryRequest(): void {
  if (activeDirectoryOperationId) {
    window.electronAPI.cancelDirectoryContents(activeDirectoryOperationId).catch(ignoreError);
  }
  directoryRequestId += 1;
  finishDirectoryRequest(directoryRequestId);
}

const currentGitStatuses: Map<string, string> = new Map();
let gitStatusRequestId = 0;

function clearGitIndicators(): void {
  currentGitStatuses.clear();
  for (const itemPath of gitIndicatorPaths) {
    fileElementMap.get(itemPath)?.querySelector('.git-indicator')?.remove();
  }
  gitIndicatorPaths.clear();
}

async function fetchGitStatusAsync(dirPath: string) {
  if (!currentSettings.enableGitStatus) {
    return;
  }

  const requestId = ++gitStatusRequestId;
  const includeUntracked = currentSettings.gitIncludeUntracked !== false;

  try {
    const result = await getGitStatusCached(dirPath, includeUntracked);
    if (
      requestId !== gitStatusRequestId ||
      dirPath !== currentPath ||
      !currentSettings.enableGitStatus
    ) {
      return;
    }

    currentGitStatuses.clear();

    if (result.success && result.isGitRepo && result.statuses) {
      for (const item of result.statuses) {
        currentGitStatuses.set(item.path, item.status);
      }
      updateGitIndicators();
    } else {
      clearGitIndicators();
    }
  } catch (error) {
    console.error('[Git Status] Failed to fetch:', error);
  }
}

async function getGitStatusCached(
  dirPath: string,
  includeUntracked: boolean
): Promise<GitStatusResponse> {
  const cacheKey = `${dirPath}|${includeUntracked ? 'all' : 'tracked'}`;
  const cached = gitStatusCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < GIT_STATUS_CACHE_TTL_MS) {
    return { success: true, isGitRepo: cached.isGitRepo, statuses: cached.statuses };
  }

  const inFlight = gitStatusInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const request = window.electronAPI
    .getGitStatus(dirPath, includeUntracked)
    .then((result) => {
      if (result.success) {
        if (gitStatusCache.size >= GIT_STATUS_CACHE_MAX) {
          const firstKey = gitStatusCache.keys().next().value;
          if (firstKey) gitStatusCache.delete(firstKey);
        }
        gitStatusCache.set(cacheKey, {
          timestamp: Date.now(),
          isGitRepo: result.isGitRepo === true,
          statuses: result.statuses || [],
        });
      }
      return result;
    })
    .finally(() => {
      gitStatusInFlight.delete(cacheKey);
    });

  gitStatusInFlight.set(cacheKey, request);
  return request;
}

async function updateGitBranch(dirPath: string) {
  const statusGitBranch = document.getElementById('status-git-branch');
  const statusGitBranchName = document.getElementById('status-git-branch-name');

  if (!statusGitBranch || !statusGitBranchName) return;

  if (!currentSettings.enableGitStatus) {
    statusGitBranch.style.display = 'none';
    return;
  }

  try {
    const result = await window.electronAPI.getGitBranch(dirPath);
    if (result.success && result.branch && dirPath === currentPath) {
      statusGitBranchName.textContent = result.branch;
      statusGitBranch.style.display = 'inline-flex';
    } else {
      statusGitBranch.style.display = 'none';
    }
  } catch {
    statusGitBranch.style.display = 'none';
  }
}

function updateGitIndicators() {
  if (!currentSettings.enableGitStatus) {
    clearGitIndicators();
    return;
  }

  for (const itemPath of Array.from(gitIndicatorPaths)) {
    if (!currentGitStatuses.has(itemPath)) {
      fileElementMap.get(itemPath)?.querySelector('.git-indicator')?.remove();
      gitIndicatorPaths.delete(itemPath);
    }
  }

  applyGitIndicatorsToPaths(Array.from(currentGitStatuses.keys()));
}

function applyGitIndicatorsToPaths(paths: string[]): void {
  for (const itemPath of paths) {
    const status = currentGitStatuses.get(itemPath);
    if (!status) continue;
    const item = fileElementMap.get(itemPath);
    if (!item) continue;

    let indicator = item.querySelector('.git-indicator') as HTMLElement | null;
    if (!indicator) {
      indicator = document.createElement('span');
      item.appendChild(indicator);
    }
    indicator.className = `git-indicator ${status}`;
    indicator.title = status.charAt(0).toUpperCase() + status.slice(1);
    gitIndicatorPaths.add(itemPath);
  }
}

let currentSettings: Settings = createDefaultSettings();
let isResettingSettings = false;
const tourController: TourController = createTourController({
  getSettings: () => currentSettings,
  saveSettings: (settings) => saveSettingsWithTimestamp(settings),
  onModalOpen: activateModal,
  onModalClose: deactivateModal,
});

const toastManager = createToastManager({
  durationMs: TOAST_DURATION_MS,
  maxVisible: 3,
  getContainer: () => getById('toast-container'),
  twemojiImg,
});
const showToast = toastManager.showToast;

const homeController = createHomeController({
  twemojiImg,
  showToast,
  showConfirm,
  navigateTo: (path) => {
    void navigateTo(path);
  },
  handleQuickAction: (action) => {
    void handleQuickAction(action);
  },
  getFileIcon,
  formatFileSize,
  getSettings: () => currentSettings,
  openPath: (filePath) => openPathWithArchivePrompt(filePath, undefined, false),
  onModalOpen: activateModal,
  onModalClose: deactivateModal,
});

const navigationController = createNavigationController({
  getCurrentPath: () => currentPath,
  getCurrentSettings: () => currentSettings,
  getBreadcrumbContainer: () => getById('breadcrumb-container'),
  getBreadcrumbMenu: () => getById('breadcrumb-menu'),
  getAddressInput: () => getById('address-input') as HTMLInputElement | null,
  getPathDisplayValue,
  isHomeViewPath,
  homeViewLabel: HOME_VIEW_LABEL,
  homeViewPath: HOME_VIEW_PATH,
  navigateTo: (path) => {
    void navigateTo(path);
  },
  createDirectoryOperationId,
  nameCollator: NAME_COLLATOR,
  getFolderIcon,
  getDragOperation,
  showDropIndicator,
  hideDropIndicator,
  getDraggedPaths,
  handleDrop,
  debouncedSaveSettings,
  saveSettingsWithTimestamp,
  showToast,
  directoryHistoryMax: DIRECTORY_HISTORY_MAX,
});

const searchController = createSearchController({
  getCurrentPath: () => currentPath,
  getCurrentSettings: () => currentSettings,
  setAllFiles: (files) => {
    allFiles = files;
  },
  renderFiles: (files, highlight) => renderFiles(files, highlight),
  showLoading,
  hideLoading,
  updateStatusBar,
  showToast,
  createDirectoryOperationId,
  navigateTo: (path) => {
    void navigateTo(path);
  },
  debouncedSaveSettings,
  saveSettingsWithTimestamp,
  getFileGrid: () => fileGrid,
  searchDebounceMs: SEARCH_DEBOUNCE_MS,
  searchHistoryMax: SEARCH_HISTORY_MAX,
});

const previewController = createPreviewController({
  getSelectedItems: () => selectedItems,
  getFileByPath: (path) => filePathMap.get(path),
  getCurrentSettings: () => currentSettings,
  formatFileSize,
  getFileExtension,
  getFileIcon,
  openFileEntry,
  onModalOpen: activateModal,
  onModalClose: deactivateModal,
});

const selectionController = createSelectionController({
  getSelectedItems: () => selectedItems,
  setSelectedItems: (items) => {
    selectedItems = items;
  },
  updateStatusBar,
  isPreviewVisible: () => previewController.isPreviewVisible(),
  updatePreview: (file) => previewController.updatePreview(file),
  clearPreview: () => previewController.clearPreview(),
  getFileByPath: (path) => filePathMap.get(path),
  getViewMode: () => viewMode,
  getFileGrid: () => fileGrid,
  openFileEntry,
});

const {
  updateBreadcrumb,
  setupBreadcrumbListeners,
  hideBreadcrumbMenu,
  addToDirectoryHistory,
  showDirectoryHistoryDropdown,
  hideDirectoryHistoryDropdown,
  clearDirectoryHistory,
  getBreadcrumbMenuElement,
  isBreadcrumbMenuOpen,
} = navigationController;

const {
  initListeners: initSearchListeners,
  closeSearch,
  openSearch,
  performSearch,
  cancelActiveSearch,
  showSearchHistoryDropdown,
  hideSearchHistoryDropdown,
  clearSearchHistory,
  getStatusText: getSearchStatusText,
  isSearchMode: isSearchModeActive,
  getSearchInputElement,
  setQuery: setSearchQuery,
  focusInput: focusSearchInput,
} = searchController;

const {
  toggleSelection,
  clearSelection,
  selectAll,
  openSelectedItem,
  navigateFileGrid,
  selectFirstItem,
  selectLastItem,
  navigateByPage,
  setupRubberBandSelection,
  isRubberBandActive,
  ensureActiveItem,
} = selectionController;

const hoverCardController = createHoverCardController({
  getFileItemData,
  formatFileSize,
  getFileTypeFromName,
  getFileIcon,
  getThumbnailForPath: (path) => thumbnailCache.get(path),
  isRubberBandActive,
});

const { setEnabled: setHoverCardEnabled, setup: setupHoverCard } = hoverCardController;

const typeaheadController = createTypeaheadController({
  getFileItems: () => getFileItemsArray(),
  clearSelection,
  getSelectedItems: () => selectedItems,
  updateStatusBar,
});

const { handleInput: handleTypeaheadInput, reset: resetTypeahead } = typeaheadController;

const {
  initPreviewUi,
  updatePreview,
  showQuickLook,
  showQuickLookForFile,
  closeQuickLook,
  isQuickLookOpen,
} = previewController;

const tabsController = createTabsController({
  getTabs: () => tabs,
  setTabs: (value) => {
    tabs = value;
  },
  getActiveTabId: () => activeTabId,
  setActiveTabId: (value) => {
    activeTabId = value;
  },
  getTabsEnabled: () => tabsEnabled,
  setTabsEnabled: (value) => {
    tabsEnabled = value;
  },
  getTabNewButtonListenerAttached: () => tabNewButtonListenerAttached,
  setTabNewButtonListenerAttached: (value) => {
    tabNewButtonListenerAttached = value;
  },
  getTabCacheAccessOrder: () => tabCacheAccessOrder,
  setTabCacheAccessOrder: (value) => {
    tabCacheAccessOrder = value;
  },
  getSaveTabStateTimeout: () => saveTabStateTimeout,
  setSaveTabStateTimeout: (value) => {
    saveTabStateTimeout = value;
  },
  getCurrentSettings: () => currentSettings,
  getCurrentPath: () => currentPath,
  setCurrentPath: (value) => {
    currentPath = value;
  },
  getHistory: () => history,
  setHistory: (value) => {
    history = value;
  },
  getHistoryIndex: () => historyIndex,
  setHistoryIndex: (value) => {
    historyIndex = value;
  },
  getSelectedItems: () => selectedItems,
  setSelectedItems: (value) => {
    selectedItems = value;
  },
  getAllFiles: () => allFiles,
  setAllFiles: (value) => {
    allFiles = value;
  },
  getFileViewScrollTop: () => fileView?.scrollTop || 0,
  setFileViewScrollTop: (value) => {
    if (fileView) fileView.scrollTop = value;
  },
  getAddressInput: () => addressInput,
  getPathDisplayValue,
  isHomeViewPath,
  homeViewLabel: HOME_VIEW_LABEL,
  homeViewPath: HOME_VIEW_PATH,
  getViewMode: () => viewMode,
  renderFiles: (files) => renderFiles(files),
  renderColumnView: () => renderColumnView(),
  updateBreadcrumb,
  updateNavigationButtons,
  setHomeViewActive,
  navigateTo: (pathValue, force) => {
    void navigateTo(pathValue, force);
  },
  debouncedSaveSettings,
  saveSettingsWithTimestamp,
  maxCachedTabs: MAX_CACHED_TABS,
  maxCachedFilesPerTab: MAX_CACHED_FILES_PER_TAB,
});

const {
  initializeTabs,
  addNewTab,
  closeTab,
  saveTabState,
  updateCurrentTabPath,
  switchToTab,
  cleanup: cleanupTabs,
} = tabsController;

interface ReservedShortcut {
  label: string;
  actionId?: string;
}

const MODIFIER_ORDER = ['Ctrl', 'Shift', 'Alt', 'Meta'];
const MODIFIER_SET = new Set(MODIFIER_ORDER);
const shortcutLookup = new Map<string, string>();
const fixedShortcutLookup = new Map<string, string>();
const reservedShortcutLookup = new Map<string, ReservedShortcut>();
const COMMAND_PALETTE_FIXED_SHORTCUTS: Record<string, ShortcutBinding> = {
  refresh: ['F5'],
  delete: ['Delete'],
  rename: ['F2'],
};
let shortcutBindings: Record<string, ShortcutBinding> = {};

const shortcutDefinitionById = new Map<string, ShortcutDefinition>(
  SHORTCUT_DEFINITIONS.map((def) => [def.id, def])
);

function isMacPlatform(): boolean {
  if (platformOS) return platformOS === 'darwin';
  return typeof process !== 'undefined' && process.platform === 'darwin';
}

function isWindowsPlatform(): boolean {
  if (platformOS) return platformOS === 'win32';
  return typeof process !== 'undefined' && process.platform === 'win32';
}

function normalizeModifierKey(key: string): string | null {
  const lower = key.toLowerCase();
  if (lower === 'control' || lower === 'ctrl') return 'Ctrl';
  if (lower === 'shift') return 'Shift';
  if (lower === 'alt' || lower === 'option') return 'Alt';
  if (lower === 'meta' || lower === 'cmd' || lower === 'command') return 'Meta';
  return null;
}

function normalizeKeyLabel(key: string): string | null {
  if (!key || key === 'Dead') return null;
  const modifier = normalizeModifierKey(key);
  if (modifier) return modifier;
  if (key === ' ') return 'Space';
  if (key === 'Esc') return 'Escape';
  if (key === 'Del') return 'Delete';
  if (key === '?') return '/';
  if (key === '+') return '=';
  if (key === '_') return '-';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function normalizeShortcutBinding(binding: string[]): ShortcutBinding {
  const modifiers = new Set<string>();
  let mainKey: string | null = null;
  for (const part of binding) {
    const normalized = normalizeKeyLabel(part);
    if (!normalized) continue;
    if (MODIFIER_SET.has(normalized)) {
      modifiers.add(normalized);
    } else if (!mainKey) {
      mainKey = normalized;
    }
  }
  const orderedModifiers = MODIFIER_ORDER.filter((mod) => modifiers.has(mod));
  return mainKey ? [...orderedModifiers, mainKey] : orderedModifiers;
}

function serializeShortcut(binding: ShortcutBinding): string {
  return binding.join('::');
}

function hasModifier(binding: ShortcutBinding): boolean {
  return binding.some((key) => MODIFIER_SET.has(key));
}

function eventToBinding(e: KeyboardEvent): ShortcutBinding | null {
  const key = normalizeKeyLabel(e.key);
  if (!key || MODIFIER_SET.has(key)) return null;
  const modifiers: string[] = [];
  const ignoreShift = e.shiftKey && (e.key === '?' || e.key === '+' || e.key === '_');
  if (e.ctrlKey) modifiers.push('Ctrl');
  if (e.shiftKey && !ignoreShift) modifiers.push('Shift');
  if (e.altKey) modifiers.push('Alt');
  if (e.metaKey) modifiers.push('Meta');
  return normalizeShortcutBinding([...modifiers, key]);
}

function rebuildShortcutLookup(): void {
  shortcutLookup.clear();
  for (const [id, binding] of Object.entries(shortcutBindings)) {
    if (binding.length === 0) continue;
    shortcutLookup.set(serializeShortcut(binding), id);
  }
}

function registerFixedShortcut(binding: ShortcutBinding, actionId: string): void {
  const normalized = normalizeShortcutBinding(binding);
  if (normalized.length === 0) return;
  fixedShortcutLookup.set(serializeShortcut(normalized), actionId);
}

function registerReservedShortcut(
  binding: ShortcutBinding,
  actionId: string | null,
  label: string
): void {
  const normalized = normalizeShortcutBinding(binding);
  if (normalized.length === 0) return;
  reservedShortcutLookup.set(serializeShortcut(normalized), {
    label,
    actionId: actionId ?? undefined,
  });
}

function rebuildFixedShortcuts(): void {
  fixedShortcutLookup.clear();
  registerFixedShortcut(['F5'], 'refresh');
  registerFixedShortcut(['Ctrl', 'R'], 'refresh');
  registerFixedShortcut(['Meta', 'R'], 'refresh');
  if (!isMacPlatform()) {
    registerFixedShortcut(['Ctrl', 'Shift', 'Z'], 'redo');
  } else {
    registerFixedShortcut(['Meta', 'Z'], 'undo');
    registerFixedShortcut(['Meta', 'Shift', 'Z'], 'redo');
  }
}

function rebuildReservedShortcuts(): void {
  reservedShortcutLookup.clear();
  registerReservedShortcut(['F5'], 'refresh', 'Refresh');
  registerReservedShortcut(['Ctrl', 'R'], 'refresh', 'Refresh');
  registerReservedShortcut(['Meta', 'R'], 'refresh', 'Refresh');
  registerReservedShortcut(['Shift', 'Delete'], null, 'Permanent Delete');
  registerReservedShortcut(['Shift', 'ArrowUp'], null, 'Extend Selection');
  registerReservedShortcut(['Shift', 'ArrowDown'], null, 'Extend Selection');
  registerReservedShortcut(['Shift', 'ArrowLeft'], null, 'Extend Selection');
  registerReservedShortcut(['Shift', 'ArrowRight'], null, 'Extend Selection');
  if (!isMacPlatform()) {
    registerReservedShortcut(['Ctrl', 'Shift', 'Z'], 'redo', 'Redo');
  } else {
    registerReservedShortcut(['Meta', 'Z'], 'undo', 'Undo');
    registerReservedShortcut(['Meta', 'Shift', 'Z'], 'redo', 'Redo');
  }
}

function getFixedShortcutActionIdFromEvent(e: KeyboardEvent): string | null {
  const binding = eventToBinding(e);
  if (!binding) return null;
  return fixedShortcutLookup.get(serializeShortcut(binding)) ?? null;
}

function syncShortcutBindingsFromSettings(
  settings: Settings,
  options: { save?: boolean; render?: boolean } = {}
): void {
  rebuildFixedShortcuts();
  rebuildReservedShortcuts();
  const defaults = getDefaultShortcuts();
  const normalized: Record<string, ShortcutBinding> = {};
  const used = new Set<string>();
  let changed = false;

  for (const def of SHORTCUT_DEFINITIONS) {
    const raw = settings.shortcuts?.[def.id] || defaults[def.id];
    let binding = normalizeShortcutBinding(raw);
    if (binding.length > 0 && (!hasModifier(binding) || binding.length < 2)) {
      binding = normalizeShortcutBinding(defaults[def.id]);
      changed = true;
    }
    if (binding.length > 0) {
      let serialized = serializeShortcut(binding);
      const reservedEntry = reservedShortcutLookup.get(serialized);
      if (reservedEntry && reservedEntry.actionId !== def.id) {
        const fallback = normalizeShortcutBinding(defaults[def.id]);
        const fallbackSerialized = serializeShortcut(fallback);
        if (serialized !== fallbackSerialized) {
          binding = fallback;
          serialized = fallbackSerialized;
          changed = true;
        }
      }
      if (binding.length > 0 && used.has(serialized)) {
        const fallback = normalizeShortcutBinding(defaults[def.id]);
        const fallbackSerialized = serializeShortcut(fallback);
        if (!used.has(fallbackSerialized)) {
          binding = fallback;
        } else {
          binding = [];
        }
        changed = true;
        serialized = serializeShortcut(binding);
      }
      if (binding.length > 0) {
        used.add(serialized);
      }
    }
    normalized[def.id] = binding;
  }

  if (!settings.shortcuts) {
    settings.shortcuts = normalized;
    changed = true;
  } else if (changed) {
    settings.shortcuts = normalized;
  }

  shortcutBindings = normalized;
  rebuildShortcutLookup();
  syncCommandShortcuts();
  if (options.render) {
    renderShortcutsModal();
  }
  if (options.save && changed) {
    debouncedSaveSettings(100);
  }
}

function getShortcutBinding(id: string): ShortcutBinding | undefined {
  const binding = shortcutBindings[id];
  return binding && binding.length > 0 ? binding : undefined;
}

function getShortcutActionIdFromEvent(e: KeyboardEvent): string | null {
  const binding = eventToBinding(e);
  if (!binding || !hasModifier(binding)) return null;
  return shortcutLookup.get(serializeShortcut(binding)) ?? null;
}

function areBindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
  return (
    serializeShortcut(normalizeShortcutBinding(a)) ===
    serializeShortcut(normalizeShortcutBinding(b))
  );
}

function formatModifierLabel(key: string): string {
  if (!isMacPlatform()) return key;
  if (key === 'Meta') return '⌘ Cmd';
  if (key === 'Ctrl') return '⌃ Ctrl';
  if (key === 'Alt') return '⌥ Option';
  if (key === 'Shift') return '⇧ Shift';
  return key;
}

function formatShortcutKeyLabel(key: string): string {
  if (MODIFIER_SET.has(key)) {
    return formatModifierLabel(key);
  }
  const labels: Record<string, string> = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Escape: 'Esc',
    PageUp: 'Page Up',
    PageDown: 'Page Down',
    '/': '?',
  };
  return labels[key] || (key.length === 1 ? key.toUpperCase() : key);
}

const commandPaletteController = createCommandPaletteController({
  activateModal,
  deactivateModal,
  showToast,
  getShortcutBinding,
  fixedShortcuts: COMMAND_PALETTE_FIXED_SHORTCUTS,
  remappableCommandIds: new Set(SHORTCUT_DEFINITIONS.map((def) => def.id)),
  formatShortcutKeyLabel,
  getTabsEnabled: () => tabsEnabled,
  actions: {
    createNewFolder: () => {
      void createNewFolder();
    },
    createNewFile: () => {
      void createNewFile();
    },
    refresh: () => {
      refresh();
    },
    goBack: () => {
      goBack();
    },
    goForward: () => {
      goForward();
    },
    goUp: () => {
      goUp();
    },
    showSettingsModal: () => {
      showSettingsModal();
    },
    showShortcutsModal: () => {
      showShortcutsModal();
    },
    selectAll: () => {
      selectAll();
    },
    copyToClipboard: () => {
      copyToClipboard();
    },
    cutToClipboard: () => {
      cutToClipboard();
    },
    pasteFromClipboard: () => {
      pasteFromClipboard();
    },
    deleteSelected: () => {
      deleteSelected();
    },
    renameSelected: () => {
      renameSelected();
    },
    setViewMode: (mode) => {
      void setViewMode(mode);
    },
    addNewTab: () => {
      void addNewTab();
    },
  },
});

const { initCommandPalette, showCommandPalette, syncCommandShortcuts } = commandPaletteController;

const shortcutsUi = createShortcutsUiController({
  isMacPlatform,
  formatShortcutKeyLabel,
  getDefaultShortcuts,
  shortcutDefinitions: SHORTCUT_DEFINITIONS,
  getShortcutBindings: () => shortcutBindings,
  setShortcutBindings: (bindings) => {
    shortcutBindings = bindings;
  },
  normalizeShortcutBinding,
  areBindingsEqual,
  getCurrentSettings: () => currentSettings,
  rebuildShortcutLookup,
  syncCommandShortcuts,
  debouncedSaveSettings,
  eventToBinding,
  hasModifier,
  serializeShortcut,
  reservedShortcutLookup,
  shortcutLookup,
  shortcutDefinitionById,
  showToast,
});

const { renderShortcutsModal, initShortcutsModal, stopShortcutCapture, isShortcutCaptureActive } =
  shortcutsUi;

const settingsUi = createSettingsUiController({
  updateDangerousOptionsVisibility,
  saveSettings,
});

const {
  initSettingsTabs,
  initSettingsUi,
  activateSettingsTab,
  applySettingsSearch,
  updateSettingsCardSummaries,
  syncQuickActionsFromMain,
  captureSettingsFormState,
  applySettingsFormState,
  buildSettingsFormStateFromSettings,
  clearSettingsChanged,
  initSettingsChangeTracking,
  setSuppressSettingsTracking,
  getSavedState,
  setSavedState,
  resetRedoState,
} = settingsUi;

const settingsModalController = createSettingsModalController({
  getCurrentSettings: () => currentSettings,
  activateModal,
  deactivateModal,
  setSuppressSettingsTracking,
  activateSettingsTab,
  updateCustomThemeUI,
  updateDangerousOptionsVisibility,
  updateIndexStatus,
  updateThumbnailCacheSize,
  syncQuickActionsFromMain,
  updateSettingsCardSummaries,
  applySettingsSearch,
  clearSettingsChanged,
  initSettingsChangeTracking,
  stopIndexStatusPolling,
});

const { showSettingsModal, hideSettingsModal } = settingsModalController;

const settingsActionsController = createSettingsActionsController({
  getCurrentSettings: () => currentSettings,
  setCurrentSettings: (settings) => {
    currentSettings = settings;
  },
  saveSettingsWithTimestamp,
  showToast,
  loadBookmarks,
  updateThumbnailCacheSize,
  clearThumbnailCacheLocal: () => {
    thumbnailCache.clear();
  },
  hideSettingsModal,
  showSettingsModal,
  isOneOf,
  themeValues: THEME_VALUES,
  sortByValues: SORT_BY_VALUES,
  sortOrderValues: SORT_ORDER_VALUES,
  viewModeValues: VIEW_MODE_VALUES,
});

const { initSettingsActions } = settingsActionsController;

const supportUiController = createSupportUiController({
  activateModal,
  deactivateModal,
  escapeHtml,
  getErrorMessage,
  getCurrentSettings: () => currentSettings,
  saveSettingsWithTimestamp,
  openExternal: (url) => {
    window.electronAPI.openFile(url);
  },
});

const {
  showLicensesModal,
  hideLicensesModal,
  initLicensesUi,
  showSupportPopup,
  hideSupportPopup,
  initSupportPopup,
} = supportUiController;

const externalLinksController = createExternalLinksController({
  openExternal: (url) => {
    window.electronAPI.openFile(url);
  },
  showLicensesModal,
  showShortcutsModal,
});

const { initExternalLinks } = externalLinksController;

interface ProgressOperation {
  id: string;
  title: string;
  status: string;
  progress: number;
  completed: boolean;
  error: boolean;
}

const progressOperations = new Map<string, ProgressOperation>();
let progressPanel: HTMLElement | null = null;
let progressPanelContent: HTMLElement | null = null;

function initProgressPanel(): void {
  progressPanel = document.getElementById('progress-panel');
  progressPanelContent = document.getElementById('progress-panel-content');

  const closeBtn = document.getElementById('progress-panel-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', hideProgressPanel);
  }
}

function hideProgressPanel(): void {
  if (progressPanel) {
    progressPanel.style.display = 'none';
  }
}

async function loadSettings(): Promise<void> {
  const [result, sharedClipboard] = await Promise.all([
    window.electronAPI.getSettings(),
    window.electronAPI.getClipboard(),
  ]);

  if (result.success && result.settings) {
    const defaults = createDefaultSettings();
    currentSettings = { ...defaults, ...result.settings };
    currentSettings.enableSyntaxHighlighting = currentSettings.enableSyntaxHighlighting !== false;
    syncShortcutBindingsFromSettings(currentSettings, { save: true });
    applySettings(currentSettings);
    const newLaunchCount = (currentSettings.launchCount || 0) + 1;
    currentSettings.launchCount = newLaunchCount;
    debouncedSaveSettings(100);

    if (newLaunchCount === 2 && !currentSettings.supportPopupDismissed) {
      setTimeout(() => showSupportPopup(), 1500);
    }

    tourController.handleLaunch(newLaunchCount);
  }

  if (sharedClipboard) {
    clipboard = sharedClipboard;
    console.log(
      '[Init] Loaded shared clipboard:',
      clipboard.operation,
      clipboard.paths.length,
      'items'
    );
  }

  window.addEventListener('focus', () => {
    updateClipboardIndicator();
  });
}

async function applySystemFontSize(): Promise<void> {
  try {
    const scaleFactor = await window.electronAPI.getSystemTextScale();
    const fontScale = 1 + (scaleFactor - 1) * 0.5;
    document.documentElement.style.setProperty('--system-font-scale', fontScale.toString());
    document.body.classList.add('use-system-font-size');
  } catch (error) {
    console.error('[Settings] Failed to get system text scale:', error);
  }
}

function applySettings(settings: Settings) {
  document.body.classList.remove(
    'theme-dark',
    'theme-light',
    'theme-default',
    'theme-custom',
    'theme-nord',
    'theme-catppuccin',
    'theme-dracula',
    'theme-solarized',
    'theme-github'
  );
  if (settings.theme && settings.theme !== 'default') {
    document.body.classList.add(`theme-${settings.theme}`);
  }

  if (settings.theme === 'custom' && settings.customTheme) {
    applyCustomThemeColors(settings.customTheme);
  } else {
    clearCustomThemeColors();
  }

  if (settings.viewMode) {
    viewMode = settings.viewMode;
    applyViewMode();
  }

  applyListColumnWidths();
  applySidebarWidth();
  applyPreviewPanelWidth();
  updateSortIndicators();

  if (settings.reduceMotion) {
    document.body.classList.add('reduce-motion');
  } else {
    document.body.classList.remove('reduce-motion');
  }

  if (settings.highContrast) {
    document.body.classList.add('high-contrast');
  } else {
    document.body.classList.remove('high-contrast');
  }

  if (settings.largeText) {
    document.body.classList.add('large-text');
  } else {
    document.body.classList.remove('large-text');
  }

  // Apply system font size scaling
  if (settings.useSystemFontSize) {
    applySystemFontSize();
  } else {
    document.documentElement.style.removeProperty('--system-font-scale');
    document.body.classList.remove('use-system-font-size');
  }

  // Apply UI density
  document.body.classList.remove('compact-ui', 'large-ui');
  if (settings.uiDensity === 'compact') {
    document.body.classList.add('compact-ui');
  } else if (settings.uiDensity === 'larger') {
    document.body.classList.add('large-ui');
  }

  if (settings.boldText) {
    document.body.classList.add('bold-text');
  } else {
    document.body.classList.remove('bold-text');
  }

  if (settings.visibleFocus) {
    document.body.classList.add('visible-focus');
  } else {
    document.body.classList.remove('visible-focus');
  }

  if (settings.reduceTransparency) {
    document.body.classList.add('reduce-transparency');
  } else {
    document.body.classList.remove('reduce-transparency');
  }

  if (settings.liquidGlassMode) {
    document.body.classList.add('liquid-glass');
  } else {
    document.body.classList.remove('liquid-glass');
  }

  if (settings.themedIcons) {
    document.body.classList.add('themed-icons');
  } else {
    document.body.classList.remove('themed-icons');
  }

  if (settings.showFileCheckboxes) {
    document.body.classList.add('show-file-checkboxes');
  } else {
    document.body.classList.remove('show-file-checkboxes');
  }

  // Compact file info
  if (settings.compactFileInfo) {
    document.body.classList.add('compact-file-info');
  } else {
    document.body.classList.remove('compact-file-info');
  }

  // Show file extensions
  if (settings.showFileExtensions === false) {
    document.body.classList.add('hide-file-extensions');
  } else {
    document.body.classList.remove('hide-file-extensions');
  }

  // Grid columns
  if (settings.gridColumns && settings.gridColumns !== 'auto') {
    document.documentElement.style.setProperty('--grid-columns', settings.gridColumns);
  } else {
    document.documentElement.style.removeProperty('--grid-columns');
  }

  // Icon size
  if (settings.iconSize && settings.iconSize > 0) {
    document.documentElement.style.setProperty('--icon-size-grid', `${settings.iconSize}px`);
  } else {
    document.documentElement.style.removeProperty('--icon-size-grid');
  }

  // Preview panel position
  document.body.classList.remove('preview-right', 'preview-bottom');
  if (settings.previewPanelPosition === 'bottom') {
    document.body.classList.add('preview-bottom');
  } else {
    document.body.classList.add('preview-right');
  }

  setHoverCardEnabled(settings.showFileHoverCard !== false);
  if (settings.showFileHoverCard !== false) {
    setupHoverCard();
  }

  if (settings.enableGitStatus) {
    if (currentPath) {
      fetchGitStatusAsync(currentPath);
      updateGitBranch(currentPath);
    }
  } else {
    clearGitIndicators();
    gitStatusCache.clear();
    gitStatusInFlight.clear();
    const statusGitBranch = document.getElementById('status-git-branch');
    if (statusGitBranch) statusGitBranch.style.display = 'none';
  }

  const nextFolderTreeEnabled = settings.showFolderTree !== false;
  setFolderTreeVisibility(nextFolderTreeEnabled);
  if (nextFolderTreeEnabled && !folderTreeEnabled) {
    loadDrives();
  }
  folderTreeEnabled = nextFolderTreeEnabled;

  loadBookmarks();
  loadRecentFiles();
}

function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    return `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`;
  }
  return '0, 120, 212';
}

function hexToRgba(hex: string, alpha: number): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    const r = parseInt(result[1], 16);
    const g = parseInt(result[2], 16);
    const b = parseInt(result[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return `rgba(255, 255, 255, ${alpha})`;
}

function applyCustomThemeColors(theme: CustomTheme) {
  const root = document.documentElement;
  root.style.setProperty('--custom-accent-color', theme.accentColor);
  root.style.setProperty('--custom-accent-rgb', hexToRgb(theme.accentColor));
  root.style.setProperty('--custom-bg-primary', theme.bgPrimary);
  root.style.setProperty('--custom-bg-primary-rgb', hexToRgb(theme.bgPrimary));
  root.style.setProperty('--custom-bg-secondary', theme.bgSecondary);
  root.style.setProperty('--custom-text-primary', theme.textPrimary);
  root.style.setProperty('--custom-text-secondary', theme.textSecondary);
  root.style.setProperty('--custom-glass-bg', hexToRgba(theme.glassBg, 0.03));
  root.style.setProperty('--custom-glass-border', hexToRgba(theme.glassBorder, 0.08));
  document.body.style.backgroundColor = theme.bgPrimary;
}

function clearCustomThemeColors() {
  const root = document.documentElement;
  const props = [
    '--custom-accent-color',
    '--custom-accent-rgb',
    '--custom-bg-primary',
    '--custom-bg-primary-rgb',
    '--custom-bg-secondary',
    '--custom-text-primary',
    '--custom-text-secondary',
    '--custom-glass-bg',
    '--custom-glass-border',
  ];
  props.forEach((prop) => root.style.removeProperty(prop));
  document.body.style.backgroundColor = '';
}

// Theme Editor
const themePresets: Record<string, CustomTheme> = {
  midnight: {
    name: 'Midnight Blue',
    accentColor: '#4a9eff',
    bgPrimary: '#0d1b2a',
    bgSecondary: '#1b263b',
    textPrimary: '#e0e1dd',
    textSecondary: '#a0a4a8',
    glassBg: '#ffffff',
    glassBorder: '#4a9eff',
  },
  forest: {
    name: 'Forest Green',
    accentColor: '#2ecc71',
    bgPrimary: '#1a2f1a',
    bgSecondary: '#243524',
    textPrimary: '#e8f5e9',
    textSecondary: '#a5d6a7',
    glassBg: '#ffffff',
    glassBorder: '#2ecc71',
  },
  sunset: {
    name: 'Sunset Orange',
    accentColor: '#ff7043',
    bgPrimary: '#1f1410',
    bgSecondary: '#2d1f1a',
    textPrimary: '#fff3e0',
    textSecondary: '#ffab91',
    glassBg: '#ffffff',
    glassBorder: '#ff7043',
  },
  lavender: {
    name: 'Lavender Purple',
    accentColor: '#9c7cf4',
    bgPrimary: '#1a1625',
    bgSecondary: '#251f33',
    textPrimary: '#ede7f6',
    textSecondary: '#b39ddb',
    glassBg: '#ffffff',
    glassBorder: '#9c7cf4',
  },
  rose: {
    name: 'Rose Pink',
    accentColor: '#f48fb1',
    bgPrimary: '#1f1418',
    bgSecondary: '#2d1f24',
    textPrimary: '#fce4ec',
    textSecondary: '#f8bbd9',
    glassBg: '#ffffff',
    glassBorder: '#f48fb1',
  },
  ocean: {
    name: 'Ocean Teal',
    accentColor: '#26c6da',
    bgPrimary: '#0d1f22',
    bgSecondary: '#1a2f33',
    textPrimary: '#e0f7fa',
    textSecondary: '#80deea',
    glassBg: '#ffffff',
    glassBorder: '#26c6da',
  },
};

let tempCustomTheme: CustomTheme = {
  name: 'My Custom Theme',
  accentColor: '#0078d4',
  bgPrimary: '#1a1a1a',
  bgSecondary: '#252525',
  textPrimary: '#ffffff',
  textSecondary: '#b0b0b0',
  glassBg: '#ffffff',
  glassBorder: '#ffffff',
};

let themeEditorHasUnsavedChanges = false;

// show theme customizer modal
function showThemeEditor() {
  const modal = document.getElementById('theme-editor-modal');
  if (!modal) return;

  themeEditorHasUnsavedChanges = false;

  if (currentSettings.customTheme) {
    tempCustomTheme = { ...currentSettings.customTheme };
  }

  const inputs: Record<string, { color: string; text: string }> = {
    'theme-accent-color': { color: tempCustomTheme.accentColor, text: tempCustomTheme.accentColor },
    'theme-bg-primary': { color: tempCustomTheme.bgPrimary, text: tempCustomTheme.bgPrimary },
    'theme-bg-secondary': { color: tempCustomTheme.bgSecondary, text: tempCustomTheme.bgSecondary },
    'theme-text-primary': { color: tempCustomTheme.textPrimary, text: tempCustomTheme.textPrimary },
    'theme-text-secondary': {
      color: tempCustomTheme.textSecondary,
      text: tempCustomTheme.textSecondary,
    },
    'theme-glass-bg': { color: tempCustomTheme.glassBg, text: tempCustomTheme.glassBg },
    'theme-glass-border': { color: tempCustomTheme.glassBorder, text: tempCustomTheme.glassBorder },
  };

  for (const [id, values] of Object.entries(inputs)) {
    const colorInput = document.getElementById(id) as HTMLInputElement;
    const textInput = document.getElementById(`${id}-text`) as HTMLInputElement;
    if (colorInput) colorInput.value = values.color;
    if (textInput) textInput.value = values.text;
  }

  const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
  if (nameInput) nameInput.value = tempCustomTheme.name;

  updateThemePreview();
  modal.style.display = 'flex';
  activateModal(modal);
}

async function hideThemeEditor(skipConfirmation = false) {
  if (!skipConfirmation && themeEditorHasUnsavedChanges) {
    const confirmed = await showConfirm(
      'You have unsaved changes. Are you sure you want to close the theme editor?',
      'Unsaved Changes',
      'warning'
    );
    if (!confirmed) return;
  }
  const modal = document.getElementById('theme-editor-modal');
  if (modal) {
    modal.style.display = 'none';
    deactivateModal(modal);
  }
  themeEditorHasUnsavedChanges = false;
}

function updateThemePreview() {
  const preview = document.getElementById('theme-preview');
  if (!preview) return;

  preview.style.setProperty('--custom-accent-color', tempCustomTheme.accentColor);
  preview.style.setProperty('--custom-accent-rgb', hexToRgb(tempCustomTheme.accentColor));
  preview.style.setProperty('--custom-bg-primary', tempCustomTheme.bgPrimary);
  preview.style.setProperty('--custom-bg-secondary', tempCustomTheme.bgSecondary);
  preview.style.setProperty('--custom-text-primary', tempCustomTheme.textPrimary);
  preview.style.setProperty('--custom-text-secondary', tempCustomTheme.textSecondary);
  preview.style.setProperty('--custom-glass-bg', hexToRgba(tempCustomTheme.glassBg, 0.03));
  preview.style.setProperty('--custom-glass-border', hexToRgba(tempCustomTheme.glassBorder, 0.08));
  preview.style.backgroundColor = tempCustomTheme.bgPrimary;
}

function syncColorInputs(colorId: string, value: string) {
  const colorInput = document.getElementById(colorId) as HTMLInputElement;
  const textInput = document.getElementById(`${colorId}-text`) as HTMLInputElement;

  if (colorInput) colorInput.value = value;
  if (textInput) textInput.value = value.toUpperCase();

  const mapping: Record<string, keyof CustomTheme> = {
    'theme-accent-color': 'accentColor',
    'theme-bg-primary': 'bgPrimary',
    'theme-bg-secondary': 'bgSecondary',
    'theme-text-primary': 'textPrimary',
    'theme-text-secondary': 'textSecondary',
    'theme-glass-bg': 'glassBg',
    'theme-glass-border': 'glassBorder',
  };

  const key = mapping[colorId];
  if (key) {
    tempCustomTheme[key] = value;
    themeEditorHasUnsavedChanges = true;
  }

  updateThemePreview();
}

function applyThemePreset(presetName: string) {
  const preset = themePresets[presetName];
  if (!preset) return;

  tempCustomTheme = { ...preset };

  const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
  if (nameInput) nameInput.value = preset.name;

  syncColorInputs('theme-accent-color', preset.accentColor);
  syncColorInputs('theme-bg-primary', preset.bgPrimary);
  syncColorInputs('theme-bg-secondary', preset.bgSecondary);
  syncColorInputs('theme-text-primary', preset.textPrimary);
  syncColorInputs('theme-text-secondary', preset.textSecondary);
  syncColorInputs('theme-glass-bg', preset.glassBg);
  syncColorInputs('theme-glass-border', preset.glassBorder);
}

async function saveCustomTheme() {
  const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
  if (nameInput && nameInput.value.trim()) {
    tempCustomTheme.name = nameInput.value.trim();
  }

  currentSettings.customTheme = { ...tempCustomTheme };
  currentSettings.theme = 'custom';

  applySettings(currentSettings);

  const result = await saveSettingsWithTimestamp(currentSettings);
  if (result.success) {
    themeEditorHasUnsavedChanges = false;
    hideThemeEditor(true);
    updateCustomThemeUI();
    showToast('Custom theme saved!', 'Theme', 'success');
  } else {
    showToast('Failed to save theme: ' + result.error, 'Error', 'error');
  }
}

function setupThemeEditorListeners() {
  document.getElementById('theme-editor-close')?.addEventListener('click', () => hideThemeEditor());
  document
    .getElementById('theme-editor-cancel')
    ?.addEventListener('click', () => hideThemeEditor());
  document.getElementById('theme-editor-save')?.addEventListener('click', saveCustomTheme);

  // Color inputs
  const colorIds = [
    'theme-accent-color',
    'theme-bg-primary',
    'theme-bg-secondary',
    'theme-text-primary',
    'theme-text-secondary',
    'theme-glass-bg',
    'theme-glass-border',
  ];

  colorIds.forEach((id) => {
    const colorInput = document.getElementById(id) as HTMLInputElement;
    const textInput = document.getElementById(`${id}-text`) as HTMLInputElement;

    colorInput?.addEventListener('input', (e) => {
      const value = (e.target as HTMLInputElement).value;
      syncColorInputs(id, value);
    });

    textInput?.addEventListener('input', (e) => {
      let value = (e.target as HTMLInputElement).value.trim();
      if (!value.startsWith('#')) value = '#' + value;
      if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
        syncColorInputs(id, value);
        textInput.classList.remove('invalid');
      } else if (/^#[0-9A-Fa-f]{3}$/.test(value)) {
        const expanded = '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
        syncColorInputs(id, expanded);
        textInput.classList.remove('invalid');
      } else if (value.length > 1) {
        textInput.classList.add('invalid');
      }
    });

    textInput?.addEventListener('blur', (e) => {
      let value = (e.target as HTMLInputElement).value.trim();
      if (!value.startsWith('#')) value = '#' + value;
      if (!/^#[0-9A-Fa-f]{3}$/.test(value) && !/^#[0-9A-Fa-f]{6}$/.test(value)) {
        const colorInput = document.getElementById(id) as HTMLInputElement;
        if (colorInput && textInput) {
          textInput.value = colorInput.value.toUpperCase();
          textInput.classList.remove('invalid');
        }
      } else {
        textInput.classList.remove('invalid');
      }
    });
  });

  document.getElementById('theme-name-input')?.addEventListener('input', (e) => {
    tempCustomTheme.name = (e.target as HTMLInputElement).value || 'My Custom Theme';
    themeEditorHasUnsavedChanges = true;
  });

  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = (btn as HTMLElement).dataset.preset;
      if (preset) applyThemePreset(preset);
    });
  });

  const openThemeEditorBtn = document.getElementById('open-theme-editor-btn');
  if (openThemeEditorBtn) {
    openThemeEditorBtn.addEventListener('click', () => {
      showThemeEditor();
    });
  }

  document.getElementById('theme-editor-modal')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).classList.contains('modal-overlay')) {
      hideThemeEditor();
    }
  });
}

function updateCustomThemeUI(options?: { syncSelect?: boolean; selectedTheme?: string }) {
  const customThemeDescription = document.getElementById('custom-theme-description');
  const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
  const selectedTheme = options?.selectedTheme ?? currentSettings.theme ?? 'default';

  if (currentSettings.customTheme) {
    if (customThemeDescription) {
      const themeName = currentSettings.customTheme.name || 'Custom Theme';
      if (selectedTheme === 'custom') {
        customThemeDescription.textContent = `Currently using: ${themeName}`;
      } else {
        customThemeDescription.textContent = `Custom theme ready: ${themeName}`;
      }
    }
  } else {
    if (customThemeDescription) {
      customThemeDescription.textContent = 'Create your own color scheme';
    }
  }

  if (themeSelect && options?.syncSelect !== false) {
    themeSelect.value = currentSettings.theme || 'default';
  }
}

function startIndexStatusPolling() {
  stopIndexStatusPolling();
  indexStatusInterval = setInterval(async () => {
    await updateIndexStatus();
    const result = await window.electronAPI.getIndexStatus();
    if (result.success && result.status && !result.status.isIndexing) {
      stopIndexStatusPolling();
    }
  }, 500);
}

function stopIndexStatusPolling() {
  if (indexStatusInterval) {
    clearInterval(indexStatusInterval);
    indexStatusInterval = null;
  }
}

async function updateIndexStatus() {
  const indexStatus = document.getElementById('index-status');
  if (!indexStatus) return;

  try {
    const result = await window.electronAPI.getIndexStatus();
    if (result.success && result.status) {
      const status = result.status;
      if (status.isIndexing) {
        indexStatus.textContent = `Status: Indexing... (${status.indexedFiles.toLocaleString()} files found)`;
        if (!indexStatusInterval) {
          startIndexStatusPolling();
        }
      } else if (status.lastIndexTime) {
        const date = new Date(status.lastIndexTime);
        indexStatus.textContent = `Status: ${status.indexedFiles.toLocaleString()} files indexed on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`;
      } else {
        indexStatus.textContent = 'Status: Not indexed yet';
      }
    } else {
      indexStatus.textContent = 'Status: Unknown';
    }
  } catch (error) {
    console.error('Failed to get index status:', error);
    indexStatus.textContent = 'Status: Error';
  }
}

async function rebuildIndex() {
  const rebuildBtn = document.getElementById('rebuild-index-btn') as HTMLButtonElement;
  if (!rebuildBtn) return;

  const originalHTML = rebuildBtn.innerHTML;
  rebuildBtn.disabled = true;
  rebuildBtn.innerHTML = `${twemojiImg(String.fromCodePoint(0x23f3), 'twemoji')} Rebuilding...`;

  try {
    const result = await window.electronAPI.rebuildIndex();
    if (result.success) {
      showToast('Index rebuild started', 'File Indexer', 'success');
      setTimeout(async () => {
        await updateIndexStatus();
      }, 300);
    } else {
      showToast('Failed to rebuild index: ' + result.error, 'Error', 'error');
    }
  } catch {
    showToast('Error rebuilding index', 'Error', 'error');
  } finally {
    rebuildBtn.disabled = false;
    rebuildBtn.innerHTML = originalHTML;
  }
}

function updateDangerousOptionsVisibility(show: boolean) {
  const dangerousOptions = document.querySelectorAll('.dangerous-option');
  dangerousOptions.forEach((option) => {
    (option as HTMLElement).style.display = show ? 'flex' : 'none';
  });
}

function showShortcutsModal() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  const shortcutsModal = document.getElementById('shortcuts-modal');
  if (shortcutsModal) {
    shortcutsModal.style.display = 'flex';
    activateModal(shortcutsModal);
    renderShortcutsModal();
  }
}

function hideShortcutsModal() {
  stopShortcutCapture();
  const shortcutsModal = document.getElementById('shortcuts-modal');
  if (shortcutsModal) {
    shortcutsModal.style.display = 'none';
    deactivateModal(shortcutsModal);
  }
}

const FOLDER_ICON_OPTIONS = [
  0x1f4c1, 0x1f4c2, 0x1f4c1, 0x1f5c2, 0x1f5c3, 0x1f4bc, 0x2b50, 0x1f31f, 0x2764, 0x1f499, 0x1f49a,
  0x1f49b, 0x1f4a1, 0x1f3ae, 0x1f3b5, 0x1f3ac, 0x1f4f7, 0x1f4f9, 0x1f4da, 0x1f4d6, 0x1f4dd, 0x270f,
  0x1f4bb, 0x1f5a5, 0x1f3e0, 0x1f3e2, 0x1f6e0, 0x2699, 0x1f512, 0x1f513, 0x1f4e6, 0x1f4e5, 0x1f4e4,
  0x1f5d1, 0x2601, 0x1f310, 0x1f680, 0x2708, 0x1f697, 0x1f6b2, 0x26bd, 0x1f3c0, 0x1f352, 0x1f34e,
  0x1f33f, 0x1f333, 0x1f308, 0x2600,
];

let folderIconPickerPath: string | null = null;

function showFolderIconPicker(folderPath: string) {
  const modal = document.getElementById('folder-icon-modal');
  const pathDisplay = document.getElementById('folder-icon-path');
  const grid = document.getElementById('folder-icon-grid');

  if (!modal || !pathDisplay || !grid) return;

  folderIconPickerPath = folderPath;

  const folderName = folderPath.split(/[/\\]/).pop() || folderPath;
  pathDisplay.textContent = folderName;

  const currentIcon = currentSettings.folderIcons?.[folderPath];

  grid.innerHTML = FOLDER_ICON_OPTIONS.map((code) => {
    const emoji = String.fromCodePoint(code);
    const isSelected = currentIcon === emoji;
    return `
      <div class="folder-icon-option${isSelected ? ' selected' : ''}" data-icon="${emoji}">
        ${twemojiImg(emoji, 'twemoji')}
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.folder-icon-option').forEach((option) => {
    option.addEventListener('click', () => {
      const icon = (option as HTMLElement).dataset.icon;
      if (icon && folderIconPickerPath) {
        setFolderIcon(folderIconPickerPath, icon);
        hideFolderIconPicker();
      }
    });
  });

  modal.style.display = 'flex';
  activateModal(modal);
}

function hideFolderIconPicker() {
  const modal = document.getElementById('folder-icon-modal');
  if (modal) {
    modal.style.display = 'none';
    deactivateModal(modal);
  }
  folderIconPickerPath = null;
}

async function setFolderIcon(folderPath: string, icon: string) {
  if (!currentSettings.folderIcons) {
    currentSettings.folderIcons = {};
  }
  currentSettings.folderIcons[folderPath] = icon;
  await saveSettings();
  if (currentPath) navigateTo(currentPath);
  showToast('Folder icon updated', 'Success', 'success');
}

async function resetFolderIcon() {
  if (
    folderIconPickerPath &&
    currentSettings.folderIcons &&
    currentSettings.folderIcons[folderIconPickerPath]
  ) {
    delete currentSettings.folderIcons[folderIconPickerPath];
    await saveSettings();
    if (currentPath) navigateTo(currentPath);
    showToast('Folder icon reset to default', 'Success', 'success');
  }
  hideFolderIconPicker();
}

function getFolderIcon(folderPath: string): string {
  const customIcon = currentSettings.folderIcons?.[folderPath];
  if (customIcon) {
    return twemojiImg(customIcon, 'twemoji file-icon');
  }
  return FOLDER_ICON;
}

function openNewWindow() {
  void (async () => {
    if (tabsEnabled) {
      try {
        await saveTabState(true);
      } catch (error) {
        console.error('[Tabs] Failed to persist tab state before opening new window:', error);
      }
    }
    await window.electronAPI.openNewWindow();
  })().catch((error) => {
    console.error('[Window] Failed to open new window:', error);
  });
}

async function saveSettings() {
  const previousTabsEnabled = tabsEnabled;
  const systemThemeToggle = document.getElementById('system-theme-toggle') as HTMLInputElement;
  const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
  const sortBySelect = document.getElementById('sort-by-select') as HTMLSelectElement;
  const sortOrderSelect = document.getElementById('sort-order-select') as HTMLSelectElement;
  const showHiddenFilesToggle = document.getElementById(
    'show-hidden-files-toggle'
  ) as HTMLInputElement;
  const enableGitStatusToggle = document.getElementById(
    'enable-git-status-toggle'
  ) as HTMLInputElement;
  const gitIncludeUntrackedToggle = document.getElementById(
    'git-include-untracked-toggle'
  ) as HTMLInputElement;
  const showFileHoverCardToggle = document.getElementById(
    'show-file-hover-card-toggle'
  ) as HTMLInputElement;
  const showFileCheckboxesToggle = document.getElementById(
    'show-file-checkboxes-toggle'
  ) as HTMLInputElement;
  const minimizeToTrayToggle = document.getElementById(
    'minimize-to-tray-toggle'
  ) as HTMLInputElement;
  const startOnLoginToggle = document.getElementById('start-on-login-toggle') as HTMLInputElement;
  const autoCheckUpdatesToggle = document.getElementById(
    'auto-check-updates-toggle'
  ) as HTMLInputElement;
  const updateChannelSelect = document.getElementById('update-channel-select') as HTMLSelectElement;
  const enableSearchHistoryToggle = document.getElementById(
    'enable-search-history-toggle'
  ) as HTMLInputElement;
  const dangerousOptionsToggle = document.getElementById(
    'dangerous-options-toggle'
  ) as HTMLInputElement;
  const startupPathInput = document.getElementById('startup-path-input') as HTMLInputElement;
  const enableIndexerToggle = document.getElementById('enable-indexer-toggle') as HTMLInputElement;
  const showRecentFilesToggle = document.getElementById(
    'show-recent-files-toggle'
  ) as HTMLInputElement;
  const showFolderTreeToggle = document.getElementById(
    'show-folder-tree-toggle'
  ) as HTMLInputElement;
  const enableTabsToggle = document.getElementById('enable-tabs-toggle') as HTMLInputElement;
  const globalContentSearchToggle = document.getElementById(
    'global-content-search-toggle'
  ) as HTMLInputElement;
  const globalClipboardToggle = document.getElementById(
    'global-clipboard-toggle'
  ) as HTMLInputElement;
  const enableSyntaxHighlightingToggle = document.getElementById(
    'enable-syntax-highlighting-toggle'
  ) as HTMLInputElement;
  const reduceMotionToggle = document.getElementById('reduce-motion-toggle') as HTMLInputElement;
  const highContrastToggle = document.getElementById('high-contrast-toggle') as HTMLInputElement;
  const largeTextToggle = document.getElementById('large-text-toggle') as HTMLInputElement;
  const useSystemFontSizeToggle = document.getElementById(
    'use-system-font-size-toggle'
  ) as HTMLInputElement;
  const uiDensitySelect = document.getElementById('ui-density-select') as HTMLSelectElement;
  const boldTextToggle = document.getElementById('bold-text-toggle') as HTMLInputElement;
  const visibleFocusToggle = document.getElementById('visible-focus-toggle') as HTMLInputElement;
  const reduceTransparencyToggle = document.getElementById(
    'reduce-transparency-toggle'
  ) as HTMLInputElement;
  const liquidGlassToggle = document.getElementById('liquid-glass-toggle') as HTMLInputElement;
  const themedIconsToggle = document.getElementById('themed-icons-toggle') as HTMLInputElement;
  const disableHwAccelToggle = document.getElementById(
    'disable-hw-accel-toggle'
  ) as HTMLInputElement;
  const confirmFileOperationsToggle = document.getElementById(
    'confirm-file-operations-toggle'
  ) as HTMLInputElement;
  const fileConflictBehaviorSelect = document.getElementById(
    'file-conflict-behavior-select'
  ) as HTMLSelectElement;
  const maxThumbnailSizeInput = document.getElementById(
    'max-thumbnail-size-input'
  ) as HTMLInputElement;
  const thumbnailQualitySelect = document.getElementById(
    'thumbnail-quality-select'
  ) as HTMLSelectElement;
  const autoPlayVideosToggle = document.getElementById(
    'auto-play-videos-toggle'
  ) as HTMLInputElement;
  const previewPanelPositionSelect = document.getElementById(
    'preview-panel-position-select'
  ) as HTMLSelectElement;
  const maxPreviewSizeInput = document.getElementById('max-preview-size-input') as HTMLInputElement;
  const gridColumnsSelect = document.getElementById('grid-columns-select') as HTMLSelectElement;
  const iconSizeSlider = document.getElementById('icon-size-slider') as HTMLInputElement;
  const compactFileInfoToggle = document.getElementById(
    'compact-file-info-toggle'
  ) as HTMLInputElement;
  const showFileExtensionsToggle = document.getElementById(
    'show-file-extensions-toggle'
  ) as HTMLInputElement;
  const maxSearchHistoryInput = document.getElementById(
    'max-search-history-input'
  ) as HTMLInputElement;
  const maxDirectoryHistoryInput = document.getElementById(
    'max-directory-history-input'
  ) as HTMLInputElement;

  if (systemThemeToggle) {
    currentSettings.useSystemTheme = systemThemeToggle.checked;
  }
  if (enableSyntaxHighlightingToggle) {
    currentSettings.enableSyntaxHighlighting = enableSyntaxHighlightingToggle.checked;
  }

  if (themeSelect) {
    const selectedTheme = themeSelect.value;
    if (isOneOf(selectedTheme, THEME_VALUES)) {
      currentSettings.theme = selectedTheme;
    }
  }

  if (currentSettings.useSystemTheme) {
    try {
      const { isDarkMode } = await window.electronAPI.getSystemAccentColor();
      const systemTheme = isDarkMode ? 'default' : 'light';
      currentSettings.theme = systemTheme;
    } catch (error) {
      console.error('[Settings] Failed to apply system theme:', error);
    }
  }

  if (sortBySelect) {
    const sortByValue = sortBySelect.value;
    if (isOneOf(sortByValue, SORT_BY_VALUES)) {
      currentSettings.sortBy = sortByValue;
    }
  }

  if (sortOrderSelect) {
    const sortOrderValue = sortOrderSelect.value;
    if (isOneOf(sortOrderValue, SORT_ORDER_VALUES)) {
      currentSettings.sortOrder = sortOrderValue;
    }
  }

  if (showHiddenFilesToggle) {
    currentSettings.showHiddenFiles = showHiddenFilesToggle.checked;
  }
  if (enableGitStatusToggle) {
    currentSettings.enableGitStatus = enableGitStatusToggle.checked;
  }
  if (gitIncludeUntrackedToggle) {
    currentSettings.gitIncludeUntracked = gitIncludeUntrackedToggle.checked;
  }

  if (showFileHoverCardToggle) {
    currentSettings.showFileHoverCard = showFileHoverCardToggle.checked;
  }

  if (showFileCheckboxesToggle) {
    currentSettings.showFileCheckboxes = showFileCheckboxesToggle.checked;
  }

  if (minimizeToTrayToggle) {
    currentSettings.minimizeToTray = minimizeToTrayToggle.checked;
  }

  if (startOnLoginToggle) {
    currentSettings.startOnLogin = startOnLoginToggle.checked;
  }

  if (autoCheckUpdatesToggle) {
    currentSettings.autoCheckUpdates = autoCheckUpdatesToggle.checked;
  }

  if (updateChannelSelect) {
    const channelValue = updateChannelSelect.value;
    if (isOneOf(channelValue, UPDATE_CHANNEL_VALUES)) {
      currentSettings.updateChannel = channelValue;
    }
  }

  if (enableSearchHistoryToggle) {
    currentSettings.enableSearchHistory = enableSearchHistoryToggle.checked;
  }

  if (dangerousOptionsToggle) {
    currentSettings.showDangerousOptions = dangerousOptionsToggle.checked;
    updateDangerousOptionsVisibility(currentSettings.showDangerousOptions);
  }

  if (startupPathInput) {
    currentSettings.startupPath = startupPathInput.value;
  }

  if (enableIndexerToggle) {
    currentSettings.enableIndexer = enableIndexerToggle.checked;
  }

  if (showRecentFilesToggle) {
    currentSettings.showRecentFiles = showRecentFilesToggle.checked;
  }

  if (showFolderTreeToggle) {
    currentSettings.showFolderTree = showFolderTreeToggle.checked;
  }

  if (enableTabsToggle) {
    currentSettings.enableTabs = enableTabsToggle.checked;
  }

  if (globalContentSearchToggle) {
    currentSettings.globalContentSearch = globalContentSearchToggle.checked;
  }

  if (globalClipboardToggle) {
    currentSettings.globalClipboard = globalClipboardToggle.checked;
  }

  if (reduceMotionToggle) {
    currentSettings.reduceMotion = reduceMotionToggle.checked;
  }

  if (highContrastToggle) {
    currentSettings.highContrast = highContrastToggle.checked;
  }

  if (largeTextToggle) {
    currentSettings.largeText = largeTextToggle.checked;
  }

  if (useSystemFontSizeToggle) {
    currentSettings.useSystemFontSize = useSystemFontSizeToggle.checked;
  }

  if (uiDensitySelect) {
    const densityValue = uiDensitySelect.value;
    if (densityValue === 'default' || densityValue === 'compact' || densityValue === 'larger') {
      currentSettings.uiDensity = densityValue;
    }
  }

  if (boldTextToggle) {
    currentSettings.boldText = boldTextToggle.checked;
  }

  if (visibleFocusToggle) {
    currentSettings.visibleFocus = visibleFocusToggle.checked;
  }

  if (reduceTransparencyToggle) {
    currentSettings.reduceTransparency = reduceTransparencyToggle.checked;
  }

  if (liquidGlassToggle) {
    currentSettings.liquidGlassMode = liquidGlassToggle.checked;
  }

  if (themedIconsToggle) {
    currentSettings.themedIcons = themedIconsToggle.checked;
  }

  if (disableHwAccelToggle) {
    currentSettings.disableHardwareAcceleration = disableHwAccelToggle.checked;
  }

  if (confirmFileOperationsToggle) {
    currentSettings.confirmFileOperations = confirmFileOperationsToggle.checked;
  }

  if (fileConflictBehaviorSelect) {
    const conflictValue = fileConflictBehaviorSelect.value;
    if (isOneOf(conflictValue, FILE_CONFLICT_VALUES)) {
      currentSettings.fileConflictBehavior = conflictValue;
    }
  }

  if (maxThumbnailSizeInput) {
    const val = parseInt(maxThumbnailSizeInput.value, 10);
    if (val >= 1 && val <= 100) {
      currentSettings.maxThumbnailSizeMB = val;
    }
  }

  if (thumbnailQualitySelect) {
    const qualityValue = thumbnailQualitySelect.value;
    if (isOneOf(qualityValue, THUMBNAIL_QUALITY_VALUES)) {
      currentSettings.thumbnailQuality = qualityValue;
    }
  }

  if (autoPlayVideosToggle) {
    currentSettings.autoPlayVideos = autoPlayVideosToggle.checked;
  }

  if (previewPanelPositionSelect) {
    const positionValue = previewPanelPositionSelect.value;
    if (isOneOf(positionValue, PREVIEW_POSITION_VALUES)) {
      currentSettings.previewPanelPosition = positionValue;
    }
  }

  if (maxPreviewSizeInput) {
    const val = parseInt(maxPreviewSizeInput.value, 10);
    if (val >= 1 && val <= 500) {
      currentSettings.maxPreviewSizeMB = val;
    }
  }

  if (gridColumnsSelect) {
    const gridValue = gridColumnsSelect.value;
    if (isOneOf(gridValue, GRID_COLUMNS_VALUES)) {
      currentSettings.gridColumns = gridValue;
    }
  }

  if (iconSizeSlider) {
    currentSettings.iconSize = parseInt(iconSizeSlider.value, 10);
  }

  if (compactFileInfoToggle) {
    currentSettings.compactFileInfo = compactFileInfoToggle.checked;
  }

  if (showFileExtensionsToggle) {
    currentSettings.showFileExtensions = showFileExtensionsToggle.checked;
  }

  if (maxSearchHistoryInput) {
    const val = parseInt(maxSearchHistoryInput.value, 10);
    if (val >= 1 && val <= 20) {
      currentSettings.maxSearchHistoryItems = val;
    }
  }
  if (maxDirectoryHistoryInput) {
    const val = parseInt(maxDirectoryHistoryInput.value, 10);
    if (val >= 1 && val <= 20) {
      currentSettings.maxDirectoryHistoryItems = val;
    }
  }
  if (Array.isArray(currentSettings.searchHistory)) {
    const maxSearchHistoryItems = Math.max(
      1,
      Math.min(20, currentSettings.maxSearchHistoryItems || SEARCH_HISTORY_MAX)
    );
    currentSettings.searchHistory = currentSettings.searchHistory.slice(0, maxSearchHistoryItems);
  }
  if (Array.isArray(currentSettings.directoryHistory)) {
    const maxDirectoryHistoryItems = Math.max(
      1,
      Math.min(20, currentSettings.maxDirectoryHistoryItems || DIRECTORY_HISTORY_MAX)
    );
    currentSettings.directoryHistory = currentSettings.directoryHistory.slice(
      0,
      maxDirectoryHistoryItems
    );
  }

  currentSettings.viewMode = viewMode;

  const result = await saveSettingsWithTimestamp(currentSettings);
  if (result.success) {
    if (previousTabsEnabled !== currentSettings.enableTabs) {
      initializeTabs();
    }
    applySettings(currentSettings);
    clearSettingsChanged();
    hideSettingsModal();
    showToast('Settings saved successfully!', 'Settings', 'success');
    if (currentPath) {
      refresh();
    }
  } else {
    showToast('Failed to save settings: ' + result.error, 'Error', 'error');
  }
}

async function resetSettings() {
  const confirmed = await showConfirm(
    'Are you sure you want to reset all settings (including Home view) to default? The app will restart. This cannot be undone.',
    'Reset Settings',
    'warning'
  );

  if (confirmed) {
    isResettingSettings = true;
    if (settingsSaveTimeout) {
      clearTimeout(settingsSaveTimeout);
      settingsSaveTimeout = null;
    }
    const [settingsResult, homeResult] = await Promise.all([
      window.electronAPI.resetSettings(),
      window.electronAPI.resetHomeSettings(),
    ]);
    if (settingsResult.success && homeResult.success) {
      await window.electronAPI.relaunchApp();
    } else {
      isResettingSettings = false;
      const errors: string[] = [];
      if (!settingsResult.success) {
        errors.push(settingsResult.error || 'Failed to reset settings');
      }
      if (!homeResult.success) {
        errors.push(homeResult.error || 'Failed to reset Home settings');
      }
      showToast(`Failed to reset settings: ${errors.join(' | ')}`, 'Error', 'error');
    }
  }
}

function renderSidebarQuickAccess() {
  const grid = document.getElementById('sidebar-quick-access-grid');
  if (!grid) return;

  grid.innerHTML = '';

  const visibleItems = homeController.getVisibleSidebarQuickAccessItems();
  const itemsByAction = new Map(HOME_QUICK_ACCESS_ITEMS.map((item) => [item.action, item]));

  visibleItems.forEach((item) => {
    const itemData = itemsByAction.get(item.action);
    if (!itemData) return;

    const div = document.createElement('div');
    div.className = 'nav-item quick-action';
    div.dataset.action = item.action;
    div.setAttribute('role', 'button');
    div.tabIndex = 0;
    div.setAttribute('aria-label', `Navigate to ${item.label}`);

    const icon = twemojiImg(String.fromCodePoint(item.icon), 'twemoji');
    div.innerHTML = `
      <span class="nav-icon" aria-hidden="true">${icon}</span>
      <span class="nav-label">${escapeHtml(item.label)}</span>
    `;

    div.addEventListener('click', () => handleQuickAction(item.action));
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleQuickAction(item.action);
      }
    });

    grid.appendChild(div);
  });
}

function loadBookmarks() {
  if (!bookmarksList) return;
  bookmarksList.innerHTML = '';

  if (!currentSettings.bookmarks || currentSettings.bookmarks.length === 0) {
    bookmarksList.innerHTML = '<div class="sidebar-empty">No bookmarks yet</div>';
    homeController.renderHomeBookmarks();
    return;
  }

  currentSettings.bookmarks.forEach((bookmarkPath) => {
    const bookmarkItem = document.createElement('div');
    bookmarkItem.className = 'bookmark-item';
    bookmarkItem.dataset.path = bookmarkPath;
    const pathParts = bookmarkPath.split(/[/\\]/);
    const name = pathParts[pathParts.length - 1] || bookmarkPath;
    bookmarkItem.setAttribute('role', 'button');
    bookmarkItem.tabIndex = 0;
    bookmarkItem.setAttribute('aria-label', `Open bookmark ${name}`);

    bookmarkItem.innerHTML = `
      <span class="bookmark-icon">${twemojiImg(String.fromCodePoint(0x2b50), 'twemoji')}</span>
      <span class="bookmark-label">${escapeHtml(name)}</span>
      <button class="bookmark-remove" type="button" title="Remove bookmark" aria-label="Remove bookmark">${twemojiImg(String.fromCodePoint(0x274c), 'twemoji')}</button>
    `;

    bookmarkItem.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).classList.contains('bookmark-remove')) {
        navigateTo(bookmarkPath);
      }
    });

    bookmarkItem.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navigateTo(bookmarkPath);
      }
    });

    const removeBtn = bookmarkItem.querySelector('.bookmark-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeBookmark(bookmarkPath);
      });
    }

    bookmarkItem.draggable = true;
    bookmarkItem.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      bookmarkItem.classList.add('dragging');
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/iyeris-bookmark', bookmarkPath);
    });

    bookmarkItem.addEventListener('dragend', () => {
      bookmarkItem.classList.remove('dragging');
      bookmarkItem.classList.remove('drag-over');
      hideDropIndicator();
    });

    bookmarkItem.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.dataTransfer) return;
      const isBookmarkDrag = e.dataTransfer.types.includes('text/iyeris-bookmark');
      const operation = getDragOperation(e);
      e.dataTransfer.dropEffect = isBookmarkDrag ? 'move' : operation;
      bookmarkItem.classList.add('drag-over');
      if (!isBookmarkDrag) {
        showDropIndicator(operation, bookmarkPath, e.clientX, e.clientY);
      }
    });

    bookmarkItem.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = bookmarkItem.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX >= rect.right ||
        e.clientY < rect.top ||
        e.clientY >= rect.bottom
      ) {
        bookmarkItem.classList.remove('drag-over');
        hideDropIndicator();
      }
    });

    bookmarkItem.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      bookmarkItem.classList.remove('drag-over');

      if (e.dataTransfer?.types.includes('text/iyeris-bookmark')) {
        const draggedPath = e.dataTransfer.getData('text/iyeris-bookmark');
        if (!draggedPath || draggedPath === bookmarkPath) return;
        if (!currentSettings.bookmarks) return;
        const fromIndex = currentSettings.bookmarks.indexOf(draggedPath);
        const toIndex = currentSettings.bookmarks.indexOf(bookmarkPath);
        if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;
        const updated = [...currentSettings.bookmarks];
        updated.splice(fromIndex, 1);
        updated.splice(toIndex, 0, draggedPath);
        currentSettings.bookmarks = updated;
        const saveResult = await saveSettingsWithTimestamp(currentSettings);
        if (saveResult.success) {
          loadBookmarks();
        } else {
          showToast('Failed to reorder bookmarks', 'Bookmarks', 'error');
        }
        hideDropIndicator();
        return;
      }

      const draggedPaths = await getDraggedPaths(e);
      if (draggedPaths.length === 0) return;
      const operation = getDragOperation(e);
      await handleDrop(draggedPaths, bookmarkPath, operation);
      hideDropIndicator();
    });

    bookmarksList.appendChild(bookmarkItem);
  });

  if (!bookmarksDropReady && bookmarksList) {
    bookmarksList.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return;
      if (e.dataTransfer.types.includes('text/iyeris-bookmark')) return;
      e.preventDefault();
      e.stopPropagation();
      bookmarksList.classList.add('drag-over');
      e.dataTransfer.dropEffect = 'copy';
      showDropIndicator('add', 'Bookmarks', e.clientX, e.clientY);
    });

    bookmarksList.addEventListener('dragleave', (e) => {
      const rect = bookmarksList.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX >= rect.right ||
        e.clientY < rect.top ||
        e.clientY >= rect.bottom
      ) {
        bookmarksList.classList.remove('drag-over');
        hideDropIndicator();
      }
    });

    bookmarksList.addEventListener('drop', async (e) => {
      if (!e.dataTransfer) return;
      if (e.dataTransfer.types.includes('text/iyeris-bookmark')) {
        hideDropIndicator();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      bookmarksList.classList.remove('drag-over');
      hideDropIndicator();

      const draggedPaths = await getDraggedPaths(e);
      if (draggedPaths.length === 0) return;
      const targetPath = draggedPaths[0];
      try {
        const propsResult = await window.electronAPI.getItemProperties(targetPath);
        if (propsResult.success && propsResult.properties?.isDirectory) {
          await addBookmarkByPath(targetPath);
        } else {
          showToast('Only folders can be bookmarked', 'Bookmarks', 'info');
        }
      } catch {
        showToast('Failed to add bookmark', 'Bookmarks', 'error');
      }
    });

    bookmarksDropReady = true;
  }

  homeController.renderHomeBookmarks();
}

function setHomeViewActive(active: boolean): void {
  if (!homeView) return;
  homeView.style.display = active ? 'flex' : 'none';

  if (active) {
    cancelDirectoryRequest();
    cancelColumnOperations();
    hideLoading();
    if (fileGrid) fileGrid.style.display = 'none';
    if (columnView) columnView.style.display = 'none';
    if (listHeader) listHeader.style.display = 'none';
    if (emptyState) emptyState.style.display = 'none';
    resetVirtualizedRender();
    allFiles = [];
    filePathMap.clear();
    selectedItems.clear();
    updateStatusBar();
    const statusDiskSpace = document.getElementById('status-disk-space');
    if (statusDiskSpace) statusDiskSpace.textContent = '';
    const statusGitBranch = document.getElementById('status-git-branch');
    if (statusGitBranch) statusGitBranch.style.display = 'none';
    homeController.renderHomeView();
  } else {
    if (viewMode === 'column') {
      if (fileGrid) fileGrid.style.display = 'none';
      if (columnView) columnView.style.display = 'flex';
    } else {
      if (columnView) columnView.style.display = 'none';
      if (fileGrid) {
        fileGrid.style.display = '';
        fileGrid.className = viewMode === 'list' ? 'file-grid list-view' : 'file-grid';
      }
    }
    if (listHeader) {
      listHeader.style.display = viewMode === 'list' ? 'grid' : 'none';
    }
  }

  const disableFileActions = active;
  if (newFileBtn) newFileBtn.disabled = disableFileActions;
  if (newFolderBtn) newFolderBtn.disabled = disableFileActions;
  if (sortBtn) sortBtn.disabled = disableFileActions;
  if (viewToggleBtn) viewToggleBtn.disabled = disableFileActions;
  if (viewOptions) {
    viewOptions
      .querySelectorAll('button')
      .forEach((button) => ((button as HTMLButtonElement).disabled = disableFileActions));
  }
}

async function handleQuickAction(action?: string | null): Promise<void> {
  if (!action) return;

  if (action === 'home') {
    navigateTo(HOME_VIEW_PATH);
    return;
  }

  if (action === 'userhome') {
    const homePath = await window.electronAPI.getHomeDirectory();
    if (homePath) {
      navigateTo(homePath);
    } else {
      showToast('Failed to open Home Folder', 'Quick Access', 'error');
    }
    return;
  }

  const specialAction = SPECIAL_DIRECTORY_ACTIONS[action];
  if (specialAction) {
    const result = await window.electronAPI.getSpecialDirectory(specialAction.key);
    if (result.success && result.path) {
      navigateTo(result.path);
    } else {
      showToast(
        result.error || `Failed to open ${specialAction.label} folder`,
        'Quick Access',
        'error'
      );
    }
    return;
  }

  if (action === 'browse') {
    const result = await window.electronAPI.selectFolder();
    if (result.success && result.path) {
      navigateTo(result.path);
    }
    return;
  }

  if (action === 'trash') {
    const result = await window.electronAPI.openTrash();
    if (result.success) {
      showToast('Opening system trash folder', 'Info', 'info');
    } else {
      showToast('Failed to open trash folder', 'Error', 'error');
    }
  }
}

async function addBookmark() {
  if (!currentPath || isHomeViewPath(currentPath)) {
    showToast('Open a folder to add a bookmark', 'Bookmarks', 'info');
    return;
  }
  await addBookmarkByPath(currentPath);
}

async function addBookmarkByPath(path: string) {
  if (!currentSettings.bookmarks) {
    currentSettings.bookmarks = [];
  }

  if (currentSettings.bookmarks.includes(path)) {
    showToast('This folder is already bookmarked', 'Bookmarks', 'info');
    return;
  }

  currentSettings.bookmarks.push(path);
  const result = await saveSettingsWithTimestamp(currentSettings);

  if (result.success) {
    loadBookmarks();
    showToast('Bookmark added', 'Bookmarks', 'success');
  } else {
    showToast('Failed to add bookmark', 'Error', 'error');
  }
}

async function removeBookmark(path: string) {
  if (!currentSettings.bookmarks) return;

  currentSettings.bookmarks = currentSettings.bookmarks.filter((b) => b !== path);
  const result = await saveSettingsWithTimestamp(currentSettings);

  if (result.success) {
    loadBookmarks();
    showToast('Bookmark removed', 'Bookmarks', 'success');
  } else {
    showToast('Failed to remove bookmark', 'Error', 'error');
  }
}

const MAX_RECENT_FILES = 10;

function loadRecentFiles() {
  const recentList = document.getElementById('recent-list');
  const recentSection = document.getElementById('recent-section');
  if (!recentList || !recentSection) return;

  recentList.innerHTML = '';

  if (currentSettings.showRecentFiles === false) {
    recentSection.style.display = 'none';
    return;
  }

  if (!currentSettings.recentFiles || currentSettings.recentFiles.length === 0) {
    recentSection.style.display = 'block';
    recentList.innerHTML = '<div class="sidebar-empty">No recent files yet</div>';
    return;
  }

  recentSection.style.display = 'block';

  currentSettings.recentFiles.forEach((filePath) => {
    const recentItem = document.createElement('div');
    recentItem.className = 'nav-item recent-item';
    const pathParts = filePath.split(/[/\\]/);
    const name = pathParts[pathParts.length - 1] || filePath;
    const icon = getFileIcon(name);

    recentItem.innerHTML = `
      <span class="nav-icon">${icon}</span>
      <span class="nav-label" title="${escapeHtml(filePath)}">${escapeHtml(name)}</span>
    `;

    recentItem.addEventListener('click', () => {
      void openPathWithArchivePrompt(filePath, name, false);
    });

    recentList.appendChild(recentItem);
  });
}

async function addToRecentFiles(filePath: string) {
  if (!filePath || filePath.startsWith('http://') || filePath.startsWith('https://')) return;

  if (!currentSettings.recentFiles) {
    currentSettings.recentFiles = [];
  }

  currentSettings.recentFiles = currentSettings.recentFiles.filter((f) => f !== filePath);
  currentSettings.recentFiles.unshift(filePath);
  currentSettings.recentFiles = currentSettings.recentFiles.slice(0, MAX_RECENT_FILES);

  debouncedSaveSettings();
  loadRecentFiles();
  homeController.renderHomeRecents();
}

async function updateClipboardIndicator() {
  const indicator = document.getElementById('clipboard-indicator');
  const indicatorText = document.getElementById('clipboard-text');
  if (!indicator || !indicatorText) return;

  if (clipboard && clipboard.paths.length > 0) {
    const count = clipboard.paths.length;
    const operation = clipboard.operation === 'cut' ? 'cut' : 'copied';
    indicatorText.textContent = `${count} ${operation}`;
    indicator.classList.toggle('cut-mode', clipboard.operation === 'cut');
    indicator.style.display = 'inline-flex';
  } else {
    // check system clipboard
    if (currentSettings.globalClipboard !== false) {
      const systemFiles = await window.electronAPI.getSystemClipboardFiles();
      if (systemFiles && systemFiles.length > 0) {
        indicatorText.textContent = `${systemFiles.length} from system`;
        indicator.classList.remove('cut-mode');
        indicator.style.display = 'inline-flex';
        return;
      }
    }
    indicator.style.display = 'none';
  }
}

function copyToClipboard() {
  if (selectedItems.size === 0) return;
  clipboard = {
    operation: 'copy',
    paths: Array.from(selectedItems),
  };
  window.electronAPI.setClipboard(clipboard);
  updateCutVisuals();
  updateClipboardIndicator();
  showToast(`${selectedItems.size} item(s) copied`, 'Clipboard', 'success');
}

function cutToClipboard() {
  if (selectedItems.size === 0) return;
  clipboard = {
    operation: 'cut',
    paths: Array.from(selectedItems),
  };
  window.electronAPI.setClipboard(clipboard);
  updateCutVisuals();
  updateClipboardIndicator();
  showToast(`${selectedItems.size} item(s) cut`, 'Clipboard', 'success');
}

async function moveSelectedToFolder(): Promise<void> {
  if (selectedItems.size === 0) return;
  const result = await window.electronAPI.selectFolder();
  if (!result.success || !result.path) return;

  const destPath = result.path;
  const sourcePaths = Array.from(selectedItems);
  const alreadyInDest = sourcePaths.some((sourcePath) => {
    const parentDir = path.dirname(sourcePath);
    return parentDir === destPath || sourcePath === destPath;
  });

  if (alreadyInDest) {
    showToast('Items are already in this directory', 'Info', 'info');
    return;
  }

  await handleDrop(sourcePaths, destPath, 'move');
}

async function pasteFromClipboard() {
  if (!currentPath) return;

  // fallback to system clipboard
  if (!clipboard || clipboard.paths.length === 0) {
    if (currentSettings.globalClipboard !== false) {
      const systemFiles = await window.electronAPI.getSystemClipboardFiles();
      if (systemFiles && systemFiles.length > 0) {
        const result = await window.electronAPI.copyItems(
          systemFiles,
          currentPath,
          currentSettings.fileConflictBehavior || 'ask'
        );
        if (result.success) {
          showToast(
            `${systemFiles.length} item(s) pasted from system clipboard`,
            'Success',
            'success'
          );
          refresh();
        } else {
          showToast(result.error || 'Paste failed', 'Error', 'error');
        }
        return;
      }
    }
    return;
  }

  const isCopy = clipboard.operation === 'copy';
  const conflictBehavior = currentSettings.fileConflictBehavior || 'ask';
  const result = isCopy
    ? await window.electronAPI.copyItems(clipboard.paths, currentPath, conflictBehavior)
    : await window.electronAPI.moveItems(clipboard.paths, currentPath, conflictBehavior);

  if (result.success) {
    showToast(
      `${clipboard.paths.length} item(s) ${isCopy ? 'copied' : 'moved'}`,
      'Success',
      'success'
    );

    if (!isCopy) {
      await updateUndoRedoState();
      clipboard = null;
      window.electronAPI.setClipboard(null);
      updateClipboardIndicator();
    }

    updateCutVisuals();
    refresh();
  } else {
    showToast(result.error || 'Operation failed', 'Error', 'error');
  }
}

function updateCutVisuals() {
  const nextCutPaths = new Set(clipboard && clipboard.operation === 'cut' ? clipboard.paths : []);

  for (const itemPath of cutPaths) {
    if (!nextCutPaths.has(itemPath)) {
      fileElementMap.get(itemPath)?.classList.remove('cut');
    }
  }

  for (const itemPath of nextCutPaths) {
    const element = fileElementMap.get(itemPath);
    if (element) {
      element.classList.add('cut');
    }
  }

  cutPaths = nextCutPaths;
}

function showSortMenu(e: MouseEvent) {
  const sortMenu = document.getElementById('sort-menu');
  if (!sortMenu) return;

  const rect = sortBtn.getBoundingClientRect();
  sortMenu.style.display = 'block';

  const menuRect = sortMenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = rect.left;
  let top = rect.bottom + 5;

  if (left + menuRect.width > viewportWidth) {
    left = viewportWidth - menuRect.width - 10;
  }

  if (top + menuRect.height > viewportHeight) {
    top = rect.top - menuRect.height - 5;
  }

  if (left < 10) left = 10;
  if (top < 10) top = 10;

  sortMenu.style.left = left + 'px';
  sortMenu.style.top = top + 'px';

  updateSortIndicators();

  e.stopPropagation();
}

function hideSortMenu() {
  const sortMenu = document.getElementById('sort-menu');
  if (sortMenu) {
    sortMenu.style.display = 'none';
  }
}

function updateSortIndicators() {
  ['name', 'date', 'size', 'type'].forEach((sortType) => {
    const indicator = document.getElementById(`sort-${sortType}`);
    if (indicator) {
      if (currentSettings.sortBy === sortType) {
        indicator.textContent = currentSettings.sortOrder === 'asc' ? '▲' : '▼';
      } else {
        indicator.textContent = '';
      }
    }
    const listIndicator = document.getElementById(`list-sort-${sortType}`);
    if (listIndicator) {
      if (currentSettings.sortBy === sortType) {
        listIndicator.textContent = currentSettings.sortOrder === 'asc' ? '▲' : '▼';
      } else {
        listIndicator.textContent = '';
      }
    }
  });

  document.querySelectorAll<HTMLElement>('.list-header-cell').forEach((cell) => {
    const sortType = cell.dataset.sort;
    if (!sortType) return;
    const ariaSort =
      currentSettings.sortBy === sortType
        ? currentSettings.sortOrder === 'asc'
          ? 'ascending'
          : 'descending'
        : 'none';
    cell.setAttribute('aria-sort', ariaSort);
  });
}

async function changeSortMode(sortBy: string) {
  if (!isOneOf(sortBy, SORT_BY_VALUES)) {
    return;
  }
  if (currentSettings.sortBy === sortBy) {
    currentSettings.sortOrder = currentSettings.sortOrder === 'asc' ? 'desc' : 'asc';
  } else {
    currentSettings.sortBy = sortBy;
    currentSettings.sortOrder = 'asc';
  }

  await saveSettingsWithTimestamp(currentSettings);
  hideSortMenu();
  updateSortIndicators();

  if (allFiles.length > 0) {
    renderFiles(allFiles);
  }
}

type ListColumnKey = 'name' | 'type' | 'size' | 'modified';

function setListColumnWidth(key: ListColumnKey, width: number, persist: boolean = true): void {
  const min = LIST_COLUMN_MIN_WIDTHS[key] ?? 120;
  const max = LIST_COLUMN_MAX_WIDTHS[key] ?? 480;
  const clamped = Math.max(min, Math.min(max, Math.round(width)));
  const varName = key === 'modified' ? '--list-col-modified' : `--list-col-${key}`;
  const value = key === 'name' ? `minmax(${clamped}px, 1fr)` : `${clamped}px`;

  document.documentElement.style.setProperty(varName, value);

  if (persist) {
    currentSettings.listColumnWidths = {
      ...(currentSettings.listColumnWidths || {}),
      [key]: clamped,
    };
    debouncedSaveSettings();
  }
}

function applyListColumnWidths(): void {
  const widths = currentSettings.listColumnWidths;
  if (!widths) return;
  (['name', 'type', 'size', 'modified'] as ListColumnKey[]).forEach((key) => {
    const value = widths[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      setListColumnWidth(key, value, false);
    }
  });
}

function setSidebarWidth(width: number, persist: boolean = true): void {
  const clamped = Math.max(140, Math.min(360, Math.round(width)));
  document.documentElement.style.setProperty('--sidebar-width-current', `${clamped}px`);
  if (persist) {
    currentSettings.sidebarWidth = clamped;
    debouncedSaveSettings();
  }
}

function applySidebarWidth(): void {
  if (typeof currentSettings.sidebarWidth === 'number') {
    setSidebarWidth(currentSettings.sidebarWidth, false);
  }
}

function setPreviewPanelWidth(width: number, persist: boolean = true): void {
  const clamped = Math.max(200, Math.min(520, Math.round(width)));
  document.documentElement.style.setProperty('--preview-panel-width', `${clamped}px`);
  if (persist) {
    currentSettings.previewPanelWidth = clamped;
    debouncedSaveSettings();
  }
}

function applyPreviewPanelWidth(): void {
  if (typeof currentSettings.previewPanelWidth === 'number') {
    setPreviewPanelWidth(currentSettings.previewPanelWidth, false);
  }
}

function setSidebarCollapsed(collapsed?: boolean): void {
  const sidebar = document.querySelector('.sidebar') as HTMLElement | null;
  const toggle = document.getElementById('sidebar-toggle');
  if (!sidebar) return;
  const shouldCollapse =
    typeof collapsed === 'boolean' ? collapsed : !sidebar.classList.contains('collapsed');
  sidebar.classList.toggle('collapsed', shouldCollapse);
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(!shouldCollapse));
  }
}

function syncSidebarToggleState(): void {
  const sidebar = document.querySelector('.sidebar') as HTMLElement | null;
  const toggle = document.getElementById('sidebar-toggle');
  if (!sidebar || !toggle) return;
  toggle.setAttribute('aria-expanded', String(!sidebar.classList.contains('collapsed')));
}

function setupSidebarResize(): void {
  if (!sidebarResizeHandle) return;
  const sidebar = document.querySelector('.sidebar') as HTMLElement | null;
  if (!sidebar) return;
  let startX = 0;
  let startWidth = 0;

  const onMouseMove = (e: MouseEvent) => {
    const delta = e.clientX - startX;
    setSidebarWidth(startWidth + delta, false);
  };

  const onMouseUp = () => {
    sidebarResizeHandle.classList.remove('resizing');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const currentWidth = sidebar.getBoundingClientRect().width;
    setSidebarWidth(currentWidth, true);
  };

  sidebarResizeHandle.addEventListener('mousedown', (e) => {
    if (sidebar.classList.contains('collapsed')) return;
    e.preventDefault();
    startX = e.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    sidebarResizeHandle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function setupSidebarSections(): void {
  const sections = document.querySelectorAll<HTMLElement>(
    '.sidebar-section[data-collapsible="true"]'
  );
  sections.forEach((section) => {
    const toggle = section.querySelector<HTMLButtonElement>('.section-toggle');
    if (!toggle) return;
    const syncAria = () => {
      const isCollapsed = section.classList.contains('collapsed');
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
    };
    syncAria();
    toggle.addEventListener('click', () => {
      section.classList.toggle('collapsed');
      syncAria();
    });
  });
}

function setupPreviewResize(): void {
  if (!previewResizeHandle) return;
  const previewPanel = document.getElementById('preview-panel') as HTMLElement | null;
  if (!previewPanel) return;
  let startX = 0;
  let startWidth = 0;

  const onMouseMove = (e: MouseEvent) => {
    const delta = startX - e.clientX;
    setPreviewPanelWidth(startWidth + delta, false);
  };

  const onMouseUp = () => {
    previewResizeHandle.classList.remove('resizing');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const currentWidth = previewPanel.getBoundingClientRect().width;
    setPreviewPanelWidth(currentWidth, true);
  };

  previewResizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = previewPanel.getBoundingClientRect().width;
    previewResizeHandle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function setupListHeader(): void {
  if (!listHeader) return;

  listHeader.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.list-header-resize')) return;
    const cell = target.closest('.list-header-cell') as HTMLElement | null;
    if (!cell) return;
    const sortType = cell.dataset.sort;
    if (sortType) {
      changeSortMode(sortType);
    }
  });

  listHeader.querySelectorAll<HTMLElement>('.list-header-cell').forEach((cell) => {
    cell.tabIndex = 0;
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const sortType = cell.dataset.sort;
        if (sortType) {
          changeSortMode(sortType);
        }
      }
    });
  });

  listHeader.querySelectorAll('.list-header-resize').forEach((handle) => {
    const resizeHandle = handle as HTMLElement;
    resizeHandle.addEventListener('mousedown', (e) => {
      const mouseEvent = e as MouseEvent;
      mouseEvent.preventDefault();
      mouseEvent.stopPropagation();
      const resizeKey = resizeHandle.dataset.resize as ListColumnKey | undefined;
      if (!resizeKey) return;
      activeListResizeColumn = resizeKey;
      const cell = resizeHandle.closest('.list-header-cell') as HTMLElement | null;
      if (!cell) return;
      listResizeStartX = mouseEvent.clientX;
      listResizeStartWidth = cell.getBoundingClientRect().width;
      listResizeCurrentWidth = listResizeStartWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!activeListResizeColumn) return;
    const delta = e.clientX - listResizeStartX;
    listResizeCurrentWidth = listResizeStartWidth + delta;
    setListColumnWidth(activeListResizeColumn as ListColumnKey, listResizeCurrentWidth, false);
  });

  document.addEventListener('mouseup', () => {
    if (!activeListResizeColumn) return;
    setListColumnWidth(activeListResizeColumn as ListColumnKey, listResizeCurrentWidth, true);
    activeListResizeColumn = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

function updateStatusBar() {
  if (statusItems) {
    statusItems.textContent = `${allFiles.length} item${allFiles.length !== 1 ? 's' : ''}`;
  }

  if (statusSelected) {
    if (selectedItems.size > 0) {
      const totalSize = Array.from(selectedItems).reduce((acc, itemPath) => {
        const item = filePathMap.get(itemPath);
        return acc + (item ? item.size : 0);
      }, 0);
      const sizeStr = formatFileSize(totalSize);
      statusSelected.textContent = `${selectedItems.size} selected (${sizeStr})`;
      statusSelected.style.display = 'inline';
    } else {
      statusSelected.style.display = 'none';
    }
  }

  if (selectionIndicator && selectionCount) {
    if (selectedItems.size > 0) {
      selectionCount.textContent = String(selectedItems.size);
      selectionIndicator.style.display = 'inline-flex';
    } else {
      selectionIndicator.style.display = 'none';
    }
  }

  if (statusHidden) {
    if (!currentSettings.showHiddenFiles) {
      const hiddenCount = hiddenFilesCount;
      if (hiddenCount > 0) {
        statusHidden.textContent = `(+${hiddenCount} hidden)`;
        statusHidden.style.display = 'inline';
        statusHidden.title = 'Click to show hidden files';
      } else {
        statusHidden.style.display = 'none';
      }
    } else {
      statusHidden.style.display = 'none';
    }
  }

  if (statusSearch && statusSearchText) {
    const searchStatus = getSearchStatusText();
    if (searchStatus.active) {
      statusSearchText.textContent = searchStatus.text;
      statusSearch.style.display = 'inline-flex';
    } else {
      statusSearch.style.display = 'none';
    }
  }
}

// disk space query timer
let diskSpaceDebounceTimer: NodeJS.Timeout | null = null;
let lastDiskSpacePath: string = '';

function getUnixDrivePath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/');
  const roots = ['/Volumes', '/media', '/mnt', '/run/media'];
  for (const root of roots) {
    if (normalized === root || normalized.startsWith(root + '/')) {
      const parts = normalized.split('/').filter(Boolean);
      const rootParts = root.split('/').filter(Boolean);
      const extraSegments = root === '/run/media' ? 2 : 1;
      const needed = rootParts.length + extraSegments;
      if (parts.length >= needed) {
        return '/' + parts.slice(0, needed).join('/');
      }
      return root;
    }
  }
  return '/';
}

function getWindowsDrivePath(pathValue: string): string {
  const normalized = pathValue.replace(/\//g, '\\');
  if (normalized.startsWith('\\\\')) {
    const parts = normalized.split('\\').filter(Boolean);
    if (parts.length >= 2) {
      return `\\\\${parts[0]}\\${parts[1]}\\`;
    }
    return normalized;
  }
  return normalized.substring(0, 3);
}

async function updateDiskSpace() {
  const statusDiskSpace = document.getElementById('status-disk-space');
  if (!statusDiskSpace || !currentPath || isHomeViewPath(currentPath)) return;

  let drivePath = currentPath;
  if (platformOS === 'win32') {
    drivePath = getWindowsDrivePath(currentPath);
  } else {
    drivePath = getUnixDrivePath(currentPath);
  }

  if (drivePath === lastDiskSpacePath && diskSpaceDebounceTimer) {
    return;
  }

  if (diskSpaceDebounceTimer) {
    clearTimeout(diskSpaceDebounceTimer);
  }

  lastDiskSpacePath = drivePath;

  const cached = getCachedDiskSpace(drivePath);
  if (cached) {
    renderDiskSpace(statusDiskSpace, cached.total, cached.free);
    return;
  }

  diskSpaceDebounceTimer = setTimeout(async () => {
    const result = await window.electronAPI.getDiskSpace(drivePath);
    if (
      result.success &&
      typeof result.total === 'number' &&
      typeof result.free === 'number' &&
      result.total > 0
    ) {
      const total = result.total;
      const free = result.free;
      if (diskSpaceCache.size >= DISK_SPACE_CACHE_MAX) {
        const firstKey = diskSpaceCache.keys().next().value;
        if (firstKey) diskSpaceCache.delete(firstKey);
      }
      diskSpaceCache.set(drivePath, { timestamp: Date.now(), total, free });
      renderDiskSpace(statusDiskSpace, total, free);
    } else {
      const isUnc = platformOS === 'win32' && drivePath.startsWith('\\\\');
      const message = isUnc ? 'Disk space unavailable for network share' : 'Disk space unavailable';
      renderDiskSpaceUnavailable(statusDiskSpace, message);
    }
    diskSpaceDebounceTimer = null;
  }, 300);
}

function getCachedDiskSpace(drivePath: string): { total: number; free: number } | null {
  const cached = diskSpaceCache.get(drivePath);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > DISK_SPACE_CACHE_TTL_MS) {
    diskSpaceCache.delete(drivePath);
    return null;
  }
  return { total: cached.total, free: cached.free };
}

function renderDiskSpace(element: HTMLElement, total: number, free: number): void {
  const freeStr = formatFileSize(free);
  const totalStr = formatFileSize(total);
  const usedBytes = total - free;
  const usedPercent = ((usedBytes / total) * 100).toFixed(1);
  let usageColor = '#107c10';
  if (parseFloat(usedPercent) > 80) {
    usageColor = '#ff8c00';
  }
  if (parseFloat(usedPercent) > 90) {
    usageColor = '#e81123';
  }

  element.innerHTML = `
    <span style="display: inline-flex; align-items: center; gap: 6px;">
      ${twemojiImg(String.fromCodePoint(0x1f4be), 'twemoji')} ${freeStr} free of ${totalStr}
      <span style="display: inline-block; width: 60px; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; position: relative;">
        <span style="position: absolute; left: 0; top: 0; height: 100%; width: ${usedPercent}%; background: ${usageColor}; transition: width 0.3s ease;"></span>
      </span>
      <span style="opacity: 0.7;">(${usedPercent}% used)</span>
    </span>
  `;
}

function renderDiskSpaceUnavailable(element: HTMLElement, message: string): void {
  element.innerHTML = `
    <span style="display: inline-flex; align-items: center; gap: 6px; opacity: 0.7;">
      ${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} ${escapeHtml(message)}
    </span>
  `;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function updateZoomLevel(newZoom: number) {
  currentZoomLevel = Math.max(0.5, Math.min(2.0, newZoom));
  const result = await window.electronAPI.setZoomLevel(currentZoomLevel);

  if (result.success) {
    updateZoomDisplay();
    showZoomPopup();
  }
}

function updateZoomDisplay() {
  const zoomDisplay = document.getElementById('zoom-level-display');
  if (zoomDisplay) {
    zoomDisplay.textContent = `${Math.round(currentZoomLevel * 100)}%`;
  }
}

function showZoomPopup() {
  const zoomPopup = document.getElementById('zoom-popup') as HTMLElement;
  if (!zoomPopup) return;

  zoomPopup.style.display = 'flex';

  if (zoomPopupTimeout) {
    clearTimeout(zoomPopupTimeout);
  }

  zoomPopupTimeout = setTimeout(() => {
    zoomPopup.style.display = 'none';
  }, 2000);
}

async function zoomIn() {
  await updateZoomLevel(currentZoomLevel + 0.1);
}

async function zoomOut() {
  await updateZoomLevel(currentZoomLevel - 0.1);
}

async function zoomReset() {
  await updateZoomLevel(1.0);
}

async function init() {
  console.log('Init: Getting platform, store info, and settings...');

  const [platform, mas, flatpak, msStore, appVersion] = await Promise.all([
    window.electronAPI.getPlatform(),
    window.electronAPI.isMas(),
    window.electronAPI.isFlatpak(),
    window.electronAPI.isMsStore(),
    window.electronAPI.getAppVersion(),
  ]);

  await loadSettings();
  await homeController.loadHomeSettings();
  renderSidebarQuickAccess();

  initTooltipSystem();
  initCommandPalette();
  initProgressPanel();

  platformOS = platform;
  document.body.classList.add(`platform-${platformOS}`);
  updateVersionDisplays(appVersion);

  const titlebarIcon = document.getElementById('titlebar-icon') as HTMLImageElement;
  if (titlebarIcon) {
    const isBeta = /-(beta|alpha|rc)/i.test(appVersion);
    const iconSrc = isBeta ? '../assets/folder-beta.png' : '../assets/folder.png';
    titlebarIcon.src = iconSrc;
    console.log(`[Init] Version: ${appVersion}, isBeta: ${isBeta}, titlebar icon: ${iconSrc}`);
  }

  window.electronAPI.getSystemAccentColor().then(({ accentColor, isDarkMode }) => {
    const rgb = hexToRgb(accentColor);
    document.documentElement.style.setProperty('--system-accent-color', accentColor);
    document.documentElement.style.setProperty('--system-accent-rgb', rgb);
    if (isDarkMode) {
      document.body.classList.add('system-dark-mode');
    }
    if (currentSettings.useSystemTheme) {
      const systemTheme = isDarkMode ? 'default' : 'light';
      if (currentSettings.theme !== systemTheme) {
        currentSettings.theme = systemTheme;
        applySettings(currentSettings);
      }
    }
  });

  const startupPath =
    currentSettings.startupPath && currentSettings.startupPath.trim() !== ''
      ? currentSettings.startupPath
      : HOME_VIEW_PATH;

  setupEventListeners();
  loadDrives();
  initializeTabs();

  await navigateTo(startupPath);

  queueMicrotask(() => {
    setupBreadcrumbListeners();
    setupThemeEditorListeners();
    homeController.setupHomeSettingsListeners();
    loadBookmarks();

    window.electronAPI.onHomeSettingsChanged(() => {
      renderSidebarQuickAccess();
    });
  });

  const isStoreVersion = mas || flatpak || msStore;

  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(() => {
      if (isStoreVersion) {
        const updateBtn = document.getElementById('check-updates-btn');
        if (updateBtn) {
          updateBtn.style.display = 'none';
        }

        const autoCheckToggle = document.getElementById('auto-check-updates-toggle');
        if (autoCheckToggle) {
          const settingItem = autoCheckToggle.closest('.setting-item') as HTMLElement;
          if (settingItem) {
            settingItem.style.display = 'none';
          }
        }

        const updatesCards = document.querySelectorAll('.settings-card-header');
        updatesCards.forEach((header) => {
          if (header.textContent === 'Updates') {
            const card = header.closest('.settings-card') as HTMLElement;
            if (card) {
              card.style.display = 'none';
            }
          }
        });
      }

      if (mas || msStore) {
        const settingsCards = document.querySelectorAll('.settings-card-header');
        settingsCards.forEach((header) => {
          if (header.textContent === 'Developer Options') {
            const card = header.closest('.settings-card') as HTMLElement;
            if (card) {
              card.style.display = 'none';
            }
          }
        });
      }
    });
  }

  setTimeout(() => {
    updateUndoRedoState();

    window.electronAPI.getZoomLevel().then((zoomResult) => {
      if (zoomResult.success && zoomResult.zoomLevel) {
        currentZoomLevel = zoomResult.zoomLevel;
        updateZoomDisplay();
      }
    });

    const cleanupUpdateAvailable = window.electronAPI.onUpdateAvailable((info) => {
      console.log('Update available:', info);

      const settingsBtn = document.getElementById('settings-btn');
      if (settingsBtn) {
        if (!settingsBtn.querySelector('.notification-badge')) {
          const badge = document.createElement('span');
          badge.className = 'notification-badge';
          badge.textContent = '1';
          settingsBtn.style.position = 'relative';
          settingsBtn.appendChild(badge);
        }
      }

      const checkUpdatesBtn = document.getElementById('check-updates-btn');
      if (checkUpdatesBtn) {
        checkUpdatesBtn.innerHTML = `${twemojiImg(String.fromCodePoint(0x1f389), 'twemoji')} Update Available!`;
        checkUpdatesBtn.classList.add('primary');
      }
    });
    ipcCleanupFunctions.push(cleanupUpdateAvailable);

    const cleanupSystemResumed = window.electronAPI.onSystemResumed(() => {
      console.log('[Renderer] System resumed from sleep, refreshing view...');
      lastDiskSpacePath = '';
      diskSpaceCache.clear();
      if (diskSpaceDebounceTimer) {
        clearTimeout(diskSpaceDebounceTimer);
        diskSpaceDebounceTimer = null;
      }
      if (currentPath) {
        refresh();
      }
      loadDrives();
    });
    ipcCleanupFunctions.push(cleanupSystemResumed);

    const cleanupSystemThemeChanged = window.electronAPI.onSystemThemeChanged(({ isDarkMode }) => {
      if (currentSettings.useSystemTheme) {
        console.log('[Renderer] System theme changed, isDarkMode:', isDarkMode);
        const newTheme = isDarkMode ? 'default' : 'light';
        currentSettings.theme = newTheme;
        applySettings(currentSettings);
      }
    });
    ipcCleanupFunctions.push(cleanupSystemThemeChanged);
  }, 0);

  console.log('Init: Complete');
}

function setFolderTreeVisibility(enabled: boolean): void {
  const section = getById('folder-tree-section');
  if (section) {
    section.style.display = enabled ? '' : 'none';
  }
  if (!enabled && folderTree) {
    clearHtml(folderTree);
  }

  const drivesSection = getById('drives-section');
  if (drivesSection) {
    drivesSection.style.display = enabled ? 'none' : '';
  }
}

async function loadDrives() {
  if (!drivesList) return;

  const drives = await window.electronAPI.getDriveInfo();
  cacheDriveInfo(drives);
  clearHtml(drivesList);

  drives.forEach((drive) => {
    const driveLabel = drive.label || drive.path;
    const driveItem = document.createElement('div');
    driveItem.className = 'nav-item';
    driveItem.title = drive.path;
    driveItem.innerHTML = `
      <span class="nav-icon">${twemojiImg(String.fromCodePoint(0x1f4be), 'twemoji')}</span>
      <span class="nav-label">${escapeHtml(driveLabel)}</span>
    `;
    driveItem.addEventListener('click', () => navigateTo(drive.path));
    drivesList.appendChild(driveItem);
  });

  const drivePaths = drives.map((drive) => drive.path);
  void homeController.renderHomeDrives(drives);

  if (currentSettings.showFolderTree !== false) {
    folderTreeManager.render(drivePaths);
  } else if (folderTree) {
    clearHtml(folderTree);
  }
}

function getFileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() || '';
}

function getFileTypeFromName(filename: string): string {
  const ext = getFileExtension(filename);
  if (!ext) return 'File';
  if (IMAGE_EXTENSIONS.has(ext)) return 'Image';
  if (RAW_EXTENSIONS.has(ext)) return 'RAW Image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'Video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'Audio';
  if (PDF_EXTENSIONS.has(ext)) return 'PDF Document';
  if (WORD_EXTENSIONS.has(ext)) return 'Word Document';
  if (SPREADSHEET_EXTENSIONS.has(ext)) return 'Spreadsheet';
  if (PRESENTATION_EXTENSIONS.has(ext)) return 'Presentation';
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'Archive';
  if (SOURCE_CODE_EXTENSIONS.has(ext)) return 'Source Code';
  if (WEB_EXTENSIONS.has(ext)) return 'Web File';
  if (DATA_EXTENSIONS.has(ext)) return 'Data File';
  if (TEXT_EXTENSIONS.has(ext)) return 'Text File';
  return `${ext.toUpperCase()} File`;
}

function initCoreUiInteractions(): void {
  initSettingsTabs();
  initSettingsUi();
  initShortcutsModal();
  setupFileGridEventDelegation();
  setupRubberBandSelection();
  setupListHeader();
  setupViewOptions();
  setupSidebarResize();
  setupSidebarSections();
  setupPreviewResize();
  initPreviewUi();
  if (currentSettings.showFileHoverCard !== false) {
    setupHoverCard();
  }
}

function initSyncEventListeners(): void {
  const cleanupClipboard = window.electronAPI.onClipboardChanged((newClipboard) => {
    clipboard = newClipboard;
    updateCutVisuals();
    console.log('[Sync] Clipboard updated from another window');
  });
  ipcCleanupFunctions.push(cleanupClipboard);

  const cleanupSettings = window.electronAPI.onSettingsChanged((newSettings) => {
    const currentTimestamp =
      typeof currentSettings._timestamp === 'number' ? currentSettings._timestamp : 0;
    const newTimestamp = typeof newSettings._timestamp === 'number' ? newSettings._timestamp : 0;

    if (newTimestamp < currentTimestamp) {
      console.log('[Sync] Ignoring stale settings from another window');
      return;
    }

    console.log('[Sync] Settings updated from another window');
    currentSettings = newSettings;
    applySettings(newSettings);
    const settingsModal = document.getElementById('settings-modal') as HTMLElement | null;
    if (settingsModal && settingsModal.style.display === 'flex') {
      const previousSavedState = getSavedState();
      const currentFormState = captureSettingsFormState();
      const nextSavedState = buildSettingsFormStateFromSettings(newSettings);
      const mergedState = { ...nextSavedState };

      if (previousSavedState) {
        Object.keys(currentFormState).forEach((key) => {
          if (currentFormState[key] !== previousSavedState[key]) {
            mergedState[key] = currentFormState[key];
          }
        });
      }

      setSavedState(nextSavedState);
      resetRedoState();
      applySettingsFormState(mergedState);
      const themeSelect = document.getElementById('theme-select') as HTMLSelectElement | null;
      updateCustomThemeUI({
        syncSelect: false,
        selectedTheme: themeSelect?.value,
      });
    } else {
      updateCustomThemeUI();
    }
    const shortcutsModal = document.getElementById('shortcuts-modal');
    syncShortcutBindingsFromSettings(newSettings, {
      render: shortcutsModal ? shortcutsModal.style.display === 'flex' : false,
    });
  });
  ipcCleanupFunctions.push(cleanupSettings);
}

function initWindowControlListeners(): void {
  document.getElementById('minimize-btn')?.addEventListener('click', () => {
    window.electronAPI.minimizeWindow();
  });

  document.getElementById('maximize-btn')?.addEventListener('click', () => {
    window.electronAPI.maximizeWindow();
  });

  document.getElementById('close-btn')?.addEventListener('click', () => {
    window.electronAPI.closeWindow();
  });
}

function initActionButtonListeners(): void {
  backBtn?.addEventListener('click', goBack);
  forwardBtn?.addEventListener('click', goForward);
  upBtn?.addEventListener('click', goUp);
  undoBtn?.addEventListener('click', performUndo);
  redoBtn?.addEventListener('click', performRedo);
  refreshBtn?.addEventListener('click', refresh);
  newFileBtn?.addEventListener('click', createNewFile);
  newFolderBtn?.addEventListener('click', createNewFolder);
  viewToggleBtn?.addEventListener('click', toggleView);

  const emptyNewFolderBtn = document.getElementById('empty-new-folder-btn');
  const emptyNewFileBtn = document.getElementById('empty-new-file-btn');
  emptyNewFolderBtn?.addEventListener('click', createNewFolder);
  emptyNewFileBtn?.addEventListener('click', createNewFile);

  const selectAllBtn = document.getElementById('select-all-btn');
  const deselectAllBtn = document.getElementById('deselect-all-btn');
  selectAllBtn?.addEventListener('click', selectAll);
  deselectAllBtn?.addEventListener('click', clearSelection);
  selectionCopyBtn?.addEventListener('click', copyToClipboard);
  selectionCutBtn?.addEventListener('click', cutToClipboard);
  selectionMoveBtn?.addEventListener('click', moveSelectedToFolder);
  selectionRenameBtn?.addEventListener('click', renameSelected);
  selectionDeleteBtn?.addEventListener('click', deleteSelected);

  const statusHiddenBtn = document.getElementById('status-hidden');
  statusHiddenBtn?.addEventListener('click', () => {
    currentSettings.showHiddenFiles = true;
    const showHiddenFilesToggle = document.getElementById(
      'show-hidden-files-toggle'
    ) as HTMLInputElement | null;
    if (showHiddenFilesToggle) {
      showHiddenFilesToggle.checked = true;
    }
    saveSettings();
    refresh();
  });

  document.addEventListener('mouseup', (e) => {
    if (e.button === 3) {
      e.preventDefault();
      goBack();
    } else if (e.button === 4) {
      e.preventDefault();
      goForward();
    }
  });
}

function initNavigationListeners(): void {
  sortBtn?.addEventListener('click', showSortMenu);
  bookmarkAddBtn?.addEventListener('click', addBookmark);

  const sidebarToggle = document.getElementById('sidebar-toggle');
  sidebarToggle?.addEventListener('click', () => {
    setSidebarCollapsed();
  });
  syncSidebarToggleState();

  addressInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      const value = addressInput.value.trim();
      if (value === HOME_VIEW_LABEL) {
        navigateTo(HOME_VIEW_PATH);
      } else {
        navigateTo(value);
      }
    }
  });
}

function isModalOpen(): boolean {
  const settingsModal = document.getElementById('settings-modal');
  const shortcutsModal = document.getElementById('shortcuts-modal');
  const dialogModal = document.getElementById('dialog-modal');
  const licensesModal = document.getElementById('licenses-modal');
  const homeSettingsModal = document.getElementById('home-settings-modal');
  const propertiesModal = document.getElementById('properties-modal');
  const extractModal = document.getElementById('extract-modal');
  const themeEditorModal = document.getElementById('theme-editor-modal');
  const folderIconModal = document.getElementById('folder-icon-modal');
  const supportPopupModal = document.getElementById('support-popup-modal');
  const tourPromptModal = document.getElementById('tour-prompt-modal');
  const commandPaletteModal = document.getElementById('command-palette-modal');

  return !!(
    (settingsModal && settingsModal.style.display === 'flex') ||
    (shortcutsModal && shortcutsModal.style.display === 'flex') ||
    (dialogModal && dialogModal.style.display === 'flex') ||
    (licensesModal && licensesModal.style.display === 'flex') ||
    isQuickLookOpen() ||
    (homeSettingsModal && homeSettingsModal.style.display === 'flex') ||
    (propertiesModal && propertiesModal.style.display === 'flex') ||
    (extractModal && extractModal.style.display === 'flex') ||
    (themeEditorModal && themeEditorModal.style.display === 'flex') ||
    (folderIconModal && folderIconModal.style.display === 'flex') ||
    (supportPopupModal && supportPopupModal.style.display === 'flex') ||
    (tourPromptModal && tourPromptModal.style.display === 'flex') ||
    (commandPaletteModal && commandPaletteModal.style.display === 'flex')
  );
}

function hasTextSelection(): boolean {
  const selection = window.getSelection();
  return selection !== null && selection.toString().length > 0;
}

function isEditableElementActive(): boolean {
  const activeElement = document.activeElement as HTMLElement | null;
  if (!activeElement) return false;
  return (
    activeElement.tagName === 'INPUT' ||
    activeElement.tagName === 'TEXTAREA' ||
    activeElement.isContentEditable
  );
}

function runShortcutAction(actionId: string, e: KeyboardEvent): boolean {
  switch (actionId) {
    case 'command-palette':
      e.preventDefault();
      showCommandPalette();
      return true;
    case 'settings':
      e.preventDefault();
      showSettingsModal();
      return true;
    case 'shortcuts':
      e.preventDefault();
      showShortcutsModal();
      return true;
    case 'refresh':
      e.preventDefault();
      refresh();
      return true;
    case 'search':
      e.preventDefault();
      openSearch(false);
      return true;
    case 'global-search':
      e.preventDefault();
      openSearch(true);
      return true;
    case 'toggle-sidebar':
      e.preventDefault();
      setSidebarCollapsed();
      return true;
    case 'new-window':
      e.preventDefault();
      openNewWindow();
      return true;
    case 'new-file':
      e.preventDefault();
      createNewFile();
      return true;
    case 'new-folder':
      e.preventDefault();
      createNewFolder();
      return true;
    case 'go-back':
      e.preventDefault();
      goBack();
      return true;
    case 'go-forward':
      e.preventDefault();
      goForward();
      return true;
    case 'go-up':
      e.preventDefault();
      goUp();
      return true;
    case 'new-tab':
      e.preventDefault();
      if (tabsEnabled) {
        addNewTab();
      }
      return true;
    case 'close-tab':
      e.preventDefault();
      if (tabsEnabled && tabs.length > 1) {
        closeTab(activeTabId);
      }
      return true;
    case 'next-tab':
    case 'prev-tab': {
      e.preventDefault();
      if (tabsEnabled && tabs.length > 1) {
        const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
        if (currentIndex !== -1) {
          const nextIndex =
            actionId === 'next-tab'
              ? (currentIndex + 1) % tabs.length
              : (currentIndex - 1 + tabs.length) % tabs.length;
          switchToTab(tabs[nextIndex].id);
        }
      }
      return true;
    }
    case 'copy':
      if (hasTextSelection()) {
        return false;
      }
      e.preventDefault();
      copyToClipboard();
      return true;
    case 'cut':
      if (hasTextSelection()) {
        return false;
      }
      e.preventDefault();
      cutToClipboard();
      return true;
    case 'paste':
      if (isEditableElementActive()) {
        return false;
      }
      e.preventDefault();
      pasteFromClipboard();
      return true;
    case 'select-all':
      if (isEditableElementActive()) {
        return false;
      }
      e.preventDefault();
      selectAll();
      return true;
    case 'undo':
      e.preventDefault();
      performUndo();
      return true;
    case 'redo':
      e.preventDefault();
      performRedo();
      return true;
    case 'zoom-in':
      e.preventDefault();
      zoomIn();
      return true;
    case 'zoom-out':
      e.preventDefault();
      zoomOut();
      return true;
    case 'zoom-reset':
      e.preventDefault();
      zoomReset();
      return true;
    default:
      return false;
  }
}

function initKeyboardListeners(): void {
  document.addEventListener('keydown', (e) => {
    if (isShortcutCaptureActive()) {
      return;
    }
    if (e.key === 'Escape') {
      const settingsModal = document.getElementById('settings-modal');
      if (settingsModal && settingsModal.style.display === 'flex') {
        hideSettingsModal();
        return;
      }

      const shortcutsModal = document.getElementById('shortcuts-modal');
      if (shortcutsModal && shortcutsModal.style.display === 'flex') {
        hideShortcutsModal();
        return;
      }

      const licensesModal = document.getElementById('licenses-modal');
      if (licensesModal && licensesModal.style.display === 'flex') {
        hideLicensesModal();
        return;
      }

      const homeSettingsModal = document.getElementById('home-settings-modal');
      if (homeSettingsModal && homeSettingsModal.style.display === 'flex') {
        homeController.closeHomeSettingsModal();
        return;
      }

      const contextMenu = document.getElementById('context-menu');
      if (contextMenu && contextMenu.style.display === 'block') {
        hideContextMenu();
        return;
      }

      const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');
      if (emptySpaceContextMenu && emptySpaceContextMenu.style.display === 'block') {
        hideEmptySpaceContextMenu();
        return;
      }

      if (isSearchModeActive()) {
        closeSearch();
      }
      return;
    }

    const contextMenu = document.getElementById('context-menu');
    const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');

    if (contextMenu && contextMenu.style.display === 'block') {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        contextMenuFocusedIndex = navigateContextMenu(contextMenu, 'down', contextMenuFocusedIndex);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        contextMenuFocusedIndex = navigateContextMenu(contextMenu, 'up', contextMenuFocusedIndex);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (contextMenuFocusedIndex >= 0) {
          activateContextMenuItem(contextMenu, contextMenuFocusedIndex);
        }
        return;
      }
      if (e.key === 'ArrowRight') {
        const items = getVisibleMenuItems(contextMenu);
        if (
          contextMenuFocusedIndex >= 0 &&
          items[contextMenuFocusedIndex]?.classList.contains('has-submenu')
        ) {
          e.preventDefault();
          activateContextMenuItem(contextMenu, contextMenuFocusedIndex);
        }
        return;
      }
    }

    if (emptySpaceContextMenu && emptySpaceContextMenu.style.display === 'block') {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        emptySpaceMenuFocusedIndex = navigateContextMenu(
          emptySpaceContextMenu,
          'down',
          emptySpaceMenuFocusedIndex
        );
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        emptySpaceMenuFocusedIndex = navigateContextMenu(
          emptySpaceContextMenu,
          'up',
          emptySpaceMenuFocusedIndex
        );
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (emptySpaceMenuFocusedIndex >= 0) {
          const items = getVisibleMenuItems(emptySpaceContextMenu);
          if (items[emptySpaceMenuFocusedIndex]) {
            items[emptySpaceMenuFocusedIndex].click();
          }
        }
        return;
      }
    }

    if (isModalOpen()) {
      return;
    }

    const fixedActionId = getFixedShortcutActionIdFromEvent(e);
    if (fixedActionId) {
      const handled = runShortcutAction(fixedActionId, e);
      if (handled) {
        return;
      }
    }

    const shortcutActionId = getShortcutActionIdFromEvent(e);
    if (shortcutActionId) {
      const handled = runShortcutAction(shortcutActionId, e);
      if (handled) {
        return;
      }
    }

    if (e.key === 'Backspace') {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
      ) {
        return;
      }
      e.preventDefault();
      goUp();
    } else if (e.key === 'F2') {
      e.preventDefault();
      renameSelected();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      if (e.shiftKey) {
        if (!currentSettings.showDangerousOptions) {
          showToast(
            'Enable Developer Mode in settings to permanently delete items',
            'Developer Mode Required',
            'warning'
          );
          return;
        }
        permanentlyDeleteSelected();
      } else {
        deleteSelected();
      }
    } else if (e.key === 'Enter') {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
      ) {
        return;
      }
      e.preventDefault();
      openSelectedItem();
    } else if (
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight'
    ) {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
      ) {
        return;
      }
      e.preventDefault();
      navigateFileGrid(e.key, e.shiftKey);
    } else if (e.key === 'Home') {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
      ) {
        return;
      }
      e.preventDefault();
      selectFirstItem(e.shiftKey);
    } else if (e.key === 'End') {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
      ) {
        return;
      }
      e.preventDefault();
      selectLastItem(e.shiftKey);
    } else if (e.key === 'PageUp') {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
      ) {
        return;
      }
      e.preventDefault();
      navigateByPage('up', e.shiftKey);
    } else if (e.key === 'PageDown') {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
      ) {
        return;
      }
      e.preventDefault();
      navigateByPage('down', e.shiftKey);
    } else if (
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      e.key.length === 1 &&
      !isSearchModeActive() &&
      viewMode !== 'column'
    ) {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
      ) {
        return;
      }
      handleTypeaheadInput(e.key);
    }
  });
}

function initGlobalClickListeners(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const contextMenu = document.getElementById('context-menu');
    const emptySpaceMenu = document.getElementById('empty-space-context-menu');
    const sortMenu = document.getElementById('sort-menu');
    const menuItem = target.closest('.context-menu-item') as HTMLElement;

    if (menuItem) {
      if (sortMenu && sortMenu.style.display === 'block') {
        const sortType = menuItem.getAttribute('data-sort');
        if (sortType) {
          changeSortMode(sortType);
        }
        return;
      }

      if (emptySpaceMenu && emptySpaceMenu.style.display === 'block') {
        handleEmptySpaceContextMenuAction(menuItem.dataset.action);
        hideEmptySpaceContextMenu();
        return;
      }

      if (contextMenuData) {
        handleContextMenuAction(menuItem.dataset.action, contextMenuData, menuItem.dataset.format);
        hideContextMenu();
        return;
      }
    }

    if (contextMenu && contextMenu.style.display === 'block' && !contextMenu.contains(target)) {
      hideContextMenu();
    }
    if (
      emptySpaceMenu &&
      emptySpaceMenu.style.display === 'block' &&
      !emptySpaceMenu.contains(target)
    ) {
      hideEmptySpaceContextMenu();
    }
    if (
      sortMenu &&
      sortMenu.style.display === 'block' &&
      !sortMenu.contains(target) &&
      target !== sortBtn
    ) {
      hideSortMenu();
    }

    const breadcrumbMenu = getBreadcrumbMenuElement();
    if (
      breadcrumbMenu &&
      isBreadcrumbMenuOpen() &&
      !breadcrumbMenu.contains(target) &&
      !target.closest('.breadcrumb-item')
    ) {
      hideBreadcrumbMenu();
    }
  });
}

function isDropTargetFileItem(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest('.file-item');
}

function isDropTargetContentItem(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return !!(
    element.closest('.file-grid') ||
    element.closest('.column-view') ||
    element.closest('.file-item') ||
    element.closest('.column-item')
  );
}

function isDropIntoCurrentDirectory(draggedPaths: string[], destinationPath: string): boolean {
  return draggedPaths.some((dragPath: string) => {
    const parentDir = path.dirname(dragPath);
    return parentDir === destinationPath || dragPath === destinationPath;
  });
}

function initFileGridDragAndDrop(): void {
  if (!fileGrid) return;

  fileGrid.addEventListener('click', (e) => {
    if (e.target === fileGrid) {
      clearSelection();
    }
  });

  fileGrid.addEventListener('dragover', (e) => {
    if (isDropTargetFileItem(e.target)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    if (!e.dataTransfer) return;

    if (!currentPath) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }

    const operation = getDragOperation(e);
    e.dataTransfer.dropEffect = operation;
    fileGrid.classList.add('drag-over');
    showDropIndicator(operation, currentPath, e.clientX, e.clientY);
  });

  fileGrid.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const rect = fileGrid.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX >= rect.right ||
      e.clientY < rect.top ||
      e.clientY >= rect.bottom
    ) {
      fileGrid.classList.remove('drag-over');
      hideDropIndicator();
    }
  });

  fileGrid.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    fileGrid.classList.remove('drag-over');

    if (isDropTargetFileItem(e.target)) {
      return;
    }

    const draggedPaths = await getDraggedPaths(e);

    if (draggedPaths.length === 0 || !currentPath) {
      hideDropIndicator();
      return;
    }

    if (isDropIntoCurrentDirectory(draggedPaths, currentPath)) {
      showToast('Items are already in this directory', 'Info', 'info');
      hideDropIndicator();
      return;
    }

    const operation = getDragOperation(e);
    await handleDrop(draggedPaths, currentPath, operation);
    hideDropIndicator();
  });
}

function initFileViewDragAndDrop(): void {
  if (!fileView) return;

  fileView.addEventListener('dragover', (e) => {
    if (isDropTargetContentItem(e.target)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (!currentPath) {
      e.dataTransfer!.dropEffect = 'none';
      return;
    }

    const operation = getDragOperation(e);
    e.dataTransfer!.dropEffect = operation;
    fileView.classList.add('drag-over');
    showDropIndicator(operation, currentPath, e.clientX, e.clientY);
  });

  fileView.addEventListener('dragleave', (e) => {
    e.preventDefault();
    const rect = fileView.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX >= rect.right ||
      e.clientY < rect.top ||
      e.clientY >= rect.bottom
    ) {
      fileView.classList.remove('drag-over');
      hideDropIndicator();
    }
  });

  fileView.addEventListener('drop', async (e) => {
    if (isDropTargetContentItem(e.target)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    fileView.classList.remove('drag-over');

    const draggedPaths = await getDraggedPaths(e);

    if (draggedPaths.length === 0 || !currentPath) {
      hideDropIndicator();
      return;
    }

    if (isDropIntoCurrentDirectory(draggedPaths, currentPath)) {
      showToast('Items are already in this directory', 'Info', 'info');
      hideDropIndicator();
      return;
    }

    const operation = getDragOperation(e);
    await handleDrop(draggedPaths, currentPath, operation);
    hideDropIndicator();
  });
}

function initDragAndDropListeners(): void {
  initFileGridDragAndDrop();
  initFileViewDragAndDrop();
}

function initContextMenuListeners(): void {
  document.addEventListener('contextmenu', (e) => {
    if (!(e.target as HTMLElement).closest('.file-item')) {
      e.preventDefault();
      const target = e.target as HTMLElement;
      const clickedOnFileView =
        target.closest('#file-view') ||
        target.id === 'file-view' ||
        target.closest('.file-grid') ||
        target.id === 'file-grid' ||
        target.closest('.empty-state') ||
        target.id === 'empty-state';
      if (clickedOnFileView && currentPath) {
        showEmptySpaceContextMenu(e.pageX, e.pageY);
      } else {
        hideContextMenu();
        hideEmptySpaceContextMenu();
      }
    }
  });
}

function setupEventListeners() {
  initCoreUiInteractions();
  initSyncEventListeners();
  initWindowControlListeners();
  initActionButtonListeners();
  initSearchListeners();
  initNavigationListeners();
  initKeyboardListeners();
  initGlobalClickListeners();
  initDragAndDropListeners();
  initContextMenuListeners();
}
function updateHiddenFilesCount(items: FileItem[], append = false): void {
  const count = items.reduce((acc, item) => acc + (item.isHidden ? 1 : 0), 0);
  hiddenFilesCount = append ? hiddenFilesCount + count : count;
}

async function navigateTo(path: string, skipHistoryUpdate = false) {
  if (!path) return;
  const trimmedPath = path.trim();
  if (trimmedPath === HOME_VIEW_LABEL) {
    path = HOME_VIEW_PATH;
  }

  if (isHomeViewPath(path)) {
    resetTypeahead();

    if (isSearchModeActive()) {
      closeSearch();
    }

    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
    }

    hideLoading();

    currentPath = HOME_VIEW_PATH;
    updateCurrentTabPath(path);
    if (addressInput) addressInput.value = HOME_VIEW_LABEL;
    updateBreadcrumb(path);

    if (!skipHistoryUpdate && (historyIndex === -1 || history[historyIndex] !== path)) {
      history = history.slice(0, historyIndex + 1);
      history.push(path);
      historyIndex = history.length - 1;
    }

    updateNavigationButtons();
    setHomeViewActive(true);
    return;
  }

  setHomeViewActive(false);
  let requestId = 0;
  let operationId = '';

  try {
    resetTypeahead();

    if (isSearchModeActive()) {
      closeSearch();
    }

    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
    }

    showLoading('Loading folder...');
    if (fileGrid) fileGrid.innerHTML = '';
    const request = startDirectoryRequest(path);
    requestId = request.requestId;
    operationId = request.operationId;

    const result = await window.electronAPI.getDirectoryContents(
      path,
      operationId,
      currentSettings.showHiddenFiles,
      false
    );
    if (requestId !== directoryRequestId) return;

    if (result.success) {
      currentPath = path;
      updateCurrentTabPath(path);
      if (addressInput) addressInput.value = path;
      updateBreadcrumb(path);
      try {
        folderTreeManager.ensurePathVisible(path);
      } catch (error) {
        ignoreError(error);
      }
      addToDirectoryHistory(path);

      if (!skipHistoryUpdate && (historyIndex === -1 || history[historyIndex] !== path)) {
        history = history.slice(0, historyIndex + 1);
        history.push(path);
        historyIndex = history.length - 1;
      }

      updateNavigationButtons();

      if (viewMode === 'column') {
        await renderColumnView();
      } else {
        renderFiles(result.contents || []);
      }
      updateDiskSpace();
      if (currentSettings.enableGitStatus) {
        fetchGitStatusAsync(path);
        updateGitBranch(path);
      }
    } else {
      console.error('Error loading directory:', result.error);
      showToast(result.error || 'Unknown error', 'Error Loading Directory', 'error');
    }
  } catch (error) {
    console.error('Error navigating:', error);
    showToast(getErrorMessage(error), 'Error Loading Directory', 'error');
  } finally {
    const isCurrentRequest = requestId !== 0 && requestId === directoryRequestId;
    finishDirectoryRequest(requestId);
    if (isCurrentRequest) hideLoading();
  }
}

let renderFilesToken = 0;
const filePathMap: Map<string, FileItem> = new Map();
let virtualizedRenderToken = 0;
let virtualizedItems: FileItem[] = [];
let virtualizedRenderIndex = 0;
let virtualizedSearchQuery: string | undefined;
let virtualizedObserver: IntersectionObserver | null = null;
let virtualizedSentinel: HTMLElement | null = null;

function resetVirtualizedRender(): void {
  if (virtualizedObserver) {
    virtualizedObserver.disconnect();
    virtualizedObserver = null;
  }
  virtualizedItems = [];
  virtualizedRenderIndex = 0;
  virtualizedSearchQuery = undefined;
  if (virtualizedSentinel && virtualizedSentinel.parentElement) {
    virtualizedSentinel.parentElement.removeChild(virtualizedSentinel);
  }
  virtualizedSentinel = null;
}

function getVirtualizedObserver(): IntersectionObserver | null {
  const root = document.getElementById('file-view');
  if (!root) return null;
  if (virtualizedObserver) return virtualizedObserver;

  virtualizedObserver = new IntersectionObserver(
    (entries) => {
      const entry = entries.find((item) => item.isIntersecting);
      if (entry && entry.target) {
        virtualizedObserver?.unobserve(entry.target);
        appendNextVirtualizedBatch();
      }
    },
    {
      root,
      rootMargin: '200px',
      threshold: 0.01,
    }
  );
  return virtualizedObserver;
}

function ensureVirtualizedSentinel(): void {
  if (!fileGrid) return;
  const observer = getVirtualizedObserver();
  if (!observer) return;

  if (!virtualizedSentinel) {
    virtualizedSentinel = document.createElement('div');
    virtualizedSentinel.style.width = '100%';
    virtualizedSentinel.style.height = '1px';
    virtualizedSentinel.style.pointerEvents = 'none';
  }

  if (virtualizedSentinel.parentElement !== fileGrid) {
    fileGrid.appendChild(virtualizedSentinel);
  } else {
    fileGrid.appendChild(virtualizedSentinel);
  }

  observer.observe(virtualizedSentinel);
}

function appendNextVirtualizedBatch(): void {
  if (!fileGrid) return;
  if (virtualizedRenderToken !== renderFilesToken) return;

  const start = virtualizedRenderIndex;
  const end = Math.min(start + VIRTUALIZE_BATCH_SIZE, virtualizedItems.length);
  if (start >= end) {
    if (virtualizedSentinel) {
      virtualizedSentinel.remove();
    }
    return;
  }

  const batch = virtualizedItems.slice(start, end);
  virtualizedRenderIndex = end;
  const paths = appendFileItems(batch, virtualizedSearchQuery);
  applyGitIndicatorsToPaths(paths);
  updateCutVisuals();
  updateStatusBar();
  ensureActiveItem();

  if (virtualizedRenderIndex < virtualizedItems.length) {
    ensureVirtualizedSentinel();
  } else if (virtualizedSentinel) {
    virtualizedSentinel.remove();
  }
}

let renderItemIndex = 0;
const animationCleanupItems: HTMLElement[] = [];
let animationCleanupTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAnimationCleanup(): void {
  if (animationCleanupTimer) return;
  animationCleanupTimer = setTimeout(() => {
    animationCleanupTimer = null;
    const batch = animationCleanupItems.splice(0);
    for (const el of batch) {
      el.classList.remove('animate-in');
      el.style.animationDelay = '';
    }
    if (animationCleanupItems.length > 0) {
      scheduleAnimationCleanup();
    }
  }, 400);
}

function appendFileItems(items: FileItem[], searchQuery?: string): string[] {
  if (!fileGrid) return [];
  const fragment = document.createDocumentFragment();
  const paths: string[] = [];
  const shouldAnimate = !document.body.classList.contains('reduce-motion');

  for (const item of items) {
    const fileItem = createFileItem(item, searchQuery);
    if (shouldAnimate) {
      const delayIndex = renderItemIndex % 20;
      const delayMs = delayIndex * 20;
      fileItem.classList.add('animate-in');
      fileItem.style.animationDelay = `${delayMs / 1000}s`;
      animationCleanupItems.push(fileItem);
    }
    renderItemIndex++;
    fileElementMap.set(item.path, fileItem);
    fragment.appendChild(fileItem);
    paths.push(item.path);
  }

  fileGrid.appendChild(fragment);
  if (shouldAnimate && animationCleanupItems.length > 0) {
    scheduleAnimationCleanup();
  }
  return paths;
}

function renderFiles(items: FileItem[], searchQuery?: string) {
  if (!fileGrid) return;

  const renderToken = ++renderFilesToken;
  resetVirtualizedRender();
  resetThumbnailObserver();
  fileGrid.innerHTML = '';
  renderItemIndex = 0;
  clearSelection();
  allFiles = items;
  updateHiddenFilesCount(items);

  filePathMap.clear();
  fileElementMap.clear();
  gitIndicatorPaths.clear();
  cutPaths.clear();
  for (const item of items) {
    filePathMap.set(item.path, item);
  }

  const LARGE_FOLDER_THRESHOLD = 10000;
  if (items.length >= LARGE_FOLDER_THRESHOLD) {
    showToast(
      `This folder contains ${items.length.toLocaleString()} items. Performance may be affected.`,
      'Large Folder',
      'warning'
    );
  }

  const visibleItems = currentSettings.showHiddenFiles
    ? items
    : items.filter((item) => !item.isHidden);

  if (visibleItems.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    updateStatusBar();
    return;
  }

  if (emptyState) emptyState.style.display = 'none';

  const sortBy = currentSettings.sortBy || 'name';
  const sortOrder = currentSettings.sortOrder || 'asc';
  const extCache = sortBy === 'type' ? new Map<FileItem, string>() : null;
  const modifiedCache = sortBy === 'date' ? new Map<FileItem, number>() : null;

  if (sortBy === 'type') {
    visibleItems.forEach((item) => {
      if (!item.isDirectory) {
        const ext = getFileExtension(item.name);
        extCache?.set(item, ext);
      }
    });
  } else if (sortBy === 'date') {
    visibleItems.forEach((item) => {
      const time =
        item.modified instanceof Date ? item.modified.getTime() : new Date(item.modified).getTime();
      modifiedCache?.set(item, time);
    });
  }

  const sortedItems = [...visibleItems].sort((a, b) => {
    const dirSort = (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0);
    if (dirSort !== 0) return dirSort;

    let comparison = 0;

    switch (sortBy) {
      case 'name':
        comparison = NAME_COLLATOR.compare(a.name, b.name);
        break;
      case 'date':
        comparison = (modifiedCache?.get(a) || 0) - (modifiedCache?.get(b) || 0);
        break;
      case 'size':
        comparison = a.size - b.size;
        break;
      case 'type': {
        const extA = extCache?.get(a) || '';
        const extB = extCache?.get(b) || '';
        comparison = NAME_COLLATOR.compare(extA, extB);
        break;
      }
      default:
        comparison = NAME_COLLATOR.compare(a.name, b.name);
    }

    return sortOrder === 'asc' ? comparison : -comparison;
  });

  if (sortedItems.length >= VIRTUALIZE_THRESHOLD) {
    virtualizedRenderToken = renderToken;
    virtualizedItems = sortedItems;
    virtualizedRenderIndex = 0;
    virtualizedSearchQuery = searchQuery;
    appendNextVirtualizedBatch();
    return;
  }

  const batchSize = RENDER_BATCH_SIZE;
  let currentBatch = 0;

  const renderBatch = () => {
    if (renderToken !== renderFilesToken) return;
    const start = currentBatch * batchSize;
    const end = Math.min(start + batchSize, sortedItems.length);
    const batch = sortedItems.slice(start, end);
    const paths = appendFileItems(batch, searchQuery);
    applyGitIndicatorsToPaths(paths);
    currentBatch++;

    if (renderToken !== renderFilesToken) return;
    if (end < sortedItems.length) {
      requestAnimationFrame(renderBatch);
    } else {
      updateCutVisuals();
      updateStatusBar();
      ensureActiveItem();
    }
  };

  renderBatch();
}

let thumbnailObserver: IntersectionObserver | null = null;
let thumbnailObserverRoot: HTMLElement | null = null;

function resetThumbnailObserver(): void {
  if (thumbnailObserver) {
    thumbnailObserver.disconnect();
    thumbnailObserver = null;
  }
  thumbnailObserverRoot = null;
}

function getThumbnailObserver(): IntersectionObserver | null {
  const scrollContainer = document.getElementById('file-view');
  if (!scrollContainer) return null;
  if (thumbnailObserver && thumbnailObserverRoot === scrollContainer) return thumbnailObserver;

  if (thumbnailObserver) {
    thumbnailObserver.disconnect();
  }

  thumbnailObserverRoot = scrollContainer;
  thumbnailObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const fileItem = entry.target as HTMLElement;
          const path = fileItem.dataset.path;
          const item = path ? filePathMap.get(path) : undefined;

          if (item && fileItem.classList.contains('has-thumbnail')) {
            loadThumbnail(fileItem, item);
            thumbnailObserver?.unobserve(fileItem);
          }
        }
      });
    },
    {
      root: scrollContainer,
      rootMargin: THUMBNAIL_ROOT_MARGIN,
      threshold: 0.01,
    }
  );
  return thumbnailObserver;
}

function observeThumbnailItem(fileItem: HTMLElement): void {
  const observer = getThumbnailObserver();
  if (observer) {
    observer.observe(fileItem);
  }
}

function createFileItem(item: FileItem, searchQuery?: string): HTMLElement {
  const fileItem = document.createElement('div');
  fileItem.className = 'file-item';
  fileItem.tabIndex = -1;
  fileItem.dataset.path = item.path;
  fileItem.dataset.isDirectory = String(item.isDirectory);
  fileItem.setAttribute('role', 'option');
  fileItem.setAttribute('aria-selected', 'false');

  let icon: string;
  if (item.isDirectory) {
    icon = getFolderIcon(item.path);
  } else {
    const ext = getFileExtension(item.name);
    if (IMAGE_EXTENSIONS.has(ext) || RAW_EXTENSIONS.has(ext)) {
      fileItem.classList.add('has-thumbnail');
      fileItem.dataset.thumbnailType = RAW_EXTENSIONS.has(ext) ? 'raw' : 'image';
      icon = IMAGE_ICON;
      observeThumbnailItem(fileItem);
    } else if (VIDEO_EXTENSIONS.has(ext)) {
      fileItem.classList.add('has-thumbnail');
      fileItem.dataset.thumbnailType = 'video';
      icon = getFileIcon(item.name);
      observeThumbnailItem(fileItem);
    } else if (AUDIO_EXTENSIONS.has(ext)) {
      fileItem.classList.add('has-thumbnail');
      fileItem.dataset.thumbnailType = 'audio';
      icon = getFileIcon(item.name);
      observeThumbnailItem(fileItem);
    } else if (PDF_EXTENSIONS.has(ext)) {
      fileItem.classList.add('has-thumbnail');
      fileItem.dataset.thumbnailType = 'pdf';
      icon = getFileIcon(item.name);
      observeThumbnailItem(fileItem);
    } else {
      icon = getFileIcon(item.name);
    }
  }

  const sizeDisplay = item.isDirectory ? '--' : formatFileSize(item.size);
  const dateDisplay = DATE_FORMATTER.format(new Date(item.modified));
  const typeDisplay = item.isDirectory ? 'Folder' : getFileTypeFromName(item.name);

  const ariaDescription = item.isDirectory
    ? `${typeDisplay}, modified ${dateDisplay}`
    : `${typeDisplay}, ${sizeDisplay}, modified ${dateDisplay}`;
  fileItem.setAttribute('aria-label', item.name);
  fileItem.setAttribute('aria-description', ariaDescription);

  const contentResult = item as ContentSearchResult;
  let matchContextHtml = '';
  if (contentResult.matchContext && searchQuery && searchQuery.length <= 500) {
    const escapedContext = escapeHtml(contentResult.matchContext);
    const escapedQuery = escapeHtml(searchQuery);
    const regex = new RegExp(`(${escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const highlightedContext = escapedContext.replace(
      regex,
      '<span class="match-highlight">$1</span>'
    );
    const lineInfo = contentResult.matchLineNumber
      ? `<span class="match-line-number">Line ${contentResult.matchLineNumber}</span>`
      : '';
    matchContextHtml = `<div class="match-context">${highlightedContext}${lineInfo}</div>`;
  }

  // Handle file extension display
  let displayName = item.name;
  if (currentSettings.showFileExtensions === false && !item.isDirectory) {
    const lastDot = item.name.lastIndexOf('.');
    if (lastDot > 0) {
      displayName = item.name.substring(0, lastDot);
    }
  }

  fileItem.innerHTML = `
    <div class="file-main">
      <div class="file-checkbox"><span class="checkbox-mark">✓</span></div>
      <div class="file-icon">${icon}</div>
      <div class="file-text">
        <div class="file-name">${escapeHtml(displayName)}</div>
        ${matchContextHtml}
      </div>
    </div>
    <div class="file-info">
      <span class="file-type">${escapeHtml(typeDisplay)}</span>
      <span class="file-size" data-path="${escapeHtml(item.path)}">${sizeDisplay}</span>
      <span class="file-modified">${dateDisplay}</span>
    </div>
  `;
  fileItem.draggable = true;

  return fileItem;
}

let fileGridDelegationReady = false;

function getFileItemElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const fileItem = target.closest('.file-item');
  return fileItem instanceof HTMLElement ? fileItem : null;
}

function getFileItemData(fileItem: HTMLElement): FileItem | null {
  const itemPath = fileItem.dataset.path;
  if (!itemPath) return null;
  return filePathMap.get(itemPath) ?? null;
}

function getDragOperation(event: DragEvent): 'copy' | 'move' {
  return event.ctrlKey || event.altKey ? 'copy' : 'move';
}

async function getDraggedPaths(event: DragEvent): Promise<string[]> {
  let draggedPaths: string[] = [];
  if (!event.dataTransfer) return draggedPaths;

  try {
    const textData = event.dataTransfer.getData('text/plain');
    if (textData) {
      draggedPaths = JSON.parse(textData);
    }
  } catch (error) {
    console.debug('[Drag] Failed to parse drag data, trying fallback methods:', error);
  }

  if (draggedPaths.length === 0 && event.dataTransfer.files.length > 0) {
    draggedPaths = Array.from(event.dataTransfer.files).map(
      (f) => (f as File & { path: string }).path
    );
  }

  if (draggedPaths.length === 0) {
    const sharedData = await window.electronAPI.getDragData();
    if (sharedData) {
      draggedPaths = sharedData.paths;
    }
  }

  return draggedPaths;
}

function showDropIndicator(
  action: 'copy' | 'move' | 'add',
  destPath: string,
  x: number,
  y: number
): void {
  if (!dropIndicator || !dropIndicatorAction || !dropIndicatorPath) return;
  const label = path.basename(destPath) || destPath;
  dropIndicatorAction.textContent = action === 'copy' ? 'Copy' : action === 'add' ? 'Add' : 'Move';
  dropIndicatorPath.textContent = label;
  dropIndicatorPath.title = destPath;
  dropIndicator.style.display = 'inline-flex';
  dropIndicator.style.left = `${x + 12}px`;
  dropIndicator.style.top = `${y + 12}px`;
}

function hideDropIndicator(): void {
  if (!dropIndicator) return;
  dropIndicator.style.display = 'none';
}

function scheduleSpringLoad(target: HTMLElement, action: () => void): void {
  if (springLoadedFolder !== target) {
    if (springLoadedTimeout) {
      clearTimeout(springLoadedTimeout);
      springLoadedTimeout = null;
    }
    springLoadedFolder?.classList.remove('spring-loading');
    springLoadedFolder = target;
    springLoadedTimeout = setTimeout(() => {
      if (springLoadedFolder === target) {
        target.classList.remove('spring-loading');
        action();
      }
      springLoadedFolder = null;
      springLoadedTimeout = null;
    }, SPRING_LOAD_DELAY);
    setTimeout(() => {
      if (springLoadedFolder === target) {
        target.classList.add('spring-loading');
      }
    }, SPRING_LOAD_DELAY / 2);
  }
}

function clearSpringLoad(target?: HTMLElement): void {
  if (!target || springLoadedFolder === target) {
    if (springLoadedTimeout) {
      clearTimeout(springLoadedTimeout);
      springLoadedTimeout = null;
    }
    springLoadedFolder?.classList.remove('spring-loading');
    springLoadedFolder = null;
  }
}

function setupFileGridEventDelegation(): void {
  if (!fileGrid || fileGridDelegationReady) return;
  fileGridDelegationReady = true;

  fileGrid.addEventListener(
    'mouseenter',
    (e) => {
      const target = e.target;
      if (!(target instanceof HTMLImageElement)) return;
      if (target.dataset.animated !== 'true') return;
      const animatedSrc = target.dataset.animatedSrc;
      if (animatedSrc && target.src !== animatedSrc) {
        target.src = animatedSrc;
      }
    },
    true
  );

  fileGrid.addEventListener(
    'mouseleave',
    (e) => {
      const target = e.target;
      if (!(target instanceof HTMLImageElement)) return;
      if (target.dataset.animated !== 'true') return;
      const staticSrc = target.dataset.staticSrc;
      if (staticSrc && target.src !== staticSrc) {
        target.src = staticSrc;
      }
    },
    true
  );

  fileGrid.addEventListener('click', (e) => {
    const fileItem = getFileItemElement(e.target);
    if (!fileItem) return;
    if (!e.ctrlKey && !e.metaKey) {
      clearSelection();
    }
    toggleSelection(fileItem);
  });

  fileGrid.addEventListener('dblclick', (e) => {
    const fileItem = getFileItemElement(e.target);
    if (!fileItem) return;
    const item = getFileItemData(fileItem);
    if (!item) return;
    void openFileEntry(item);
  });

  fileGrid.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const fileItem = getFileItemElement(e.target);
    if (!fileItem) return;
    const item = getFileItemData(fileItem);
    if (!item || !item.isDirectory || !tabsEnabled) return;
    e.preventDefault();
    addNewTab(item.path);
  });

  fileGrid.addEventListener('contextmenu', (e) => {
    const fileItem = getFileItemElement(e.target);
    if (!fileItem) return;
    const item = getFileItemData(fileItem);
    if (!item) return;
    e.preventDefault();
    if (!fileItem.classList.contains('selected')) {
      clearSelection();
      toggleSelection(fileItem);
    }
    showContextMenu(e.pageX, e.pageY, item);
  });

  fileGrid.addEventListener('dragstart', (e) => {
    const fileItem = getFileItemElement(e.target);
    if (!fileItem) return;
    e.stopPropagation();

    if (!fileItem.classList.contains('selected')) {
      clearSelection();
      toggleSelection(fileItem);
    }

    const selectedPaths = Array.from(selectedItems);
    if (!e.dataTransfer) return;

    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', JSON.stringify(selectedPaths));
    window.electronAPI.setDragData(selectedPaths);
    fileItem.classList.add('dragging');

    if (selectedPaths.length > 1) {
      const dragImage = document.createElement('div');
      dragImage.className = 'drag-image';
      dragImage.textContent = `${selectedPaths.length} items`;
      dragImage.style.position = 'absolute';
      dragImage.style.top = '-1000px';
      document.body.appendChild(dragImage);
      e.dataTransfer.setDragImage(dragImage, 0, 0);
      setTimeout(() => dragImage.remove(), 0);
    }
  });

  fileGrid.addEventListener('dragend', (e) => {
    const fileItem = getFileItemElement(e.target);
    if (!fileItem) return;
    fileItem.classList.remove('dragging');
    document.querySelectorAll('.file-item.drag-over').forEach((el) => {
      el.classList.remove('drag-over', 'spring-loading');
    });
    document.getElementById('file-grid')?.classList.remove('drag-over');
    window.electronAPI.clearDragData();
    clearSpringLoad();
    hideDropIndicator();
  });

  fileGrid.addEventListener('dragover', (e) => {
    const fileItem = getFileItemElement(e.target);
    if (!fileItem) return;
    if (fileItem.dataset.isDirectory !== 'true') return;

    e.preventDefault();
    e.stopPropagation();

    if (!e.dataTransfer) return;
    if (!e.dataTransfer.types.includes('text/plain') && e.dataTransfer.files.length === 0) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    const operation = getDragOperation(e);
    e.dataTransfer.dropEffect = operation;
    fileItem.classList.add('drag-over');

    const item = getFileItemData(fileItem);
    if (item && item.isDirectory) {
      showDropIndicator(operation, item.path, e.clientX, e.clientY);
      scheduleSpringLoad(fileItem, () => {
        fileItem.classList.remove('drag-over', 'spring-loading');
        navigateTo(item.path);
      });
    }
  });

  fileGrid.addEventListener('dragleave', (e) => {
    const fileItem = getFileItemElement(e.target);
    if (!fileItem) return;
    if (fileItem.dataset.isDirectory !== 'true') return;

    e.preventDefault();
    e.stopPropagation();

    const rect = fileItem.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX >= rect.right ||
      e.clientY < rect.top ||
      e.clientY >= rect.bottom
    ) {
      fileItem.classList.remove('drag-over', 'spring-loading');
      clearSpringLoad(fileItem);
      hideDropIndicator();
    }
  });

  fileGrid.addEventListener('drop', async (e) => {
    const fileItem = getFileItemElement(e.target);
    if (!fileItem) return;
    if (fileItem.dataset.isDirectory !== 'true') return;

    e.preventDefault();
    e.stopPropagation();

    fileItem.classList.remove('drag-over');
    clearSpringLoad(fileItem);

    const draggedPaths = await getDraggedPaths(e);

    const item = getFileItemData(fileItem);
    if (!item || draggedPaths.length === 0 || draggedPaths.includes(item.path)) {
      hideDropIndicator();
      return;
    }

    const operation = getDragOperation(e);
    await handleDrop(draggedPaths, item.path, operation);
    hideDropIndicator();
  });
}

function generateVideoThumbnail(videoUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'metadata';

    const cleanup = () => {
      video.src = '';
      video.load();
    };

    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, video.duration * 0.1);
    };

    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const size = 160 * dpr;
        const aspectRatio = video.videoWidth / video.videoHeight;

        if (aspectRatio > 1) {
          canvas.width = size;
          canvas.height = Math.round(size / aspectRatio);
        } else {
          canvas.width = Math.round(size * aspectRatio);
          canvas.height = size;
        }

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const quality =
            currentSettings.thumbnailQuality === 'low'
              ? 0.5
              : currentSettings.thumbnailQuality === 'high'
                ? 0.9
                : 0.7;
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          cleanup();
          resolve(dataUrl);
        } else {
          cleanup();
          reject(new Error('Could not get canvas context'));
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    video.onerror = () => {
      cleanup();
      reject(new Error('Failed to load video'));
    };

    setTimeout(() => {
      cleanup();
      reject(new Error('Video thumbnail timeout'));
    }, 5000);

    video.src = videoUrl;
  });
}

async function generateAudioWaveform(audioUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(160 * dpr);
    canvas.height = Math.round(160 * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Cannot get canvas context'));
      return;
    }
    ctx.scale(dpr, dpr);

    const audioContext = new AudioContext();

    fetch(audioUrl)
      .then((response) => response.arrayBuffer())
      .then((arrayBuffer) => audioContext.decodeAudioData(arrayBuffer))
      .then((audioBuffer) => {
        const rawData = audioBuffer.getChannelData(0);
        const samples = 80;
        const blockSize = Math.floor(rawData.length / samples);
        const filteredData: number[] = [];

        for (let i = 0; i < samples; i++) {
          const blockStart = blockSize * i;
          let sum = 0;
          for (let j = 0; j < blockSize; j++) {
            sum += Math.abs(rawData[blockStart + j]);
          }
          filteredData.push(sum / blockSize);
        }

        const maxVal = Math.max(...filteredData);
        const normalizedData = filteredData.map((d) => d / maxVal);

        const logicalW = 160;
        const logicalH = 160;

        ctx.fillStyle = 'rgba(30, 30, 40, 0.8)';
        ctx.fillRect(0, 0, logicalW, logicalH);

        const barWidth = logicalW / samples;
        const centerY = logicalH / 2;

        ctx.fillStyle = 'rgba(99, 179, 237, 0.8)';
        normalizedData.forEach((value, index) => {
          const barHeight = value * (logicalH * 0.4);
          const x = index * barWidth;
          ctx.fillRect(x, centerY - barHeight, barWidth - 1, barHeight * 2);
        });

        ctx.fillStyle = 'rgba(99, 179, 237, 0.4)';
        ctx.beginPath();
        ctx.arc(logicalW / 2, logicalH / 2, 25, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.beginPath();
        ctx.moveTo(logicalW / 2 - 8, logicalH / 2 - 12);
        ctx.lineTo(logicalW / 2 + 12, logicalH / 2);
        ctx.lineTo(logicalW / 2 - 8, logicalH / 2 + 12);
        ctx.closePath();
        ctx.fill();

        audioContext.close();
        const quality =
          currentSettings.thumbnailQuality === 'low'
            ? 0.5
            : currentSettings.thumbnailQuality === 'high'
              ? 0.9
              : 0.7;
        resolve(canvas.toDataURL('image/jpeg', quality));
      })
      .catch((error) => {
        audioContext.close();
        reject(error);
      });
  });
}

function generatePdfThumbnail(pdfUrl: string): Promise<string> {
  const quality =
    currentSettings.thumbnailQuality === 'low'
      ? 'low'
      : currentSettings.thumbnailQuality === 'high'
        ? 'high'
        : 'medium';
  return generatePdfThumbnailPdfJs(pdfUrl, quality);
}

function loadThumbnail(fileItem: HTMLElement, item: FileItem) {
  const cached = thumbnailCache.get(item.path);
  if (cached) {
    const iconDiv = fileItem.querySelector('.file-icon');
    if (iconDiv) {
      renderThumbnailImage(iconDiv as HTMLElement, cached, item, fileItem);
    }
    return;
  }

  const thumbnailType = fileItem.dataset.thumbnailType || 'image';

  enqueueThumbnailLoad(async () => {
    try {
      if (!document.body.contains(fileItem)) {
        return;
      }

      const iconDiv = fileItem.querySelector('.file-icon');

      if (iconDiv) {
        iconDiv.innerHTML = `<div class="spinner" style="width: 30px; height: 30px; border-width: 2px;"></div>`;
      }

      if (
        thumbnailType !== 'audio' &&
        thumbnailType !== 'pdf' &&
        item.size > (currentSettings.maxThumbnailSizeMB || 10) * 1024 * 1024
      ) {
        if (iconDiv) {
          iconDiv.innerHTML = getFileIcon(item.name);
        }
        fileItem.classList.remove('has-thumbnail');
        return;
      }

      if (
        thumbnailType === 'pdf' &&
        item.size > (currentSettings.maxPreviewSizeMB || 50) * 1024 * 1024
      ) {
        if (iconDiv) {
          iconDiv.innerHTML = getFileIcon(item.name);
        }
        fileItem.classList.remove('has-thumbnail');
        return;
      }

      const diskCacheResult = await window.electronAPI.getCachedThumbnail(item.path);
      if (diskCacheResult.success && diskCacheResult.dataUrl) {
        if (!document.body.contains(fileItem)) return;
        cacheThumbnail(item.path, diskCacheResult.dataUrl);
        if (iconDiv) {
          renderThumbnailImage(iconDiv as HTMLElement, diskCacheResult.dataUrl, item, fileItem);
        }
        return;
      }

      const fileUrl = encodeFileUrl(item.path);

      if (!document.body.contains(fileItem)) {
        return;
      }

      let thumbnailUrl = fileUrl;
      let shouldCacheToDisk = false;

      if (thumbnailType === 'video') {
        try {
          thumbnailUrl = await generateVideoThumbnail(fileUrl);
          shouldCacheToDisk = true;
        } catch {
          if (iconDiv) {
            iconDiv.innerHTML = getFileIcon(item.name);
          }
          fileItem.classList.remove('has-thumbnail');
          return;
        }
      } else if (thumbnailType === 'audio') {
        try {
          thumbnailUrl = await generateAudioWaveform(fileUrl);
          shouldCacheToDisk = true;
        } catch {
          if (iconDiv) {
            iconDiv.innerHTML = getFileIcon(item.name);
          }
          fileItem.classList.remove('has-thumbnail');
          return;
        }
      } else if (thumbnailType === 'pdf') {
        try {
          thumbnailUrl = await generatePdfThumbnail(fileUrl);
          shouldCacheToDisk = true;
        } catch {
          if (iconDiv) {
            iconDiv.innerHTML = getFileIcon(item.name);
          }
          fileItem.classList.remove('has-thumbnail');
          return;
        }
      }

      if (!document.body.contains(fileItem)) {
        return;
      }

      if (iconDiv) {
        cacheThumbnail(item.path, thumbnailUrl);
        renderThumbnailImage(iconDiv as HTMLElement, thumbnailUrl, item, fileItem);

        if (shouldCacheToDisk && thumbnailUrl.startsWith('data:')) {
          window.electronAPI.saveCachedThumbnail(item.path, thumbnailUrl).catch(ignoreError);
        }
      }
    } catch {
      if (!document.body.contains(fileItem)) {
        return;
      }
      const iconDiv = fileItem.querySelector('.file-icon');
      if (iconDiv) {
        iconDiv.innerHTML = getFileIcon(item.name);
      }
      fileItem.classList.remove('has-thumbnail');
    }
  });
}

function cacheThumbnail(path: string, url: string): void {
  if (thumbnailCache.size >= THUMBNAIL_CACHE_MAX) {
    const firstKey = thumbnailCache.keys().next().value;
    if (firstKey) thumbnailCache.delete(firstKey);
  }
  thumbnailCache.set(path, url);
}

function renderThumbnailImage(
  iconDiv: HTMLElement,
  thumbnailUrl: string,
  item: FileItem,
  fileItem: HTMLElement
): void {
  iconDiv.innerHTML = '';
  const img = document.createElement('img');
  img.src = thumbnailUrl;
  img.className = 'file-thumbnail';
  img.alt = item.name;
  img.style.opacity = '0';
  img.loading = 'lazy';
  img.decoding = 'async';

  img.addEventListener(
    'load',
    () => {
      img.style.transition = 'opacity 0.2s ease';
      img.style.opacity = '1';
    },
    { once: true }
  );

  const ext = getFileExtension(item.name);
  if (ANIMATED_IMAGE_EXTENSIONS.has(ext)) {
    img.dataset.animated = 'true';
    img.dataset.staticSrc = thumbnailUrl;
    img.dataset.animatedSrc = encodeFileUrl(item.path);
  }

  img.addEventListener('error', () => {
    if (!document.body.contains(fileItem)) {
      return;
    }
    iconDiv.innerHTML = getFileIcon(item.name);
    fileItem.classList.remove('has-thumbnail');
  });
  iconDiv.appendChild(img);
}

const FOLDER_ICON = twemojiImg(String.fromCodePoint(0x1f4c1), 'twemoji file-icon');
const IMAGE_ICON = twemojiImg(String.fromCodePoint(parseInt('1f5bc', 16)), 'twemoji');
const RAW_ICON = twemojiImg(String.fromCodePoint(0x1f4f7), 'twemoji');
const VIDEO_ICON = twemojiImg(String.fromCodePoint(0x1f3ac), 'twemoji');
const AUDIO_ICON = twemojiImg(String.fromCodePoint(0x1f3b5), 'twemoji');
const WORD_ICON = twemojiImg(String.fromCodePoint(0x1f4dd), 'twemoji');
const SPREADSHEET_ICON = twemojiImg(String.fromCodePoint(0x1f4ca), 'twemoji');
const ARCHIVE_ICON = twemojiImg(String.fromCodePoint(0x1f5dc), 'twemoji');
const DEFAULT_FILE_ICON = twemojiImg(String.fromCodePoint(parseInt('1f4c4', 16)), 'twemoji');

const fileIconCache = new Map<string, string>();
function getFileIcon(filename: string): string {
  const ext = getFileExtension(filename);

  const cached = fileIconCache.get(ext);
  if (cached) return cached;

  const codepoint = FILE_ICON_MAP[ext];
  let icon: string;

  if (!codepoint) {
    if (RAW_EXTENSIONS.has(ext)) {
      icon = RAW_ICON;
    } else if (IMAGE_EXTENSIONS.has(ext)) {
      icon = IMAGE_ICON;
    } else if (VIDEO_EXTENSIONS.has(ext)) {
      icon = VIDEO_ICON;
    } else if (AUDIO_EXTENSIONS.has(ext)) {
      icon = AUDIO_ICON;
    } else if (WORD_EXTENSIONS.has(ext)) {
      icon = WORD_ICON;
    } else if (SPREADSHEET_EXTENSIONS.has(ext) || PRESENTATION_EXTENSIONS.has(ext)) {
      icon = SPREADSHEET_ICON;
    } else if (ARCHIVE_EXTENSIONS.has(ext)) {
      icon = ARCHIVE_ICON;
    } else {
      icon = DEFAULT_FILE_ICON;
    }
  } else if (codepoint === '1f5bc') {
    icon = IMAGE_ICON;
  } else {
    icon = twemojiImg(String.fromCodePoint(parseInt(codepoint, 16)), 'twemoji');
  }

  fileIconCache.set(ext, icon);
  return icon;
}

async function handleDrop(
  sourcePaths: string[],
  destPath: string,
  operation: 'copy' | 'move'
): Promise<void> {
  try {
    const conflictBehavior = currentSettings.fileConflictBehavior || 'ask';
    const result =
      operation === 'copy'
        ? await window.electronAPI.copyItems(sourcePaths, destPath, conflictBehavior)
        : await window.electronAPI.moveItems(sourcePaths, destPath, conflictBehavior);

    if (result.success) {
      showToast(
        `${operation === 'copy' ? 'Copied' : 'Moved'} ${sourcePaths.length} item(s)`,
        'Success',
        'success'
      );
      await window.electronAPI.clearDragData();

      if (operation === 'move') {
        await updateUndoRedoState();
      }

      await navigateTo(currentPath);
      clearSelection();
    } else {
      showToast(result.error || `Failed to ${operation} items`, 'Error', 'error');
    }
  } catch (error) {
    console.error(`Error during ${operation}:`, error);
    showToast(`Failed to ${operation} items`, 'Error', 'error');
  }
}

async function renameSelected() {
  if (selectedItems.size !== 1) return;
  const itemPath = Array.from(selectedItems)[0];
  const fileItems = document.querySelectorAll('.file-item');
  for (const fileItem of Array.from(fileItems)) {
    if (fileItem.getAttribute('data-path') === itemPath) {
      const item = filePathMap.get(itemPath);
      if (item) {
        startInlineRename(fileItem as HTMLElement, item.name, item.path);
      }
      break;
    }
  }
}

async function deleteSelected() {
  if (selectedItems.size === 0) return;

  const count = selectedItems.size;

  if (currentSettings.confirmFileOperations !== false) {
    const confirmed = await showConfirm(
      `Move ${count} item${count > 1 ? 's' : ''} to ${platformOS === 'win32' ? 'Recycle Bin' : 'Trash'}?`,
      'Move to Trash',
      'warning'
    );
    if (!confirmed) return;
  }

  let successCount = 0;
  for (const itemPath of selectedItems) {
    const result = await window.electronAPI.trashItem(itemPath);
    if (result.success) successCount++;
  }

  if (successCount > 0) {
    showToast(
      `${successCount} item${successCount > 1 ? 's' : ''} moved to ${platformOS === 'win32' ? 'Recycle Bin' : 'Trash'}`,
      'Success',
      'success'
    );
    await updateUndoRedoState();
    refresh();
  }
}

async function permanentlyDeleteSelected() {
  if (selectedItems.size === 0) return;

  // warn about permanent delete
  const count = selectedItems.size;
  const confirmed = await showConfirm(
    `${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} PERMANENTLY delete ${count} item${count > 1 ? 's' : ''}? This CANNOT be undone!`,
    'Permanent Delete',
    'error'
  );

  if (confirmed) {
    let successCount = 0;
    for (const itemPath of selectedItems) {
      const result = await window.electronAPI.deleteItem(itemPath);
      if (result.success) successCount++;
    }

    if (successCount > 0) {
      showToast(
        `${successCount} item${successCount > 1 ? 's' : ''} permanently deleted`,
        'Success',
        'success'
      );
      refresh();
    }
  }
}

async function updateUndoRedoState() {
  const state = await window.electronAPI.getUndoRedoState();
  canUndo = state.canUndo;
  canRedo = state.canRedo;

  const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
  const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
  if (undoBtn) undoBtn.disabled = !canUndo;
  if (redoBtn) redoBtn.disabled = !canRedo;
}

async function performUndo() {
  const result = await window.electronAPI.undoAction();
  if (result.success) {
    showToast('Action undone', 'Undo', 'success');
    await updateUndoRedoState();
    refresh();
  } else {
    showToast(result.error || 'Cannot undo', 'Undo Failed', 'warning');
    await updateUndoRedoState();
  }
}

async function performRedo() {
  const result = await window.electronAPI.redoAction();
  if (result.success) {
    showToast('Action redone', 'Redo', 'success');
    await updateUndoRedoState();
    refresh();
  } else {
    showToast(result.error || 'Cannot redo', 'Redo Failed', 'warning');
    await updateUndoRedoState();
  }
}

function goBack() {
  if (historyIndex > 0) {
    historyIndex--;
    const path = history[historyIndex];
    navigateTo(path, true);
  }
}

function goForward() {
  if (historyIndex < history.length - 1) {
    historyIndex++;
    const path = history[historyIndex];
    navigateTo(path, true);
  }
}

function isRootPath(pathValue: string): boolean {
  if (!pathValue || isHomeViewPath(pathValue)) return true;
  if (!isWindowsPath(pathValue)) {
    return pathValue === '/';
  }
  const normalized = normalizeWindowsPath(pathValue);
  if (normalized.startsWith('\\\\')) {
    const parts = normalized.split('\\').filter(Boolean);
    return parts.length <= 2;
  }
  return /^[A-Za-z]:\\?$/.test(normalized);
}

function goUp() {
  if (!currentPath) return;
  if (isRootPath(currentPath)) return;
  const parentPath = path.dirname(currentPath);
  if (!parentPath) return;
  navigateTo(parentPath);
}

function refresh() {
  if (currentPath) {
    navigateTo(currentPath);
  }
}

function updateNavigationButtons() {
  backBtn.disabled = historyIndex <= 0;
  forwardBtn.disabled = historyIndex >= history.length - 1;
  upBtn.disabled = !currentPath || isRootPath(currentPath);
}

async function setViewMode(nextMode: 'grid' | 'list' | 'column') {
  if (viewMode === nextMode) return;
  viewMode = nextMode;
  await applyViewMode();

  currentSettings.viewMode = viewMode;
  saveSettingsWithTimestamp(currentSettings);
}

async function toggleView() {
  // Cycle through: grid → list → column → grid
  if (viewMode === 'grid') {
    await setViewMode('list');
  } else if (viewMode === 'list') {
    await setViewMode('column');
  } else {
    await setViewMode('grid');
  }
}

async function applyViewMode() {
  if (isHomeViewPath(currentPath)) {
    setHomeViewActive(true);
    return;
  }

  if (viewMode === 'column') {
    cancelDirectoryRequest();
    hideLoading();
    fileGrid.style.display = 'none';
    columnView.style.display = 'flex';
    await renderColumnView();
  } else {
    cancelColumnOperations();
    columnView.style.display = 'none';
    fileGrid.style.display = '';
    fileGrid.className = viewMode === 'list' ? 'file-grid list-view' : 'file-grid';

    if (currentPath) {
      let requestId = 0;
      let operationId = '';
      try {
        const request = startDirectoryRequest(currentPath);
        requestId = request.requestId;
        operationId = request.operationId;
        const result = await window.electronAPI.getDirectoryContents(
          currentPath,
          operationId,
          currentSettings.showHiddenFiles
        );
        if (requestId !== directoryRequestId) return;
        if (result.success) {
          renderFiles(result.contents || []);
        }
      } finally {
        finishDirectoryRequest(requestId);
      }
    }
  }

  updateViewModeControls();
}

let columnPaths: string[] = [];
let columnViewRenderId = 0;
let isRenderingColumnView = false;
const activeColumnOperationIds = new Set<string>();

function cancelColumnOperations(): void {
  for (const operationId of activeColumnOperationIds) {
    window.electronAPI.cancelDirectoryContents(operationId).catch(ignoreError);
  }
  activeColumnOperationIds.clear();
}

async function renderColumnView() {
  if (!columnView) return;

  cancelColumnOperations();
  if (isHomeViewPath(currentPath)) {
    columnView.innerHTML = '';
    return;
  }

  const currentRenderId = ++columnViewRenderId;
  while (isRenderingColumnView) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (currentRenderId !== columnViewRenderId) return;
  }

  isRenderingColumnView = true;
  const savedScrollLeft = columnView.scrollLeft;

  try {
    columnView.innerHTML = '';
    columnPaths = [];

    if (!currentPath) {
      await renderDriveColumn();
      return;
    }

    const isWindows = isWindowsPath(currentPath);

    if (isWindows) {
      const parts = currentPath.split('\\').filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        if (i === 0) {
          columnPaths.push(parts[0] + '\\');
        } else {
          columnPaths.push(parts.slice(0, i + 1).join('\\'));
        }
      }
    } else {
      const parts = currentPath.split('/').filter(Boolean);
      columnPaths.push('/');
      for (let i = 0; i < parts.length; i++) {
        columnPaths.push('/' + parts.slice(0, i + 1).join('/'));
      }
    }

    const panePromises = columnPaths.map((colPath, index) =>
      renderColumn(colPath, index, currentRenderId)
    );

    const panes = await Promise.all(panePromises);

    if (currentRenderId !== columnViewRenderId) {
      return;
    }

    for (const pane of panes) {
      if (pane) {
        columnView.appendChild(pane);
      }
    }

    setTimeout(() => {
      if (currentRenderId !== columnViewRenderId) return;
      if (savedScrollLeft > 0) {
        columnView.scrollLeft = savedScrollLeft;
      } else {
        columnView.scrollLeft = columnView.scrollWidth;
      }
    }, 50);
  } finally {
    isRenderingColumnView = false;
  }
}

function addColumnResizeHandle(pane: HTMLElement) {
  const handle = document.createElement('div');
  handle.className = 'column-resize-handle';

  let startX: number;
  let startWidth: number;

  const onMouseMove = (e: MouseEvent) => {
    const delta = e.clientX - startX;
    const newWidth = Math.max(150, Math.min(500, startWidth + delta));
    pane.style.width = newWidth + 'px';
  };

  const onMouseUp = () => {
    handle.classList.remove('resizing');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = pane.offsetWidth;
    handle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  pane.appendChild(handle);
}

async function renderDriveColumn() {
  const pane = document.createElement('div');
  pane.className = 'column-pane';

  try {
    const drives =
      cachedDriveInfo.length > 0 ? cachedDriveInfo : await window.electronAPI.getDriveInfo();
    if (cachedDriveInfo.length === 0) {
      cacheDriveInfo(drives);
    }
    drives.forEach((drive) => {
      const item = document.createElement('div');
      item.className = 'column-item is-directory';
      item.tabIndex = 0;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      item.dataset.path = drive.path;
      item.title = drive.path;
      item.innerHTML = `
        <span class="column-item-icon"><img src="../assets/twemoji/1f4bf.svg" class="twemoji" alt="💿" draggable="false" /></span>
        <span class="column-item-name">${escapeHtml(drive.label || drive.path)}</span>
        <span class="column-item-arrow">▸</span>
      `;
      item.addEventListener('click', () => handleColumnItemClick(item, drive.path, true, 0));
      pane.appendChild(item);
    });
  } catch {
    pane.innerHTML = '<div class="column-item" style="opacity: 0.5;">Error loading drives</div>';
  }

  addColumnResizeHandle(pane);
  columnView.appendChild(pane);
}

async function renderColumn(
  columnPath: string,
  columnIndex: number,
  renderId?: number
): Promise<HTMLDivElement | null> {
  if (renderId !== undefined && renderId !== columnViewRenderId) {
    return null;
  }

  const pane = document.createElement('div');
  pane.className = 'column-pane';
  pane.dataset.columnIndex = String(columnIndex);
  pane.dataset.path = columnPath;

  pane.addEventListener('dragover', (e) => {
    if ((e.target as HTMLElement).closest('.column-item')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    if (!e.dataTransfer!.types.includes('text/plain') && e.dataTransfer!.files.length === 0) {
      e.dataTransfer!.dropEffect = 'none';
      return;
    }

    const operation = getDragOperation(e);
    e.dataTransfer!.dropEffect = operation;
    pane.classList.add('drag-over');
    showDropIndicator(operation, columnPath, e.clientX, e.clientY);
  });

  pane.addEventListener('dragleave', (e) => {
    if ((e.target as HTMLElement).closest('.column-item')) {
      return;
    }
    e.preventDefault();
    const rect = pane.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX >= rect.right ||
      e.clientY < rect.top ||
      e.clientY >= rect.bottom
    ) {
      pane.classList.remove('drag-over');
      hideDropIndicator();
    }
  });

  pane.addEventListener('drop', async (e) => {
    if ((e.target as HTMLElement).closest('.column-item')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    pane.classList.remove('drag-over');

    const draggedPaths = await getDraggedPaths(e);

    if (draggedPaths.length === 0) {
      hideDropIndicator();
      return;
    }

    const alreadyInCurrentDir = draggedPaths.some((filePath: string) => {
      const parentDir = path.dirname(filePath);
      return parentDir === columnPath || filePath === columnPath;
    });

    if (alreadyInCurrentDir) {
      showToast('Items are already in this directory', 'Info', 'info');
      hideDropIndicator();
      return;
    }

    const operation = getDragOperation(e);
    await handleDrop(draggedPaths, columnPath, operation);
    hideDropIndicator();
  });

  try {
    const operationId = createDirectoryOperationId('column');
    activeColumnOperationIds.add(operationId);
    let result: { success: boolean; contents?: FileItem[]; error?: string };
    try {
      result = await window.electronAPI.getDirectoryContents(
        columnPath,
        operationId,
        currentSettings.showHiddenFiles
      );
    } finally {
      activeColumnOperationIds.delete(operationId);
    }
    if (renderId !== undefined && renderId !== columnViewRenderId) {
      return null;
    }
    if (!result.success) {
      throw new Error(result.error || 'Error loading folder');
    }
    const items = result.contents || [];

    const sortedItems = [...items].sort((a, b) => {
      const dirSort = (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0);
      if (dirSort !== 0) return dirSort;
      return NAME_COLLATOR.compare(a.name, b.name);
    });

    const visibleItems = currentSettings.showHiddenFiles
      ? sortedItems
      : sortedItems.filter((item) => !item.isHidden);

    if (visibleItems.length === 0) {
      pane.innerHTML =
        '<div class="column-item" style="opacity: 0.5; font-style: italic;">Empty folder</div>';
    } else {
      visibleItems.forEach((fileItem) => {
        const item = document.createElement('div');
        item.className = 'column-item';
        item.tabIndex = 0;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', 'false');
        if (fileItem.isDirectory) item.classList.add('is-directory');
        item.dataset.path = fileItem.path;

        const nextColPath = columnPaths[columnIndex + 1];
        if (nextColPath && fileItem.path === nextColPath) {
          item.classList.add('expanded');
          item.setAttribute('aria-selected', 'true');
        }

        const icon = fileItem.isDirectory
          ? '<img src="../assets/twemoji/1f4c1.svg" class="twemoji" alt="📁" draggable="false" />'
          : getFileIcon(fileItem.name);

        item.innerHTML = `
          <span class="column-item-icon">${icon}</span>
          <span class="column-item-name">${escapeHtml(fileItem.name)}</span>
          ${fileItem.isDirectory ? '<span class="column-item-arrow">▸</span>' : ''}
        `;

        item.addEventListener('click', () =>
          handleColumnItemClick(item, fileItem.path, fileItem.isDirectory, columnIndex)
        );
        item.addEventListener('dblclick', () => {
          if (!fileItem.isDirectory) {
            void openFileEntry(fileItem);
          }
        });

        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();

          pane.querySelectorAll('.column-item').forEach((i) => {
            i.classList.remove('selected');
            i.setAttribute('aria-selected', 'false');
          });
          item.classList.add('selected');
          item.setAttribute('aria-selected', 'true');

          clearSelection();
          selectedItems.add(fileItem.path);

          const colPath = columnPaths[columnIndex];
          if (colPath && colPath !== currentPath) {
            currentPath = colPath;
            addressInput.value = colPath;
            updateBreadcrumb(colPath);
          }

          showContextMenu(e.pageX, e.pageY, fileItem);
        });

        item.draggable = true;

        item.addEventListener('dragstart', (e) => {
          e.stopPropagation();

          if (!item.classList.contains('selected')) {
            pane.querySelectorAll('.column-item').forEach((i) => {
              i.classList.remove('selected');
              i.setAttribute('aria-selected', 'false');
            });
            item.classList.add('selected');
            item.setAttribute('aria-selected', 'true');
            clearSelection();
            selectedItems.add(fileItem.path);
          }

          const selectedPaths = Array.from(selectedItems);
          e.dataTransfer!.effectAllowed = 'copyMove';
          e.dataTransfer!.setData('text/plain', JSON.stringify(selectedPaths));

          window.electronAPI.setDragData(selectedPaths);

          item.classList.add('dragging');
        });

        item.addEventListener('dragend', () => {
          item.classList.remove('dragging');
          document.querySelectorAll('.column-item.drag-over').forEach((el) => {
            el.classList.remove('drag-over');
          });
          window.electronAPI.clearDragData();
          clearSpringLoad();
          hideDropIndicator();
        });

        if (fileItem.isDirectory) {
          item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (
              !e.dataTransfer!.types.includes('text/plain') &&
              e.dataTransfer!.files.length === 0
            ) {
              e.dataTransfer!.dropEffect = 'none';
              return;
            }

            const operation = getDragOperation(e);
            e.dataTransfer!.dropEffect = operation;
            item.classList.add('drag-over');
            showDropIndicator(operation, fileItem.path, e.clientX, e.clientY);
            scheduleSpringLoad(item, () => {
              item.classList.remove('drag-over', 'spring-loading');
              handleColumnItemClick(item, fileItem.path, true, columnIndex);
            });
          });

          item.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = item.getBoundingClientRect();
            if (
              e.clientX < rect.left ||
              e.clientX >= rect.right ||
              e.clientY < rect.top ||
              e.clientY >= rect.bottom
            ) {
              item.classList.remove('drag-over');
              clearSpringLoad(item);
              hideDropIndicator();
            }
          });

          item.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            item.classList.remove('drag-over');
            clearSpringLoad(item);

            const draggedPaths = await getDraggedPaths(e);

            if (draggedPaths.length === 0 || draggedPaths.includes(fileItem.path)) {
              hideDropIndicator();
              return;
            }

            const operation = getDragOperation(e);
            await handleDrop(draggedPaths, fileItem.path, operation);
            hideDropIndicator();
          });
        }

        pane.appendChild(item);
      });
    }
  } catch {
    pane.innerHTML = '<div class="column-item" style="opacity: 0.5;">Error loading folder</div>';
  }

  addColumnResizeHandle(pane);
  return pane;
}

async function handleColumnItemClick(
  element: HTMLElement,
  path: string,
  isDirectory: boolean,
  _columnIndex: number
) {
  const currentPane = element.closest('.column-pane');
  if (!currentPane) return;

  cancelColumnOperations();
  const clickRenderId = ++columnViewRenderId;
  const allPanes = Array.from(columnView.querySelectorAll('.column-pane'));
  const currentPaneIndex = allPanes.indexOf(currentPane as Element);

  for (let i = allPanes.length - 1; i > currentPaneIndex; i--) {
    allPanes[i].remove();
  }
  columnPaths = columnPaths.slice(0, currentPaneIndex + 1);

  currentPane.querySelectorAll('.column-item').forEach((item) => {
    item.classList.remove('expanded', 'selected');
    item.setAttribute('aria-selected', 'false');
  });

  if (isDirectory) {
    element.classList.add('expanded');
    element.setAttribute('aria-selected', 'true');
    columnPaths.push(path);

    currentPath = path;
    addressInput.value = path;
    updateBreadcrumb(path);
    try {
      folderTreeManager.ensurePathVisible(path);
    } catch (error) {
      ignoreError(error);
    }

    const newPane = await renderColumn(path, currentPaneIndex + 1, clickRenderId);

    if (clickRenderId === columnViewRenderId && newPane) {
      columnView.appendChild(newPane);
    }

    setTimeout(() => {
      if (clickRenderId !== columnViewRenderId) return;
      columnView.scrollLeft = columnView.scrollWidth;
    }, 50);
  } else {
    element.classList.add('selected');
    element.setAttribute('aria-selected', 'true');
    clearSelection();
    selectedItems.add(path);

    const parentPath = columnPaths[currentPaneIndex];
    if (parentPath && parentPath !== currentPath) {
      currentPath = parentPath;
      addressInput.value = parentPath;
      updateBreadcrumb(parentPath);
      try {
        folderTreeManager.ensurePathVisible(parentPath);
      } catch (error) {
        ignoreError(error);
      }
    }

    const previewPanel = document.getElementById('preview-panel');
    if (previewPanel && previewPanel.style.display !== 'none') {
      let file = filePathMap.get(path);
      if (!file) {
        const fileName = path.split(/[\\/]/).pop() || '';
        file = {
          name: fileName,
          path: path,
          isDirectory: false,
          isFile: true,
          size: 0,
          modified: new Date(),
          isHidden: fileName.startsWith('.'),
        };
      }
      updatePreview(file);
    }
  }
}

function updateViewToggleButton() {
  if (viewMode === 'list') {
    viewToggleBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16">
        <rect x="2" y="3" width="12" height="2" fill="currentColor" rx="1"/>
        <rect x="2" y="7" width="12" height="2" fill="currentColor" rx="1"/>
        <rect x="2" y="11" width="12" height="2" fill="currentColor" rx="1"/>
      </svg>
    `;
    viewToggleBtn.title = 'Switch to Column View';
  } else if (viewMode === 'column') {
    viewToggleBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16">
        <rect x="1" y="2" width="4" height="12" fill="currentColor" rx="1"/>
        <rect x="6" y="2" width="4" height="12" fill="currentColor" rx="1"/>
        <rect x="11" y="2" width="4" height="12" fill="currentColor" rx="1"/>
      </svg>
    `;
    viewToggleBtn.title = 'Switch to Grid View';
  } else {
    viewToggleBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16">
        <rect x="2" y="2" width="5" height="5" fill="currentColor" rx="1"/>
        <rect x="9" y="2" width="5" height="5" fill="currentColor" rx="1"/>
        <rect x="2" y="9" width="5" height="5" fill="currentColor" rx="1"/>
        <rect x="9" y="9" width="5" height="5" fill="currentColor" rx="1"/>
      </svg>
    `;
    viewToggleBtn.title = 'Switch to List View';
  }
}

function updateViewModeControls() {
  updateViewToggleButton();
  if (viewOptions) {
    viewOptions.querySelectorAll('.view-option').forEach((btn) => {
      const view = (btn as HTMLElement).dataset.view;
      btn.classList.toggle('active', view === viewMode);
    });
  }
  if (listHeader) {
    listHeader.style.display =
      viewMode === 'list' && !isHomeViewPath(currentPath) ? 'grid' : 'none';
  }
}

function setupViewOptions(): void {
  if (!viewOptions) return;
  viewOptions.querySelectorAll('.view-option').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const view = (btn as HTMLElement).dataset.view as 'grid' | 'list' | 'column' | undefined;
      if (!view) return;
      await setViewMode(view);
    });
  });
  updateViewModeControls();
}

async function createNewFile() {
  await createNewFileWithInlineRename();
}

async function createNewFolder() {
  await createNewFolderWithInlineRename();
}

async function createNewFileWithInlineRename() {
  if (!currentPath || isHomeViewPath(currentPath)) {
    showToast('Open a folder to create a file', 'Create', 'info');
    return;
  }
  const fileName = 'File';
  let counter = 1;
  let finalFileName = fileName;

  const existingNames = new Set(allFiles.map((f) => f.name));

  while (existingNames.has(finalFileName)) {
    finalFileName = `${fileName} (${counter})`;
    counter++;
  }

  const result = await window.electronAPI.createFile(currentPath, finalFileName);
  if (result.success && result.path) {
    const createdFilePath = result.path;
    await navigateTo(currentPath);

    setTimeout(() => {
      const fileItems = document.querySelectorAll('.file-item');
      for (const item of Array.from(fileItems)) {
        const nameElement = item.querySelector('.file-name');
        if (nameElement && nameElement.textContent === finalFileName) {
          startInlineRename(item as HTMLElement, finalFileName, createdFilePath);
          break;
        }
      }
    }, 100);
  } else {
    await showAlert(result.error || 'Unknown error', 'Error Creating File', 'error');
  }
}

async function createNewFolderWithInlineRename() {
  if (!currentPath || isHomeViewPath(currentPath)) {
    showToast('Open a folder to create a folder', 'Create', 'info');
    return;
  }
  const folderName = 'New Folder';
  let counter = 1;
  let finalFolderName = folderName;

  const existingNames = new Set(allFiles.map((f) => f.name));

  while (existingNames.has(finalFolderName)) {
    finalFolderName = `${folderName} (${counter})`;
    counter++;
  }

  const result = await window.electronAPI.createFolder(currentPath, finalFolderName);
  if (result.success && result.path) {
    const createdFolderPath = result.path;
    await navigateTo(currentPath);

    setTimeout(() => {
      const fileItems = document.querySelectorAll('.file-item');
      for (const item of Array.from(fileItems)) {
        const nameElement = item.querySelector('.file-name');
        if (nameElement && nameElement.textContent === finalFolderName) {
          startInlineRename(item as HTMLElement, finalFolderName, createdFolderPath);
          break;
        }
      }
    }, 100);
  } else {
    await showAlert(result.error || 'Unknown error', 'Error Creating Folder', 'error');
  }
}

function startInlineRename(fileItem: HTMLElement, currentName: string, itemPath: string) {
  const nameElement = fileItem.querySelector('.file-name') as HTMLElement | null;
  if (!nameElement) return;

  if (fileItem.classList.contains('renaming')) return;

  nameElement.style.display = 'none';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file-name-input';
  input.value = currentName;
  const nameContainer = fileItem.querySelector('.file-text') as HTMLElement | null;
  (nameContainer || fileItem).appendChild(input);

  fileItem.classList.add('renaming');

  input.focus();

  const lastDotIndex = currentName.lastIndexOf('.');
  if (lastDotIndex > 0) {
    input.setSelectionRange(0, lastDotIndex);
  } else {
    input.select();
  }

  let renameHandled = false;

  const finishRename = async () => {
    if (renameHandled) {
      return;
    }
    renameHandled = true;

    input.removeEventListener('blur', finishRename);
    input.removeEventListener('keypress', handleKeyPress);
    input.removeEventListener('keydown', handleKeyDown);

    const newName = input.value.trim();

    if (newName && newName !== currentName) {
      const result = await window.electronAPI.renameItem(itemPath, newName);
      if (result.success) {
        await navigateTo(currentPath);
      } else {
        await showAlert(result.error || 'Unknown error', 'Error Renaming', 'error');
        nameElement.style.display = '';
        input.remove();
        fileItem.classList.remove('renaming');
      }
    } else {
      nameElement.style.display = '';
      input.remove();
      fileItem.classList.remove('renaming');
    }
  };

  const handleKeyPress = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      finishRename();
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      renameHandled = true;
      input.removeEventListener('blur', finishRename);
      input.removeEventListener('keypress', handleKeyPress);
      input.removeEventListener('keydown', handleKeyDown);
      nameElement.style.display = '';
      input.remove();
      fileItem.classList.remove('renaming');
    }
  };

  input.addEventListener('blur', finishRename);
  input.addEventListener('keypress', handleKeyPress);
  input.addEventListener('keydown', handleKeyDown);
}

function showContextMenu(x: number, y: number, item: FileItem) {
  const contextMenu = document.getElementById('context-menu');
  const addToBookmarksItem = document.getElementById('add-to-bookmarks-item');
  const changeFolderIconItem = document.getElementById('change-folder-icon-item');
  const copyPathItem = document.getElementById('copy-path-item');
  const openTerminalItem = document.getElementById('open-terminal-item');
  const compressItem = document.getElementById('compress-item');
  const extractItem = document.getElementById('extract-item');
  const previewPdfItem = document.getElementById('preview-pdf-item');

  if (!contextMenu) return;

  hideEmptySpaceContextMenu();

  contextMenuData = item;
  contextMenuFocusedIndex = -1;

  if (addToBookmarksItem) {
    if (item.isDirectory) {
      addToBookmarksItem.style.display = 'flex';
    } else {
      addToBookmarksItem.style.display = 'none';
    }
  }

  if (changeFolderIconItem) {
    if (item.isDirectory) {
      changeFolderIconItem.style.display = 'flex';
    } else {
      changeFolderIconItem.style.display = 'none';
    }
  }

  if (copyPathItem) {
    if (!item.isDirectory) {
      copyPathItem.style.display = 'flex';
    } else {
      copyPathItem.style.display = 'none';
    }
  }

  if (openTerminalItem) {
    if (item.isDirectory) {
      openTerminalItem.style.display = 'flex';
    } else {
      openTerminalItem.style.display = 'none';
    }
  }

  if (compressItem) {
    compressItem.style.display = 'flex';
  }

  if (extractItem) {
    const isArchive = !item.isDirectory && isArchivePath(item.path);
    extractItem.style.display = isArchive ? 'flex' : 'none';
  }

  if (previewPdfItem) {
    const ext = getFileExtension(item.name);
    previewPdfItem.style.display = !item.isDirectory && PDF_EXTENSIONS.has(ext) ? 'flex' : 'none';
  }

  contextMenu.style.display = 'block';

  const menuRect = contextMenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = x;
  let top = y;

  if (y + menuRect.height > viewportHeight - 10) {
    top = y - menuRect.height;
  }

  if (left + menuRect.width > viewportWidth - 10) {
    left = viewportWidth - menuRect.width - 10;
  }

  if (top < 10) {
    top = 10;
  }

  if (left < 10) {
    left = 10;
  }

  if (top + menuRect.height > viewportHeight - 10) {
    top = viewportHeight - menuRect.height - 10;
  }

  contextMenu.style.left = left + 'px';
  contextMenu.style.top = top + 'px';

  const submenu = contextMenu.querySelector('.context-submenu') as HTMLElement;
  if (submenu) {
    submenu.classList.remove('flip-left');
    const menuRight = left + menuRect.width;
    const submenuWidth = 160;

    if (menuRight + submenuWidth > viewportWidth - 10) {
      submenu.classList.add('flip-left');
    }
  }

  contextMenuFocusedIndex = navigateContextMenu(contextMenu, 'down', contextMenuFocusedIndex);
}

let contextMenuFocusedIndex = -1;
let emptySpaceMenuFocusedIndex = -1;

function hideContextMenu() {
  const contextMenuElement = document.getElementById('context-menu');
  if (contextMenuElement) {
    contextMenuElement.style.display = 'none';
    contextMenuData = null;
    clearContextMenuFocus(contextMenuElement);
    contextMenuFocusedIndex = -1;
  }
}

function clearContextMenuFocus(menu: HTMLElement) {
  menu.querySelectorAll('.context-menu-item.focused').forEach((item) => {
    item.classList.remove('focused');
  });
}

function getVisibleMenuItems(menu: HTMLElement): HTMLElement[] {
  const items = menu.querySelectorAll('.context-menu-item');
  return Array.from(items).filter((item) => {
    const el = item as HTMLElement;
    const parent = el.parentElement;
    if (parent?.classList.contains('context-submenu')) return false;
    return el.style.display !== 'none' && el.offsetParent !== null;
  }) as HTMLElement[];
}

function navigateContextMenu(
  menu: HTMLElement,
  direction: 'up' | 'down',
  focusIndex: number
): number {
  const items = getVisibleMenuItems(menu);
  if (items.length === 0) return -1;

  clearContextMenuFocus(menu);

  let newIndex = focusIndex;
  if (direction === 'down') {
    newIndex = focusIndex < items.length - 1 ? focusIndex + 1 : 0;
  } else {
    newIndex = focusIndex > 0 ? focusIndex - 1 : items.length - 1;
  }

  items[newIndex].classList.add('focused');
  items[newIndex].scrollIntoView({ block: 'nearest' });
  items[newIndex].focus({ preventScroll: true });
  return newIndex;
}

function activateContextMenuItem(menu: HTMLElement, focusIndex: number): boolean {
  const items = getVisibleMenuItems(menu);
  if (focusIndex < 0 || focusIndex >= items.length) return false;

  const item = items[focusIndex];
  if (item.classList.contains('has-submenu')) {
    const submenu = item.querySelector('.context-submenu') as HTMLElement;
    if (submenu) {
      submenu.style.display = 'block';
      const submenuItems = submenu.querySelectorAll(
        '.context-menu-item'
      ) as NodeListOf<HTMLElement>;
      if (submenuItems.length > 0) {
        submenuItems[0].classList.add('focused');
        submenuItems[0].focus({ preventScroll: true });
      }
    }
    return false;
  }

  item.click();
  return true;
}

function showEmptySpaceContextMenu(x: number, y: number) {
  const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');
  if (!emptySpaceContextMenu) return;

  hideContextMenu();

  emptySpaceMenuFocusedIndex = -1;
  emptySpaceContextMenu.style.display = 'block';

  const menuRect = emptySpaceContextMenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = x;
  let top = y;

  if (y + menuRect.height > viewportHeight - 10) {
    top = y - menuRect.height;
  }

  if (left + menuRect.width > viewportWidth - 10) {
    left = viewportWidth - menuRect.width - 10;
  }

  if (top < 10) {
    top = 10;
  }

  if (left < 10) {
    left = 10;
  }

  if (top + menuRect.height > viewportHeight - 10) {
    top = viewportHeight - menuRect.height - 10;
  }

  emptySpaceContextMenu.style.left = left + 'px';
  emptySpaceContextMenu.style.top = top + 'px';
  emptySpaceMenuFocusedIndex = navigateContextMenu(
    emptySpaceContextMenu,
    'down',
    emptySpaceMenuFocusedIndex
  );
}

function hideEmptySpaceContextMenu() {
  const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');
  if (emptySpaceContextMenu) {
    emptySpaceContextMenu.style.display = 'none';
    clearContextMenuFocus(emptySpaceContextMenu);
    emptySpaceMenuFocusedIndex = -1;
  }
}

async function handleEmptySpaceContextMenuAction(action: string | undefined) {
  switch (action) {
    case 'new-folder':
      await createNewFolderWithInlineRename();
      break;

    case 'new-file':
      await createNewFileWithInlineRename();
      break;

    case 'paste':
      await pasteFromClipboard();
      break;

    case 'refresh':
      await navigateTo(currentPath);
      break;

    case 'open-terminal': {
      const terminalResult = await window.electronAPI.openTerminal(currentPath);
      if (!terminalResult.success) {
        showToast(terminalResult.error || 'Failed to open terminal', 'Error', 'error');
      }
      break;
    }
  }

  hideEmptySpaceContextMenu();
}

async function handleContextMenuAction(
  action: string | undefined,
  item: FileItem,
  format?: string
) {
  switch (action) {
    case 'open':
      await openFileEntry(item);
      break;

    case 'preview-pdf':
      await showQuickLookForFile(item);
      break;

    case 'rename': {
      const fileItems = document.querySelectorAll('.file-item');
      for (const fileItem of Array.from(fileItems)) {
        if ((fileItem as HTMLElement).dataset.path === item.path) {
          startInlineRename(fileItem as HTMLElement, item.name, item.path);
          break;
        }
      }
      break;
    }

    case 'copy':
      copyToClipboard();
      break;

    case 'cut':
      cutToClipboard();
      break;

    case 'copy-path':
      try {
        await navigator.clipboard.writeText(item.path);
        showToast('File path copied to clipboard', 'Success', 'success');
      } catch {
        showToast('Failed to copy file path', 'Error', 'error');
      }
      break;

    case 'add-to-bookmarks':
      if (item.isDirectory) {
        await addBookmarkByPath(item.path);
      }
      break;

    case 'change-folder-icon':
      if (item.isDirectory) {
        showFolderIconPicker(item.path);
      }
      break;

    case 'open-terminal': {
      const terminalPath = item.isDirectory ? item.path : path.dirname(item.path);
      const terminalResult = await window.electronAPI.openTerminal(terminalPath);
      if (!terminalResult.success) {
        showToast(terminalResult.error || 'Failed to open terminal', 'Error', 'error');
      }
      break;
    }

    case 'properties': {
      const propsResult = await window.electronAPI.getItemProperties(item.path);
      if (propsResult.success && propsResult.properties) {
        showPropertiesDialog(propsResult.properties);
      } else {
        showToast(propsResult.error || 'Unknown error', 'Error Getting Properties', 'error');
      }
      break;
    }

    case 'delete':
      await deleteSelected();
      break;

    case 'compress':
      await handleCompress(format || 'zip');
      break;

    case 'extract':
      showExtractModal(item.path, item.name);
      break;
  }
}

async function handleCompress(format: string = 'zip') {
  const selectedPaths = Array.from(selectedItems);

  if (selectedPaths.length === 0) {
    showToast('No items selected', 'Error', 'error');
    return;
  }

  const extensionMap: Record<string, string> = {
    zip: '.zip',
    '7z': '.7z',
    tar: '.tar',
    'tar.gz': '.tar.gz',
  };

  const extension = extensionMap[format] || '.zip';

  let archiveName: string;
  if (selectedPaths.length === 1) {
    const itemName = path.basename(selectedPaths[0]);
    const nameWithoutExt = itemName.replace(/\.[^/.]+$/, '');
    archiveName = `${nameWithoutExt}${extension}`;
  } else {
    const folderName = path.basename(currentPath);
    archiveName = `${folderName}_${selectedPaths.length}_items${extension}`;
  }

  const outputPath = path.join(currentPath, archiveName);
  const operationId = generateOperationId();

  addOperation(operationId, 'compress', archiveName);

  const progressHandler = (progress: {
    operationId?: string;
    current: number;
    total: number;
    name: string;
  }) => {
    if (progress.operationId === operationId) {
      const operation = getOperation(operationId);
      if (operation && !operation.aborted) {
        updateOperation(operationId, progress.current, progress.total, progress.name);
      }
    }
  };

  // Store cleanup function to prevent memory leaks
  const cleanupProgressHandler = window.electronAPI.onCompressProgress(progressHandler);

  try {
    const operation = getOperation(operationId);
    if (operation?.aborted) {
      cleanupProgressHandler();
      removeOperation(operationId);
      return;
    }

    const result = await window.electronAPI.compressFiles(
      selectedPaths,
      outputPath,
      format,
      operationId
    );

    cleanupProgressHandler();
    removeOperation(operationId);

    if (result.success) {
      showToast(`Created ${archiveName}`, 'Compressed Successfully', 'success');
      await navigateTo(currentPath);
    } else {
      showToast(result.error || 'Compression failed', 'Error', 'error');
    }
  } catch (error) {
    cleanupProgressHandler();
    removeOperation(operationId);
    showToast(getErrorMessage(error), 'Compression Error', 'error');
  }
}

function isArchivePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return ARCHIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function getArchiveBaseName(filePath: string): string {
  const lower = filePath.toLowerCase();
  const fileName = path.basename(filePath);
  if (lower.endsWith('.tar.gz')) {
    return fileName.replace(/\.tar\.gz$/i, '');
  }
  return path.basename(filePath, path.extname(filePath));
}

function joinFilePath(baseFolder: string, ...segments: string[]): string {
  if (!isWindowsPlatform()) {
    const normalizedBase = baseFolder.replace(/\\/g, '/');
    const normalizedSegments = segments.map((segment) => segment.replace(/\\/g, '/'));
    return path.join(normalizedBase, ...normalizedSegments);
  }

  const normalizedBase = normalizeWindowsPath(baseFolder);
  let combined = normalizedBase;
  for (const segment of segments) {
    const cleaned = segment
      .replace(/[\\/]+/g, '\\')
      .replace(/^\\+/, '')
      .replace(/\\+$/, '');
    if (!cleaned) continue;
    if (!combined.endsWith('\\')) {
      combined += '\\';
    }
    combined += cleaned;
  }
  return combined;
}

function buildArchiveExtractPath(baseFolder: string, archivePath: string): string {
  return joinFilePath(baseFolder, getArchiveBaseName(archivePath));
}

let extractModalArchivePath: string | null = null;
let extractModalTrackRecent = true;

function updateExtractPreview(baseFolder: string): void {
  const preview = document.getElementById('extract-preview-path');
  if (!preview || !extractModalArchivePath) return;
  if (!baseFolder) {
    preview.textContent = '';
    return;
  }
  preview.textContent = buildArchiveExtractPath(baseFolder, extractModalArchivePath);
}

function showExtractModal(
  archivePath: string,
  archiveName?: string,
  trackRecent: boolean = true
): void {
  const modal = document.getElementById('extract-modal') as HTMLElement | null;
  const message = document.getElementById('extract-modal-message') as HTMLElement | null;
  const input = document.getElementById('extract-destination-input') as HTMLInputElement | null;

  if (!modal || !message || !input) return;

  const name = archiveName || path.basename(archivePath);
  extractModalArchivePath = archivePath;
  extractModalTrackRecent = trackRecent;

  const baseFolder = path.dirname(archivePath);
  input.value = baseFolder;
  message.textContent = `Extract ${name}?`;
  updateExtractPreview(baseFolder);

  modal.style.display = 'flex';
  activateModal(modal);
  input.focus();
  input.select();
}

function hideExtractModal(): void {
  const modal = document.getElementById('extract-modal') as HTMLElement | null;
  if (modal) {
    modal.style.display = 'none';
    deactivateModal(modal);
  }
  extractModalArchivePath = null;
  extractModalTrackRecent = true;
}

async function openPathWithArchivePrompt(
  filePath: string,
  fileName?: string,
  trackRecent: boolean = true
): Promise<void> {
  if (!filePath) return;
  if (isArchivePath(filePath)) {
    showExtractModal(filePath, fileName, trackRecent);
    return;
  }
  await window.electronAPI.openFile(filePath);
  if (trackRecent) {
    addToRecentFiles(filePath);
  }
}

async function openFileEntry(item: FileItem): Promise<void> {
  if (item.isDirectory) {
    navigateTo(item.path);
    return;
  }
  await openPathWithArchivePrompt(item.path, item.name);
}

async function confirmExtractModal(): Promise<void> {
  const input = document.getElementById('extract-destination-input') as HTMLInputElement | null;
  if (!input || !extractModalArchivePath) return;
  const baseFolder = input.value.trim();
  if (!baseFolder) {
    showToast('Choose a destination folder', 'Missing Destination', 'warning');
    input.focus();
    return;
  }
  const archivePath = extractModalArchivePath;
  const trackRecent = extractModalTrackRecent;
  hideExtractModal();
  await handleExtract(archivePath, baseFolder, trackRecent);
}

async function handleExtract(
  archivePath: string,
  destBaseFolder: string,
  trackRecent: boolean = true
) {
  const baseFolder = destBaseFolder.trim();
  if (!baseFolder) {
    showToast('Choose a destination folder', 'Missing Destination', 'warning');
    return;
  }

  if (!isArchivePath(archivePath)) {
    showToast(
      'Unsupported archive format. Supported: .zip, .7z, .rar, .tar.gz, and more',
      'Error',
      'error'
    );
    return;
  }

  const baseName = getArchiveBaseName(archivePath);
  const destPath = buildArchiveExtractPath(baseFolder, archivePath);
  const operationId = generateOperationId();

  addOperation(operationId, 'extract', baseName);

  const progressHandler = (progress: {
    operationId?: string;
    current: number;
    total: number;
    name: string;
  }) => {
    if (progress.operationId === operationId) {
      const operation = getOperation(operationId);
      if (operation && !operation.aborted) {
        updateOperation(operationId, progress.current, progress.total, progress.name);
      }
    }
  };

  const cleanupProgressHandler = window.electronAPI.onExtractProgress(progressHandler);

  try {
    const operation = getOperation(operationId);
    if (operation?.aborted) {
      cleanupProgressHandler();
      removeOperation(operationId);
      return;
    }

    const result = await window.electronAPI.extractArchive(archivePath, destPath, operationId);

    cleanupProgressHandler();
    removeOperation(operationId);

    if (result.success) {
      showToast(`Extracted to ${destPath}`, 'Extraction Complete', 'success');
      if (trackRecent) {
        addToRecentFiles(archivePath);
      }
      if (currentPath === baseFolder) {
        await navigateTo(currentPath);
      }
    } else {
      showToast(result.error || 'Extraction failed', 'Error', 'error');
    }
  } catch (error) {
    cleanupProgressHandler();
    removeOperation(operationId);
    showToast(getErrorMessage(error), 'Extraction Error', 'error');
  }
}

let activePropertiesCleanup: (() => void) | null = null;

function showPropertiesDialog(props: ItemProperties) {
  if (activePropertiesCleanup) {
    activePropertiesCleanup();
    activePropertiesCleanup = null;
  }

  const modal = document.getElementById('properties-modal');
  const content = document.getElementById('properties-content');

  if (!modal || !content) return;

  // unique op IDs
  const folderSizeOperationId = `foldersize_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  const checksumOperationId = `checksum_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

  let folderSizeActive = false;
  let checksumActive = false;
  let folderSizeProgressCleanup: (() => void) | null = null;
  let checksumProgressCleanup: (() => void) | null = null;

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 bytes';
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const size = (bytes / Math.pow(1024, i)).toFixed(2);
    return `${bytes.toLocaleString()} bytes (${size} ${units[i]})`;
  };

  const sizeDisplay = formatSize(props.size);

  let html = `
    <div class="property-row">
      <div class="property-label">Name:</div>
      <div class="property-value">${escapeHtml(props.name)}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Type:</div>
      <div class="property-value">${props.isDirectory ? 'Folder' : 'File'}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Size:</div>
      <div class="property-value" id="props-size-value">${sizeDisplay}</div>
    </div>`;

  if (props.isDirectory) {
    html += `
    <div class="property-row property-folder-size">
      <div class="property-label">Contents:</div>
      <div class="property-value">
        <span id="folder-size-info">Not calculated</span>
        <button class="property-btn" id="calculate-folder-size-btn">${twemojiImg(String.fromCodePoint(0x1f4ca), 'twemoji')} Calculate Size</button>
      </div>
    </div>
    <div class="property-row" id="folder-size-progress-row" style="display: none;">
      <div class="property-label"></div>
      <div class="property-value">
        <div class="property-progress-container">
          <div class="property-progress-bar" id="folder-size-progress-bar"></div>
        </div>
        <div class="property-progress-text" id="folder-size-progress-text">Calculating...</div>
        <button class="property-btn property-btn-cancel" id="cancel-folder-size-btn">${twemojiImg(String.fromCodePoint(0x274c), 'twemoji')} Cancel</button>
      </div>
    </div>
    <div class="property-row" id="folder-stats-row" style="display: none;">
      <div class="property-label">File Types:</div>
      <div class="property-value">
        <div id="folder-stats-content" class="folder-stats-content"></div>
      </div>
    </div>`;
  }

  html += `
    <div class="property-row">
      <div class="property-label">Location:</div>
      <div class="property-value property-path">${escapeHtml(props.path)}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Created:</div>
      <div class="property-value">${new Date(props.created).toLocaleString()}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Modified:</div>
      <div class="property-value">${new Date(props.modified).toLocaleString()}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Accessed:</div>
      <div class="property-value">${new Date(props.accessed).toLocaleString()}</div>
    </div>`;

  if (props.isFile) {
    html += `
    <div class="property-separator"></div>
    <div class="property-row property-checksum-header">
      <div class="property-label">Checksums:</div>
      <div class="property-value">
        <button class="property-btn" id="calculate-checksum-btn">${twemojiImg(String.fromCodePoint(0x1f510), 'twemoji')} Calculate Checksums</button>
      </div>
    </div>
    <div class="property-row" id="checksum-progress-row" style="display: none;">
      <div class="property-label"></div>
      <div class="property-value">
        <div class="property-progress-container">
          <div class="property-progress-bar" id="checksum-progress-bar"></div>
        </div>
        <div class="property-progress-text" id="checksum-progress-text">Calculating...</div>
        <button class="property-btn property-btn-cancel" id="cancel-checksum-btn">${twemojiImg(String.fromCodePoint(0x274c), 'twemoji')} Cancel</button>
      </div>
    </div>
    <div class="property-row" id="checksum-md5-row" style="display: none;">
      <div class="property-label">MD5:</div>
      <div class="property-value property-checksum">
        <code id="checksum-md5-value"></code>
        <button class="property-btn-copy" id="copy-md5-btn" title="Copy MD5">${twemojiImg(String.fromCodePoint(0x1f4cb), 'twemoji')}</button>
      </div>
    </div>
    <div class="property-row" id="checksum-sha256-row" style="display: none;">
      <div class="property-label">SHA-256:</div>
      <div class="property-value property-checksum">
        <code id="checksum-sha256-value"></code>
        <button class="property-btn-copy" id="copy-sha256-btn" title="Copy SHA-256">${twemojiImg(String.fromCodePoint(0x1f4cb), 'twemoji')}</button>
      </div>
    </div>`;
  }

  content.innerHTML = html;
  modal.style.display = 'flex';
  activateModal(modal);

  const cleanup = () => {
    if (folderSizeActive) {
      window.electronAPI.cancelFolderSizeCalculation(folderSizeOperationId);
      folderSizeActive = false;
    }
    if (checksumActive) {
      window.electronAPI.cancelChecksumCalculation(checksumOperationId);
      checksumActive = false;
    }
    if (folderSizeProgressCleanup) {
      folderSizeProgressCleanup();
      folderSizeProgressCleanup = null;
    }
    if (checksumProgressCleanup) {
      checksumProgressCleanup();
      checksumProgressCleanup = null;
    }
    activePropertiesCleanup = null;
  };

  activePropertiesCleanup = cleanup;

  const closeModal = () => {
    cleanup();
    modal.style.display = 'none';
    deactivateModal(modal);
  };

  if (props.isDirectory) {
    const calculateBtn = document.getElementById('calculate-folder-size-btn');
    const cancelBtn = document.getElementById('cancel-folder-size-btn');
    const progressRow = document.getElementById('folder-size-progress-row');
    const progressBar = document.getElementById('folder-size-progress-bar');
    const progressText = document.getElementById('folder-size-progress-text');
    const sizeInfo = document.getElementById('folder-size-info');

    if (calculateBtn) {
      calculateBtn.addEventListener('click', async () => {
        calculateBtn.style.display = 'none';
        if (progressRow) progressRow.style.display = 'flex';
        folderSizeActive = true;

        // progress listener
        folderSizeProgressCleanup = window.electronAPI.onFolderSizeProgress((progress) => {
          if (progress.operationId === folderSizeOperationId && progressBar && progressText) {
            const currentSize = formatSize(progress.calculatedSize);
            progressText.textContent = `${progress.fileCount} files, ${progress.folderCount} folders - ${currentSize}`;
            progressBar.style.width = '100%';
            progressBar.classList.add('indeterminate');
          }
        });

        try {
          const result = await window.electronAPI.calculateFolderSize(
            props.path,
            folderSizeOperationId
          );

          if (result.success && result.result) {
            const totalSize = formatSize(result.result.totalSize);
            if (sizeInfo) {
              sizeInfo.textContent = `${result.result.fileCount} files, ${result.result.folderCount} folders (${totalSize})`;
            }
            const propsSize = document.getElementById('props-size-value');
            if (propsSize) {
              propsSize.textContent = totalSize;
            }

            if (result.result.fileTypes && result.result.fileTypes.length > 0) {
              const statsRow = document.getElementById('folder-stats-row');
              const statsContent = document.getElementById('folder-stats-content');
              if (statsRow && statsContent) {
                statsRow.style.display = 'flex';
                const formatBytes = (bytes: number): string => {
                  if (bytes === 0) return '0 B';
                  const units = ['B', 'KB', 'MB', 'GB'];
                  const i = Math.floor(Math.log(bytes) / Math.log(1024));
                  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
                };
                statsContent.innerHTML = result.result.fileTypes
                  .map((ft) => {
                    const pct =
                      result.result!.totalSize > 0
                        ? ((ft.size / result.result!.totalSize) * 100).toFixed(1)
                        : '0';
                    return `<div class="file-type-stat">
                    <span class="file-type-ext">${escapeHtml(ft.extension)}</span>
                    <span class="file-type-count">${ft.count} files</span>
                    <span class="file-type-size">${formatBytes(ft.size)} (${pct}%)</span>
                    <div class="file-type-bar" style="width: ${pct}%"></div>
                  </div>`;
                  })
                  .join('');
              }
            }
          } else if (result.error !== 'Calculation cancelled') {
            if (sizeInfo) sizeInfo.textContent = `Error: ${result.error}`;
          }
        } catch (err) {
          if (sizeInfo) sizeInfo.textContent = `Error: ${getErrorMessage(err)}`;
        } finally {
          folderSizeActive = false;
          if (folderSizeProgressCleanup) {
            folderSizeProgressCleanup();
            folderSizeProgressCleanup = null;
          }
          if (progressRow) progressRow.style.display = 'none';
          if (progressBar) {
            progressBar.classList.remove('indeterminate');
            progressBar.style.width = '0%';
          }
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (folderSizeActive) {
          window.electronAPI.cancelFolderSizeCalculation(folderSizeOperationId);
          folderSizeActive = false;
        }
        if (folderSizeProgressCleanup) {
          folderSizeProgressCleanup();
          folderSizeProgressCleanup = null;
        }
        if (progressRow) progressRow.style.display = 'none';
        if (calculateBtn) calculateBtn.style.display = 'inline-flex';
        if (sizeInfo) sizeInfo.textContent = 'Calculation cancelled';
      });
    }
  }

  // checksum calculation
  if (props.isFile) {
    const calculateBtn = document.getElementById('calculate-checksum-btn');
    const cancelBtn = document.getElementById('cancel-checksum-btn');
    const progressRow = document.getElementById('checksum-progress-row');
    const progressBar = document.getElementById('checksum-progress-bar');
    const progressText = document.getElementById('checksum-progress-text');
    const md5Row = document.getElementById('checksum-md5-row');
    const sha256Row = document.getElementById('checksum-sha256-row');
    const md5Value = document.getElementById('checksum-md5-value');
    const sha256Value = document.getElementById('checksum-sha256-value');
    const copyMd5Btn = document.getElementById('copy-md5-btn');
    const copySha256Btn = document.getElementById('copy-sha256-btn');

    if (calculateBtn) {
      calculateBtn.addEventListener('click', async () => {
        calculateBtn.style.display = 'none';
        if (progressRow) progressRow.style.display = 'flex';
        checksumActive = true;

        checksumProgressCleanup = window.electronAPI.onChecksumProgress((progress) => {
          if (progress.operationId === checksumOperationId && progressBar && progressText) {
            progressBar.style.width = `${progress.percent}%`;
            progressText.textContent = `Calculating ${progress.algorithm.toUpperCase()}... ${progress.percent.toFixed(1)}%`;
          }
        });

        try {
          const result = await window.electronAPI.calculateChecksum(
            props.path,
            checksumOperationId,
            ['md5', 'sha256']
          );

          if (result.success && result.result) {
            if (result.result.md5 && md5Row && md5Value) {
              md5Value.textContent = result.result.md5;
              md5Row.style.display = 'flex';
            }
            if (result.result.sha256 && sha256Row && sha256Value) {
              sha256Value.textContent = result.result.sha256;
              sha256Row.style.display = 'flex';
            }
          } else if (result.error !== 'Calculation cancelled') {
            showToast(result.error || 'Checksum calculation failed', 'Error', 'error');
          }
        } catch (err) {
          showToast(getErrorMessage(err), 'Error', 'error');
        } finally {
          checksumActive = false;
          if (checksumProgressCleanup) {
            checksumProgressCleanup();
            checksumProgressCleanup = null;
          }
          if (progressRow) progressRow.style.display = 'none';
          if (progressBar) progressBar.style.width = '0%';
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (checksumActive) {
          window.electronAPI.cancelChecksumCalculation(checksumOperationId);
          checksumActive = false;
        }
        if (checksumProgressCleanup) {
          checksumProgressCleanup();
          checksumProgressCleanup = null;
        }
        if (progressRow) progressRow.style.display = 'none';
        if (calculateBtn) calculateBtn.style.display = 'inline-flex';
      });
    }

    if (copyMd5Btn && md5Value) {
      copyMd5Btn.addEventListener('click', () => {
        navigator.clipboard.writeText(md5Value.textContent || '');
        showToast('MD5 copied to clipboard', 'Copied', 'success');
      });
    }

    if (copySha256Btn && sha256Value) {
      copySha256Btn.addEventListener('click', () => {
        navigator.clipboard.writeText(sha256Value.textContent || '');
        showToast('SHA-256 copied to clipboard', 'Copied', 'success');
      });
    }
  }

  const propsCloseBtn = document.getElementById('properties-close');
  const propsOkBtn = document.getElementById('properties-ok');
  if (propsCloseBtn) propsCloseBtn.onclick = closeModal;
  if (propsOkBtn) propsOkBtn.onclick = closeModal;
  modal.onclick = (e) => {
    if (e.target === modal) closeModal();
  };
}

async function restartAsAdmin() {
  const confirmed = await showDialog(
    'Restart as Administrator',
    "Restarting the app with elevated permissions can lead to possible damage of your computer/files if you don't know what you're doing.",
    'warning',
    true
  );

  if (confirmed) {
    const result = await window.electronAPI.restartAsAdmin();
    if (!result.success) {
      showToast(
        result.error || 'Failed to restart with admin privileges',
        'Restart Failed',
        'error'
      );
    }
  }
}

async function checkForUpdates() {
  const btn = document.getElementById('check-updates-btn') as HTMLButtonElement;
  if (!btn) return;

  const originalHTML = btn.innerHTML;
  btn.innerHTML = `${twemojiImg(String.fromCodePoint(0x1f504), 'twemoji')} Checking...`;
  btn.disabled = true;

  try {
    const result = await window.electronAPI.checkForUpdates();

    if (result.success) {
      if (result.isFlatpak) {
        showDialog(
          'Updates via Flatpak',
          `You're running IYERIS as a Flatpak (${result.currentVersion}).\n\n${result.flatpakMessage}\n\nOr use your system's software center to check for updates.`,
          'info',
          false
        );
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        return;
      }

      if (result.isMas) {
        showDialog(
          'Updates via App Store',
          `You're running IYERIS from the Mac App Store (${result.currentVersion}).\n\n${result.masMessage}`,
          'info',
          false
        );
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        return;
      }

      if (result.isMsStore) {
        showDialog(
          'Updates via Microsoft Store',
          `You're running IYERIS from the Microsoft Store (${result.currentVersion}).\n\n${result.msStoreMessage}`,
          'info',
          false
        );
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        return;
      }

      if (result.isMsi) {
        showDialog(
          'Enterprise Installation',
          `You're running IYERIS as an enterprise installation (${result.currentVersion}).\n\n${result.msiMessage}`,
          'info',
          false
        );
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        return;
      }

      if (result.hasUpdate) {
        const updateTitle = result.isBeta ? 'Beta Update Available' : 'Update Available';
        const updateMessage = result.isBeta
          ? `[BETA CHANNEL] A new beta build is available!\n\nCurrent Version: ${result.currentVersion}\nNew Version: ${result.latestVersion}\n\nWould you like to download and install the update?`
          : `A new version is available!\n\nCurrent Version: ${result.currentVersion}\nNew Version: ${result.latestVersion}\n\nWould you like to download and install the update?`;

        const confirmed = await showDialog(updateTitle, updateMessage, 'success', true);

        if (confirmed) {
          await downloadAndInstallUpdate();
        }
      } else {
        if (result.isBeta) {
          showDialog(
            'No Updates Available',
            `You're on the latest beta channel build (${result.currentVersion})!`,
            'info',
            false
          );
        } else {
          showDialog(
            'No Updates Available',
            `You're running the latest version (${result.currentVersion})!`,
            'info',
            false
          );
        }
      }
    } else {
      showDialog(
        'Update Check Failed',
        `Failed to check for updates: ${result.error}`,
        'error',
        false
      );
    }
  } catch (error) {
    showDialog(
      'Update Check Failed',
      `An error occurred while checking for updates: ${getErrorMessage(error)}`,
      'error',
      false
    );
  } finally {
    btn.innerHTML = originalHTML;
    btn.disabled = false;
  }
}

async function downloadAndInstallUpdate() {
  const dialogModal = document.getElementById('dialog-modal') as HTMLElement;
  const dialogTitle = document.getElementById('dialog-title') as HTMLElement;
  const dialogContent = document.getElementById('dialog-content') as HTMLElement;
  const dialogIcon = document.getElementById('dialog-icon') as HTMLElement;
  const dialogOk = document.getElementById('dialog-ok') as HTMLButtonElement;
  const dialogCancel = document.getElementById('dialog-cancel') as HTMLButtonElement;

  dialogIcon.textContent = '⬇️';
  dialogTitle.textContent = 'Downloading Update';
  dialogContent.textContent = 'Preparing download... 0%';
  dialogOk.style.display = 'none';
  dialogCancel.style.display = 'none';
  dialogModal.style.display = 'flex';
  activateModal(dialogModal);

  const cleanupProgress = window.electronAPI.onUpdateDownloadProgress((progress) => {
    const percent = progress.percent.toFixed(1);
    const transferred = formatFileSize(progress.transferred);
    const total = formatFileSize(progress.total);
    const speed = formatFileSize(progress.bytesPerSecond);

    dialogContent.textContent = `Downloading update...\n\n${percent}% (${transferred} / ${total})\nSpeed: ${speed}/s`;
  });

  try {
    const downloadResult = await window.electronAPI.downloadUpdate();
    cleanupProgress();

    if (!downloadResult.success) {
      dialogModal.style.display = 'none';
      deactivateModal(dialogModal);
      showDialog(
        'Download Failed',
        `Failed to download update: ${downloadResult.error}`,
        'error',
        false
      );
      return;
    }

    dialogIcon.innerHTML = twemojiImg(String.fromCodePoint(0x2705), 'twemoji-large');
    dialogTitle.textContent = 'Update Downloaded';
    dialogContent.textContent =
      'The update has been downloaded successfully.\n\nThe application will restart to install the update.';
    dialogOk.style.display = 'block';
    dialogOk.textContent = 'Install & Restart';
    dialogCancel.style.display = 'block';
    dialogCancel.textContent = 'Later';

    const installPromise = new Promise<boolean>((resolve) => {
      const cleanup = () => {
        dialogOk.onclick = null;
        dialogCancel.onclick = null;
      };

      dialogOk.onclick = () => {
        cleanup();
        resolve(true);
      };

      dialogCancel.onclick = () => {
        cleanup();
        resolve(false);
      };
    });

    const shouldInstall = await installPromise;
    dialogModal.style.display = 'none';
    deactivateModal(dialogModal);

    if (shouldInstall) {
      await window.electronAPI.installUpdate();
    }
  } catch (error) {
    cleanupProgress();
    dialogModal.style.display = 'none';
    deactivateModal(dialogModal);
    showDialog(
      'Update Error',
      `An error occurred during the update process: ${getErrorMessage(error)}`,
      'error',
      false
    );
  }
}

document.getElementById('settings-btn')?.addEventListener('click', showSettingsModal);
document.getElementById('settings-close')?.addEventListener('click', hideSettingsModal);
document.getElementById('save-settings-btn')?.addEventListener('click', saveSettings);
document.getElementById('reset-settings-btn')?.addEventListener('click', resetSettings);
document.getElementById('start-tour-btn')?.addEventListener('click', () => {
  hideSettingsModal();
  tourController.startTour();
});
document.getElementById('dangerous-options-toggle')?.addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement;
  updateDangerousOptionsVisibility(target.checked);
});
document.getElementById('browse-startup-path-btn')?.addEventListener('click', async () => {
  const result = await window.electronAPI.selectFolder();
  if (result.success && result.path) {
    const startupPathInput = document.getElementById('startup-path-input') as HTMLInputElement;
    if (startupPathInput) {
      startupPathInput.value = result.path;
    }
  }
});
const extractModal = document.getElementById('extract-modal') as HTMLElement | null;
const extractClose = document.getElementById('extract-close');
const extractCancel = document.getElementById('extract-cancel');
const extractConfirm = document.getElementById('extract-confirm');
const extractBrowseBtn = document.getElementById('extract-browse-btn');
const extractDestinationInput = document.getElementById(
  'extract-destination-input'
) as HTMLInputElement | null;

extractClose?.addEventListener('click', hideExtractModal);
extractCancel?.addEventListener('click', hideExtractModal);
extractConfirm?.addEventListener('click', () => {
  void confirmExtractModal();
});
extractBrowseBtn?.addEventListener('click', async () => {
  const result = await window.electronAPI.selectFolder();
  if (result.success && result.path && extractDestinationInput) {
    extractDestinationInput.value = result.path;
    updateExtractPreview(result.path);
  }
});
extractDestinationInput?.addEventListener('input', () => {
  updateExtractPreview(extractDestinationInput.value);
});
extractDestinationInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void confirmExtractModal();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideExtractModal();
  }
});
extractModal?.addEventListener('click', (e) => {
  if (e.target === extractModal) {
    hideExtractModal();
  }
});
document.getElementById('rebuild-index-btn')?.addEventListener('click', rebuildIndex);
document.getElementById('restart-admin-btn')?.addEventListener('click', restartAsAdmin);
document.getElementById('check-updates-btn')?.addEventListener('click', checkForUpdates);

document.getElementById('icon-size-slider')?.addEventListener('input', (e) => {
  const value = (e.target as HTMLInputElement).value;
  const valueDisplay = document.getElementById('icon-size-value');
  if (valueDisplay) {
    valueDisplay.textContent = value;
  }
});

initSettingsActions();
initSupportPopup();
initLicensesUi();
initExternalLinks();

async function updateThumbnailCacheSize(): Promise<void> {
  const sizeElement = document.getElementById('thumbnail-cache-size');
  if (!sizeElement) return;

  const result = await window.electronAPI.getThumbnailCacheSize();
  if (result.success && typeof result.sizeBytes === 'number') {
    sizeElement.textContent = `(${formatFileSize(result.sizeBytes)}, ${result.fileCount} files)`;
  } else {
    sizeElement.textContent = '';
  }
}

document.getElementById('zoom-in-btn')?.addEventListener('click', zoomIn);
document.getElementById('zoom-out-btn')?.addEventListener('click', zoomOut);
document.getElementById('zoom-reset-btn')?.addEventListener('click', zoomReset);

document.getElementById('shortcuts-close')?.addEventListener('click', hideShortcutsModal);
document.getElementById('close-shortcuts-btn')?.addEventListener('click', hideShortcutsModal);

document.getElementById('folder-icon-close')?.addEventListener('click', hideFolderIconPicker);
document.getElementById('folder-icon-cancel')?.addEventListener('click', hideFolderIconPicker);
document.getElementById('folder-icon-reset')?.addEventListener('click', resetFolderIcon);

const folderIconModal = document.getElementById('folder-icon-modal');
if (folderIconModal) {
  folderIconModal.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'folder-icon-modal') {
      hideFolderIconPicker();
    }
  });
}

const settingsModal = document.getElementById('settings-modal');
if (settingsModal) {
  settingsModal.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'settings-modal') {
      hideSettingsModal();
    }
  });
}

const shortcutsModal = document.getElementById('shortcuts-modal');
if (shortcutsModal) {
  shortcutsModal.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'shortcuts-modal') {
      hideShortcutsModal();
    }
  });
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
    const activeElement = document.activeElement;
    if (
      activeElement &&
      (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
    ) {
      return;
    }

    if (isModalOpen()) {
      return;
    }

    e.preventDefault();
    if (isQuickLookOpen()) {
      closeQuickLook();
    } else {
      showQuickLook();
    }
  }

  if (e.key === 'Escape') {
    const extractModal = document.getElementById('extract-modal');
    if (extractModal && extractModal.style.display === 'flex') {
      e.preventDefault();
      hideExtractModal();
      return;
    }
    if (isQuickLookOpen()) {
      closeQuickLook();
    }
  }
});
const searchInputElement = getSearchInputElement();
if (searchInputElement) {
  searchInputElement.addEventListener('focus', () => {
    if (currentSettings.enableSearchHistory) {
      showSearchHistoryDropdown();
    }
  });
}

if (addressInput) {
  addressInput.addEventListener('focus', () => {
    if (currentSettings.enableSearchHistory) {
      showDirectoryHistoryDropdown();
    }
  });
}

document.addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement;

  // Close dropdowns when clicking outside of them and their inputs
  const searchDropdown = document.getElementById('search-history-dropdown');
  const directoryDropdown = document.getElementById('directory-history-dropdown');

  const isClickInsideSearchDropdown = searchDropdown?.contains(target);
  const isClickInsideDirectoryDropdown = directoryDropdown?.contains(target);
  const isClickOnSearchInput = searchInputElement?.contains(target);
  const isClickOnAddressInput = addressInput?.contains(target);

  if (!isClickInsideSearchDropdown && !isClickOnSearchInput) {
    hideSearchHistoryDropdown();
  }
  if (!isClickInsideDirectoryDropdown && !isClickOnAddressInput) {
    hideDirectoryHistoryDropdown();
  }

  if (target.classList.contains('history-item') && target.dataset.query) {
    e.preventDefault();
    const query = target.dataset.query;
    setSearchQuery(query);
    setTimeout(() => focusSearchInput(), 0);
    hideSearchHistoryDropdown();
    performSearch();
    return;
  }

  if (target.classList.contains('history-item') && target.dataset.path) {
    e.preventDefault();
    const path = target.dataset.path;
    navigateTo(path);
    hideDirectoryHistoryDropdown();
    return;
  }

  if (target.classList.contains('history-clear') && target.dataset.action === 'clear-search') {
    e.preventDefault();
    clearSearchHistory();
    return;
  }

  if (target.classList.contains('history-clear') && target.dataset.action === 'clear-directory') {
    e.preventDefault();
    clearDirectoryHistory();
    return;
  }
});

(async () => {
  try {
    console.log('Starting IYERIS...');
    await init();
    console.log('IYERIS initialized successfully');
  } catch (error) {
    console.error('Failed to initialize IYERIS:', error);
    alert('Failed to start IYERIS: ' + getErrorMessage(error));
  }
})();

window.addEventListener('beforeunload', () => {
  stopIndexStatusPolling();
  cancelActiveSearch();
  if (thumbnailObserver) {
    thumbnailObserver.disconnect();
    thumbnailObserver = null;
  }
  if (virtualizedObserver) {
    virtualizedObserver.disconnect();
    virtualizedObserver = null;
  }

  if (diskSpaceDebounceTimer) {
    clearTimeout(diskSpaceDebounceTimer);
    diskSpaceDebounceTimer = null;
  }
  if (zoomPopupTimeout) {
    clearTimeout(zoomPopupTimeout);
    zoomPopupTimeout = null;
  }
  if (!isResettingSettings) {
    if (tabsEnabled && tabs.length > 0) {
      const currentTab = tabs.find((t) => t.id === activeTabId);
      if (currentTab) {
        currentTab.path = currentPath;
        currentTab.history = [...history];
        currentTab.historyIndex = historyIndex;
        currentTab.selectedItems = new Set(selectedItems);
        currentTab.scrollPosition = fileView?.scrollTop || 0;
      }
      currentSettings.tabState = {
        tabs: tabs.map((t) => ({
          id: t.id,
          path: t.path,
          history: t.history,
          historyIndex: t.historyIndex,
          selectedItems: Array.from(t.selectedItems),
          scrollPosition: t.scrollPosition,
        })),
        activeTabId,
      };
    }
    currentSettings._timestamp = Date.now();
    window.electronAPI.saveSettingsSync(currentSettings);
  }
  if (settingsSaveTimeout) {
    clearTimeout(settingsSaveTimeout);
    settingsSaveTimeout = null;
  }
  cleanupTabs();
  cleanupArchiveOperations();

  filePathMap.clear();
  fileElementMap.clear();
  gitIndicatorPaths.clear();
  cutPaths.clear();
  diskSpaceCache.clear();
  gitStatusCache.clear();
  gitStatusInFlight.clear();
  thumbnailCache.clear();
  pendingThumbnailLoads.length = 0;

  for (const cleanup of ipcCleanupFunctions) {
    try {
      cleanup();
    } catch (e) {
      console.error('[Cleanup] Error cleaning up IPC listener:', e);
    }
  }
  ipcCleanupFunctions.length = 0;
});
