import type { FileItem, Settings } from './types';
import { escapeHtml, ignoreError } from './shared.js';
import { clearHtml, getById } from './rendererDom.js';
import { twemojiImg } from './rendererUtils.js';
import { isHomeViewPath } from './home.js';

export type SearchFilters = {
  fileType?: string;
  minSize?: number;
  maxSize?: number;
  dateFrom?: string;
  dateTo?: string;
};

type SearchDeps = {
  getCurrentPath: () => string;
  getCurrentSettings: () => Settings;
  setAllFiles: (files: FileItem[]) => void;
  renderFiles: (files: FileItem[], highlight?: string) => void;
  showLoading: (text: string) => void;
  hideLoading: () => void;
  updateStatusBar: () => void;
  showToast: (
    message: string,
    title: string,
    type: 'success' | 'error' | 'info' | 'warning'
  ) => void;
  createDirectoryOperationId: (scope: string) => string;
  navigateTo: (path: string) => void;
  debouncedSaveSettings: () => void;
  saveSettingsWithTimestamp: (settings: Settings) => Promise<{ success: boolean; error?: string }>;
  getFileGrid: () => HTMLElement | null;
  searchDebounceMs: number;
  searchHistoryMax: number;
};

export function createSearchController(deps: SearchDeps) {
  let searchDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
  let searchRequestId = 0;
  let currentSearchFilters: SearchFilters = {};
  let activeSearchOperationId: string | null = null;
  let isSearchMode = false;
  let isGlobalSearch = false;
  let searchInContents = false;

  let searchBtn: HTMLButtonElement | null = null;
  let searchInput: HTMLInputElement | null = null;
  let searchBarWrapper: HTMLElement | null = null;
  let searchClose: HTMLButtonElement | null = null;
  let searchScopeToggle: HTMLButtonElement | null = null;
  let searchFilterToggle: HTMLButtonElement | null = null;
  let searchFiltersPanel: HTMLElement | null = null;
  let searchFilterType: HTMLSelectElement | null = null;
  let searchFilterMinSize: HTMLInputElement | null = null;
  let searchFilterMaxSize: HTMLInputElement | null = null;
  let searchFilterSizeUnitMin: HTMLSelectElement | null = null;
  let searchFilterSizeUnitMax: HTMLSelectElement | null = null;
  let searchFilterDateFrom: HTMLInputElement | null = null;
  let searchFilterDateTo: HTMLInputElement | null = null;
  let searchFilterClear: HTMLButtonElement | null = null;
  let searchFilterApply: HTMLButtonElement | null = null;
  let searchInContentsToggle: HTMLInputElement | null = null;

  function hasActiveFilters(): boolean {
    return !!(
      currentSearchFilters.fileType ||
      currentSearchFilters.minSize !== undefined ||
      currentSearchFilters.maxSize !== undefined ||
      currentSearchFilters.dateFrom ||
      currentSearchFilters.dateTo
    );
  }

  function applySearchScopeUi(global: boolean) {
    if (!searchScopeToggle) return;
    searchScopeToggle.classList.toggle('global', global);
    searchScopeToggle.title = global
      ? 'Global Search (All Indexed Files)'
      : 'Local Search (Current Folder)';
    const img = searchScopeToggle.querySelector('img');
    if (img) {
      img.src = global ? '../assets/twemoji/1f30d.svg' : '../assets/twemoji/1f4c1.svg';
      img.alt = global ? '🌍' : '📁';
    }
  }

  const ensureElements = () => {
    if (!searchBtn) searchBtn = getById('search-btn') as HTMLButtonElement | null;
    if (!searchInput) searchInput = getById('search-input') as HTMLInputElement | null;
    if (!searchBarWrapper)
      searchBarWrapper = document.querySelector('.search-bar-wrapper') as HTMLElement | null;
    if (!searchClose) searchClose = getById('search-close') as HTMLButtonElement | null;
    if (!searchScopeToggle)
      searchScopeToggle = getById('search-scope-toggle') as HTMLButtonElement | null;
    if (!searchFilterToggle)
      searchFilterToggle = getById('search-filter-toggle') as HTMLButtonElement | null;
    if (!searchFiltersPanel)
      searchFiltersPanel = getById('search-filters-panel') as HTMLElement | null;
    if (!searchFilterType)
      searchFilterType = getById('search-filter-type') as HTMLSelectElement | null;
    if (!searchFilterMinSize)
      searchFilterMinSize = getById('search-filter-min-size') as HTMLInputElement | null;
    if (!searchFilterMaxSize)
      searchFilterMaxSize = getById('search-filter-max-size') as HTMLInputElement | null;
    if (!searchFilterSizeUnitMin)
      searchFilterSizeUnitMin = getById('search-filter-size-unit-min') as HTMLSelectElement | null;
    if (!searchFilterSizeUnitMax)
      searchFilterSizeUnitMax = getById('search-filter-size-unit-max') as HTMLSelectElement | null;
    if (!searchFilterDateFrom)
      searchFilterDateFrom = getById('search-filter-date-from') as HTMLInputElement | null;
    if (!searchFilterDateTo)
      searchFilterDateTo = getById('search-filter-date-to') as HTMLInputElement | null;
    if (!searchFilterClear)
      searchFilterClear = getById('search-filter-clear') as HTMLButtonElement | null;
    if (!searchFilterApply)
      searchFilterApply = getById('search-filter-apply') as HTMLButtonElement | null;
    if (!searchInContentsToggle)
      searchInContentsToggle = getById('search-in-contents-toggle') as HTMLInputElement | null;
  };

  function debouncedSearch(delay: number = deps.searchDebounceMs) {
    if (searchDebounceTimeout) {
      clearTimeout(searchDebounceTimeout);
    }
    searchDebounceTimeout = setTimeout(() => {
      performSearch();
      searchDebounceTimeout = null;
    }, delay);
  }

  function cancelActiveSearch(): void {
    if (!activeSearchOperationId) return;
    window.electronAPI.cancelSearch(activeSearchOperationId).catch(ignoreError);
    activeSearchOperationId = null;
  }

  function toggleSearch() {
    ensureElements();
    if (!searchBarWrapper || !searchInput) return;

    if (searchBarWrapper.style.display === 'none' || !searchBarWrapper.style.display) {
      searchBarWrapper.style.display = 'block';
      searchInput.focus();
      isSearchMode = true;
      if (isHomeViewPath(deps.getCurrentPath()) && !isGlobalSearch) {
        toggleSearchScope();
      }
      updateSearchPlaceholder();
    } else {
      closeSearch();
    }
  }

  function closeSearch() {
    ensureElements();
    if (!searchBarWrapper || !searchInput || !searchScopeToggle || !searchFiltersPanel) return;
    searchRequestId += 1;
    cancelActiveSearch();
    if (searchDebounceTimeout) {
      clearTimeout(searchDebounceTimeout);
      searchDebounceTimeout = null;
    }
    searchBarWrapper.style.display = 'none';
    searchInput.value = '';
    isSearchMode = false;
    isGlobalSearch = false;
    searchScopeToggle.classList.remove('global');
    syncSearchScopeAria();
    hideSearchHistoryDropdown();
    updateSearchPlaceholder();

    searchFiltersPanel.style.display = 'none';
    searchFilterToggle?.classList.remove('active');
    syncSearchFilterAria();
    currentSearchFilters = {};
    updateFilterBadge();

    const currentPath = deps.getCurrentPath();
    if (currentPath) {
      deps.navigateTo(currentPath);
    }
  }

  function updateFilterBadge() {
    const badge = getById('filter-badge');
    if (!badge) return;

    let count = 0;
    if (currentSearchFilters.fileType) count++;
    if (currentSearchFilters.minSize !== undefined) count++;
    if (currentSearchFilters.maxSize !== undefined) count++;
    if (currentSearchFilters.dateFrom) count++;
    if (currentSearchFilters.dateTo) count++;

    if (count > 0) {
      badge.textContent = String(count);
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  function syncSearchScopeAria(): void {
    if (!searchScopeToggle) return;
    searchScopeToggle.setAttribute('aria-pressed', String(isGlobalSearch));
  }

  function syncSearchFilterAria(): void {
    if (!searchFilterToggle || !searchFiltersPanel) return;
    const isExpanded =
      searchFiltersPanel.style.display !== 'none' && searchFiltersPanel.style.display !== '';
    searchFilterToggle.setAttribute('aria-expanded', String(isExpanded));
  }

  function toggleSearchScope() {
    ensureElements();
    if (!searchScopeToggle) return;
    isGlobalSearch = !isGlobalSearch;
    applySearchScopeUi(isGlobalSearch);
    syncSearchScopeAria();
    updateSearchPlaceholder();
    updateContentSearchToggle();

    if (searchInput?.value.trim()) {
      performSearch();
    }
  }

  function updateContentSearchToggle() {
    ensureElements();
    if (!searchInContentsToggle) return;

    const settings = deps.getCurrentSettings();
    if (isGlobalSearch && !settings.globalContentSearch) {
      searchInContentsToggle.disabled = true;
      searchInContentsToggle.checked = false;
      searchInContents = false;
      searchInContentsToggle.parentElement?.classList.add('disabled');
      searchInContentsToggle.title =
        'Enable "Global Content Search" in settings to use this feature';
    } else {
      searchInContentsToggle.disabled = false;
      searchInContentsToggle.parentElement?.classList.remove('disabled');
      searchInContentsToggle.title = '';
    }
  }

  function updateSearchPlaceholder() {
    ensureElements();
    if (!searchInput) return;
    if (isGlobalSearch) {
      searchInput.placeholder = 'Search all files...';
    } else {
      searchInput.placeholder = 'Search files...';
    }
  }

  async function performSearch() {
    ensureElements();
    if (!searchInput) return;
    const query = searchInput.value.trim();
    if (!query) {
      searchRequestId += 1;
      cancelActiveSearch();
      return;
    }

    if (!isGlobalSearch && isHomeViewPath(deps.getCurrentPath())) {
      deps.showToast('Open a folder or use global search', 'Search', 'info');
      return;
    }

    if (!isGlobalSearch && !deps.getCurrentPath()) return;

    const currentRequestId = ++searchRequestId;
    cancelActiveSearch();
    const operationId = deps.createDirectoryOperationId('search');
    activeSearchOperationId = operationId;

    addToSearchHistory(query);

    deps.showLoading('Searching...');
    const fileGrid = deps.getFileGrid();
    if (fileGrid) clearHtml(fileGrid);

    let result;
    const hasFilters = hasActiveFilters() || searchInContents;

    if (isGlobalSearch) {
      if (searchInContents) {
        result = await window.electronAPI.searchFilesWithContentGlobal(
          query,
          hasFilters ? currentSearchFilters : undefined,
          operationId
        );
        if (currentRequestId !== searchRequestId) return;

        if (result.success && result.results) {
          deps.setAllFiles(result.results);
          deps.renderFiles(result.results, query);
        } else if (result.error !== 'Calculation cancelled') {
          if (result.error === 'Indexer is disabled') {
            deps.showToast(
              'File indexer is disabled. Enable it in settings to use global search.',
              'Index Disabled',
              'warning'
            );
          } else {
            deps.showToast(result.error || 'Global content search failed', 'Search Error', 'error');
          }
        }
      } else {
        result = await window.electronAPI.searchIndex(query, operationId);
        if (currentRequestId !== searchRequestId) return;

        if (result.success && result.results) {
          const fileItems: FileItem[] = [];

          for (const entry of result.results) {
            const isHidden = entry.name.startsWith('.');

            fileItems.push({
              name: entry.name,
              path: entry.path,
              isDirectory: entry.isDirectory,
              isFile: entry.isFile,
              size: entry.size,
              modified: entry.modified,
              isHidden,
            });
          }

          deps.setAllFiles(fileItems);
          deps.renderFiles(fileItems, query);
        } else if (result.error !== 'Calculation cancelled') {
          if (result.error === 'Indexer is disabled') {
            deps.showToast(
              'File indexer is disabled. Enable it in settings to use global search.',
              'Index Disabled',
              'warning'
            );
          } else {
            deps.showToast(result.error || 'Global search failed', 'Search Error', 'error');
          }
        }
      }
    } else {
      if (searchInContents) {
        result = await window.electronAPI.searchFilesWithContent(
          deps.getCurrentPath(),
          query,
          hasFilters ? currentSearchFilters : undefined,
          operationId
        );
      } else {
        result = await window.electronAPI.searchFiles(
          deps.getCurrentPath(),
          query,
          hasFilters ? currentSearchFilters : undefined,
          operationId
        );
      }
      if (currentRequestId !== searchRequestId) return;

      if (result.success && result.results) {
        deps.setAllFiles(result.results);
        deps.renderFiles(result.results, searchInContents ? query : undefined);
      } else if (result.error !== 'Calculation cancelled') {
        deps.showToast(result.error || 'Search failed', 'Search Error', 'error');
      }
    }

    if (currentRequestId !== searchRequestId) return;
    deps.hideLoading();
    deps.updateStatusBar();
    activeSearchOperationId = null;
  }

  function addToSearchHistory(query: string) {
    const settings = deps.getCurrentSettings();
    if (!settings.enableSearchHistory || !query.trim()) return;
    if (!settings.searchHistory) {
      settings.searchHistory = [];
    }
    const maxSearchHistoryItems = Math.max(
      1,
      Math.min(20, settings.maxSearchHistoryItems || deps.searchHistoryMax)
    );
    settings.searchHistory = settings.searchHistory.filter((item) => item !== query);
    settings.searchHistory.unshift(query);
    settings.searchHistory = settings.searchHistory.slice(0, maxSearchHistoryItems);
    deps.debouncedSaveSettings();
  }

  function showSearchHistoryDropdown() {
    const dropdown = getById('search-history-dropdown');
    const settings = deps.getCurrentSettings();
    if (!dropdown || !settings.enableSearchHistory) return;

    const history = settings.searchHistory || [];

    if (history.length === 0) {
      dropdown.innerHTML = '<div class="history-empty">No recent searches</div>';
    } else {
      dropdown.innerHTML =
        history
          .map(
            (item) =>
              `<div class="history-item" data-query="${escapeHtml(item)}">${twemojiImg(String.fromCodePoint(0x1f50d), 'twemoji')} ${escapeHtml(item)}</div>`
          )
          .join('') +
        `<div class="history-clear" data-action="clear-search">${twemojiImg(String.fromCodePoint(0x1f5d1), 'twemoji')} Clear Search History</div>`;
    }

    dropdown.style.display = 'block';
  }

  function hideSearchHistoryDropdown() {
    const dropdown = getById('search-history-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  }

  function clearSearchHistory() {
    const settings = deps.getCurrentSettings();
    settings.searchHistory = [];
    deps.saveSettingsWithTimestamp(settings);
    hideSearchHistoryDropdown();
    deps.showToast('Search history cleared', 'History', 'success');
  }

  function openSearch(isGlobal: boolean): void {
    ensureElements();
    if (!searchBarWrapper || !searchScopeToggle || !searchInput) return;

    if (!isSearchMode) {
      searchBarWrapper.style.display = 'block';
      isSearchMode = true;
    }

    isGlobalSearch = isGlobal;
    applySearchScopeUi(isGlobalSearch);
    updateSearchPlaceholder();
    searchInput.focus();
  }

  function initListeners(): void {
    ensureElements();
    syncSearchScopeAria();
    syncSearchFilterAria();
    searchBtn?.addEventListener('click', toggleSearch);
    searchClose?.addEventListener('click', closeSearch);
    searchScopeToggle?.addEventListener('click', toggleSearchScope);

    searchFilterToggle?.addEventListener('click', () => {
      if (!searchFiltersPanel || !searchFilterToggle) return;
      if (searchFiltersPanel.style.display === 'none' || !searchFiltersPanel.style.display) {
        searchFiltersPanel.style.display = 'block';
        searchFilterToggle.classList.add('active');
      } else {
        searchFiltersPanel.style.display = 'none';
        searchFilterToggle.classList.remove('active');
      }
      syncSearchFilterAria();
    });

    searchFilterApply?.addEventListener('click', () => {
      if (
        !searchFilterType ||
        !searchFilterMinSize ||
        !searchFilterMaxSize ||
        !searchFilterSizeUnitMin ||
        !searchFilterSizeUnitMax ||
        !searchFilterDateFrom ||
        !searchFilterDateTo ||
        !searchFiltersPanel ||
        !searchFilterToggle
      ) {
        return;
      }

      const fileType = searchFilterType.value;
      const minSizeValue = searchFilterMinSize.value
        ? parseFloat(searchFilterMinSize.value)
        : undefined;
      const maxSizeValue = searchFilterMaxSize.value
        ? parseFloat(searchFilterMaxSize.value)
        : undefined;
      const minSizeUnit = parseFloat(searchFilterSizeUnitMin.value);
      const maxSizeUnit = parseFloat(searchFilterSizeUnitMax.value);

      const minSizeBytes = minSizeValue !== undefined ? minSizeValue * minSizeUnit : undefined;
      const maxSizeBytes = maxSizeValue !== undefined ? maxSizeValue * maxSizeUnit : undefined;

      if (minSizeBytes !== undefined && maxSizeBytes !== undefined && minSizeBytes > maxSizeBytes) {
        deps.showToast('Min size cannot be greater than max size', 'Invalid Filter', 'warning');
        searchFilterMinSize.focus();
        return;
      }

      const dateFrom = searchFilterDateFrom.value || undefined;
      const dateTo = searchFilterDateTo.value || undefined;

      if (dateFrom && dateTo && dateFrom > dateTo) {
        deps.showToast('Start date cannot be after end date', 'Invalid Filter', 'warning');
        searchFilterDateFrom.focus();
        return;
      }

      currentSearchFilters = {
        fileType: fileType !== 'all' ? fileType : undefined,
        minSize: minSizeBytes,
        maxSize: maxSizeBytes,
        dateFrom,
        dateTo,
      };

      if (hasActiveFilters()) {
        searchFilterToggle.classList.add('active');
      }
      updateFilterBadge();

      searchFiltersPanel.style.display = 'none';
      syncSearchFilterAria();

      if (searchInput?.value.trim()) {
        performSearch();
      }
    });

    searchFilterClear?.addEventListener('click', () => {
      if (
        !searchFilterType ||
        !searchFilterMinSize ||
        !searchFilterMaxSize ||
        !searchFilterSizeUnitMin ||
        !searchFilterSizeUnitMax ||
        !searchFilterDateFrom ||
        !searchFilterDateTo ||
        !searchFilterToggle
      ) {
        return;
      }

      searchFilterType.value = 'all';
      searchFilterMinSize.value = '';
      searchFilterMaxSize.value = '';
      searchFilterSizeUnitMin.value = '1024';
      searchFilterSizeUnitMax.value = '1048576';
      searchFilterDateFrom.value = '';
      searchFilterDateTo.value = '';
      currentSearchFilters = {};
      searchFilterToggle.classList.remove('active');
      updateFilterBadge();
      syncSearchFilterAria();

      if (searchInput?.value.trim()) {
        performSearch();
      }
    });

    searchInContentsToggle?.addEventListener('change', () => {
      if (!searchInContentsToggle) return;
      searchInContents = searchInContentsToggle.checked;
      if (searchInput?.value.trim()) {
        performSearch();
      }
    });

    searchInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        hideSearchHistoryDropdown();
        performSearch();
      }
    });

    searchInput?.addEventListener('input', () => {
      if (!searchInput) return;
      if (searchInput.value.length === 0) {
        closeSearch();
      } else if (searchInput.value.length >= 2) {
        debouncedSearch();
      }
    });
  }

  function getStatusText(): { active: boolean; text: string } {
    ensureElements();
    if (!isSearchMode) return { active: false, text: '' };
    const query = searchInput?.value || '';
    let searchText = isGlobalSearch ? 'Global' : 'Search';

    if (query) {
      const truncated = query.length > 20 ? query.slice(0, 20) + '...' : query;
      searchText += `: "${truncated}"`;
    }

    if (hasActiveFilters()) {
      searchText += ' (filtered)';
    }

    return { active: true, text: searchText };
  }

  function isSearchActive(): boolean {
    return isSearchMode;
  }

  function isGlobalSearchActive(): boolean {
    return isGlobalSearch;
  }

  function getQuery(): string {
    ensureElements();
    return searchInput?.value || '';
  }

  function setQuery(query: string): void {
    ensureElements();
    if (searchInput) {
      searchInput.value = query;
    }
  }

  function focusInput(): void {
    ensureElements();
    searchInput?.focus();
  }

  function getSearchInputElement(): HTMLInputElement | null {
    ensureElements();
    return searchInput;
  }

  return {
    initListeners,
    toggleSearch,
    closeSearch,
    openSearch,
    performSearch,
    debouncedSearch,
    cancelActiveSearch,
    updateContentSearchToggle,
    updateSearchPlaceholder,
    showSearchHistoryDropdown,
    hideSearchHistoryDropdown,
    clearSearchHistory,
    addToSearchHistory,
    getStatusText,
    isSearchMode: isSearchActive,
    isGlobalSearch: isGlobalSearchActive,
    getQuery,
    setQuery,
    focusInput,
    getSearchInputElement,
  };
}
