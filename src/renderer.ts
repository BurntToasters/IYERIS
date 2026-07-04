import type { Settings, FileItem, DriveInfo } from './types';
import { assignKey, getErrorMessage, ignoreError, devLog } from './shared.js';
import type { TabData } from './rendererTabs.js';
import { showConfirm } from './rendererModals.js';
import { isPermissionDeniedError } from './rendererClipboard.js';
import { initTooltipSystem } from './rendererTooltips.js';
import {
  isWindowsPath,
  normalizeWindowsPath,
  rendererPath as path,
  twemojiImg,
} from './rendererUtils.js';
import { createDefaultSettings, sanitizeSettings } from './settings.js';
import { setLocale, detectLocale, t } from './i18n.js';

import { HOME_VIEW_LABEL, HOME_VIEW_PATH, isHomeViewPath } from './home.js';

import { createFileRenderController } from './rendererFileRender.js';
import { createFileGridEventsController } from './rendererFileGridEvents.js';
import { createEventListenersController } from './rendererEventListeners.js';
import { createBootstrapController } from './rendererBootstrap.js';
import { createUtilityDrawerController } from './rendererUtilityDrawer.js';
import { moveGridFocusWithinScope } from './rendererSelection.js';
import { applyAppearance } from './rendererAppearance.js';
import {
  SETTINGS_SAVE_DEBOUNCE_MS,
  SEARCH_HISTORY_MAX,
  DIRECTORY_HISTORY_MAX,
  SUPPORT_POPUP_DELAY_MS,
  NAME_COLLATOR,
  DATE_FORMATTER,
  consumeEvent,
  type ViewMode,
} from './rendererLocalConstants.js';
import {
  TOGGLE_MAPPINGS,
  SELECT_MAPPINGS,
  INT_RANGE_MAPPINGS,
} from './rendererSettingsMappings.js';
import { wireControllers, type LateBound } from './rendererControllerWiring.js';
import { createDualPaneController } from './rendererDualPane.js';
import { createStatusBarController } from './rendererStatusBar.js';
import { createRecentFilesController } from './rendererRecentFiles.js';
import { createSidebarController } from './rendererSidebar.js';
import { isOneOf } from './constants.js';
import { renderSkeleton, clearSkeleton } from './rendererSkeleton.js';
import { isForeground, markDirtyRefresh } from './rendererActivityState.js';

const fileElementMap: Map<string, HTMLElement> = new Map();
let utilityDrawerController: ReturnType<typeof createUtilityDrawerController> | null = null;
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

async function saveSettingsWithTimestamp(settings: Settings) {
  if (isResettingSettings) {
    return { success: true as const };
  }
  settings._timestamp = Date.now();
  return window.tauriAPI.saveSettings(settings);
}

let settingsSaveTimeout: ReturnType<typeof setTimeout> | null = null;
let settingsSaveInFlight = false;
let settingsSavePending = false;
let lastSettingsSaveErrorAt = 0;

function notifySettingsSaveError(error?: string): void {
  const now = Date.now();
  if (now - lastSettingsSaveErrorAt < 5000) return;
  lastSettingsSaveErrorAt = now;
  showToast(
    t('toast.settingsSaveFailed', { error: error || t('common.operationFailed') }),
    t('common.error'),
    'error'
  );
}

function executeSettingsSave(): void {
  if (settingsSaveInFlight) {
    settingsSavePending = true;
    return;
  }
  settingsSaveInFlight = true;
  settingsSavePending = false;
  saveSettingsWithTimestamp(currentSettings)
    .then((result) => {
      if (!result.success) {
        notifySettingsSaveError(result.error);
      }
    })
    .catch((error) => {
      notifySettingsSaveError(getErrorMessage(error));
    })
    .finally(() => {
      settingsSaveInFlight = false;
      if (settingsSavePending) {
        executeSettingsSave();
      }
    });
}

function debouncedSaveSettings(delay: number = SETTINGS_SAVE_DEBOUNCE_MS) {
  if (settingsSaveTimeout) {
    clearTimeout(settingsSaveTimeout);
  }
  settingsSaveTimeout = setTimeout(() => {
    settingsSaveTimeout = null;
    executeSettingsSave();
  }, delay);
}

function flushDebouncedSettingsSave(): void {
  if (!settingsSaveTimeout) return;
  clearTimeout(settingsSaveTimeout);
  settingsSaveTimeout = null;
  if (isResettingSettings) return;
  currentSettings._timestamp = Date.now();
  void window.tauriAPI.saveSettingsSync(currentSettings);
}

const ipcCleanupFunctions: (() => void)[] = [];

let currentPath: string = '';
let history: string[] = [];
let historyIndex: number = -1;
let selectedItems: Set<string> = new Set();
let primaryPaneSelectedItems: Set<string> = new Set();
let secondaryPaneSelectedItems: Set<string> = new Set();
let recentlyPastedPaths: Set<string> = new Set();
let recentlyRenamedPath: string | null = null;
let selectedItemsSizeBytes = 0;
let selectedItemsSizeDirty = true;
let viewMode: ViewMode = 'grid';
let allFiles: FileItem[] = [];
let hiddenFilesCount = 0;
let platformOS: string = '';
let canUndo: boolean = false;
let canRedo: boolean = false;
let folderTreeEnabled: boolean = true;
let isNavigating: boolean = false;
let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRefreshReason: string | null = null;
let navigationSequence = 0;

function markSelectionDirty(): void {
  selectedItemsSizeDirty = true;
}

