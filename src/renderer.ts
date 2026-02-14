import type { Settings, FileItem, ContentSearchResult, SpecialDirectory, DriveInfo } from './types';
import { createFolderTreeManager } from './folderDir.js';
import { escapeHtml, getErrorMessage, ignoreError } from './shared.js';
import { clearHtml, getById } from './rendererDom.js';
import { createThemeEditorController, hexToRgb } from './rendererThemeEditor.js';
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
import { createShortcutEngineController } from './rendererShortcutsEngine.js';
import { createSettingsUiController } from './rendererSettingsUi.js';
import { createSettingsModalController } from './rendererSettingsModal.js';
import { createClipboardController } from './rendererClipboard.js';
import { createSettingsActionsController } from './rendererSettingsActions.js';
import { createSupportUiController } from './rendererSupportUi.js';
import { createExternalLinksController } from './rendererExternalLinks.js';
import { createPropertiesDialogController } from './rendererPropertiesDialog.js';
import { createUpdateActionsController } from './rendererUpdateActions.js';
import { createColumnViewController } from './rendererColumnView.js';
import { createCompressExtractController } from './rendererCompressExtract.js';
import { createBookmarksController } from './rendererBookmarks.js';
import { createContextMenuController } from './rendererContextMenu.js';
import { createDiskSpaceController } from './rendererDiskSpace.js';
import { createFolderIconPickerController } from './rendererFolderIconPicker.js';
import { createInlineRenameController } from './rendererInlineRename.js';
import { createGitStatusController } from './rendererGitStatus.js';
import { createSortController, SORT_BY_VALUES } from './rendererSort.js';
import { createZoomController } from './rendererZoom.js';
import { createIndexerController } from './rendererIndexer.js';
import { createLayoutController } from './rendererLayout.js';
import { createDragDropController } from './rendererDragDrop.js';
import { createThumbnailController, THUMBNAIL_QUALITY_VALUES } from './rendererThumbnails.js';
import {
  activateModal,
  deactivateModal,
  showAlert,
  showConfirm,
  showDialog,
} from './rendererModals.js';
import { initTooltipSystem } from './rendererTooltips.js';
import {
  isWindowsPath,
  normalizeWindowsPath,
  rendererPath as path,
  twemojiImg,
} from './rendererUtils.js';
import { createDefaultSettings } from './settings.js';
import { SHORTCUT_DEFINITIONS, getDefaultShortcuts } from './shortcuts.js';
import type { ShortcutBinding } from './shortcuts.js';
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
  IMAGE_EXTENSIONS,
  RAW_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  PDF_EXTENSIONS,
} from './fileTypes.js';
import {
  getFileExtension,
  getFileTypeFromName,
  formatFileSize,
  getFileIcon,
  IMAGE_ICON,
} from './rendererFileIcons.js';

const SEARCH_DEBOUNCE_MS = 300;
const SETTINGS_SAVE_DEBOUNCE_MS = 1000;
const TOAST_DURATION_MS = 3000;
const SEARCH_HISTORY_MAX = 5;
const DIRECTORY_HISTORY_MAX = 5;
const RENDER_BATCH_SIZE = 50;
const VIRTUALIZE_THRESHOLD = 2000;
const VIRTUALIZE_BATCH_SIZE = 200;
const ANIMATED_RENDER_ITEM_LIMIT = 320;
const PERFORMANCE_MODE_ITEM_THRESHOLD = 6000;
const DIRECTORY_PROGRESS_THROTTLE_MS = 100;
const SUPPORT_POPUP_DELAY_MS = 1500;

const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function consumeEvent(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}

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
const SORT_ORDER_VALUES = ['asc', 'desc'] as const;
const FILE_CONFLICT_VALUES = ['ask', 'rename', 'skip', 'overwrite'] as const;
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

const SPECIAL_DIRECTORY_ACTIONS: Record<string, { key: SpecialDirectory; label: string }> = {
  desktop: { key: 'desktop', label: 'Desktop' },
  documents: { key: 'documents', label: 'Documents' },
  downloads: { key: 'downloads', label: 'Downloads' },
  music: { key: 'music', label: 'Music' },
  videos: { key: 'videos', label: 'Videos' },
};

const fileElementMap: Map<string, HTMLElement> = new Map();
const driveLabelByPath = new Map<string, string>();
let cachedDriveInfo: DriveInfo[] = [];

function cacheDriveInfo(drives: DriveInfo[]): void {
  cachedDriveInfo = drives;
  driveLabelByPath.clear();
  drives.forEach((drive) => {
    if (drive?.path) {
      driveLabelByPath.set(drive.path, drive.label || drive.path);
    }
  });
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
  return window.electronAPI.saveSettings(settings);
}

