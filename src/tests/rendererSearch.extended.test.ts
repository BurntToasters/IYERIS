// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared.js', () => ({
  escapeHtml: (s: string) => s,
  ignoreError: () => {},
}));

vi.mock('../rendererDom.js', () => ({
  clearHtml: vi.fn((el: HTMLElement) => {
    if (el) el.innerHTML = '';
  }),
  getById: vi.fn((id: string) => document.getElementById(id)),
}));

vi.mock('../rendererUtils.js', () => ({
  twemojiImg: () => '<img>',
}));

vi.mock('../home.js', () => ({
  isHomeViewPath: (p: string) => p === 'home-view',
}));

import { createSearchController } from '../rendererSearch';

function createDeps(overrides: Record<string, unknown> = {}) {
  const settings = {
    enableSearchHistory: true,
    searchHistory: [] as string[],
    maxSearchHistoryItems: 10,
    globalContentSearch: false,
    showHiddenFiles: false,
    ...((overrides.settingsOverrides as Record<string, unknown>) ?? {}),
  } as Record<string, unknown>;
  return {
    settings,
    getCurrentPath: vi.fn(() => (overrides.currentPath as string) ?? '/workspace'),
    getCurrentSettings: vi.fn(() => settings),
    setAllFiles: vi.fn(),
    renderFiles: vi.fn(),
    showLoading: vi.fn(),
    hideLoading: vi.fn(),
    updateStatusBar: vi.fn(),
    showToast: vi.fn(),
    createDirectoryOperationId: vi.fn(() => 'op-1'),
    navigateTo: vi.fn(),
    debouncedSaveSettings: vi.fn(),
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
    getFileGrid: vi.fn(() => document.getElementById('file-grid')),
    searchDebounceMs: 200,
    searchHistoryMax: 5,
  };
}

function setupSearchDOM() {
  document.body.innerHTML = `
    <div class="search-bar-wrapper" style="display:none">
      <input id="search-input" type="text" />
    </div>
    <button id="search-btn"></button>
    <button id="search-close"></button>
    <button id="search-scope-toggle"><img src="" alt="" /></button>
    <button id="search-filter-toggle"></button>
    <div id="search-filters-panel" style="display:none">
      <select id="search-filter-type"><option value="all">All</option></select>
      <input id="search-filter-min-size" />
      <input id="search-filter-max-size" />
      <select id="search-filter-size-unit-min"><option value="1024">KB</option></select>
      <select id="search-filter-size-unit-max"><option value="1048576">MB</option></select>
      <input id="search-filter-date-from" />
      <input id="search-filter-date-to" />
      <button id="search-filter-clear"></button>
      <button id="search-filter-apply"></button>
      <input id="search-in-contents-toggle" type="checkbox" />
    </div>
    <span id="filter-badge" style="display:none"></span>
    <div id="search-history-dropdown" style="display:none"></div>
    <div id="file-grid"></div>
  `;

  Object.defineProperty(window, 'electronAPI', {
    value: {
      cancelSearch: vi.fn().mockResolvedValue(undefined),
      searchFiles: vi.fn().mockResolvedValue({ success: true, results: [] }),
      searchIndex: vi.fn().mockResolvedValue({ success: true, results: [] }),
      searchFilesWithContent: vi.fn().mockResolvedValue({ success: true, results: [] }),
      searchFilesWithContentGlobal: vi.fn().mockResolvedValue({ success: true, results: [] }),
    },
    configurable: true,
    writable: true,
  });
}