function setSelectedItemsState(value: Set<string>): void {
  selectedItems = value;
  if (currentSettings.dualPaneEnabled && currentSettings.activePane === 'right') {
    secondaryPaneSelectedItems = new Set(value);
  } else {
    primaryPaneSelectedItems = new Set(value);
  }
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

let tabs: TabData[] = [];
let activeTabId: string = '';
let tabsEnabled: boolean = false;
let tabNewButtonListenerAttached: boolean = false;

let tabCacheAccessOrder: string[] = [];
let saveTabStateTimeout: NodeJS.Timeout | null = null;

import {
  addressInput,
  fileGrid,
  fileView,
  columnView,
  homeView,
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
  sortBtn,
  bookmarkAddBtn,
  selectionCopyBtn,
  selectionCutBtn,
  selectionMoveBtn,
  selectionRenameBtn,
  selectionDeleteBtn,
  announceToScreenReader,
} from './rendererElements.js';

let currentSettings: Settings = createDefaultSettings();
let isResettingSettings = false;

const late = {} as LateBound;
const isMainWindow = window.tauriAPI.getWindowLabel() === 'main';

const wired = wireControllers({
  getCurrentPath: () => currentPath,
  getSearchScopePath: () => {
    if (currentSettings.dualPaneEnabled === true && currentSettings.activePane === 'right') {
      return dualPane.getSecondaryPanePath() || currentPath;
    }
    return currentPath;
  },
  getSearchScopeLabel: () => {
    if (currentSettings.dualPaneEnabled === true && currentSettings.activePane === 'right') {
      return 'right pane';
    }
    return 'files';
  },
  setCurrentPath: (v) => {
    currentPath = v;
  },
  getCurrentSettings: () => currentSettings,
  setCurrentSettings: (s) => {
    currentSettings = s;
  },
  getSelectedItems: () => selectedItems,
  setSelectedItems: (v) => {
    setSelectedItemsState(v);
  },
  clearSelectedItemsState,
  markSelectionDirty,
  getAllFiles: () => allFiles,
  setAllFiles: (v) => {
    allFiles = v;
  },
  getViewMode: () => viewMode,
  getPlatformOS: () => platformOS,
  getHistory: () => history,
  setHistory: (v) => {
    history = v;
  },
  getHistoryIndex: () => historyIndex,
  setHistoryIndex: (v) => {
    historyIndex = v;
  },
  getTabs: () => tabs,
  setTabs: (v) => {
    tabs = v;
  },
  getActiveTabId: () => activeTabId,
  setActiveTabId: (v) => {
    activeTabId = v;
  },
  getTabsEnabled: () => tabsEnabled,
  setTabsEnabled: (v) => {
    tabsEnabled = v;
  },
  getTabNewButtonListenerAttached: () => tabNewButtonListenerAttached,
  setTabNewButtonListenerAttached: (v) => {
    tabNewButtonListenerAttached = v;
  },
  getTabCacheAccessOrder: () => tabCacheAccessOrder,
  setTabCacheAccessOrder: (v) => {
    tabCacheAccessOrder = v;
  },
  getSaveTabStateTimeout: () => saveTabStateTimeout,
  setSaveTabStateTimeout: (v) => {
    saveTabStateTimeout = v;
  },
  getFileViewScrollTop: () => fileView?.scrollTop || 0,
  setFileViewScrollTop: (v) => {
    if (fileView) fileView.scrollTop = v;
  },
  saveSettingsWithTimestamp: (s) => saveSettingsWithTimestamp(s),
  debouncedSaveSettings: (delay) => debouncedSaveSettings(delay),
  getFileElementMap: () => fileElementMap,
  getDriveLabelByPath: () => driveLabelByPath,
  getCachedDriveInfo: () => cachedDriveInfo,
  cacheDriveInfo,
  getIpcCleanupFunctions: () => ipcCleanupFunctions,
  isMainWindow,
  late,
});

const {
  generateOperationId,
  addOperation,
  updateOperation,
  completeOperation,
  isOperationCancelling,
  cleanupOperationQueue,
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
  stopIndexStatusPolling,
  rebuildIndex,
  applyListColumnWidths,
  applySidebarWidth,
  applyPreviewPanelWidth,
  setSidebarCollapsed,
  syncSidebarToggleState,
  setupSidebarResize,
  setupSidebarSections,
  setupPreviewResize,
  setupListHeader,
  getDragOperation,
  getDraggedPaths,
  showDropIndicator,
  hideDropIndicator,
  scheduleSpringLoad,
  clearSpringLoad,
  handleDrop,
  initDragAndDropListeners,
  directoryLoader,
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
  folderIconPickerController,
  inlineRenameController,
  hideCompressOptionsModal,
  hideExtractModal,
  openPathWithArchivePrompt,
  openFileEntry,
  confirmExtractModal,
  updateExtractPreview,
  setupCompressOptionsModal,
  homeController,
  updateBreadcrumb,
  setupBreadcrumbListeners,
  hideBreadcrumbMenu,
  addToDirectoryHistory,
  showDirectoryHistoryDropdown,
  hideDirectoryHistoryDropdown,
  clearDirectoryHistory,
  getBreadcrumbMenuElement,
  isBreadcrumbMenuOpen,
  initSearchListeners,
  closeSearch,
  openSearch,
  performSearch,
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
  showQuickLook,
  closeQuickLook,
  isQuickLookOpen,
  toggleSelection,
  clearSelection,
  selectAll,
  openSelectedItem,
  navigateFileGrid,
  selectFirstItem,
  selectLastItem,
  navigateByPage,
  setupRubberBandSelection,
  ensureActiveItem,
  invalidateGridColumnsCache,
  invalidateFileItemsCache,
  thumbnails,
  setHoverCardEnabled,
  setupHoverCard,
  cleanupHoverCard,
  handleTypeaheadInput,
  resetTypeahead,
  loadBookmarks,
  addBookmark,
  clipboardController,
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
  initializeTabs,
  addNewTab,
  closeTab,
  restoreClosedTab,
  saveTabState,
  updateCurrentTabPath,
  switchToTab,
  cleanupTabs,
  getFixedShortcutActionIdFromEvent,
  syncShortcutBindingsFromSettings,
  getShortcutActionIdFromEvent,
  initCommandPalette,
  showCommandPalette,
  initShortcutsModal,
  isShortcutCaptureActive,
  showShortcutsModal,
  hideShortcutsModal,
  initSettingsTabs,
  initSettingsUi,
  captureSettingsFormState,
  applySettingsFormState,
  buildSettingsFormStateFromSettings,
  clearSettingsChanged,
  getSavedState,
  setSavedState,
  resetRedoState,
  applyCustomThemeColors,
  clearCustomThemeColors,
  setupThemeEditorListeners,
  updateCustomThemeUI,
  showSettingsModal,
  hideSettingsModal,
  initSettingsActions,
  hideLicensesModal,
  initLicensesUi,
  showSupportPopup,
  initSupportPopup,

  initExternalLinks,
  showPropertiesDialog,
  cleanupPropertiesDialog,
  restartAsAdmin,
  checkForUpdates,
  silentCheckAndDownload,
  handleUpdateDownloaded,
} = wired;
const showToast = toastManager.showToast;

const dualPane = createDualPaneController({
  getCurrentSettings: () => currentSettings,
  getCurrentPath: () => currentPath,
  getSelectedItems: () => selectedItems,
  setSelectedItems: (v) => setSelectedItemsState(v),
  getPrimaryPaneSelected: () => primaryPaneSelectedItems,
  setPrimaryPaneSelected: (v) => {
    primaryPaneSelectedItems = v;
  },
  getSecondaryPaneSelected: () => secondaryPaneSelectedItems,
  setSecondaryPaneSelected: (v) => {
    secondaryPaneSelectedItems = v;
  },
  getFileElementMap: () => fileElementMap,
  updateStatusBar: () => updateStatusBar(),
  debouncedSaveSettings: (delay) => debouncedSaveSettings(delay),
  showToast,
  refresh: (reason) => refresh(reason),
  navigateTo: (p) => {
    void navigateTo(p);
  },
  observeThumbnailItem: (row, scope) => thumbnails.observeThumbnailItem(row, scope),
  showContextMenu: (x, y, item) => showContextMenu(x, y, item),
  getDragOperation: (e) => getDragOperation(e),
  getDraggedPaths: (e) => getDraggedPaths(e),
  showDropIndicator: (op, p, x, y) => showDropIndicator(op, p, x, y),
  hideDropIndicator: () => hideDropIndicator(),
  scheduleSpringLoad: (row, action) => scheduleSpringLoad(row, action),
  clearSpringLoad: () => clearSpringLoad(),
  handleDrop: (paths, dest, op) => handleDrop(paths, dest, op),
  copySelectedToDestination: (dest) => clipboardController.copySelectedToDestination(dest),
  moveSelectedToDestination: (dest) => clipboardController.moveSelectedToDestination(dest),
  ensureActiveItem: () => ensureActiveItem(),
  invalidateFileItemsCache: () => invalidateFileItemsCache(),
});
const { getActiveFileGridScope, syncDualPaneControls, setActivePane, loadSecondaryPane } = dualPane;

const statusBarController = createStatusBarController({
  getCurrentSettings: () => currentSettings,
  getSelectedItems: () => selectedItems,
  getAllFiles: () => allFiles,
  getSecondaryPaneItems: () => dualPane.getSecondaryPaneItems(),
  getSelectedItemsSizeBytes: () => getSelectedItemsSizeBytes(),
  getHiddenFilesCount: () => hiddenFilesCount,
  getCurrentPath: () => currentPath,
  getViewMode: () => viewMode,
  getSearchStatusText: () => getSearchStatusText(),
  syncDualPaneControls: () => syncDualPaneControls(),
  updateUtilitySelection: (p) => utilityDrawerController?.updateSelection(p),
  saveSettings: () => debouncedSaveSettings(),
  updateGitBranch: (p) => updateGitBranch(p),
  updateClipboardIndicator: () => clipboardController.updateClipboardIndicator(),
});
const { update: updateStatusBar } = statusBarController;

const { loadRecentFiles, addToRecentFiles } = createRecentFilesController({
  getCurrentSettings: () => currentSettings,
  debouncedSaveSettings: () => debouncedSaveSettings(),
  openPath: (filePath, name, isDirectory) => openPathWithArchivePrompt(filePath, name, isDirectory),
  renderHomeRecents: () => homeController.renderHomeRecents(),
});

const { renderSidebarQuickAccess, handleQuickAction, loadDrives } = createSidebarController({
  getCurrentSettings: () => currentSettings,
  navigateTo: (p) => navigateTo(p),
  showToast,
  getVisibleSidebarQuickAccessItems: () => homeController.getVisibleSidebarQuickAccessItems(),
  renderHomeDrives: (drives) => homeController.renderHomeDrives(drives),
  cacheDriveInfo: (drives) => cacheDriveInfo(drives),
  renderFolderTree: (drivePaths) => folderTreeManager.render(drivePaths),
});

function syncOsAccessibilityPreferences(settings: Settings): void {
  const isFirstLaunch = (settings.launchCount || 0) === 0;

  if (isFirstLaunch) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      settings.reduceMotion = true;
    }
    if (window.matchMedia('(prefers-contrast: more)').matches) {
      settings.highContrast = true;
    }
    if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) {
      settings.reduceTransparency = true;
    }
  }
}

