import type { Settings, FileItem } from './types';
import type { ToastType } from './rendererToasts.js';
import type { SettingsFormState } from './rendererSettingsUi.js';

type EventListenersConfig = {
  getCurrentSettings: () => Settings;
  setCurrentSettings: (settings: Settings) => void;
  getCurrentPath: () => string;
  getViewMode: () => string;
  getTabsEnabled: () => boolean;
  getTabs: () => { id: string }[];
  getActiveTabId: () => string;
  getFileGrid: () => HTMLElement | null;
  getSortBtn: () => HTMLElement;
  getBackBtn: () => HTMLElement;
  getForwardBtn: () => HTMLElement;
  getUpBtn: () => HTMLElement;
  getUndoBtn: () => HTMLElement;
  getRedoBtn: () => HTMLElement;
  getRefreshBtn: () => HTMLElement;
  getNewFileBtn: () => HTMLButtonElement;
  getNewFolderBtn: () => HTMLButtonElement;
  getViewToggleBtn: () => HTMLButtonElement;
  getAddressInput: () => HTMLInputElement | null;
  getSelectionCopyBtn: () => HTMLElement | null;
  getSelectionCutBtn: () => HTMLElement | null;
  getSelectionMoveBtn: () => HTMLElement | null;
  getSelectionRenameBtn: () => HTMLElement | null;
  getSelectionDeleteBtn: () => HTMLElement | null;
  getBookmarkAddBtn: () => HTMLElement | null;
  getIpcCleanupFunctions: () => (() => void)[];

  goBack: () => void;
  goForward: () => void;
  goUp: () => void;
  goHome: () => void;
  refresh: () => void;
  navigateTo: (path: string) => void;
  clearSelection: () => void;
  selectAll: () => void;
  toggleView: () => void;
  renameSelected: () => void;
  deleteSelected: (permanent?: boolean) => void;
  performUndo: () => void;
  performRedo: () => void;
  saveSettings: () => void;
  openSelectedItem: () => void;
  selectFirstItem: (extend: boolean) => void;
  selectLastItem: (extend: boolean) => void;
  navigateByPage: (direction: 'up' | 'down', extend: boolean) => void;
  navigateFileGrid: (key: string, extend: boolean) => void;
  handleTypeaheadInput: (key: string) => void;
  openSearch: (global: boolean) => void;
  closeSearch: () => void;
  isSearchModeActive: () => boolean;
  showQuickLook: () => void;
  closeQuickLook: () => void;
  isQuickLookOpen: () => boolean;
  showSortMenu: (e: MouseEvent) => void;
  hideSortMenu: () => void;
  changeSortMode: (sortType: string) => void;
  addBookmark: () => void;
  setSidebarCollapsed: () => void;
  syncSidebarToggleState: () => void;
  showSettingsModal: () => void;
  hideSettingsModal: () => void | Promise<void>;
  showShortcutsModal: () => void;
  hideShortcutsModal: () => void;
  hideExtractModal: () => void;
  hideCompressOptionsModal: () => void;
  hideLicensesModal: () => void;
  closeHomeSettingsModal: () => void;
  showEmptySpaceContextMenu: (x: number, y: number) => void;
  hideContextMenu: () => void;
  hideEmptySpaceContextMenu: () => void;
  handleContextMenuAction: (action: string | undefined, item: FileItem, format?: string) => void;
  handleEmptySpaceContextMenuAction: (action: string | undefined) => void;
  handleContextMenuKeyNav: (e: KeyboardEvent) => boolean;
  handleSortMenuKeyNav: (e: KeyboardEvent) => boolean;
  getContextMenuData: () => FileItem | null;
  openNewWindow: () => void;
  showCommandPalette: () => void;
  addNewTab: () => void;
  closeTab: (id: string) => void;
  switchToTab: (id: string) => void;
  showToast: (message: string, title: string, type: ToastType) => void;

  applySettings: (settings: Settings) => void;
  getSavedState: () => SettingsFormState | null;
  captureSettingsFormState: () => SettingsFormState;
  buildSettingsFormStateFromSettings: (settings: Settings) => SettingsFormState;
  setSavedState: (state: SettingsFormState) => void;
  resetRedoState: () => void;
  applySettingsFormState: (state: SettingsFormState) => void;
  updateCustomThemeUI: (opts?: { syncSelect?: boolean; selectedTheme?: string }) => void;
  syncShortcutBindingsFromSettings: (settings: Settings, opts: { render: boolean }) => void;
  hideBreadcrumbMenu: () => void;
  getBreadcrumbMenuElement: () => HTMLElement | null;
  isBreadcrumbMenuOpen: () => boolean;

  isShortcutCaptureActive: () => boolean;
  getFixedShortcutActionIdFromEvent: (e: KeyboardEvent) => string | null;
  getShortcutActionIdFromEvent: (e: KeyboardEvent) => string | null;

  createNewFile: () => void;
  createNewFolder: () => void;
  copyToClipboard: () => void;
  cutToClipboard: () => void;
  pasteFromClipboard: () => void;
  moveSelectedToFolder: () => void;
  clipboardOnClipboardChanged: (
    newClipboard: { operation: 'copy' | 'cut'; paths: string[] } | null
  ) => void;
  clipboardUpdateCutVisuals: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  toggleHiddenFiles: () => void;
  showPropertiesForSelected: () => void;
  restoreClosedTab: () => void;
  togglePreviewPanel: () => void;
  showContextMenuForSelected: () => void;
  focusFileGrid: () => void;
  ensureActiveItem: () => void;
  toggleSelectionAtCursor: () => void;
  navigateFileGridFocusOnly: (key: string) => void;

  initSettingsTabs: () => void;
  initSettingsUi: () => void;
  initShortcutsModal: () => void;
  setupFileGridEventDelegation: () => void;
  setupRubberBandSelection: () => void;
  setupListHeader: () => void;
  setupViewOptions: () => void;
  setupSidebarResize: () => void;
  setupSidebarSections: () => void;
  setupPreviewResize: () => void;
  initPreviewUi: () => void;
  setupHoverCard: () => void;
  initSearchListeners: () => void;
  initDragAndDropListeners: () => void;

  homeViewLabel: string;
  homeViewPath: string;
};

