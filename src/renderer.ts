import type { Settings, FileItem, DriveInfo } from './types';
import { assignKey, escapeHtml, getErrorMessage, ignoreError } from './shared.js';
import { clearHtml, getById } from './rendererDom.js';
import type { TabData } from './rendererTabs.js';
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
import type { ShortcutBinding } from './shortcuts.js';
import {
  createHomeController,
  getPathDisplayValue,
  HOME_VIEW_LABEL,
  HOME_VIEW_PATH,
  HOME_QUICK_ACCESS_ITEMS,
  isHomeViewPath,
} from './home.js';
import type { TourController } from './tour.js';
import {
  getFileExtension,
  getFileTypeFromName,
  formatFileSize,
  getFileIcon,
} from './rendererFileIcons.js';
import { createFileRenderController } from './rendererFileRender.js';
import { createFileGridEventsController } from './rendererFileGridEvents.js';
import { createEventListenersController } from './rendererEventListeners.js';
import { createBootstrapController } from './rendererBootstrap.js';
import { applyAppearance } from './rendererAppearance.js';
import {
  SEARCH_DEBOUNCE_MS,
  SETTINGS_SAVE_DEBOUNCE_MS,
  TOAST_DURATION_MS,
  SEARCH_HISTORY_MAX,
  DIRECTORY_HISTORY_MAX,
  DIRECTORY_PROGRESS_THROTTLE_MS,
  SUPPORT_POPUP_DELAY_MS,
  MAX_RECENT_FILES,
  MAX_CACHED_TABS,
  MAX_CACHED_FILES_PER_TAB,
  NAME_COLLATOR,
  DATE_FORMATTER,
  SPECIAL_DIRECTORY_ACTIONS,
  consumeEvent,
  type ViewMode,
} from './rendererLocalConstants.js';
import {
  TOGGLE_MAPPINGS,
  SELECT_MAPPINGS,
  INT_RANGE_MAPPINGS,
} from './rendererSettingsMappings.js';
import { wireControllers, type LateBound } from './rendererControllerWiring.js';
import { isOneOf } from './constants.js';

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

