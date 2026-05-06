import type { Settings, FileItem, DriveInfo } from './types';
import type { ToastAction, ToastType } from './rendererToasts.js';
import type { ShortcutBinding } from './shortcuts.js';
import type { TabData } from './rendererTabs.js';
import type { TourController } from './tour.js';
import type { ViewMode } from './rendererLocalConstants.js';
import { createFolderTreeManager } from './folderDir.js';
import { getById } from './rendererDom.js';
import { createThemeEditorController } from './rendererThemeEditor.js';
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
import { createOperationQueueController } from './rendererOperationQueue.js';
import { createTabsController } from './rendererTabs.js';
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
import { createDuplicateFinderController } from './rendererDuplicateFinder.js';
import { createColumnViewController } from './rendererColumnView.js';
import { createCompressExtractController } from './rendererCompressExtract.js';
import { createBookmarksController } from './rendererBookmarks.js';
import { createContextMenuController } from './rendererContextMenu.js';
import { createBatchRenameController } from './rendererBatchRename.js';
import { createDiskSpaceController } from './rendererDiskSpace.js';
import { createFolderIconPickerController } from './rendererFolderIconPicker.js';
import { createInlineRenameController } from './rendererInlineRename.js';
import { createGitStatusController } from './rendererGitStatus.js';
import { createSortController } from './rendererSort.js';
import { createZoomController } from './rendererZoom.js';
import { createIndexerController } from './rendererIndexer.js';
import { createLayoutController } from './rendererLayout.js';
import { createDragDropController } from './rendererDragDrop.js';
import { createThumbnailController } from './rendererThumbnails.js';
import {
  activateModal,
  deactivateModal,
  showAlert,
  showConfirm,
  showDialog,
} from './rendererModals.js';
import {
  isWindowsPath,
  normalizeWindowsPath,
  rendererPath as path,
  twemojiImg,
} from './rendererUtils.js';

import { SHORTCUT_DEFINITIONS, getDefaultShortcuts } from './shortcuts.js';
import {
  createHomeController,
  getPathDisplayValue,
  HOME_VIEW_LABEL,
  HOME_VIEW_PATH,
  isHomeViewPath,
} from './home.js';
import { createTourController } from './tour.js';
import {
  getFileExtension,
  getFileTypeFromName,
  formatFileSize,
  getFileIcon,
} from './rendererFileIcons.js';
import { escapeHtml, getErrorMessage, ignoreError } from './shared.js';
import {
  SEARCH_DEBOUNCE_MS,
  TOAST_DURATION_MS,
  SEARCH_HISTORY_MAX,
  DIRECTORY_HISTORY_MAX,
  DIRECTORY_PROGRESS_THROTTLE_MS,
  MAX_CACHED_TABS,
  MAX_CACHED_FILES_PER_TAB,
  NAME_COLLATOR,
  consumeEvent,
} from './rendererLocalConstants.js';
import { createDirectoryLoaderController } from './rendererDirectoryLoader.js';
import {
  addressInput,
  fileGrid,
  fileView,
  columnView,
  loading,
  loadingText,
  emptyState,
  listHeader,
  folderTree,
  sidebarResizeHandle,
  sortBtn,
  bookmarksList,
  dropIndicator,
  dropIndicatorAction,
  dropIndicatorPath,
  previewResizeHandle,
  announceToScreenReader,
} from './rendererElements.js';

export interface LateBound {
  navigateTo(path: string, force?: boolean, trigger?: string): Promise<void>;
  refresh(reason?: string): void;
  renderFiles(files: FileItem[], highlight?: string): void;
  updateStatusBar(): void;
  updateUndoRedoState(): Promise<void>;
  deleteSelected(permanent?: boolean): Promise<void>;
  renameSelected(): Promise<void>;
  handleQuickAction(action?: string | null): Promise<void>;
  addToRecentFiles(filePath: string): Promise<void>;
  saveSettings(): Promise<void>;
  applySettings(settings: Settings): void;
  updateDangerousOptionsVisibility(show: boolean): void;
  setViewMode(mode: 'grid' | 'list' | 'column'): Promise<void>;
  setHomeViewActive(active: boolean): void;
  updateNavigationButtons(): void;
  getFileByPath(path: string): FileItem | undefined;
  getFileItemData(el: HTMLElement): FileItem | null;
}

export interface WiringDeps {
  getCurrentPath(): string;
  getSearchScopePath?(): string;
  getSearchScopeLabel?(): string;
  setCurrentPath(value: string): void;
  getCurrentSettings(): Settings;
  setCurrentSettings(settings: Settings): void;
  getSelectedItems(): Set<string>;
  setSelectedItems(items: Set<string>): void;
  clearSelectedItemsState(): void;
  markSelectionDirty(): void;
  getAllFiles(): FileItem[];
  setAllFiles(files: FileItem[]): void;
  getViewMode(): ViewMode;
  getPlatformOS(): string;
  getHistory(): string[];
  setHistory(value: string[]): void;
  getHistoryIndex(): number;
  setHistoryIndex(value: number): void;
  getTabs(): TabData[];
  setTabs(value: TabData[]): void;
  getActiveTabId(): string;
  setActiveTabId(value: string): void;
  getTabsEnabled(): boolean;
  setTabsEnabled(value: boolean): void;
  getTabNewButtonListenerAttached(): boolean;
  setTabNewButtonListenerAttached(value: boolean): void;
  getTabCacheAccessOrder(): string[];
  setTabCacheAccessOrder(value: string[]): void;
  getSaveTabStateTimeout(): NodeJS.Timeout | null;
  setSaveTabStateTimeout(value: NodeJS.Timeout | null): void;
  getFileViewScrollTop(): number;
  setFileViewScrollTop(value: number): void;