export function createEventListenersController(config: EventListenersConfig) {
  function initCoreUiInteractions(): void {
    config.initSettingsTabs();
    config.initSettingsUi();
    config.initShortcutsModal();
    config.setupFileGridEventDelegation();
    config.setupRubberBandSelection();
    config.setupListHeader();
    config.setupViewOptions();
    config.setupSidebarResize();
    config.setupSidebarSections();
    config.setupPreviewResize();
    config.initPreviewUi();
    if (config.getCurrentSettings().showFileHoverCard !== false) {
      config.setupHoverCard();
    }
  }

  function initSyncEventListeners(): void {
    const cleanupClipboard = window.electronAPI.onClipboardChanged((newClipboard) => {
      config.clipboardOnClipboardChanged(newClipboard);
      config.clipboardUpdateCutVisuals();
    });
    config.getIpcCleanupFunctions().push(cleanupClipboard);

    const cleanupSettings = window.electronAPI.onSettingsChanged((newSettings) => {
      const currentTimestamp =
        typeof config.getCurrentSettings()._timestamp === 'number'
          ? config.getCurrentSettings()._timestamp
          : 0;
      const newTimestamp = typeof newSettings._timestamp === 'number' ? newSettings._timestamp : 0;

      if ((newTimestamp as number) < (currentTimestamp as number)) {
        return;
      }

      config.setCurrentSettings(newSettings);
      config.applySettings(newSettings);
      const settingsModal = document.getElementById('settings-modal') as HTMLElement | null;
      if (settingsModal && settingsModal.style.display === 'flex') {
        const previousSavedState = config.getSavedState();
        const currentFormState = config.captureSettingsFormState();
        const nextSavedState = config.buildSettingsFormStateFromSettings(newSettings);
        const mergedState = { ...nextSavedState };

        if (previousSavedState) {
          Object.keys(currentFormState).forEach((key) => {
            if (currentFormState[key] !== previousSavedState[key]) {
              mergedState[key] = currentFormState[key];
            }
          });
        }

        config.setSavedState(nextSavedState);
        config.resetRedoState();
        config.applySettingsFormState(mergedState);
        const themeSelect = document.getElementById('theme-select') as HTMLSelectElement | null;
        config.updateCustomThemeUI({
          syncSelect: false,
          selectedTheme: themeSelect?.value,
        });
      } else {
        config.updateCustomThemeUI();
      }
      const shortcutsModal = document.getElementById('shortcuts-modal');
      config.syncShortcutBindingsFromSettings(newSettings, {
        render: shortcutsModal ? shortcutsModal.style.display === 'flex' : false,
      });
    });
    config.getIpcCleanupFunctions().push(cleanupSettings);
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
      [config.getBackBtn(), config.goBack],
      [config.getForwardBtn(), config.goForward],
      [config.getUpBtn(), config.goUp],
      [config.getUndoBtn(), config.performUndo],
      [config.getRedoBtn(), config.performRedo],
      [config.getRefreshBtn(), config.refresh],
      [config.getNewFileBtn(), () => config.createNewFile()],
      [config.getNewFolderBtn(), () => config.createNewFolder()],
      [config.getViewToggleBtn(), config.toggleView],
      [document.getElementById('empty-new-folder-btn'), () => config.createNewFolder()],
      [document.getElementById('empty-new-file-btn'), () => config.createNewFile()],
      [document.getElementById('select-all-btn'), config.selectAll],
      [document.getElementById('deselect-all-btn'), config.clearSelection],
      [config.getSelectionCopyBtn(), config.copyToClipboard],
      [config.getSelectionCutBtn(), config.cutToClipboard],
      [config.getSelectionMoveBtn(), config.moveSelectedToFolder],
      [config.getSelectionRenameBtn(), config.renameSelected],
      [config.getSelectionDeleteBtn(), () => config.deleteSelected()],
    ];
    clickBindings.forEach(([element, handler]) => element?.addEventListener('click', handler));

    const overflowBtn = document.getElementById('selection-overflow-btn');
    const overflowMenu = document.getElementById('selection-overflow-menu');
    if (overflowBtn && overflowMenu) {
      overflowBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = overflowMenu.style.display !== 'none';
        overflowMenu.style.display = open ? 'none' : 'block';
        overflowBtn.setAttribute('aria-expanded', String(!open));
      });
      overflowMenu.addEventListener('click', () => {
        overflowMenu.style.display = 'none';
        overflowBtn.setAttribute('aria-expanded', 'false');
      });
      document.addEventListener('click', (e) => {
        if (!overflowBtn.contains(e.target as Node) && !overflowMenu.contains(e.target as Node)) {
          overflowMenu.style.display = 'none';
          overflowBtn.setAttribute('aria-expanded', 'false');
        }
      });
    }

    const statusHiddenBtn = document.getElementById('status-hidden');
    const activateHiddenFiles = () => {
      const settings = config.getCurrentSettings();
      settings.showHiddenFiles = true;
      const showHiddenFilesToggle = document.getElementById(
        'show-hidden-files-toggle'
      ) as HTMLInputElement | null;
      if (showHiddenFilesToggle) {
        showHiddenFilesToggle.checked = true;
      }
      config.saveSettings();
      config.refresh();
    };
    statusHiddenBtn?.addEventListener('click', activateHiddenFiles);
    statusHiddenBtn?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateHiddenFiles();
      }
    });

    document.addEventListener('mouseup', (e) => {
      if (e.button === 3) {
        e.preventDefault();
        config.goBack();
      } else if (e.button === 4) {
        e.preventDefault();
        config.goForward();
      }
    });
  }

  function initNavigationListeners(): void {
    config.getSortBtn()?.addEventListener('click', (e) => config.showSortMenu(e as MouseEvent));
    config.getBookmarkAddBtn()?.addEventListener('click', config.addBookmark);
    document
      .getElementById('sidebar-toggle')
      ?.addEventListener('click', () => config.setSidebarCollapsed());
    config.syncSidebarToggleState();

    const addressInput = config.getAddressInput();
    addressInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const value = addressInput.value.trim();
        if (value === config.homeViewLabel) {
          config.navigateTo(config.homeViewPath);
        } else {
          config.navigateTo(value);
        }
      }
    });
  }

  function isModalOpen(): boolean {
    if (config.isQuickLookOpen()) return true;
    const modals = document.querySelectorAll('.modal-overlay');
    for (let i = 0; i < modals.length; i++) {
      const el = modals[i];
      if (el instanceof HTMLElement && el.style.display === 'flex') return true;
    }
    return false;
  }

  function isOverlayOpen(): boolean {
    if (isModalOpen()) return true;
    const overlayIds = ['sort-menu', 'context-menu', 'empty-space-context-menu'];
    for (const id of overlayIds) {
      const el = document.getElementById(id);
      if (el && el.style.display === 'block') return true;
    }
    if (config.isBreadcrumbMenuOpen()) return true;
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

  const shortcutActions: Record<string, () => void> = {
    'command-palette': () => config.showCommandPalette(),
    settings: () => config.showSettingsModal(),
    shortcuts: () => config.showShortcutsModal(),
    refresh: () => config.refresh(),
    search: () => config.openSearch(false),
    'global-search': () => config.openSearch(true),
    'toggle-sidebar': () => config.setSidebarCollapsed(),
    'new-window': () => config.openNewWindow(),
    'new-file': () => config.createNewFile(),
    'new-folder': () => config.createNewFolder(),
    'go-back': () => config.goBack(),
    'go-forward': () => config.goForward(),
    'go-up': () => config.goUp(),
    'go-home': () => config.goHome(),
    'new-tab': () => {
      if (config.getTabsEnabled()) config.addNewTab();
    },
    'close-tab': () => {
      if (config.getTabsEnabled() && config.getTabs().length > 1)
        config.closeTab(config.getActiveTabId());
    },
    copy: () => config.copyToClipboard(),
    cut: () => config.cutToClipboard(),
    paste: () => config.pasteFromClipboard(),
    'select-all': () => config.selectAll(),
    undo: () => config.performUndo(),
    redo: () => config.performRedo(),
    'zoom-in': () => config.zoomIn(),
    'zoom-out': () => config.zoomOut(),
    'zoom-reset': () => config.zoomReset(),
    'toggle-hidden-files': () => config.toggleHiddenFiles(),
    properties: () => config.showPropertiesForSelected(),
    'restore-closed-tab': () => {
      if (config.getTabsEnabled()) config.restoreClosedTab();
    },
    'focus-address-bar': () => focusAddressBar(),
    'toggle-preview-panel': () => config.togglePreviewPanel(),
  };

  function runShortcutAction(actionId: string, e: KeyboardEvent): boolean {
    if (actionId === 'copy' && hasTextSelection()) return false;
    if (actionId === 'cut' && hasTextSelection()) return false;
    if ((actionId === 'paste' || actionId === 'select-all') && isEditableElementActive())
      return false;

    if (actionId === 'next-tab' || actionId === 'prev-tab') {
      e.preventDefault();
      if (config.getTabsEnabled() && config.getTabs().length > 1) {
        const tabs = config.getTabs();
        const currentIndex = tabs.findIndex((t) => t.id === config.getActiveTabId());
        if (currentIndex !== -1) {
          const nextIndex =
            actionId === 'next-tab'
              ? (currentIndex + 1) % tabs.length
              : (currentIndex - 1 + tabs.length) % tabs.length;
          config.switchToTab(tabs[nextIndex].id);
        }
      }
      return true;
    }

    const handler = shortcutActions[actionId];
    if (handler) {
      e.preventDefault();
      handler();
      return true;
    }
    return false;
  }

  function initKeyboardListeners(): void {
    document.addEventListener('keydown', (e) => {
      if (config.isShortcutCaptureActive()) {
        return;
      }
      if (e.key === 'Escape') {
        const modalDismissals: [string, string, () => void][] = [
          ['extract-modal', 'flex', config.hideExtractModal],
          ['compress-options-modal', 'flex', config.hideCompressOptionsModal],
          ['settings-modal', 'flex', config.hideSettingsModal],
          ['shortcuts-modal', 'flex', config.hideShortcutsModal],
          ['licenses-modal', 'flex', config.hideLicensesModal],
          ['home-settings-modal', 'flex', () => config.closeHomeSettingsModal()],
          ['sort-menu', 'block', config.hideSortMenu],
          ['context-menu', 'block', config.hideContextMenu],
          ['empty-space-context-menu', 'block', config.hideEmptySpaceContextMenu],
        ];
        for (const [id, display, handler] of modalDismissals) {
          const el = document.getElementById(id);
          if (el?.style.display === display) {
            e.preventDefault();
            handler();
            return;
          }
        }

        if (config.isSearchModeActive()) config.closeSearch();
        if (config.isQuickLookOpen()) config.closeQuickLook();
        return;
      }

      if (config.handleContextMenuKeyNav(e)) return;
      if (config.handleSortMenuKeyNav(e)) return;

      if (isOverlayOpen()) {
        return;
      }

      if (e.key === 'F6') {
        e.preventDefault();
        cyclePaneFocus(e.shiftKey);
        return;
      }

      if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
        if (isEditableElementActive()) return;
        e.preventDefault();
        config.showContextMenuForSelected();
        return;
      }

      if (e.code === 'Space' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        if (isEditableElementActive()) return;
        e.preventDefault();
        config.toggleSelectionAtCursor();
        return;
      }

      if (e.code === 'Space' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        if (isEditableElementActive()) return;
        e.preventDefault();
        if (config.isQuickLookOpen()) {
          config.closeQuickLook();
        } else {
          config.showQuickLook();
        }
        return;
      }

      const fixedActionId = config.getFixedShortcutActionIdFromEvent(e);
      if (fixedActionId) {
        const handled = runShortcutAction(fixedActionId, e);
        if (handled) {
          return;
        }
      }

      const shortcutActionId = config.getShortcutActionIdFromEvent(e);
      if (shortcutActionId) {
        const handled = runShortcutAction(shortcutActionId, e);
        if (handled) {
          return;
        }
      }

      if (EDIT_GUARDED_KEYS.has(e.key) && isEditableElementActive()) return;

      if (e.key === 'Delete') {
        e.preventDefault();
        if (e.shiftKey) {
          config.deleteSelected(true);
        } else {
          config.deleteSelected();
        }
        return;
      }

      const simpleKeyActions: Record<string, () => void> = {
        Backspace: () => config.goUp(),
        F2: () => config.renameSelected(),
        Enter: () => config.openSelectedItem(),
        Home: () => config.selectFirstItem(e.shiftKey),
        End: () => config.selectLastItem(e.shiftKey),
        PageUp: () => config.navigateByPage('up', e.shiftKey),
        PageDown: () => config.navigateByPage('down', e.shiftKey),
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
        if (e.ctrlKey && !e.shiftKey) {
          config.navigateFileGridFocusOnly(e.key);
        } else {
          config.navigateFileGrid(e.key, e.shiftKey);
        }
      } else if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key.length === 1 &&
        !config.isSearchModeActive() &&
        config.getViewMode() !== 'column'
      ) {
        if (isEditableElementActive()) return;
        config.handleTypeaheadInput(e.key);
      }
    });
  }

  function focusAddressBar(): void {
    const addressInput = config.getAddressInput();
    if (!addressInput) return;
    const breadcrumbContainer = document.getElementById('breadcrumb-container');
    if (breadcrumbContainer && breadcrumbContainer.style.display !== 'none') {
      breadcrumbContainer.style.display = 'none';
      addressInput.style.display = 'block';
    }
    addressInput.focus();
    addressInput.select();
  }

  const PANE_ORDER = ['sidebar', 'address-bar', 'file-grid'] as const;

  function cyclePaneFocus(reverse: boolean): void {
    const activeEl = document.activeElement as HTMLElement | null;
    let currentPane = -1;

    if (activeEl) {
      if (activeEl.closest('#sidebar') || activeEl.closest('.sidebar')) currentPane = 0;
      else if (
        activeEl.closest('.address-bar') ||
        activeEl.id === 'address-input' ||
        activeEl.closest('#breadcrumb-container')
      )
        currentPane = 1;
      else if (
        activeEl.closest('#file-grid') ||
        activeEl.closest('#file-view') ||
        activeEl.classList.contains('file-item')
      )
        currentPane = 2;
    }

    const step = reverse ? -1 : 1;
    const startIndex =
      currentPane === -1 ? 0 : (currentPane + step + PANE_ORDER.length) % PANE_ORDER.length;

    for (let i = 0; i < PANE_ORDER.length; i++) {
      const idx = (startIndex + i * step + PANE_ORDER.length * 2) % PANE_ORDER.length;
      const pane = PANE_ORDER[idx];

      if (pane === 'sidebar') {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar || sidebar.classList.contains('collapsed')) continue;
        const treeItem = sidebar.querySelector<HTMLElement>('.tree-item[tabindex="0"]');
        if (treeItem) {
          treeItem.focus();
          return;
        }
        const firstFocusable = sidebar.querySelector<HTMLElement>('button, [tabindex="0"]');
        if (firstFocusable) {
          firstFocusable.focus();
          return;
        }
      } else if (pane === 'address-bar') {
        focusAddressBar();
        return;
      } else if (pane === 'file-grid') {
        config.focusFileGrid();
        return;
      }
    }
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
            config.changeSortMode(sortType);
          }
          return;
        }

        if (emptySpaceMenu && emptySpaceMenu.style.display === 'block') {
          config.handleEmptySpaceContextMenuAction(menuItem.dataset.action);
          config.hideEmptySpaceContextMenu();
          return;
        }

        const ctxData = config.getContextMenuData();
        if (ctxData) {
          config.handleContextMenuAction(menuItem.dataset.action, ctxData, menuItem.dataset.format);
          config.hideContextMenu();
          return;
        }
      }

      if (contextMenu && contextMenu.style.display === 'block' && !contextMenu.contains(target)) {
        config.hideContextMenu();
      }
      if (
        emptySpaceMenu &&
        emptySpaceMenu.style.display === 'block' &&
        !emptySpaceMenu.contains(target)
      ) {
        config.hideEmptySpaceContextMenu();
      }
      if (
        sortMenu &&
        sortMenu.style.display === 'block' &&
        !sortMenu.contains(target) &&
        target !== config.getSortBtn()
      ) {
        config.hideSortMenu();
      }

      const breadcrumbMenu = config.getBreadcrumbMenuElement();
      if (
        breadcrumbMenu &&
        config.isBreadcrumbMenuOpen() &&
        !breadcrumbMenu.contains(target) &&
        !target.closest('.breadcrumb-item')
      ) {
        config.hideBreadcrumbMenu();
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
        if (clickedOnFileView && config.getCurrentPath()) {
          config.showEmptySpaceContextMenu(e.pageX, e.pageY);
        } else {
          config.hideContextMenu();
          config.hideEmptySpaceContextMenu();
        }
      }
    });
  }

  function setupEventListeners() {
    initCoreUiInteractions();
    initSyncEventListeners();
    initWindowControlListeners();
    initActionButtonListeners();
    config.initSearchListeners();
    initNavigationListeners();
    initKeyboardListeners();
    initGlobalClickListeners();
    config.initDragAndDropListeners();
    const fileGrid = config.getFileGrid();
    if (fileGrid) {
      fileGrid.addEventListener('click', (e) => {
        if (e.target === fileGrid) config.clearSelection();
      });
    }
    initContextMenuListeners();
  }

  return {
    setupEventListeners,
    isModalOpen,
    isEditableElementActive,
    runShortcutAction,
  };
}