async function saveSettingsWithTimestamp(settings: Settings) {
  if (isResettingSettings) {
    return { success: true as const };
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

const ipcCleanupFunctions: (() => void)[] = [];

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
  announceToScreenReader,
} from './rendererElements.js';

let currentSettings: Settings = createDefaultSettings();
let isResettingSettings = false;

const late = {} as LateBound;

const wired = wireControllers({
  getCurrentPath: () => currentPath,
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
  late,
});

const {
  cleanupArchiveOperations,
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
  updateIndexStatus,
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
  cancelActiveSearch,
  showSearchHistoryDropdown,
  hideSearchHistoryDropdown,
  clearSearchHistory,
  getSearchStatusText,
  isSearchModeActive,
  getSearchInputElement,
  setSearchQuery,
  focusSearchInput,
  previewController,
  initPreviewUi,
  updatePreview,
  showQuickLook,
  showQuickLookForFile,
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
  isRubberBandActive,
  ensureActiveItem,
  invalidateGridColumnsCache,
  thumbnails,
  setHoverCardEnabled,
  setupHoverCard,
  cleanupHoverCard,
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
  initCommandPalette,
  showCommandPalette,
  hideCommandPalette,
  syncCommandShortcuts,
  renderShortcutsModal,
  initShortcutsModal,
  stopShortcutCapture,
  isShortcutCaptureActive,
  showShortcutsModal,
  hideShortcutsModal,
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
  applyCustomThemeColors,
  clearCustomThemeColors,
  setupThemeEditorListeners,
  updateCustomThemeUI,
  showSettingsModal,
  hideSettingsModal,
  initSettingsActions,
  showLicensesModal,
  hideLicensesModal,
  initLicensesUi,
  showSupportPopup,
  initSupportPopup,
  initExternalLinks,
  showPropertiesDialog,
  cleanupPropertiesDialog,
  restartAsAdmin,
  checkForUpdates,
  handleUpdateDownloaded,
  generateOperationId,
  addOperation,
  getOperation,
  updateOperation,
  removeOperation,
} = wired;
const showToast = toastManager.showToast;

async function loadSettings(): Promise<void> {
  const [result, sharedClipboard] = await Promise.all([
    window.electronAPI.getSettings(),
    window.electronAPI.getClipboard(),
  ]);

  if (result.success) {
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
  } else {
    currentSettings = createDefaultSettings();
    applySettings(currentSettings);
  }

  if (sharedClipboard) {
    clipboardController.setClipboard(sharedClipboard);
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
  applyAppearance(settings, {
    applyCustomThemeColors,
    clearCustomThemeColors,
  });

  if (settings.viewMode) {
    viewMode = settings.viewMode;
    applyViewMode();
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
      if (val >= min && val <= max)
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
  if (!result.success) {
    showToast('Failed to save settings: ' + (result.error || 'Operation failed'), 'Error', 'error');
    return;
  }
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
    await window.electronAPI.relaunchApp();
  }
}

function renderSidebarQuickAccess() {
  const grid = document.getElementById('sidebar-quick-access-grid');
  if (!grid) return;

  grid.innerHTML = '';

  const homeDiv = document.createElement('div');
  homeDiv.className = 'nav-item quick-action';
  homeDiv.dataset.action = 'home';
  homeDiv.setAttribute('role', 'button');
  homeDiv.tabIndex = 0;
  homeDiv.setAttribute('aria-label', 'Navigate to Home');
  homeDiv.innerHTML = `
    <span class="nav-icon" aria-hidden="true">${twemojiImg(String.fromCodePoint(0x1f3e0), 'twemoji')}</span>
    <span class="nav-label">Home</span>
  `;
  homeDiv.addEventListener('click', () => handleQuickAction('home'));
  homeDiv.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleQuickAction('home');
    }
  });
  grid.appendChild(homeDiv);

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
    if (!result.success) {
      showToast(
        result.error || `Failed to open ${specialAction.label} folder`,
        'Quick Access',
        'error'
      );
      return;
    }
    navigateTo(result.path);
    return;
  }

  if (action === 'browse') {
    const result = await window.electronAPI.selectFolder();
    if (result.success) {
      navigateTo(result.path);
    }
    return;
  }

  if (action === 'trash') {
    const result = await window.electronAPI.openTrash();
    if (!result.success) {
      showToast(result.error || 'Failed to open trash folder', 'Error', 'error');
      return;
    }
    showToast('Opening system trash folder', 'Info', 'info');
  }
}

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
      announceToScreenReader(
        `Search results: ${allFiles.length} item${allFiles.length !== 1 ? 's' : ''} found`
      );
    } else {
      statusSearch.style.display = 'none';
      const folderName = currentPath ? currentPath.split(/[\\/]/).pop() || currentPath : '';
      const prefix = folderName ? `${folderName}: ` : '';
      announceToScreenReader(`${prefix}${allFiles.length} item${allFiles.length !== 1 ? 's' : ''}`);
    }
  }
}

