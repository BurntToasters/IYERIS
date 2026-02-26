// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Settings } from '../types';

vi.mock('../rendererDom.js', () => ({
  clearHtml: vi.fn((el: HTMLElement) => {
    el.innerHTML = '';
  }),
}));
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

function createMockDeps(overrides: Record<string, any> = {}) {
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
  let viewMode: 'grid' | 'list' | 'column' = 'grid';
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
    getAddressInput: () => document.getElementById('address-input') as HTMLInputElement | null,
    getPathDisplayValue: (p: string) => p,
    isHomeViewPath: (p: string) => p === '~~HOME~~',
    homeViewLabel: 'Home',
    homeViewPath: '~~HOME~~',
    getViewMode: () => viewMode as 'grid' | 'list' | 'column',
    renderFiles: vi.fn(),
    renderColumnView: vi.fn(),
    updateBreadcrumb: vi.fn(),
    updateNavigationButtons: vi.fn(),
    setHomeViewActive: vi.fn(),
    navigateTo: vi.fn(),
    debouncedSaveSettings: vi.fn(),
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue(undefined),
    maxCachedTabs: 3,
    maxCachedFilesPerTab: 500,
    _settings: settings,
    _getTabs: () => tabs,
    _getActiveTabId: () => activeTabId,
    _setViewMode: (m: 'grid' | 'list' | 'column') => {
      viewMode = m;
    },
    _setCacheAccessOrder: (o: string[]) => {
      cacheAccessOrder = o;
    },
    _setAllFiles: (f: any[]) => {
      allFiles = f;
    },
    ...overrides,
  };
}

function setupDOM() {
  document.body.innerHTML = `
    <div id="tab-bar"><div id="tab-list" role="tablist"></div><button id="new-tab-btn"></button></div>
    <input id="address-input" />
  `;
}

