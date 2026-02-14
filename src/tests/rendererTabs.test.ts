// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Settings } from '../types';

vi.mock('../rendererDom.js', () => ({ clearHtml: vi.fn() }));
vi.mock('../shared.js', () => ({ escapeHtml: (s: string) => s }));
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
    debouncedSaveSettings: vi.fn(),
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue(undefined),
    maxCachedTabs: 5,
    maxCachedFilesPerTab: 500,
    _settings: settings,
    _getTabs: () => tabs,
    _getActiveTabId: () => activeTabId,
  };
}

describe('createTabsController', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="tab-bar"><div id="tab-list"></div></div>
      <button id="new-tab-btn"></button>
      <button id="toolbar-new-tab-btn"></button>
    `;
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
      expect(deps._getTabs()[0].id).toBe('tab-a');
    });

    it('does not close the last remaining tab', () => {
      const deps = createMockDeps();
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabId = deps._getTabs()[0].id;
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

    it('restores cached files instead of navigating', () => {
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

      expect(deps.navigateTo).not.toHaveBeenCalled();
      expect(deps.renderFiles).toHaveBeenCalled();
    });
  });

  describe('updateCurrentTabPath', () => {
    it('updates the current tab path', () => {
      const deps = createMockDeps();
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabId = deps._getTabs()[0].id;
      deps.setActiveTabId(tabId);

      ctrl.updateCurrentTabPath('/new/path');

      expect(deps._getTabs()[0].path).toBe('/new/path');
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