  saveSettingsWithTimestamp(settings: Settings): Promise<{ success: boolean; error?: string }>;
  debouncedSaveSettings(delay?: number): void;
  getFileElementMap(): Map<string, HTMLElement>;
  getDriveLabelByPath(): Map<string, string>;
  getCachedDriveInfo(): DriveInfo[];
  cacheDriveInfo(drives: DriveInfo[]): void;
  getIpcCleanupFunctions(): (() => void)[];
  isMainWindow: boolean;

  late: LateBound;
}

function getFileItemsArray(): HTMLElement[] {
  const isRightPaneActive =
    document.body.classList.contains('dual-pane-enabled') &&
    document.body.classList.contains('active-pane-right');
  const scope = isRightPaneActive
    ? document.getElementById('dual-pane-secondary-list')
    : document.getElementById('file-grid');
  if (scope) {
    return Array.from(scope.querySelectorAll('.file-item')) as HTMLElement[];
  }
  return Array.from(document.querySelectorAll('.file-item')) as HTMLElement[];
}

export function wireControllers(deps: WiringDeps) {
  /* eslint-disable prefer-const */
  let showToast!: (
    message: string,
    title?: string,
    type?: ToastType,
    actions?: ToastAction[]
  ) => void;
  let clearSelection!: () => void;
  let showCommandPalette!: () => void;
  let hideCommandPalette!: () => void;
  let renderShortcutsModal!: () => void;
  let syncCommandShortcuts!: () => void;
  let addNewTab!: (path?: string) => Promise<void>;
  let showPropertiesDialog!: (properties: import('./types').ItemProperties) => void;
  let showSettingsModal!: () => void;
  let hideSettingsModal!: () => void | Promise<void>;
  /* eslint-enable prefer-const */

  const operationQueueController = createOperationQueueController({
    cancelArchiveOperation: (operationId) => window.tauriAPI.cancelArchiveOperation(operationId),
    cancelChecksumCalculation: (operationId) =>
      window.tauriAPI.cancelChecksumCalculation(operationId),
    getOperationPanelCollapsed: () => deps.getCurrentSettings().operationPanelCollapsed === true,
    setOperationPanelCollapsed: (collapsed) => {
      deps.getCurrentSettings().operationPanelCollapsed = collapsed;
      deps.debouncedSaveSettings(100);
    },
  });

  const {
    generateOperationId,
    addOperation,
    updateOperation,
    completeOperation,
    removeOperation,
    getOperation,
    cleanup: cleanupOperationQueue,
  } = operationQueueController;

  const sortController = createSortController({
    getSortBtn: () => sortBtn,
    getCurrentSettings: () => deps.getCurrentSettings(),
    getAllFiles: () => deps.getAllFiles(),
    saveSettingsWithTimestamp: (s) => deps.saveSettingsWithTimestamp(s),
    renderFiles: (f) => deps.late.renderFiles(f),
  });
  const { showSortMenu, hideSortMenu, updateSortIndicators, changeSortMode, handleSortMenuKeyNav } =
    sortController;

  const zoomController = createZoomController({
    setZoomLevel: (level) => window.tauriAPI.setZoomLevel(level),
  });
  const { zoomIn, zoomOut, zoomReset, updateZoomDisplay } = zoomController;

  const indexerController = createIndexerController({
    getShowToast: () => showToast as (message: string, title: string, type: string) => void,
  });
  const { stopIndexStatusPolling, updateIndexStatus, rebuildIndex } = indexerController;

  const layoutController = createLayoutController({
    getCurrentSettings: () => deps.getCurrentSettings(),
    debouncedSaveSettings: () => deps.debouncedSaveSettings(),
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
    getCurrentPath: () => deps.getCurrentPath(),
    getCurrentSettings: () => deps.getCurrentSettings(),
    getShowToast: () => showToast as (message: string, title: string, type: string) => void,
    showConfirm,
    getFileGrid: () => fileGrid,
    getFileView: () => fileView,
    getDropIndicator: () => dropIndicator,
    getDropIndicatorAction: () => dropIndicatorAction,
    getDropIndicatorPath: () => dropIndicatorPath,
    consumeEvent,
    clearSelection: () => clearSelection(),
    navigateTo: (p) => deps.late.navigateTo(p),
    updateUndoRedoState: () => deps.late.updateUndoRedoState(),
    getPlatformOS: () => deps.getPlatformOS(),
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

  const directoryLoader = createDirectoryLoaderController({
    getLoadingEl: () => loading,
    getLoadingTextEl: () => loadingText,
    getEmptyStateEl: () => emptyState,
    cancelDirectoryContents: (operationId) => window.tauriAPI.cancelDirectoryContents(operationId),
    throttleMs: DIRECTORY_PROGRESS_THROTTLE_MS,
  });

  const cleanupDirectoryContentsProgress = window.tauriAPI.onDirectoryContentsProgress(
    (progress) => {
      directoryLoader.handleProgress(progress);
    }
  );
  deps.getIpcCleanupFunctions().push(cleanupDirectoryContentsProgress);

  const cleanupFileOperationProgress = operationQueueController.bindFileOperationProgress();
  deps.getIpcCleanupFunctions().push(cleanupFileOperationProgress);

  const createDirectoryOperationId = directoryLoader.createOperationId;
  const startDirectoryRequest = directoryLoader.startRequest;
  const finishDirectoryRequest = directoryLoader.finishRequest;
  const showLoading = directoryLoader.showLoading;
  const hideLoading = directoryLoader.hideLoading;
  const cancelDirectoryRequest = directoryLoader.cancelRequest;

  // eslint-disable-next-line prefer-const
  let folderIconPickerController!: ReturnType<typeof createFolderIconPickerController>;

  const folderTreeManager = createFolderTreeManager({
    folderTree,
    nameCollator: NAME_COLLATOR,
    getFolderIcon: (p: string) => folderIconPickerController.getFolderIcon(p),
    getBasename: (value) => deps.getDriveLabelByPath().get(value) ?? path.basename(value),
    navigateTo: (value) => deps.late.navigateTo(value),
    handleDrop,
    getDraggedPaths,
    getDragOperation,
    scheduleSpringLoad,
    clearSpringLoad,
    showDropIndicator,
    hideDropIndicator,
    createDirectoryOperationId,
    getDirectoryContents: (dirPath, operationId, showHidden) =>
      window.tauriAPI.getDirectoryContents(dirPath, operationId, showHidden),
    parsePath,
    buildPathFromSegments,
    getCurrentPath: () => deps.getCurrentPath(),
    shouldShowHidden: () => deps.getCurrentSettings().showHiddenFiles,
  });

  const diskSpaceController = createDiskSpaceController({
    getCurrentPath: () => deps.getCurrentPath(),
    getPlatformOS: () => deps.getPlatformOS(),
    formatFileSize,
    isHomeViewPath,
    getDiskSpace: (drivePath) => window.tauriAPI.getDiskSpace(drivePath),
  });
  const { updateDiskSpace } = diskSpaceController;

  const gitStatus = createGitStatusController({
    getCurrentSettings: () => deps.getCurrentSettings(),
    getCurrentPath: () => deps.getCurrentPath(),
    getFileElement: (p) => deps.getFileElementMap().get(p),
    getRenderedPaths: () => deps.getFileElementMap().keys(),
    getGitStatus: (dir, untracked) => window.tauriAPI.getGitStatus(dir, untracked),
    getGitBranch: (dir) => window.tauriAPI.getGitBranch(dir),
  });

  const { clearGitIndicators, fetchGitStatusAsync, updateGitBranch, applyGitIndicatorsToPaths } =
    gitStatus;

  const tourController: TourController = createTourController({
    getSettings: () => deps.getCurrentSettings(),
    saveSettings: (settings) => deps.saveSettingsWithTimestamp(settings),
    onModalOpen: activateModal,
    onModalClose: deactivateModal,
    showCommandPalette: () => showCommandPalette(),
    hideCommandPalette: () => hideCommandPalette(),
    isMac: deps.getPlatformOS() === 'darwin',
  });

  const toastManager = createToastManager({
    durationMs: TOAST_DURATION_MS,
    maxVisible: 3,
    getContainer: () => getById('toast-container'),
    twemojiImg,
  });
  showToast = toastManager.showToast;

  folderIconPickerController = createFolderIconPickerController({
    getCurrentSettings: () => deps.getCurrentSettings(),
    getCurrentPath: () => deps.getCurrentPath(),
    navigateTo: (p) => deps.late.navigateTo(p),
    showToast,
    saveSettings: () => deps.late.saveSettings(),
    activateModal,
    deactivateModal,
    twemojiImg,
    folderIcon: twemojiImg(String.fromCodePoint(0x1f4c1), 'twemoji file-icon'),
  });

  const inlineRenameController = createInlineRenameController({
    getCurrentPath: () => deps.getCurrentPath(),
    getAllFiles: () => deps.getAllFiles(),
    navigateTo: (p) => deps.late.navigateTo(p),
    showToast,
    showAlert,
    showConfirm,
    isHomeViewPath,
    announceToScreenReader,
  });

  function isWindowsPlatform(): boolean {
    return deps.getPlatformOS() === 'win32';
  }

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
    getCurrentPath: () => deps.getCurrentPath(),
    getSelectedItems: () => deps.getSelectedItems(),
    getAllFiles: () => deps.getAllFiles(),
    showToast,
    showConfirm,
    navigateTo: (p) => deps.late.navigateTo(p),
    activateModal,
    deactivateModal,
    addToRecentFiles: (p) => deps.late.addToRecentFiles(p),
    generateOperationId,
    addOperation: (id, type, name) => addOperation(id, type, name, { cancellable: true }),
    getOperation: (id) => {
      const operation = getOperation(id);
      return operation ? { aborted: operation.status === 'cancelling' } : undefined;
    },
    updateOperation: (id, current, total, currentFile) =>
      updateOperation(id, { current, total, currentFile, status: 'active' }),
    completeOperation,
    removeOperation,
    isWindowsPlatform,
  });

  const homeController = createHomeController({
    twemojiImg,
    showToast,
    showConfirm,
    navigateTo: (pathValue) => {
      void deps.late.navigateTo(pathValue);
    },
    handleQuickAction: (action) => {
      void deps.late.handleQuickAction(action);
    },
    getFileIcon,
    formatFileSize,
    getSettings: () => deps.getCurrentSettings(),
    openPath: (filePath) => openPathWithArchivePrompt(filePath, undefined, false),
    onModalOpen: activateModal,
    onModalClose: deactivateModal,
  });

  const navigationController = createNavigationController({
    getCurrentPath: () => deps.getCurrentPath(),
    getCurrentSettings: () => deps.getCurrentSettings(),
    getBreadcrumbContainer: () => getById('breadcrumb-container'),
    getBreadcrumbMenu: () => getById('breadcrumb-menu'),
    getAddressInput: () => getById('address-input') as HTMLInputElement | null,
    getPathDisplayValue,
    isHomeViewPath,
    homeViewLabel: HOME_VIEW_LABEL,
    homeViewPath: HOME_VIEW_PATH,
    navigateTo: (pathValue) => {
      void deps.late.navigateTo(pathValue);
    },
    createDirectoryOperationId,
    nameCollator: NAME_COLLATOR,
    getFolderIcon: (p: string) => folderIconPickerController.getFolderIcon(p),
    getDragOperation,
    showDropIndicator,
    hideDropIndicator,
    getDraggedPaths,
    handleDrop,
    debouncedSaveSettings: deps.debouncedSaveSettings,
    saveSettingsWithTimestamp: deps.saveSettingsWithTimestamp,
    showToast,
    directoryHistoryMax: DIRECTORY_HISTORY_MAX,
  });

  const searchController = createSearchController({
    getCurrentPath: () => deps.getCurrentPath(),
    getSearchScopePath: deps.getSearchScopePath ? () => deps.getSearchScopePath!() : undefined,
    getSearchScopeLabel: deps.getSearchScopeLabel ? () => deps.getSearchScopeLabel!() : undefined,
    getCurrentSettings: () => deps.getCurrentSettings(),
    setAllFiles: (files) => {
      deps.setAllFiles(files);
    },
    renderFiles: (files, highlight) => deps.late.renderFiles(files, highlight),
    showLoading,
    hideLoading,
    updateStatusBar: () => deps.late.updateStatusBar(),
    showToast,
    createDirectoryOperationId,
    navigateTo: (pathValue) => deps.late.navigateTo(pathValue),
    debouncedSaveSettings: deps.debouncedSaveSettings,
    saveSettingsWithTimestamp: deps.saveSettingsWithTimestamp,
    getFileGrid: () => fileGrid,
    setHomeViewActive: (active) => deps.late.setHomeViewActive(active),
    searchDebounceMs: SEARCH_DEBOUNCE_MS,
    searchHistoryMax: SEARCH_HISTORY_MAX,
    announceToScreenReader,
  });

  const previewController = createPreviewController({
    getSelectedItems: () => deps.getSelectedItems(),
    getFileByPath: (p) => deps.late.getFileByPath(p),
    getCurrentSettings: () => deps.getCurrentSettings(),
    formatFileSize,
    getFileExtension,
    getFileIcon,
    openFileEntry,
    openExternal: (url) => {
      void window.tauriAPI.openFile(url);
    },
    onModalOpen: activateModal,
    onModalClose: deactivateModal,
  });

  const selectionController = createSelectionController({
    getSelectedItems: () => deps.getSelectedItems(),
    setSelectedItems: (items) => {
      deps.setSelectedItems(items);
    },
    updateStatusBar: () => deps.late.updateStatusBar(),
    onSelectionChanged: deps.markSelectionDirty,
    isPreviewVisible: () => previewController.isPreviewVisible(),
    updatePreview: (file) => previewController.updatePreview(file),
    clearPreview: () => previewController.clearPreview(),
    getFileByPath: (p) => deps.late.getFileByPath(p),
    getViewMode: () => deps.getViewMode(),
    getFileGrid: () => {
      const isRightPaneActive =
        deps.getCurrentSettings().dualPaneEnabled === true &&
        deps.getCurrentSettings().activePane === 'right';
      if (isRightPaneActive) {
        return document.getElementById('dual-pane-secondary-list') as HTMLElement | null;
      }
      return fileGrid;
    },
    openFileEntry: (file) => {
      const isRightPaneActive =
        deps.getCurrentSettings().dualPaneEnabled === true &&
        deps.getCurrentSettings().activePane === 'right';
      if (isRightPaneActive && file.isDirectory) {
        window.dispatchEvent(
          new CustomEvent('dual-pane-open-directory', {
            detail: { path: file.path },
          })
        );
      } else if (isRightPaneActive && file.isFile) {
        void window.tauriAPI.openFile(file.path);
      } else {
        void openFileEntry(file);
      }
    },
    announceToScreenReader,
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
    cleanup: cleanupSearch,
    showSearchHistoryDropdown,
    hideSearchHistoryDropdown,
    clearSearchHistory,
    getStatusText: getSearchStatusText,
    isSearchMode: isSearchModeActive,
    getSearchInputElement,
    setQuery: setSearchQuery,
    focusInput: focusSearchInput,
    updateContentSearchToggle,
    updateSearchPlaceholder,
  } = searchController;

  const {
    toggleSelection,
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
    invalidateFileItemsCache,
  } = selectionController;
  clearSelection = selectionController.clearSelection;

  const thumbnails = createThumbnailController({
    getCurrentSettings: () => deps.getCurrentSettings(),
    getFileIcon,
    getFileExtension,
    formatFileSize,
    getFileByPath: (p) => deps.late.getFileByPath(p),
  });

  const hoverCardController = createHoverCardController({
    getFileItemData: (el) => deps.late.getFileItemData(el),
    formatFileSize,
    getFileTypeFromName,
    getFileIcon,
    getThumbnailForPath: thumbnails.getThumbnailForPath,
    isRubberBandActive,
    getHoverRoot: () => fileGrid,
    getScrollContainer: () => fileView,
  });

  const {
    setEnabled: setHoverCardEnabled,
    setup: setupHoverCard,
    cleanup: cleanupHoverCard,
  } = hoverCardController;

  const typeaheadController = createTypeaheadController({
    getFileItems: () => getFileItemsArray(),
    clearSelection,
    getSelectedItems: () => deps.getSelectedItems(),
    updateStatusBar: () => deps.late.updateStatusBar(),
    selectSingleItem: (fileItem) => selectionController.selectSingleItem(fileItem),
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
    getCurrentPath: () => deps.getCurrentPath(),
    getCurrentSettings: () => deps.getCurrentSettings(),
    saveSettingsWithTimestamp: deps.saveSettingsWithTimestamp,
    showToast,
    navigateTo: (p) => deps.late.navigateTo(p),
    getDraggedPaths,
    getDragOperation,
    handleDrop,
    showDropIndicator,
    hideDropIndicator,
    consumeEvent,
    renderHomeBookmarks: () => homeController.renderHomeBookmarks(),
  });

  const clipboardController = createClipboardController({
    getSelectedItems: () => deps.getSelectedItems(),
    getCurrentPath: () => deps.getCurrentPath(),
    getFileElementMap: () => deps.getFileElementMap(),
    getCurrentSettings: () => deps.getCurrentSettings(),
    showToast,
    showConfirm,
    handleDrop,
    refresh: () => deps.late.refresh('clipboard-operation'),
    updateUndoRedoState: () => deps.late.updateUndoRedoState(),
  });

  const batchRenameController = createBatchRenameController({
    getSelectedItems: () => deps.getSelectedItems(),
    getAllFiles: () => deps.getAllFiles(),
    showToast,
    activateModal,
    deactivateModal,
    refresh: () => deps.late.refresh('batch-rename'),
    updateUndoRedoState: () => deps.late.updateUndoRedoState(),
  });
  batchRenameController.initListeners();

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
    getCurrentPath: () => deps.getCurrentPath(),
    getFileElementMap: () => deps.getFileElementMap(),
    createNewFolderWithInlineRename: () => inlineRenameController.createNewFolderWithInlineRename(),
    createNewFileWithInlineRename: () => inlineRenameController.createNewFileWithInlineRename(),
    pasteFromClipboard: () => clipboardController.pasteFromClipboard(),
    navigateTo: (p) => deps.late.navigateTo(p),
    showToast,
    openFileEntry: (item) => openFileEntry(item),
    showQuickLookForFile: (item) => showQuickLookForFile(item),
    startInlineRename: (el, name, p) => inlineRenameController.startInlineRename(el, name, p),
    copyToClipboard: () => clipboardController.copyToClipboard(),
    cutToClipboard: () => clipboardController.cutToClipboard(),
    addBookmarkByPath: (p) => addBookmarkByPath(p),
    showFolderIconPicker: (p) => folderIconPickerController.showFolderIconPicker(p),
    showPropertiesDialog: (props) => showPropertiesDialog(props),
    deleteSelected: (permanent) => deps.late.deleteSelected(permanent),
    handleCompress: (format) => handleCompress(format),
    showCompressOptionsModal: () => showCompressOptionsModal(),
    showExtractModal: (archivePath, name) => showExtractModal(archivePath, name),
    getSelectedItems: () => deps.getSelectedItems(),
    showBatchRenameModal: () => batchRenameController.showBatchRenameModal(),
    addNewTab: (p) => addNewTab(p),
    getTabsEnabled: () => deps.getTabsEnabled(),
    pasteIntoFolder: (folderPath) => clipboardController.pasteIntoFolder(folderPath),
    duplicateItems: (paths) => clipboardController.duplicateItems(paths),
    moveSelectedToFolder: () => clipboardController.moveSelectedToFolder(),
    copySelectedToFolder: () => clipboardController.copySelectedToFolder(),
    moveSelectedToDestination: (destinationPath) =>
      clipboardController.moveSelectedToDestination(destinationPath),
    copySelectedToDestination: (destinationPath) =>
      clipboardController.copySelectedToDestination(destinationPath),
    getRecentTransferDestinations: () => deps.getCurrentSettings().recentTransferDestinations ?? [],
    setRecentTransferDestinations: (destinations) => {
      const settings = deps.getCurrentSettings();
      settings.recentTransferDestinations = destinations;
      deps.debouncedSaveSettings(100);
    },
    shareItems: async (filePaths) => {
      const result = await window.tauriAPI.shareItems(filePaths);
      if (!result.success) {
        showToast(result.error || 'Failed to share', 'Error', 'error');
      }
    },
    hasClipboardContent: () => clipboardController.getClipboard() !== null,
  });

  const { cancelColumnOperations, renderColumnView } = createColumnViewController({
    columnView,
    getCurrentPath: () => deps.getCurrentPath(),
    setCurrentPath: (value) => {
      deps.setCurrentPath(value);
    },
    getCurrentSettings: () => deps.getCurrentSettings(),
    getSelectedItems: () => deps.getSelectedItems(),
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
    getCachedDriveInfo: () => deps.getCachedDriveInfo(),
    cacheDriveInfo: deps.cacheDriveInfo,
    folderTreeManager,
    getFileByPath: (filePath) => deps.late.getFileByPath(filePath),
    nameCollator: NAME_COLLATOR,
  });

  const tabsController = createTabsController({
    getTabs: () => deps.getTabs(),
    setTabs: (value) => {
      deps.setTabs(value);
    },
    getActiveTabId: () => deps.getActiveTabId(),
    setActiveTabId: (value) => {
      deps.setActiveTabId(value);
    },
    getTabsEnabled: () => deps.getTabsEnabled(),
    setTabsEnabled: (value) => {
      deps.setTabsEnabled(value);
    },
    getTabNewButtonListenerAttached: () => deps.getTabNewButtonListenerAttached(),
    setTabNewButtonListenerAttached: (value) => {
      deps.setTabNewButtonListenerAttached(value);
    },
    getTabCacheAccessOrder: () => deps.getTabCacheAccessOrder(),
    setTabCacheAccessOrder: (value) => {
      deps.setTabCacheAccessOrder(value);
    },
    getSaveTabStateTimeout: () => deps.getSaveTabStateTimeout(),
    setSaveTabStateTimeout: (value) => {
      deps.setSaveTabStateTimeout(value);
    },
    getCurrentSettings: () => deps.getCurrentSettings(),
    getCurrentPath: () => deps.getCurrentPath(),
    setCurrentPath: (value) => {
      deps.setCurrentPath(value);
    },
    getHistory: () => deps.getHistory(),
    setHistory: (value) => {
      deps.setHistory(value);
    },
    getHistoryIndex: () => deps.getHistoryIndex(),
    setHistoryIndex: (value) => {
      deps.setHistoryIndex(value);
    },
    getSelectedItems: () => deps.getSelectedItems(),
    setSelectedItems: (value) => {
      deps.setSelectedItems(value);
    },
    getAllFiles: () => deps.getAllFiles(),
    setAllFiles: (value) => {
      deps.setAllFiles(value);
    },
    getFileViewScrollTop: () => deps.getFileViewScrollTop(),
    setFileViewScrollTop: (value) => {
      deps.setFileViewScrollTop(value);
    },
    getAddressInput: () => addressInput,
    getPathDisplayValue,
    isHomeViewPath,
    homeViewLabel: HOME_VIEW_LABEL,
    homeViewPath: HOME_VIEW_PATH,
    getViewMode: () => deps.getViewMode(),
    renderFiles: (files) => deps.late.renderFiles(files),
    renderColumnView: () => renderColumnView(),
    updateBreadcrumb,
    updateNavigationButtons: () => deps.late.updateNavigationButtons(),
    setHomeViewActive: (active) => deps.late.setHomeViewActive(active),
    navigateTo: (pathValue, force) => {
      void deps.late.navigateTo(pathValue, force);
    },
    watchDirectory: (pathValue) => {
      window.tauriAPI.watchDirectory(pathValue).catch(ignoreError);
    },
    debouncedSaveSettings: deps.debouncedSaveSettings,
    saveSettingsWithTimestamp: deps.saveSettingsWithTimestamp,
    cancelDirectoryRequest: () => cancelDirectoryRequest(),
    closeSearch: (options) => closeSearch(options),
    isSearchModeActive: () => isSearchModeActive(),
    resetTypeahead: () => resetTypeahead(),
    fetchGitStatusAsync: (path: string) => fetchGitStatusAsync(path),
    updateGitBranch: (path: string) => updateGitBranch(path),
    maxCachedTabs: MAX_CACHED_TABS,
    maxCachedFilesPerTab: MAX_CACHED_FILES_PER_TAB,
    isMainWindow: deps.isMainWindow,
  });

  const {
    initializeTabs,
    closeTab,
    restoreClosedTab,
    saveTabState,
    updateCurrentTabPath,
    switchToTab,
    cleanup: cleanupTabs,
  } = tabsController;
  addNewTab = tabsController.addNewTab;

  const COMMAND_PALETTE_FIXED_SHORTCUTS: Record<string, ShortcutBinding> = {
    refresh: ['F5'],
    delete: ['Delete'],
    rename: ['F2'],
  };

  const shortcutEngine = createShortcutEngineController({
    getPlatformOS: () => deps.getPlatformOS(),
    syncCommandShortcuts: () => syncCommandShortcuts(),
    renderShortcutsModal: () => renderShortcutsModal(),
    debouncedSaveSettings: deps.debouncedSaveSettings,
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

  function navigateHistory(delta: -1 | 1): void {
    const hi = deps.getHistoryIndex();
    const h = deps.getHistory();
    const nextIndex = hi + delta;
    if (nextIndex < 0 || nextIndex >= h.length) return;
    deps.setHistoryIndex(nextIndex);
    void deps.late.navigateTo(h[nextIndex]!, true);
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
    const cp = deps.getCurrentPath();
    if (!cp) return;
    if (isRootPath(cp)) return;
    const parentPath = path.dirname(cp);
    if (!parentPath) return;
    deps.late.navigateTo(parentPath);
  }

  const duplicateFinderController = createDuplicateFinderController({
    getCurrentPath: () => deps.getCurrentPath(),
    isHomeViewPath,
    formatFileSize,
    showToast,
    showConfirm,
    onModalOpen: activateModal,
    onModalClose: deactivateModal,
    refresh: (reason?: string) => deps.late.refresh(reason),
    navigateTo: (pathValue) => deps.late.navigateTo(pathValue),
  });

  const commandPaletteController = createCommandPaletteController({
    activateModal,
    deactivateModal,
    showToast,
    getShortcutBinding,
    fixedShortcuts: COMMAND_PALETTE_FIXED_SHORTCUTS,
    remappableCommandIds: new Set(SHORTCUT_DEFINITIONS.map((def) => def.id)),
    formatShortcutKeyLabel,
    getTabsEnabled: () => deps.getTabsEnabled(),
    twemojiImg,
    actions: {
      createNewFolder: () => {
        void inlineRenameController.createNewFolder();
      },
      createNewFile: () => {
        void inlineRenameController.createNewFile();
      },
      refresh: () => {
        deps.late.refresh('command-palette');
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
      goHome: () => {
        deps.late.navigateTo(HOME_VIEW_PATH);
      },
      findDuplicates: () => {
        void duplicateFinderController.openDuplicateFinderModal();
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
        deps.late.deleteSelected();
      },
      renameSelected: () => {
        deps.late.renameSelected();
      },
      setViewMode: (mode) => {
        void deps.late.setViewMode(mode);
      },
      addNewTab: () => {
        void addNewTab();
      },
    },
  });

  const { initCommandPalette } = commandPaletteController;
  showCommandPalette = commandPaletteController.showCommandPalette;
  hideCommandPalette = commandPaletteController.hideCommandPalette;
  syncCommandShortcuts = commandPaletteController.syncCommandShortcuts;

  const cleanupNativeMenuCommand =
    window.tauriAPI.onNativeMenuCommand?.((command) => {
      const run: Record<string, () => void> = {
        'new-window': () => void window.tauriAPI.openNewWindow(),
        'new-tab': () => void addNewTab(),
        'new-file': () => void inlineRenameController.createNewFile(),
        'new-folder': () => void inlineRenameController.createNewFolder(),
        copy: () => clipboardController.copyToClipboard(),
        cut: () => clipboardController.cutToClipboard(),
        paste: () => void clipboardController.pasteFromClipboard(),
        rename: () => void deps.late.renameSelected(),
        delete: () => void deps.late.deleteSelected(),
        refresh: () => deps.late.refresh('native-menu'),
        back: () => goBack(),
        forward: () => goForward(),
        up: () => goUp(),
        home: () => void deps.late.navigateTo(HOME_VIEW_PATH),
        'view-grid': () => void deps.late.setViewMode('grid'),
        'view-list': () => void deps.late.setViewMode('list'),
        'view-column': () => void deps.late.setViewMode('column'),
        'dual-pane': () => {
          const settings = deps.getCurrentSettings();
          settings.dualPaneEnabled = !settings.dualPaneEnabled;
          deps.late.applySettings(settings);
          deps.debouncedSaveSettings(100);
          showToast(
            settings.dualPaneEnabled ? 'Dual pane enabled' : 'Dual pane disabled',
            'View',
            'info'
          );
        },
        'command-palette': () => showCommandPalette(),
        'find-duplicates': () => void duplicateFinderController.openDuplicateFinderModal(),
        settings: () => showSettingsModal(),
        shortcuts: () => showShortcutsModal(),
      };
      run[command]?.();
    }) ?? (() => {});
  deps.getIpcCleanupFunctions().push(cleanupNativeMenuCommand);

  const cleanupNativeOpenPath =
    window.tauriAPI.onNativeOpenPath?.((openPath) => {
      void openPathWithArchivePrompt(openPath, undefined, true);
    }) ?? (() => {});
  deps.getIpcCleanupFunctions().push(cleanupNativeOpenPath);

  const shortcutsUi = createShortcutsUiController({
    isMacPlatform,
    formatShortcutKeyLabel,
    getDefaultShortcuts: () =>
      getDefaultShortcuts(isMacPlatform() ? 'darwin' : deps.getPlatformOS()),
    shortcutDefinitions: SHORTCUT_DEFINITIONS,
    getShortcutBindings,
    setShortcutBindings,
    normalizeShortcutBinding,
    areBindingsEqual,
    getCurrentSettings: () => deps.getCurrentSettings(),
    rebuildShortcutLookup,
    syncCommandShortcuts,
    debouncedSaveSettings: deps.debouncedSaveSettings,
    eventToBinding,
    hasModifier,
    serializeShortcut,
    reservedShortcutLookup,
    shortcutLookup,
    shortcutDefinitionById,
    showToast,
  });

  const { initShortcutsModal, stopShortcutCapture, isShortcutCaptureActive } = shortcutsUi;
  renderShortcutsModal = shortcutsUi.renderShortcutsModal;

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

  const settingsUi = createSettingsUiController({
    updateDangerousOptionsVisibility: (show) => deps.late.updateDangerousOptionsVisibility(show),
    saveSettings: () => deps.late.saveSettings(),
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
    isSettingsDirty,
  } = settingsUi;

  const themeEditorController = createThemeEditorController({
    getCurrentSettings: () => deps.getCurrentSettings(),
    setCurrentSettingsTheme: (theme, customTheme) => {
      const s = deps.getCurrentSettings();
      s.theme = theme;
      s.customTheme = customTheme;
      deps.setCurrentSettings(s);
    },
    applySettings: (s) => deps.late.applySettings(s),
    saveSettingsWithTimestamp: deps.saveSettingsWithTimestamp,
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
    getCurrentSettings: () => deps.getCurrentSettings(),
    activateModal,
    deactivateModal,
    setSuppressSettingsTracking,
    activateSettingsTab,
    updateCustomThemeUI,
    updateDangerousOptionsVisibility: (show) => deps.late.updateDangerousOptionsVisibility(show),
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
    isSettingsDirty,
    showConfirm,
  });

  showSettingsModal = settingsModalController.showSettingsModal;
  hideSettingsModal = settingsModalController.hideSettingsModal; // eslint-disable-line prefer-const

  const settingsActionsController = createSettingsActionsController({
    getCurrentSettings: () => deps.getCurrentSettings(),
    setCurrentSettings: (settings) => {
      deps.setCurrentSettings(settings);
    },
    saveSettingsWithTimestamp: deps.saveSettingsWithTimestamp,
    showToast,
    showConfirm,
    loadBookmarks,
    updateThumbnailCacheSize: thumbnails.updateThumbnailCacheSize,
    clearThumbnailCacheLocal: thumbnails.clearThumbnailCache,
    hideSettingsModal,
    showSettingsModal,
  });

  const { initSettingsActions } = settingsActionsController;

  const supportUiController = createSupportUiController({
    activateModal,
    deactivateModal,
    escapeHtml,
    getErrorMessage,
    getCurrentSettings: () => deps.getCurrentSettings(),
    saveSettingsWithTimestamp: deps.saveSettingsWithTimestamp,
    openExternal: (url) => {
      window.tauriAPI.openFile(url);
    },
  });

  const {
    showLicensesModal,
    hideLicensesModal,
    initLicensesUi,
    showSupportPopup,
    initSupportPopup,
  } = supportUiController;

  const externalLinksController = createExternalLinksController({
    openExternal: (url) => {
      window.tauriAPI.openFile(url);
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

  showPropertiesDialog = propertiesDialogController.showPropertiesDialog;
  const { cleanup: cleanupPropertiesDialog } = propertiesDialogController;

  const updateActionsController = createUpdateActionsController({
    showDialog,
    showToast,
    formatFileSize,
    onModalOpen: activateModal,
    onModalClose: deactivateModal,
  });

  const {
    restartAsAdmin,
    checkForUpdates,
    silentCheckAndDownload,
    handleUpdateDownloaded,
    handleSettingsModalClosed,
  } = updateActionsController;
  onSettingsModalHide = handleSettingsModalClosed;

  return {
    operationQueueController,
    generateOperationId,
    addOperation,
    updateOperation,
    completeOperation,
    removeOperation,
    getOperation,
    cleanupOperationQueue,

    sortController,
    showSortMenu,
    hideSortMenu,
    updateSortIndicators,
    changeSortMode,
    handleSortMenuKeyNav,

    zoomController,
    zoomIn,
    zoomOut,
    zoomReset,
    updateZoomDisplay,

    indexerController,
    stopIndexStatusPolling,
    updateIndexStatus,
    rebuildIndex,

    layoutController,
    applyListColumnWidths,
    applySidebarWidth,
    applyPreviewPanelWidth,
    setSidebarCollapsed,
    syncSidebarToggleState,
    setupSidebarResize,
    setupSidebarSections,
    setupPreviewResize,
    setupListHeader,

    dragDropController,
    getDragOperation,
    getDraggedPaths,
    showDropIndicator,
    hideDropIndicator,
    scheduleSpringLoad,
    clearSpringLoad,
    handleDrop,
    initDragAndDropListeners,

    directoryLoader,
    createDirectoryOperationId,
    startDirectoryRequest,
    finishDirectoryRequest,
    showLoading,
    hideLoading,
    cancelDirectoryRequest,

    folderTreeManager,

    diskSpaceController,
    updateDiskSpace,

    gitStatus,
    clearGitIndicators,
    fetchGitStatusAsync,
    updateGitBranch,
    applyGitIndicatorsToPaths,

    tourController,

    toastManager,
    showToast,

    folderIconPickerController,
    inlineRenameController,

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

    homeController,

    navigationController,
    updateBreadcrumb,
    setupBreadcrumbListeners,
    hideBreadcrumbMenu,
    addToDirectoryHistory,
    showDirectoryHistoryDropdown,
    hideDirectoryHistoryDropdown,
    clearDirectoryHistory,
    getBreadcrumbMenuElement,
    isBreadcrumbMenuOpen,

    searchController,
    initSearchListeners,
    closeSearch,
    openSearch,
    performSearch,
    cancelActiveSearch,
    cleanupSearch,
    showSearchHistoryDropdown,
    hideSearchHistoryDropdown,
    clearSearchHistory,
    getSearchStatusText,
    isSearchModeActive,
    getSearchInputElement,
    setSearchQuery,
    focusSearchInput,
    updateContentSearchToggle,
    updateSearchPlaceholder,

    previewController,
    initPreviewUi,
    updatePreview,
    showQuickLook,
    showQuickLookForFile,
    closeQuickLook,
    isQuickLookOpen,

    selectionController,
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
    invalidateFileItemsCache,

    thumbnails,
    hoverCardController,
    setHoverCardEnabled,
    setupHoverCard,
    cleanupHoverCard,

    typeaheadController,
    handleTypeaheadInput,
    resetTypeahead,

    loadBookmarks,
    addBookmark,
    addBookmarkByPath,

    clipboardController,
    batchRenameController,

    showContextMenu,
    hideContextMenu,
    showEmptySpaceContextMenu,
    hideEmptySpaceContextMenu,
    handleContextMenuAction,
    handleEmptySpaceContextMenuAction,
    handleContextMenuKeyNav,
    getContextMenuData,

    cancelColumnOperations,
    renderColumnView,

    tabsController,
    initializeTabs,
    addNewTab,
    closeTab,
    restoreClosedTab,
    saveTabState,
    updateCurrentTabPath,
    switchToTab,
    cleanupTabs,

    COMMAND_PALETTE_FIXED_SHORTCUTS,
    isWindowsPlatform,

    shortcutEngine,
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

    commandPaletteController,
    initCommandPalette,
    showCommandPalette,
    hideCommandPalette,
    syncCommandShortcuts,

    shortcutsUi,
    renderShortcutsModal,
    initShortcutsModal,
    stopShortcutCapture,
    isShortcutCaptureActive,

    showShortcutsModal,
    hideShortcutsModal,

    settingsUi,
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

    themeEditorController,
    applyCustomThemeColors,
    clearCustomThemeColors,
    setupThemeEditorListeners,
    updateCustomThemeUI,

    settingsModalController,
    showSettingsModal,
    hideSettingsModal,

    settingsActionsController,
    initSettingsActions,

    supportUiController,
    showLicensesModal,
    hideLicensesModal,
    initLicensesUi,
    showSupportPopup,
    initSupportPopup,
    externalLinksController,
    initExternalLinks,

    propertiesDialogController,
    showPropertiesDialog,
    cleanupPropertiesDialog,

    updateActionsController,
    restartAsAdmin,
    checkForUpdates,
    silentCheckAndDownload,
    handleUpdateDownloaded,
    handleSettingsModalClosed,
  };
}