let scalingWarningShown = false;
let settingsFullyLoaded = false;
function warnIfMultipleScalingActive(settings: Settings): void {
  if (!settingsFullyLoaded) return;
  const activeCount =
    (settings.largeText ? 1 : 0) +
    (settings.useSystemFontSize ? 1 : 0) +
    (settings.uiDensity === 'larger' ? 1 : 0);
  if (activeCount >= 2 && !scalingWarningShown) {
    scalingWarningShown = true;
    showToast('Multiple text scaling options are active and may compound', 'Accessibility', 'info');
  } else if (activeCount < 2) {
    scalingWarningShown = false;
  }
}

async function loadSettings(): Promise<void> {
  const [result, sharedClipboard] = await Promise.all([
    window.tauriAPI.getSettings(),
    window.tauriAPI.getClipboard(),
  ]);

  if (result.success) {
    currentSettings = sanitizeSettings(result.settings ?? {});
    syncShortcutBindingsFromSettings(currentSettings, { save: true });

    syncOsAccessibilityPreferences(currentSettings);

    applySettings(currentSettings);
    const newLaunchCount = (currentSettings.launchCount || 0) + 1;
    currentSettings.launchCount = newLaunchCount;
    debouncedSaveSettings(100);

    if (newLaunchCount === 2 && !currentSettings.supportPopupDismissed) {
      setTimeout(() => showSupportPopup(), SUPPORT_POPUP_DELAY_MS);
    }
    tourController.handleLaunch(newLaunchCount);
  } else {
    currentSettings = createDefaultSettings();
    syncOsAccessibilityPreferences(currentSettings);
    applySettings(currentSettings);
  }

  if (sharedClipboard) {
    clipboardController.setClipboard(sharedClipboard);
  }

  settingsFullyLoaded = true;

  let focusDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('focus', () => {
    devLog('Focus', 'Window focus event — debouncing clipboard indicator update');
    if (focusDebounceTimer) clearTimeout(focusDebounceTimer);
    focusDebounceTimer = setTimeout(() => {
      clipboardController.updateClipboardIndicator();
    }, 300);
  });
}

async function applySystemFontSize(): Promise<void> {
  try {
    const scaleFactor = await window.tauriAPI.getSystemTextScale();
    const fontScale = 1 + (scaleFactor - 1) * 0.5;
    document.documentElement.style.setProperty('--system-font-scale', fontScale.toString());
    document.body.classList.add('use-system-font-size');
  } catch (error) {
    devLog('Settings', 'Failed to get system text scale', error);
  }
}

function applySettings(settings: Settings) {
  devLog('Settings', 'applySettings', { viewMode: settings.viewMode, theme: settings.theme });
  setLocale(
    detectLocale(settings.language && settings.language !== 'auto' ? settings.language : undefined)
  );
  applyAppearance(settings, {
    applyCustomThemeColors,
    clearCustomThemeColors,
  });

  if (settings.viewMode && settings.viewMode !== viewMode) {
    viewMode = settings.viewMode;
    void applyViewMode();
  }

  applyListColumnWidths();
  applySidebarWidth();
  applyPreviewPanelWidth();
  updateSortIndicators();

  if (settings.useSystemFontSize) {
    applySystemFontSize();
  } else {
    document.documentElement.style.removeProperty('--system-font-scale');
    document.body.classList.remove('use-system-font-size');
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
    void loadDrives();
  }
  folderTreeEnabled = nextFolderTreeEnabled;

  loadBookmarks();
  loadRecentFiles();
  document.body.classList.toggle('dual-pane-enabled', settings.dualPaneEnabled === true);
  setActivePane(settings.activePane === 'right' ? 'right' : 'left', false);
  if (
    settings.dualPaneEnabled &&
    !dualPane.getSecondaryPanePath() &&
    currentPath &&
    !isHomeViewPath(currentPath)
  ) {
    void loadSecondaryPane(currentPath);
  } else if (!settings.dualPaneEnabled) {
    dualPane.clearSecondaryPane();
    setActivePane('left', false);
  }
  syncDualPaneControls();

  window.tauriAPI.setUpdateChannel(settings.updateChannel || 'auto');

  updateContentSearchToggle();
  updateSearchPlaceholder();

  warnIfMultipleScalingActive(settings);
}

function updateDangerousOptionsVisibility(show: boolean) {
  const dangerousOptions = document.querySelectorAll('.dangerous-option');
  dangerousOptions.forEach((option) => {
    (option as HTMLElement).style.display = show ? 'flex' : 'none';
  });
}

function openNewWindow() {
  void (async () => {
    if (tabsEnabled) {
      try {
        await saveTabState(true);
      } catch (error) {
        devLog('Tabs', 'Failed to persist tab state before opening new window', error);
      }
    }
    await window.tauriAPI.openNewWindow();
  })().catch((error) => {
    devLog('Window', 'Failed to open new window', error);
  });
}

async function saveSettings() {
  const previousTabsEnabled = tabsEnabled;
  const previousDisableHwAccel = currentSettings.disableHardwareAcceleration;
  const previousNativeMenu = currentSettings.nativeMenuEnabled ?? true;

  for (const [id, key] of TOGGLE_MAPPINGS) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) assignKey(currentSettings, key, el.checked as Settings[keyof Settings]);
  }

  for (const [id, key, validValues] of SELECT_MAPPINGS) {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    if (el && isOneOf(el.value, validValues)) {
      assignKey(currentSettings, key, el.value as Settings[keyof Settings]);
    }
  }

  for (const [id, key, min, max] of INT_RANGE_MAPPINGS) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) {
      const val = parseInt(el.value, 10);
      if (!isNaN(val) && val >= min && val <= max)
        assignKey(currentSettings, key, val as Settings[keyof Settings]);
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
  if (iconSizeSlider) {
    const iconSizeVal = parseInt(iconSizeSlider.value, 10);
    if (!isNaN(iconSizeVal)) currentSettings.iconSize = iconSizeVal;
  }

  // System theme override
  if (currentSettings.useSystemTheme) {
    try {
      const { isDarkMode } = await window.tauriAPI.getSystemAccentColor();
      const systemTheme = isDarkMode ? 'default' : 'light';
      currentSettings.theme = systemTheme;
    } catch (error) {
      devLog('Settings', 'Failed to apply system theme', error);
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
  if (!result.success) {
    showToast('Failed to save settings: ' + (result.error || 'Operation failed'), 'Error', 'error');
    return;
  }
  try {
    const autostartEnabled = await window.tauriAPI.getAutostart();
    if (currentSettings.startOnLogin !== autostartEnabled) {
      await window.tauriAPI.setAutostart(currentSettings.startOnLogin);
    }
  } catch {
    /* autostart may not be available on all platforms */
  }
  if (previousTabsEnabled !== currentSettings.enableTabs) {
    initializeTabs();
  }
  applySettings(currentSettings);
  clearSettingsChanged();
  hideSettingsModal();
  showToast('Settings saved successfully!', 'Settings', 'success');
  const needsRestart =
    previousDisableHwAccel !== currentSettings.disableHardwareAcceleration ||
    previousNativeMenu !== (currentSettings.nativeMenuEnabled ?? true);
  if (needsRestart) {
    showToast(
      'Restart IYERIS to apply hardware acceleration or native menu changes.',
      'Restart Required',
      'info',
      [{ label: 'Restart', onClick: () => void window.tauriAPI.relaunchApp() }]
    );
  }
  if (currentPath) {
    refresh('settings-saved');
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
      window.tauriAPI.resetSettings(),
      window.tauriAPI.resetHomeSettings(),
    ]);
    if (!settingsResult.success || !homeResult.success) {
      isResettingSettings = false;
      const errors: string[] = [];
      if (!settingsResult.success) {
        errors.push(settingsResult.error || 'Failed to reset settings');
      }
      if (!homeResult.success) {
        errors.push(homeResult.error || 'Failed to reset Home settings');
      }
      showToast(`Failed to reset settings: ${errors.join(' | ')}`, 'Error', 'error');
      return;
    }
    await window.tauriAPI.relaunchApp();
  }
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
    fileElementMap.clear();
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
  updateSortIndicators();
}