let settingsSaveTimeout: ReturnType<typeof setTimeout> | null = null;
function debouncedSaveSettings(delay: number = SETTINGS_SAVE_DEBOUNCE_MS) {
  if (settingsSaveTimeout) {
    clearTimeout(settingsSaveTimeout);
  }
  const timeoutId = setTimeout(() => {
    saveSettingsWithTimestamp(currentSettings)
      .catch(ignoreError)
      .finally(() => {
        if (settingsSaveTimeout === timeoutId) {
          settingsSaveTimeout = null;
        }
      });
  }, delay);
  settingsSaveTimeout = timeoutId;
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
let selectedItemsSizeBytes = 0;
let selectedItemsSizeDirty = true;
let viewMode: ViewMode = 'grid';
let allFiles: FileItem[] = [];
let hiddenFilesCount = 0;
let platformOS: string = '';
let canUndo: boolean = false;
let canRedo: boolean = false;
let folderTreeEnabled: boolean = true;
let disableEntryAnimation = false;

function markSelectionDirty(): void {
  selectedItemsSizeDirty = true;
}

function setSelectedItemsState(value: Set<string>): void {
  selectedItems = value;
  markSelectionDirty();
}

function clearSelectedItemsState(): void {
  if (selectedItems.size === 0) return;
  selectedItems.clear();
  markSelectionDirty();
}

function getSelectedItemsSizeBytes(): number {
  if (!selectedItemsSizeDirty) return selectedItemsSizeBytes;
  let sum = 0;
  for (const itemPath of selectedItems) {
    const item = filePathMap.get(itemPath);
    if (item) {
      sum += item.size;
    }
  }
  selectedItemsSizeBytes = sum;
  selectedItemsSizeDirty = false;
  return sum;
}

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

import {
  addressInput,
  fileGrid,
  fileView,
  columnView,
  homeView,
  loading,
  loadingText,
  emptyState,
  backBtn,
  forwardBtn,
  upBtn,
  refreshBtn,
  newFileBtn,
  newFolderBtn,
  viewToggleBtn,
  viewOptions,
  listHeader,
  folderTree,
  sidebarResizeHandle,
  drivesList,
  sortBtn,
  bookmarksList,
  bookmarkAddBtn,
  undoBtn,
  redoBtn,
  dropIndicator,
  dropIndicatorAction,
  dropIndicatorPath,
  previewResizeHandle,
  selectionCopyBtn,
  selectionCutBtn,
  selectionMoveBtn,
  selectionRenameBtn,
  selectionDeleteBtn,
  statusItems,
  statusSelected,
  statusSearch,
  statusSearchText,
  selectionIndicator,
  selectionCount,
  statusHidden,
} from './rendererElements.js';

const sortController = createSortController({
  getSortBtn: () => sortBtn,
  getCurrentSettings: () => currentSettings,
  getAllFiles: () => allFiles,
  saveSettingsWithTimestamp: (s) => saveSettingsWithTimestamp(s),
  renderFiles: (f) => renderFiles(f),
});
const { showSortMenu, hideSortMenu, updateSortIndicators, changeSortMode } = sortController;

const zoomController = createZoomController({
  setZoomLevel: (level) => window.electronAPI.setZoomLevel(level),
});
const { zoomIn, zoomOut, zoomReset, updateZoomDisplay } = zoomController;

const indexerController = createIndexerController({
  getShowToast: () => showToast as (message: string, title: string, type: string) => void,
});
const { stopIndexStatusPolling, updateIndexStatus, rebuildIndex } = indexerController;

const layoutController = createLayoutController({
  getCurrentSettings: () => currentSettings,
  debouncedSaveSettings: () => debouncedSaveSettings(),
  getSidebarResizeHandle: () => sidebarResizeHandle,
  getPreviewResizeHandle: () => previewResizeHandle,
  getListHeader: () => listHeader,
  consumeEvent,
  changeSortMode: (mode) => changeSortMode(mode),
});
const {
  applyListColumnWidths,
  applySidebarWidth,
  applyPreviewPanelWidth,
  setSidebarCollapsed,
  syncSidebarToggleState,
  setupSidebarResize,
  setupSidebarSections,
  setupPreviewResize,
  setupListHeader,
} = layoutController;

const dragDropController = createDragDropController({
  getCurrentPath: () => currentPath,
  getCurrentSettings: () => currentSettings,
  getShowToast: () => showToast as (message: string, title: string, type: string) => void,
  getFileGrid: () => fileGrid,
  getFileView: () => fileView,
  getDropIndicator: () => dropIndicator,
  getDropIndicatorAction: () => dropIndicatorAction,
  getDropIndicatorPath: () => dropIndicatorPath,
  consumeEvent,
  clearSelection: () => clearSelection(),
  navigateTo: (p) => navigateTo(p),
  updateUndoRedoState: () => updateUndoRedoState(),
});
const {
  getDragOperation,
  getDraggedPaths,
  showDropIndicator,
  hideDropIndicator,
  scheduleSpringLoad,
  clearSpringLoad,
  handleDrop,
  initDragAndDropListeners,
} = dragDropController;

const folderTreeManager = createFolderTreeManager({
  folderTree,
  nameCollator: NAME_COLLATOR,
  getFolderIcon: (p: string) => folderIconPickerController.getFolderIcon(p),
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
  if (now - lastDirectoryProgressUpdate < DIRECTORY_PROGRESS_THROTTLE_MS) return;
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

const diskSpaceController = createDiskSpaceController({
  getCurrentPath: () => currentPath,
  getPlatformOS: () => platformOS,
  formatFileSize,
  isHomeViewPath,
  getDiskSpace: (drivePath) => window.electronAPI.getDiskSpace(drivePath),
});
const { updateDiskSpace } = diskSpaceController;

const gitStatus = createGitStatusController({
  getCurrentSettings: () => currentSettings,
  getCurrentPath: () => currentPath,
  getFileElement: (p) => fileElementMap.get(p),
  getGitStatus: (dir, untracked) => window.electronAPI.getGitStatus(dir, untracked),
  getGitBranch: (dir) => window.electronAPI.getGitBranch(dir),
});

const { clearGitIndicators, fetchGitStatusAsync, updateGitBranch, applyGitIndicatorsToPaths } =
  gitStatus;

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

const folderIconPickerController = createFolderIconPickerController({
  getCurrentSettings: () => currentSettings,
  getCurrentPath: () => currentPath,
  navigateTo: (p) => navigateTo(p),
  showToast,
  saveSettings: () => saveSettings(),
  activateModal,
  deactivateModal,
  twemojiImg,
  folderIcon: twemojiImg(String.fromCodePoint(0x1f4c1), 'twemoji file-icon'),
});

const inlineRenameController = createInlineRenameController({
  getCurrentPath: () => currentPath,
  getAllFiles: () => allFiles,
  navigateTo: (p) => navigateTo(p),
  showToast,
  showAlert,
  isHomeViewPath,
});

const {
  handleCompress,
  showCompressOptionsModal,
  hideCompressOptionsModal,
  showExtractModal,
  hideExtractModal,
  openPathWithArchivePrompt,
  openFileEntry,
  confirmExtractModal,
  updateExtractPreview,
  setupCompressOptionsModal,
} = createCompressExtractController({
  getCurrentPath: () => currentPath,
  getSelectedItems: () => selectedItems,
  showToast,
  navigateTo: (p) => navigateTo(p),
  activateModal,
  deactivateModal,
  addToRecentFiles,
  generateOperationId,
  addOperation,
  getOperation,
  updateOperation,
  removeOperation,
  isWindowsPlatform,
});

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
  getFolderIcon: (p: string) => folderIconPickerController.getFolderIcon(p),
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
    setSelectedItemsState(items);
  },
  updateStatusBar,
  onSelectionChanged: markSelectionDirty,
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
  invalidateGridColumnsCache,
} = selectionController;

const thumbnails = createThumbnailController({
  getCurrentSettings: () => currentSettings,
  getFileIcon,
  getFileExtension,
  formatFileSize,
  getFileByPath: (path) => filePathMap.get(path),
});

const hoverCardController = createHoverCardController({
  getFileItemData,
  formatFileSize,
  getFileTypeFromName,
  getFileIcon,
  getThumbnailForPath: thumbnails.getThumbnailForPath,
  isRubberBandActive,
  getHoverRoot: () => fileGrid,
  getScrollContainer: () => fileView,
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

const { loadBookmarks, addBookmark, addBookmarkByPath } = createBookmarksController({
  bookmarksList,
  getCurrentPath: () => currentPath,
  getCurrentSettings: () => currentSettings,
  saveSettingsWithTimestamp,
  showToast,
  navigateTo: (p) => navigateTo(p),
  getDraggedPaths,
  getDragOperation,
  handleDrop,
  showDropIndicator,
  hideDropIndicator,
  consumeEvent,
  renderHomeBookmarks: () => homeController.renderHomeBookmarks(),
});

const clipboardController = createClipboardController({
  getSelectedItems: () => selectedItems,
  getCurrentPath: () => currentPath,
  getFileElementMap: () => fileElementMap,
  getCurrentSettings: () => currentSettings,
  showToast,
  handleDrop,
  refresh: () => refresh(),
  updateUndoRedoState: () => updateUndoRedoState(),
});

const {
  showContextMenu,
  hideContextMenu,
  showEmptySpaceContextMenu,
  hideEmptySpaceContextMenu,
  handleContextMenuAction,
  handleEmptySpaceContextMenuAction,
  handleKeyboardNavigation: handleContextMenuKeyNav,
  getContextMenuData,
} = createContextMenuController({
  getFileExtension,
  getCurrentPath: () => currentPath,
  getFileElementMap: () => fileElementMap,
  createNewFolderWithInlineRename: () => inlineRenameController.createNewFolderWithInlineRename(),
  createNewFileWithInlineRename: () => inlineRenameController.createNewFileWithInlineRename(),
  pasteFromClipboard: () => clipboardController.pasteFromClipboard(),
  navigateTo: (p) => navigateTo(p),
  showToast,
  openFileEntry: (item) => openFileEntry(item),
  showQuickLookForFile: (item) => showQuickLookForFile(item),
  startInlineRename: (el, name, p) => inlineRenameController.startInlineRename(el, name, p),
  copyToClipboard: () => clipboardController.copyToClipboard(),
  cutToClipboard: () => clipboardController.cutToClipboard(),
  addBookmarkByPath: (p) => addBookmarkByPath(p),
  showFolderIconPicker: (p) => folderIconPickerController.showFolderIconPicker(p),
  showPropertiesDialog: (props) => showPropertiesDialog(props),
  deleteSelected: (permanent) => deleteSelected(permanent),
  handleCompress: (format) => handleCompress(format),
  showCompressOptionsModal: () => showCompressOptionsModal(),
  showExtractModal: (archivePath, name) => showExtractModal(archivePath, name),
});

const { cancelColumnOperations, renderColumnView } = createColumnViewController({
  columnView,
  getCurrentPath: () => currentPath,
  setCurrentPath: (value) => {
    currentPath = value;
  },
  getCurrentSettings: () => currentSettings,
  getSelectedItems: () => selectedItems,
  clearSelection,
  addressInput,
  updateBreadcrumb,
  showToast,
  showContextMenu,
  getFileIcon,
  openFileEntry,
  updatePreview,
  consumeEvent,
  getDragOperation,
  showDropIndicator,
  hideDropIndicator,
  getDraggedPaths,
  handleDrop,
  scheduleSpringLoad,
  clearSpringLoad,
  createDirectoryOperationId,
  getCachedDriveInfo: () => cachedDriveInfo,
  cacheDriveInfo,
  folderTreeManager,
  getFileByPath: (filePath) => filePathMap.get(filePath),
  nameCollator: NAME_COLLATOR,
});

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
    setSelectedItemsState(value);
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

const COMMAND_PALETTE_FIXED_SHORTCUTS: Record<string, ShortcutBinding> = {
  refresh: ['F5'],
  delete: ['Delete'],
  rename: ['F2'],
};

function isWindowsPlatform(): boolean {
  if (platformOS) return platformOS === 'win32';
  return typeof process !== 'undefined' && process.platform === 'win32';
}

const shortcutEngine = createShortcutEngineController({
  getPlatformOS: () => platformOS,
  syncCommandShortcuts: () => syncCommandShortcuts(),
  renderShortcutsModal: () => renderShortcutsModal(),
  debouncedSaveSettings,
});

const {
  isMacPlatform,
  normalizeShortcutBinding,
  serializeShortcut,
  hasModifier,
  eventToBinding,
  rebuildShortcutLookup,
  getFixedShortcutActionIdFromEvent,
  syncShortcutBindingsFromSettings,
  getShortcutBinding,
  getShortcutActionIdFromEvent,
  areBindingsEqual,
  formatShortcutKeyLabel,
  getShortcutBindings,
  setShortcutBindings,
  shortcutLookup,
  reservedShortcutLookup,
  shortcutDefinitionById,
} = shortcutEngine;

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
      void inlineRenameController.createNewFolder();
    },
    createNewFile: () => {
      void inlineRenameController.createNewFile();
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
      clipboardController.copyToClipboard();
    },
    cutToClipboard: () => {
      clipboardController.cutToClipboard();
    },
    pasteFromClipboard: () => {
      clipboardController.pasteFromClipboard();
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
  getShortcutBindings,
  setShortcutBindings,
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

const themeEditorController = createThemeEditorController({
  getCurrentSettings: () => currentSettings,
  setCurrentSettingsTheme: (theme, customTheme) => {
    currentSettings.theme = theme;
    currentSettings.customTheme = customTheme;
  },
  applySettings,
  saveSettingsWithTimestamp,
  showToast,
  showConfirm,
  activateModal,
  deactivateModal,
});

const {
  applyCustomThemeColors,
  clearCustomThemeColors,
  setupThemeEditorListeners,
  updateCustomThemeUI,
} = themeEditorController;

let onSettingsModalHide = () => {};

const settingsModalController = createSettingsModalController({
  getCurrentSettings: () => currentSettings,
  activateModal,
  deactivateModal,
  setSuppressSettingsTracking,
  activateSettingsTab,
  updateCustomThemeUI,
  updateDangerousOptionsVisibility,
  updateIndexStatus: async () => {
    await updateIndexStatus();
  },
  updateThumbnailCacheSize: thumbnails.updateThumbnailCacheSize,
  syncQuickActionsFromMain,
  updateSettingsCardSummaries,
  applySettingsSearch,
  clearSettingsChanged,
  initSettingsChangeTracking,
  stopIndexStatusPolling,
  onSettingsModalHide: () => onSettingsModalHide(),
});

const { showSettingsModal, hideSettingsModal } = settingsModalController;

const settingsActionsController = createSettingsActionsController({
  getCurrentSettings: () => currentSettings,
  setCurrentSettings: (settings) => {
    currentSettings = settings;
  },
  saveSettingsWithTimestamp,
  showToast,
  showConfirm,
  loadBookmarks,
  updateThumbnailCacheSize: thumbnails.updateThumbnailCacheSize,
  clearThumbnailCacheLocal: thumbnails.clearThumbnailCache,
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

const { showLicensesModal, hideLicensesModal, initLicensesUi, showSupportPopup, initSupportPopup } =
  supportUiController;

const externalLinksController = createExternalLinksController({
  openExternal: (url) => {
    window.electronAPI.openFile(url);
  },
  showLicensesModal,
  showShortcutsModal,
});

const { initExternalLinks } = externalLinksController;

const propertiesDialogController = createPropertiesDialogController({
  showToast,
  onModalOpen: activateModal,
  onModalClose: deactivateModal,
});

const { showPropertiesDialog, cleanup: cleanupPropertiesDialog } = propertiesDialogController;

const updateActionsController = createUpdateActionsController({
  showDialog,
  showToast,
  formatFileSize,
  onModalOpen: activateModal,
  onModalClose: deactivateModal,
});

const { restartAsAdmin, checkForUpdates, handleUpdateDownloaded, handleSettingsModalClosed } =
  updateActionsController;
onSettingsModalHide = handleSettingsModalClosed;

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
      setTimeout(() => showSupportPopup(), SUPPORT_POPUP_DELAY_MS);
    }

    tourController.handleLaunch(newLaunchCount);
  }

  if (sharedClipboard) {
    clipboardController.setClipboard(sharedClipboard);
    const cb = clipboardController.getClipboard()!;
    console.log('[Init] Loaded shared clipboard:', cb.operation, cb.paths.length, 'items');
  }

  window.addEventListener('focus', () => {
    clipboardController.updateClipboardIndicator();
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

  // Body class toggles
  const classToggles: [string, boolean][] = [
    ['reduce-motion', !!settings.reduceMotion],
    ['high-contrast', !!settings.highContrast],
    ['large-text', !!settings.largeText],
    ['bold-text', !!settings.boldText],
    ['visible-focus', !!settings.visibleFocus],
    ['reduce-transparency', !!settings.reduceTransparency],
    ['liquid-glass', !!settings.liquidGlassMode],
    ['themed-icons', !!settings.themedIcons],
    ['show-file-checkboxes', !!settings.showFileCheckboxes],
    ['compact-file-info', !!settings.compactFileInfo],
    ['hide-file-extensions', settings.showFileExtensions === false],
  ];
  for (const [cls, val] of classToggles) document.body.classList.toggle(cls, val);

  if (settings.useSystemFontSize) {
    applySystemFontSize();
  } else {
    document.documentElement.style.removeProperty('--system-font-scale');
    document.body.classList.remove('use-system-font-size');
  }

  document.body.classList.remove('compact-ui', 'large-ui');
  if (settings.uiDensity === 'compact') {
    document.body.classList.add('compact-ui');
  } else if (settings.uiDensity === 'larger') {
    document.body.classList.add('large-ui');
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
    gitStatus.clearCache();
    clearGitIndicators();
    const statusGitBranch = document.getElementById('status-git-branch');
    if (statusGitBranch) statusGitBranch.style.display = 'none';
  }

  const nextFolderTreeEnabled = settings.showFolderTree !== false;
  setFolderTreeSpacingMode(settings.useLegacyTreeSpacing === true);
  setFolderTreeVisibility(nextFolderTreeEnabled);
  if (nextFolderTreeEnabled && !folderTreeEnabled) {
    loadDrives();
  }
  folderTreeEnabled = nextFolderTreeEnabled;

  loadBookmarks();
  loadRecentFiles();
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

  // Data-driven toggle → settings mappings
  const toggleMappings: [string, keyof Settings][] = [
    ['system-theme-toggle', 'useSystemTheme'],
    ['show-hidden-files-toggle', 'showHiddenFiles'],
    ['enable-git-status-toggle', 'enableGitStatus'],
    ['git-include-untracked-toggle', 'gitIncludeUntracked'],
    ['show-file-hover-card-toggle', 'showFileHoverCard'],
    ['show-file-checkboxes-toggle', 'showFileCheckboxes'],
    ['minimize-to-tray-toggle', 'minimizeToTray'],
    ['start-on-login-toggle', 'startOnLogin'],
    ['auto-check-updates-toggle', 'autoCheckUpdates'],
    ['enable-search-history-toggle', 'enableSearchHistory'],
    ['enable-indexer-toggle', 'enableIndexer'],
    ['show-recent-files-toggle', 'showRecentFiles'],
    ['show-folder-tree-toggle', 'showFolderTree'],
    ['legacy-tree-spacing-toggle', 'useLegacyTreeSpacing'],
    ['enable-tabs-toggle', 'enableTabs'],
    ['global-content-search-toggle', 'globalContentSearch'],
    ['global-clipboard-toggle', 'globalClipboard'],
    ['enable-syntax-highlighting-toggle', 'enableSyntaxHighlighting'],
    ['reduce-motion-toggle', 'reduceMotion'],
    ['high-contrast-toggle', 'highContrast'],
    ['large-text-toggle', 'largeText'],
    ['use-system-font-size-toggle', 'useSystemFontSize'],
    ['bold-text-toggle', 'boldText'],
    ['visible-focus-toggle', 'visibleFocus'],
    ['reduce-transparency-toggle', 'reduceTransparency'],
    ['liquid-glass-toggle', 'liquidGlassMode'],
    ['themed-icons-toggle', 'themedIcons'],
    ['disable-hw-accel-toggle', 'disableHardwareAcceleration'],
    ['confirm-file-operations-toggle', 'confirmFileOperations'],
    ['auto-play-videos-toggle', 'autoPlayVideos'],
    ['compact-file-info-toggle', 'compactFileInfo'],
    ['show-file-extensions-toggle', 'showFileExtensions'],
  ];
  for (const [id, key] of toggleMappings) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) (currentSettings as unknown as Record<string, unknown>)[key] = el.checked;
  }

  // Select → enum settings mappings
  const selectMappings: [string, keyof Settings, readonly string[]][] = [
    ['theme-select', 'theme', THEME_VALUES],
    ['sort-by-select', 'sortBy', SORT_BY_VALUES],
    ['sort-order-select', 'sortOrder', SORT_ORDER_VALUES],
    ['update-channel-select', 'updateChannel', UPDATE_CHANNEL_VALUES],
    ['ui-density-select', 'uiDensity', ['default', 'compact', 'larger']],
    ['file-conflict-behavior-select', 'fileConflictBehavior', FILE_CONFLICT_VALUES],
    ['thumbnail-quality-select', 'thumbnailQuality', THUMBNAIL_QUALITY_VALUES],
    ['preview-panel-position-select', 'previewPanelPosition', PREVIEW_POSITION_VALUES],
    ['grid-columns-select', 'gridColumns', GRID_COLUMNS_VALUES],
  ];
  for (const [id, key, validValues] of selectMappings) {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    if (el && isOneOf(el.value, validValues)) {
      (currentSettings as unknown as Record<string, unknown>)[key] = el.value;
    }
  }

  // Integer range inputs
  const intMappings: [string, keyof Settings, number, number][] = [
    ['max-thumbnail-size-input', 'maxThumbnailSizeMB', 1, 100],
    ['max-preview-size-input', 'maxPreviewSizeMB', 1, 500],
    ['max-search-history-input', 'maxSearchHistoryItems', 1, 20],
    ['max-directory-history-input', 'maxDirectoryHistoryItems', 1, 20],
  ];
  for (const [id, key, min, max] of intMappings) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) {
      const val = parseInt(el.value, 10);
      if (val >= min && val <= max)
        (currentSettings as unknown as Record<string, unknown>)[key] = val;
    }
  }

  // Special handling for dangerous options toggle
  const dangerousOptionsToggle = document.getElementById(
    'dangerous-options-toggle'
  ) as HTMLInputElement | null;
  if (dangerousOptionsToggle) {
    currentSettings.showDangerousOptions = dangerousOptionsToggle.checked;
    updateDangerousOptionsVisibility(currentSettings.showDangerousOptions);
  }

  // Startup path
  const startupPathInput = document.getElementById('startup-path-input') as HTMLInputElement | null;
  if (startupPathInput) currentSettings.startupPath = startupPathInput.value;

  // Icon size slider
  const iconSizeSlider = document.getElementById('icon-size-slider') as HTMLInputElement | null;
  if (iconSizeSlider) currentSettings.iconSize = parseInt(iconSizeSlider.value, 10);

  // System theme override
  if (currentSettings.useSystemTheme) {
    try {
      const { isDarkMode } = await window.electronAPI.getSystemAccentColor();
      const systemTheme = isDarkMode ? 'default' : 'light';
      currentSettings.theme = systemTheme;
    } catch (error) {
      console.error('[Settings] Failed to apply system theme:', error);
    }
  }

  // Truncate histories to their configured max
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
    clearSelectedItemsState();
    updateStatusBar();
    document.body.classList.remove('performance-mode');
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

function updateStatusBar() {
  if (statusItems) {
    statusItems.textContent = `${allFiles.length} item${allFiles.length !== 1 ? 's' : ''}`;
  }

  if (statusSelected) {
    if (selectedItems.size > 0) {
      const totalSize = getSelectedItemsSizeBytes();
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
        zoomController.setCurrentZoomLevel(zoomResult.zoomLevel);
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

    const cleanupUpdateDownloaded = window.electronAPI.onUpdateDownloaded((info) => {
      console.log('Update downloaded:', info);
      handleUpdateDownloaded(info);
    });
    ipcCleanupFunctions.push(cleanupUpdateDownloaded);

    const cleanupSystemResumed = window.electronAPI.onSystemResumed(() => {
      console.log('[Renderer] System resumed from sleep, refreshing view...');
      diskSpaceController.clearCache();
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

function setFolderTreeSpacingMode(useLegacyTreeSpacing: boolean): void {
  if (!folderTree) return;
  if (useLegacyTreeSpacing) {
    folderTree.dataset.treeIndentMode = 'legacy';
  } else {
    delete folderTree.dataset.treeIndentMode;
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
    clipboardController.setClipboard(newClipboard);
    clipboardController.updateCutVisuals();
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
  const windowControls: Array<[string, () => void]> = [
    ['minimize-btn', () => window.electronAPI.minimizeWindow()],
    ['maximize-btn', () => window.electronAPI.maximizeWindow()],
    ['close-btn', () => window.electronAPI.closeWindow()],
  ];
  windowControls.forEach(([id, action]) => {
    document.getElementById(id)?.addEventListener('click', action);
  });
}

function initActionButtonListeners(): void {
  const clickBindings: Array<[Element | null | undefined, () => void]> = [
    [backBtn, goBack],
    [forwardBtn, goForward],
    [upBtn, goUp],
    [undoBtn, performUndo],
    [redoBtn, performRedo],
    [refreshBtn, refresh],
    [newFileBtn, () => inlineRenameController.createNewFile()],
    [newFolderBtn, () => inlineRenameController.createNewFolder()],
    [viewToggleBtn, toggleView],
    [
      document.getElementById('empty-new-folder-btn'),
      () => inlineRenameController.createNewFolder(),
    ],
    [document.getElementById('empty-new-file-btn'), () => inlineRenameController.createNewFile()],
    [document.getElementById('select-all-btn'), selectAll],
    [document.getElementById('deselect-all-btn'), clearSelection],
    [selectionCopyBtn, clipboardController.copyToClipboard],
    [selectionCutBtn, clipboardController.cutToClipboard],
    [selectionMoveBtn, clipboardController.moveSelectedToFolder],
    [selectionRenameBtn, renameSelected],
    [selectionDeleteBtn, () => deleteSelected()],
  ];
  clickBindings.forEach(([element, handler]) => element?.addEventListener('click', handler));

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
  document.getElementById('sidebar-toggle')?.addEventListener('click', () => setSidebarCollapsed());
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
  if (isQuickLookOpen()) return true;
  const modals = document.querySelectorAll('.modal-overlay');
  for (let i = 0; i < modals.length; i++) {
    const el = modals[i];
    if (el instanceof HTMLElement && el.style.display === 'flex') return true;
  }
  return false;
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
  // Actions that need special pre-checks
  if (actionId === 'copy' && hasTextSelection()) return false;
  if (actionId === 'cut' && hasTextSelection()) return false;
  if ((actionId === 'paste' || actionId === 'select-all') && isEditableElementActive())
    return false;

  // Simple action map
  const actions: Record<string, () => void> = {
    'command-palette': () => showCommandPalette(),
    settings: () => showSettingsModal(),
    shortcuts: () => showShortcutsModal(),
    refresh: () => refresh(),
    search: () => openSearch(false),
    'global-search': () => openSearch(true),
    'toggle-sidebar': () => setSidebarCollapsed(),
    'new-window': () => openNewWindow(),
    'new-file': () => inlineRenameController.createNewFile(),
    'new-folder': () => inlineRenameController.createNewFolder(),
    'go-back': () => goBack(),
    'go-forward': () => goForward(),
    'go-up': () => goUp(),
    'new-tab': () => {
      if (tabsEnabled) addNewTab();
    },
    'close-tab': () => {
      if (tabsEnabled && tabs.length > 1) closeTab(activeTabId);
    },
    copy: () => clipboardController.copyToClipboard(),
    cut: () => clipboardController.cutToClipboard(),
    paste: () => clipboardController.pasteFromClipboard(),
    'select-all': () => selectAll(),
    undo: () => performUndo(),
    redo: () => performRedo(),
    'zoom-in': () => zoomIn(),
    'zoom-out': () => zoomOut(),
    'zoom-reset': () => zoomReset(),
  };

  // Tab cycling needs special logic
  if (actionId === 'next-tab' || actionId === 'prev-tab') {
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

  const handler = actions[actionId];
  if (handler) {
    e.preventDefault();
    handler();
    return true;
  }
  return false;
}

function initKeyboardListeners(): void {
  document.addEventListener('keydown', (e) => {
    if (isShortcutCaptureActive()) {
      return;
    }
    if (e.key === 'Escape') {
      // Dismiss modals in priority order
      const modalDismissals: [string, string, () => void][] = [
        ['extract-modal', 'flex', hideExtractModal],
        ['compress-options-modal', 'flex', hideCompressOptionsModal],
        ['settings-modal', 'flex', hideSettingsModal],
        ['shortcuts-modal', 'flex', hideShortcutsModal],
        ['licenses-modal', 'flex', hideLicensesModal],
        ['home-settings-modal', 'flex', () => homeController.closeHomeSettingsModal()],
        ['sort-menu', 'block', hideSortMenu],
        ['context-menu', 'block', hideContextMenu],
        ['empty-space-context-menu', 'block', hideEmptySpaceContextMenu],
      ];
      for (const [id, display, handler] of modalDismissals) {
        const el = document.getElementById(id);
        if (el?.style.display === display) {
          e.preventDefault();
          handler();
          return;
        }
      }

      if (isSearchModeActive()) closeSearch();
      if (isQuickLookOpen()) closeQuickLook();
      return;
    }

    if (handleContextMenuKeyNav(e)) return;

    if (isModalOpen()) {
      return;
    }

    if (e.code === 'Space' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (isEditableElementActive()) return;
      e.preventDefault();
      if (isQuickLookOpen()) {
        closeQuickLook();
      } else {
        showQuickLook();
      }
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

    const EDIT_GUARDED_KEYS = new Set([
      'Backspace',
      'Enter',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Delete',
    ]);
    if (EDIT_GUARDED_KEYS.has(e.key) && isEditableElementActive()) return;

    if (e.key === 'Delete') {
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
        deleteSelected(true);
      } else {
        deleteSelected();
      }
      return;
    }

    const simpleKeyActions: Record<string, () => void> = {
      Backspace: () => goUp(),
      F2: () => renameSelected(),
      Enter: () => openSelectedItem(),
      Home: () => selectFirstItem(e.shiftKey),
      End: () => selectLastItem(e.shiftKey),
      PageUp: () => navigateByPage('up', e.shiftKey),
      PageDown: () => navigateByPage('down', e.shiftKey),
    };
    const simpleAction = simpleKeyActions[e.key];
    if (simpleAction) {
      e.preventDefault();
      simpleAction();
    } else if (
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight'
    ) {
      e.preventDefault();
      navigateFileGrid(e.key, e.shiftKey);
    } else if (
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      e.key.length === 1 &&
      !isSearchModeActive() &&
      viewMode !== 'column'
    ) {
      if (isEditableElementActive()) return;
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

      const ctxData = getContextMenuData();
      if (ctxData) {
        handleContextMenuAction(menuItem.dataset.action, ctxData, menuItem.dataset.format);
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
  if (fileGrid) {
    fileGrid.addEventListener('click', (e) => {
      if (e.target === fileGrid) clearSelection();
    });
  }
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

    thumbnails.disconnectThumbnailObserver();

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

    thumbnails.disconnectThumbnailObserver();

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
  clipboardController.updateCutVisuals();
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
const fileIconNodeCache = new Map<string, HTMLElement>();

function createFileIconNode(iconHtml: string): HTMLElement {
  const cached = fileIconNodeCache.get(iconHtml);
  if (cached) {
    return cached.cloneNode(true) as HTMLElement;
  }
  const wrapper = document.createElement('div');
  wrapper.innerHTML = iconHtml;
  const first = wrapper.firstElementChild;
  const node = first instanceof HTMLElement ? first : document.createElement('span');
  if (!(first instanceof HTMLElement)) {
    node.textContent = iconHtml;
  }
  fileIconNodeCache.set(iconHtml, node.cloneNode(true) as HTMLElement);
  return node;
}

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
  const shouldAnimate =
    !disableEntryAnimation && !document.body.classList.contains('reduce-motion');

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
  thumbnails.resetThumbnailObserver();
  fileGrid.innerHTML = '';
  renderItemIndex = 0;
  disableEntryAnimation = false;
  clearSelection();
  allFiles = items;
  document.body.classList.toggle(
    'performance-mode',
    items.length >= PERFORMANCE_MODE_ITEM_THRESHOLD
  );
  updateHiddenFilesCount(items);

  filePathMap.clear();
  fileElementMap.clear();
  markSelectionDirty();
  gitStatus.clearCache();
  clipboardController.clearCutPaths();
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

  disableEntryAnimation = sortedItems.length > ANIMATED_RENDER_ITEM_LIMIT;

  if (sortedItems.length >= VIRTUALIZE_THRESHOLD) {
    virtualizedRenderToken = renderToken;
    virtualizedItems = sortedItems;
    virtualizedRenderIndex = 0;
    virtualizedSearchQuery = searchQuery;
    updateStatusBar();
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
      clipboardController.updateCutVisuals();
      updateStatusBar();
      ensureActiveItem();
    }
  };

  renderBatch();
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
    icon = folderIconPickerController.getFolderIcon(item.path);
  } else {
    const ext = getFileExtension(item.name);
    const thumbType = RAW_EXTENSIONS.has(ext)
      ? 'raw'
      : IMAGE_EXTENSIONS.has(ext)
        ? 'image'
        : VIDEO_EXTENSIONS.has(ext)
          ? 'video'
          : AUDIO_EXTENSIONS.has(ext)
            ? 'audio'
            : PDF_EXTENSIONS.has(ext)
              ? 'pdf'
              : null;
    if (thumbType) {
      fileItem.classList.add('has-thumbnail');
      fileItem.dataset.thumbnailType = thumbType;
      icon = thumbType === 'image' || thumbType === 'raw' ? IMAGE_ICON : getFileIcon(item.name);
      thumbnails.observeThumbnailItem(fileItem);
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
      <div class="file-icon"></div>
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
  const fileIcon = fileItem.querySelector('.file-icon');
  if (fileIcon) {
    fileIcon.appendChild(createFileIconNode(icon));
  }
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
      requestAnimationFrame(() => dragImage.remove());
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

    consumeEvent(e);

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

    consumeEvent(e);

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

    consumeEvent(e);

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

async function renameSelected() {
  if (selectedItems.size !== 1) return;
  const itemPath = Array.from(selectedItems)[0];
  const fileItem = fileElementMap.get(itemPath);
  if (fileItem) {
    const item = filePathMap.get(itemPath);
    if (item) {
      inlineRenameController.startInlineRename(fileItem, item.name, item.path);
    }
  }
}

async function deleteSelected(permanent = false) {
  if (selectedItems.size === 0) return;
  const count = selectedItems.size;
  const plural = count > 1 ? 's' : '';

  if (permanent) {
    const confirmed = await showConfirm(
      `${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} PERMANENTLY delete ${count} item${plural}? This CANNOT be undone!`,
      'Permanent Delete',
      'error'
    );
    if (!confirmed) return;
  } else if (currentSettings.confirmFileOperations !== false) {
    const trashName = platformOS === 'win32' ? 'Recycle Bin' : 'Trash';
    const confirmed = await showConfirm(
      `Move ${count} item${plural} to ${trashName}?`,
      'Move to Trash',
      'warning'
    );
    if (!confirmed) return;
  }

  const itemsSnapshot = Array.from(selectedItems);
  const results = await Promise.allSettled(
    itemsSnapshot.map((p) =>
      permanent ? window.electronAPI.deleteItem(p) : window.electronAPI.trashItem(p)
    )
  );
  const successCount = results.filter((r) => r.status === 'fulfilled' && r.value.success).length;
  if (successCount > 0) {
    const msg = permanent
      ? `${successCount} item${successCount > 1 ? 's' : ''} permanently deleted`
      : `${successCount} item${successCount > 1 ? 's' : ''} moved to ${platformOS === 'win32' ? 'Recycle Bin' : 'Trash'}`;
    showToast(msg, 'Success', 'success');
    if (!permanent) await updateUndoRedoState();
    refresh();
  }
}

async function updateUndoRedoState() {
  const state = await window.electronAPI.getUndoRedoState();
  canUndo = state.canUndo;
  canRedo = state.canRedo;

  if (undoBtn) undoBtn.disabled = !canUndo;
  if (redoBtn) redoBtn.disabled = !canRedo;
}

async function performUndoRedo(isUndo: boolean) {
  const result = isUndo
    ? await window.electronAPI.undoAction()
    : await window.electronAPI.redoAction();
  const label = isUndo ? 'Undo' : 'Redo';
  if (result.success) {
    showToast(`Action ${isUndo ? 'undone' : 'redone'}`, label, 'success');
    await updateUndoRedoState();
    refresh();
  } else {
    showToast(result.error || `Cannot ${label.toLowerCase()}`, `${label} Failed`, 'warning');
    await updateUndoRedoState();
  }
}
function performUndo() {
  return performUndoRedo(true);
}
function performRedo() {
  return performUndoRedo(false);
}

function navigateHistory(delta: -1 | 1): void {
  const nextIndex = historyIndex + delta;
  if (nextIndex < 0 || nextIndex >= history.length) return;
  historyIndex = nextIndex;
  navigateTo(history[historyIndex], true);
}

function goBack() {
  navigateHistory(-1);
}

function goForward() {
  navigateHistory(1);
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
  const viewModeCycle: ViewMode[] = ['grid', 'list', 'column'];
  const nextIndex = (viewModeCycle.indexOf(viewMode) + 1) % viewModeCycle.length;
  await setViewMode(viewModeCycle[nextIndex]);
}

async function applyViewMode() {
  invalidateGridColumnsCache();
  if (isHomeViewPath(currentPath)) {
    setHomeViewActive(true);
    return;
  }

  if (viewMode === 'column') {
    document.body.classList.remove('performance-mode');
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

const VIEW_TOGGLE_CONFIG: Record<string, { svg: string; title: string }> = {
  list: {
    svg: `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="2" fill="currentColor" rx="1"/><rect x="2" y="7" width="12" height="2" fill="currentColor" rx="1"/><rect x="2" y="11" width="12" height="2" fill="currentColor" rx="1"/></svg>`,
    title: 'Switch to Column View',
  },
  column: {
    svg: `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1" y="2" width="4" height="12" fill="currentColor" rx="1"/><rect x="6" y="2" width="4" height="12" fill="currentColor" rx="1"/><rect x="11" y="2" width="4" height="12" fill="currentColor" rx="1"/></svg>`,
    title: 'Switch to Grid View',
  },
  grid: {
    svg: `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" fill="currentColor" rx="1"/><rect x="9" y="2" width="5" height="5" fill="currentColor" rx="1"/><rect x="2" y="9" width="5" height="5" fill="currentColor" rx="1"/><rect x="9" y="9" width="5" height="5" fill="currentColor" rx="1"/></svg>`,
    title: 'Switch to List View',
  },
};

function updateViewToggleButton() {
  const cfg = VIEW_TOGGLE_CONFIG[viewMode] ?? VIEW_TOGGLE_CONFIG.grid;
  viewToggleBtn.innerHTML = cfg.svg;
  viewToggleBtn.title = cfg.title;
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

function bindClickById(id: string, handler: () => void): void {
  document.getElementById(id)?.addEventListener('click', handler);
}

function bindClickBindings(bindings: ReadonlyArray<readonly [string, () => void]>): void {
  bindings.forEach(([id, handler]) => bindClickById(id, handler));
}

async function chooseFolderAndApply(onPathSelected: (selectedPath: string) => void): Promise<void> {
  const result = await window.electronAPI.selectFolder();
  if (result.success && result.path) {
    onPathSelected(result.path);
  }
}

bindClickBindings([
  ['settings-btn', showSettingsModal],
  ['settings-close', hideSettingsModal],
  ['save-settings-btn', saveSettings],
  ['reset-settings-btn', resetSettings],
]);
document.getElementById('start-tour-btn')?.addEventListener('click', () => {
  hideSettingsModal();
  tourController.startTour();
});
document.getElementById('dangerous-options-toggle')?.addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement;
  updateDangerousOptionsVisibility(target.checked);
});
document.getElementById('browse-startup-path-btn')?.addEventListener('click', async () => {
  await chooseFolderAndApply((selectedPath) => {
    const startupPathInput = document.getElementById(
      'startup-path-input'
    ) as HTMLInputElement | null;
    if (startupPathInput) startupPathInput.value = selectedPath;
  });
});
const extractModal = document.getElementById('extract-modal') as HTMLElement | null;
const extractClose = document.getElementById('extract-close');
const extractCancel = document.getElementById('extract-cancel');
const extractConfirm = document.getElementById('extract-confirm');
const extractBrowseBtn = document.getElementById('extract-browse-btn');
const extractDestinationInput = document.getElementById(
  'extract-destination-input'
) as HTMLInputElement | null;

([extractClose, extractCancel] as const).forEach((el) =>
  el?.addEventListener('click', hideExtractModal)
);
extractConfirm?.addEventListener('click', () => {
  void confirmExtractModal();
});
extractBrowseBtn?.addEventListener('click', async () => {
  await chooseFolderAndApply((selectedPath) => {
    if (!extractDestinationInput) return;
    extractDestinationInput.value = selectedPath;
    updateExtractPreview(selectedPath);
  });
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

setupCompressOptionsModal();

bindClickBindings([
  ['rebuild-index-btn', rebuildIndex],
  ['restart-admin-btn', restartAsAdmin],
  ['check-updates-btn', checkForUpdates],
]);

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

bindClickBindings([
  ['zoom-in-btn', zoomIn],
  ['zoom-out-btn', zoomOut],
  ['zoom-reset-btn', zoomReset],
  ['shortcuts-close', hideShortcutsModal],
  ['close-shortcuts-btn', hideShortcutsModal],
  ['folder-icon-close', () => folderIconPickerController.hideFolderIconPicker()],
  ['folder-icon-cancel', () => folderIconPickerController.hideFolderIconPicker()],
  ['folder-icon-reset', () => folderIconPickerController.resetFolderIcon()],
]);

for (const [id, handler] of [
  ['folder-icon-modal', () => folderIconPickerController.hideFolderIconPicker()],
  ['settings-modal', hideSettingsModal],
  ['shortcuts-modal', hideShortcutsModal],
] as const) {
  const el = document.getElementById(id);
  el?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === id) handler();
  });
}

function bindHistoryDropdownOnFocus(element: HTMLElement | null, showDropdown: () => void): void {
  if (!element) return;
  element.addEventListener('focus', () => {
    if (currentSettings.enableSearchHistory) showDropdown();
  });
}

const searchInputElement = getSearchInputElement();
bindHistoryDropdownOnFocus(searchInputElement, showSearchHistoryDropdown);
bindHistoryDropdownOnFocus(addressInput, showDirectoryHistoryDropdown);

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

  if (target.classList.contains('history-item')) {
    if (target.dataset.query) {
      e.preventDefault();
      setSearchQuery(target.dataset.query);
      setTimeout(() => focusSearchInput(), 0);
      hideSearchHistoryDropdown();
      performSearch();
      return;
    }
    if (target.dataset.path) {
      e.preventDefault();
      navigateTo(target.dataset.path);
      hideDirectoryHistoryDropdown();
      return;
    }
  }

  if (target.classList.contains('history-clear')) {
    let clearAction: (() => void) | null = null;
    if (target.dataset.action === 'clear-search') {
      clearAction = clearSearchHistory;
    } else if (target.dataset.action === 'clear-directory') {
      clearAction = clearDirectoryHistory;
    }
    if (clearAction) {
      e.preventDefault();
      clearAction();
    }
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

function disconnectAndResetObserver<T extends { disconnect: () => void }>(
  observer: T | null
): null {
  observer?.disconnect();
  return null;
}

function clearAndResetTimeout(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer) clearTimeout(timer);
  return null;
}

window.addEventListener('beforeunload', () => {
  stopIndexStatusPolling();
  cancelActiveSearch();
  cleanupPropertiesDialog();
  thumbnails.resetThumbnailObserver();
  virtualizedObserver = disconnectAndResetObserver(virtualizedObserver);
  diskSpaceController.clearCache();
  zoomController.clearZoomPopupTimeout();
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
  settingsSaveTimeout = clearAndResetTimeout(settingsSaveTimeout);
  cleanupTabs();
  cleanupArchiveOperations();

  [filePathMap, fileElementMap].forEach((cache) => cache.clear());
  diskSpaceController.clearCache();
  clipboardController.clearCutPaths();
  gitStatus.clearCache();
  thumbnails.clearThumbnailCache();
  thumbnails.clearPendingThumbnailLoads();

  for (const cleanup of ipcCleanupFunctions) {
    try {
      cleanup();
    } catch (e) {
      console.error('[Cleanup] Error cleaning up IPC listener:', e);
    }
  }
  ipcCleanupFunctions.length = 0;
});