describe('rendererTabs extended', () => {
  beforeEach(() => {
    setupDOM();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('evictOldestTabCache', () => {
    it('evicts cached files from the oldest tabs when exceeding MAX_CACHED_TABS', () => {
      const deps = createMockDeps();

      const ctrl = createTabsController(deps);

      const tabState = {
        tabs: Array.from({ length: 5 }, (_, i) => ({
          id: `tab-${i}`,
          path: `/path/${i}`,
          history: [`/path/${i}`],
          historyIndex: 0,
          selectedItems: [] as string[],
          scrollPosition: 0,
        })),
        activeTabId: 'tab-0',
      };
      deps._settings.tabState = tabState;
      ctrl.initializeTabs();

      const tabs = deps._getTabs();
      tabs.forEach((tab) => {
        tab.cachedFiles = [{ name: 'test.txt' } as any];
      });

      deps._setCacheAccessOrder(['tab-0', 'tab-1', 'tab-2', 'tab-3', 'tab-4']);

      deps._setAllFiles([{ name: 'a.txt' } as any]);

      ctrl.switchToTab('tab-4');

      const tab1 = tabs.find((t) => t.id === 'tab-1');
      const tab2 = tabs.find((t) => t.id === 'tab-2');
      expect(tab1?.cachedFiles).toBeUndefined();
      expect(tab2?.cachedFiles).toBeUndefined();

      const remaining = tabs.filter((t) => t.cachedFiles !== undefined);
      expect(remaining.length).toBeLessThanOrEqual(3);
    });

    it('does not evict when under MAX_CACHED_TABS limit', () => {
      const deps = createMockDeps();
      const ctrl = createTabsController(deps);

      const tabState = {
        tabs: [
          {
            id: 'tab-a',
            path: '/a',
            history: ['/a'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
          {
            id: 'tab-b',
            path: '/b',
            history: ['/b'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-a',
      };
      deps._settings.tabState = tabState;
      ctrl.initializeTabs();

      const tabs = deps._getTabs();
      tabs.forEach((tab) => {
        tab.cachedFiles = [{ name: 'x.txt' } as any];
      });

      deps._setCacheAccessOrder(['tab-a', 'tab-b']);
      deps._setAllFiles([{ name: 'tiny.txt' } as any]);

      ctrl.switchToTab('tab-b');

      expect(tabs.find((t) => t.id === 'tab-a')?.cachedFiles).toBeDefined();
    });
  });

  describe('tab keyboard navigation', () => {
    function initThreeTabs(deps: ReturnType<typeof createMockDeps>) {
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-1',
            path: '/one',
            history: ['/one'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
          {
            id: 'tab-2',
            path: '/two',
            history: ['/two'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
          {
            id: 'tab-3',
            path: '/three',
            history: ['/three'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-1',
      };
    }

    it('ArrowRight moves focus to the next tab, wrapping around', () => {
      const deps = createMockDeps();
      initThreeTabs(deps);
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const items = tabList.querySelectorAll<HTMLElement>('.tab-item');
      expect(items.length).toBe(3);

      const focusSpy = vi.spyOn(items[0], 'focus');
      items[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      expect(focusSpy).toHaveBeenCalled();
    });

    it('ArrowLeft moves focus to the previous tab, wrapping around', () => {
      const deps = createMockDeps();
      initThreeTabs(deps);
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const items = tabList.querySelectorAll<HTMLElement>('.tab-item');

      const focusSpy = vi.spyOn(items[2], 'focus');
      items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      expect(focusSpy).toHaveBeenCalled();
    });

    it('Home moves focus to the first tab', () => {
      const deps = createMockDeps();
      initThreeTabs(deps);
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const items = tabList.querySelectorAll<HTMLElement>('.tab-item');

      const focusSpy = vi.spyOn(items[0], 'focus');
      items[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      expect(focusSpy).toHaveBeenCalled();
    });

    it('End moves focus to the last tab', () => {
      const deps = createMockDeps();
      initThreeTabs(deps);
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const items = tabList.querySelectorAll<HTMLElement>('.tab-item');

      const focusSpy = vi.spyOn(items[2], 'focus');
      items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      expect(focusSpy).toHaveBeenCalled();
    });

    it('Enter key triggers switchToTab', () => {
      const deps = createMockDeps();
      initThreeTabs(deps);
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const items = tabList.querySelectorAll<HTMLElement>('.tab-item');

      items[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(deps._getActiveTabId()).toBe('tab-2');
    });

    it('Space key triggers switchToTab', () => {
      const deps = createMockDeps();
      initThreeTabs(deps);
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const items = tabList.querySelectorAll<HTMLElement>('.tab-item');

      items[1].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      expect(deps._getActiveTabId()).toBe('tab-2');
    });
  });

  describe('middle-click (auxclick)', () => {
    it('closes a tab on middle-click (button === 1)', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-a',
            path: '/a',
            history: ['/a'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
          {
            id: 'tab-b',
            path: '/b',
            history: ['/b'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-a',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const items = tabList.querySelectorAll<HTMLElement>('.tab-item');
      expect(items.length).toBe(2);

      const auxEvent = new MouseEvent('auxclick', { button: 1, bubbles: true });
      items[1].dispatchEvent(auxEvent);

      expect(deps._getTabs().length).toBe(1);
      expect(deps._getTabs()[0].id).toBe('tab-a');
    });

    it('does not close tab on non-middle auxclick (button !== 1)', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-a',
            path: '/a',
            history: ['/a'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
          {
            id: 'tab-b',
            path: '/b',
            history: ['/b'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-a',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const items = tabList.querySelectorAll<HTMLElement>('.tab-item');

      const rightClick = new MouseEvent('auxclick', { button: 2, bubbles: true });
      items[1].dispatchEvent(rightClick);

      expect(deps._getTabs().length).toBe(2);
    });
  });

  describe('restoreTabView', () => {
    it('activates home mode when path is the home view path', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-1',
            path: '/one',
            history: ['/one'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
          {
            id: 'tab-home',
            path: '~~HOME~~',
            history: ['~~HOME~~'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-1',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabs = deps._getTabs();
      const homeTab = tabs.find((t) => t.id === 'tab-home')!;
      homeTab.cachedFiles = [];

      ctrl.switchToTab('tab-home');

      expect(deps.setHomeViewActive).toHaveBeenCalledWith(true);

      expect(deps.renderFiles).not.toHaveBeenCalled();
      expect(deps.renderColumnView).not.toHaveBeenCalled();
    });

    it('renders column view when viewMode is column', () => {
      const deps = createMockDeps();
      deps._setViewMode('column');
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-1',
            path: '/one',
            history: ['/one'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
          {
            id: 'tab-2',
            path: '/two',
            history: ['/two'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-1',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabs = deps._getTabs();
      const tab2 = tabs.find((t) => t.id === 'tab-2')!;
      tab2.cachedFiles = [{ name: 'file.txt' } as any];

      ctrl.switchToTab('tab-2');

      expect(deps.setHomeViewActive).toHaveBeenCalledWith(false);
      expect(deps.renderColumnView).toHaveBeenCalled();
      expect(deps.renderFiles).not.toHaveBeenCalled();
    });

    it('renders files when viewMode is grid (non-column, non-home)', () => {
      const deps = createMockDeps();
      deps._setViewMode('grid');
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-1',
            path: '/one',
            history: ['/one'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
          {
            id: 'tab-2',
            path: '/two',
            history: ['/two'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-1',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const cachedFiles = [{ name: 'a.txt' } as any, { name: 'b.txt' } as any];
      const tabs = deps._getTabs();
      tabs.find((t) => t.id === 'tab-2')!.cachedFiles = cachedFiles;

      ctrl.switchToTab('tab-2');

      expect(deps.setHomeViewActive).toHaveBeenCalledWith(false);
      expect(deps.renderFiles).toHaveBeenCalledWith(cachedFiles);
    });

    it('updates address input value on restore', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-1',
            path: '/one',
            history: ['/one'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
          {
            id: 'tab-2',
            path: '/two',
            history: ['/two'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-1',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabs = deps._getTabs();
      tabs.find((t) => t.id === 'tab-2')!.cachedFiles = [{ name: 'x.txt' } as any];

      ctrl.switchToTab('tab-2');

      const addressInput = document.getElementById('address-input') as HTMLInputElement;
      expect(addressInput.value).toBe('/two');
      expect(deps.updateBreadcrumb).toHaveBeenCalledWith('/two');
      expect(deps.updateNavigationButtons).toHaveBeenCalled();
    });
  });

  describe('debouncedSaveTabState', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('clears existing timeout before setting a new one', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-1',
            path: '/one',
            history: ['/one'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
          {
            id: 'tab-2',
            path: '/two',
            history: ['/two'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
          {
            id: 'tab-3',
            path: '/three',
            history: ['/three'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-1',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      ctrl.switchToTab('tab-2');
      const firstTimeout = deps.getSaveTabStateTimeout();
      expect(firstTimeout).not.toBeNull();

      ctrl.switchToTab('tab-3');
      const secondTimeout = deps.getSaveTabStateTimeout();
      expect(secondTimeout).not.toBeNull();
      expect(secondTimeout).not.toBe(firstTimeout);
    });

    it('calls saveTabState after debounce delay', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-1',
            path: '/one',
            history: ['/one'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
          {
            id: 'tab-2',
            path: '/two',
            history: ['/two'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-1',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      ctrl.switchToTab('tab-2');

      deps.debouncedSaveSettings.mockClear();

      vi.advanceTimersByTime(500);

      expect(deps.debouncedSaveSettings).toHaveBeenCalled();
    });
  });

  describe('new tab button listeners', () => {
    it('new-tab-btn click fires addNewTab', () => {
      const deps = createMockDeps();
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const initialCount = deps._getTabs().length;
      const btn = document.getElementById('new-tab-btn')!;
      btn.click();

      expect(deps._getTabs().length).toBe(initialCount + 1);
      expect(deps.navigateTo).toHaveBeenCalled();
    });

    it('only attaches listeners once even if initializeTabs called twice', () => {
      const deps = createMockDeps();
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();
      ctrl.initializeTabs();

      const initialCount = deps._getTabs().length;
      const btn = document.getElementById('new-tab-btn')!;
      btn.click();

      expect(deps._getTabs().length).toBe(initialCount + 1);
    });
  });

  describe('tab rendering DOM details', () => {
    it('renders close button with correct content and aria-label', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-1',
            path: '/my/folder',
            history: ['/my/folder'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-1',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const closeBtn = tabList.querySelector('.tab-close') as HTMLButtonElement;
      expect(closeBtn).not.toBeNull();
      expect(closeBtn.textContent).toBe('×');
      expect(closeBtn.getAttribute('aria-label')).toBe('Close tab');
    });

    it('sets active styling on the active tab', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-1',
            path: '/a',
            history: ['/a'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
          {
            id: 'tab-2',
            path: '/b',
            history: ['/b'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-2',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const items = tabList.querySelectorAll<HTMLElement>('.tab-item');

      expect(items[0].classList.contains('active')).toBe(false);
      expect(items[0].getAttribute('aria-selected')).toBe('false');
      expect(items[0].tabIndex).toBe(-1);

      expect(items[1].classList.contains('active')).toBe(true);
      expect(items[1].getAttribute('aria-selected')).toBe('true');
      expect(items[1].tabIndex).toBe(0);
    });

    it('renders folder name as title text from path', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-1',
            path: '/usr/local/share',
            history: ['/usr/local/share'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-1',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const title = tabList.querySelector('.tab-title') as HTMLElement;
      expect(title.textContent).toBe('share');
      expect(title.getAttribute('title')).toBe('/usr/local/share');
    });

    it('renders "Home" label for home view path tab', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-home',
            path: '~~HOME~~',
            history: ['~~HOME~~'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-home',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const title = tabList.querySelector('.tab-title') as HTMLElement;
      expect(title.textContent).toBe('Home');
    });

    it('renders "New Tab" for a tab with empty path', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-empty',
            path: '',
            history: [],
            historyIndex: -1,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-empty',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const title = tabList.querySelector('.tab-title') as HTMLElement;
      expect(title.textContent).toBe('New Tab');
    });

    it('close button click closes the tab', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'tab-1',
            path: '/a',
            history: ['/a'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
          {
            id: 'tab-2',
            path: '/b',
            history: ['/b'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'tab-1',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const closeBtns = tabList.querySelectorAll<HTMLButtonElement>('.tab-close');

      closeBtns[1].click();

      expect(deps._getTabs().length).toBe(1);
      expect(deps._getTabs()[0].id).toBe('tab-1');
    });

    it('sets role=tab and aria-controls on tab elements', () => {
      const deps = createMockDeps();
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const item = tabList.querySelector('.tab-item') as HTMLElement;
      expect(item.getAttribute('role')).toBe('tab');
      expect(item.getAttribute('aria-controls')).toBe('file-view');
    });

    it('tab element has data-tab-id attribute', () => {
      const deps = createMockDeps();
      deps._settings.tabState = {
        tabs: [
          {
            id: 'my-tab-id',
            path: '/test',
            history: ['/test'],
            historyIndex: 0,
            selectedItems: [] as string[],
            scrollPosition: 0,
          },
        ],
        activeTabId: 'my-tab-id',
      };
      const ctrl = createTabsController(deps);
      ctrl.initializeTabs();

      const tabList = document.getElementById('tab-list')!;
      const item = tabList.querySelector('.tab-item') as HTMLElement;
      expect(item.dataset.tabId).toBe('my-tab-id');
    });
  });
});