const bootstrapController = createBootstrapController({
  loadSettings: () => loadSettings(),
  loadHomeSettings: () => homeController.loadHomeSettings(),
  renderSidebarQuickAccess: () => renderSidebarQuickAccess(),
  initTooltipSystem,
  initCommandPalette,
  setupEventListeners: () => {
    try {
      setupEventListeners();
    } catch (err) {
      console.error('[EventListeners] setup failed:', err);
    }
    try {
      setupMoreActionsMenu();
    } catch (err) {
      console.error('[MoreActions] setup failed:', err);
    }
  },
  loadDrives: () => loadDrives(),
  initializeTabs,
  navigateTo: (p) => navigateTo(p),
  setupBreadcrumbListeners,
  setupThemeEditorListeners,
  setupHomeSettingsListeners: () => homeController.setupHomeSettingsListeners(),
  loadBookmarks,
  updateUndoRedoState: () => updateUndoRedoState(),
  handleUpdateDownloaded,
  silentCheckAndDownload,
  refresh: (reason) => refresh(reason),
  applySettings,
  getCurrentSettings: () => currentSettings,
  setCurrentSettings: (s) => {
    currentSettings = s;
  },
  saveSettings: () => {
    void saveSettingsWithTimestamp(currentSettings);
  },
  setPlatformOS: (os) => {
    platformOS = os;
  },
  getIpcCleanupFunctions: () => ipcCleanupFunctions,
  setZoomLevel: (level) => zoomController.setCurrentZoomLevel(level),
  clearDiskSpaceCache: () => diskSpaceController.clearCache(),
  getCurrentPath: () => currentPath,
  updateZoomDisplay,
  getFolderTree: () => folderTree,
  onHomeSettingsChanged: (cb) => window.tauriAPI.onHomeSettingsChanged(cb),
  homeViewPath: HOME_VIEW_PATH,
  goUp,
  showToast: (m, t, ty) => showToast(m, t, ty as 'success' | 'error' | 'info' | 'warning'),
});
const {
  init: bootstrapInit,
  setFolderTreeVisibility,
  setFolderTreeSpacingMode,
} = bootstrapController;

const eventListenersController = createEventListenersController({
  getCurrentSettings: () => currentSettings,
  setCurrentSettings: (settings) => {
    currentSettings = settings;
  },
  getCurrentPath: () => currentPath,
  getViewMode: () => viewMode,
  getTabsEnabled: () => tabsEnabled,
  getTabs: () => tabs,
  getActiveTabId: () => activeTabId,
  getFileGrid: () => fileGrid,
  getSortBtn: () => sortBtn,
  getBackBtn: () => backBtn,
  getForwardBtn: () => forwardBtn,
  getUpBtn: () => upBtn,
  getRefreshBtn: () => refreshBtn,
  getNewFileBtn: () => newFileBtn,
  getNewFolderBtn: () => newFolderBtn,
  getViewToggleBtn: () => viewToggleBtn,
  getAddressInput: () => addressInput,
  getSelectionCopyBtn: () => selectionCopyBtn,
  getSelectionCutBtn: () => selectionCutBtn,
  getSelectionMoveBtn: () => selectionMoveBtn,
  getSelectionRenameBtn: () => selectionRenameBtn,
  getSelectionDeleteBtn: () => selectionDeleteBtn,
  getBookmarkAddBtn: () => bookmarkAddBtn,
  getIpcCleanupFunctions: () => ipcCleanupFunctions,
  goBack,
  goForward,
  goUp,
  goHome: () => navigateTo(HOME_VIEW_PATH),
  refresh,
  navigateTo: (p) => navigateTo(p),
  clearSelection,
  selectAll,
  toggleView,
  renameSelected: () => renameSelected(),
  deleteSelected: (permanent) => deleteSelected(permanent),
  performUndo,
  performRedo,
  saveSettings: () => {
    void saveSettingsWithTimestamp(currentSettings);
  },
  openSelectedItem,
  selectFirstItem,
  selectLastItem,
  navigateByPage,
  navigateFileGrid,
  handleTypeaheadInput: handleTypeaheadInput,
  openSearch,
  closeSearch,
  isSearchModeActive: isSearchModeActive,
  showQuickLook,
  closeQuickLook,
  isQuickLookOpen,
  showSortMenu,
  hideSortMenu: () => hideSortMenu(),
  changeSortMode,
  addBookmark,
  setSidebarCollapsed,
  syncSidebarToggleState,
  showSettingsModal,
  hideSettingsModal,
  showShortcutsModal,
  hideShortcutsModal,
  hideExtractModal,
  hideCompressOptionsModal,
  hideLicensesModal,
  closeHomeSettingsModal: () => homeController.closeHomeSettingsModal(),
  showEmptySpaceContextMenu,
  hideContextMenu,
  hideEmptySpaceContextMenu,
  handleContextMenuAction,
  handleEmptySpaceContextMenuAction,
  handleContextMenuKeyNav: handleContextMenuKeyNav,
  handleSortMenuKeyNav: (e: KeyboardEvent) => handleSortMenuKeyNav(e),
  getContextMenuData,
  openNewWindow,
  showCommandPalette,
  addNewTab: () => addNewTab(),
  closeTab,
  switchToTab,
  showToast: (m, t, ty) => showToast(m, t, ty),
  applySettings,
  getSavedState,
  captureSettingsFormState,
  buildSettingsFormStateFromSettings,
  setSavedState,
  resetRedoState,
  applySettingsFormState,
  updateCustomThemeUI,
  syncShortcutBindingsFromSettings: (s, opts) => syncShortcutBindingsFromSettings(s, opts),
  hideBreadcrumbMenu,
  getBreadcrumbMenuElement,
  isBreadcrumbMenuOpen,
  isShortcutCaptureActive,
  getFixedShortcutActionIdFromEvent,
  getShortcutActionIdFromEvent,
  createNewFile: () => inlineRenameController.createNewFile(),
  createNewFolder: () => inlineRenameController.createNewFolder(),
  copyToClipboard: () => clipboardController.copyToClipboard(),
  cutToClipboard: () => clipboardController.cutToClipboard(),
  pasteFromClipboard: () => clipboardController.pasteFromClipboard(),
  moveSelectedToFolder: () => clipboardController.moveSelectedToFolder(),
  clipboardOnClipboardChanged: (c) => clipboardController.setClipboard(c),
  clipboardUpdateCutVisuals: () => clipboardController.updateCutVisuals(),
  clipboardUpdateIndicator: () => clipboardController.updateClipboardIndicator(),
  zoomIn,
  zoomOut,
  zoomReset,
  toggleHiddenFiles: () => {
    currentSettings.showHiddenFiles = !currentSettings.showHiddenFiles;
    const toggle = document.getElementById('show-hidden-files-toggle') as HTMLInputElement | null;
    if (toggle) toggle.checked = currentSettings.showHiddenFiles;
    void saveSettingsWithTimestamp(currentSettings);
    refresh('toggle-hidden-files');
  },
  showPropertiesForSelected: () => {
    const firstSelected = allFiles.find((f) => selectedItems.has(f.path));
    if (!firstSelected) return;
    void (async () => {
      try {
        const result = await window.tauriAPI.getItemProperties(firstSelected.path);
        if (result.success) {
          showPropertiesDialog(result.properties);
        }
      } catch (e) {
        ignoreError(e);
      }
    })();
  },
  restoreClosedTab: () => restoreClosedTab(),
  togglePreviewPanel: () => previewController.togglePreviewPanel(),
  showContextMenuForSelected: () => {
    const selectedPaths = Array.from(selectedItems);
    if (selectedPaths.length === 0) return;
    const firstPath = selectedPaths[0]!;
    const item = filePathMap.get(firstPath) ?? dualPane.getSecondaryFilePathMap().get(firstPath);
    if (!item) return;
    const el = document.querySelector<HTMLElement>(
      `.file-item[data-path="${CSS.escape(firstPath)}"]`
    );
    if (el) {
      const rect = el.getBoundingClientRect();
      showContextMenu(rect.left + rect.width / 2, rect.top + rect.height / 2, item);
    }
  },
  focusFileGrid: () => {
    ensureActiveItem();
    const scope = getActiveFileGridScope();
    const activeItem = scope?.querySelector<HTMLElement>('.file-item[tabindex="0"]');
    if (activeItem) {
      activeItem.focus();
    } else {
      scope?.focus();
    }
  },
  focusSecondaryPane: () => {
    if (!currentSettings.dualPaneEnabled) return;
    setActivePane('right');
    ensureActiveItem();
    const scope = document.getElementById('dual-pane-secondary-list');
    const activeItem = scope?.querySelector<HTMLElement>('.file-item[tabindex="0"]');
    if (activeItem) {
      activeItem.focus();
    } else {
      scope?.focus();
    }
  },
  ensureActiveItem: () => ensureActiveItem(),
  toggleSelectionAtCursor: () => {
    const isSecondary =
      currentSettings.dualPaneEnabled === true && currentSettings.activePane === 'right';
    const scope = document.getElementById(isSecondary ? 'dual-pane-secondary-list' : 'file-grid');
    if (!scope) return;
    const activeItem = scope.querySelector<HTMLElement>('.file-item[tabindex="0"]');
    if (activeItem) {
      toggleSelection(activeItem);
    }
  },
  navigateFileGridFocusOnly: (key: string) => {
    const scope = getActiveFileGridScope();
    if (!scope) return;
    moveGridFocusWithinScope(scope, key, viewMode);
  },
  initSettingsTabs,
  initSettingsUi,
  initShortcutsModal,
  setupFileGridEventDelegation: () => setupFileGridEventDelegation(),
  setupRubberBandSelection,
  setupListHeader,
  setupViewOptions,
  setupSidebarResize,
  setupSidebarSections,
  setupPreviewResize,
  initPreviewUi: () => initPreviewUi(),
  setupHoverCard,
  initSearchListeners: initSearchListeners,
  initDragAndDropListeners,
  homeViewLabel: HOME_VIEW_LABEL,
  homeViewPath: HOME_VIEW_PATH,
  isMacPlatform: () => platformOS === 'darwin',
});
const { setupEventListeners } = eventListenersController;

