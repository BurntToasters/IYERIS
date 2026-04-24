// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Settings } from '../types';

vi.mock('../rendererDom.js', () => ({ clearHtml: vi.fn() }));
vi.mock('../shared.js', () => ({ escapeHtml: (s: string) => s, ignoreError: () => {} }));
vi.mock('../rendererUtils.js', () => ({ twemojiImg: () => '<img />' }));

import { createTabsController, type TabData } from '../rendererTabs';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    enableTabs: true,
    startupPath: '',
    tabState: undefined,
    ...overrides,
  } as Settings;
}

function createMockDeps() {
  let tabs: TabData[] = [];
  let activeTabId = '';
  let tabsEnabled = false;
  let newBtnAttached = false;
  let cacheAccessOrder: string[] = [];
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;
  let currentPath = '/home/test';
  let history = ['/home/test'];
  let historyIndex = 0;
  let selectedItems = new Set<string>();
  let allFiles: any[] = [];
  let scrollTop = 0;
  const settings = makeSettings();

  return {
    getTabs: () => tabs,
    setTabs: (t: TabData[]) => {
      tabs = t;
    },
    getActiveTabId: () => activeTabId,
    setActiveTabId: (id: string) => {
      activeTabId = id;
    },
    getTabsEnabled: () => tabsEnabled,
    setTabsEnabled: (v: boolean) => {
      tabsEnabled = v;
    },
    getTabNewButtonListenerAttached: () => newBtnAttached,
    setTabNewButtonListenerAttached: (v: boolean) => {
      newBtnAttached = v;
    },
    getTabCacheAccessOrder: () => cacheAccessOrder,
    setTabCacheAccessOrder: (o: string[]) => {
      cacheAccessOrder = o;
    },
    getSaveTabStateTimeout: () => saveTimeout,
    setSaveTabStateTimeout: (t: ReturnType<typeof setTimeout> | null) => {
      saveTimeout = t;
    },
    getCurrentSettings: () => settings,
    getCurrentPath: () => currentPath,
    setCurrentPath: (p: string) => {
      currentPath = p;
    },
    getHistory: () => history,
    setHistory: (h: string[]) => {
      history = h;
    },
    getHistoryIndex: () => historyIndex,
    setHistoryIndex: (i: number) => {
      historyIndex = i;
    },
    getSelectedItems: () => selectedItems,
    setSelectedItems: (s: Set<string>) => {
      selectedItems = s;
    },
    getAllFiles: () => allFiles,
    setAllFiles: (f: any[]) => {
      allFiles = f;
    },
    getFileViewScrollTop: () => scrollTop,
    setFileViewScrollTop: (v: number) => {
      scrollTop = v;
    },
    getAddressInput: () => document.createElement('input') as HTMLInputElement,
    getPathDisplayValue: (p: string) => p,
    isHomeViewPath: (p: string) => p === '~~HOME~~',
    homeViewLabel: 'Home',
    homeViewPath: '~~HOME~~',
    getViewMode: () => 'grid' as const,
    renderFiles: vi.fn(),
    renderColumnView: vi.fn(),
    updateBreadcrumb: vi.fn(),
    updateNavigationButtons: vi.fn(),
    setHomeViewActive: vi.fn(),
    navigateTo: vi.fn(),
    watchDirectory: vi.fn(),
    debouncedSaveSettings: vi.fn(),
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue(undefined),
    maxCachedTabs: 5,
    maxCachedFilesPerTab: 500,
    isMainWindow: true,
    _settings: settings,
    _getTabs: () => tabs,
    _getActiveTabId: () => activeTabId,
  };
}

