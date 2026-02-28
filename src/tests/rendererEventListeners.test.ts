// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Settings, FileItem } from '../types';
import type { SettingsFormState } from '../rendererSettingsUi';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    _timestamp: 100,
    shortcuts: {},
    theme: 'dark',
    useSystemTheme: false,
    sortBy: 'name',
    sortOrder: 'asc',
    bookmarks: [],
    viewMode: 'grid',
    showDangerousOptions: false,
    startupPath: '',
    showHiddenFiles: true,
    enableSearchHistory: false,
    searchHistory: [],
    savedSearches: [],
    directoryHistory: [],
    enableIndexer: false,
    minimizeToTray: false,
    startOnLogin: false,
    autoCheckUpdates: false,
    showRecentFiles: false,
    showFolderTree: false,
    useLegacyTreeSpacing: false,
    enableTabs: false,
    globalContentSearch: false,
    globalClipboard: false,
    enableSyntaxHighlighting: false,
    enableGitStatus: false,
    gitIncludeUntracked: false,
    showFileHoverCard: false,
    showFileCheckboxes: false,
    reduceMotion: false,
    highContrast: false,
    largeText: false,
    boldText: false,
    visibleFocus: false,
    reduceTransparency: false,
    liquidGlassMode: false,
    uiDensity: 'default',
    updateChannel: 'stable',
    themedIcons: false,
    disableHardwareAcceleration: false,
    useSystemFontSize: false,
    confirmFileOperations: true,
    fileConflictBehavior: 'ask',
    skipElevationConfirmation: false,
    maxThumbnailSizeMB: 10,
    thumbnailQuality: 'medium',
    autoPlayVideos: false,
    previewPanelPosition: 'right',
    maxPreviewSizeMB: 50,
    gridColumns: 'auto',
    iconSize: 64,
    compactFileInfo: false,
    showFileExtensions: true,
    maxSearchHistoryItems: 20,
    maxDirectoryHistoryItems: 20,
    ...overrides,
  };
}