function hideFileViewError(): void {
  const el = document.getElementById('fileview-error');
  if (el) el.style.display = 'none';
}

let fileViewErrorWired = false;
let lastFailedNavPath = '';
function showFileViewError(message: string, attemptedPath?: string): void {
  lastFailedNavPath = attemptedPath || currentPath;
  if (!fileViewErrorWired) {
    fileViewErrorWired = true;
    document.getElementById('fileview-error-retry')?.addEventListener('click', () => {
      hideFileViewError();
      void navigateTo(lastFailedNavPath || currentPath, true);
    });
    document.getElementById('fileview-error-terminal')?.addEventListener('click', () => {
      const target = lastFailedNavPath || currentPath;
      if (target) window.tauriAPI.openTerminal(target).catch(ignoreError);
    });
    document.getElementById('fileview-error-fda')?.addEventListener('click', () => {
      window.tauriAPI.requestFullDiskAccess().catch(ignoreError);
    });
  }
  hideLoading();
  if (emptyState) emptyState.style.display = 'none';
  if (listHeader) listHeader.style.display = 'none';
  if (fileGrid) fileGrid.replaceChildren();
  const msgEl = document.getElementById('fileview-error-message');
  if (msgEl) msgEl.textContent = message || 'This folder could not be opened.';
  const fdaBtn = document.getElementById('fileview-error-fda');
  if (fdaBtn) {
    fdaBtn.style.display =
      platformOS === 'darwin' && isPermissionDeniedError(message) ? 'inline-flex' : 'none';
  }
  const el = document.getElementById('fileview-error');
  if (el) el.style.display = 'flex';
}

function detectNavigationDirection(oldPath: string, newPath: string, trigger: string): boolean {
  if (trigger === 'back') return false;
  if (trigger === 'forward') return true;
  if (trigger === 'up') return false;

  if (isHomeViewPath(newPath)) return false;
  if (isHomeViewPath(oldPath)) return true;

  const cleanOld = oldPath.replace(/\\/g, '/').replace(/\/$/, '');
  const cleanNew = newPath.replace(/\\/g, '/').replace(/\/$/, '');

  if (cleanNew.startsWith(cleanOld + '/')) {
    return true;
  }
  if (cleanOld.startsWith(cleanNew + '/')) {
    return false;
  }

  const oldSegments = cleanOld.split('/').filter(Boolean);
  const newSegments = cleanNew.split('/').filter(Boolean);
  if (newSegments.length !== oldSegments.length) {
    return newSegments.length > oldSegments.length;
  }

  return true;
}

async function navigateTo(path: string, skipHistoryUpdate = false, trigger = 'direct') {
  if (!path) {
    devLog('Navigate', 'Ignored empty navigation request', { trigger });
    return;
  }
  const navigationId = ++navigationSequence;
  const navigationStartAt = Date.now();
  devLog('Navigate', `[${navigationId}] start`, {
    path,
    skipHistoryUpdate,
    trigger,
    wasNavigating: isNavigating,
  });
  isNavigating = true;
  const trimmedPath = path.trim();
  if (trimmedPath === HOME_VIEW_LABEL) {
    path = HOME_VIEW_PATH;
  }

  if (isHomeViewPath(path)) {
    try {
      resetTypeahead();

      if (isSearchModeActive()) {
        closeSearch({ restoreCurrentPath: false });
      }

      thumbnails.disconnectThumbnailObserver();
      thumbnails.clearPendingThumbnailLoads();

      hideLoading();

      const isForward = detectNavigationDirection(currentPath, path, trigger);
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

      if (homeView && trigger !== 'tab') {
        homeView.classList.remove('nav-forward', 'nav-back');
        void homeView.offsetWidth; // Force reflow
        homeView.classList.add(isForward ? 'nav-forward' : 'nav-back');
      }
      announceToScreenReader('Home view');
      devLog('Navigate', `[${navigationId}] completed`, {
        source: 'home',
        path: HOME_VIEW_PATH,
        trigger,
        durationMs: Date.now() - navigationStartAt,
      });
    } finally {
      isNavigating = false;
    }
    return;
  }

  setHomeViewActive(false);
  let requestId = 0;

  try {
    resetTypeahead();

    if (isSearchModeActive()) {
      closeSearch({ restoreCurrentPath: false });
    }

    thumbnails.disconnectThumbnailObserver();
    thumbnails.clearPendingThumbnailLoads();

    showLoading('Loading folder...');
    hideFileViewError();
    if (fileGrid) {
      if (viewMode === 'grid' || viewMode === 'list') {
        renderSkeleton(fileGrid, viewMode);
      } else {
        fileGrid.replaceChildren();
      }
    }
    const request = startDirectoryRequest(path);
    requestId = request.requestId;
    devLog('Navigate', `[${navigationId}] directory request`, {
      path,
      requestId,
      operationId: request.operationId,
      showHidden: currentSettings.showHiddenFiles,
    });

    const result = await window.tauriAPI.getDirectoryContents(
      path,
      request.operationId,
      currentSettings.showHiddenFiles,
      false
    );
    if (!directoryLoader.isCurrentRequest(requestId)) {
      devLog('Navigate', `[${navigationId}] stale directory result ignored`, {
        path,
        requestId,
      });
      return;
    }

    if (!result.success) {
      devLog('Navigate', `[${navigationId}] directory request failed`, {
        path,
        requestId,
        error: result.error || 'Unknown error',
      });
      devLog('Navigate', 'Error loading directory', result.error);
      showFileViewError(result.error || 'This folder could not be opened.', path);
      return;
    }

    const isForward = detectNavigationDirection(currentPath, path, trigger);
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
    if (currentSettings.dualPaneEnabled === true && !dualPane.getSecondaryPanePath()) {
      void loadSecondaryPane(path);
    }

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
      invalidateFileItemsCache();
    }

    if (fileView && trigger !== 'tab') {
      fileView.classList.remove('nav-forward', 'nav-back');
      void fileView.offsetWidth; // Force reflow
      fileView.classList.add(isForward ? 'nav-forward' : 'nav-back');
    }

    // Trigger paste-in and rename-flash micro-animations
    if (recentlyPastedPaths.size > 0) {
      recentlyPastedPaths.forEach((p) => {
        const itemEl = document.querySelector<HTMLElement>(`[data-path="${CSS.escape(p)}"]`);
        if (itemEl) {
          itemEl.classList.add('animate-paste-in');
          setTimeout(() => {
            itemEl.classList.remove('animate-paste-in');
          }, 400);
        }
      });
      recentlyPastedPaths.clear();
    }

    if (recentlyRenamedPath) {
      const itemEl = document.querySelector<HTMLElement>(
        `[data-path="${CSS.escape(recentlyRenamedPath)}"]`
      );
      if (itemEl) {
        itemEl.classList.add('animate-rename-flash');
        setTimeout(() => {
          itemEl.classList.remove('animate-rename-flash');
        }, 600);
      }
      recentlyRenamedPath = null;
    }
    devLog('Navigate', `[${navigationId}] render complete`, {
      path,
      requestId,
      itemCount: result.contents?.length ?? 0,
      viewMode,
    });

    window.tauriAPI
      .watchDirectory(path)
      .then((watching) => {
        devLog('Watcher', `[${navigationId}] watchDirectory result`, { path, watching });
      })
      .catch((error) => {
        devLog('Watcher', `[${navigationId}] watchDirectory failed`, {
          path,
          error: getErrorMessage(error),
        });
      });
    if (isForeground()) {
      updateDiskSpace();
      if (currentSettings.enableGitStatus) {
        fetchGitStatusAsync(path);
        updateGitBranch(path);
      }
    }
    devLog('Navigate', `[${navigationId}] success`, {
      path,
      trigger,
      durationMs: Date.now() - navigationStartAt,
    });
  } catch (error) {
    devLog('Navigate', `[${navigationId}] exception`, {
      path,
      trigger,
      error: getErrorMessage(error),
      durationMs: Date.now() - navigationStartAt,
    });
    devLog('Navigate', 'Error navigating', error);
    showFileViewError(getErrorMessage(error), path);
  } finally {
    const isCurrentRequest = directoryLoader.isCurrentRequest(requestId);
    finishDirectoryRequest(requestId);
    if (isCurrentRequest) {
      if (fileGrid) clearSkeleton(fileGrid);
      hideLoading();
      isNavigating = false;
      if (pendingRefreshReason) {
        const deferredReason = pendingRefreshReason;
        pendingRefreshReason = null;
        refresh(deferredReason);
      }
      devLog('Navigate', `[${navigationId}] finalized`, {
        path,
        requestId,
        trigger,
        durationMs: Date.now() - navigationStartAt,
      });
    } else {
      devLog('Navigate', `[${navigationId}] finalize skipped for stale request`, {
        path,
        requestId,
      });
    }
  }
}