const bootstrapController = createBootstrapController({
  loadSettings: () => loadSettings(),
  loadHomeSettings: () => homeController.loadHomeSettings(),
  renderSidebarQuickAccess: () => renderSidebarQuickAccess(),
  initTooltipSystem,
  initCommandPalette,
  setupEventListeners: () => {
    setupEventListeners();
    setupMoreActionsMenu();
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
  refresh: () => refresh(),
  applySettings,
  getCurrentSettings: () => currentSettings,
  setCurrentSettings: (s) => {
    currentSettings = s;
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
  onHomeSettingsChanged: (cb) => window.electronAPI.onHomeSettingsChanged(cb),
  homeViewPath: HOME_VIEW_PATH,
});
const {
  init: bootstrapInit,
  setFolderTreeVisibility,
  setFolderTreeSpacingMode,
} = bootstrapController;

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
  saveSettings: () => saveSettings(),
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
  zoomIn,
  zoomOut,
  zoomReset,
  toggleHiddenFiles: () => {
    currentSettings.showHiddenFiles = !currentSettings.showHiddenFiles;
    const toggle = document.getElementById('show-hidden-files-toggle') as HTMLInputElement | null;
    if (toggle) toggle.checked = currentSettings.showHiddenFiles;
    saveSettings();
    refresh();
  },
  showPropertiesForSelected: () => {
    const firstSelected = allFiles.find((f) => selectedItems.has(f.path));
    if (!firstSelected) return;
    void (async () => {
      const result = await window.electronAPI.getItemProperties(firstSelected.path);
      if (result.success) {
        showPropertiesDialog(result.properties);
      }
    })();
  },
  restoreClosedTab: () => restoreClosedTab(),
  togglePreviewPanel: () => previewController.togglePreviewPanel(),
  showContextMenuForSelected: () => {
    const selectedPaths = Array.from(selectedItems);
    if (selectedPaths.length === 0) return;
    const firstPath = selectedPaths[0];
    const item = allFiles.find((f) => f.path === firstPath);
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
    const fileGrid = document.getElementById('file-grid');
    const activeItem = fileGrid?.querySelector<HTMLElement>('.file-item[tabindex="0"]');
    if (activeItem) {
      activeItem.focus();
    } else {
      fileGrid?.focus();
    }
  },
  ensureActiveItem: () => ensureActiveItem(),
  toggleSelectionAtCursor: () => {
    const fileGrid = document.getElementById('file-grid');
    if (!fileGrid) return;
    const activeItem = fileGrid.querySelector<HTMLElement>('.file-item[tabindex="0"]');
    if (activeItem) {
      toggleSelection(activeItem);
    }
  },
  navigateFileGridFocusOnly: (key: string) => {
    const fileGrid = document.getElementById('file-grid');
    if (!fileGrid) return;
    const items = Array.from(fileGrid.querySelectorAll<HTMLElement>('.file-item'));
    if (items.length === 0) return;

    const active = fileGrid.querySelector<HTMLElement>('.file-item[tabindex="0"]');
    let currentIndex = active ? items.indexOf(active) : 0;
    if (currentIndex === -1) currentIndex = 0;

    const gridStyle = window.getComputedStyle(fileGrid);
    const columns =
      viewMode === 'list'
        ? 1
        : gridStyle.getPropertyValue('grid-template-columns').split(' ').length || 1;

    let newIndex = currentIndex;
    switch (key) {
      case 'ArrowUp':
        newIndex = Math.max(0, currentIndex - columns);
        break;
      case 'ArrowDown':
        newIndex = Math.min(items.length - 1, currentIndex + columns);
        break;
      case 'ArrowLeft':
        newIndex = Math.max(0, currentIndex - 1);
        break;
      case 'ArrowRight':
        newIndex = Math.min(items.length - 1, currentIndex + 1);
        break;
    }

    if (newIndex !== currentIndex) {
      if (active) active.tabIndex = -1;
      items[newIndex].tabIndex = 0;
      items[newIndex].focus({ preventScroll: true });
      items[newIndex].scrollIntoView({ block: 'nearest' });
    }
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
});
const { setupEventListeners } = eventListenersController;

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
    announceToScreenReader('Home view');
    return;
  }

  setHomeViewActive(false);
  let requestId = 0;

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

    const result = await window.electronAPI.getDirectoryContents(
      path,
      request.operationId,
      currentSettings.showHiddenFiles,
      false
    );
    if (!directoryLoader.isCurrentRequest(requestId)) return;

    if (!result.success) {
      console.error('Error loading directory:', result.error);
      showToast(result.error || 'Unknown error', 'Error Loading Directory', 'error');
      return;
    }

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
    window.electronAPI.watchDirectory(path);
    if (currentSettings.enableGitStatus) {
      fetchGitStatusAsync(path);
      updateGitBranch(path);
    }
  } catch (error) {
    console.error('Error navigating:', error);
    showToast(getErrorMessage(error), 'Error Loading Directory', 'error');
  } finally {
    const isCurrentRequest = directoryLoader.isCurrentRequest(requestId);
    finishDirectoryRequest(requestId);
    if (isCurrentRequest) hideLoading();
  }
}