describe('Search controller — extended', () => {
  beforeEach(() => {
    setupSearchDOM();
  });

  describe('hasActiveFilters (via getStatusText)', () => {
    it('includes (filtered) when filters are active', async () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();

      ctrl.toggleSearch();
      ctrl.setQuery('hello');

      const dateFrom = document.getElementById('search-filter-date-from') as HTMLInputElement;
      dateFrom.value = '2024-01-01';
      const applyBtn = document.getElementById('search-filter-apply')!;
      applyBtn.click();

      const status = ctrl.getStatusText();
      expect(status.active).toBe(true);
      expect(status.text).toContain('(filtered)');
    });
  });

  describe('clearSearchHistory', () => {
    it('clears history and shows toast', () => {
      const deps = createDeps();
      deps.settings.searchHistory = ['a', 'b', 'c'];
      const ctrl = createSearchController(deps as any);
      ctrl.clearSearchHistory();
      expect(deps.settings.searchHistory).toEqual([]);
      expect(deps.saveSettingsWithTimestamp).toHaveBeenCalledWith(deps.settings);
      expect(deps.showToast).toHaveBeenCalledWith('Search history cleared', 'History', 'success');
    });

    it('hides search history dropdown', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      const dropdown = document.getElementById('search-history-dropdown')!;
      dropdown.style.display = 'block';
      ctrl.clearSearchHistory();
      expect(dropdown.style.display).toBe('none');
    });
  });

  describe('showSearchHistoryDropdown', () => {
    it('shows empty message when no history', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.showSearchHistoryDropdown();
      const dropdown = document.getElementById('search-history-dropdown')!;
      expect(dropdown.style.display).toBe('block');
      expect(dropdown.innerHTML).toContain('No recent searches');
    });

    it('shows history items and clear button', () => {
      const deps = createDeps();
      deps.settings.searchHistory = ['alpha', 'beta'];
      const ctrl = createSearchController(deps as any);
      ctrl.showSearchHistoryDropdown();
      const dropdown = document.getElementById('search-history-dropdown')!;
      expect(dropdown.innerHTML).toContain('alpha');
      expect(dropdown.innerHTML).toContain('beta');
      expect(dropdown.innerHTML).toContain('Clear Search History');
    });

    it('does nothing when dropdown element is missing', () => {
      document.getElementById('search-history-dropdown')!.remove();
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);

      ctrl.showSearchHistoryDropdown();
    });

    it('does nothing when enableSearchHistory is false', () => {
      const deps = createDeps({ settingsOverrides: { enableSearchHistory: false } });
      const ctrl = createSearchController(deps as any);
      ctrl.showSearchHistoryDropdown();
      const dropdown = document.getElementById('search-history-dropdown')!;
      expect(dropdown.style.display).toBe('none');
    });
  });

  describe('hideSearchHistoryDropdown', () => {
    it('hides the dropdown', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      const dropdown = document.getElementById('search-history-dropdown')!;
      dropdown.style.display = 'block';
      ctrl.hideSearchHistoryDropdown();
      expect(dropdown.style.display).toBe('none');
    });
  });

  describe('getStatusText', () => {
    it('returns Search prefix for local search with query', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.toggleSearch();
      ctrl.setQuery('test');
      const status = ctrl.getStatusText();
      expect(status.active).toBe(true);
      expect(status.text).toBe('Search: "test"');
    });

    it('truncates long queries to 20 chars', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.toggleSearch();
      ctrl.setQuery('a'.repeat(25));
      const status = ctrl.getStatusText();
      expect(status.text).toContain('...');
      expect(status.text).toContain('a'.repeat(20));
    });

    it('returns Global prefix for global search', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.openSearch(true);
      ctrl.setQuery('files');
      const status = ctrl.getStatusText();
      expect(status.text).toContain('Global');
    });
  });

  describe('toggleSearch', () => {
    it('opens search bar and sets focus', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.toggleSearch();
      const wrapper = document.querySelector('.search-bar-wrapper') as HTMLElement;
      expect(wrapper.style.display).toBe('block');
      expect(ctrl.isSearchMode()).toBe(true);
    });

    it('closes search on second toggle', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.toggleSearch();
      ctrl.toggleSearch();
      expect(ctrl.isSearchMode()).toBe(false);
    });

    it('forces global search when on home view', () => {
      const deps = createDeps({ currentPath: 'home-view' });
      const ctrl = createSearchController(deps as any);
      ctrl.toggleSearch();
      expect(ctrl.isGlobalSearch()).toBe(true);
    });
  });

  describe('closeSearch', () => {
    it('resets all search state', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.toggleSearch();
      ctrl.setQuery('something');
      ctrl.closeSearch();
      expect(ctrl.isSearchMode()).toBe(false);
      expect(ctrl.isGlobalSearch()).toBe(false);
      expect(ctrl.getQuery()).toBe('');
      expect(deps.navigateTo).toHaveBeenCalledWith('/workspace');
    });
  });

  describe('openSearch', () => {
    it('opens in global mode', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.openSearch(true);
      expect(ctrl.isSearchMode()).toBe(true);
      expect(ctrl.isGlobalSearch()).toBe(true);
    });

    it('opens in local mode', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.openSearch(false);
      expect(ctrl.isSearchMode()).toBe(true);
      expect(ctrl.isGlobalSearch()).toBe(false);
    });
  });

  describe('performSearch', () => {
    it('does nothing when query is empty', async () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.toggleSearch();
      ctrl.setQuery('');
      await ctrl.performSearch();
      expect(deps.showLoading).not.toHaveBeenCalled();
    });

    it('shows toast when local search on home view', async () => {
      const deps = createDeps({ currentPath: 'home-view' });
      const ctrl = createSearchController(deps as any);
      ctrl.openSearch(false);

      ctrl.setQuery('test');

      await ctrl.performSearch();
      expect(deps.showToast).toHaveBeenCalledWith(
        'Open a folder or use global search',
        'Search',
        'info'
      );
    });
  });

  describe('updateFilterBadge', () => {
    it('does nothing when badge element is missing', () => {
      document.getElementById('filter-badge')!.remove();
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);

      ctrl.initListeners();
      const filterType = document.getElementById('search-filter-type') as HTMLSelectElement;
      if (filterType) filterType.value = 'image';
    });
  });

  describe('updateContentSearchToggle', () => {
    it('disables content search toggle for global search when globalContentSearch is off', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.openSearch(true);
      ctrl.updateContentSearchToggle();
      const toggle = document.getElementById('search-in-contents-toggle') as HTMLInputElement;
      expect(toggle.disabled).toBe(true);
      expect(toggle.parentElement?.classList.contains('disabled')).toBe(true);
    });

    it('enables content search toggle for local search', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.openSearch(false);
      ctrl.updateContentSearchToggle();
      const toggle = document.getElementById('search-in-contents-toggle') as HTMLInputElement;
      expect(toggle.disabled).toBe(false);
    });

    it('enables content search toggle for global when globalContentSearch is on', () => {
      const deps = createDeps({ settingsOverrides: { globalContentSearch: true } });
      const ctrl = createSearchController(deps as any);
      ctrl.openSearch(true);
      ctrl.updateContentSearchToggle();
      const toggle = document.getElementById('search-in-contents-toggle') as HTMLInputElement;
      expect(toggle.disabled).toBe(false);
    });
  });

  describe('focusInput', () => {
    it('does not throw when search input exists', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      expect(() => ctrl.focusInput()).not.toThrow();
    });
  });

  describe('getSearchInputElement', () => {
    it('returns the search input', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      const el = ctrl.getSearchInputElement();
      expect(el).toBe(document.getElementById('search-input'));
    });
  });
});