const fileRenderController = createFileRenderController({
  getFileGrid: () => fileGrid,
  getEmptyState: () => emptyState,
  isSelected: (p) => selectedItems.has(p),
  getCurrentSettings: () => currentSettings,
  getFileElementMap: () => fileElementMap,
  showToast: (m, t, ty) => showToast(m, t, ty),
  clearSelection: () => clearSelection(),
  updateStatusBar,
  markSelectionDirty,
  setHiddenFilesCount: (count) => {
    hiddenFilesCount = count;
  },
  getHiddenFilesCount: () => hiddenFilesCount,
  setAllFiles: (files) => {
    allFiles = files;
  },
  setDisableEntryAnimation: () => {},
  setDisableThumbnailRendering: () => {},
  ensureActiveItem: () => ensureActiveItem(),
  applyGitIndicatorsToPaths: (paths) => applyGitIndicatorsToPaths(paths),
  updateCutVisuals: () => clipboardController.updateCutVisuals(),
  clearCutPaths: () => clipboardController.clearCutPaths(),
  clearGitCache: () => gitStatus.clearCache(),
  observeThumbnailItem: (el) => thumbnails.observeThumbnailItem(el),
  resetThumbnailObserver: () => thumbnails.resetThumbnailObserver(),
  getFolderIcon: (p) => folderIconPickerController.getFolderIcon(p),
  nameCollator: NAME_COLLATOR,
  dateFormatter: DATE_FORMATTER,
});
const { renderFiles, resetVirtualizedRender } = fileRenderController;
const filePathMap = fileRenderController.getFilePathMap();
const getFileItemData = fileRenderController.getFileItemData;
utilityDrawerController = createUtilityDrawerController({
  getCurrentSettings: () => currentSettings,
  saveSettingsWithTimestamp: (settings) => saveSettingsWithTimestamp(settings),
  showToast: (m, t, ty) => showToast(m, t, ty as 'success' | 'error' | 'info' | 'warning'),
  getCurrentPath: () => currentPath,
  navigateTo: (p) => navigateTo(p),
});

const fileGridEventsController = createFileGridEventsController({
  getFileGrid: () => fileGrid,
  getFileItemData: (el) => getFileItemData(el),
  getSelectedItems: () => selectedItems,
  getTabsEnabled: () => tabsEnabled,
  clearSelection: () => clearSelection(),
  toggleSelection: (el) => toggleSelection(el),
  showContextMenu: (x, y, item) => showContextMenu(x, y, item),
  openFileEntry: (item) => openFileEntry(item),
  addNewTab: (path) => addNewTab(path),
  navigateTo: (p) => navigateTo(p),
  consumeEvent,
  getDragOperation,
  getDraggedPaths,
  showDropIndicator,
  hideDropIndicator,
  scheduleSpringLoad,
  clearSpringLoad,
  handleDrop,
  setDragData: (paths) => window.tauriAPI.setDragData(paths),
  clearDragData: () => window.tauriAPI.clearDragData(),
});
const { setupFileGridEventDelegation } = fileGridEventsController;