function createMockConfig() {
  const ipcCleanupFunctions: (() => void)[] = [];
  let currentSettings = makeSettings();

  return {
    getCurrentSettings: vi.fn(() => currentSettings),
    setCurrentSettings: vi.fn((s: Settings) => {
      currentSettings = s;
    }),
    getCurrentPath: vi.fn(() => '/home/user'),
    getViewMode: vi.fn(() => 'grid'),
    getTabsEnabled: vi.fn(() => false),
    getTabs: vi.fn(() => [{ id: 'tab-1' }]),
    getActiveTabId: vi.fn(() => 'tab-1'),
    getFileGrid: vi.fn(() => document.getElementById('file-grid')),
    getSortBtn: vi.fn(() => document.getElementById('sort-btn')!),
    getBackBtn: vi.fn(() => document.getElementById('back-btn')!),
    getForwardBtn: vi.fn(() => document.getElementById('forward-btn')!),
    getUpBtn: vi.fn(() => document.getElementById('up-btn')!),
    getRefreshBtn: vi.fn(() => document.getElementById('refresh-btn')!),
    getNewFileBtn: vi.fn(() => document.getElementById('new-file-btn')! as HTMLButtonElement),
    getNewFolderBtn: vi.fn(() => document.getElementById('new-folder-btn')! as HTMLButtonElement),
    getViewToggleBtn: vi.fn(() => document.getElementById('view-toggle-btn')! as HTMLButtonElement),
    getAddressInput: vi.fn(
      () => document.getElementById('address-input') as HTMLInputElement | null
    ),
    getSelectionCopyBtn: vi.fn(() => document.getElementById('selection-copy-btn')),
    getSelectionCutBtn: vi.fn(() => document.getElementById('selection-cut-btn')),
    getSelectionMoveBtn: vi.fn(() => document.getElementById('selection-move-btn')),
    getSelectionRenameBtn: vi.fn(() => document.getElementById('selection-rename-btn')),
    getSelectionDeleteBtn: vi.fn(() => document.getElementById('selection-delete-btn')),
    getBookmarkAddBtn: vi.fn(() => document.getElementById('bookmark-add-btn')),
    getIpcCleanupFunctions: vi.fn(() => ipcCleanupFunctions),

    goBack: vi.fn(),
    goForward: vi.fn(),
    goUp: vi.fn(),
    goHome: vi.fn(),
    refresh: vi.fn(),
    navigateTo: vi.fn(),
    clearSelection: vi.fn(),
    selectAll: vi.fn(),
    toggleView: vi.fn(),
    renameSelected: vi.fn(),
    deleteSelected: vi.fn(),
    performUndo: vi.fn(),
    performRedo: vi.fn(),
    saveSettings: vi.fn(),
    openSelectedItem: vi.fn(),
    selectFirstItem: vi.fn(),
    selectLastItem: vi.fn(),
    navigateByPage: vi.fn(),
    navigateFileGrid: vi.fn(),
    handleTypeaheadInput: vi.fn(),
    openSearch: vi.fn(),
    closeSearch: vi.fn(),
    isSearchModeActive: vi.fn(() => false),
    showQuickLook: vi.fn(),
    closeQuickLook: vi.fn(),
    isQuickLookOpen: vi.fn(() => false),
    showSortMenu: vi.fn(),
    hideSortMenu: vi.fn(),
    changeSortMode: vi.fn(),
    addBookmark: vi.fn(),
    setSidebarCollapsed: vi.fn(),
    syncSidebarToggleState: vi.fn(),
    showSettingsModal: vi.fn(),
    hideSettingsModal: vi.fn(),
    showShortcutsModal: vi.fn(),
    hideShortcutsModal: vi.fn(),
    hideExtractModal: vi.fn(),
    hideCompressOptionsModal: vi.fn(),
    hideLicensesModal: vi.fn(),
    closeHomeSettingsModal: vi.fn(),
    showEmptySpaceContextMenu: vi.fn(),
    hideContextMenu: vi.fn(),
    hideEmptySpaceContextMenu: vi.fn(),
    handleContextMenuAction: vi.fn(),
    handleEmptySpaceContextMenuAction: vi.fn(),
    handleContextMenuKeyNav: vi.fn(() => false),
    handleSortMenuKeyNav: vi.fn(() => false),
    getContextMenuData: vi.fn(() => null),
    openNewWindow: vi.fn(),
    showCommandPalette: vi.fn(),
    addNewTab: vi.fn(),
    closeTab: vi.fn(),
    switchToTab: vi.fn(),
    showToast: vi.fn(),

    applySettings: vi.fn(),
    getSavedState: vi.fn(() => null),
    captureSettingsFormState: vi.fn(() => ({}) as SettingsFormState),
    buildSettingsFormStateFromSettings: vi.fn(() => ({}) as SettingsFormState),
    setSavedState: vi.fn(),
    resetRedoState: vi.fn(),
    applySettingsFormState: vi.fn(),
    updateCustomThemeUI: vi.fn(),
    syncShortcutBindingsFromSettings: vi.fn(),
    hideBreadcrumbMenu: vi.fn(),
    getBreadcrumbMenuElement: vi.fn(() => null),
    isBreadcrumbMenuOpen: vi.fn(() => false),

    isShortcutCaptureActive: vi.fn(() => false),
    getFixedShortcutActionIdFromEvent: vi.fn(() => null),
    getShortcutActionIdFromEvent: vi.fn(() => null),

    createNewFile: vi.fn(),
    createNewFolder: vi.fn(),
    copyToClipboard: vi.fn(),
    cutToClipboard: vi.fn(),
    pasteFromClipboard: vi.fn(),
    moveSelectedToFolder: vi.fn(),
    clipboardOnClipboardChanged: vi.fn(),
    clipboardUpdateCutVisuals: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomReset: vi.fn(),
    toggleHiddenFiles: vi.fn(),
    showPropertiesForSelected: vi.fn(),
    restoreClosedTab: vi.fn(),
    togglePreviewPanel: vi.fn(),
    showContextMenuForSelected: vi.fn(),
    focusFileGrid: vi.fn(),
    ensureActiveItem: vi.fn(),
    toggleSelectionAtCursor: vi.fn(),
    navigateFileGridFocusOnly: vi.fn(),

    initSettingsTabs: vi.fn(),
    initSettingsUi: vi.fn(),
    initShortcutsModal: vi.fn(),
    setupFileGridEventDelegation: vi.fn(),
    setupRubberBandSelection: vi.fn(),
    setupListHeader: vi.fn(),
    setupViewOptions: vi.fn(),
    setupSidebarResize: vi.fn(),
    setupSidebarSections: vi.fn(),
    setupPreviewResize: vi.fn(),
    initPreviewUi: vi.fn(),
    setupHoverCard: vi.fn(),
    initSearchListeners: vi.fn(),
    initDragAndDropListeners: vi.fn(),

    homeViewLabel: 'Home',
    homeViewPath: '~home',

    _ipcCleanupFunctions: ipcCleanupFunctions,
    _setCurrentSettings: (s: Settings) => {
      currentSettings = s;
    },
  };
}

