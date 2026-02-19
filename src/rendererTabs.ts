import type { FileItem, Settings } from './types';
import { clearHtml } from './rendererDom.js';
import { escapeHtml } from './shared.js';
import { twemojiImg } from './rendererUtils.js';
import { TAB_SAVE_DELAY_MS } from './rendererLocalConstants.js';

export interface TabData {
  id: string;
  path: string;
  history: string[];
  historyIndex: number;
  selectedItems: Set<string>;
  scrollPosition: number;
  cachedFiles?: FileItem[];
}

type ViewMode = 'grid' | 'list' | 'column';

interface TabsDeps {
  getTabs: () => TabData[];
  setTabs: (tabs: TabData[]) => void;
  getActiveTabId: () => string;
  setActiveTabId: (id: string) => void;
  getTabsEnabled: () => boolean;
  setTabsEnabled: (enabled: boolean) => void;
  getTabNewButtonListenerAttached: () => boolean;
  setTabNewButtonListenerAttached: (attached: boolean) => void;
  getTabCacheAccessOrder: () => string[];
  setTabCacheAccessOrder: (order: string[]) => void;
  getSaveTabStateTimeout: () => ReturnType<typeof setTimeout> | null;
  setSaveTabStateTimeout: (timeout: ReturnType<typeof setTimeout> | null) => void;

  getCurrentSettings: () => Settings;
  getCurrentPath: () => string;
  setCurrentPath: (path: string) => void;
  getHistory: () => string[];
  setHistory: (history: string[]) => void;
  getHistoryIndex: () => number;
  setHistoryIndex: (index: number) => void;
  getSelectedItems: () => Set<string>;
  setSelectedItems: (items: Set<string>) => void;
  getAllFiles: () => FileItem[];
  setAllFiles: (files: FileItem[]) => void;
  getFileViewScrollTop: () => number;
  setFileViewScrollTop: (value: number) => void;

  getAddressInput: () => HTMLInputElement | null;
  getPathDisplayValue: (path: string) => string;
  isHomeViewPath: (path: string) => boolean;
  homeViewLabel: string;
  homeViewPath: string;
  getViewMode: () => ViewMode;

  renderFiles: (files: FileItem[]) => void;
  renderColumnView: () => void;
  updateBreadcrumb: (path: string) => void;
  updateNavigationButtons: () => void;
  setHomeViewActive: (active: boolean) => void;
  navigateTo: (path: string, force?: boolean) => void;

  debouncedSaveSettings: () => void;
  saveSettingsWithTimestamp: (settings: Settings) => Promise<unknown>;

  maxCachedTabs: number;
  maxCachedFilesPerTab: number;
}

