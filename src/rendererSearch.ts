import type { FileItem, SavedSearch, SearchFilters, Settings } from './types';
import { escapeHtml, ignoreError } from './shared.js';
import { clearHtml, getById } from './rendererDom.js';
import { twemojiImg } from './rendererUtils.js';
import { isHomeViewPath } from './home.js';

type SearchDeps = {
  getCurrentPath: () => string;
  getSearchScopePath?: () => string;
  getSearchScopeLabel?: () => string;
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
  navigateTo: (path: string) => Promise<void>;
  debouncedSaveSettings: () => void;
  saveSettingsWithTimestamp: (settings: Settings) => Promise<{ success: boolean; error?: string }>;
  getFileGrid: () => HTMLElement | null;
  setHomeViewActive: (active: boolean) => void;
  searchDebounceMs: number;
  searchHistoryMax: number;
  announceToScreenReader?: (message: string) => void;
};

export function createSearchController(deps: SearchDeps) {
  function getLocalSearchPath(): string {
    return deps.getSearchScopePath ? deps.getSearchScopePath() : deps.getCurrentPath();
  }

  function includeHidden(): boolean {
    return deps.getCurrentSettings().showHiddenFiles === true;
  }

  let searchDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
  let searchRequestId = 0;
  let currentSearchFilters: SearchFilters = {};
  let activeSearchOperationId: string | null = null;
  let isSearchMode = false;
  let isGlobalSearch = false;
  let searchInContents = false;
  let isRegexMode = false;

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
  let searchRegexToggle: HTMLButtonElement | null = null;
  let searchSaveBtn: HTMLButtonElement | null = null;
  let searchHistoryActiveIndex = -1;

  // Keep in sync with the backend caps in src-tauri/src/search.rs and indexer.rs.
  const SEARCH_NAME_RESULTS_CAP = 10_000;
  const SEARCH_CONTENT_RESULTS_CAP = 5_000;

  function showSearchEmptyState(query: string): void {
    const fileGrid = deps.getFileGrid();
    if (!fileGrid) return;

    const suggestions: string[] = [
      'Check for typos in your search term',
      'Try a broader search query',
    ];
    if (!isGlobalSearch) {
      suggestions.push('Try Global Search to search all indexed files');
    }
    if (!searchInContents) {
      suggestions.push('Enable "Search in file contents" to search inside files');
    }
    if (hasActiveFilters()) {
      suggestions.push('Clear search filters to broaden results');
    }

    const suggestionsHtml = suggestions.map((s) => `<li>${escapeHtml(s)}</li>`).join('');

    // eslint-disable-next-line no-restricted-syntax -- user data via escapeHtml(); icons/numerics are safe
    fileGrid.innerHTML = `<div class="search-empty-state">
      ${twemojiImg('search', 'twemoji-large', 'Search')}
      <h3>No results found</h3>
      <p>No files matching "${escapeHtml(query)}" were found.</p>
      <ul>${suggestionsHtml}</ul>
    </div>`;
  }

  function showResultsCapBanner(
    count: number,
    cap: number = searchInContents ? SEARCH_CONTENT_RESULTS_CAP : SEARCH_NAME_RESULTS_CAP
  ): void {
    if (count < cap) return;
    const fileGrid = deps.getFileGrid();
    if (!fileGrid) return;

    const banner = document.createElement('div');
    banner.className = 'search-results-cap-banner';
    banner.setAttribute('role', 'status');
    banner.textContent = `Showing first ${cap.toLocaleString()} results. Refine your search to see more specific matches.`;
    fileGrid.prepend(banner);
  }

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
    searchScopeToggle.innerHTML = twemojiImg(
      global ? 'globe' : 'folder',
      'twemoji',
      global ? '🌍' : '📁'
    );
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
    if (!searchRegexToggle)
      searchRegexToggle = getById('search-regex-toggle') as HTMLButtonElement | null;
    if (!searchSaveBtn) searchSaveBtn = getById('search-save-btn') as HTMLButtonElement | null;
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
    window.tauriAPI.cancelSearch(activeSearchOperationId).catch(ignoreError);
    activeSearchOperationId = null;
  }

  function toggleSearch() {
    ensureElements();
    if (!searchBarWrapper || !searchInput) return;

    if (searchBarWrapper.style.display === 'none' || !searchBarWrapper.style.display) {
      searchBarWrapper.style.display = 'block';
      searchInput.focus();
      isSearchMode = true;
      syncSaveBtnState();
      if (isHomeViewPath(deps.getCurrentPath()) && !isGlobalSearch) {
        toggleSearchScope();
      }
      updateSearchPlaceholder();
    } else {
      closeSearch();
    }
  }

  function closeSearch(options: { restoreCurrentPath?: boolean } = {}) {
    ensureElements();
    if (!searchBarWrapper || !searchInput || !searchScopeToggle || !searchFiltersPanel) return;
    const shouldRestoreCurrentPath = options.restoreCurrentPath ?? true;
    searchRequestId += 1;
    cancelActiveSearch();
    deps.hideLoading();
    if (searchDebounceTimeout) {
      clearTimeout(searchDebounceTimeout);
      searchDebounceTimeout = null;
    }
    searchBarWrapper.style.display = 'none';
    searchInput.value = '';
    searchInput.classList.remove('input-error');
    isSearchMode = false;
    isGlobalSearch = false;
    isRegexMode = false;
    searchInContents = false;
    if (searchRegexToggle) {
      searchRegexToggle.classList.remove('active');
      searchRegexToggle.setAttribute('aria-pressed', 'false');
    }
    searchScopeToggle.classList.remove('global');
    syncSearchScopeAria();
    hideSearchHistoryDropdown();
    updateSearchPlaceholder();

    searchFiltersPanel.style.display = 'none';
    searchFilterToggle?.classList.remove('active');
    syncSearchFilterAria();
    currentSearchFilters = {};
    updateFilterBadge();
    syncSaveBtnState();

    const currentPath = deps.getCurrentPath();
    if (shouldRestoreCurrentPath && currentPath) {
      void Promise.resolve(deps.navigateTo(currentPath)).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        deps.showToast(message || 'Failed to restore folder', 'Search', 'error');
      });
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
      const scopeLabel = deps.getSearchScopeLabel?.();
      searchInput.placeholder = scopeLabel ? `Search ${scopeLabel}...` : 'Search files...';
    }
  }

  async function performSearch() {
    let loadingShown = false;
    let operationIdForCleanup: string | null = null;
    let currentRequestId = 0;
    let matchedResultCount: number | null = null;
    try {
      ensureElements();
      if (!searchInput) return;
      const query = searchInput.value.trim();
      if (!query) {
        searchRequestId += 1;
        cancelActiveSearch();
        closeSearch();
        return;
      }

      const localSearchPath = getLocalSearchPath();
      if (!isGlobalSearch && isHomeViewPath(localSearchPath)) {
        deps.showToast('Open a folder or use global search', 'Search', 'info');
        return;
      }

      if (!isGlobalSearch && !localSearchPath) return;

      currentRequestId = ++searchRequestId;
      cancelActiveSearch();
      const operationId = deps.createDirectoryOperationId('search');
      activeSearchOperationId = operationId;
      operationIdForCleanup = operationId;

      // Validate regex BEFORE touching history or clearing the grid
      const hasFilters = hasActiveFilters() || searchInContents || isRegexMode;
      if (isRegexMode) {
        currentSearchFilters.regex = true;
        if (query.length > 1000) {
          deps.showToast('Regex pattern too long (max 1000 characters)', 'Search', 'warning');
          searchInput?.classList.add('input-error');
          activeSearchOperationId = null;
          return;
        }
        try {
          new RegExp(query);
        } catch {
          deps.showToast('Invalid regular expression pattern', 'Search', 'warning');
          searchInput?.classList.add('input-error');
          activeSearchOperationId = null;
          return;
        }
        searchInput?.classList.remove('input-error');
      } else {
        delete currentSearchFilters.regex;
        searchInput?.classList.remove('input-error');
      }

      addToSearchHistory(query);

      deps.showLoading('Searching...');
      loadingShown = true;

      let result;

      if (isHomeViewPath(deps.getCurrentPath())) {
        deps.setHomeViewActive(false);
      }
      const columnView = document.getElementById('column-view');
      const fileGrid = deps.getFileGrid();
      if (columnView && fileGrid && columnView.style.display !== 'none') {
        columnView.style.display = 'none';
        fileGrid.style.display = '';
      }

      if (isGlobalSearch) {
        if (searchInContents) {
          result = await window.tauriAPI.searchFilesWithContentGlobal(
            query,
            hasFilters ? currentSearchFilters : undefined,
            operationId,
            includeHidden()
          );
          if (currentRequestId !== searchRequestId) return;
          const fileGrid = deps.getFileGrid();
          if (fileGrid) clearHtml(fileGrid);

          if (!result.success) {
            if (result.error !== 'Calculation cancelled') {
              if (result.error === 'Indexer is disabled') {
                deps.showToast(
                  'File indexer is disabled. Enable it in settings to use global search.',
                  'Index Disabled',
                  'warning'
                );
              } else {
                deps.showToast(result.error || 'Search failed', 'Search Error', 'error');
              }
            }
          } else {
            deps.setAllFiles(result.results);
            matchedResultCount = result.results.length;
            deps.renderFiles(result.results, query);
            if (result.results.length === 0) showSearchEmptyState(query);
            else showResultsCapBanner(result.results.length);
          }
        } else {
          // The backend only accepts filters/hidden state when they are actually
          // set, so the two-argument call stays intact for the common case.
          const shouldIncludeHidden = includeHidden();
          if (hasFilters || shouldIncludeHidden) {
            result = await window.tauriAPI.searchIndex(
              query,
              operationId,
              hasFilters ? currentSearchFilters : undefined,
              shouldIncludeHidden
            );
          } else {
            result = await window.tauriAPI.searchIndex(query, operationId);
          }
          if (currentRequestId !== searchRequestId) return;
          const fileGrid2 = deps.getFileGrid();
          if (fileGrid2) clearHtml(fileGrid2);

          if (!result.success) {
            if (result.error !== 'Calculation cancelled') {
              if (result.error === 'Indexer is disabled') {
                deps.showToast(
                  'File indexer is disabled. Enable it in settings to use global search.',
                  'Index Disabled',
                  'warning'
                );
              } else {
                deps.showToast(result.error || 'Search failed', 'Search Error', 'error');
              }
            }
          } else {
            const fileItems: FileItem[] = [];

            for (const entry of result.results) {
              const isHidden = entry.isHidden ?? entry.name.startsWith('.');

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
            matchedResultCount = fileItems.length;
            deps.renderFiles(fileItems, query);
            if (fileItems.length === 0) showSearchEmptyState(query);
            else showResultsCapBanner(fileItems.length);
          }
        }
      } else {
        if (searchInContents) {
          result = await window.tauriAPI.searchFilesWithContent(
            localSearchPath,
            query,
            hasFilters ? currentSearchFilters : undefined,
            operationId,
            includeHidden()
          );
        } else {
          result = await window.tauriAPI.searchFiles(
            localSearchPath,
            query,
            hasFilters ? currentSearchFilters : undefined,
            operationId,
            includeHidden()
          );
        }
        if (currentRequestId !== searchRequestId) return;
        const fileGrid3 = deps.getFileGrid();
        if (fileGrid3) clearHtml(fileGrid3);

        if (!result.success) {
          if (result.error !== 'Calculation cancelled') {
            deps.showToast(result.error || 'Search failed', 'Search Error', 'error');
          }
        } else {
          deps.setAllFiles(result.results);
          matchedResultCount = result.results.length;
          deps.renderFiles(result.results, searchInContents ? query : undefined);
          if (result.results.length === 0) showSearchEmptyState(query);
          else showResultsCapBanner(result.results.length);
        }
      }

      if (currentRequestId !== searchRequestId) return;
      deps.updateStatusBar();
      activeSearchOperationId = null;

      // Announce the matched result count, not the mounted DOM rows: batched and
      // virtualized renders mount fewer rows than the backend actually returned.
      const resultCount =
        matchedResultCount ?? (deps.getFileGrid()?.querySelectorAll('.file-item') ?? []).length;
      deps.announceToScreenReader?.(
        resultCount === 0
          ? 'No results found'
          : `${resultCount} result${resultCount !== 1 ? 's' : ''} found`
      );
    } catch {
      deps.showToast('Search failed unexpectedly', 'Search Error', 'error');
      activeSearchOperationId = null;
    } finally {
      if (loadingShown && currentRequestId === searchRequestId) {
        deps.hideLoading();
      }
      if (operationIdForCleanup && activeSearchOperationId === operationIdForCleanup) {
        activeSearchOperationId = null;
      }
    }
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

  function renderSavedSearchesSection(): string {
    const settings = deps.getCurrentSettings();
    const saved = (settings.savedSearches || [])
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const aLastUsed = Date.parse(a.entry.lastUsedAt || a.entry.createdAt || '');
        const bLastUsed = Date.parse(b.entry.lastUsedAt || b.entry.createdAt || '');
        if (Number.isFinite(aLastUsed) && Number.isFinite(bLastUsed) && aLastUsed !== bLastUsed) {
          return bLastUsed - aLastUsed;
        }
        const aUseCount = a.entry.useCount ?? 0;
        const bUseCount = b.entry.useCount ?? 0;
        if (aUseCount !== bUseCount) return bUseCount - aUseCount;
        return a.entry.name.localeCompare(b.entry.name);
      });

    if (saved.length === 0) return '';

    const items = saved
      .map(({ entry: s, index }) => {
        const badges: string[] = [];
        if (s.isGlobal) badges.push('<span class="saved-search-badge">Global</span>');
        if (s.isRegex) badges.push('<span class="saved-search-badge">Regex</span>');
        if (!s.isGlobal && s.scopePath)
          badges.push('<span class="saved-search-badge">Scoped</span>');
        if (s.filters && Object.keys(s.filters).length > 0)
          badges.push('<span class="saved-search-badge">Filtered</span>');
        const tooltipParts = [s.query];
        if (!s.isGlobal && s.scopePath) {
          tooltipParts.push(`Scope: ${s.scopePath}`);
        }
        if (s.useCount && s.useCount > 0) {
          tooltipParts.push(`Used ${s.useCount} time${s.useCount === 1 ? '' : 's'}`);
        }
        return `<div class="saved-search-row" role="group" aria-label="Saved search ${escapeHtml(s.name)}">
          <div class="saved-search-item" id="search-history-saved-${index}" data-saved-index="${index}" data-option-action="saved" role="option" aria-selected="false">
            ${twemojiImg('star', 'twemoji')}
            <span class="saved-search-name" title="${escapeHtml(tooltipParts.join('\n'))}">${escapeHtml(s.name)}</span>
            <span class="saved-search-badges">${badges.join('')}</span>
          </div>
          <button type="button" class="saved-search-delete" id="search-history-delete-${index}" data-delete-index="${index}" data-option-action="delete-saved" role="option" aria-selected="false" aria-label="Delete saved search ${escapeHtml(s.name)}" title="Delete saved search">&times;</button>
        </div>`;
      })
      .join('');

    return `<div class="saved-search-section" role="presentation">${items}</div>`;
  }

  function showSearchHistoryDropdown() {
    const dropdown = getById('search-history-dropdown');
    const settings = deps.getCurrentSettings();
    if (!dropdown) return;
    if (!settings.enableSearchHistory) {
      hideSearchHistoryDropdown();
      return;
    }

    const history = settings.searchHistory || [];
    const savedHtml = renderSavedSearchesSection();

    let historyHtml: string;
    if (history.length === 0 && !savedHtml) {
      historyHtml = '<div class="history-empty">No recent searches</div>';
    } else {
      historyHtml =
        history
          .map(
            (item, index) =>
              `<div class="history-item" id="search-history-recent-${index}" data-query="${escapeHtml(item)}" data-option-action="recent" role="option" aria-selected="false">${twemojiImg('search', 'twemoji')} ${escapeHtml(item)}</div>`
          )
          .join('') +
        (history.length > 0
          ? `<div class="history-clear" id="search-history-clear" data-action="clear-search" data-option-action="clear" role="option" aria-selected="false">${twemojiImg('trash-2', 'twemoji')} Clear Search History</div>`
          : '');
    }

    dropdown.innerHTML = savedHtml + historyHtml;
    dropdown.style.display = 'block';
    searchHistoryActiveIndex = -1;
    ensureElements();
    searchInput?.setAttribute('aria-controls', 'search-history-dropdown');
    searchInput?.setAttribute('aria-expanded', 'true');
    searchInput?.removeAttribute('aria-activedescendant');
  }

  function hideSearchHistoryDropdown() {
    const dropdown = getById('search-history-dropdown');
    if (dropdown) {
      dropdown.style.display = 'none';
      dropdown.querySelectorAll('[role="option"]').forEach((option) => {
        option.classList.remove('dropdown-active');
        option.setAttribute('aria-selected', 'false');
      });
    }
    searchHistoryActiveIndex = -1;
    ensureElements();
    searchInput?.setAttribute('aria-expanded', 'false');
    searchInput?.removeAttribute('aria-activedescendant');
  }

  function getSearchHistoryOptions(dropdown: HTMLElement): HTMLElement[] {
    return Array.from(dropdown.querySelectorAll<HTMLElement>('[role="option"]'));
  }

  function setActiveSearchHistoryOption(options: HTMLElement[], index: number): void {
    if (options.length === 0) return;
    searchHistoryActiveIndex = (index + options.length) % options.length;
    options.forEach((option, optionIndex) => {
      const selected = optionIndex === searchHistoryActiveIndex;
      option.classList.toggle('dropdown-active', selected);
      option.setAttribute('aria-selected', String(selected));
    });
    const active = options[searchHistoryActiveIndex];
    if (active?.id) searchInput?.setAttribute('aria-activedescendant', active.id);
    active?.scrollIntoView({ block: 'nearest' });
  }

  async function activateSearchHistoryOption(option: HTMLElement): Promise<void> {
    const action = option.dataset.optionAction;
    if (action === 'saved') {
      const index = Number.parseInt(option.dataset.savedIndex || '', 10);
      if (Number.isFinite(index)) await loadSavedSearch(index);
      return;
    }
    if (action === 'delete-saved') {
      const index = Number.parseInt(option.dataset.deleteIndex || '', 10);
      if (Number.isFinite(index)) {
        deleteSavedSearch(index);
        searchInput?.focus();
      }
      return;
    }
    if (action === 'recent' && option.dataset.query !== undefined) {
      ensureElements();
      if (!searchInput) return;
      searchInput.value = option.dataset.query;
      syncSaveBtnState();
      hideSearchHistoryDropdown();
      searchInput.focus();
      await performSearch();
      return;
    }
    if (action === 'clear') {
      hideSearchHistoryDropdown();
      searchInput?.focus();
      try {
        await clearSearchHistory();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.showToast(message || 'Failed to clear search history', 'History', 'error');
      }
    }
  }

  async function clearSearchHistory() {
    const settings = deps.getCurrentSettings();
    settings.searchHistory = [];
    hideSearchHistoryDropdown();
    try {
      const result = await deps.saveSettingsWithTimestamp(settings);
      if (!result.success) {
        deps.showToast(result.error || 'Failed to clear search history', 'History', 'error');
        return;
      }
      deps.showToast('Search history cleared', 'History', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.showToast(message || 'Failed to clear search history', 'History', 'error');
    }
  }

  function saveCurrentSearch(): void {
    ensureElements();
    const query = searchInput?.value.trim();
    if (!query) {
      deps.showToast('Enter a search query first', 'Save Search', 'info');
      return;
    }

    const name = window.prompt('Name for this saved search:', query);
    if (!name || !name.trim()) return;

    const settings = deps.getCurrentSettings();
    if (!settings.savedSearches) settings.savedSearches = [];

    const now = new Date().toISOString();
    const normalizedName = name.trim().slice(0, 100);
    const existingIndex = settings.savedSearches.findIndex(
      (entry) => entry.name.toLowerCase() === normalizedName.toLowerCase()
    );
    const existing = existingIndex >= 0 ? settings.savedSearches[existingIndex] : null;

    if (settings.savedSearches.length >= 50 && existingIndex < 0) {
      deps.showToast('Maximum of 50 saved searches reached', 'Save Search', 'warning');
      return;
    }

    const entry: SavedSearch = {
      name: normalizedName,
      query,
      isGlobal: isGlobalSearch,
      isRegex: isRegexMode,
      createdAt: existing?.createdAt || now,
      lastUsedAt: now,
      useCount: existing?.useCount ?? 0,
      scopePath: isGlobalSearch ? undefined : getLocalSearchPath(),
    };

    if (hasActiveFilters()) {
      const { regex: _regex, ...filtersCopy } = currentSearchFilters;
      entry.filters = filtersCopy;
    }

    if (existingIndex >= 0) {
      settings.savedSearches[existingIndex] = entry;
    } else {
      settings.savedSearches.push(entry);
    }
    deps.debouncedSaveSettings();
    deps.showToast(
      existingIndex >= 0 ? `Search "${entry.name}" updated` : `Search "${entry.name}" saved`,
      'Saved Search',
      'success'
    );
  }

  function deleteSavedSearch(index: number): void {
    const settings = deps.getCurrentSettings();
    if (!settings.savedSearches || index < 0 || index >= settings.savedSearches.length) return;
    const removed = settings.savedSearches.splice(index, 1);
    deps.debouncedSaveSettings();
    deps.showToast(`Removed "${removed[0]?.name}"`, 'Saved Search', 'info');
    showSearchHistoryDropdown();
  }

  async function loadSavedSearch(index: number): Promise<void> {
    const settings = deps.getCurrentSettings();
    if (!settings.savedSearches || index < 0 || index >= settings.savedSearches.length) return;
    const saved = settings.savedSearches[index]!;

    saved.lastUsedAt = new Date().toISOString();
    saved.useCount = (saved.useCount ?? 0) + 1;
    if (!saved.isGlobal && !saved.scopePath) {
      saved.scopePath = deps.getCurrentPath();
    }
    deps.debouncedSaveSettings();

    ensureElements();
    if (!searchBarWrapper || !searchInput || !searchScopeToggle) return;

    if (!isSearchMode) {
      searchBarWrapper.style.display = 'block';
      isSearchMode = true;
    }

    isGlobalSearch = saved.isGlobal;
    applySearchScopeUi(isGlobalSearch);
    syncSearchScopeAria();
    updateSearchPlaceholder();

    isRegexMode = saved.isRegex;
    if (searchRegexToggle) {
      searchRegexToggle.classList.toggle('active', isRegexMode);
      searchRegexToggle.setAttribute('aria-pressed', String(isRegexMode));
    }

    if (saved.filters && Object.keys(saved.filters).length > 0) {
      currentSearchFilters = { ...saved.filters };
    } else {
      currentSearchFilters = {};
    }
    updateFilterBadge();

    searchInput.value = saved.query;
    syncSaveBtnState();
    hideSearchHistoryDropdown();
    try {
      if (!saved.isGlobal && saved.scopePath && !isHomeViewPath(saved.scopePath)) {
        await deps.navigateTo(saved.scopePath);
      }
      await performSearch();
    } catch (error) {
      // Navigation can fail when a saved scope was removed or is inaccessible.
      // Keep the restored query usable, but never leak an unhandled rejection
      // from pointer/keyboard activation of the history listbox.
      const message = error instanceof Error ? error.message : String(error);
      deps.showToast(message || 'Failed to open saved search scope', 'Saved Search', 'error');
    } finally {
      hideSearchHistoryDropdown();
      searchInput.focus();
    }
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
    searchInput?.setAttribute('role', 'combobox');
    searchInput?.setAttribute('aria-autocomplete', 'list');
    searchInput?.setAttribute('aria-haspopup', 'listbox');
    searchBtn?.addEventListener('click', toggleSearch);
    searchClose?.addEventListener('click', () => closeSearch());
    searchScopeToggle?.addEventListener('click', toggleSearchScope);

    searchSaveBtn?.addEventListener('click', saveCurrentSearch);

    const dropdown = getById('search-history-dropdown');
    dropdown?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const actionTarget = target.closest<HTMLElement>('[data-option-action]');
      if (actionTarget) void activateSearchHistoryOption(actionTarget);
    });
    dropdown?.addEventListener('mousedown', (event) => {
      // Keep the search input focused for listbox navigation, but allow the
      // native delete button to receive pointer focus and activation.
      if (!(event.target as HTMLElement).closest('.saved-search-delete')) event.preventDefault();
    });
    searchInput?.addEventListener('focus', showSearchHistoryDropdown);

    searchRegexToggle?.addEventListener('click', () => {
      isRegexMode = !isRegexMode;
      searchRegexToggle?.classList.toggle('active', isRegexMode);
      searchRegexToggle?.setAttribute('aria-pressed', String(isRegexMode));
      if (isSearchMode && searchInput?.value) {
        debouncedSearch();
      }
    });

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

    searchInput?.addEventListener('keydown', (e) => {
      const dropdown = getById('search-history-dropdown');
      const isOpen = !!dropdown && dropdown.style.display === 'block';
      const items = dropdown ? getSearchHistoryOptions(dropdown) : [];

      if (isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const start =
          searchHistoryActiveIndex < 0 ? (delta > 0 ? -1 : 0) : searchHistoryActiveIndex;
        setActiveSearchHistoryOption(items, start + delta);
      } else if (isOpen && (e.key === 'Home' || e.key === 'End')) {
        e.preventDefault();
        setActiveSearchHistoryOption(items, e.key === 'Home' ? 0 : items.length - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const active = isOpen ? items[searchHistoryActiveIndex] : undefined;
        if (active) void activateSearchHistoryOption(active);
        else {
          hideSearchHistoryDropdown();
          void performSearch();
        }
      } else if (isOpen && e.key === 'Escape') {
        e.preventDefault();
        hideSearchHistoryDropdown();
        searchInput?.focus();
      }
    });

    searchInput?.addEventListener('input', () => {
      if (!searchInput) return;
      syncSaveBtnState();
      if (searchInput.value.length === 0) {
        closeSearch();
      } else if (searchInput.value.length >= 2) {
        debouncedSearch();
      }
    });
  }

  function syncSaveBtnState(): void {
    if (!searchSaveBtn) return;
    const hasQuery = !!(searchInput && searchInput.value.trim());
    searchSaveBtn.disabled = !hasQuery;
  }

  function getStatusText(): { active: boolean; text: string } {
    ensureElements();
    if (!isSearchMode) return { active: false, text: '' };
    const query = searchInput?.value || '';
    let searchText = isGlobalSearch ? 'Global' : 'Search';
    if (!isGlobalSearch) {
      const scopeLabel = deps.getSearchScopeLabel?.();
      if (scopeLabel && scopeLabel !== 'files') {
        searchText += ` (${scopeLabel})`;
      }
    }

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

  function cleanup(): void {
    cancelActiveSearch();
    if (searchDebounceTimeout) {
      clearTimeout(searchDebounceTimeout);
      searchDebounceTimeout = null;
    }
  }

  return {
    initListeners,
    toggleSearch,
    closeSearch,
    openSearch,
    performSearch,
    debouncedSearch,
    cancelActiveSearch,
    cleanup,
    updateContentSearchToggle,
    updateSearchPlaceholder,
    showSearchHistoryDropdown,
    hideSearchHistoryDropdown,
    clearSearchHistory,
    addToSearchHistory,
    saveCurrentSearch,
    deleteSavedSearch,
    loadSavedSearch,
    getStatusText,
    isSearchMode: isSearchActive,
    isGlobalSearch: isGlobalSearchActive,
    getQuery,
    setQuery,
    focusInput,
    getSearchInputElement,
  };
}