const fileRenderController = createFileRenderController({
  getFileGrid: () => fileGrid,
  getEmptyState: () => emptyState,
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
  setDragData: (paths) => window.electronAPI.setDragData(paths),
  clearDragData: () => window.electronAPI.clearDragData(),
});
const { setupFileGridEventDelegation } = fileGridEventsController;

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
  const DELETE_BATCH_SIZE = 20;
  const allResults: PromiseSettledResult<{ success: boolean; error?: string }>[] = [];
  for (let i = 0; i < itemsSnapshot.length; i += DELETE_BATCH_SIZE) {
    const batch = itemsSnapshot.slice(i, i + DELETE_BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map((p) =>
        permanent ? window.electronAPI.deleteItem(p) : window.electronAPI.trashItem(p)
      )
    );
    allResults.push(...batchResults);
  }
  const successCount = allResults.filter((r) => r.status === 'fulfilled' && r.value.success).length;
  const failCount = allResults.length - successCount;
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
    refresh();
  }
  if (failCount > 0) {
    showToast(
      `${failCount} item${failCount > 1 ? 's' : ''} could not be deleted`,
      'Partial Failure',
      'error'
    );
  }
}

async function updateUndoRedoState() {
  const state = await window.electronAPI.getUndoRedoState();
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

  function showMenu() {
    if (!menu) return;
    const rect = btn!.getBoundingClientRect();
    menu.style.display = 'block';

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
    btn!.setAttribute('aria-expanded', 'true');

    void updateUndoRedoState();

    const items = Array.from(menu.querySelectorAll<HTMLElement>('.context-menu-item'));
    const firstEnabled = items.find((el) => !(el as HTMLButtonElement).disabled);
    if (firstEnabled) {
      firstEnabled.classList.add('focused');
      firstEnabled.tabIndex = 0;
      firstEnabled.focus({ preventScroll: true });
    }
  }

  function hideMenu() {
    if (!menu) return;
    menu.style.display = 'none';
    btn!.setAttribute('aria-expanded', 'false');
    menu.querySelectorAll('.focused').forEach((el) => el.classList.remove('focused'));
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.style.display === 'block') {
      hideMenu();
    } else {
      showMenu();
    }
  });

  const undoItem = document.getElementById('more-undo-btn');
  const redoItem = document.getElementById('more-redo-btn');

  undoItem?.addEventListener('click', () => {
    hideMenu();
    void performUndo();
  });
  redoItem?.addEventListener('click', () => {
    hideMenu();
    void performRedo();
  });

  menu.addEventListener('keydown', (e) => {
    const items = Array.from(menu.querySelectorAll<HTMLElement>('.context-menu-item'));
    const focusedIndex = items.findIndex((el) => el.classList.contains('focused'));

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const next = (focusedIndex + dir + items.length) % items.length;
      items.forEach((el, i) => {
        el.classList.toggle('focused', i === next);
        el.tabIndex = i === next ? 0 : -1;
      });
      items[next].focus({ preventScroll: true });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (focusedIndex >= 0) items[focusedIndex].click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideMenu();
      btn.focus();
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (menu.style.display === 'block' && !menu.contains(e.target as Node) && e.target !== btn) {
      hideMenu();
    }
  });
}

async function performUndoRedo(isUndo: boolean) {
  const result = isUndo
    ? await window.electronAPI.undoAction()
    : await window.electronAPI.redoAction();
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
  refresh();
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
  void navigateTo(history[historyIndex], true);
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
late.getFileByPath = (p) => filePathMap.get(p);
late.getFileItemData = getFileItemData;

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
      try {
        const request = startDirectoryRequest(currentPath);
        requestId = request.requestId;
        const result = await window.electronAPI.getDirectoryContents(
          currentPath,
          request.operationId,
          currentSettings.showHiddenFiles
        );
        if (!directoryLoader.isCurrentRequest(requestId)) return;
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
    await bootstrapInit();
  } catch (error) {
    console.error('Failed to initialize IYERIS:', error);
    alert('Failed to start IYERIS: ' + getErrorMessage(error));
  }
})();

window.addEventListener('beforeunload', () => {
  stopIndexStatusPolling();
  cancelActiveSearch();
  cleanupHoverCard();
  cleanupPropertiesDialog();
  thumbnails.resetThumbnailObserver();
  fileRenderController.disconnectVirtualizedObserver();
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
  if (settingsSaveTimeout) {
    clearTimeout(settingsSaveTimeout);
    settingsSaveTimeout = null;
  }
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