export function createTabsController(deps: TabsDeps) {
  const MAX_CACHED_TABS = deps.maxCachedTabs;
  const MAX_CACHED_FILES_PER_TAB = deps.maxCachedFilesPerTab;
  const MAX_CLOSED_TABS = 10;
  const closedTabPaths: string[] = [];
  let activeDismissHandler: ((e: MouseEvent) => void) | null = null;

  function generateTabId(): string {
    return `tab-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  function evictOldestTabCache() {
    const tabCacheAccessOrder = deps.getTabCacheAccessOrder();
    if (tabCacheAccessOrder.length <= MAX_CACHED_TABS) return;

    const tabsToEvict = tabCacheAccessOrder.slice(0, tabCacheAccessOrder.length - MAX_CACHED_TABS);
    const tabs = deps.getTabs();
    for (const tabId of tabsToEvict) {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab && tab.cachedFiles) {
        delete tab.cachedFiles;
      }
    }
    deps.setTabCacheAccessOrder(tabCacheAccessOrder.slice(-MAX_CACHED_TABS));
  }

  function updateTabCacheAccess(tabId: string) {
    const nextOrder = deps.getTabCacheAccessOrder().filter((id) => id !== tabId);
    nextOrder.push(tabId);
    deps.setTabCacheAccessOrder(nextOrder);
    evictOldestTabCache();
  }

  function initializeTabs() {
    const settings = deps.getCurrentSettings();
    if (settings.enableTabs === false) {
      deps.setTabsEnabled(false);
      document.body.classList.remove('tabs-enabled');
      document.body.classList.remove('tabs-single');
      const tabBar = document.getElementById('tab-bar');
      if (tabBar) tabBar.style.display = 'none';
      return;
    }

    deps.setTabsEnabled(true);
    document.body.classList.add('tabs-enabled');
    const tabBar = document.getElementById('tab-bar');
    if (tabBar) tabBar.style.removeProperty('display');

    const tabState = settings.tabState;
    if (tabState && tabState.tabs.length > 0) {
      const tabs = tabState.tabs.map((t) => ({
        ...t,
        selectedItems: new Set(t.selectedItems || []),
      }));
      deps.setTabs(tabs);
      deps.setActiveTabId(tabState.activeTabId);

      const activeTab = tabs.find((t) => t.id === tabState.activeTabId);
      if (activeTab) {
        deps.setHistory([...activeTab.history]);
        deps.setHistoryIndex(activeTab.historyIndex);
        deps.setSelectedItems(new Set(activeTab.selectedItems));
      }
    } else {
      const initialTab = createNewTabData(deps.getCurrentPath() || '');
      deps.setTabs([initialTab]);
      deps.setActiveTabId(initialTab.id);
    }

    renderTabs();

    if (!deps.getTabNewButtonListenerAttached()) {
      const newTabBtn = document.getElementById('new-tab-btn');
      if (newTabBtn) {
        newTabBtn.addEventListener('click', () => {
          addNewTab();
        });
      }

      const toolbarNewTabBtn = document.getElementById('toolbar-new-tab-btn');
      if (toolbarNewTabBtn) {
        toolbarNewTabBtn.addEventListener('click', () => {
          addNewTab();
        });
      }

      deps.setTabNewButtonListenerAttached(true);
    }
  }

  function createNewTabData(path: string): TabData {
    return {
      id: generateTabId(),
      path: path,
      history: path ? [path] : [],
      historyIndex: path ? 0 : -1,
      selectedItems: new Set(),
      scrollPosition: 0,
    };
  }

  function updateTabBarVisibility() {
    if (!deps.getTabsEnabled()) return;
    const tabs = deps.getTabs();
    if (tabs.length <= 1) {
      document.body.classList.add('tabs-single');
    } else {
      document.body.classList.remove('tabs-single');
    }
  }

  function renderTabs() {
    const tabList = document.getElementById('tab-list');
    if (!deps.getTabsEnabled()) return;

    updateTabBarVisibility();

    if (!tabList) return;

    clearHtml(tabList);

    const tabs = deps.getTabs();
    const activeTabId = deps.getActiveTabId();

    tabs.forEach((tab) => {
      const tabElement = document.createElement('div');
      const isActive = tab.id === activeTabId;
      tabElement.className = `tab-item${isActive ? ' active' : ''}`;
      tabElement.dataset.tabId = tab.id;
      tabElement.setAttribute('role', 'tab');
      tabElement.setAttribute('aria-selected', String(isActive));
      tabElement.setAttribute('aria-controls', 'file-view');
      tabElement.tabIndex = isActive ? 0 : -1;

      const isHomeTab = deps.isHomeViewPath(tab.path);
      const pathParts = tab.path.split(/[/\\]/);
      const folderName = isHomeTab
        ? deps.homeViewLabel
        : pathParts[pathParts.length - 1] || tab.path || 'New Tab';
      const tabTitle = isHomeTab ? deps.homeViewLabel : tab.path;
      const tabIcon = isHomeTab
        ? twemojiImg(String.fromCodePoint(0x1f3e0), 'twemoji')
        : '<img src="../assets/twemoji/1f4c2.svg" class="twemoji" alt="📂" draggable="false" />';

      tabElement.innerHTML = `
      <span class="tab-icon">
        ${tabIcon}
      </span>
      <span class="tab-title" title="${escapeHtml(tabTitle)}">${escapeHtml(folderName)}</span>
      <button class="tab-close" title="Close Tab" aria-label="Close tab">&times;</button>
    `;

      tabElement.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('tab-close')) {
          e.stopPropagation();
          closeTab(tab.id);
        } else {
          switchToTab(tab.id);
        }
      });

      tabElement.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          switchToTab(tab.id);
          return;
        }
        if (
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight' ||
          e.key === 'Home' ||
          e.key === 'End'
        ) {
          e.preventDefault();
          const tabItems = Array.from(tabList.querySelectorAll<HTMLElement>('.tab-item'));
          if (tabItems.length === 0) return;
          const currentIndex = tabItems.indexOf(tabElement);
          if (currentIndex === -1) return;
          let nextIndex = currentIndex;
          if (e.key === 'ArrowLeft') {
            nextIndex = (currentIndex - 1 + tabItems.length) % tabItems.length;
          } else if (e.key === 'ArrowRight') {
            nextIndex = (currentIndex + 1) % tabItems.length;
          } else if (e.key === 'Home') {
            nextIndex = 0;
          } else if (e.key === 'End') {
            nextIndex = tabItems.length - 1;
          }
          tabItems[nextIndex]?.focus();
        }
      });

      tabElement.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(tab.id);
        }
      });

      tabElement.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTabContextMenu(e.clientX, e.clientY, tab.id);
      });

      tabList.appendChild(tabElement);
    });
  }

  function snapshotCurrentTab() {
    const tabs = deps.getTabs();
    const currentTab = tabs.find((t) => t.id === deps.getActiveTabId());
    if (!currentTab) return;
    currentTab.path = deps.getCurrentPath();
    currentTab.history = [...deps.getHistory()];
    currentTab.historyIndex = deps.getHistoryIndex();
    currentTab.selectedItems = new Set(deps.getSelectedItems());
    currentTab.scrollPosition = deps.getFileViewScrollTop();
    if (deps.getAllFiles().length <= MAX_CACHED_FILES_PER_TAB) {
      currentTab.cachedFiles = [...deps.getAllFiles()];
      updateTabCacheAccess(currentTab.id);
    }
  }

  function switchToTab(tabId: string) {
    if (deps.getActiveTabId() === tabId || !deps.getTabsEnabled()) return;

    snapshotCurrentTab();

    const tabs = deps.getTabs();
    deps.setActiveTabId(tabId);
    const newTab = tabs.find((t) => t.id === tabId);
    if (newTab) {
      deps.setHistory([...newTab.history]);
      deps.setHistoryIndex(newTab.historyIndex);
      deps.setSelectedItems(new Set(newTab.selectedItems));

      if (newTab.path) {
        if (newTab.cachedFiles !== undefined) {
          restoreTabView(newTab);
          updateTabCacheAccess(newTab.id);
        } else {
          deps.navigateTo(newTab.path, true);
        }
      }

      setTimeout(() => {
        deps.setFileViewScrollTop(newTab.scrollPosition);
      }, 50);
    }

    renderTabs();
    debouncedSaveTabState();
  }

  function restoreTabView(tab: TabData) {
    deps.setCurrentPath(tab.path);
    const addressInput = deps.getAddressInput();
    if (addressInput) addressInput.value = deps.getPathDisplayValue(tab.path);
    deps.updateBreadcrumb(tab.path);
    deps.updateNavigationButtons();

    if (deps.isHomeViewPath(tab.path)) {
      deps.setHomeViewActive(true);
      return;
    }

    deps.setHomeViewActive(false);

    if (deps.getViewMode() === 'column') {
      deps.renderColumnView();
    } else {
      deps.renderFiles(tab.cachedFiles || []);
    }
  }

  function debouncedSaveTabState() {
    const existing = deps.getSaveTabStateTimeout();
    if (existing) {
      clearTimeout(existing);
    }
    const timeout = setTimeout(() => {
      saveTabState();
    }, TAB_SAVE_DELAY_MS);
    deps.setSaveTabStateTimeout(timeout);
  }

  async function addNewTab(path?: string) {
    if (!deps.getTabsEnabled()) return;

    snapshotCurrentTab();

    const tabs = deps.getTabs();
    let tabPath = path;
    if (!tabPath) {
      const settings = deps.getCurrentSettings();
      tabPath =
        settings.startupPath && settings.startupPath.trim() !== ''
          ? settings.startupPath
          : deps.homeViewPath;
    }

    const newTab = createNewTabData(tabPath);
    tabs.push(newTab);
    deps.setActiveTabId(newTab.id);

    deps.setHistory([tabPath]);
    deps.setHistoryIndex(0);
    deps.setSelectedItems(new Set());

    deps.navigateTo(tabPath, true);

    renderTabs();
    debouncedSaveTabState();
  }

  function closeTab(tabId: string) {
    if (!deps.getTabsEnabled()) return;
    const tabs = deps.getTabs();
    if (tabs.length <= 1) return;

    const tabIndex = tabs.findIndex((t) => t.id === tabId);
    if (tabIndex === -1) return;

    const closingTab = tabs[tabIndex];
    if (closingTab.path) {
      closedTabPaths.push(closingTab.path);
      if (closedTabPaths.length > MAX_CLOSED_TABS) {
        closedTabPaths.shift();
      }
    }

    tabs.splice(tabIndex, 1);

    if (deps.getActiveTabId() === tabId) {
      const newIndex = Math.min(tabIndex, tabs.length - 1);
      const nextTab = tabs[newIndex];
      deps.setActiveTabId(nextTab.id);

      deps.setHistory([...nextTab.history]);
      deps.setHistoryIndex(nextTab.historyIndex);
      deps.setSelectedItems(new Set(nextTab.selectedItems));

      if (nextTab.path) {
        if (nextTab.cachedFiles !== undefined) {
          restoreTabView(nextTab);
        } else {
          deps.navigateTo(nextTab.path, true);
        }
      }
    }

    renderTabs();
    debouncedSaveTabState();
  }

  function saveTabState(immediate = false): Promise<unknown> | void {
    if (!deps.getTabsEnabled()) return;
    const settings = deps.getCurrentSettings();
    const tabs = deps.getTabs();

    settings.tabState = {
      tabs: tabs.map((t) => ({
        id: t.id,
        path: t.path,
        history: t.history,
        historyIndex: t.historyIndex,
        selectedItems: Array.from(t.selectedItems),
        scrollPosition: t.scrollPosition,
      })),
      activeTabId: deps.getActiveTabId(),
    };
    if (immediate) {
      return deps.saveSettingsWithTimestamp(settings);
    }
    deps.debouncedSaveSettings();
  }

  function updateCurrentTabPath(newPath: string) {
    if (!deps.getTabsEnabled()) return;
    const tabs = deps.getTabs();
    const currentTab = tabs.find((t) => t.id === deps.getActiveTabId());
    if (currentTab) {
      currentTab.path = newPath;
      renderTabs();
      saveTabState();
    }
  }

  function closeOtherTabs(tabId: string): void {
    if (!deps.getTabsEnabled()) return;
    const tabs = deps.getTabs();
    const keepTab = tabs.find((t) => t.id === tabId);
    if (!keepTab) return;

    const closingTabs = tabs.filter((t) => t.id !== tabId);
    for (const t of closingTabs) {
      if (t.path) {
        closedTabPaths.push(t.path);
        if (closedTabPaths.length > MAX_CLOSED_TABS) closedTabPaths.shift();
      }
    }

    deps.setTabs([keepTab]);
    if (deps.getActiveTabId() !== tabId) {
      deps.setActiveTabId(tabId);
      deps.setHistory([...keepTab.history]);
      deps.setHistoryIndex(keepTab.historyIndex);
      deps.setSelectedItems(new Set(keepTab.selectedItems));
      if (keepTab.cachedFiles !== undefined) {
        restoreTabView(keepTab);
      } else {
        deps.navigateTo(keepTab.path, true);
      }
    }
    renderTabs();
    debouncedSaveTabState();
  }

  function closeTabsToTheRight(tabId: string): void {
    if (!deps.getTabsEnabled()) return;
    const tabs = deps.getTabs();
    const tabIndex = tabs.findIndex((t) => t.id === tabId);
    if (tabIndex === -1 || tabIndex >= tabs.length - 1) return;

    const closingTabs = tabs.slice(tabIndex + 1);
    for (const t of closingTabs) {
      if (t.path) {
        closedTabPaths.push(t.path);
        if (closedTabPaths.length > MAX_CLOSED_TABS) closedTabPaths.shift();
      }
    }

    tabs.length = tabIndex + 1;

    const activeTabId = deps.getActiveTabId();
    if (!tabs.some((t) => t.id === activeTabId)) {
      const lastTab = tabs[tabs.length - 1];
      deps.setActiveTabId(lastTab.id);
      deps.setHistory([...lastTab.history]);
      deps.setHistoryIndex(lastTab.historyIndex);
      deps.setSelectedItems(new Set(lastTab.selectedItems));
      if (lastTab.cachedFiles !== undefined) {
        restoreTabView(lastTab);
      } else {
        deps.navigateTo(lastTab.path, true);
      }
    }
    renderTabs();
    debouncedSaveTabState();
  }

  function duplicateTab(tabId: string): void {
    if (!deps.getTabsEnabled()) return;
    const tabs = deps.getTabs();
    const sourceTab = tabs.find((t) => t.id === tabId);
    if (!sourceTab) return;
    void addNewTab(sourceTab.path);
  }

  function showTabContextMenu(x: number, y: number, tabId: string): void {
    hideTabContextMenu();
    const tabs = deps.getTabs();
    const tabIndex = tabs.findIndex((t) => t.id === tabId);

    const menu = document.createElement('div');
    menu.className = 'tab-context-menu';
    menu.setAttribute('role', 'menu');
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const items: Array<{ label: string; action: () => void; disabled?: boolean }> = [
      { label: 'Close Tab', action: () => closeTab(tabId), disabled: tabs.length <= 1 },
      {
        label: 'Close Other Tabs',
        action: () => closeOtherTabs(tabId),
        disabled: tabs.length <= 1,
      },
      {
        label: 'Close Tabs to the Right',
        action: () => closeTabsToTheRight(tabId),
        disabled: tabIndex >= tabs.length - 1,
      },
      { label: 'Duplicate Tab', action: () => duplicateTab(tabId) },
    ];

    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'tab-context-menu-item' + (item.disabled ? ' disabled' : '');
      el.setAttribute('role', 'menuitem');
      el.textContent = item.label;
      if (item.disabled) {
        el.setAttribute('aria-disabled', 'true');
      } else {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          hideTabContextMenu();
          item.action();
        });
      }
      menu.appendChild(el);
    }

    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 4}px`;
    }

    const enabledItems = Array.from(
      menu.querySelectorAll('.tab-context-menu-item:not(.disabled)')
    ) as HTMLElement[];
    if (enabledItems.length > 0) {
      enabledItems[0].setAttribute('tabindex', '0');
      enabledItems[0].focus();
      for (let i = 1; i < enabledItems.length; i++) {
        enabledItems[i].setAttribute('tabindex', '-1');
      }
    }

    menu.addEventListener('keydown', (e: KeyboardEvent) => {
      const focused = document.activeElement as HTMLElement | null;
      const idx = focused ? enabledItems.indexOf(focused) : -1;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = idx < enabledItems.length - 1 ? idx + 1 : 0;
        enabledItems[next]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = idx > 0 ? idx - 1 : enabledItems.length - 1;
        enabledItems[prev]?.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        focused?.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideTabContextMenu();
      }
    });

    activeDismissHandler = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        hideTabContextMenu();
      }
    };
    setTimeout(
      () => document.addEventListener('mousedown', activeDismissHandler!, { once: true }),
      0
    );
  }

  function hideTabContextMenu(): void {
    if (activeDismissHandler) {
      document.removeEventListener('mousedown', activeDismissHandler);
      activeDismissHandler = null;
    }
    document.querySelectorAll('.tab-context-menu').forEach((el) => el.remove());
  }

  function restoreClosedTab(): void {
    if (!deps.getTabsEnabled() || closedTabPaths.length === 0) return;
    const path = closedTabPaths.pop()!;
    void addNewTab(path);
  }

  function cleanup(): void {
    const timeout = deps.getSaveTabStateTimeout();
    if (timeout) {
      clearTimeout(timeout);
      deps.setSaveTabStateTimeout(null);
    }
  }

  return {
    initializeTabs,
    addNewTab,
    closeTab,
    restoreClosedTab,
    saveTabState,
    updateCurrentTabPath,
    switchToTab,
    cleanup,
  };
}
