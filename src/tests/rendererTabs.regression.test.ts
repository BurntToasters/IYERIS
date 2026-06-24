// @vitest-environment jsdom
/**
 * Regression tests for tabs.
 * N2: When snapshotCurrentTab is called while the current listing exceeds
 *     maxCachedFilesPerTab, any stale cachedFiles snapshot must be deleted.
 *     Previously the stale snapshot was left intact, so a switch-back
 *     rendered the wrong directory's files under the new path.
 * N4: The tab context menu dismiss listener must NOT use { once: true }.
 *     With once:true, a mousedown inside the menu consumed the listener
 *     without closing it, making the menu permanently undismissable for
 *     any subsequent outside click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../rendererDom.js', () => ({ clearHtml: vi.fn() }));
vi.mock('../shared.js', () => ({ escapeHtml: (s: string) => s, ignoreError: () => {} }));
vi.mock('../rendererUtils.js', () => ({ twemojiImg: () => '<img />' }));

import { createTabsController } from '../rendererTabs';
import type { TabData } from '../rendererTabs';
import type { FileItem, Settings } from '../types';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { enableTabs: true, startupPath: '', tabState: undefined, ...overrides } as Settings;
}

function makeFile(path: string): FileItem {
  return {
    name: path.split('/').pop() || path,
    path,
    isDirectory: false,
    isFile: true,
    size: 0,
    modified: new Date(0),
    isHidden: false,
  };
}

function createMockDeps(maxCachedFilesPerTab = 5) {
  let tabs: TabData[] = [];
  let activeTabId = '';
  let tabsEnabled = false;
  let cacheAccessOrder: string[] = [];
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;
  let currentPath = '/home/test';
  let history = ['/home/test'];
  let historyIndex = 0;
  let selectedItems = new Set<string>();
  let allFiles: FileItem[] = [];
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
    getTabNewButtonListenerAttached: () => false,
    setTabNewButtonListenerAttached: vi.fn(),
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
    setAllFiles: (f: FileItem[]) => {
      allFiles = f;
    },
    getFileViewScrollTop: () => scrollTop,
    setFileViewScrollTop: (v: number) => {
      scrollTop = v;
    },
    getAddressInput: () => null,
    getPathDisplayValue: (p: string) => p,
    homeViewLabel: 'Home',
    homeViewPath: 'home://',
    getViewMode: () => 'grid' as const,
    navigateTo: vi.fn().mockResolvedValue(undefined),
    renderFiles: vi.fn(),
    renderColumnView: vi.fn(),
    updateBreadcrumb: vi.fn(),
    updateNavigationButtons: vi.fn(),
    setHomeViewActive: vi.fn(),
    watchDirectory: vi.fn(),
    debouncedSaveSettings: vi.fn(),
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
    maxCachedTabs: 10,
    maxCachedFilesPerTab,
    isMainWindow: true,
    isHomeViewPath: (p: string) => p === 'home://',
  };
}

// ── N2 ──────────────────────────────────────────────────────────────────────

describe('rendererTabs — N2 stale cachedFiles must be deleted when listing is large', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
    document.body.innerHTML = `
      <div id="tab-bar">
        <div id="tab-list"></div>
        <button id="tab-new-btn"></button>
      </div>
    `;
    Object.defineProperty(window, 'tauriAPI', {
      value: { getItemProperties: vi.fn().mockResolvedValue({ success: true }) },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('deletes cachedFiles when current listing exceeds maxCachedFilesPerTab', async () => {
    const deps = createMockDeps(3); // small cap so we can exceed it easily
    const ctrl = createTabsController(deps);

    // Initialize with tabs enabled.
    deps.setTabsEnabled(true);
    ctrl.initializeTabs();

    // Add two tabs.
    await ctrl.addNewTab('/dir-a');
    await ctrl.addNewTab('/dir-b');

    const tabs = deps.getTabs();
    expect(tabs.length).toBeGreaterThanOrEqual(2);

    const firstTabId = tabs[0]!.id;
    const secondTabId = tabs[1]!.id;

    // Plant a stale cache on the first tab (simulates a prior small listing).
    tabs[0]!.cachedFiles = [{ name: 'stale.txt', path: '/stale/stale.txt' }] as never;
    expect(tabs[0]!.cachedFiles).toBeDefined();

    // Switch to the first tab so it becomes current.
    ctrl.switchToTab(firstTabId);
    expect(deps.getActiveTabId()).toBe(firstTabId);

    // Now simulate a large listing for the first tab (exceeds cap of 3).
    deps.setAllFiles(Array.from({ length: 10 }, (_, i) => makeFile(`/dir-a/file${i}.txt`)));

    // Switching away triggers snapshotCurrentTab for the first tab.
    ctrl.switchToTab(secondTabId);

    // The stale cache must have been deleted — it no longer matches the path.
    expect(tabs[0]!.cachedFiles).toBeUndefined();
  });

  it('keeps cachedFiles when listing is within maxCachedFilesPerTab', async () => {
    const deps = createMockDeps(100); // large cap
    const ctrl = createTabsController(deps);
    deps.setTabsEnabled(true);
    ctrl.initializeTabs();

    await ctrl.addNewTab('/dir-a');
    await ctrl.addNewTab('/dir-b');

    const tabs = deps.getTabs();
    const firstTabId = tabs[0]!.id;
    const secondTabId = tabs[1]!.id;

    ctrl.switchToTab(firstTabId);

    // Small listing — well within cap.
    deps.setAllFiles([makeFile('/dir-a/file.txt')]);

    ctrl.switchToTab(secondTabId);

    // Cache should be populated (not deleted) for the small listing.
    expect(tabs[0]!.cachedFiles).toBeDefined();
    expect(tabs[0]!.cachedFiles?.length).toBe(1);
  });
});

// ── N4 ──────────────────────────────────────────────────────────────────────

describe('rendererTabs — N4 context menu dismiss must survive inside-menu clicks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
    document.body.innerHTML = `
      <div id="tab-bar">
        <div id="tab-list">
          <div class="tab-item" data-tab-id="tab-1" style="position:relative">
            <span>Tab 1</span>
          </div>
        </div>
        <button id="tab-new-btn"></button>
      </div>
    `;
    Object.defineProperty(window, 'tauriAPI', {
      value: { getItemProperties: vi.fn().mockResolvedValue({ success: true }) },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the menu open after a mousedown inside the menu', async () => {
    const deps = createMockDeps();
    const ctrl = createTabsController(deps);
    ctrl.initializeTabs();

    await ctrl.addNewTab('/tab-1-path');

    const tabList = document.getElementById('tab-list')!;
    const tabEl = tabList.querySelector('.tab-item[data-tab-id]') as HTMLElement;
    expect(tabEl).not.toBeNull();

    // Fire contextmenu to open the tab context menu.
    const ctxEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 50,
    });
    tabEl.dispatchEvent(ctxEvent);

    // Flush the setTimeout that registers the dismiss listener.
    vi.runAllTimers();

    const menu = document.querySelector('.tab-context-menu') as HTMLElement | null;
    expect(menu).not.toBeNull();

    // Click INSIDE the menu — with the old { once:true } bug this would consume
    // the dismiss listener without closing, making subsequent outside clicks ignored.
    const insideClick = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    menu!.dispatchEvent(insideClick);

    // Menu must still exist.
    expect(document.querySelector('.tab-context-menu')).not.toBeNull();

    // Now click OUTSIDE — the dismiss listener must still be active and close the menu.
    const outsideClick = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(outsideClick);

    expect(document.querySelector('.tab-context-menu')).toBeNull();
  });

  it('closes the menu on the first outside mousedown', async () => {
    const deps = createMockDeps();
    const ctrl = createTabsController(deps);
    ctrl.initializeTabs();

    await ctrl.addNewTab('/tab-1-path');

    const tabList = document.getElementById('tab-list')!;
    const tabEl = tabList.querySelector('.tab-item[data-tab-id]') as HTMLElement;

    tabEl.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    );
    vi.runAllTimers();

    expect(document.querySelector('.tab-context-menu')).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(document.querySelector('.tab-context-menu')).toBeNull();
  });
});