describe('createTabsController', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="tab-bar"><div id="tab-list"></div><button id="new-tab-btn"></button></div>
    `;
    (window as any).tauriAPI = {
      getItemProperties: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  describe('initializeTabs', () => {
    it('disables tabs when enableTabs is false', () => {
      const deps = createMockDeps();
      deps._settings.enableTabs = false;
      const ctrl = createTabsController(deps);

      ctrl.initializeTabs();

      expect(deps.getTabsEnabled()).toBe(false);
      expect(document.body.classList.contains('tabs-enabled')).toBe(false);
    });

    it('enables tabs and creates initial tab', () => {
      const deps = createMockDeps();
      deps._settings.enableTabs = true;
      const ctrl = createTabsController(deps);

      ctrl.initializeTabs();

      expect(deps.getTabsEnabled()).toBe(true);
      expect(document.body.classList.contains('tabs-enabled')).toBe(true);
      expect(deps._getTabs().length).toBe(1);
    });

    it('restores tabs from settings tabState', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-1',
            path: '/usr',
            history: ['/usr'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
          {
            id: 'tab-2',
            path: '/tmp',
            history: ['/tmp'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 100,
          },
        ],
        activeTabId: 'tab-2',
      };
      const ctrl = createTabsController(deps);

      ctrl.initializeTabs();

      expect(deps._getTabs().length).toBe(2);
      expect(deps._getActiveTabId()).toBe('tab-2');
    });
  });

  describe('addNewTab', () => {
    it('adds a new tab and navigates to it', async () => {
      const deps = createMockDeps();
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const initialCount = deps._getTabs().length;
      await ctrl.addNewTab('/new/path');

      expect(deps._getTabs().length).toBe(initialCount + 1);
      expect(deps.navigateTo).toHaveBeenCalledWith('/new/path', true);
    });

    it('uses startupPath when no path provided', async () => {
      const deps = createMockDeps();
      deps._settings.startupPath = '/startup';
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      await ctrl.addNewTab();

      expect(deps.navigateTo).toHaveBeenCalledWith('/startup', true);
    });

    it('uses homeViewPath when no path and no startupPath', async () => {
      const deps = createMockDeps();
      deps._settings.startupPath = '';
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      await ctrl.addNewTab();

      expect(deps.navigateTo).toHaveBeenCalledWith('~~HOME~~', true);
    });

    it('does nothing when tabs disabled', async () => {
      const deps = createMockDeps();
      deps._settings.enableTabs = false;
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      await ctrl.addNewTab('/test');
      expect(deps.navigateTo).not.toHaveBeenCalled();
    });
  });

  describe('closeTab', () => {
    it('removes tab from list', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-a',
            path: '/a',
            history: ['/a'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
          {
            id: 'tab-b',
            path: '/b',
            history: ['/b'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-a',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      ctrl.closeTab('tab-b');

      expect(deps._getTabs().length).toBe(1);
      expect(deps._getTabs()[0]!.id).toBe('tab-a');
    });

    it('does not close the last remaining tab', () => {
      const deps = createMockDeps();
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabId = deps._getTabs()[0]!.id;
      ctrl.closeTab(tabId);

      expect(deps._getTabs().length).toBe(1);
    });

    it('switches to next tab when closing active tab', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-1',
            path: '/one',
            history: ['/one'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
          {
            id: 'tab-2',
            path: '/two',
            history: ['/two'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
          {
            id: 'tab-3',
            path: '/three',
            history: ['/three'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-2',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      ctrl.closeTab('tab-2');

      expect(deps._getTabs().length).toBe(2);
      expect(deps._getActiveTabId()).not.toBe('tab-2');
    });

    it('does nothing when tabs disabled', () => {
      const deps = createMockDeps();
      deps._settings.enableTabs = false;
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      ctrl.closeTab('any-id');
      expect(deps.navigateTo).not.toHaveBeenCalled();
    });
  });

  describe('switchToTab', () => {
    it('switches active tab and restores state', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-a',
            path: '/a',
            history: ['/a'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
          {
            id: 'tab-b',
            path: '/b',
            history: ['/b'],
            historyIndex: 0,
            selectedItems: ['file1'],
            scrollPosition: 50,
          },
        ],
        activeTabId: 'tab-a',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      ctrl.switchToTab('tab-b');

      expect(deps._getActiveTabId()).toBe('tab-b');
      expect(deps.navigateTo).toHaveBeenCalledWith('/b', true);
    });

    it('does nothing when switching to already active tab', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-x',
            path: '/x',
            history: ['/x'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-x',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      ctrl.switchToTab('tab-x');
      expect(deps.navigateTo).not.toHaveBeenCalled();
    });

    it('restores cached files instead of navigating', async () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-1',
            path: '/one',
            history: ['/one'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
          {
            id: 'tab-2',
            path: '/two',
            history: ['/two'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-1',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabs = deps._getTabs();
      const tab2 = tabs.find((t) => t.id === 'tab-2')!;
      tab2.cachedFiles = [{ name: 'cached.txt' } as any];

      ctrl.switchToTab('tab-2');
      await vi.waitFor(() => {
        expect(deps.renderFiles).toHaveBeenCalled();
      });

      expect(deps.navigateTo).not.toHaveBeenCalled();
    });

    it('closes search and resets typeahead when search mode is active', () => {
      const deps = createMockDeps() as any;
      deps.isSearchModeActive = vi.fn(() => true);
      deps.closeSearch = vi.fn();
      deps.resetTypeahead = vi.fn();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-a',
            path: '/a',
            history: ['/a'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
          {
            id: 'tab-b',
            path: '/b',
            history: ['/b'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-a',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      ctrl.switchToTab('tab-b');

      expect(deps.closeSearch).toHaveBeenCalledWith({ restoreCurrentPath: false });
      expect(deps.resetTypeahead).toHaveBeenCalled();
    });

    it('falls back to navigate when cached tab validation fails', async () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-a',
            path: '/a',
            history: ['/a'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
          {
            id: 'tab-b',
            path: '/missing',
            history: ['/missing'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-a',
      };
      (window as any).tauriAPI.getItemProperties = vi.fn().mockResolvedValue({ success: false });

      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();
      const cachedTab = deps._getTabs().find((t) => t.id === 'tab-b')!;
      cachedTab.cachedFiles = [{ name: 'cached.txt' } as any];

      ctrl.switchToTab('tab-b');

      await vi.waitFor(() => {
        expect(deps.navigateTo).toHaveBeenCalledWith('/missing', true);
      });
      expect(cachedTab.cachedFiles).toBeUndefined();
    });

    it('falls back to navigate when cached tab validation throws', async () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-a',
            path: '/a',
            history: ['/a'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
          {
            id: 'tab-b',
            path: '/broken',
            history: ['/broken'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-a',
      };
      (window as any).tauriAPI.getItemProperties = vi.fn().mockRejectedValue(new Error('boom'));

      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();
      const cachedTab = deps._getTabs().find((t) => t.id === 'tab-b')!;
      cachedTab.cachedFiles = [{ name: 'cached.txt' } as any];

      ctrl.switchToTab('tab-b');

      await vi.waitFor(() => {
        expect(deps.navigateTo).toHaveBeenCalledWith('/broken', true);
      });
      expect(cachedTab.cachedFiles).toBeUndefined();
    });

    it('restores home tab from cache without watching directory', async () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-a',
            path: '/a',
            history: ['/a'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
          {
            id: 'tab-home',
            path: '~~HOME~~',
            history: ['~~HOME~~'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-a',
      };
      (window as any).tauriAPI.getItemProperties = vi.fn().mockResolvedValue({ success: true });

      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();
      const homeTab = deps._getTabs().find((t) => t.id === 'tab-home')!;
      homeTab.cachedFiles = [{ name: 'cached-home.txt' } as any];

      ctrl.switchToTab('tab-home');

      await vi.waitFor(() => {
        expect(deps.setHomeViewActive).toHaveBeenCalledWith(true);
      });
      expect(deps.watchDirectory).not.toHaveBeenCalled();
      expect(deps.renderFiles).not.toHaveBeenCalled();
    });

    it('restores cached tab in column mode and updates git info', async () => {
      const deps = createMockDeps() as any;
      deps.getViewMode = () => 'column';
      deps.fetchGitStatusAsync = vi.fn();
      deps.updateGitBranch = vi.fn();
      deps._settings.enableGitStatus = true;
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-a',
            path: '/a',
            history: ['/a'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
          {
            id: 'tab-col',
            path: '/repo',
            history: ['/repo'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-a',
      };
      (window as any).tauriAPI.getItemProperties = vi.fn().mockResolvedValue({ success: true });

      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();
      const colTab = deps._getTabs().find((t: TabData) => t.id === 'tab-col')!;
      colTab.cachedFiles = [{ name: 'cached.txt' } as any];

      ctrl.switchToTab('tab-col');

      await vi.waitFor(() => {
        expect(deps.renderColumnView).toHaveBeenCalled();
      });
      expect(deps.fetchGitStatusAsync).toHaveBeenCalledWith('/repo');
      expect(deps.updateGitBranch).toHaveBeenCalledWith('/repo');
    });
  });

  describe('tab list interactions and context menu', () => {
    function setupTabsForMenu(activeTabId = 'tab-1') {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-1',
            path: '/one',
            history: ['/one'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 10,
          },
          {
            id: 'tab-2',
            path: '/two',
            history: ['/two'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 20,
          },
          {
            id: 'tab-3',
            path: '/three',
            history: ['/three'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 30,
          },
        ],
        activeTabId,
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();
      return { deps, ctrl };
    }

    function openTabContextMenu(tabId: string, x = 40, y = 60) {
      const target = document.querySelector(`[data-tab-id="${tabId}"]`) as HTMLElement;
      expect(target).toBeTruthy();
      target.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        })
      );
      const menu = document.querySelector('.tab-context-menu') as HTMLElement | null;
      expect(menu).toBeTruthy();
      return menu!;
    }

    it('handles keyboard navigation among tabs and enter selection', () => {
      const { deps } = setupTabsForMenu('tab-1');
      const tab1 = document.querySelector('[data-tab-id="tab-1"]') as HTMLElement;
      const tab2 = document.querySelector('[data-tab-id="tab-2"]') as HTMLElement;
      const tab3 = document.querySelector('[data-tab-id="tab-3"]') as HTMLElement;

      tab1.focus();
      tab1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      expect(document.activeElement).toBe(tab2);

      tab2.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      expect(document.activeElement).toBe(tab3);

      tab3.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      expect(document.activeElement).toBe(tab1);

      tab2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(deps._getActiveTabId()).toBe('tab-2');
    });

    it('handles middle click close via auxclick', () => {
      const { deps } = setupTabsForMenu('tab-1');
      const tab2 = document.querySelector('[data-tab-id="tab-2"]') as HTMLElement;
      tab2.dispatchEvent(
        new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })
      );
      expect(deps._getTabs().some((t) => t.id === 'tab-2')).toBe(false);
    });

    it('executes Close Other Tabs action from tab context menu', () => {
      const { deps } = setupTabsForMenu('tab-1');
      openTabContextMenu('tab-2');

      const closeOthers = Array.from(document.querySelectorAll('.tab-context-menu-item')).find(
        (el) => el.textContent === 'Close Other Tabs'
      ) as HTMLElement;
      expect(closeOthers).toBeTruthy();
      closeOthers.click();

      expect(deps._getTabs().map((t) => t.id)).toEqual(['tab-2']);
      expect(deps._getActiveTabId()).toBe('tab-2');
    });

    it('executes Close Tabs to the Right and rehomes active tab when needed', () => {
      const { deps } = setupTabsForMenu('tab-3');
      openTabContextMenu('tab-2');

      const closeRight = Array.from(document.querySelectorAll('.tab-context-menu-item')).find(
        (el) => el.textContent === 'Close Tabs to the Right'
      ) as HTMLElement;
      expect(closeRight).toBeTruthy();
      closeRight.click();

      expect(deps._getTabs().map((t) => t.id)).toEqual(['tab-1', 'tab-2']);
      expect(deps._getActiveTabId()).toBe('tab-2');
    });

    it('duplicates tab from context menu', async () => {
      const { deps } = setupTabsForMenu('tab-1');
      openTabContextMenu('tab-1');

      const duplicate = Array.from(document.querySelectorAll('.tab-context-menu-item')).find(
        (el) => el.textContent === 'Duplicate Tab'
      ) as HTMLElement;
      expect(duplicate).toBeTruthy();
      duplicate.click();

      await vi.waitFor(() => {
        expect(deps._getTabs().length).toBe(4);
      });
      expect(deps.navigateTo).toHaveBeenCalledWith('/one', true);
    });

    it('marks close actions disabled when only one tab exists', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'solo',
            path: '/solo',
            history: ['/solo'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'solo',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      openTabContextMenu('solo');

      const closeTabItem = Array.from(document.querySelectorAll('.tab-context-menu-item')).find(
        (el) => el.textContent === 'Close Tab'
      ) as HTMLElement;
      const closeOthersItem = Array.from(document.querySelectorAll('.tab-context-menu-item')).find(
        (el) => el.textContent === 'Close Other Tabs'
      ) as HTMLElement;
      expect(closeTabItem.getAttribute('aria-disabled')).toBe('true');
      expect(closeOthersItem.getAttribute('aria-disabled')).toBe('true');
    });

    it('supports keyboard dismiss and outside-click dismiss for context menu', async () => {
      vi.useFakeTimers();
      try {
        setupTabsForMenu('tab-1');
        let menu = openTabContextMenu('tab-1');

        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(document.querySelector('.tab-context-menu')).toBeNull();

        menu = openTabContextMenu('tab-2');
        await vi.runAllTimersAsync();
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(document.querySelector('.tab-context-menu')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps only one context menu when opened repeatedly before dismiss timer', () => {
      vi.useFakeTimers();
      try {
        setupTabsForMenu('tab-1');
        openTabContextMenu('tab-1');
        openTabContextMenu('tab-2');
        expect(document.querySelectorAll('.tab-context-menu').length).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('restoreClosedTab', () => {
    it('restores the most recently closed tab path', async () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-a',
            path: '/a',
            history: ['/a'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
          {
            id: 'tab-b',
            path: '/b',
            history: ['/b'],
            historyIndex: 0,
            selectedItems: [],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-a',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      ctrl.closeTab('tab-b');
      vi.clearAllMocks();
      ctrl.restoreClosedTab();

      await vi.waitFor(() => {
        expect(deps.navigateTo).toHaveBeenCalledWith('/b', true);
      });
      expect(deps._getTabs().length).toBe(2);
    });
  });

  describe('updateCurrentTabPath', () => {
    it('updates the current tab path', () => {
      const deps = createMockDeps();
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabId = deps._getTabs()[0]!.id;
      deps.setActiveTabId(tabId);

      ctrl.updateCurrentTabPath('/new/path');

      expect(deps._getTabs()[0]!.path).toBe('/new/path');
    });

    it('does nothing when tabs disabled', () => {
      const deps = createMockDeps();
      deps._settings.enableTabs = false;
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      ctrl.updateCurrentTabPath('/new/path');
      expect(deps.debouncedSaveSettings).not.toHaveBeenCalled();
    });
  });

  describe('saveTabState', () => {
    it('saves tab state to settings', () => {
      const deps = createMockDeps();
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      ctrl.saveTabState();

      expect(deps._settings.tabState).toBeDefined();
      expect(deps._settings.tabState!.tabs.length).toBeGreaterThan(0);
    });

    it('calls saveSettingsWithTimestamp when immediate=true', () => {
      const deps = createMockDeps();
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      ctrl.saveTabState(true);

      expect(deps.saveSettingsWithTimestamp).toHaveBeenCalled();
    });

    it('calls debouncedSaveSettings when not immediate', () => {
      const deps = createMockDeps();
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      ctrl.saveTabState();

      expect(deps.debouncedSaveSettings).toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('clears save timeout', () => {
      const deps = createMockDeps();
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const timeout = setTimeout(() => {}, 5000);
      deps.setSaveTabStateTimeout(timeout);

      ctrl.cleanup();
      expect(deps.getSaveTabStateTimeout()).toBeNull();
    });
  });
});
