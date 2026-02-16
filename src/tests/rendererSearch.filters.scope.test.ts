// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const mockCancelSearch = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSearchFiles = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true, results: [] }));
const mockSearchIndex = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true, results: [] }));
const mockSearchFilesWithContent = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ success: true, results: [] })
);
const mockSearchFilesWithContentGlobal = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ success: true, results: [] })
);
const mockClearHtml = vi.hoisted(() =>
  vi.fn((el: HTMLElement) => {
    if (el) el.innerHTML = '';
  })
);
const mockGetById = vi.hoisted(() => vi.fn((id: string) => document.getElementById(id)));

vi.mock('../shared.js', () => ({
  escapeHtml: (s: string) => s,
  ignoreError: () => {},
}));

vi.mock('../rendererDom.js', () => ({
  clearHtml: mockClearHtml,
  getById: mockGetById,
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
    searchDebounceMs: 50,
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
      <select id="search-filter-type">
        <option value="all">All</option>
        <option value="image">Image</option>
        <option value="document">Document</option>
      </select>
      <input id="search-filter-min-size" type="number" />
      <input id="search-filter-max-size" type="number" />
      <select id="search-filter-size-unit-min">
        <option value="1">B</option>
        <option value="1024">KB</option>
      </select>
      <select id="search-filter-size-unit-max">
        <option value="1024">KB</option>
        <option value="1048576">MB</option>
      </select>
      <input id="search-filter-date-from" type="date" />
      <input id="search-filter-date-to" type="date" />
      <button id="search-filter-clear"></button>
      <button id="search-filter-apply"></button>
      <label><input id="search-in-contents-toggle" type="checkbox" /> Search in contents</label>
    </div>
    <span id="filter-badge" style="display:none"></span>
    <div id="search-history-dropdown" style="display:none"></div>
    <div id="file-grid"></div>
  `;

  Object.defineProperty(window, 'electronAPI', {
    value: {
      cancelSearch: mockCancelSearch,
      searchFiles: mockSearchFiles,
      searchIndex: mockSearchIndex,
      searchFilesWithContent: mockSearchFilesWithContent,
      searchFilesWithContentGlobal: mockSearchFilesWithContentGlobal,
    },
    configurable: true,
    writable: true,
  });
}

describe('rendererSearch — extended2', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupSearchDOM();
    mockCancelSearch.mockClear();
    mockSearchFiles.mockClear();
    mockSearchIndex.mockClear();
    mockSearchFilesWithContent.mockClear();
    mockSearchFilesWithContentGlobal.mockClear();
    mockClearHtml.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('performSearch — local search success', () => {
    it('calls searchFiles and renders results for local non-content search', async () => {
      const files = [
        {
          name: 'readme.md',
          path: '/workspace/readme.md',
          isDirectory: false,
          isFile: true,
          size: 100,
          modified: '2024-01-01',
        },
      ];
      mockSearchFiles.mockResolvedValueOnce({ success: true, results: files });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('readme');

      await ctrl.performSearch();

      expect(mockSearchFiles).toHaveBeenCalledWith('/workspace', 'readme', undefined, 'op-1');
      expect(deps.setAllFiles).toHaveBeenCalledWith(files);
      expect(deps.renderFiles).toHaveBeenCalledWith(files, undefined);
      expect(deps.hideLoading).toHaveBeenCalled();
      expect(deps.updateStatusBar).toHaveBeenCalled();
    });

    it('passes highlight query for local content search', async () => {
      const files = [
        {
          name: 'file.ts',
          path: '/workspace/file.ts',
          isDirectory: false,
          isFile: true,
          size: 50,
          modified: '2024-06-01',
        },
      ];

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('import');

      const toggle = document.getElementById('search-in-contents-toggle') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));

      await vi.runAllTimersAsync();

      mockSearchFilesWithContent.mockResolvedValueOnce({ success: true, results: files });
      deps.renderFiles.mockClear();
      deps.setAllFiles.mockClear();

      await ctrl.performSearch();

      expect(mockSearchFilesWithContent).toHaveBeenCalledWith(
        '/workspace',
        'import',
        expect.any(Object),
        'op-1'
      );
      expect(deps.renderFiles).toHaveBeenCalledWith(files, 'import');
    });

    it('shows error toast when local search fails', async () => {
      mockSearchFiles.mockResolvedValueOnce({ success: false, error: 'Permission denied' });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('test');

      await ctrl.performSearch();

      expect(deps.showToast).toHaveBeenCalledWith('Permission denied', 'Search Error', 'error');
    });

    it('does not show toast when local search error is "Calculation cancelled"', async () => {
      mockSearchFiles.mockResolvedValueOnce({ success: false, error: 'Calculation cancelled' });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('test');

      await ctrl.performSearch();

      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('shows fallback error message when error is empty', async () => {
      mockSearchFiles.mockResolvedValueOnce({ success: false, error: '' });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('test');

      await ctrl.performSearch();

      expect(deps.showToast).toHaveBeenCalledWith('Search failed', 'Search Error', 'error');
    });

    it('returns early when no current path in local mode', async () => {
      const deps = createDeps({ currentPath: '' });
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.openSearch(false);
      ctrl.setQuery('query');

      await ctrl.performSearch();

      expect(mockSearchFiles).not.toHaveBeenCalled();
      expect(deps.showLoading).not.toHaveBeenCalled();
    });
  });

  describe('performSearch — global search success', () => {
    it('calls searchIndex and maps results to FileItem[]', async () => {
      const indexResults = [
        {
          name: 'app.ts',
          path: '/project/app.ts',
          isDirectory: false,
          isFile: true,
          size: 200,
          modified: '2024-03-15',
        },
        {
          name: '.hidden',
          path: '/project/.hidden',
          isDirectory: false,
          isFile: true,
          size: 10,
          modified: '2024-03-15',
        },
        {
          name: 'docs',
          path: '/project/docs',
          isDirectory: true,
          isFile: false,
          size: 0,
          modified: '2024-03-15',
        },
      ];
      mockSearchIndex.mockResolvedValueOnce({ success: true, results: indexResults });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.openSearch(true);
      ctrl.setQuery('app');

      await ctrl.performSearch();

      expect(mockSearchIndex).toHaveBeenCalledWith('app', 'op-1');
      expect(deps.setAllFiles).toHaveBeenCalled();

      const mappedFiles = deps.setAllFiles.mock.calls[0][0];
      expect(mappedFiles).toHaveLength(3);
      expect(mappedFiles[0]).toEqual({
        name: 'app.ts',
        path: '/project/app.ts',
        isDirectory: false,
        isFile: true,
        size: 200,
        modified: '2024-03-15',
        isHidden: false,
      });
      expect(mappedFiles[1].isHidden).toBe(true);
      expect(mappedFiles[2].isDirectory).toBe(true);

      expect(deps.renderFiles).toHaveBeenCalledWith(mappedFiles, 'app');
    });

    it('shows "Index Disabled" warning on global non-content search', async () => {
      mockSearchIndex.mockResolvedValueOnce({ success: false, error: 'Indexer is disabled' });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.openSearch(true);
      ctrl.setQuery('test');

      await ctrl.performSearch();

      expect(deps.showToast).toHaveBeenCalledWith(
        'File indexer is disabled. Enable it in settings to use global search.',
        'Index Disabled',
        'warning'
      );
    });

    it('shows generic error on global non-content search failure', async () => {
      mockSearchIndex.mockResolvedValueOnce({ success: false, error: 'Timeout' });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.openSearch(true);
      ctrl.setQuery('test');

      await ctrl.performSearch();

      expect(deps.showToast).toHaveBeenCalledWith('Timeout', 'Search Error', 'error');
    });

    it('shows fallback error when global non-content error is empty', async () => {
      mockSearchIndex.mockResolvedValueOnce({ success: false, error: '' });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.openSearch(true);
      ctrl.setQuery('test');

      await ctrl.performSearch();

      expect(deps.showToast).toHaveBeenCalledWith('Global search failed', 'Search Error', 'error');
    });

    it('ignores "Calculation cancelled" on global non-content search', async () => {
      mockSearchIndex.mockResolvedValueOnce({ success: false, error: 'Calculation cancelled' });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.openSearch(true);
      ctrl.setQuery('test');

      await ctrl.performSearch();

      expect(deps.showToast).not.toHaveBeenCalled();
    });
  });

  describe('performSearch — global content search', () => {
    it('calls searchFilesWithContentGlobal and renders with highlight', async () => {
      const files = [
        {
          name: 'match.ts',
          path: '/a/match.ts',
          isDirectory: false,
          isFile: true,
          size: 50,
          modified: '2024-01-01',
        },
      ];

      const deps = createDeps({ settingsOverrides: { globalContentSearch: true } });
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.openSearch(true);
      ctrl.setQuery('keyword');

      const toggle = document.getElementById('search-in-contents-toggle') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));

      await vi.runAllTimersAsync();

      mockSearchFilesWithContentGlobal.mockResolvedValueOnce({ success: true, results: files });
      deps.setAllFiles.mockClear();
      deps.renderFiles.mockClear();

      await ctrl.performSearch();

      expect(mockSearchFilesWithContentGlobal).toHaveBeenCalledWith(
        'keyword',
        expect.any(Object),
        'op-1'
      );
      expect(deps.setAllFiles).toHaveBeenCalledWith(files);
      expect(deps.renderFiles).toHaveBeenCalledWith(files, 'keyword');
    });

    it('shows "Index Disabled" warning on global content search', async () => {
      const deps = createDeps({ settingsOverrides: { globalContentSearch: true } });
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.openSearch(true);
      ctrl.setQuery('keyword');

      const toggle = document.getElementById('search-in-contents-toggle') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));

      await vi.runAllTimersAsync();
      mockSearchFilesWithContentGlobal.mockResolvedValueOnce({
        success: false,
        error: 'Indexer is disabled',
      });

      await ctrl.performSearch();

      expect(deps.showToast).toHaveBeenCalledWith(
        'File indexer is disabled. Enable it in settings to use global search.',
        'Index Disabled',
        'warning'
      );
    });

    it('shows generic error on global content search failure', async () => {
      const deps = createDeps({ settingsOverrides: { globalContentSearch: true } });
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.openSearch(true);
      ctrl.setQuery('keyword');

      const toggle = document.getElementById('search-in-contents-toggle') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      await vi.runAllTimersAsync();
      mockSearchFilesWithContentGlobal.mockResolvedValueOnce({
        success: false,
        error: 'Out of memory',
      });

      await ctrl.performSearch();

      expect(deps.showToast).toHaveBeenCalledWith('Out of memory', 'Search Error', 'error');
    });

    it('shows fallback error on empty global content search error', async () => {
      const deps = createDeps({ settingsOverrides: { globalContentSearch: true } });
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.openSearch(true);
      ctrl.setQuery('keyword');

      const toggle = document.getElementById('search-in-contents-toggle') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      await vi.runAllTimersAsync();
      mockSearchFilesWithContentGlobal.mockResolvedValueOnce({ success: false, error: '' });

      await ctrl.performSearch();

      expect(deps.showToast).toHaveBeenCalledWith(
        'Global content search failed',
        'Search Error',
        'error'
      );
    });

    it('ignores "Calculation cancelled" on global content search', async () => {
      const deps = createDeps({ settingsOverrides: { globalContentSearch: true } });
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.openSearch(true);
      ctrl.setQuery('keyword');

      const toggle = document.getElementById('search-in-contents-toggle') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      await vi.runAllTimersAsync();
      deps.showToast.mockClear();
      mockSearchFilesWithContentGlobal.mockResolvedValueOnce({
        success: false,
        error: 'Calculation cancelled',
      });

      await ctrl.performSearch();

      expect(deps.showToast).not.toHaveBeenCalled();
    });
  });

  describe('performSearch — with active filters', () => {
    it('passes currentSearchFilters to searchFiles when filters are active', async () => {
      mockSearchFiles.mockResolvedValueOnce({ success: true, results: [] });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('test');

      const filterType = document.getElementById('search-filter-type') as HTMLSelectElement;
      filterType.value = 'image';
      const applyBtn = document.getElementById('search-filter-apply')!;
      applyBtn.click();

      mockSearchFiles.mockClear();
      mockSearchFiles.mockResolvedValueOnce({ success: true, results: [] });
      await ctrl.performSearch();

      expect(mockSearchFiles).toHaveBeenCalledWith(
        '/workspace',
        'test',
        expect.objectContaining({ fileType: 'image' }),
        'op-1'
      );
    });

    it('passes filters to global content search when active', async () => {
      mockSearchFilesWithContentGlobal.mockResolvedValueOnce({ success: true, results: [] });

      const deps = createDeps({ settingsOverrides: { globalContentSearch: true } });
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.openSearch(true);
      ctrl.setQuery('test');

      const dateFrom = document.getElementById('search-filter-date-from') as HTMLInputElement;
      dateFrom.value = '2024-01-01';
      const applyBtn = document.getElementById('search-filter-apply')!;
      applyBtn.click();

      const toggle = document.getElementById('search-in-contents-toggle') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));

      mockSearchFilesWithContentGlobal.mockClear();
      mockSearchFilesWithContentGlobal.mockResolvedValueOnce({ success: true, results: [] });
      await ctrl.performSearch();

      expect(mockSearchFilesWithContentGlobal).toHaveBeenCalledWith(
        'test',
        expect.objectContaining({ dateFrom: '2024-01-01' }),
        'op-1'
      );
    });
  });

  describe('performSearch — file grid clearing', () => {
    it('clears file grid contents before searching', async () => {
      mockSearchFiles.mockResolvedValueOnce({ success: true, results: [] });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('hello');

      await ctrl.performSearch();

      expect(mockClearHtml).toHaveBeenCalled();
      expect(deps.showLoading).toHaveBeenCalledWith('Searching...');
    });
  });

  describe('cancelActiveSearch — with active operation', () => {
    it('calls electronAPI.cancelSearch when there is an active search', async () => {
      mockSearchFiles.mockImplementationOnce(
        () =>
          new Promise((resolve) => setTimeout(() => resolve({ success: true, results: [] }), 1000))
      );

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('slow');

      const searchPromise = ctrl.performSearch();

      ctrl.cancelActiveSearch();

      expect(mockCancelSearch).toHaveBeenCalledWith('op-1');

      vi.advanceTimersByTime(1000);
      await searchPromise;
    });
  });

  describe('initListeners — filter toggle', () => {
    it('opens the filters panel on first click', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();

      const filterToggle = document.getElementById('search-filter-toggle')!;
      filterToggle.click();

      const panel = document.getElementById('search-filters-panel')!;
      expect(panel.style.display).toBe('block');
      expect(filterToggle.classList.contains('active')).toBe(true);
      expect(filterToggle.getAttribute('aria-expanded')).toBe('true');
    });

    it('closes the filters panel on second click', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();

      const filterToggle = document.getElementById('search-filter-toggle')!;
      filterToggle.click();
      filterToggle.click();

      const panel = document.getElementById('search-filters-panel')!;
      expect(panel.style.display).toBe('none');
      expect(filterToggle.classList.contains('active')).toBe(false);
      expect(filterToggle.getAttribute('aria-expanded')).toBe('false');
    });
  });

  describe('initListeners — filter apply', () => {
    it('computes minSize and maxSize using selected units', async () => {
      mockSearchFiles.mockResolvedValueOnce({ success: true, results: [] });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('data');

      const minSize = document.getElementById('search-filter-min-size') as HTMLInputElement;
      const maxSize = document.getElementById('search-filter-max-size') as HTMLInputElement;
      const minUnit = document.getElementById('search-filter-size-unit-min') as HTMLSelectElement;
      const maxUnit = document.getElementById('search-filter-size-unit-max') as HTMLSelectElement;

      minSize.value = '5';
      maxSize.value = '10';
      minUnit.value = '1024';
      maxUnit.value = '1048576';

      const applyBtn = document.getElementById('search-filter-apply')!;
      applyBtn.click();

      await vi.runAllTimersAsync();

      expect(mockSearchFiles).toHaveBeenCalledWith(
        '/workspace',
        'data',
        expect.objectContaining({
          minSize: 5 * 1024,
          maxSize: 10 * 1048576,
        }),
        'op-1'
      );
    });

    it('applies all filter types at once', async () => {
      mockSearchFiles.mockResolvedValueOnce({ success: true, results: [] });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('query');

      (document.getElementById('search-filter-type') as HTMLSelectElement).value = 'document';
      (document.getElementById('search-filter-min-size') as HTMLInputElement).value = '1';
      (document.getElementById('search-filter-max-size') as HTMLInputElement).value = '100';
      (document.getElementById('search-filter-date-from') as HTMLInputElement).value = '2024-01-01';
      (document.getElementById('search-filter-date-to') as HTMLInputElement).value = '2024-12-31';

      document.getElementById('search-filter-apply')!.click();
      await vi.runAllTimersAsync();

      const badge = document.getElementById('filter-badge')!;
      expect(badge.style.display).toBe('flex');
      expect(badge.textContent).toBe('5');
    });

    it('closes filter panel after applying', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();

      document.getElementById('search-filter-toggle')!.click();
      expect(document.getElementById('search-filters-panel')!.style.display).toBe('block');

      document.getElementById('search-filter-apply')!.click();
      expect(document.getElementById('search-filters-panel')!.style.display).toBe('none');
    });

    it('does not trigger search if query is empty on apply', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('');

      document.getElementById('search-filter-apply')!.click();

      expect(mockSearchFiles).not.toHaveBeenCalled();
    });
  });

  describe('initListeners — filter clear', () => {
    it('resets all filter fields and clears badge', async () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('hello');

      (document.getElementById('search-filter-type') as HTMLSelectElement).value = 'image';
      (document.getElementById('search-filter-min-size') as HTMLInputElement).value = '5';
      (document.getElementById('search-filter-max-size') as HTMLInputElement).value = '50';
      (document.getElementById('search-filter-date-from') as HTMLInputElement).value = '2024-01-01';
      (document.getElementById('search-filter-date-to') as HTMLInputElement).value = '2024-12-31';

      document.getElementById('search-filter-apply')!.click();

      const badge = document.getElementById('filter-badge')!;
      expect(badge.style.display).toBe('flex');

      mockSearchFiles.mockClear();
      mockSearchFiles.mockResolvedValueOnce({ success: true, results: [] });
      document.getElementById('search-filter-clear')!.click();
      await vi.runAllTimersAsync();

      expect((document.getElementById('search-filter-type') as HTMLSelectElement).value).toBe(
        'all'
      );
      expect((document.getElementById('search-filter-min-size') as HTMLInputElement).value).toBe(
        ''
      );
      expect((document.getElementById('search-filter-max-size') as HTMLInputElement).value).toBe(
        ''
      );
      expect((document.getElementById('search-filter-date-from') as HTMLInputElement).value).toBe(
        ''
      );
      expect((document.getElementById('search-filter-date-to') as HTMLInputElement).value).toBe('');

      expect(badge.style.display).toBe('none');

      expect(document.getElementById('search-filter-toggle')!.classList.contains('active')).toBe(
        false
      );
    });

    it('resets size unit selects to defaults', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();

      (document.getElementById('search-filter-size-unit-min') as HTMLSelectElement).value = '1';
      (document.getElementById('search-filter-size-unit-max') as HTMLSelectElement).value = '1024';

      document.getElementById('search-filter-clear')!.click();

      expect(
        (document.getElementById('search-filter-size-unit-min') as HTMLSelectElement).value
      ).toBe('1024');
      expect(
        (document.getElementById('search-filter-size-unit-max') as HTMLSelectElement).value
      ).toBe('1048576');
    });

    it('does not trigger search when query is empty on clear', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('');

      document.getElementById('search-filter-clear')!.click();

      expect(mockSearchFiles).not.toHaveBeenCalled();
    });

    it('triggers search when query is present on clear', async () => {
      mockSearchFiles.mockResolvedValueOnce({ success: true, results: [] });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('test');

      document.getElementById('search-filter-clear')!.click();
      await vi.runAllTimersAsync();

      expect(mockSearchFiles).toHaveBeenCalled();
    });
  });

  describe('initListeners — content search toggle', () => {
    it('triggers performSearch when checked and query is present', async () => {
      mockSearchFilesWithContent.mockResolvedValueOnce({ success: true, results: [] });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('hello');

      const toggle = document.getElementById('search-in-contents-toggle') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));

      await vi.runAllTimersAsync();

      expect(mockSearchFilesWithContent).toHaveBeenCalled();
    });

    it('does not trigger search when unchecked with empty query', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('');

      const toggle = document.getElementById('search-in-contents-toggle') as HTMLInputElement;
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));

      expect(mockSearchFiles).not.toHaveBeenCalled();
      expect(mockSearchFilesWithContent).not.toHaveBeenCalled();
    });
  });

  describe('initListeners — search input keypress', () => {
    it('triggers performSearch on Enter key', async () => {
      mockSearchFiles.mockResolvedValueOnce({ success: true, results: [] });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('search term');

      const input = document.getElementById('search-input')!;
      input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter' }));

      await vi.runAllTimersAsync();

      expect(mockSearchFiles).toHaveBeenCalled();
    });

    it('hides history dropdown on Enter', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('test');

      ctrl.showSearchHistoryDropdown();
      const dropdown = document.getElementById('search-history-dropdown')!;
      expect(dropdown.style.display).toBe('block');

      const input = document.getElementById('search-input')!;
      input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter' }));

      expect(dropdown.style.display).toBe('none');
    });

    it('does not trigger search on non-Enter keys', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('test');

      const input = document.getElementById('search-input')!;
      input.dispatchEvent(new KeyboardEvent('keypress', { key: 'a' }));

      expect(mockSearchFiles).not.toHaveBeenCalled();
    });
  });

  describe('initListeners — search input event', () => {
    it('closes search when input becomes empty', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();

      const input = document.getElementById('search-input') as HTMLInputElement;
      input.value = '';
      input.dispatchEvent(new Event('input'));

      expect(ctrl.isSearchMode()).toBe(false);
    });

    it('triggers debounced search when input length >= 2', async () => {
      mockSearchFiles.mockResolvedValue({ success: true, results: [] });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();

      const input = document.getElementById('search-input') as HTMLInputElement;
      input.value = 'ab';
      input.dispatchEvent(new Event('input'));

      expect(mockSearchFiles).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(deps.searchDebounceMs + 10);

      expect(mockSearchFiles).toHaveBeenCalled();
    });

    it('does not trigger search when input length is 1', async () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();

      const input = document.getElementById('search-input') as HTMLInputElement;
      input.value = 'a';
      input.dispatchEvent(new Event('input'));

      await vi.advanceTimersByTimeAsync(deps.searchDebounceMs + 10);

      expect(mockSearchFiles).not.toHaveBeenCalled();
    });
  });

  describe('debouncedSearch', () => {
    it('debounces multiple rapid calls', async () => {
      mockSearchFiles.mockResolvedValue({ success: true, results: [] });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('debounce');

      ctrl.debouncedSearch();
      ctrl.debouncedSearch();
      ctrl.debouncedSearch();

      await vi.advanceTimersByTimeAsync(deps.searchDebounceMs + 10);

      expect(mockSearchFiles).toHaveBeenCalledTimes(1);
    });
  });

  describe('toggleSearchScope (via search-scope-toggle button)', () => {
    it('toggles between global and local scope', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();

      expect(ctrl.isGlobalSearch()).toBe(false);

      const scopeToggle = document.getElementById('search-scope-toggle')!;
      scopeToggle.click();

      expect(ctrl.isGlobalSearch()).toBe(true);

      scopeToggle.click();

      expect(ctrl.isGlobalSearch()).toBe(false);
    });

    it('updates scope toggle img src and alt', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();

      const scopeToggle = document.getElementById('search-scope-toggle')!;
      scopeToggle.click();

      const img = scopeToggle.querySelector('img')!;
      expect(img.src).toContain('1f30d.svg');
      expect(img.alt).toBe('🌍');

      scopeToggle.click();

      expect(img.src).toContain('1f4c1.svg');
      expect(img.alt).toBe('📁');
    });

    it('updates aria-pressed attribute', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();

      const scopeToggle = document.getElementById('search-scope-toggle')!;
      scopeToggle.click();

      expect(scopeToggle.getAttribute('aria-pressed')).toBe('true');

      scopeToggle.click();

      expect(scopeToggle.getAttribute('aria-pressed')).toBe('false');
    });

    it('updates placeholder text on scope change', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();

      const searchInput = document.getElementById('search-input') as HTMLInputElement;
      expect(searchInput.placeholder).toBe('Search files...');

      document.getElementById('search-scope-toggle')!.click();

      expect(searchInput.placeholder).toBe('Search all files...');
    });

    it('triggers search if query exists when scope toggles', async () => {
      mockSearchFiles.mockResolvedValue({ success: true, results: [] });
      mockSearchIndex.mockResolvedValue({ success: true, results: [] });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('query');

      document.getElementById('search-scope-toggle')!.click();

      await vi.runAllTimersAsync();

      expect(mockSearchIndex).toHaveBeenCalled();
    });

    it('does not trigger search if query is empty', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('');

      document.getElementById('search-scope-toggle')!.click();

      expect(mockSearchFiles).not.toHaveBeenCalled();
      expect(mockSearchIndex).not.toHaveBeenCalled();
    });
  });

  describe('updateFilterBadge — filter count', () => {
    it('shows badge count of 1 for single filter', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();

      (document.getElementById('search-filter-type') as HTMLSelectElement).value = 'image';
      document.getElementById('search-filter-apply')!.click();

      const badge = document.getElementById('filter-badge')!;
      expect(badge.style.display).toBe('flex');
      expect(badge.textContent).toBe('1');
    });

    it('shows badge count of 3 for three filters', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();

      (document.getElementById('search-filter-type') as HTMLSelectElement).value = 'document';
      (document.getElementById('search-filter-min-size') as HTMLInputElement).value = '10';
      (document.getElementById('search-filter-date-from') as HTMLInputElement).value = '2024-06-01';
      document.getElementById('search-filter-apply')!.click();

      const badge = document.getElementById('filter-badge')!;
      expect(badge.textContent).toBe('3');
    });

    it('hides badge when no filters are active', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();

      document.getElementById('search-filter-apply')!.click();

      const badge = document.getElementById('filter-badge')!;
      expect(badge.style.display).toBe('none');
    });
  });

  describe('syncSearchFilterAria', () => {
    it('sets aria-expanded to false initially', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();

      const filterToggle = document.getElementById('search-filter-toggle')!;
      expect(filterToggle.getAttribute('aria-expanded')).toBe('false');
    });
  });

  describe('initListeners — search-btn and search-close', () => {
    it('toggles search when search-btn is clicked', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();

      document.getElementById('search-btn')!.click();
      expect(ctrl.isSearchMode()).toBe(true);
    });

    it('closes search when search-close is clicked', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      expect(ctrl.isSearchMode()).toBe(true);

      document.getElementById('search-close')!.click();
      expect(ctrl.isSearchMode()).toBe(false);
    });
  });

  describe('closeSearch — resets filter and scope state', () => {
    it('hides filter panel and resets filter toggle active class', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();

      document.getElementById('search-filter-toggle')!.click();
      (document.getElementById('search-filter-type') as HTMLSelectElement).value = 'image';
      document.getElementById('search-filter-apply')!.click();

      expect(document.getElementById('filter-badge')!.style.display).toBe('flex');

      ctrl.closeSearch();

      expect(document.getElementById('search-filters-panel')!.style.display).toBe('none');
      expect(document.getElementById('filter-badge')!.style.display).toBe('none');
      expect(document.getElementById('search-filter-toggle')!.classList.contains('active')).toBe(
        false
      );
    });

    it('removes global class from scope toggle', () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.openSearch(true);

      expect(document.getElementById('search-scope-toggle')!.classList.contains('global')).toBe(
        true
      );

      ctrl.closeSearch();

      expect(document.getElementById('search-scope-toggle')!.classList.contains('global')).toBe(
        false
      );
    });
  });

  describe('performSearch — local content search error', () => {
    it('shows error toast on content search failure', async () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('term');

      const toggle = document.getElementById('search-in-contents-toggle') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      await vi.runAllTimersAsync();
      mockSearchFilesWithContent.mockResolvedValueOnce({ success: false, error: 'Read error' });

      await ctrl.performSearch();

      expect(deps.showToast).toHaveBeenCalledWith('Read error', 'Search Error', 'error');
    });

    it('ignores "Calculation cancelled" on content search', async () => {
      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('term');

      const toggle = document.getElementById('search-in-contents-toggle') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      await vi.runAllTimersAsync();
      deps.showToast.mockClear();
      mockSearchFilesWithContent.mockResolvedValueOnce({
        success: false,
        error: 'Calculation cancelled',
      });

      await ctrl.performSearch();

      expect(deps.showToast).not.toHaveBeenCalled();
    });
  });

  describe('performSearch — fileType "all" is treated as undefined', () => {
    it('does not include fileType in filters when value is "all"', async () => {
      mockSearchFiles.mockResolvedValueOnce({ success: true, results: [] });

      const deps = createDeps();
      const ctrl = createSearchController(deps as any);
      ctrl.initListeners();
      ctrl.toggleSearch();
      ctrl.setQuery('test');

      (document.getElementById('search-filter-date-from') as HTMLInputElement).value = '2024-01-01';
      document.getElementById('search-filter-apply')!.click();

      mockSearchFiles.mockClear();
      mockSearchFiles.mockResolvedValueOnce({ success: true, results: [] });
      await ctrl.performSearch();

      const filterArg = mockSearchFiles.mock.calls[0][2] as any;
      expect(filterArg.fileType).toBeUndefined();
      expect(filterArg.dateFrom).toBe('2024-01-01');
    });
  });

  describe('showSearchHistoryDropdown — history item click', () => {
    it('renders clickable history items with data-query attributes', () => {
      const deps = createDeps();
      deps.settings.searchHistory = ['alpha', 'beta'];
      const ctrl = createSearchController(deps as any);
      ctrl.showSearchHistoryDropdown();

      const dropdown = document.getElementById('search-history-dropdown')!;
      const items = dropdown.querySelectorAll('.history-item');
      expect(items.length).toBe(2);
      expect((items[0] as HTMLElement).dataset.query).toBe('alpha');
      expect((items[1] as HTMLElement).dataset.query).toBe('beta');
    });

    it('renders clear button in history dropdown', () => {
      const deps = createDeps();
      deps.settings.searchHistory = ['one'];
      const ctrl = createSearchController(deps as any);
      ctrl.showSearchHistoryDropdown();

      const dropdown = document.getElementById('search-history-dropdown')!;
      const clearBtn = dropdown.querySelector('[data-action="clear-search"]');
      expect(clearBtn).not.toBeNull();
      expect(clearBtn!.textContent).toContain('Clear Search History');
    });
  });
});