function setupBasicDom() {
  document.body.innerHTML = `
    <div id="file-view">
      <div id="file-grid"></div>
    </div>
    <div id="sort-btn"></div>
    <div id="back-btn"></div>
    <div id="forward-btn"></div>
    <div id="up-btn"></div>
    <div id="refresh-btn"></div>
    <button id="new-file-btn"></button>
    <button id="new-folder-btn"></button>
    <button id="view-toggle-btn"></button>
    <input id="address-input" />
    <div id="selection-copy-btn"></div>
    <div id="selection-cut-btn"></div>
    <div id="selection-move-btn"></div>
    <div id="selection-rename-btn"></div>
    <div id="selection-delete-btn"></div>
    <div id="selection-overflow-btn"></div>
    <div id="selection-overflow-menu" style="display:none"></div>
    <div id="bookmark-add-btn"></div>
    <div id="select-all-btn"></div>
    <div id="deselect-all-btn"></div>
    <div id="minimize-btn"></div>
    <div id="maximize-btn"></div>
    <div id="close-btn"></div>
    <div id="sidebar-toggle"></div>
    <button id="empty-new-folder-btn"></button>
    <button id="empty-new-file-btn"></button>
    <div id="status-hidden"></div>
    <input id="show-hidden-files-toggle" type="checkbox" />
    <div id="context-menu" style="display:none"></div>
    <div id="empty-space-context-menu" style="display:none"></div>
    <div id="sort-menu" style="display:none"></div>
    <div id="settings-modal" style="display:none"></div>
    <div id="shortcuts-modal" style="display:none"></div>
    <div id="extract-modal" class="modal-overlay" style="display:none"></div>
    <div id="compress-options-modal" class="modal-overlay" style="display:none"></div>
    <div id="licenses-modal" class="modal-overlay" style="display:none"></div>
    <div id="home-settings-modal" class="modal-overlay" style="display:none"></div>
  `;
}

function setupElectronAPIMock() {
  (window as any).electronAPI = {
    onClipboardChanged: vi.fn(() => vi.fn()),
    onSettingsChanged: vi.fn(() => vi.fn()),
    minimizeWindow: vi.fn(),
    maximizeWindow: vi.fn(),
    closeWindow: vi.fn(),
  };
}

import { createEventListenersController } from '../rendererEventListeners';