async function renameSelected() {
  if (selectedItems.size !== 1) return;
  const itemPath = Array.from(selectedItems)[0]!;
  const fileItem =
    fileElementMap.get(itemPath) ?? dualPane.getSecondaryFileElementMap().get(itemPath);
  if (fileItem) {
    const item = filePathMap.get(itemPath) ?? dualPane.getSecondaryFilePathMap().get(itemPath);
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
      `${twemojiImg('alert-triangle', 'twemoji')} PERMANENTLY delete ${count} item${plural}? This CANNOT be undone!`,
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

  const operationId = generateOperationId();
  addOperation(operationId, 'delete', `${count} item${plural}${permanent ? ' permanently' : ''}`, {
    cancellable: false,
    total: itemsSnapshot.length,
    retry: () => void deleteSelected(permanent),
  });
  const DELETE_BATCH_SIZE = 20;
  const allResults: PromiseSettledResult<{ success: boolean; error?: string }>[] = [];
  const processedPaths: string[] = [];
  for (let i = 0; i < itemsSnapshot.length; i += DELETE_BATCH_SIZE) {
    if (isOperationCancelling(operationId)) break;
    const batch = itemsSnapshot.slice(i, i + DELETE_BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map((p) => (permanent ? window.tauriAPI.deleteItem(p) : window.tauriAPI.trashItem(p)))
    );
    allResults.push(...batchResults);
    processedPaths.push(...batch);
    updateOperation(operationId, {
      current: allResults.length,
      total: itemsSnapshot.length,
      currentFile: batch[batch.length - 1] || 'Deleting...',
      status: 'active',
    });
  }
  const successCount = allResults.filter((r) => r.status === 'fulfilled' && r.value.success).length;
  const failCount = allResults.length - successCount;
  const cancelled = isOperationCancelling(operationId);

  const permissionFailedPaths: string[] = [];
  for (let i = 0; i < allResults.length; i++) {
    const r = allResults[i]!;
    if (r.status === 'fulfilled' && !r.value.success && isPermissionDeniedError(r.value.error)) {
      permissionFailedPaths.push(processedPaths[i]!);
    }
  }

  if (!cancelled && permissionFailedPaths.length > 0) {
    const needsPermanentFallback = !permanent;
    const confirmed = await showConfirm(
      needsPermanentFallback
        ? `${permissionFailedPaths.length} item${permissionFailedPaths.length > 1 ? 's' : ''} could not be moved to Trash due to permissions. Permanently delete ${permissionFailedPaths.length > 1 ? 'them' : 'it'} instead? This cannot be undone.`
        : `${permissionFailedPaths.length} item${permissionFailedPaths.length > 1 ? 's' : ''} require administrator privileges to delete. You will be prompted to authorize.`,
      needsPermanentFallback ? 'Permanent Delete Required' : 'Elevated Permissions Required',
      needsPermanentFallback ? 'error' : 'warning'
    );
    if (confirmed) {
      updateOperation(operationId, {
        currentFile: 'Waiting for elevated permissions...',
        status: 'active',
      });
      const elevResult = await window.tauriAPI.elevatedDeleteBatch(permissionFailedPaths);
      if (elevResult.success) {
        const totalSuccess = successCount + permissionFailedPaths.length;
        const unresolvedFailures = Math.max(0, failCount - permissionFailedPaths.length);
        const effectivePermanent = permanent || needsPermanentFallback;
        const msg = effectivePermanent
          ? `${totalSuccess} item${totalSuccess > 1 ? 's' : ''} permanently deleted`
          : `${totalSuccess} item${totalSuccess > 1 ? 's' : ''} deleted`;
        showToast(msg, 'Success', 'success');
        if (unresolvedFailures > 0) {
          showToast(
            `${unresolvedFailures} item${unresolvedFailures > 1 ? 's' : ''} could not be deleted`,
            'Partial Failure',
            'error'
          );
        }
        if (unresolvedFailures > 0) {
          completeOperation(
            operationId,
            'failed',
            `${unresolvedFailures} item(s) could not be deleted`
          );
        } else {
          completeOperation(operationId, 'done');
        }
        refreshAfterDeleteAnimation(
          permissionFailedPaths,
          effectivePermanent ? 'delete-selected-permanent' : 'delete-selected'
        );
        return;
      }
      completeOperation(operationId, 'failed', elevResult.error || 'Elevated delete failed');
      showToast(elevResult.error || 'Elevated delete failed', 'Error', 'error');
      refresh(
        permanent || needsPermanentFallback
          ? 'delete-selected-permanent-failed'
          : 'delete-selected-failed'
      );
      return;
    }
  }

  if (successCount > 0) {
    const msg = permanent
      ? `${successCount} item${successCount > 1 ? 's' : ''} permanently deleted`
      : `${successCount} item${successCount > 1 ? 's' : ''} moved to ${platformOS === 'win32' ? 'Recycle Bin' : 'Trash'}`;
    if (!permanent) {
      await updateUndoRedoState();
      showToast(
        msg,
        'Success',
        'success',
        canUndo
          ? [
              {
                label: 'Undo',
                onClick: () => {
                  void performUndo();
                },
              },
            ]
          : undefined
      );
    } else {
      showToast(msg, 'Success', 'success');
    }
    const successfulPaths = processedPaths.filter((_path, index) => {
      const result = allResults[index];
      return result?.status === 'fulfilled' && result.value.success;
    });
    refreshAfterDeleteAnimation(
      successfulPaths,
      permanent ? 'delete-selected-permanent' : 'delete-selected'
    );
  }
  if (cancelled) {
    completeOperation(
      operationId,
      'failed',
      `Cancelled after ${successCount} item${successCount === 1 ? '' : 's'}`
    );
  } else if (failCount > 0) {
    completeOperation(
      operationId,
      'failed',
      `${failCount} item${failCount > 1 ? 's' : ''} could not be deleted`
    );
    showToast(
      `${failCount} item${failCount > 1 ? 's' : ''} could not be deleted`,
      'Partial Failure',
      'error'
    );
  } else {
    completeOperation(operationId, 'done');
  }
}

function refreshAfterDeleteAnimation(paths: string[], reason: string): void {
  const duration =
    typeof currentSettings.operationAnimationDuration === 'number'
      ? currentSettings.operationAnimationDuration
      : 100;
  const shouldAnimate =
    duration > 0 &&
    !document.body.classList.contains('reduce-motion') &&
    !document.body.classList.contains('performance-mode');
  if (!shouldAnimate || paths.length === 0) {
    refresh(reason);
    return;
  }

  paths.forEach((p) => {
    const itemEl = fileGrid?.querySelector<HTMLElement>(`[data-path="${CSS.escape(p)}"]`);
    itemEl?.classList.add('animate-delete-out');
  });
  window.setTimeout(() => refresh(reason), Math.min(duration, 200));
}

async function updateUndoRedoState() {
  const state = await window.tauriAPI.getUndoRedoState();
  if (!state.success) return;
  canUndo = state.canUndo;
  canRedo = state.canRedo;

  const moreUndoBtn = document.getElementById('more-undo-btn') as HTMLButtonElement | null;
  const moreRedoBtn = document.getElementById('more-redo-btn') as HTMLButtonElement | null;
  if (moreUndoBtn) moreUndoBtn.disabled = !canUndo;
  if (moreRedoBtn) moreRedoBtn.disabled = !canRedo;
}

function setupMoreActionsMenu() {
  const btn = document.getElementById('more-actions-btn');
  const menu = document.getElementById('more-actions-menu');
  if (!btn || !menu) return;

  const menuEl = menu;
  const btnEl = btn;

  function closeMenu() {
    menuEl.style.display = 'none';
    btnEl.setAttribute('aria-expanded', 'false');
    menuEl.querySelectorAll('.focused').forEach((el) => el.classList.remove('focused'));
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menu.style.display === 'block';
    if (isOpen) {
      closeMenu();
    } else {
      hideSortMenu();
      hideContextMenu();
      hideEmptySpaceContextMenu();

      menu.style.display = 'block';

      const rect = btn.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      let left = rect.left;
      let top = rect.bottom + 5;

      if (left + menuRect.width > window.innerWidth) {
        left = window.innerWidth - menuRect.width - 10;
      }
      if (top + menuRect.height > window.innerHeight) {
        top = rect.top - menuRect.height - 5;
      }
      if (left < 10) left = 10;
      if (top < 10) top = 10;

      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
      btn.setAttribute('aria-expanded', 'true');

      void updateUndoRedoState();

      const items = Array.from(menu.querySelectorAll<HTMLElement>('.context-menu-item'));
      const firstEnabled = items.find((el) => !(el as HTMLButtonElement).disabled);
      if (firstEnabled) {
        firstEnabled.classList.add('focused');
        firstEnabled.tabIndex = 0;
        firstEnabled.focus({ preventScroll: true });
      }
    }
  });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (menu.style.display !== 'block') return;
    if (!btn.contains(e.target as Node) && !menu.contains(e.target as Node)) {
      closeMenu();
    }
  });

  // Menu item actions
  menu.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.context-menu-item') as HTMLElement | null;
    if (!item) return;
    e.stopPropagation();
    closeMenu();
    if (item.id === 'more-undo-btn') void performUndo();
    else if (item.id === 'more-redo-btn') void performRedo();
  });

  // Keyboard navigation
  menu.addEventListener('keydown', (e) => {
    const items = Array.from(menu.querySelectorAll<HTMLElement>('.context-menu-item'));
    const focusedIndex = items.findIndex((el) => el.classList.contains('focused'));

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const enabledItems = items.filter((el) => !el.hasAttribute('disabled'));
      if (enabledItems.length === 0) return;
      const enabledFocusedIndex = enabledItems.findIndex((el) => el.classList.contains('focused'));
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const next = (enabledFocusedIndex + dir + enabledItems.length) % enabledItems.length;
      items.forEach((el) => {
        el.classList.remove('focused');
        el.tabIndex = -1;
      });
      enabledItems[next]!.classList.add('focused');
      enabledItems[next]!.tabIndex = 0;
      enabledItems[next]!.focus({ preventScroll: true });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (focusedIndex >= 0) items[focusedIndex]!.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      btn.focus();
    }
  });
}

async function performUndoRedo(isUndo: boolean) {
  const result = isUndo ? await window.tauriAPI.undoAction() : await window.tauriAPI.redoAction();
  const label = isUndo ? 'Undo' : 'Redo';
  if (!result.success) {
    showToast(result.error || `Cannot ${label.toLowerCase()}`, `${label} Failed`, 'warning');
    await updateUndoRedoState();
    return;
  }
  await updateUndoRedoState();
  const reverseAction = isUndo
    ? canRedo
      ? [
          {
            label: 'Redo',
            onClick: () => {
              void performRedo();
            },
          },
        ]
      : undefined
    : canUndo
      ? [
          {
            label: 'Undo',
            onClick: () => {
              void performUndo();
            },
          },
        ]
      : undefined;
  showToast(`Action ${isUndo ? 'undone' : 'redone'}`, label, 'success', reverseAction);
  refresh(isUndo ? 'undo' : 'redo');
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
  void navigateTo(history[historyIndex]!, true, delta === -1 ? 'back' : 'forward');
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
  navigateTo(parentPath, false, 'up');
}

function refresh(reason = 'unspecified') {
  if (!currentPath) {
    devLog('Refresh', 'Skipped refresh (no current path)', { reason });
    return;
  }

  if (!isForeground()) {
    markDirtyRefresh(reason);
    devLog('Refresh', 'Deferred refresh (window backgrounded)', { reason, currentPath });
    return;
  }
  if (isNavigating) {
    pendingRefreshReason = reason;
    devLog('Refresh', 'Skipped refresh (navigation already in progress)', {
      reason,
      currentPath,
    });
    return;
  }
  if (document.body.classList.contains('pending-created-item-rename')) {
    devLog('Refresh', 'Skipped refresh (created item rename pending)', { reason, currentPath });
    return;
  }
  if (document.querySelector('.file-item.renaming')) {
    devLog('Refresh', 'Skipped refresh (inline rename active)', { reason, currentPath });
    return;
  }
  if (isSearchModeActive()) {
    devLog('Refresh', 'Skipped refresh (search is active)', { reason, currentPath });
    return;
  }
  if (refreshDebounceTimer) {
    devLog('Refresh', 'Resetting pending refresh debounce', { reason, currentPath });
    clearTimeout(refreshDebounceTimer);
  } else {
    devLog('Refresh', 'Scheduling refresh', { reason, currentPath });
  }
  refreshDebounceTimer = setTimeout(() => {
    refreshDebounceTimer = null;
    if (document.body.classList.contains('pending-created-item-rename')) {
      devLog('Refresh', 'Skipped debounced refresh (created item rename pending)', {
        reason,
        currentPath,
      });
      return;
    }
    if (document.querySelector('.file-item.renaming')) {
      devLog('Refresh', 'Skipped debounced refresh (inline rename active)', {
        reason,
        currentPath,
      });
      return;
    }
    if (!isNavigating && !isSearchModeActive() && currentPath) {
      devLog('Refresh', 'Executing debounced refresh', { reason, currentPath });
      const savedSelection = new Set(selectedItems);
      navigateTo(currentPath, false, `refresh:${reason}`)
        .then(() => {
          const valid = new Set<string>();
          for (const itemPath of savedSelection) {
            if (filePathMap.has(itemPath)) valid.add(itemPath);
          }
          if (valid.size === 0) return;
          setSelectedItemsState(valid);
          if (currentSettings.dualPaneEnabled) {
            dualPane.syncPaneSelectionVisuals();
          } else {
            for (const itemPath of valid) {
              const el = fileElementMap.get(itemPath);
              if (el) {
                el.classList.add('selected');
                el.setAttribute('aria-selected', 'true');
              }
            }
          }
          updateStatusBar();
        })
        .catch(ignoreError);
    } else {
      devLog('Refresh', 'Skipped debounced refresh execution', {
        reason,
        currentPath,
        isNavigating,
        isSearchActive: isSearchModeActive(),
      });
    }
  }, 200);
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
  void saveSettingsWithTimestamp(currentSettings)
    .then((result) => {
      if (!result.success) {
        notifySettingsSaveError(result.error);
      }
    })
    .catch(ignoreError);
}

late.navigateTo = navigateTo;
late.refresh = refresh;
late.renderFiles = renderFiles;
late.updateStatusBar = updateStatusBar;
late.updateUndoRedoState = updateUndoRedoState;
late.deleteSelected = deleteSelected;
late.renameSelected = renameSelected;
late.handleQuickAction = handleQuickAction;
late.addToRecentFiles = addToRecentFiles;
late.saveSettings = saveSettings;
late.applySettings = applySettings;
late.updateDangerousOptionsVisibility = updateDangerousOptionsVisibility;
late.setViewMode = setViewMode;
late.setHomeViewActive = setHomeViewActive;
late.updateNavigationButtons = updateNavigationButtons;
late.registerRecentlyPastedPaths = (paths) => {
  recentlyPastedPaths = new Set(paths);
};
late.setRecentlyRenamedPath = (p) => {
  recentlyRenamedPath = p;
};
late.getFileByPath = (p) => filePathMap.get(p) ?? dualPane.getSecondaryFilePathMap().get(p);
late.getFileItemData = (el) =>
  getFileItemData(el) ?? dualPane.getSecondaryFilePathMap().get(el.dataset.path || '') ?? null;

async function toggleView() {
  const viewModeCycle: ViewMode[] = ['grid', 'list', 'column'];
  const nextIndex = (viewModeCycle.indexOf(viewMode) + 1) % viewModeCycle.length;
  await setViewMode(viewModeCycle[nextIndex]!);
}

async function applyViewMode() {
  invalidateGridColumnsCache();
  invalidateFileItemsCache();
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
      try {
        const request = startDirectoryRequest(currentPath);
        requestId = request.requestId;
        const result = await window.tauriAPI.getDirectoryContents(
          currentPath,
          request.operationId,
          currentSettings.showHiddenFiles
        );
        if (!directoryLoader.isCurrentRequest(requestId)) return;
        if (result.success) {
          renderFiles(result.contents || []);
          invalidateFileItemsCache();
        }
      } catch {
        // ignore; finishDirectoryRequest handles cleanup
      } finally {
        const wasCurrentRequest = directoryLoader.isCurrentRequest(requestId);
        finishDirectoryRequest(requestId);
        if (wasCurrentRequest) {
          hideLoading();
          isNavigating = false;
        }
      }
    }
  }

  updateViewModeControls();
}

const VIEW_TOGGLE_CONFIG: Record<ViewMode, { svg: string; title: string }> = {
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
  updateSortIndicators();
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
  const result = await window.tauriAPI.selectFolder();
  if (result.success) {
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
const extractPasswordInput = document.getElementById('extract-password') as HTMLInputElement | null;
const extractPasswordToggle = document.getElementById('extract-password-toggle');
extractPasswordToggle?.addEventListener('click', () => {
  if (!extractPasswordInput) return;
  const show = extractPasswordInput.type === 'password';
  extractPasswordInput.type = show ? 'text' : 'password';
  if (extractPasswordToggle instanceof HTMLButtonElement) {
    extractPasswordToggle.title = show ? 'Hide password' : 'Show password';
  }
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

dualPane.setupListeners();

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

  const historyItem = target.closest<HTMLElement>('.history-item');
  if (historyItem) {
    if (historyItem.dataset.query) {
      e.preventDefault();
      setSearchQuery(historyItem.dataset.query);
      setTimeout(() => focusSearchInput(), 0);
      hideSearchHistoryDropdown();
      performSearch();
      return;
    }
    if (historyItem.dataset.path) {
      e.preventDefault();
      navigateTo(historyItem.dataset.path);
      hideDirectoryHistoryDropdown();
      return;
    }
  }

  const historyClear = target.closest<HTMLElement>('.history-clear');
  if (historyClear) {
    let clearAction: (() => void) | null = null;
    if (historyClear.dataset.action === 'clear-search') {
      clearAction = clearSearchHistory;
    } else if (historyClear.dataset.action === 'clear-directory') {
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
    await bootstrapInit();
    if (utilityDrawerController) {
      utilityDrawerController.init();
    }
  } catch (error) {
    devLog('Init', 'Failed to initialize IYERIS', error);
    const message = 'Failed to start IYERIS: ' + getErrorMessage(error);
    const dialogModal = document.getElementById('dialog-modal');
    const dialogMessage = document.getElementById('dialog-message');
    const dialogTitle = document.getElementById('dialog-title');
    if (dialogModal && dialogMessage) {
      if (dialogTitle) dialogTitle.textContent = 'Startup Error';
      dialogMessage.textContent = message;
      dialogModal.style.display = 'flex';
    } else {
      const alert = document.createElement('div');
      alert.setAttribute('role', 'alert');
      alert.style.padding = '24px';
      alert.style.fontFamily = 'system-ui';
      alert.textContent = message;
      document.body.replaceChildren(alert);
    }
  }
})();

window.addEventListener('beforeunload', () => {
  flushDebouncedSettingsSave();
  stopIndexStatusPolling();
  cleanupSearch();
  cleanupHoverCard();
  cleanupPropertiesDialog();
  thumbnails.resetThumbnailObserver();
  fileRenderController.disconnectVirtualizedObserver();
  diskSpaceController.clearCache();
  zoomController.clearZoomPopupTimeout();
  window.tauriAPI.unwatchDirectory().catch(ignoreError);
  if (!isResettingSettings) {
    if (isMainWindow && tabsEnabled && tabs.length > 0) {
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
    void window.tauriAPI.saveSettingsSync(currentSettings);
  }
  if (settingsSaveTimeout) {
    clearTimeout(settingsSaveTimeout);
    settingsSaveTimeout = null;
  }
  cleanupTabs();
  cleanupOperationQueue();

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
      devLog('Cleanup', 'Error cleaning up IPC listener', e);
    }
  }
  ipcCleanupFunctions.length = 0;
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushDebouncedSettingsSave();
  }
});

window.addEventListener('pagehide', () => {
  flushDebouncedSettingsSave();
});