describe('createEventListenersController', () => {
  beforeEach(() => {
    setupBasicDom();
    setupElectronAPIMock();
  });

  describe('setupEventListeners', () => {
    it('initializes all core UI interactions', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);

      ctrl.setupEventListeners();

      expect(config.initSettingsTabs).toHaveBeenCalled();
      expect(config.initSettingsUi).toHaveBeenCalled();
      expect(config.initShortcutsModal).toHaveBeenCalled();
      expect(config.setupFileGridEventDelegation).toHaveBeenCalled();
      expect(config.setupRubberBandSelection).toHaveBeenCalled();
      expect(config.setupListHeader).toHaveBeenCalled();
      expect(config.setupViewOptions).toHaveBeenCalled();
      expect(config.setupSidebarResize).toHaveBeenCalled();
      expect(config.setupSidebarSections).toHaveBeenCalled();
      expect(config.setupPreviewResize).toHaveBeenCalled();
      expect(config.initPreviewUi).toHaveBeenCalled();
    });

    it('sets up hover card when showFileHoverCard is enabled', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(makeSettings({ showFileHoverCard: true }));
      const ctrl = createEventListenersController(config);

      ctrl.setupEventListeners();

      expect(config.setupHoverCard).toHaveBeenCalled();
    });

    it('does not set up hover card when showFileHoverCard is false', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(makeSettings({ showFileHoverCard: false }));
      const ctrl = createEventListenersController(config);

      ctrl.setupEventListeners();

      expect(config.setupHoverCard).not.toHaveBeenCalled();
    });

    it('registers IPC cleanup functions for clipboard and settings listeners', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);

      ctrl.setupEventListeners();

      expect(config._ipcCleanupFunctions.length).toBe(2);
    });

    it('attaches search listeners', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);

      ctrl.setupEventListeners();

      expect(config.initSearchListeners).toHaveBeenCalled();
    });

    it('attaches drag and drop listeners', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);

      ctrl.setupEventListeners();

      expect(config.initDragAndDropListeners).toHaveBeenCalled();
    });

    it('clears selection when clicking on empty file grid space', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      const fileGrid = document.getElementById('file-grid')!;
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'target', { value: fileGrid });
      fileGrid.dispatchEvent(event);

      expect(config.clearSelection).toHaveBeenCalled();
    });
  });

  describe('isModalOpen', () => {
    it('returns false when no modals are visible', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);

      expect(ctrl.isModalOpen()).toBe(false);
    });

    it('returns true when quicklook is open', () => {
      const config = createMockConfig();
      config.isQuickLookOpen.mockReturnValue(true);
      const ctrl = createEventListenersController(config);

      expect(ctrl.isModalOpen()).toBe(true);
    });

    it('returns true when a modal overlay is visible', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);

      const modal = document.getElementById('extract-modal')!;
      modal.style.display = 'flex';

      expect(ctrl.isModalOpen()).toBe(true);
    });
  });

  describe('isEditableElementActive', () => {
    it('returns false when body is focused', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      (document.body as HTMLElement).focus();

      expect(ctrl.isEditableElementActive()).toBeFalsy();
    });

    it('returns true when an input is focused', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const input = document.getElementById('address-input') as HTMLInputElement;
      input.focus();

      expect(document.activeElement).toBe(input);
      expect(ctrl.isEditableElementActive()).toBe(true);
    });

    it('returns true when a textarea is focused', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      textarea.focus();

      expect(document.activeElement).toBe(textarea);
      expect(ctrl.isEditableElementActive()).toBe(true);
    });
  });

  describe('runShortcutAction', () => {
    function makeKeyEvent(key: string, opts: Partial<KeyboardEvent> = {}): KeyboardEvent {
      return new KeyboardEvent('keydown', {
        key,
        cancelable: true,
        bubbles: true,
        ...opts,
      });
    }

    it('dispatches refresh action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('r');

      const result = ctrl.runShortcutAction('refresh', e);

      expect(result).toBe(true);
      expect(config.refresh).toHaveBeenCalled();
    });

    it('dispatches settings action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('s');

      const result = ctrl.runShortcutAction('settings', e);

      expect(result).toBe(true);
      expect(config.showSettingsModal).toHaveBeenCalled();
    });

    it('dispatches command-palette action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('p');

      ctrl.runShortcutAction('command-palette', e);

      expect(config.showCommandPalette).toHaveBeenCalled();
    });

    it('dispatches search action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('f');

      ctrl.runShortcutAction('search', e);

      expect(config.openSearch).toHaveBeenCalledWith(false);
    });

    it('dispatches global-search action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('f');

      ctrl.runShortcutAction('global-search', e);

      expect(config.openSearch).toHaveBeenCalledWith(true);
    });

    it('dispatches new-window action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('n');

      ctrl.runShortcutAction('new-window', e);

      expect(config.openNewWindow).toHaveBeenCalled();
    });

    it('dispatches new-file action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('n');

      ctrl.runShortcutAction('new-file', e);

      expect(config.createNewFile).toHaveBeenCalled();
    });

    it('dispatches new-folder action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('n');

      ctrl.runShortcutAction('new-folder', e);

      expect(config.createNewFolder).toHaveBeenCalled();
    });

    it('dispatches go-back action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('ArrowLeft');

      ctrl.runShortcutAction('go-back', e);

      expect(config.goBack).toHaveBeenCalled();
    });

    it('dispatches go-forward action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('ArrowRight');

      ctrl.runShortcutAction('go-forward', e);

      expect(config.goForward).toHaveBeenCalled();
    });

    it('dispatches go-up action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('ArrowUp');

      ctrl.runShortcutAction('go-up', e);

      expect(config.goUp).toHaveBeenCalled();
    });

    it('dispatches copy action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('c');

      ctrl.runShortcutAction('copy', e);

      expect(config.copyToClipboard).toHaveBeenCalled();
    });

    it('dispatches cut action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('x');

      ctrl.runShortcutAction('cut', e);

      expect(config.cutToClipboard).toHaveBeenCalled();
    });

    it('dispatches paste action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('v');

      ctrl.runShortcutAction('paste', e);

      expect(config.pasteFromClipboard).toHaveBeenCalled();
    });

    it('dispatches select-all action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('a');

      ctrl.runShortcutAction('select-all', e);

      expect(config.selectAll).toHaveBeenCalled();
    });

    it('dispatches undo action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('z');

      ctrl.runShortcutAction('undo', e);

      expect(config.performUndo).toHaveBeenCalled();
    });

    it('dispatches redo action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('z');

      ctrl.runShortcutAction('redo', e);

      expect(config.performRedo).toHaveBeenCalled();
    });

    it('dispatches toggle-sidebar action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('b');

      ctrl.runShortcutAction('toggle-sidebar', e);

      expect(config.setSidebarCollapsed).toHaveBeenCalled();
    });

    it('dispatches zoom-in action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('+');

      ctrl.runShortcutAction('zoom-in', e);

      expect(config.zoomIn).toHaveBeenCalled();
    });

    it('dispatches zoom-out action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('-');

      ctrl.runShortcutAction('zoom-out', e);

      expect(config.zoomOut).toHaveBeenCalled();
    });

    it('dispatches zoom-reset action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('0');

      ctrl.runShortcutAction('zoom-reset', e);

      expect(config.zoomReset).toHaveBeenCalled();
    });

    it('dispatches shortcuts action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('k');

      ctrl.runShortcutAction('shortcuts', e);

      expect(config.showShortcutsModal).toHaveBeenCalled();
    });

    it('returns false for unknown action', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('x');

      const result = ctrl.runShortcutAction('nonexistent-action', e);

      expect(result).toBe(false);
    });

    it('does not fire copy if text is selected', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('c');

      const span = document.createElement('span');
      span.textContent = 'selected text';
      document.body.appendChild(span);
      const range = document.createRange();
      range.selectNodeContents(span);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);

      const result = ctrl.runShortcutAction('copy', e);

      expect(result).toBe(false);
      expect(config.copyToClipboard).not.toHaveBeenCalled();

      window.getSelection()?.removeAllRanges();
    });

    it('handles next-tab with tabs enabled and multiple tabs', () => {
      const config = createMockConfig();
      config.getTabsEnabled.mockReturnValue(true);
      config.getTabs.mockReturnValue([{ id: 'tab-1' }, { id: 'tab-2' }, { id: 'tab-3' }]);
      config.getActiveTabId.mockReturnValue('tab-1');
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('Tab');

      const result = ctrl.runShortcutAction('next-tab', e);

      expect(result).toBe(true);
      expect(config.switchToTab).toHaveBeenCalledWith('tab-2');
    });

    it('handles prev-tab wrapping around', () => {
      const config = createMockConfig();
      config.getTabsEnabled.mockReturnValue(true);
      config.getTabs.mockReturnValue([{ id: 'tab-1' }, { id: 'tab-2' }, { id: 'tab-3' }]);
      config.getActiveTabId.mockReturnValue('tab-1');
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('Tab');

      const result = ctrl.runShortcutAction('prev-tab', e);

      expect(result).toBe(true);
      expect(config.switchToTab).toHaveBeenCalledWith('tab-3');
    });

    it('handles next-tab wrapping to first tab', () => {
      const config = createMockConfig();
      config.getTabsEnabled.mockReturnValue(true);
      config.getTabs.mockReturnValue([{ id: 'tab-1' }, { id: 'tab-2' }]);
      config.getActiveTabId.mockReturnValue('tab-2');
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('Tab');

      ctrl.runShortcutAction('next-tab', e);

      expect(config.switchToTab).toHaveBeenCalledWith('tab-1');
    });

    it('does not switch tabs when tabs are disabled', () => {
      const config = createMockConfig();
      config.getTabsEnabled.mockReturnValue(false);
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('Tab');

      ctrl.runShortcutAction('next-tab', e);

      expect(config.switchToTab).not.toHaveBeenCalled();
    });

    it('dispatches new-tab when tabs are enabled', () => {
      const config = createMockConfig();
      config.getTabsEnabled.mockReturnValue(true);
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('t');

      ctrl.runShortcutAction('new-tab', e);

      expect(config.addNewTab).toHaveBeenCalled();
    });

    it('does not add tab when tabs are disabled', () => {
      const config = createMockConfig();
      config.getTabsEnabled.mockReturnValue(false);
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('t');

      ctrl.runShortcutAction('new-tab', e);

      expect(config.addNewTab).not.toHaveBeenCalled();
    });

    it('dispatches close-tab when tabs enabled and multiple tabs', () => {
      const config = createMockConfig();
      config.getTabsEnabled.mockReturnValue(true);
      config.getTabs.mockReturnValue([{ id: 'tab-1' }, { id: 'tab-2' }]);
      config.getActiveTabId.mockReturnValue('tab-1');
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('w');

      ctrl.runShortcutAction('close-tab', e);

      expect(config.closeTab).toHaveBeenCalledWith('tab-1');
    });

    it('does not close tab when only one tab exists', () => {
      const config = createMockConfig();
      config.getTabsEnabled.mockReturnValue(true);
      config.getTabs.mockReturnValue([{ id: 'tab-1' }]);
      const ctrl = createEventListenersController(config);
      const e = makeKeyEvent('w');

      ctrl.runShortcutAction('close-tab', e);

      expect(config.closeTab).not.toHaveBeenCalled();
    });
  });

  describe('keyboard event integration', () => {
    it('dispatches Escape to dismiss extract modal', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.getElementById('extract-modal')!.style.display = 'flex';

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(config.hideExtractModal).toHaveBeenCalled();
    });

    it('dispatches Escape to dismiss settings modal', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.getElementById('settings-modal')!.style.display = 'flex';

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(config.hideSettingsModal).toHaveBeenCalled();
    });

    it('dispatches Escape to close search when active', () => {
      const config = createMockConfig();
      config.isSearchModeActive.mockReturnValue(true);
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(config.closeSearch).toHaveBeenCalled();
    });

    it('dispatches Space to show QuickLook when not open', () => {
      const config = createMockConfig();
      config.isQuickLookOpen.mockReturnValue(false);
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })
      );

      expect(config.showQuickLook).toHaveBeenCalled();
    });

    it('closes QuickLook via Escape', () => {
      const config = createMockConfig();
      config.isQuickLookOpen.mockReturnValue(true);
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(config.closeQuickLook).toHaveBeenCalled();
    });

    it('dispatches Delete to trash item', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));

      expect(config.deleteSelected).toHaveBeenCalledWith();
    });

    it('dispatches Shift+Delete to permanently delete when developer mode is on', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(makeSettings({ showDangerousOptions: true }));
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', shiftKey: true, bubbles: true })
      );

      expect(config.deleteSelected).toHaveBeenCalledWith(true);
    });

    it('dispatches Shift+Delete to permanently delete even when developer mode is off', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(makeSettings({ showDangerousOptions: false }));
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', shiftKey: true, bubbles: true })
      );

      expect(config.deleteSelected).toHaveBeenCalledWith(true);
    });

    it('dispatches Backspace to go up', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));

      expect(config.goUp).toHaveBeenCalled();
    });

    it('dispatches F2 to rename', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));

      expect(config.renameSelected).toHaveBeenCalled();
    });

    it('dispatches Enter to open selected', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(config.openSelectedItem).toHaveBeenCalled();
    });

    it('dispatches Home to select first item', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));

      expect(config.selectFirstItem).toHaveBeenCalledWith(false);
    });

    it('dispatches End to select last item', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));

      expect(config.selectLastItem).toHaveBeenCalledWith(false);
    });

    it('dispatches arrow keys to navigate file grid', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

      expect(config.navigateFileGrid).toHaveBeenCalledWith('ArrowDown', false);
    });

    it('dispatches PageDown to navigate by page', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));

      expect(config.navigateByPage).toHaveBeenCalledWith('down', false);
    });

    it('routes single character keys to typeahead when not in search or column view', () => {
      const config = createMockConfig();
      config.isSearchModeActive.mockReturnValue(false);
      config.getViewMode.mockReturnValue('grid');
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));

      expect(config.handleTypeaheadInput).toHaveBeenCalledWith('a');
    });

    it('does not route typeahead in column view', () => {
      const config = createMockConfig();
      config.getViewMode.mockReturnValue('column');
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));

      expect(config.handleTypeaheadInput).not.toHaveBeenCalled();
    });
  });

  describe('button click bindings', () => {
    it('back button triggers goBack', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.getElementById('back-btn')!.click();

      expect(config.goBack).toHaveBeenCalled();
    });

    it('forward button triggers goForward', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.getElementById('forward-btn')!.click();

      expect(config.goForward).toHaveBeenCalled();
    });

    it('up button triggers goUp', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.getElementById('up-btn')!.click();

      expect(config.goUp).toHaveBeenCalled();
    });

    it('refresh button triggers refresh', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.getElementById('refresh-btn')!.click();

      expect(config.refresh).toHaveBeenCalled();
    });

    it('new file button triggers createNewFile', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.getElementById('new-file-btn')!.click();

      expect(config.createNewFile).toHaveBeenCalled();
    });

    it('new folder button triggers createNewFolder', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.getElementById('new-folder-btn')!.click();

      expect(config.createNewFolder).toHaveBeenCalled();
    });

    it('view toggle button triggers toggleView', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.getElementById('view-toggle-btn')!.click();

      expect(config.toggleView).toHaveBeenCalled();
    });

    it('select all button triggers selectAll', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.getElementById('select-all-btn')!.click();

      expect(config.selectAll).toHaveBeenCalled();
    });

    it('deselect all button triggers clearSelection', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.getElementById('deselect-all-btn')!.click();

      expect(config.clearSelection).toHaveBeenCalled();
    });
  });

  describe('window controls', () => {
    it('minimize button calls minimizeWindow', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.getElementById('minimize-btn')!.click();

      expect(window.electronAPI.minimizeWindow).toHaveBeenCalled();
    });

    it('maximize button calls maximizeWindow', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.getElementById('maximize-btn')!.click();

      expect(window.electronAPI.maximizeWindow).toHaveBeenCalled();
    });

    it('close button calls closeWindow', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      document.getElementById('close-btn')!.click();

      expect(window.electronAPI.closeWindow).toHaveBeenCalled();
    });
  });

  describe('address bar', () => {
    it('navigates to entered path on Enter', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      const input = document.getElementById('address-input') as HTMLInputElement;
      input.value = '/usr/local/bin';
      input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));

      expect(config.navigateTo).toHaveBeenCalledWith('/usr/local/bin');
    });

    it('navigates to home path when home label is entered', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      const input = document.getElementById('address-input') as HTMLInputElement;
      input.value = 'Home';
      input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));

      expect(config.navigateTo).toHaveBeenCalledWith('~home');
    });
  });

  describe('context menu clicks', () => {
    it('closes context menu when clicking outside', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      const contextMenu = document.getElementById('context-menu')!;
      contextMenu.style.display = 'block';

      document.body.click();

      expect(config.hideContextMenu).toHaveBeenCalled();
    });

    it('closes empty-space context menu when clicking outside', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      const emptyMenu = document.getElementById('empty-space-context-menu')!;
      emptyMenu.style.display = 'block';

      document.body.click();

      expect(config.hideEmptySpaceContextMenu).toHaveBeenCalled();
    });
  });

  describe('IPC sync listeners', () => {
    it('registers clipboard change listener via electronAPI', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      expect(window.electronAPI.onClipboardChanged).toHaveBeenCalled();
    });

    it('registers settings change listener via electronAPI', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      expect(window.electronAPI.onSettingsChanged).toHaveBeenCalled();
    });

    it('calls clipboardOnClipboardChanged when clipboard changes', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      const onClipboard = (window.electronAPI.onClipboardChanged as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      const clipboardData = { operation: 'copy' as const, paths: ['/test.txt'] };
      onClipboard(clipboardData);

      expect(config.clipboardOnClipboardChanged).toHaveBeenCalledWith(clipboardData);
      expect(config.clipboardUpdateCutVisuals).toHaveBeenCalled();
    });

    it('applies new settings when settings change with newer timestamp', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      const onSettings = (window.electronAPI.onSettingsChanged as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      const newSettings = makeSettings({ _timestamp: 200, theme: 'light' });
      onSettings(newSettings);

      expect(config.setCurrentSettings).toHaveBeenCalledWith(newSettings);
      expect(config.applySettings).toHaveBeenCalledWith(newSettings);
    });

    it('ignores settings with older timestamp', () => {
      const config = createMockConfig();
      const ctrl = createEventListenersController(config);
      ctrl.setupEventListeners();

      const onSettings = (window.electronAPI.onSettingsChanged as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      const oldSettings = makeSettings({ _timestamp: 50, theme: 'light' });
      onSettings(oldSettings);

      expect(config.setCurrentSettings).not.toHaveBeenCalled();
    });
  });
});
