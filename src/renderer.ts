import type { Settings, FileItem, ItemProperties, CustomTheme, ContentSearchResult } from './types';
import { escapeHtml, getErrorMessage } from './shared.js';
import { createDefaultSettings } from './settings.js';

const THUMBNAIL_MAX_SIZE = 10 * 1024 * 1024;
const SEARCH_DEBOUNCE_MS = 300;
const SETTINGS_SAVE_DEBOUNCE_MS = 1000;
const TOAST_DURATION_MS = 3000;
const SEARCH_HISTORY_MAX = 5;
const DIRECTORY_HISTORY_MAX = 5;
const RENDER_BATCH_SIZE = 50;
const THUMBNAIL_ROOT_MARGIN = '100px';
const THUMBNAIL_CACHE_MAX = 100;
const THUMBNAIL_CONCURRENT_LOADS = 4;
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const thumbnailCache = new Map<string, string>();
let activeThumbnailLoads = 0;
const pendingThumbnailLoads: Array<() => void> = [];

function enqueueThumbnailLoad(loadFn: () => Promise<void>): void {
  const execute = async () => {
    activeThumbnailLoads++;
    try {
      await loadFn();
    } finally {
      activeThumbnailLoads--;
      if (pendingThumbnailLoads.length > 0) {
        const next = pendingThumbnailLoads.shift();
        if (next) next();
      }
    }
  };

  if (activeThumbnailLoads < THUMBNAIL_CONCURRENT_LOADS) {
    execute();
  } else {
    pendingThumbnailLoads.push(execute);
  }
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function normalizeWindowsPath(value: string): string {
  return value.replace(/\//g, '\\');
}

const path = {
  basename: (filePath: string, ext?: string): string => {
    const name = filePath.split(/[\\/]/).pop() || '';
    if (ext && name.endsWith(ext)) {
      return name.slice(0, -ext.length);
    }
    return name;
  },
  dirname: (filePath: string): string => {
    if (!isWindowsPath(filePath)) {
      const normalized = filePath.replace(/\\/g, '/');
      const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
      if (!trimmed || trimmed === '/') return '/';
      const idx = trimmed.lastIndexOf('/');
      return idx <= 0 ? '/' : trimmed.slice(0, idx);
    }

    const normalized = normalizeWindowsPath(filePath);
    const trimmed = normalized.length > 3 ? normalized.replace(/\\+$/, '') : normalized;

    if (trimmed.startsWith('\\\\')) {
      const parts = trimmed.split('\\').filter(Boolean);
      if (parts.length <= 2) {
        return `\\\\${parts.join('\\')}\\`;
      }
      return `\\\\${parts.slice(0, -1).join('\\')}`;
    }

    const driveMatch = trimmed.match(/^([A-Za-z]:)(\\.*)?$/);
    if (!driveMatch) return trimmed;
    const drive = driveMatch[1];
    const rest = (driveMatch[2] || '').replace(/\\+$/, '');
    if (!rest) return `${drive}\\`;
    const lastSep = rest.lastIndexOf('\\');
    if (lastSep <= 0) return `${drive}\\`;
    return `${drive}${rest.slice(0, lastSep)}`;
  },
  extname: (filePath: string): string => {
    const name = filePath.split(/[\\/]/).pop() || '';
    const dotIndex = name.lastIndexOf('.');
    return dotIndex === -1 ? '' : name.slice(dotIndex);
  },
  join: (...parts: string[]): string => {
    return parts.join('/').replace(/\/+/g, '/');
  },
};

function encodeFileUrl(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(normalizedPath)) {
    const drive = normalizedPath.slice(0, 2);
    const rest = normalizedPath.slice(2);
    const encodedRest = rest
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const normalizedRest = encodedRest.startsWith('/') ? encodedRest : `/${encodedRest}`;
    return `file:///${drive}${normalizedRest}`;
  }
  if (normalizedPath.startsWith('//')) {
    const uncPath = normalizedPath.slice(2);
    const encoded = uncPath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `file://${encoded}`;
  }
  const encoded = normalizedPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `file:///${encoded}`;
}

function emojiToCodepoint(emoji: string): string {
  const codePoints: number[] = [];
  let i = 0;
  while (i < emoji.length) {
    const code = emoji.codePointAt(i);
    if (code !== undefined) {
      if (code !== 0xfe0f) {
        codePoints.push(code);
      }
      i += code > 0xffff ? 2 : 1;
    } else {
      i++;
    }
  }
  return codePoints.map((cp) => cp.toString(16)).join('-');
}

function twemojiImg(emoji: string, className: string = 'twemoji', alt?: string): string {
  const codepoint = emojiToCodepoint(emoji);
  const src = `assets/twemoji/${codepoint}.svg`;
  const altText = escapeHtml(alt || emoji);
  return `<img src="${src}" class="${className}" alt="${altText}" draggable="false" />`;
}

// Debounced settings save for non-critical updates (history, recent files, etc.)
let settingsSaveTimeout: ReturnType<typeof setTimeout> | null = null;
function debouncedSaveSettings(delay: number = SETTINGS_SAVE_DEBOUNCE_MS) {
  if (settingsSaveTimeout) {
    clearTimeout(settingsSaveTimeout);
  }
  settingsSaveTimeout = setTimeout(() => {
    window.electronAPI.saveSettings(currentSettings);
    settingsSaveTimeout = null;
  }, delay);
}

let searchDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
let searchRequestId = 0;
function debouncedSearch(delay: number = SEARCH_DEBOUNCE_MS) {
  if (searchDebounceTimeout) {
    clearTimeout(searchDebounceTimeout);
  }
  searchDebounceTimeout = setTimeout(() => {
    performSearch();
    searchDebounceTimeout = null;
  }, delay);
}

interface SearchFilters {
  fileType?: string;
  minSize?: number;
  maxSize?: number;
  dateFrom?: string;
  dateTo?: string;
}

let currentSearchFilters: SearchFilters = {};
let activeSearchOperationId: string | null = null;

function cancelActiveSearch(): void {
  if (!activeSearchOperationId) return;
  window.electronAPI.cancelSearch(activeSearchOperationId).catch(() => {});
  activeSearchOperationId = null;
}

type ViewMode = 'grid' | 'list' | 'column';

// Breadcrumb state
let isBreadcrumbMode = true;
let breadcrumbContainer: HTMLElement | null = null;

interface ArchiveOperation {
  id: string;
  type: 'compress' | 'extract';
  name: string;
  current: number;
  total: number;
  currentFile: string;
  aborted: boolean;
}

const activeOperations = new Map<string, ArchiveOperation>();

const ipcCleanupFunctions: (() => void)[] = [];

let archiveOperationsPanelListenerInitialized = false;
function initArchiveOperationsPanelListener(): void {
  if (archiveOperationsPanelListenerInitialized) return;

  const list = document.getElementById('archive-operations-list');
  if (list) {
    list.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('archive-operation-cancel')) {
        const operationId = target.getAttribute('data-id');
        if (operationId) {
          abortOperation(operationId);
        }
      }
    });
    archiveOperationsPanelListenerInitialized = true;
  }
}

function generateOperationId(): string {
  return `op_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

function showOperationsPanel() {
  const panel = document.getElementById('archive-operations-panel');
  if (panel && activeOperations.size > 0) {
    panel.style.display = 'block';
  }
}

function hideOperationsPanel() {
  const panel = document.getElementById('archive-operations-panel');
  if (panel && activeOperations.size === 0) {
    panel.style.display = 'none';
  }
}

function addOperation(id: string, type: 'compress' | 'extract', name: string) {
  const operation: ArchiveOperation = {
    id,
    type,
    name,
    current: 0,
    total: 0,
    currentFile: 'Preparing...',
    aborted: false,
  };

  activeOperations.set(id, operation);
  renderOperations();
  showOperationsPanel();
}

let renderOperationsTimeout: ReturnType<typeof setTimeout> | null = null;

function updateOperation(id: string, current: number, total: number, currentFile: string) {
  const operation = activeOperations.get(id);
  if (operation && !operation.aborted) {
    operation.current = current;
    operation.total = total;
    operation.currentFile = currentFile;
    if (renderOperationsTimeout) clearTimeout(renderOperationsTimeout);
    renderOperationsTimeout = setTimeout(renderOperations, 50);
  }
}

function removeOperation(id: string) {
  activeOperations.delete(id);
  renderOperations();
  hideOperationsPanel();
}

function abortOperation(id: string) {
  const operation = activeOperations.get(id);
  if (operation) {
    operation.aborted = true;
    operation.currentFile = 'Cancelling...';
    renderOperations();

    window.electronAPI.cancelArchiveOperation(id).then((result) => {
      if (result.success) {
        console.log('[Archive] Operation cancelled:', id);
      } else {
        console.error('[Archive] Failed to cancel:', result.error);
      }
    });

    setTimeout(() => {
      removeOperation(id);
    }, 1500);
  }
}

function renderOperations() {
  const list = document.getElementById('archive-operations-list');
  if (!list) return;

  initArchiveOperationsPanelListener();

  list.innerHTML = '';

  for (const [id, operation] of activeOperations) {
    const item = document.createElement('div');
    item.className = 'archive-operation-item';

    const icon = operation.type === 'compress' ? '1f5dc' : '1f4e6';
    const iconEmoji = operation.type === 'compress' ? '🗜️' : '📦';
    const title = operation.type === 'compress' ? 'Compressing' : 'Extracting';

    const percent =
      operation.total > 0 ? Math.round((operation.current / operation.total) * 100) : 0;

    item.innerHTML = `
      <div class="archive-operation-header">
        <div class="archive-operation-title">
          <img src="assets/twemoji/${icon}.svg" class="twemoji" alt="${iconEmoji}" draggable="false" />
          <span class="archive-operation-name" title="${escapeHtml(operation.name)}">${title}: ${escapeHtml(operation.name)}</span>
        </div>
        ${!operation.aborted ? `<button class="archive-operation-cancel" data-id="${escapeHtml(id)}">Cancel</button>` : ''}
      </div>
      <div class="archive-operation-file">${escapeHtml(operation.currentFile)}</div>
      <div class="archive-operation-stats">${operation.current} / ${operation.total} files</div>
      <div class="archive-progress-bar-container">
        <div class="archive-progress-bar" style="width: ${percent}%"></div>
      </div>
    `;

    list.appendChild(item);
  }
}

// Breadcrumb nav
function parsePath(filePath: string): { segments: string[]; isWindows: boolean; isUnc: boolean } {
  const isUnc = filePath.startsWith('\\\\');
  const isWindows = isUnc || /^[A-Za-z]:/.test(filePath);
  const normalizedPath = filePath.replace(/\\/g, '/');
  const segments = normalizedPath.split('/').filter((s) => s.length > 0);
  if (isWindows && !isUnc && segments.length > 0) {
    if (!segments[0].includes(':')) {
      segments[0] = segments[0] + ':';
    }
  }

  return { segments, isWindows, isUnc };
}

function buildPathFromSegments(
  segments: string[],
  index: number,
  isWindows: boolean,
  isUnc: boolean
): string {
  if (index < 0) return '';

  const pathSegments = segments.slice(0, index + 1);

  if (isWindows) {
    if (isUnc) {
      if (pathSegments.length <= 2) {
        return `\\\\${pathSegments.join('\\')}\\`;
      }
      return `\\\\${pathSegments.join('\\')}`;
    }
    if (pathSegments.length === 1) {
      return pathSegments[0] + '\\';
    }
    return pathSegments.join('\\');
  } else {
    return '/' + pathSegments.join('/');
  }
}

function updateBreadcrumb(currentPath: string): void {
  if (!breadcrumbContainer) {
    breadcrumbContainer = document.getElementById('breadcrumb-container');
  }

  if (!breadcrumbContainer || !addressInput) return;

  if (!isBreadcrumbMode || !currentPath) {
    breadcrumbContainer.style.display = 'none';
    addressInput.style.display = 'block';
    addressInput.value = currentPath || '';
    return;
  }

  const { segments, isWindows, isUnc } = parsePath(currentPath);

  if (segments.length === 0) {
    breadcrumbContainer.style.display = 'none';
    addressInput.style.display = 'block';
    addressInput.value = currentPath;
    return;
  }

  breadcrumbContainer.style.display = 'inline-flex';
  addressInput.style.display = 'none';
  breadcrumbContainer.innerHTML = '';

  const container = breadcrumbContainer;

  segments.forEach((segment, index) => {
    const item = document.createElement('span');
    item.className = 'breadcrumb-item';
    item.textContent = segment;
    item.title = buildPathFromSegments(segments, index, isWindows, isUnc);

    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetPath = buildPathFromSegments(segments, index, isWindows, isUnc);
      navigateTo(targetPath);
    });

    container.appendChild(item);

    if (index < segments.length - 1) {
      const separator = document.createElement('span');
      separator.className = 'breadcrumb-separator';
      separator.textContent = isWindows ? '›' : '/';
      container.appendChild(separator);
    }
  });
}

function toggleBreadcrumbMode(): void {
  isBreadcrumbMode = !isBreadcrumbMode;

  if (!breadcrumbContainer) {
    breadcrumbContainer = document.getElementById('breadcrumb-container');
  }

  if (isBreadcrumbMode) {
    updateBreadcrumb(currentPath);
  } else {
    if (breadcrumbContainer) breadcrumbContainer.style.display = 'none';
    if (addressInput) {
      addressInput.style.display = 'block';
      addressInput.value = currentPath;
      addressInput.focus();
      addressInput.select();
    }
  }
}

function setupBreadcrumbListeners(): void {
  breadcrumbContainer = document.getElementById('breadcrumb-container');

  const addressBar = document.querySelector('.address-bar');
  if (addressBar) {
    addressBar.addEventListener('dblclick', (e) => {
      const target = e.target as HTMLElement;
      if (
        target.classList.contains('address-bar') ||
        target.classList.contains('breadcrumb') ||
        target.id === 'breadcrumb-container'
      ) {
        if (isBreadcrumbMode) {
          toggleBreadcrumbMode();
        }
      }
    });
  }

  if (addressInput) {
    addressInput.addEventListener('blur', () => {
      setTimeout(() => {
        if (!isBreadcrumbMode && currentPath) {
          isBreadcrumbMode = true;
          updateBreadcrumb(currentPath);
        }
      }, 150);
    });

    addressInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        isBreadcrumbMode = true;
        updateBreadcrumb(currentPath);
        addressInput.blur();
      }
    });
  }
}

type DialogType = 'info' | 'warning' | 'error' | 'success' | 'question';

let currentPath: string = '';
let history: string[] = [];
let historyIndex: number = -1;
let selectedItems: Set<string> = new Set();
let viewMode: ViewMode = 'grid';
let contextMenuData: FileItem | null = null;
let clipboard: { operation: 'copy' | 'cut'; paths: string[] } | null = null;
let allFiles: FileItem[] = [];
let isSearchMode: boolean = false;
let isGlobalSearch: boolean = false;
let searchInContents: boolean = false;
let isPreviewPanelVisible: boolean = false;
let previewRequestId = 0;
let currentQuicklookFile: FileItem | null = null;
let platformOS: string = '';
let canUndo: boolean = false;
let canRedo: boolean = false;
let currentZoomLevel: number = 1.0;
let zoomPopupTimeout: NodeJS.Timeout | null = null;
let indexStatusInterval: NodeJS.Timeout | null = null;

interface TabData {
  id: string;
  path: string;
  history: string[];
  historyIndex: number;
  selectedItems: Set<string>;
  scrollPosition: number;
  cachedFiles?: FileItem[];
}

let tabs: TabData[] = [];
let activeTabId: string = '';
let tabsEnabled: boolean = false;
let tabNewButtonListenerAttached: boolean = false;

function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

function initializeTabs() {
  if (currentSettings.enableTabs === false) {
    tabsEnabled = false;
    document.body.classList.remove('tabs-enabled');
    document.body.classList.remove('tabs-single');
    const tabBar = document.getElementById('tab-bar');
    if (tabBar) tabBar.style.display = 'none';
    return;
  }

  tabsEnabled = true;
  document.body.classList.add('tabs-enabled');
  const tabBar = document.getElementById('tab-bar');
  if (tabBar) tabBar.style.removeProperty('display');

  if (currentSettings.tabState && currentSettings.tabState.tabs.length > 0) {
    tabs = currentSettings.tabState.tabs.map((t) => ({
      ...t,
      selectedItems: new Set(t.selectedItems || []),
    }));
    activeTabId = currentSettings.tabState.activeTabId;

    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (activeTab) {
      history = [...activeTab.history];
      historyIndex = activeTab.historyIndex;
      selectedItems = new Set(activeTab.selectedItems);
    }
  } else {
    const initialTab = createNewTabData(currentPath || '');
    tabs = [initialTab];
    activeTabId = initialTab.id;
  }

  renderTabs();

  if (!tabNewButtonListenerAttached) {
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

    tabNewButtonListenerAttached = true;
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
  if (!tabsEnabled) return;
  if (tabs.length <= 1) {
    document.body.classList.add('tabs-single');
  } else {
    document.body.classList.remove('tabs-single');
  }
}

function renderTabs() {
  const tabList = document.getElementById('tab-list');
  if (!tabsEnabled) return;

  updateTabBarVisibility();

  if (!tabList) return;

  tabList.innerHTML = '';

  tabs.forEach((tab) => {
    const tabElement = document.createElement('div');
    tabElement.className = `tab-item${tab.id === activeTabId ? ' active' : ''}`;
    tabElement.dataset.tabId = tab.id;

    const pathParts = tab.path.split(/[/\\]/);
    const folderName = pathParts[pathParts.length - 1] || tab.path || 'New Tab';

    tabElement.innerHTML = `
      <span class="tab-icon">
        <img src="assets/twemoji/1f4c2.svg" class="twemoji" alt="📂" draggable="false" />
      </span>
      <span class="tab-title" title="${escapeHtml(tab.path)}">${escapeHtml(folderName)}</span>
      <button class="tab-close" title="Close Tab">&times;</button>
    `;

    tabElement.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('tab-close')) {
        e.stopPropagation();
        closeTab(tab.id);
      } else {
        switchToTab(tab.id);
      }
    });

    tabElement.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tab.id);
      }
    });

    tabList.appendChild(tabElement);
  });
}

function switchToTab(tabId: string) {
  if (activeTabId === tabId || !tabsEnabled) return;

  const currentTab = tabs.find((t) => t.id === activeTabId);
  if (currentTab) {
    currentTab.path = currentPath;
    currentTab.history = [...history];
    currentTab.historyIndex = historyIndex;
    currentTab.selectedItems = new Set(selectedItems);
    currentTab.scrollPosition = fileView?.scrollTop || 0;
    currentTab.cachedFiles = [...allFiles];
  }

  activeTabId = tabId;
  const newTab = tabs.find((t) => t.id === tabId);
  if (newTab) {
    history = [...newTab.history];
    historyIndex = newTab.historyIndex;
    selectedItems = new Set(newTab.selectedItems);

    if (newTab.path) {
      if (newTab.cachedFiles !== undefined) {
        restoreTabView(newTab);
      } else {
        navigateTo(newTab.path, true);
      }
    }

    setTimeout(() => {
      if (fileView) fileView.scrollTop = newTab.scrollPosition;
    }, 50);
  }

  renderTabs();
  debouncedSaveTabState();
}

function restoreTabView(tab: TabData) {
  currentPath = tab.path;
  if (addressInput) addressInput.value = tab.path;
  updateBreadcrumb(tab.path);
  updateNavigationButtons();

  if (viewMode === 'column') {
    renderColumnView();
  } else {
    renderFiles(tab.cachedFiles || []);
  }
}

let saveTabStateTimeout: NodeJS.Timeout | null = null;
function debouncedSaveTabState() {
  if (saveTabStateTimeout) {
    clearTimeout(saveTabStateTimeout);
  }
  saveTabStateTimeout = setTimeout(() => {
    saveTabState();
  }, 500);
}

async function addNewTab(path?: string) {
  if (!tabsEnabled) return;

  const currentTab = tabs.find((t) => t.id === activeTabId);
  if (currentTab) {
    currentTab.path = currentPath;
    currentTab.history = [...history];
    currentTab.historyIndex = historyIndex;
    currentTab.selectedItems = new Set(selectedItems);
    currentTab.scrollPosition = fileView?.scrollTop || 0;
    currentTab.cachedFiles = [...allFiles];
  }

  let tabPath = path;
  if (!tabPath) {
    tabPath = await window.electronAPI.getHomeDirectory();
  }

  const newTab = createNewTabData(tabPath);
  tabs.push(newTab);
  activeTabId = newTab.id;

  history = [tabPath];
  historyIndex = 0;
  selectedItems = new Set();

  navigateTo(tabPath, true);

  renderTabs();
  debouncedSaveTabState();
}

function closeTab(tabId: string) {
  if (!tabsEnabled || tabs.length <= 1) return;

  const tabIndex = tabs.findIndex((t) => t.id === tabId);
  if (tabIndex === -1) return;

  tabs.splice(tabIndex, 1);

  if (activeTabId === tabId) {
    const newIndex = Math.min(tabIndex, tabs.length - 1);
    activeTabId = tabs[newIndex].id;
    const newTab = tabs[newIndex];

    history = [...newTab.history];
    historyIndex = newTab.historyIndex;
    selectedItems = new Set(newTab.selectedItems);

    if (newTab.path) {
      if (newTab.cachedFiles !== undefined) {
        restoreTabView(newTab);
      } else {
        navigateTo(newTab.path, true);
      }
    }
  }

  renderTabs();
  debouncedSaveTabState();
}

function saveTabState() {
  if (!tabsEnabled) return;

  currentSettings.tabState = {
    tabs: tabs.map((t) => ({
      id: t.id,
      path: t.path,
      history: t.history,
      historyIndex: t.historyIndex,
      selectedItems: Array.from(t.selectedItems),
      scrollPosition: t.scrollPosition,
    })),
    activeTabId,
  };
  debouncedSaveSettings();
}

function updateCurrentTabPath(newPath: string) {
  if (!tabsEnabled) return;

  const currentTab = tabs.find((t) => t.id === activeTabId);
  if (currentTab) {
    currentTab.path = newPath;
    renderTabs();
    saveTabState();
  }
}

const addressInput = document.getElementById('address-input') as HTMLInputElement;
const fileGrid = document.getElementById('file-grid') as HTMLElement;
const fileView = document.getElementById('file-view') as HTMLElement;
const columnView = document.getElementById('column-view') as HTMLElement;
const loading = document.getElementById('loading') as HTMLElement;
const emptyState = document.getElementById('empty-state') as HTMLElement;
const backBtn = document.getElementById('back-btn') as HTMLButtonElement;
const forwardBtn = document.getElementById('forward-btn') as HTMLButtonElement;
const upBtn = document.getElementById('up-btn') as HTMLButtonElement;
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
const newFileBtn = document.getElementById('new-file-btn') as HTMLButtonElement;
const newFolderBtn = document.getElementById('new-folder-btn') as HTMLButtonElement;
const viewToggleBtn = document.getElementById('view-toggle-btn') as HTMLButtonElement;
const drivesList = document.getElementById('drives-list') as HTMLElement;
const searchBtn = document.getElementById('search-btn') as HTMLButtonElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchBarWrapper = document.querySelector('.search-bar-wrapper') as HTMLElement;
const searchClose = document.getElementById('search-close') as HTMLButtonElement;
const searchScopeToggle = document.getElementById('search-scope-toggle') as HTMLButtonElement;
const searchFilterToggle = document.getElementById('search-filter-toggle') as HTMLButtonElement;
const searchFiltersPanel = document.getElementById('search-filters-panel') as HTMLElement;
const searchFilterType = document.getElementById('search-filter-type') as HTMLSelectElement;
const searchFilterMinSize = document.getElementById('search-filter-min-size') as HTMLInputElement;
const searchFilterMaxSize = document.getElementById('search-filter-max-size') as HTMLInputElement;
const searchFilterSizeUnitMin = document.getElementById(
  'search-filter-size-unit-min'
) as HTMLSelectElement;
const searchFilterSizeUnitMax = document.getElementById(
  'search-filter-size-unit-max'
) as HTMLSelectElement;
const searchFilterDateFrom = document.getElementById('search-filter-date-from') as HTMLInputElement;
const searchFilterDateTo = document.getElementById('search-filter-date-to') as HTMLInputElement;
const searchFilterClear = document.getElementById('search-filter-clear') as HTMLButtonElement;
const searchFilterApply = document.getElementById('search-filter-apply') as HTMLButtonElement;
const searchInContentsToggle = document.getElementById(
  'search-in-contents-toggle'
) as HTMLInputElement;
const sortBtn = document.getElementById('sort-btn') as HTMLButtonElement;
const bookmarksList = document.getElementById('bookmarks-list') as HTMLElement;
const bookmarkAddBtn = document.getElementById('bookmark-add-btn') as HTMLButtonElement;
const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;

const loadingText = loading ? (loading.querySelector('p') as HTMLElement | null) : null;
let activeDirectoryProgressPath: string | null = null;
let activeDirectoryProgressOperationId: string | null = null;
let activeDirectoryOperationId: string | null = null;
let directoryRequestId = 0;
let directoryProgressCount = 0;
let lastDirectoryProgressUpdate = 0;

window.electronAPI.onDirectoryContentsProgress((progress) => {
  if (activeDirectoryProgressOperationId) {
    if (progress.operationId !== activeDirectoryProgressOperationId) return;
  } else if (!activeDirectoryProgressPath || progress.dirPath !== activeDirectoryProgressPath) {
    return;
  }
  directoryProgressCount = progress.loaded;
  const now = Date.now();
  if (now - lastDirectoryProgressUpdate < 100) return;
  lastDirectoryProgressUpdate = now;
  if (loadingText) {
    loadingText.textContent = `Loading... (${directoryProgressCount.toLocaleString()} items)`;
  }
});

function createDirectoryOperationId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function startDirectoryRequest(path: string): { requestId: number; operationId: string } {
  const requestId = ++directoryRequestId;
  if (activeDirectoryOperationId) {
    window.electronAPI.cancelDirectoryContents(activeDirectoryOperationId).catch(() => {});
  }
  const operationId = createDirectoryOperationId('dir');
  activeDirectoryOperationId = operationId;
  activeDirectoryProgressOperationId = operationId;
  activeDirectoryProgressPath = path;
  directoryProgressCount = 0;
  lastDirectoryProgressUpdate = 0;
  if (loadingText) loadingText.textContent = 'Loading...';
  return { requestId, operationId };
}

function finishDirectoryRequest(requestId: number): void {
  if (requestId !== directoryRequestId) return;
  activeDirectoryOperationId = null;
  activeDirectoryProgressOperationId = null;
  activeDirectoryProgressPath = null;
  directoryProgressCount = 0;
  lastDirectoryProgressUpdate = 0;
  if (loadingText) loadingText.textContent = 'Loading...';
}

function cancelDirectoryRequest(): void {
  if (activeDirectoryOperationId) {
    window.electronAPI.cancelDirectoryContents(activeDirectoryOperationId).catch(() => {});
  }
  directoryRequestId += 1;
  finishDirectoryRequest(directoryRequestId);
}

const currentGitStatuses: Map<string, string> = new Map();
let gitStatusRequestId = 0;

function clearGitIndicators(): void {
  currentGitStatuses.clear();
  document.querySelectorAll('.git-indicator').forEach((indicator) => indicator.remove());
}

async function fetchGitStatusAsync(dirPath: string) {
  if (!currentSettings.enableGitStatus) {
    return;
  }

  const requestId = ++gitStatusRequestId;

  try {
    const result = await window.electronAPI.getGitStatus(dirPath);
    if (
      requestId !== gitStatusRequestId ||
      dirPath !== currentPath ||
      !currentSettings.enableGitStatus
    ) {
      return;
    }

    currentGitStatuses.clear();

    if (result.success && result.isGitRepo && result.statuses) {
      for (const item of result.statuses) {
        currentGitStatuses.set(item.path, item.status);
      }
      updateGitIndicators();
    } else {
      clearGitIndicators();
    }
  } catch (error) {
    console.error('[Git Status] Failed to fetch:', error);
  }
}

function updateGitIndicators() {
  if (!currentSettings.enableGitStatus) {
    clearGitIndicators();
    return;
  }

  document.querySelectorAll('.file-item').forEach((item) => {
    const itemPath = item.getAttribute('data-path');
    if (!itemPath) return;

    const existingIndicator = item.querySelector('.git-indicator');
    if (existingIndicator) existingIndicator.remove();

    const status = currentGitStatuses.get(itemPath);
    if (status) {
      const indicator = document.createElement('span');
      indicator.className = `git-indicator ${status}`;
      indicator.title = status.charAt(0).toUpperCase() + status.slice(1);
      item.appendChild(indicator);
    }
  });
}

function showDialog(
  title: string,
  message: string,
  type: DialogType = 'info',
  showCancel: boolean = false
): Promise<boolean> {
  return new Promise((resolve) => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    const dialogModal = document.getElementById('dialog-modal') as HTMLElement;
    const dialogTitle = document.getElementById('dialog-title') as HTMLElement;
    const dialogContent = document.getElementById('dialog-content') as HTMLElement;
    const dialogIcon = document.getElementById('dialog-icon') as HTMLElement;
    const dialogOk = document.getElementById('dialog-ok') as HTMLButtonElement;
    const dialogCancel = document.getElementById('dialog-cancel') as HTMLButtonElement;

    const icons: Record<DialogType, string> = {
      info: '2139',
      warning: '26a0',
      error: '274c',
      success: '2705',
      question: '2753',
    };

    dialogIcon.innerHTML = twemojiImg(
      String.fromCodePoint(parseInt(icons[type] || icons.info, 16)),
      'twemoji'
    );
    dialogTitle.textContent = title;
    dialogContent.textContent = message;

    if (showCancel) {
      dialogCancel.style.display = 'block';
    } else {
      dialogCancel.style.display = 'none';
    }

    dialogModal.style.display = 'flex';

    const handleOk = (): void => {
      dialogModal.style.display = 'none';
      cleanup();
      resolve(true);
    };

    const handleCancel = (): void => {
      dialogModal.style.display = 'none';
      cleanup();
      resolve(false);
    };

    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        dialogModal.style.display = 'none';
        cleanup();
        resolve(false);
      }
    };

    const cleanup = (): void => {
      dialogOk.removeEventListener('click', handleOk);
      dialogCancel.removeEventListener('click', handleCancel);
      document.removeEventListener('keydown', handleEscape);
    };

    dialogOk.addEventListener('click', handleOk);
    dialogCancel.addEventListener('click', handleCancel);
    document.addEventListener('keydown', handleEscape);
  });
}

async function showAlert(
  message: string,
  title: string = 'IYERIS',
  type: DialogType = 'info'
): Promise<void> {
  await showDialog(title, message, type, false);
}

async function showConfirm(
  message: string,
  title: string = 'Confirm',
  type: DialogType = 'question'
): Promise<boolean> {
  return await showDialog(title, message, type, true);
}

let currentSettings: Settings = createDefaultSettings();

function showToast(
  message: string,
  title: string = '',
  type: 'success' | 'error' | 'info' | 'warning' = 'info'
): void {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.style.cursor = 'pointer';

  const icons: Record<string, string> = {
    success: '2705',
    error: '274c',
    info: '2139',
    warning: '26a0',
  };

  toast.innerHTML = `
    <span class="toast-icon">${twemojiImg(String.fromCodePoint(parseInt(icons[type], 16)), 'twemoji')}</span>
    <div class="toast-content">
      ${title ? `<div class="toast-title">${escapeHtml(title)}</div>` : ''}
      <div class="toast-message">${escapeHtml(message)}</div>
    </div>
  `;

  container.appendChild(toast);

  const removeToast = () => {
    toast.classList.add('removing');
    setTimeout(() => {
      if (container.contains(toast)) {
        container.removeChild(toast);
      }
    }, 300);
  };

  toast.addEventListener('click', removeToast);

  setTimeout(removeToast, TOAST_DURATION_MS);
}

async function loadSettings(): Promise<void> {
  const [result, sharedClipboard] = await Promise.all([
    window.electronAPI.getSettings(),
    window.electronAPI.getClipboard(),
  ]);

  if (result.success && result.settings) {
    const defaults = createDefaultSettings();
    currentSettings = { ...defaults, ...result.settings };
    currentSettings.enableSyntaxHighlighting = currentSettings.enableSyntaxHighlighting !== false;
    applySettings(currentSettings);
    const newLaunchCount = (currentSettings.launchCount || 0) + 1;
    currentSettings.launchCount = newLaunchCount;
    debouncedSaveSettings(100);

    if (newLaunchCount === 2 && !currentSettings.supportPopupDismissed) {
      setTimeout(() => showSupportPopup(), 1500);
    }
  }

  if (sharedClipboard) {
    clipboard = sharedClipboard;
    console.log(
      '[Init] Loaded shared clipboard:',
      clipboard.operation,
      clipboard.paths.length,
      'items'
    );
  }
}

function applySettings(settings: Settings) {
  if (settings.transparency === false) {
    document.body.classList.add('no-transparency');
  } else {
    document.body.classList.remove('no-transparency');
  }

  document.body.classList.remove('theme-dark', 'theme-light', 'theme-default', 'theme-custom');
  if (settings.theme && settings.theme !== 'default') {
    document.body.classList.add(`theme-${settings.theme}`);
  }

  if (settings.theme === 'custom' && settings.customTheme) {
    applyCustomThemeColors(settings.customTheme);
  } else {
    clearCustomThemeColors();
  }

  if (settings.viewMode) {
    viewMode = settings.viewMode;
    applyViewMode();
    updateViewToggleButton();
  }

  if (settings.reduceMotion) {
    document.body.classList.add('reduce-motion');
  } else {
    document.body.classList.remove('reduce-motion');
  }

  if (settings.highContrast) {
    document.body.classList.add('high-contrast');
  } else {
    document.body.classList.remove('high-contrast');
  }

  if (settings.largeText) {
    document.body.classList.add('large-text');
  } else {
    document.body.classList.remove('large-text');
  }

  if (settings.boldText) {
    document.body.classList.add('bold-text');
  } else {
    document.body.classList.remove('bold-text');
  }

  if (settings.visibleFocus) {
    document.body.classList.add('visible-focus');
  } else {
    document.body.classList.remove('visible-focus');
  }

  if (settings.reduceTransparency) {
    document.body.classList.add('reduce-transparency');
  } else {
    document.body.classList.remove('reduce-transparency');
  }

  if (settings.enableGitStatus) {
    if (currentPath) {
      fetchGitStatusAsync(currentPath);
    }
  } else {
    clearGitIndicators();
  }

  loadBookmarks();
  loadRecentFiles();
}

function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    return `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`;
  }
  return '0, 120, 212';
}

function applyCustomThemeColors(theme: CustomTheme) {
  const root = document.documentElement;
  root.style.setProperty('--custom-accent-color', theme.accentColor);
  root.style.setProperty('--custom-accent-rgb', hexToRgb(theme.accentColor));
  root.style.setProperty('--custom-bg-primary', theme.bgPrimary);
  root.style.setProperty('--custom-bg-primary-rgb', hexToRgb(theme.bgPrimary));
  root.style.setProperty('--custom-bg-secondary', theme.bgSecondary);
  root.style.setProperty('--custom-text-primary', theme.textPrimary);
  root.style.setProperty('--custom-text-secondary', theme.textSecondary);
  root.style.setProperty('--custom-glass-bg', `${theme.glassBg}08`);
  root.style.setProperty('--custom-glass-border', `${theme.glassBorder}14`);
  document.body.style.backgroundColor = theme.bgPrimary;
}

function clearCustomThemeColors() {
  const root = document.documentElement;
  const props = [
    '--custom-accent-color',
    '--custom-accent-rgb',
    '--custom-bg-primary',
    '--custom-bg-primary-rgb',
    '--custom-bg-secondary',
    '--custom-text-primary',
    '--custom-text-secondary',
    '--custom-glass-bg',
    '--custom-glass-border',
  ];
  props.forEach((prop) => root.style.removeProperty(prop));
  document.body.style.backgroundColor = '';
}

// Theme Editor
const themePresets: Record<string, CustomTheme> = {
  midnight: {
    name: 'Midnight Blue',
    accentColor: '#4a9eff',
    bgPrimary: '#0d1b2a',
    bgSecondary: '#1b263b',
    textPrimary: '#e0e1dd',
    textSecondary: '#a0a4a8',
    glassBg: '#ffffff',
    glassBorder: '#4a9eff',
  },
  forest: {
    name: 'Forest Green',
    accentColor: '#2ecc71',
    bgPrimary: '#1a2f1a',
    bgSecondary: '#243524',
    textPrimary: '#e8f5e9',
    textSecondary: '#a5d6a7',
    glassBg: '#ffffff',
    glassBorder: '#2ecc71',
  },
  sunset: {
    name: 'Sunset Orange',
    accentColor: '#ff7043',
    bgPrimary: '#1f1410',
    bgSecondary: '#2d1f1a',
    textPrimary: '#fff3e0',
    textSecondary: '#ffab91',
    glassBg: '#ffffff',
    glassBorder: '#ff7043',
  },
  lavender: {
    name: 'Lavender Purple',
    accentColor: '#9c7cf4',
    bgPrimary: '#1a1625',
    bgSecondary: '#251f33',
    textPrimary: '#ede7f6',
    textSecondary: '#b39ddb',
    glassBg: '#ffffff',
    glassBorder: '#9c7cf4',
  },
  rose: {
    name: 'Rose Pink',
    accentColor: '#f48fb1',
    bgPrimary: '#1f1418',
    bgSecondary: '#2d1f24',
    textPrimary: '#fce4ec',
    textSecondary: '#f8bbd9',
    glassBg: '#ffffff',
    glassBorder: '#f48fb1',
  },
  ocean: {
    name: 'Ocean Teal',
    accentColor: '#26c6da',
    bgPrimary: '#0d1f22',
    bgSecondary: '#1a2f33',
    textPrimary: '#e0f7fa',
    textSecondary: '#80deea',
    glassBg: '#ffffff',
    glassBorder: '#26c6da',
  },
};

let tempCustomTheme: CustomTheme = {
  name: 'My Custom Theme',
  accentColor: '#0078d4',
  bgPrimary: '#1a1a1a',
  bgSecondary: '#252525',
  textPrimary: '#ffffff',
  textSecondary: '#b0b0b0',
  glassBg: '#ffffff',
  glassBorder: '#ffffff',
};

function showThemeEditor() {
  const modal = document.getElementById('theme-editor-modal');
  if (!modal) return;

  if (currentSettings.customTheme) {
    tempCustomTheme = { ...currentSettings.customTheme };
  }

  const inputs: Record<string, { color: string; text: string }> = {
    'theme-accent-color': { color: tempCustomTheme.accentColor, text: tempCustomTheme.accentColor },
    'theme-bg-primary': { color: tempCustomTheme.bgPrimary, text: tempCustomTheme.bgPrimary },
    'theme-bg-secondary': { color: tempCustomTheme.bgSecondary, text: tempCustomTheme.bgSecondary },
    'theme-text-primary': { color: tempCustomTheme.textPrimary, text: tempCustomTheme.textPrimary },
    'theme-text-secondary': {
      color: tempCustomTheme.textSecondary,
      text: tempCustomTheme.textSecondary,
    },
    'theme-glass-bg': { color: tempCustomTheme.glassBg, text: tempCustomTheme.glassBg },
  };

  for (const [id, values] of Object.entries(inputs)) {
    const colorInput = document.getElementById(id) as HTMLInputElement;
    const textInput = document.getElementById(`${id}-text`) as HTMLInputElement;
    if (colorInput) colorInput.value = values.color;
    if (textInput) textInput.value = values.text;
  }

  const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
  if (nameInput) nameInput.value = tempCustomTheme.name;

  updateThemePreview();
  modal.style.display = 'flex';
}

function hideThemeEditor() {
  const modal = document.getElementById('theme-editor-modal');
  if (modal) modal.style.display = 'none';
}

function updateThemePreview() {
  const preview = document.getElementById('theme-preview');
  if (!preview) return;

  preview.style.setProperty('--custom-accent-color', tempCustomTheme.accentColor);
  preview.style.setProperty('--custom-accent-rgb', hexToRgb(tempCustomTheme.accentColor));
  preview.style.setProperty('--custom-bg-primary', tempCustomTheme.bgPrimary);
  preview.style.setProperty('--custom-bg-secondary', tempCustomTheme.bgSecondary);
  preview.style.setProperty('--custom-text-primary', tempCustomTheme.textPrimary);
  preview.style.setProperty('--custom-text-secondary', tempCustomTheme.textSecondary);
  preview.style.setProperty('--custom-glass-bg', `${tempCustomTheme.glassBg}08`);
  preview.style.setProperty('--custom-glass-border', `${tempCustomTheme.glassBorder}20`);
  preview.style.backgroundColor = tempCustomTheme.bgPrimary;
}

function syncColorInputs(colorId: string, value: string) {
  const colorInput = document.getElementById(colorId) as HTMLInputElement;
  const textInput = document.getElementById(`${colorId}-text`) as HTMLInputElement;

  if (colorInput) colorInput.value = value;
  if (textInput) textInput.value = value.toUpperCase();

  const mapping: Record<string, keyof CustomTheme> = {
    'theme-accent-color': 'accentColor',
    'theme-bg-primary': 'bgPrimary',
    'theme-bg-secondary': 'bgSecondary',
    'theme-text-primary': 'textPrimary',
    'theme-text-secondary': 'textSecondary',
    'theme-glass-bg': 'glassBg',
  };

  const key = mapping[colorId];
  if (key) {
    (tempCustomTheme as any)[key] = value;
    if (key === 'glassBg') {
      tempCustomTheme.glassBorder = value;
    }
  }

  updateThemePreview();
}

function applyThemePreset(presetName: string) {
  const preset = themePresets[presetName];
  if (!preset) return;

  tempCustomTheme = { ...preset };

  const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
  if (nameInput) nameInput.value = preset.name;

  syncColorInputs('theme-accent-color', preset.accentColor);
  syncColorInputs('theme-bg-primary', preset.bgPrimary);
  syncColorInputs('theme-bg-secondary', preset.bgSecondary);
  syncColorInputs('theme-text-primary', preset.textPrimary);
  syncColorInputs('theme-text-secondary', preset.textSecondary);
  syncColorInputs('theme-glass-bg', preset.glassBg);
}

async function saveCustomTheme() {
  const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
  if (nameInput && nameInput.value.trim()) {
    tempCustomTheme.name = nameInput.value.trim();
  }

  currentSettings.customTheme = { ...tempCustomTheme };
  currentSettings.theme = 'custom';

  applySettings(currentSettings);

  const result = await window.electronAPI.saveSettings(currentSettings);
  if (result.success) {
    hideThemeEditor();
    updateCustomThemeUI();
    showToast('Custom theme saved!', 'Theme', 'success');
  } else {
    showToast('Failed to save theme: ' + result.error, 'Error', 'error');
  }
}

function setupThemeEditorListeners() {
  document.getElementById('theme-editor-close')?.addEventListener('click', hideThemeEditor);
  document.getElementById('theme-editor-cancel')?.addEventListener('click', hideThemeEditor);
  document.getElementById('theme-editor-save')?.addEventListener('click', saveCustomTheme);

  // Color inputs
  const colorIds = [
    'theme-accent-color',
    'theme-bg-primary',
    'theme-bg-secondary',
    'theme-text-primary',
    'theme-text-secondary',
    'theme-glass-bg',
  ];

  colorIds.forEach((id) => {
    const colorInput = document.getElementById(id) as HTMLInputElement;
    const textInput = document.getElementById(`${id}-text`) as HTMLInputElement;

    colorInput?.addEventListener('input', (e) => {
      const value = (e.target as HTMLInputElement).value;
      syncColorInputs(id, value);
    });

    textInput?.addEventListener('input', (e) => {
      let value = (e.target as HTMLInputElement).value.trim();
      if (!value.startsWith('#')) value = '#' + value;
      if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
        syncColorInputs(id, value);
        textInput.classList.remove('invalid');
      } else if (/^#[0-9A-Fa-f]{3}$/.test(value)) {
        const expanded = '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
        syncColorInputs(id, expanded);
        textInput.classList.remove('invalid');
      } else if (value.length > 1) {
        textInput.classList.add('invalid');
      }
    });

    textInput?.addEventListener('blur', (e) => {
      let value = (e.target as HTMLInputElement).value.trim();
      if (!value.startsWith('#')) value = '#' + value;
      // Validate and reset
      if (!/^#[0-9A-Fa-f]{3}$/.test(value) && !/^#[0-9A-Fa-f]{6}$/.test(value)) {
        // Reset to current color picker value
        const colorInput = document.getElementById(id) as HTMLInputElement;
        if (colorInput && textInput) {
          textInput.value = colorInput.value.toUpperCase();
          textInput.classList.remove('invalid');
        }
      } else {
        textInput.classList.remove('invalid');
      }
    });
  });

  document.getElementById('theme-name-input')?.addEventListener('input', (e) => {
    tempCustomTheme.name = (e.target as HTMLInputElement).value || 'My Custom Theme';
  });

  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = (btn as HTMLElement).dataset.preset;
      if (preset) applyThemePreset(preset);
    });
  });

  const openThemeEditorBtn = document.getElementById('open-theme-editor-btn');
  if (openThemeEditorBtn) {
    openThemeEditorBtn.addEventListener('click', () => {
      showThemeEditor();
    });
  }

  const useCustomThemeBtn = document.getElementById('use-custom-theme-btn');
  if (useCustomThemeBtn) {
    useCustomThemeBtn.addEventListener('click', async () => {
      if (currentSettings.customTheme) {
        currentSettings.theme = 'custom';
        applySettings(currentSettings);
        await window.electronAPI.saveSettings(currentSettings);
        updateCustomThemeUI();
      }
    });
  }

  document.getElementById('theme-editor-modal')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).classList.contains('modal-overlay')) {
      hideThemeEditor();
    }
  });
}

function updateCustomThemeUI() {
  const useCustomThemeBtn = document.getElementById('use-custom-theme-btn');
  const customThemeDescription = document.getElementById('custom-theme-description');
  const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;

  if (currentSettings.customTheme) {
    if (useCustomThemeBtn) {
      useCustomThemeBtn.style.display = 'block';
    }
    if (customThemeDescription) {
      const themeName = currentSettings.customTheme.name || 'Custom Theme';
      if (currentSettings.theme === 'custom') {
        customThemeDescription.textContent = `Currently using: ${themeName}`;
      } else {
        customThemeDescription.textContent = `Edit or use your custom theme: ${themeName}`;
      }
    }
    if (themeSelect && currentSettings.theme === 'custom') {
      themeSelect.value = 'default';
    }
  } else {
    if (useCustomThemeBtn) {
      useCustomThemeBtn.style.display = 'none';
    }
    if (customThemeDescription) {
      customThemeDescription.textContent = 'Create your own color scheme';
    }
  }

  if (themeSelect && currentSettings.theme !== 'custom') {
    themeSelect.value = currentSettings.theme || 'default';
  }
}

async function showSettingsModal() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  const settingsModal = document.getElementById('settings-modal');

  // Reset tabs
  const tabs = document.querySelectorAll('.settings-tab');
  const sections = document.querySelectorAll('.settings-section');

  tabs.forEach((t) => t.classList.remove('active'));
  sections.forEach((s) => s.classList.remove('active'));

  if (tabs.length > 0) tabs[0].classList.add('active');
  if (sections.length > 0) sections[0].classList.add('active');

  const transparencyToggle = document.getElementById('transparency-toggle') as HTMLInputElement;
  const sortBySelect = document.getElementById('sort-by-select') as HTMLSelectElement;
  const sortOrderSelect = document.getElementById('sort-order-select') as HTMLSelectElement;
  const showHiddenFilesToggle = document.getElementById(
    'show-hidden-files-toggle'
  ) as HTMLInputElement;
  const enableGitStatusToggle = document.getElementById(
    'enable-git-status-toggle'
  ) as HTMLInputElement;
  const minimizeToTrayToggle = document.getElementById(
    'minimize-to-tray-toggle'
  ) as HTMLInputElement;
  const startOnLoginToggle = document.getElementById('start-on-login-toggle') as HTMLInputElement;
  const autoCheckUpdatesToggle = document.getElementById(
    'auto-check-updates-toggle'
  ) as HTMLInputElement;
  const updateChannelSelect = document.getElementById('update-channel-select') as HTMLSelectElement;
  const enableSearchHistoryToggle = document.getElementById(
    'enable-search-history-toggle'
  ) as HTMLInputElement;
  const dangerousOptionsToggle = document.getElementById(
    'dangerous-options-toggle'
  ) as HTMLInputElement;
  const startupPathInput = document.getElementById('startup-path-input') as HTMLInputElement;
  const enableIndexerToggle = document.getElementById('enable-indexer-toggle') as HTMLInputElement;
  const showRecentFilesToggle = document.getElementById(
    'show-recent-files-toggle'
  ) as HTMLInputElement;
  const enableTabsToggle = document.getElementById('enable-tabs-toggle') as HTMLInputElement;
  const globalContentSearchToggle = document.getElementById(
    'global-content-search-toggle'
  ) as HTMLInputElement;
  const enableSyntaxHighlightingToggle = document.getElementById(
    'enable-syntax-highlighting-toggle'
  ) as HTMLInputElement;
  const reduceMotionToggle = document.getElementById('reduce-motion-toggle') as HTMLInputElement;
  const highContrastToggle = document.getElementById('high-contrast-toggle') as HTMLInputElement;
  const largeTextToggle = document.getElementById('large-text-toggle') as HTMLInputElement;
  const boldTextToggle = document.getElementById('bold-text-toggle') as HTMLInputElement;
  const visibleFocusToggle = document.getElementById('visible-focus-toggle') as HTMLInputElement;
  const reduceTransparencyToggle = document.getElementById(
    'reduce-transparency-toggle'
  ) as HTMLInputElement;
  const settingsPath = document.getElementById('settings-path');

  if (transparencyToggle) {
    transparencyToggle.checked = currentSettings.transparency;
  }
  if (enableSyntaxHighlightingToggle) {
    enableSyntaxHighlightingToggle.checked = currentSettings.enableSyntaxHighlighting !== false;
  }
  if (enableGitStatusToggle) {
    enableGitStatusToggle.checked = currentSettings.enableGitStatus === true;
  }

  updateCustomThemeUI();

  const themeSelectForTracking = document.getElementById('theme-select') as HTMLSelectElement;
  if (themeSelectForTracking) {
    themeSelectForTracking.onchange = () => {
      themeDropdownChanged = true;
      markSettingsChanged();
    };
  }

  if (sortBySelect) {
    sortBySelect.value = currentSettings.sortBy || 'name';
  }

  if (sortOrderSelect) {
    sortOrderSelect.value = currentSettings.sortOrder || 'asc';
  }

  if (showHiddenFilesToggle) {
    showHiddenFilesToggle.checked = currentSettings.showHiddenFiles || false;
  }

  if (minimizeToTrayToggle) {
    minimizeToTrayToggle.checked = currentSettings.minimizeToTray || false;
  }

  if (startOnLoginToggle) {
    startOnLoginToggle.checked = currentSettings.startOnLogin || false;
  }

  if (autoCheckUpdatesToggle) {
    autoCheckUpdatesToggle.checked = currentSettings.autoCheckUpdates !== false;
  }

  if (updateChannelSelect) {
    updateChannelSelect.value = currentSettings.updateChannel || 'auto';
  }

  if (enableSearchHistoryToggle) {
    enableSearchHistoryToggle.checked = currentSettings.enableSearchHistory !== false;
  }

  if (dangerousOptionsToggle) {
    dangerousOptionsToggle.checked = currentSettings.showDangerousOptions || false;
    updateDangerousOptionsVisibility(dangerousOptionsToggle.checked);
  }

  if (startupPathInput) {
    startupPathInput.value = currentSettings.startupPath || '';
  }

  if (enableIndexerToggle) {
    enableIndexerToggle.checked = currentSettings.enableIndexer !== false;
  }

  if (showRecentFilesToggle) {
    showRecentFilesToggle.checked = currentSettings.showRecentFiles !== false;
  }

  if (enableTabsToggle) {
    enableTabsToggle.checked = currentSettings.enableTabs !== false;
  }

  if (globalContentSearchToggle) {
    globalContentSearchToggle.checked = currentSettings.globalContentSearch || false;
  }

  if (reduceMotionToggle) {
    reduceMotionToggle.checked = currentSettings.reduceMotion || false;
  }

  if (highContrastToggle) {
    highContrastToggle.checked = currentSettings.highContrast || false;
  }

  if (largeTextToggle) {
    largeTextToggle.checked = currentSettings.largeText || false;
  }

  if (boldTextToggle) {
    boldTextToggle.checked = currentSettings.boldText || false;
  }

  if (visibleFocusToggle) {
    visibleFocusToggle.checked = currentSettings.visibleFocus || false;
  }

  if (reduceTransparencyToggle) {
    reduceTransparencyToggle.checked = currentSettings.reduceTransparency || false;
  }

  await updateIndexStatus();

  const path = await window.electronAPI.getSettingsPath();
  if (settingsPath) {
    settingsPath.textContent = path;
  }

  if (settingsModal) {
    settingsModal.style.display = 'flex';
    clearSettingsChanged();
    initSettingsChangeTracking();
  }
}

function hideSettingsModal() {
  const settingsModal = document.getElementById('settings-modal');
  if (settingsModal) {
    settingsModal.style.display = 'none';
  }
  stopIndexStatusPolling();
}

function startIndexStatusPolling() {
  stopIndexStatusPolling();
  indexStatusInterval = setInterval(async () => {
    await updateIndexStatus();
    const result = await window.electronAPI.getIndexStatus();
    if (result.success && result.status && !result.status.isIndexing) {
      stopIndexStatusPolling();
    }
  }, 500);
}

function stopIndexStatusPolling() {
  if (indexStatusInterval) {
    clearInterval(indexStatusInterval);
    indexStatusInterval = null;
  }
}

async function updateIndexStatus() {
  const indexStatus = document.getElementById('index-status');
  if (!indexStatus) return;

  try {
    const result = await window.electronAPI.getIndexStatus();
    if (result.success && result.status) {
      const status = result.status;
      if (status.isIndexing) {
        indexStatus.textContent = `Status: Indexing... (${status.indexedFiles.toLocaleString()} files found)`;
        if (!indexStatusInterval) {
          startIndexStatusPolling();
        }
      } else if (status.lastIndexTime) {
        const date = new Date(status.lastIndexTime);
        indexStatus.textContent = `Status: ${status.indexedFiles.toLocaleString()} files indexed on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`;
      } else {
        indexStatus.textContent = 'Status: Not indexed yet';
      }
    } else {
      indexStatus.textContent = 'Status: Unknown';
    }
  } catch (error) {
    console.error('Failed to get index status:', error);
    indexStatus.textContent = 'Status: Error';
  }
}

async function rebuildIndex() {
  const rebuildBtn = document.getElementById('rebuild-index-btn') as HTMLButtonElement;
  if (!rebuildBtn) return;

  const originalHTML = rebuildBtn.innerHTML;
  rebuildBtn.disabled = true;
  rebuildBtn.innerHTML = `${twemojiImg(String.fromCodePoint(0x23f3), 'twemoji')} Rebuilding...`;

  try {
    const result = await window.electronAPI.rebuildIndex();
    if (result.success) {
      showToast('Index rebuild started', 'File Indexer', 'success');
      setTimeout(async () => {
        await updateIndexStatus();
      }, 300);
    } else {
      showToast('Failed to rebuild index: ' + result.error, 'Error', 'error');
    }
  } catch (error) {
    showToast('Error rebuilding index', 'Error', 'error');
  } finally {
    rebuildBtn.disabled = false;
    rebuildBtn.innerHTML = originalHTML;
  }
}

function updateDangerousOptionsVisibility(show: boolean) {
  const dangerousOptions = document.querySelectorAll('.dangerous-option');
  dangerousOptions.forEach((option) => {
    (option as HTMLElement).style.display = show ? 'flex' : 'none';
  });
}

function getRepositoryText(repository: unknown): string | null {
  if (typeof repository === 'string') {
    const trimmed = repository.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (repository && typeof repository === 'object' && 'url' in repository) {
    const repoUrl = (repository as { url?: unknown }).url;
    if (typeof repoUrl === 'string') {
      const trimmed = repoUrl.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }

  return null;
}

function normalizeRepositoryUrl(repository: unknown): string | null {
  const raw = getRepositoryText(repository);
  if (!raw) return null;

  let normalized = raw;

  if (normalized.startsWith('git+')) {
    normalized = normalized.slice(4);
  }

  if (normalized.startsWith('git@')) {
    const match = normalized.match(/^git@([^:]+):(.+)$/);
    if (match) {
      normalized = `https://${match[1]}/${match[2]}`;
    }
  }

  if (normalized.startsWith('ssh://git@')) {
    normalized = normalized.replace(/^ssh:\/\/git@/, 'https://');
  }

  if (normalized.startsWith('git://')) {
    normalized = normalized.replace(/^git:\/\//, 'https://');
  }

  if (normalized.endsWith('.git')) {
    normalized = normalized.slice(0, -4);
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    return null;
  }

  return null;
}

async function showLicensesModal() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  const licensesModal = document.getElementById('licenses-modal');
  if (!licensesModal) return;

  licensesModal.style.display = 'flex';

  const licensesContent = document.getElementById('licenses-content');
  const totalDeps = document.getElementById('total-deps');

  if (!licensesContent) return;

  licensesContent.innerHTML =
    '<p style="text-align: center; color: var(--text-secondary);">Loading licenses...</p>';

  try {
    const result = await window.electronAPI.getLicenses();

    if (result.success && result.licenses) {
      const licenses = result.licenses;
      const packageCount = Object.keys(licenses).length;

      if (totalDeps) {
        totalDeps.textContent = packageCount.toString();
      }

      let html = '';

      for (const [packageName, packageInfo] of Object.entries(licenses)) {
        const info = packageInfo as any;
        html += '<div class="license-package">';
        html += `<div class="license-package-name">${escapeHtml(packageName)}</div>`;
        html += '<div class="license-package-info">';
        html += `<span class="license-package-license">${escapeHtml(info.licenses || 'Unknown')}</span>`;
        const repositoryUrl = normalizeRepositoryUrl(info.repository);
        const repositoryText = getRepositoryText(info.repository);
        if (repositoryUrl) {
          html += `<span>Repository: <a class="license-link" href="${escapeHtml(repositoryUrl)}" data-url="${escapeHtml(repositoryUrl)}" rel="noopener noreferrer">${escapeHtml(repositoryUrl)}</a></span>`;
        } else if (repositoryText) {
          html += `<span>Repository: ${escapeHtml(repositoryText)}</span>`;
        }
        if (info.publisher) {
          html += `<span>Publisher: ${escapeHtml(info.publisher)}</span>`;
        }
        html += '</div>';

        if (info.licenseFile && info.licenseText) {
          html += `<div class="license-package-text">${escapeHtml(info.licenseText.substring(0, 1000))}${info.licenseText.length > 1000 ? '...' : ''}</div>`;
        }

        html += '</div>';
      }

      licensesContent.innerHTML = html;
    } else {
      licensesContent.innerHTML = `<p style="color: var(--error-color); text-align: center;">Error loading licenses: ${escapeHtml(result.error || 'Unknown error')}</p>`;
    }
  } catch (error) {
    licensesContent.innerHTML = `<p style="color: var(--error-color); text-align: center;">Error: ${escapeHtml(getErrorMessage(error))}</p>`;
  }
}

function hideLicensesModal() {
  const licensesModal = document.getElementById('licenses-modal');
  if (licensesModal) {
    licensesModal.style.display = 'none';
  }
}

function showShortcutsModal() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  const shortcutsModal = document.getElementById('shortcuts-modal');
  if (shortcutsModal) {
    shortcutsModal.style.display = 'flex';

    if (platformOS === 'darwin') {
      const allKbdElements = shortcutsModal.querySelectorAll('kbd');
      allKbdElements.forEach((kbd) => {
        if (kbd.textContent === 'Ctrl') {
          kbd.textContent = '⌘ Cmd';
        } else if (kbd.textContent === 'Alt') {
          kbd.textContent = '⌥ Option';
        }
      });
    }
  }
}

function hideShortcutsModal() {
  const shortcutsModal = document.getElementById('shortcuts-modal');
  if (shortcutsModal) {
    shortcutsModal.style.display = 'none';
  }
}

const FOLDER_ICON_OPTIONS = [
  0x1f4c1, 0x1f4c2, 0x1f4c1, 0x1f5c2, 0x1f5c3, 0x1f4bc, 0x2b50, 0x1f31f, 0x2764, 0x1f499, 0x1f49a,
  0x1f49b, 0x1f4a1, 0x1f3ae, 0x1f3b5, 0x1f3ac, 0x1f4f7, 0x1f4f9, 0x1f4da, 0x1f4d6, 0x1f4dd, 0x270f,
  0x1f4bb, 0x1f5a5, 0x1f3e0, 0x1f3e2, 0x1f6e0, 0x2699, 0x1f512, 0x1f513, 0x1f4e6, 0x1f4e5, 0x1f4e4,
  0x1f5d1, 0x2601, 0x1f310, 0x1f680, 0x2708, 0x1f697, 0x1f6b2, 0x26bd, 0x1f3c0, 0x1f352, 0x1f34e,
  0x1f33f, 0x1f333, 0x1f308, 0x2600,
];

let folderIconPickerPath: string | null = null;

function showFolderIconPicker(folderPath: string) {
  const modal = document.getElementById('folder-icon-modal');
  const pathDisplay = document.getElementById('folder-icon-path');
  const grid = document.getElementById('folder-icon-grid');

  if (!modal || !pathDisplay || !grid) return;

  folderIconPickerPath = folderPath;

  const folderName = folderPath.split(/[/\\]/).pop() || folderPath;
  pathDisplay.textContent = folderName;

  const currentIcon = currentSettings.folderIcons?.[folderPath];

  grid.innerHTML = FOLDER_ICON_OPTIONS.map((code) => {
    const emoji = String.fromCodePoint(code);
    const isSelected = currentIcon === emoji;
    return `
      <div class="folder-icon-option${isSelected ? ' selected' : ''}" data-icon="${emoji}">
        ${twemojiImg(emoji, 'twemoji')}
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.folder-icon-option').forEach((option) => {
    option.addEventListener('click', () => {
      const icon = (option as HTMLElement).dataset.icon;
      if (icon && folderIconPickerPath) {
        setFolderIcon(folderIconPickerPath, icon);
        hideFolderIconPicker();
      }
    });
  });

  modal.style.display = 'flex';
}

function hideFolderIconPicker() {
  const modal = document.getElementById('folder-icon-modal');
  if (modal) {
    modal.style.display = 'none';
  }
  folderIconPickerPath = null;
}

async function setFolderIcon(folderPath: string, icon: string) {
  if (!currentSettings.folderIcons) {
    currentSettings.folderIcons = {};
  }
  currentSettings.folderIcons[folderPath] = icon;
  await saveSettings();
  if (currentPath) navigateTo(currentPath);
  showToast('Folder icon updated', 'Success', 'success');
}

async function resetFolderIcon() {
  if (
    folderIconPickerPath &&
    currentSettings.folderIcons &&
    currentSettings.folderIcons[folderIconPickerPath]
  ) {
    delete currentSettings.folderIcons[folderIconPickerPath];
    await saveSettings();
    if (currentPath) navigateTo(currentPath);
    showToast('Folder icon reset to default', 'Success', 'success');
  }
  hideFolderIconPicker();
}

function getFolderIcon(folderPath: string): string {
  const customIcon = currentSettings.folderIcons?.[folderPath];
  if (customIcon) {
    return twemojiImg(customIcon, 'twemoji file-icon');
  }
  return FOLDER_ICON;
}

function openNewWindow() {
  window.electronAPI.openNewWindow();
}

function copyLicensesText() {
  const licensesContent = document.getElementById('licenses-content');
  if (!licensesContent) return;

  const text = licensesContent.innerText;
  navigator.clipboard
    .writeText(text)
    .then(() => {
      const btn = document.getElementById('copy-licenses-btn');
      if (btn) {
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      }
    })
    .catch((err) => {
      console.error('Failed to copy:', err);
    });
}

async function saveSettings() {
  const previousTabsEnabled = tabsEnabled;
  const transparencyToggle = document.getElementById('transparency-toggle') as HTMLInputElement;
  const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
  const sortBySelect = document.getElementById('sort-by-select') as HTMLSelectElement;
  const sortOrderSelect = document.getElementById('sort-order-select') as HTMLSelectElement;
  const showHiddenFilesToggle = document.getElementById(
    'show-hidden-files-toggle'
  ) as HTMLInputElement;
  const enableGitStatusToggle = document.getElementById(
    'enable-git-status-toggle'
  ) as HTMLInputElement;
  const minimizeToTrayToggle = document.getElementById(
    'minimize-to-tray-toggle'
  ) as HTMLInputElement;
  const startOnLoginToggle = document.getElementById('start-on-login-toggle') as HTMLInputElement;
  const autoCheckUpdatesToggle = document.getElementById(
    'auto-check-updates-toggle'
  ) as HTMLInputElement;
  const updateChannelSelect = document.getElementById('update-channel-select') as HTMLSelectElement;
  const enableSearchHistoryToggle = document.getElementById(
    'enable-search-history-toggle'
  ) as HTMLInputElement;
  const dangerousOptionsToggle = document.getElementById(
    'dangerous-options-toggle'
  ) as HTMLInputElement;
  const startupPathInput = document.getElementById('startup-path-input') as HTMLInputElement;
  const enableIndexerToggle = document.getElementById('enable-indexer-toggle') as HTMLInputElement;
  const showRecentFilesToggle = document.getElementById(
    'show-recent-files-toggle'
  ) as HTMLInputElement;
  const enableTabsToggle = document.getElementById('enable-tabs-toggle') as HTMLInputElement;
  const globalContentSearchToggle = document.getElementById(
    'global-content-search-toggle'
  ) as HTMLInputElement;
  const enableSyntaxHighlightingToggle = document.getElementById(
    'enable-syntax-highlighting-toggle'
  ) as HTMLInputElement;
  const reduceMotionToggle = document.getElementById('reduce-motion-toggle') as HTMLInputElement;
  const highContrastToggle = document.getElementById('high-contrast-toggle') as HTMLInputElement;
  const largeTextToggle = document.getElementById('large-text-toggle') as HTMLInputElement;
  const boldTextToggle = document.getElementById('bold-text-toggle') as HTMLInputElement;
  const visibleFocusToggle = document.getElementById('visible-focus-toggle') as HTMLInputElement;
  const reduceTransparencyToggle = document.getElementById(
    'reduce-transparency-toggle'
  ) as HTMLInputElement;

  if (transparencyToggle) {
    currentSettings.transparency = transparencyToggle.checked;
  }
  if (enableSyntaxHighlightingToggle) {
    currentSettings.enableSyntaxHighlighting = enableSyntaxHighlightingToggle.checked;
  }

  if (themeSelect) {
    if (currentSettings.theme === 'custom') {
      if (themeDropdownChanged) {
        currentSettings.theme = themeSelect.value as any;
      }
    } else {
      currentSettings.theme = themeSelect.value as any;
    }
  }

  if (sortBySelect) {
    currentSettings.sortBy = sortBySelect.value as any;
  }

  if (sortOrderSelect) {
    currentSettings.sortOrder = sortOrderSelect.value as any;
  }

  if (showHiddenFilesToggle) {
    currentSettings.showHiddenFiles = showHiddenFilesToggle.checked;
  }
  if (enableGitStatusToggle) {
    currentSettings.enableGitStatus = enableGitStatusToggle.checked;
  }

  if (minimizeToTrayToggle) {
    currentSettings.minimizeToTray = minimizeToTrayToggle.checked;
  }

  if (startOnLoginToggle) {
    currentSettings.startOnLogin = startOnLoginToggle.checked;
  }

  if (autoCheckUpdatesToggle) {
    currentSettings.autoCheckUpdates = autoCheckUpdatesToggle.checked;
  }

  if (updateChannelSelect) {
    currentSettings.updateChannel = updateChannelSelect.value as 'auto' | 'beta' | 'stable';
  }

  if (enableSearchHistoryToggle) {
    currentSettings.enableSearchHistory = enableSearchHistoryToggle.checked;
  }

  if (dangerousOptionsToggle) {
    currentSettings.showDangerousOptions = dangerousOptionsToggle.checked;
    updateDangerousOptionsVisibility(currentSettings.showDangerousOptions);
  }

  if (startupPathInput) {
    currentSettings.startupPath = startupPathInput.value;
  }

  if (enableIndexerToggle) {
    currentSettings.enableIndexer = enableIndexerToggle.checked;
  }

  if (showRecentFilesToggle) {
    currentSettings.showRecentFiles = showRecentFilesToggle.checked;
  }

  if (enableTabsToggle) {
    currentSettings.enableTabs = enableTabsToggle.checked;
  }

  if (globalContentSearchToggle) {
    currentSettings.globalContentSearch = globalContentSearchToggle.checked;
  }

  if (reduceMotionToggle) {
    currentSettings.reduceMotion = reduceMotionToggle.checked;
  }

  if (highContrastToggle) {
    currentSettings.highContrast = highContrastToggle.checked;
  }

  if (largeTextToggle) {
    currentSettings.largeText = largeTextToggle.checked;
  }

  if (boldTextToggle) {
    currentSettings.boldText = boldTextToggle.checked;
  }

  if (visibleFocusToggle) {
    currentSettings.visibleFocus = visibleFocusToggle.checked;
  }

  if (reduceTransparencyToggle) {
    currentSettings.reduceTransparency = reduceTransparencyToggle.checked;
  }

  currentSettings.viewMode = viewMode;

  const result = await window.electronAPI.saveSettings(currentSettings);
  if (result.success) {
    if (previousTabsEnabled !== currentSettings.enableTabs) {
      initializeTabs();
    }
    applySettings(currentSettings);
    clearSettingsChanged();
    hideSettingsModal();
    showToast('Settings saved successfully!', 'Settings', 'success');
    if (currentPath) {
      refresh();
    }
  } else {
    showToast('Failed to save settings: ' + result.error, 'Error', 'error');
  }
}

async function resetSettings() {
  const confirmed = await showConfirm(
    'Are you sure you want to reset all settings to default? The app will restart. This cannot be undone.',
    'Reset Settings',
    'warning'
  );

  if (confirmed) {
    const result = await window.electronAPI.resetSettings();
    if (result.success) {
      await window.electronAPI.relaunchApp();
    } else {
      showToast('Failed to reset settings: ' + result.error, 'Error', 'error');
    }
  }
}

function loadBookmarks() {
  if (!bookmarksList) return;
  bookmarksList.innerHTML = '';

  if (!currentSettings.bookmarks || currentSettings.bookmarks.length === 0) {
    return;
  }

  currentSettings.bookmarks.forEach((bookmarkPath) => {
    const bookmarkItem = document.createElement('div');
    bookmarkItem.className = 'bookmark-item';
    const pathParts = bookmarkPath.split(/[/\\]/);
    const name = pathParts[pathParts.length - 1] || bookmarkPath;

    bookmarkItem.innerHTML = `
      <span class="bookmark-icon">${twemojiImg(String.fromCodePoint(0x2b50), 'twemoji')}</span>
      <span class="bookmark-label">${escapeHtml(name)}</span>
      <button class="bookmark-remove" title="Remove bookmark">${twemojiImg(String.fromCodePoint(0x274c), 'twemoji')}</button>
    `;

    bookmarkItem.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).classList.contains('bookmark-remove')) {
        navigateTo(bookmarkPath);
      }
    });

    const removeBtn = bookmarkItem.querySelector('.bookmark-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeBookmark(bookmarkPath);
      });
    }

    bookmarksList.appendChild(bookmarkItem);
  });
}

async function addBookmark() {
  if (!currentPath) return;
  await addBookmarkByPath(currentPath);
}

async function addBookmarkByPath(path: string) {
  if (!currentSettings.bookmarks) {
    currentSettings.bookmarks = [];
  }

  if (currentSettings.bookmarks.includes(path)) {
    showToast('This folder is already bookmarked', 'Bookmarks', 'info');
    return;
  }

  currentSettings.bookmarks.push(path);
  const result = await window.electronAPI.saveSettings(currentSettings);

  if (result.success) {
    loadBookmarks();
    showToast('Bookmark added', 'Bookmarks', 'success');
  } else {
    showToast('Failed to add bookmark', 'Error', 'error');
  }
}

async function removeBookmark(path: string) {
  if (!currentSettings.bookmarks) return;

  currentSettings.bookmarks = currentSettings.bookmarks.filter((b) => b !== path);
  const result = await window.electronAPI.saveSettings(currentSettings);

  if (result.success) {
    loadBookmarks();
    showToast('Bookmark removed', 'Bookmarks', 'success');
  } else {
    showToast('Failed to remove bookmark', 'Error', 'error');
  }
}

const MAX_RECENT_FILES = 10;

function loadRecentFiles() {
  const recentList = document.getElementById('recent-list');
  const recentSection = document.getElementById('recent-section');
  if (!recentList || !recentSection) return;

  recentList.innerHTML = '';

  if (currentSettings.showRecentFiles === false) {
    recentSection.style.display = 'none';
    return;
  }

  if (!currentSettings.recentFiles || currentSettings.recentFiles.length === 0) {
    recentSection.style.display = 'none';
    return;
  }

  recentSection.style.display = 'block';

  currentSettings.recentFiles.forEach((filePath) => {
    const recentItem = document.createElement('div');
    recentItem.className = 'nav-item recent-item';
    const pathParts = filePath.split(/[/\\]/);
    const name = pathParts[pathParts.length - 1] || filePath;
    const icon = getFileIcon(name);

    recentItem.innerHTML = `
      <span class="nav-icon">${icon}</span>
      <span class="nav-label" title="${escapeHtml(filePath)}">${escapeHtml(name)}</span>
    `;

    recentItem.addEventListener('click', () => {
      window.electronAPI.openFile(filePath);
    });

    recentList.appendChild(recentItem);
  });
}

async function addToRecentFiles(filePath: string) {
  if (!filePath || filePath.startsWith('http://') || filePath.startsWith('https://')) return;

  if (!currentSettings.recentFiles) {
    currentSettings.recentFiles = [];
  }

  currentSettings.recentFiles = currentSettings.recentFiles.filter((f) => f !== filePath);
  currentSettings.recentFiles.unshift(filePath);
  currentSettings.recentFiles = currentSettings.recentFiles.slice(0, MAX_RECENT_FILES);

  debouncedSaveSettings();
  loadRecentFiles();
}

function toggleSearch() {
  if (searchBarWrapper.style.display === 'none' || !searchBarWrapper.style.display) {
    searchBarWrapper.style.display = 'block';
    searchInput.focus();
    isSearchMode = true;
    updateSearchPlaceholder();
  } else {
    closeSearch();
  }
}

function closeSearch() {
  searchRequestId += 1;
  cancelActiveSearch();
  searchBarWrapper.style.display = 'none';
  searchInput.value = '';
  isSearchMode = false;
  isGlobalSearch = false;
  searchScopeToggle.classList.remove('global');
  hideSearchHistoryDropdown();
  updateSearchPlaceholder();

  searchFiltersPanel.style.display = 'none';
  searchFilterToggle.classList.remove('active');
  currentSearchFilters = {};

  if (currentPath) {
    navigateTo(currentPath);
  }
}

function toggleSearchScope() {
  isGlobalSearch = !isGlobalSearch;
  if (isGlobalSearch) {
    searchScopeToggle.classList.add('global');
    searchScopeToggle.title = 'Global Search (All Indexed Files)';
    const img = searchScopeToggle.querySelector('img');
    if (img) {
      img.src = 'assets/twemoji/1f30d.svg';
      img.alt = '🌍';
    }
  } else {
    searchScopeToggle.classList.remove('global');
    searchScopeToggle.title = 'Local Search (Current Folder)';
    const img = searchScopeToggle.querySelector('img');
    if (img) {
      img.src = 'assets/twemoji/1f4c1.svg';
      img.alt = '📁';
    }
  }
  updateSearchPlaceholder();
  updateContentSearchToggle();

  if (searchInput.value.trim()) {
    performSearch();
  }
}

function updateContentSearchToggle() {
  if (!searchInContentsToggle) return;

  if (isGlobalSearch && !currentSettings.globalContentSearch) {
    searchInContentsToggle.disabled = true;
    searchInContentsToggle.checked = false;
    searchInContents = false;
    searchInContentsToggle.parentElement?.classList.add('disabled');
    searchInContentsToggle.title = 'Enable "Global Content Search" in settings to use this feature';
  } else {
    searchInContentsToggle.disabled = false;
    searchInContentsToggle.parentElement?.classList.remove('disabled');
    searchInContentsToggle.title = '';
  }
}

function updateSearchPlaceholder() {
  if (isGlobalSearch) {
    searchInput.placeholder = 'Search all files...';
  } else {
    searchInput.placeholder = 'Search files...';
  }
}

async function performSearch() {
  const query = searchInput.value.trim();
  if (!query) {
    searchRequestId += 1;
    cancelActiveSearch();
    return;
  }

  if (!isGlobalSearch && !currentPath) return;

  const currentRequestId = ++searchRequestId;
  cancelActiveSearch();
  const operationId = createDirectoryOperationId('search');
  activeSearchOperationId = operationId;

  addToSearchHistory(query);

  loading.style.display = 'flex';
  emptyState.style.display = 'none';
  fileGrid.innerHTML = '';

  let result;
  const hasFilters =
    currentSearchFilters.fileType ||
    currentSearchFilters.minSize !== undefined ||
    currentSearchFilters.maxSize !== undefined ||
    currentSearchFilters.dateFrom ||
    currentSearchFilters.dateTo ||
    searchInContents;

  if (isGlobalSearch) {
    if (searchInContents) {
      result = await window.electronAPI.searchFilesWithContentGlobal(
        query,
        hasFilters ? currentSearchFilters : undefined,
        operationId
      );
      if (currentRequestId !== searchRequestId) return;

      if (result.success && result.results) {
        allFiles = result.results;
        renderFiles(result.results, query);
      } else if (result.error !== 'Calculation cancelled') {
        if (result.error === 'Indexer is disabled') {
          showToast(
            'File indexer is disabled. Enable it in settings to use global search.',
            'Index Disabled',
            'warning'
          );
        } else {
          showToast(result.error || 'Global content search failed', 'Search Error', 'error');
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

        allFiles = fileItems;
        renderFiles(fileItems);
      } else if (result.error !== 'Calculation cancelled') {
        if (result.error === 'Indexer is disabled') {
          showToast(
            'File indexer is disabled. Enable it in settings to use global search.',
            'Index Disabled',
            'warning'
          );
        } else {
          showToast(result.error || 'Global search failed', 'Search Error', 'error');
        }
      }
    }
  } else {
    if (searchInContents) {
      result = await window.electronAPI.searchFilesWithContent(
        currentPath,
        query,
        hasFilters ? currentSearchFilters : undefined,
        operationId
      );
    } else {
      result = await window.electronAPI.searchFiles(
        currentPath,
        query,
        hasFilters ? currentSearchFilters : undefined,
        operationId
      );
    }
    if (currentRequestId !== searchRequestId) return;

    if (result.success && result.results) {
      allFiles = result.results;
      renderFiles(result.results, searchInContents ? query : undefined);
    } else if (result.error !== 'Calculation cancelled') {
      showToast(result.error || 'Search failed', 'Search Error', 'error');
    }
  }

  if (currentRequestId !== searchRequestId) return;
  loading.style.display = 'none';
  updateStatusBar();
  activeSearchOperationId = null;
}

function copyToClipboard() {
  if (selectedItems.size === 0) return;
  clipboard = {
    operation: 'copy',
    paths: Array.from(selectedItems),
  };
  // Sync main process
  window.electronAPI.setClipboard(clipboard);
  updateCutVisuals();
  showToast(`${selectedItems.size} item(s) copied`, 'Clipboard', 'success');
}

function cutToClipboard() {
  if (selectedItems.size === 0) return;
  clipboard = {
    operation: 'cut',
    paths: Array.from(selectedItems),
  };
  window.electronAPI.setClipboard(clipboard);
  updateCutVisuals();
  showToast(`${selectedItems.size} item(s) cut`, 'Clipboard', 'success');
}

async function pasteFromClipboard() {
  if (!clipboard || !currentPath) return;

  const isCopy = clipboard.operation === 'copy';
  const result = isCopy
    ? await window.electronAPI.copyItems(clipboard.paths, currentPath)
    : await window.electronAPI.moveItems(clipboard.paths, currentPath);

  if (result.success) {
    showToast(
      `${clipboard.paths.length} item(s) ${isCopy ? 'copied' : 'moved'}`,
      'Success',
      'success'
    );

    if (!isCopy) {
      await updateUndoRedoState();
      clipboard = null;
      window.electronAPI.setClipboard(null);
    }

    updateCutVisuals();
    refresh();
  } else {
    showToast(result.error || 'Operation failed', 'Error', 'error');
  }
}

function updateCutVisuals() {
  document.querySelectorAll('.file-item').forEach((item) => {
    const itemPath = item.getAttribute('data-path');
    if (
      itemPath &&
      clipboard &&
      clipboard.operation === 'cut' &&
      clipboard.paths.includes(itemPath)
    ) {
      item.classList.add('cut');
    } else {
      item.classList.remove('cut');
    }
  });
}

function showSortMenu(e: MouseEvent) {
  const sortMenu = document.getElementById('sort-menu');
  if (!sortMenu) return;

  const rect = sortBtn.getBoundingClientRect();
  sortMenu.style.display = 'block';

  const menuRect = sortMenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = rect.left;
  let top = rect.bottom + 5;

  if (left + menuRect.width > viewportWidth) {
    left = viewportWidth - menuRect.width - 10;
  }

  if (top + menuRect.height > viewportHeight) {
    top = rect.top - menuRect.height - 5;
  }

  if (left < 10) left = 10;
  if (top < 10) top = 10;

  sortMenu.style.left = left + 'px';
  sortMenu.style.top = top + 'px';

  updateSortIndicators();

  e.stopPropagation();
}

function hideSortMenu() {
  const sortMenu = document.getElementById('sort-menu');
  if (sortMenu) {
    sortMenu.style.display = 'none';
  }
}

function updateSortIndicators() {
  ['name', 'date', 'size', 'type'].forEach((sortType) => {
    const indicator = document.getElementById(`sort-${sortType}`);
    if (indicator) {
      if (currentSettings.sortBy === sortType) {
        indicator.textContent = currentSettings.sortOrder === 'asc' ? '▲' : '▼';
      } else {
        indicator.textContent = '';
      }
    }
  });
}

async function changeSortMode(sortBy: string) {
  if (currentSettings.sortBy === sortBy) {
    currentSettings.sortOrder = currentSettings.sortOrder === 'asc' ? 'desc' : 'asc';
  } else {
    currentSettings.sortBy = sortBy as any;
    currentSettings.sortOrder = 'asc';
  }

  await window.electronAPI.saveSettings(currentSettings);
  hideSortMenu();

  if (allFiles.length > 0) {
    renderFiles(allFiles);
  }
}

function updateStatusBar() {
  const statusItems = document.getElementById('status-items');
  const statusSelected = document.getElementById('status-selected');

  if (statusItems) {
    statusItems.textContent = `${allFiles.length} item${allFiles.length !== 1 ? 's' : ''}`;
  }

  if (statusSelected) {
    if (selectedItems.size > 0) {
      const totalSize = Array.from(selectedItems).reduce((acc, path) => {
        const item = filePathMap.get(path);
        return acc + (item ? item.size : 0);
      }, 0);
      const sizeStr = formatFileSize(totalSize);
      statusSelected.textContent = `${selectedItems.size} selected (${sizeStr})`;
      statusSelected.style.display = 'inline';
    } else {
      statusSelected.style.display = 'none';
    }
  }
}

// disk space query timer
let diskSpaceDebounceTimer: NodeJS.Timeout | null = null;
let lastDiskSpacePath: string = '';

function getUnixDrivePath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/');
  const roots = ['/Volumes', '/media', '/mnt', '/run/media'];
  for (const root of roots) {
    if (normalized === root || normalized.startsWith(root + '/')) {
      const parts = normalized.split('/').filter(Boolean);
      const rootParts = root.split('/').filter(Boolean);
      const extraSegments = root === '/run/media' ? 2 : 1;
      const needed = rootParts.length + extraSegments;
      if (parts.length >= needed) {
        return '/' + parts.slice(0, needed).join('/');
      }
      return root;
    }
  }
  return '/';
}

async function updateDiskSpace() {
  const statusDiskSpace = document.getElementById('status-disk-space');
  if (!statusDiskSpace || !currentPath) return;

  let drivePath = currentPath;
  if (platformOS === 'win32') {
    drivePath = currentPath.substring(0, 3);
  } else {
    drivePath = getUnixDrivePath(currentPath);
  }

  if (drivePath === lastDiskSpacePath && diskSpaceDebounceTimer) {
    return;
  }

  if (diskSpaceDebounceTimer) {
    clearTimeout(diskSpaceDebounceTimer);
  }

  lastDiskSpacePath = drivePath;

  diskSpaceDebounceTimer = setTimeout(async () => {
    const result = await window.electronAPI.getDiskSpace(drivePath);
    if (
      result.success &&
      typeof result.total === 'number' &&
      typeof result.free === 'number' &&
      result.total > 0
    ) {
      const total = result.total;
      const free = result.free;
      const freeStr = formatFileSize(free);
      const totalStr = formatFileSize(total);
      const usedBytes = total - free;
      const usedPercent = ((usedBytes / total) * 100).toFixed(1);
      let usageColor = '#107c10';
      if (parseFloat(usedPercent) > 80) {
        usageColor = '#ff8c00';
      }
      if (parseFloat(usedPercent) > 90) {
        usageColor = '#e81123';
      }

      statusDiskSpace.innerHTML = `
        <span style="display: inline-flex; align-items: center; gap: 6px;">
          ${twemojiImg(String.fromCodePoint(0x1f4be), 'twemoji')} ${freeStr} free of ${totalStr}
          <span style="display: inline-block; width: 60px; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; position: relative;">
            <span style="position: absolute; left: 0; top: 0; height: 100%; width: ${usedPercent}%; background: ${usageColor}; transition: width 0.3s ease;"></span>
          </span>
          <span style="opacity: 0.7;">(${usedPercent}% used)</span>
        </span>
      `;
    } else {
      statusDiskSpace.textContent = '';
    }
    diskSpaceDebounceTimer = null;
  }, 300);
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function updateZoomLevel(newZoom: number) {
  currentZoomLevel = Math.max(0.5, Math.min(2.0, newZoom));
  const result = await window.electronAPI.setZoomLevel(currentZoomLevel);

  if (result.success) {
    updateZoomDisplay();
    showZoomPopup();
  }
}

function updateZoomDisplay() {
  const zoomDisplay = document.getElementById('zoom-level-display');
  if (zoomDisplay) {
    zoomDisplay.textContent = `${Math.round(currentZoomLevel * 100)}%`;
  }
}

function showZoomPopup() {
  const zoomPopup = document.getElementById('zoom-popup') as HTMLElement;
  if (!zoomPopup) return;

  zoomPopup.style.display = 'flex';

  if (zoomPopupTimeout) {
    clearTimeout(zoomPopupTimeout);
  }

  zoomPopupTimeout = setTimeout(() => {
    zoomPopup.style.display = 'none';
  }, 2000);
}

async function zoomIn() {
  await updateZoomLevel(currentZoomLevel + 0.1);
}

async function zoomOut() {
  await updateZoomLevel(currentZoomLevel - 0.1);
}

async function zoomReset() {
  await updateZoomLevel(1.0);
}

async function init() {
  console.log('Init: Getting platform, store info, and settings...');

  const homeDirectoryPromise = window.electronAPI.getHomeDirectory();

  const [platform, mas, flatpak, msStore] = await Promise.all([
    window.electronAPI.getPlatform(),
    window.electronAPI.isMas(),
    window.electronAPI.isFlatpak(),
    window.electronAPI.isMsStore(),
    loadSettings(),
  ]);

  platformOS = platform;

  const startupPath =
    currentSettings.startupPath && currentSettings.startupPath.trim() !== ''
      ? currentSettings.startupPath
      : await homeDirectoryPromise;

  setupEventListeners();
  loadDrives();
  initializeTabs();

  await navigateTo(startupPath);

  queueMicrotask(() => {
    setupBreadcrumbListeners();
    setupThemeEditorListeners();
    loadBookmarks();
  });

  const isStoreVersion = mas || flatpak || msStore;

  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(() => {
      if (isStoreVersion) {
        const updateBtn = document.getElementById('check-updates-btn');
        if (updateBtn) {
          updateBtn.style.display = 'none';
        }

        const autoCheckToggle = document.getElementById('auto-check-updates-toggle');
        if (autoCheckToggle) {
          const settingItem = autoCheckToggle.closest('.setting-item') as HTMLElement;
          if (settingItem) {
            settingItem.style.display = 'none';
          }
        }

        const updatesCards = document.querySelectorAll('.settings-card-header');
        updatesCards.forEach((header) => {
          if (header.textContent === 'Updates') {
            const card = header.closest('.settings-card') as HTMLElement;
            if (card) {
              card.style.display = 'none';
            }
          }
        });
      }

      if (mas || msStore) {
        const settingsCards = document.querySelectorAll('.settings-card-header');
        settingsCards.forEach((header) => {
          if (header.textContent === 'Developer Options') {
            const card = header.closest('.settings-card') as HTMLElement;
            if (card) {
              card.style.display = 'none';
            }
          }
        });
      }
    });
  }

  setTimeout(() => {
    updateUndoRedoState();

    window.electronAPI.getZoomLevel().then((zoomResult) => {
      if (zoomResult.success && zoomResult.zoomLevel) {
        currentZoomLevel = zoomResult.zoomLevel;
        updateZoomDisplay();
      }
    });

    const cleanupUpdateAvailable = window.electronAPI.onUpdateAvailable((info) => {
      console.log('Update available:', info);

      const settingsBtn = document.getElementById('settings-btn');
      if (settingsBtn) {
        if (!settingsBtn.querySelector('.notification-badge')) {
          const badge = document.createElement('span');
          badge.className = 'notification-badge';
          badge.textContent = '1';
          settingsBtn.style.position = 'relative';
          settingsBtn.appendChild(badge);
        }
      }

      const checkUpdatesBtn = document.getElementById('check-updates-btn');
      if (checkUpdatesBtn) {
        checkUpdatesBtn.innerHTML = `${twemojiImg(String.fromCodePoint(0x1f389), 'twemoji')} Update Available!`;
        checkUpdatesBtn.classList.add('primary');
      }
    });
    ipcCleanupFunctions.push(cleanupUpdateAvailable);

    const cleanupSystemResumed = window.electronAPI.onSystemResumed(() => {
      console.log('[Renderer] System resumed from sleep, refreshing view...');
      lastDiskSpacePath = '';
      if (diskSpaceDebounceTimer) {
        clearTimeout(diskSpaceDebounceTimer);
        diskSpaceDebounceTimer = null;
      }
      if (currentPath) {
        refresh();
      }
      loadDrives();
    });
    ipcCleanupFunctions.push(cleanupSystemResumed);
  }, 0);

  console.log('Init: Complete');
}

async function loadDrives() {
  if (!drivesList) return;

  const drives = await window.electronAPI.getDrives();
  drivesList.innerHTML = '';

  drives.forEach((drive) => {
    const driveItem = document.createElement('div');
    driveItem.className = 'nav-item';
    driveItem.innerHTML = `
      <span class="nav-icon">${twemojiImg(String.fromCodePoint(0x1f4be), 'twemoji')}</span>
      <span class="nav-label">${escapeHtml(drive)}</span>
    `;
    driveItem.addEventListener('click', () => navigateTo(drive));
    drivesList.appendChild(driveItem);
  });
}

function setupEventListeners() {
  initSettingsTabs();

  const cleanupClipboard = window.electronAPI.onClipboardChanged((newClipboard) => {
    clipboard = newClipboard;
    updateCutVisuals();
    console.log('[Sync] Clipboard updated from another window');
  });
  ipcCleanupFunctions.push(cleanupClipboard);

  const cleanupSettings = window.electronAPI.onSettingsChanged((newSettings) => {
    console.log('[Sync] Settings updated from another window');
    currentSettings = newSettings;
    applySettings(newSettings);
  });
  ipcCleanupFunctions.push(cleanupSettings);

  document.getElementById('minimize-btn')?.addEventListener('click', () => {
    window.electronAPI.minimizeWindow();
  });

  document.getElementById('maximize-btn')?.addEventListener('click', () => {
    window.electronAPI.maximizeWindow();
  });

  document.getElementById('close-btn')?.addEventListener('click', () => {
    window.electronAPI.closeWindow();
  });

  backBtn?.addEventListener('click', goBack);
  forwardBtn?.addEventListener('click', goForward);
  upBtn?.addEventListener('click', goUp);
  undoBtn?.addEventListener('click', performUndo);
  redoBtn?.addEventListener('click', performRedo);
  refreshBtn?.addEventListener('click', refresh);
  newFileBtn?.addEventListener('click', createNewFile);
  newFolderBtn?.addEventListener('click', createNewFolder);
  viewToggleBtn?.addEventListener('click', toggleView);

  const emptyNewFolderBtn = document.getElementById('empty-new-folder-btn');
  const emptyNewFileBtn = document.getElementById('empty-new-file-btn');
  emptyNewFolderBtn?.addEventListener('click', createNewFolder);
  emptyNewFileBtn?.addEventListener('click', createNewFile);

  document.addEventListener('mouseup', (e) => {
    if (e.button === 3) {
      e.preventDefault();
      goBack();
    } else if (e.button === 4) {
      e.preventDefault();
      goForward();
    }
  });

  searchBtn?.addEventListener('click', toggleSearch);
  searchClose?.addEventListener('click', closeSearch);
  searchScopeToggle?.addEventListener('click', toggleSearchScope);

  searchFilterToggle?.addEventListener('click', () => {
    if (searchFiltersPanel.style.display === 'none' || !searchFiltersPanel.style.display) {
      searchFiltersPanel.style.display = 'block';
      searchFilterToggle.classList.add('active');
    } else {
      searchFiltersPanel.style.display = 'none';
      searchFilterToggle.classList.remove('active');
    }
  });

  searchFilterApply?.addEventListener('click', () => {
    const fileType = searchFilterType.value;
    const minSizeValue = searchFilterMinSize.value
      ? parseFloat(searchFilterMinSize.value)
      : undefined;
    const maxSizeValue = searchFilterMaxSize.value
      ? parseFloat(searchFilterMaxSize.value)
      : undefined;
    const minSizeUnit = parseFloat(searchFilterSizeUnitMin.value);
    const maxSizeUnit = parseFloat(searchFilterSizeUnitMax.value);

    currentSearchFilters = {
      fileType: fileType !== 'all' ? fileType : undefined,
      minSize: minSizeValue !== undefined ? minSizeValue * minSizeUnit : undefined,
      maxSize: maxSizeValue !== undefined ? maxSizeValue * maxSizeUnit : undefined,
      dateFrom: searchFilterDateFrom.value || undefined,
      dateTo: searchFilterDateTo.value || undefined,
    };

    const hasActiveFilters =
      currentSearchFilters.fileType ||
      currentSearchFilters.minSize !== undefined ||
      currentSearchFilters.maxSize !== undefined ||
      currentSearchFilters.dateFrom ||
      currentSearchFilters.dateTo;

    if (hasActiveFilters) {
      searchFilterToggle.classList.add('active');
    }

    searchFiltersPanel.style.display = 'none';

    if (searchInput.value.trim()) {
      performSearch();
    }
  });

  searchFilterClear?.addEventListener('click', () => {
    searchFilterType.value = 'all';
    searchFilterMinSize.value = '';
    searchFilterMaxSize.value = '';
    searchFilterSizeUnitMin.value = '1024';
    searchFilterSizeUnitMax.value = '1048576';
    searchFilterDateFrom.value = '';
    searchFilterDateTo.value = '';
    currentSearchFilters = {};
    searchFilterToggle.classList.remove('active');

    if (searchInput.value.trim()) {
      performSearch();
    }
  });

  searchInContentsToggle?.addEventListener('change', () => {
    searchInContents = searchInContentsToggle.checked;
    if (searchInput.value.trim()) {
      performSearch();
    }
  });

  sortBtn?.addEventListener('click', showSortMenu);
  bookmarkAddBtn?.addEventListener('click', addBookmark);

  searchInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      hideSearchHistoryDropdown();
      performSearch();
    }
  });

  searchInput?.addEventListener('input', () => {
    if (searchInput.value.length === 0) {
      closeSearch();
    } else if (searchInput.value.length >= 2) {
      debouncedSearch();
    }
  });

  addressInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      navigateTo(addressInput.value);
    }
  });

  function isModalOpen(): boolean {
    const settingsModal = document.getElementById('settings-modal');
    const shortcutsModal = document.getElementById('shortcuts-modal');
    const dialogModal = document.getElementById('dialog-modal');
    const licensesModal = document.getElementById('licenses-modal');
    const quicklookModal = document.getElementById('quicklook-modal');

    return !!(
      (settingsModal && settingsModal.style.display === 'flex') ||
      (shortcutsModal && shortcutsModal.style.display === 'flex') ||
      (dialogModal && dialogModal.style.display === 'flex') ||
      (licensesModal && licensesModal.style.display === 'flex') ||
      (quicklookModal && quicklookModal.style.display === 'flex')
    );
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const settingsModal = document.getElementById('settings-modal');
      if (settingsModal && settingsModal.style.display === 'flex') {
        hideSettingsModal();
        return;
      }

      const shortcutsModal = document.getElementById('shortcuts-modal');
      if (shortcutsModal && shortcutsModal.style.display === 'flex') {
        hideShortcutsModal();
        return;
      }

      const contextMenu = document.getElementById('context-menu');
      if (contextMenu && contextMenu.style.display === 'block') {
        hideContextMenu();
        return;
      }

      const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');
      if (emptySpaceContextMenu && emptySpaceContextMenu.style.display === 'block') {
        hideEmptySpaceContextMenu();
        return;
      }

      if (isSearchMode) {
        closeSearch();
      }
      return;
    }

    const contextMenu = document.getElementById('context-menu');
    const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');

    if (contextMenu && contextMenu.style.display === 'block') {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        contextMenuFocusedIndex = navigateContextMenu(contextMenu, 'down', contextMenuFocusedIndex);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        contextMenuFocusedIndex = navigateContextMenu(contextMenu, 'up', contextMenuFocusedIndex);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (contextMenuFocusedIndex >= 0) {
          activateContextMenuItem(contextMenu, contextMenuFocusedIndex);
        }
        return;
      }
      if (e.key === 'ArrowRight') {
        const items = getVisibleMenuItems(contextMenu);
        if (
          contextMenuFocusedIndex >= 0 &&
          items[contextMenuFocusedIndex]?.classList.contains('has-submenu')
        ) {
          e.preventDefault();
          activateContextMenuItem(contextMenu, contextMenuFocusedIndex);
        }
        return;
      }
    }

    if (emptySpaceContextMenu && emptySpaceContextMenu.style.display === 'block') {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        emptySpaceMenuFocusedIndex = navigateContextMenu(
          emptySpaceContextMenu,
          'down',
          emptySpaceMenuFocusedIndex
        );
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        emptySpaceMenuFocusedIndex = navigateContextMenu(
          emptySpaceContextMenu,
          'up',
          emptySpaceMenuFocusedIndex
        );
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (emptySpaceMenuFocusedIndex >= 0) {
          const items = getVisibleMenuItems(emptySpaceContextMenu);
          if (items[emptySpaceMenuFocusedIndex]) {
            items[emptySpaceMenuFocusedIndex].click();
          }
        }
        return;
      }
    }

    if (isModalOpen()) {
      return;
    }

    const hasTextSelection = (): boolean => {
      const selection = window.getSelection();
      return selection !== null && selection.toString().length > 0;
    };

    if (e.ctrlKey || e.metaKey) {
      if (e.key === ',') {
        e.preventDefault();
        showSettingsModal();
      } else if (e.key === '?' || e.key === '/') {
        e.preventDefault();
        showShortcutsModal();
      } else if (e.key === 'n' && !e.shiftKey) {
        e.preventDefault();
        openNewWindow();
      } else if (e.key === 'c') {
        if (hasTextSelection()) {
          return;
        }
        e.preventDefault();
        copyToClipboard();
      } else if (e.key === 'x') {
        if (hasTextSelection()) {
          return;
        }
        e.preventDefault();
        cutToClipboard();
      } else if (e.key === 'v') {
        const activeElement = document.activeElement;
        if (
          activeElement &&
          (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
        ) {
          return;
        }
        e.preventDefault();
        pasteFromClipboard();
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        if (e.shiftKey) {
          // Ctrl+Shift+F - Open search in global mode
          if (!isSearchMode) {
            searchBarWrapper.style.display = 'block';
            isSearchMode = true;
          }
          // Always set to global search mode
          isGlobalSearch = true;
          searchScopeToggle.classList.add('global');
          searchScopeToggle.title = 'Global Search (All Indexed Files)';
          const img = searchScopeToggle.querySelector('img');
          if (img) {
            img.src = 'assets/twemoji/1f30d.svg';
            img.alt = '🌍';
          }
          updateSearchPlaceholder();
          searchInput.focus();
        } else {
          if (!isSearchMode) {
            searchBarWrapper.style.display = 'block';
            isSearchMode = true;
          }
          isGlobalSearch = false;
          searchScopeToggle.classList.remove('global');
          searchScopeToggle.title = 'Local Search (Current Folder)';
          const img = searchScopeToggle.querySelector('img');
          if (img) {
            img.src = 'assets/twemoji/1f4c1.svg';
            img.alt = '📁';
          }
          updateSearchPlaceholder();
          searchInput.focus();
        }
      } else if (e.key === 'a') {
        const activeElement = document.activeElement;
        if (
          activeElement &&
          (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
        ) {
          return;
        }
        e.preventDefault();
        selectAll();
      } else if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        performUndo();
      } else if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) {
        e.preventDefault();
        performRedo();
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        zoomReset();
      } else if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        if (tabsEnabled) {
          addNewTab();
        }
      } else if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        if (tabsEnabled && tabs.length > 1) {
          closeTab(activeTabId);
        }
      } else if (e.key === 'Tab') {
        e.preventDefault();
        if (tabsEnabled && tabs.length > 1) {
          const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
          const nextIndex = e.shiftKey
            ? (currentIndex - 1 + tabs.length) % tabs.length
            : (currentIndex + 1) % tabs.length;
          switchToTab(tabs[nextIndex].id);
        }
      }
    } else if (e.key === ' ' && selectedItems.size === 1) {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
      ) {
        return;
      }
      e.preventDefault();
      showQuickLook();
    } else if (e.key === 'F5') {
      e.preventDefault();
      refresh();
    } else if (e.key === 'F2') {
      e.preventDefault();
      renameSelected();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      if (e.shiftKey) {
        if (!currentSettings.showDangerousOptions) {
          showToast(
            'Enable Developer Mode in settings to permanently delete items',
            'Developer Mode Required',
            'warning'
          );
          return;
        }
        permanentlyDeleteSelected();
      } else {
        deleteSelected();
      }
    } else if (e.key === 'Enter') {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
      ) {
        return;
      }
      e.preventDefault();
      openSelectedItem();
    } else if (
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight'
    ) {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
      ) {
        return;
      }
      e.preventDefault();
      navigateFileGrid(e.key, e.shiftKey);
    } else if (e.key === 'Home') {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
      ) {
        return;
      }
      e.preventDefault();
      selectFirstItem(e.shiftKey);
    } else if (e.key === 'End') {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
      ) {
        return;
      }
      e.preventDefault();
      selectLastItem(e.shiftKey);
    }
  });

  document.querySelectorAll('.nav-item[data-action]').forEach((element) => {
    const item = element as HTMLElement;
    item.addEventListener('click', async () => {
      const action = item.dataset.action;
      if (action === 'home') {
        const homeDir = await window.electronAPI.getHomeDirectory();
        navigateTo(homeDir);
      } else if (action === 'browse') {
        const result = await window.electronAPI.selectFolder();
        if (result.success && result.path) {
          navigateTo(result.path);
        }
      } else if (action === 'trash') {
        const result = await window.electronAPI.openTrash();
        if (result.success) {
          showToast('Opening system trash folder', 'Info', 'info');
        } else {
          showToast('Failed to open trash folder', 'Error', 'error');
        }
      }
    });
  });

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
          changeSortMode(sortType as any);
        }
        return;
      }

      if (emptySpaceMenu && emptySpaceMenu.style.display === 'block') {
        handleEmptySpaceContextMenuAction(menuItem.dataset.action);
        hideEmptySpaceContextMenu();
        return;
      }

      if (contextMenuData) {
        handleContextMenuAction(menuItem.dataset.action, contextMenuData, menuItem.dataset.format);
        hideContextMenu();
        return;
      }
    }

    if (contextMenu && contextMenu.style.display === 'block' && !contextMenu.contains(target)) {
      hideContextMenu();
    }
    if (
      emptySpaceMenu &&
      emptySpaceMenu.style.display === 'block' &&
      !emptySpaceMenu.contains(target)
    ) {
      hideEmptySpaceContextMenu();
    }
    if (
      sortMenu &&
      sortMenu.style.display === 'block' &&
      !sortMenu.contains(target) &&
      target !== sortBtn
    ) {
      hideSortMenu();
    }
  });

  if (fileGrid) {
    fileGrid.addEventListener('click', (e) => {
      if (e.target === fileGrid) {
        clearSelection();
      }
    });

    fileGrid.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!e.dataTransfer) return;

      if (!currentPath) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }

      e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
      fileGrid.classList.add('drag-over');
    });

    fileGrid.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const rect = fileGrid.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX >= rect.right ||
        e.clientY < rect.top ||
        e.clientY >= rect.bottom
      ) {
        fileGrid.classList.remove('drag-over');
      }
    });

    fileGrid.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      fileGrid.classList.remove('drag-over');

      if ((e.target as HTMLElement).closest('.file-item')) {
        return;
      }

      let draggedPaths: string[] = [];

      if (!e.dataTransfer) return;

      try {
        const textData = e.dataTransfer.getData('text/plain');
        if (textData) {
          draggedPaths = JSON.parse(textData);
        }
      } catch {}

      if (draggedPaths.length === 0 && e.dataTransfer.files.length > 0) {
        draggedPaths = Array.from(e.dataTransfer.files).map(
          (f) => (f as File & { path: string }).path
        );
      }

      // If still empty, check shared drag data from main process (cross-window)
      if (draggedPaths.length === 0) {
        const sharedData = await window.electronAPI.getDragData();
        if (sharedData) {
          draggedPaths = sharedData.paths;
        }
      }

      if (draggedPaths.length === 0 || !currentPath) {
        return;
      }

      const alreadyInCurrentDir = draggedPaths.some((dragPath: string) => {
        const parentDir = path.dirname(dragPath);
        return parentDir === currentPath || dragPath === currentPath;
      });

      if (alreadyInCurrentDir) {
        showToast('Items are already in this directory', 'Info', 'info');
        return;
      }

      const operation = e.ctrlKey ? 'copy' : 'move';
      await handleDrop(draggedPaths, currentPath, operation);
    });
  }

  if (fileView) {
    fileView.addEventListener('dragover', (e) => {
      if (
        (e.target as HTMLElement).closest('.file-grid') ||
        (e.target as HTMLElement).closest('.column-view') ||
        (e.target as HTMLElement).closest('.file-item') ||
        (e.target as HTMLElement).closest('.column-item')
      ) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      if (!currentPath) {
        e.dataTransfer!.dropEffect = 'none';
        return;
      }

      e.dataTransfer!.dropEffect = e.ctrlKey ? 'copy' : 'move';
      fileView.classList.add('drag-over');
    });

    fileView.addEventListener('dragleave', (e) => {
      e.preventDefault();
      const rect = fileView.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX >= rect.right ||
        e.clientY < rect.top ||
        e.clientY >= rect.bottom
      ) {
        fileView.classList.remove('drag-over');
      }
    });

    fileView.addEventListener('drop', async (e) => {
      if (
        (e.target as HTMLElement).closest('.file-grid') ||
        (e.target as HTMLElement).closest('.column-view') ||
        (e.target as HTMLElement).closest('.file-item') ||
        (e.target as HTMLElement).closest('.column-item')
      ) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      fileView.classList.remove('drag-over');

      let draggedPaths: string[] = [];

      try {
        const textData = e.dataTransfer!.getData('text/plain');
        if (textData) {
          draggedPaths = JSON.parse(textData);
        }
      } catch {}

      if (draggedPaths.length === 0 && e.dataTransfer!.files.length > 0) {
        draggedPaths = Array.from(e.dataTransfer!.files).map(
          (f) => (f as File & { path: string }).path
        );
      }

      if (draggedPaths.length === 0) {
        const sharedData = await window.electronAPI.getDragData();
        if (sharedData) {
          draggedPaths = sharedData.paths;
        }
      }

      if (draggedPaths.length === 0 || !currentPath) {
        return;
      }

      const alreadyInCurrentDir = draggedPaths.some((dragPath: string) => {
        const parentDir = path.dirname(dragPath);
        return parentDir === currentPath || dragPath === currentPath;
      });

      if (alreadyInCurrentDir) {
        showToast('Items are already in this directory', 'Info', 'info');
        return;
      }

      const operation = e.ctrlKey ? 'copy' : 'move';
      await handleDrop(draggedPaths, currentPath, operation);
    });
  }

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
      if (clickedOnFileView && currentPath) {
        showEmptySpaceContextMenu(e.pageX, e.pageY);
      } else {
        hideContextMenu();
        hideEmptySpaceContextMenu();
      }
    }
  });
}

function addToSearchHistory(query: string) {
  if (!currentSettings.enableSearchHistory || !query.trim()) return;
  if (!currentSettings.searchHistory) {
    currentSettings.searchHistory = [];
  }
  currentSettings.searchHistory = currentSettings.searchHistory.filter((item) => item !== query);
  currentSettings.searchHistory.unshift(query);
  currentSettings.searchHistory = currentSettings.searchHistory.slice(0, SEARCH_HISTORY_MAX);
  debouncedSaveSettings();
}

function addToDirectoryHistory(dirPath: string) {
  if (!currentSettings.enableSearchHistory || !dirPath.trim()) return;
  if (!currentSettings.directoryHistory) {
    currentSettings.directoryHistory = [];
  }
  currentSettings.directoryHistory = currentSettings.directoryHistory.filter(
    (item) => item !== dirPath
  );
  currentSettings.directoryHistory.unshift(dirPath);
  currentSettings.directoryHistory = currentSettings.directoryHistory.slice(
    0,
    DIRECTORY_HISTORY_MAX
  );
  debouncedSaveSettings();
}

function showSearchHistoryDropdown() {
  const dropdown = document.getElementById('search-history-dropdown');
  if (!dropdown || !currentSettings.enableSearchHistory) return;

  const history = currentSettings.searchHistory || [];

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

function showDirectoryHistoryDropdown() {
  const dropdown = document.getElementById('directory-history-dropdown');
  if (!dropdown || !currentSettings.enableSearchHistory) return;

  const history = currentSettings.directoryHistory || [];

  if (history.length === 0) {
    dropdown.innerHTML = '<div class="history-empty">No recent directories</div>';
  } else {
    dropdown.innerHTML =
      history
        .map(
          (item) =>
            `<div class="history-item" data-path="${escapeHtml(item)}">${twemojiImg(String.fromCodePoint(0x1f4c1), 'twemoji')} ${escapeHtml(item)}</div>`
        )
        .join('') +
      `<div class="history-clear" data-action="clear-directory">${twemojiImg(String.fromCodePoint(0x1f5d1), 'twemoji')} Clear Directory History</div>`;
  }

  dropdown.style.display = 'block';
}

function hideSearchHistoryDropdown() {
  const dropdown = document.getElementById('search-history-dropdown');
  if (dropdown) dropdown.style.display = 'none';
}

function hideDirectoryHistoryDropdown() {
  const dropdown = document.getElementById('directory-history-dropdown');
  if (dropdown) dropdown.style.display = 'none';
}

function clearSearchHistory() {
  currentSettings.searchHistory = [];
  window.electronAPI.saveSettings(currentSettings);
  hideSearchHistoryDropdown();
  showToast('Search history cleared', 'History', 'success');
}

function clearDirectoryHistory() {
  currentSettings.directoryHistory = [];
  window.electronAPI.saveSettings(currentSettings);
  hideDirectoryHistoryDropdown();
  showToast('Directory history cleared', 'History', 'success');
}

async function navigateTo(path: string, skipHistoryUpdate = false) {
  if (!path) return;
  let requestId = 0;
  let operationId = '';

  try {
    if (isSearchMode) {
      closeSearch();
    }

    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
    }

    if (loading) loading.style.display = 'flex';
    if (emptyState) emptyState.style.display = 'none';
    if (fileGrid) fileGrid.innerHTML = '';
    const request = startDirectoryRequest(path);
    requestId = request.requestId;
    operationId = request.operationId;

    const result = await window.electronAPI.getDirectoryContents(
      path,
      operationId,
      currentSettings.showHiddenFiles
    );
    if (requestId !== directoryRequestId) return;

    if (result.success) {
      currentPath = path;
      updateCurrentTabPath(path);
      if (addressInput) addressInput.value = path;
      updateBreadcrumb(path);
      addToDirectoryHistory(path);

      if (!skipHistoryUpdate && (historyIndex === -1 || history[historyIndex] !== path)) {
        history = history.slice(0, historyIndex + 1);
        history.push(path);
        historyIndex = history.length - 1;
      }

      updateNavigationButtons();

      if (viewMode === 'column') {
        await renderColumnView();
      } else {
        renderFiles(result.contents || []);
      }
      updateDiskSpace();
      if (currentSettings.enableGitStatus) {
        fetchGitStatusAsync(path);
      }
    } else {
      console.error('Error loading directory:', result.error);
      showToast(result.error || 'Unknown error', 'Error Loading Directory', 'error');
    }
  } catch (error) {
    console.error('Error navigating:', error);
    showToast(getErrorMessage(error), 'Error Loading Directory', 'error');
  } finally {
    const isCurrentRequest = requestId !== 0 && requestId === directoryRequestId;
    finishDirectoryRequest(requestId);
    if (isCurrentRequest && loading) loading.style.display = 'none';
  }
}

let renderFilesToken = 0;
const filePathMap: Map<string, FileItem> = new Map();

function renderFiles(items: FileItem[], searchQuery?: string) {
  if (!fileGrid) return;

  const renderToken = ++renderFilesToken;
  fileGrid.innerHTML = '';
  clearSelection();
  allFiles = items;

  filePathMap.clear();
  for (const item of items) {
    filePathMap.set(item.path, item);
  }

  const LARGE_FOLDER_THRESHOLD = 10000;
  if (items.length >= LARGE_FOLDER_THRESHOLD) {
    showToast(
      `This folder contains ${items.length.toLocaleString()} items. Performance may be affected.`,
      'Large Folder',
      'warning'
    );
  }

  const visibleItems = currentSettings.showHiddenFiles
    ? items
    : items.filter((item) => !item.isHidden);

  if (visibleItems.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    updateStatusBar();
    return;
  }

  const sortBy = currentSettings.sortBy || 'name';
  const sortOrder = currentSettings.sortOrder || 'asc';
  const extCache = sortBy === 'type' ? new Map<FileItem, string>() : null;
  const modifiedCache = sortBy === 'date' ? new Map<FileItem, number>() : null;

  if (sortBy === 'type') {
    visibleItems.forEach((item) => {
      if (!item.isDirectory) {
        const ext = item.name.split('.').pop()?.toLowerCase() || '';
        extCache?.set(item, ext);
      }
    });
  } else if (sortBy === 'date') {
    visibleItems.forEach((item) => {
      const time =
        item.modified instanceof Date ? item.modified.getTime() : new Date(item.modified).getTime();
      modifiedCache?.set(item, time);
    });
  }

  const sortedItems = [...visibleItems].sort((a, b) => {
    const dirSort = (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0);
    if (dirSort !== 0) return dirSort;

    let comparison = 0;

    switch (sortBy) {
      case 'name':
        comparison = NAME_COLLATOR.compare(a.name, b.name);
        break;
      case 'date':
        comparison = (modifiedCache?.get(a) || 0) - (modifiedCache?.get(b) || 0);
        break;
      case 'size':
        comparison = a.size - b.size;
        break;
      case 'type':
        const extA = extCache?.get(a) || '';
        const extB = extCache?.get(b) || '';
        comparison = NAME_COLLATOR.compare(extA, extB);
        break;
      default:
        comparison = NAME_COLLATOR.compare(a.name, b.name);
    }

    return sortOrder === 'asc' ? comparison : -comparison;
  });

  const fragment = document.createDocumentFragment();

  const batchSize = RENDER_BATCH_SIZE;
  let currentBatch = 0;

  const renderBatch = () => {
    if (renderToken !== renderFilesToken) return;
    const start = currentBatch * batchSize;
    const end = Math.min(start + batchSize, sortedItems.length);

    for (let i = start; i < end; i++) {
      const fileItem = createFileItem(sortedItems[i], searchQuery);
      fragment.appendChild(fileItem);
    }

    fileGrid.appendChild(fragment);
    currentBatch++;

    if (renderToken !== renderFilesToken) return;
    if (end < sortedItems.length) {
      requestAnimationFrame(renderBatch);
    } else {
      updateCutVisuals();
      updateStatusBar();

      lazyLoadThumbnails();
    }
  };

  renderBatch();
}

let thumbnailObserver: IntersectionObserver | null = null;

function lazyLoadThumbnails() {
  if (thumbnailObserver) {
    thumbnailObserver.disconnect();
  }

  const scrollContainer = document.getElementById('file-view');

  thumbnailObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const fileItem = entry.target as HTMLElement;
          const path = fileItem.dataset.path;
          const item = path ? filePathMap.get(path) : undefined;

          if (item && fileItem.classList.contains('has-thumbnail')) {
            loadThumbnail(fileItem, item);
            thumbnailObserver?.unobserve(fileItem);
          }
        }
      });
    },
    {
      root: scrollContainer,
      rootMargin: THUMBNAIL_ROOT_MARGIN,
      threshold: 0.01,
    }
  );

  document.querySelectorAll('.file-item.has-thumbnail').forEach((item) => {
    thumbnailObserver?.observe(item);
  });
}

function createFileItem(item: FileItem, searchQuery?: string): HTMLElement {
  const fileItem = document.createElement('div');
  fileItem.className = 'file-item';
  fileItem.dataset.path = item.path;
  fileItem.dataset.isDirectory = String(item.isDirectory);

  let icon: string;
  if (item.isDirectory) {
    icon = getFolderIcon(item.path);
  } else {
    const ext = item.name.split('.').pop()?.toLowerCase() || '';
    if (IMAGE_EXTENSIONS.has(ext)) {
      fileItem.classList.add('has-thumbnail');
      icon = IMAGE_ICON;
    } else {
      icon = getFileIcon(item.name);
    }
  }

  const sizeDisplay = item.isDirectory ? '--' : formatFileSize(item.size);
  const dateDisplay = new Date(item.modified).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const contentResult = item as ContentSearchResult;
  let matchContextHtml = '';
  if (contentResult.matchContext && searchQuery) {
    const escapedContext = escapeHtml(contentResult.matchContext);
    const escapedQuery = escapeHtml(searchQuery);
    const regex = new RegExp(`(${escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const highlightedContext = escapedContext.replace(
      regex,
      '<span class="match-highlight">$1</span>'
    );
    const lineInfo = contentResult.matchLineNumber
      ? `<span class="match-line-number">Line ${contentResult.matchLineNumber}</span>`
      : '';
    matchContextHtml = `<div class="match-context">${highlightedContext}${lineInfo}</div>`;
  }

  fileItem.innerHTML = `
    <div class="file-icon">${icon}</div>
    <div class="file-name">${escapeHtml(item.name)}</div>
    ${matchContextHtml}
    <div class="file-info">
      <span class="file-size" data-path="${escapeHtml(item.path)}">${sizeDisplay}</span>
      <span class="file-modified">${dateDisplay}</span>
    </div>
  `;

  fileItem.addEventListener('dblclick', () => {
    if (item.isDirectory) {
      navigateTo(item.path);
    } else {
      window.electronAPI.openFile(item.path);
      addToRecentFiles(item.path);
    }
  });

  fileItem.addEventListener('auxclick', (e) => {
    if (e.button === 1 && item.isDirectory && tabsEnabled) {
      e.preventDefault();
      addNewTab(item.path);
    }
  });

  fileItem.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!e.ctrlKey && !e.metaKey) {
      clearSelection();
    }
    toggleSelection(fileItem);
  });

  fileItem.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!fileItem.classList.contains('selected')) {
      clearSelection();
      toggleSelection(fileItem);
    }
    showContextMenu(e.pageX, e.pageY, item);
  });

  fileItem.draggable = true;

  fileItem.addEventListener('dragstart', (e) => {
    e.stopPropagation();

    if (!fileItem.classList.contains('selected')) {
      clearSelection();
      toggleSelection(fileItem);
    }

    const selectedPaths = Array.from(selectedItems);

    if (!e.dataTransfer) return;

    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', JSON.stringify(selectedPaths));

    window.electronAPI.setDragData(selectedPaths);

    fileItem.classList.add('dragging');

    if (selectedPaths.length > 1) {
      const dragImage = document.createElement('div');
      dragImage.className = 'drag-image';
      dragImage.textContent = `${selectedPaths.length} items`;
      dragImage.style.position = 'absolute';
      dragImage.style.top = '-1000px';
      document.body.appendChild(dragImage);
      e.dataTransfer.setDragImage(dragImage, 0, 0);
      setTimeout(() => dragImage.remove(), 0);
    }
  });

  fileItem.addEventListener('dragend', (e) => {
    fileItem.classList.remove('dragging');
    document.querySelectorAll('.file-item.drag-over').forEach((el) => {
      el.classList.remove('drag-over');
    });
    document.getElementById('file-grid')?.classList.remove('drag-over');

    // Clear drag data main
    window.electronAPI.clearDragData();
  });

  if (item.isDirectory) {
    fileItem.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!e.dataTransfer) return;

      if (!e.dataTransfer.types.includes('text/plain')) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }

      e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
      fileItem.classList.add('drag-over');
    });

    fileItem.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const rect = fileItem.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX >= rect.right ||
        e.clientY < rect.top ||
        e.clientY >= rect.bottom
      ) {
        fileItem.classList.remove('drag-over');
      }
    });

    fileItem.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      fileItem.classList.remove('drag-over');

      let draggedPaths: string[] = [];

      if (!e.dataTransfer) return;

      try {
        const textData = e.dataTransfer.getData('text/plain');
        if (textData) {
          draggedPaths = JSON.parse(textData);
        }
      } catch {}

      if (draggedPaths.length === 0 && e.dataTransfer.files.length > 0) {
        draggedPaths = Array.from(e.dataTransfer.files).map(
          (f) => (f as File & { path: string }).path
        );
      }

      if (draggedPaths.length === 0) {
        const sharedData = await window.electronAPI.getDragData();
        if (sharedData) {
          draggedPaths = sharedData.paths;
        }
      }

      if (draggedPaths.length === 0 || draggedPaths.includes(item.path)) {
        return;
      }

      const operation = e.ctrlKey ? 'copy' : 'move';
      await handleDrop(draggedPaths, item.path, operation);
    });
  }

  return fileItem;
}

function loadThumbnail(fileItem: HTMLElement, item: FileItem) {
  const cached = thumbnailCache.get(item.path);
  if (cached) {
    const iconDiv = fileItem.querySelector('.file-icon');
    if (iconDiv) {
      iconDiv.innerHTML = '';
      const img = document.createElement('img');
      img.src = cached;
      img.className = 'file-thumbnail';
      img.alt = item.name;
      img.addEventListener('error', () => {
        if (!document.body.contains(fileItem)) {
          return;
        }
        iconDiv.innerHTML = getFileIcon(item.name);
        fileItem.classList.remove('has-thumbnail');
      });
      iconDiv.appendChild(img);
    }
    return;
  }

  enqueueThumbnailLoad(async () => {
    try {
      if (!document.body.contains(fileItem)) {
        return;
      }

      const iconDiv = fileItem.querySelector('.file-icon');

      if (iconDiv) {
        iconDiv.innerHTML = `<div class="spinner" style="width: 30px; height: 30px; border-width: 2px;"></div>`;
      }

      if (item.size > THUMBNAIL_MAX_SIZE) {
        if (iconDiv) {
          iconDiv.innerHTML = getFileIcon(item.name);
        }
        fileItem.classList.remove('has-thumbnail');
        return;
      }

      const fileUrl = encodeFileUrl(item.path);

      if (!document.body.contains(fileItem)) {
        return;
      }

      if (iconDiv) {
        if (thumbnailCache.size >= THUMBNAIL_CACHE_MAX) {
          const firstKey = thumbnailCache.keys().next().value;
          if (firstKey) thumbnailCache.delete(firstKey);
        }
        thumbnailCache.set(item.path, fileUrl);
        iconDiv.innerHTML = '';
        const img = document.createElement('img');
        img.src = fileUrl;
        img.className = 'file-thumbnail';
        img.alt = item.name;
        img.addEventListener('error', () => {
          if (!document.body.contains(fileItem)) {
            return;
          }
          iconDiv.innerHTML = getFileIcon(item.name);
          fileItem.classList.remove('has-thumbnail');
        });
        iconDiv.appendChild(img);
      }
    } catch (error) {
      if (!document.body.contains(fileItem)) {
        return;
      }
      const iconDiv = fileItem.querySelector('.file-icon');
      if (iconDiv) {
        iconDiv.innerHTML = getFileIcon(item.name);
      }
      fileItem.classList.remove('has-thumbnail');
    }
  });
}

const FILE_ICON_MAP: Record<string, string> = {
  jpg: '1f5bc',
  jpeg: '1f5bc',
  png: '1f5bc',
  gif: '1f5bc',
  svg: '1f5bc',
  bmp: '1f5bc',
  webp: '1f5bc',
  ico: '1f5bc',
  tiff: '1f5bc',
  tif: '1f5bc',
  avif: '1f5bc',
  jfif: '1f5bc',
  mp4: '1f3ac',
  avi: '1f3ac',
  mov: '1f3ac',
  mkv: '1f3ac',
  webm: '1f3ac',
  mp3: '1f3b5',
  wav: '1f3b5',
  flac: '1f3b5',
  ogg: '1f3b5',
  m4a: '1f3b5',
  pdf: '1f4c4',
  doc: '1f4dd',
  docx: '1f4dd',
  txt: '1f4dd',
  rtf: '1f4dd',
  xls: '1f4ca',
  xlsx: '1f4ca',
  csv: '1f4ca',
  ppt: '1f4ca',
  pptx: '1f4ca',
  js: '1f4dc',
  ts: '1f4dc',
  jsx: '1f4dc',
  tsx: '1f4dc',
  html: '1f310',
  css: '1f3a8',
  json: '2699',
  xml: '2699',
  py: '1f40d',
  java: '2615',
  c: 'a9',
  cpp: 'a9',
  cs: 'a9',
  php: '1f418',
  rb: '1f48e',
  go: '1f439',
  rs: '1f980',
  zip: '1f5dc',
  rar: '1f5dc',
  '7z': '1f5dc',
  tar: '1f5dc',
  gz: '1f5dc',
  exe: '2699',
  app: '2699',
  msi: '2699',
  dmg: '2699',
};

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'ico',
  'tiff',
  'tif',
  'avif',
  'jfif',
  'svg',
]);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi', 'm4v']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'opus']);
const PDF_EXTENSIONS = new Set(['pdf']);
const TEXT_EXTENSIONS = new Set([
  'txt',
  'text',
  'md',
  'markdown',
  'log',
  'readme',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'js',
  'jsx',
  'ts',
  'tsx',
  'vue',
  'svelte',
  'py',
  'pyc',
  'pyw',
  'java',
  'c',
  'cpp',
  'cc',
  'cxx',
  'h',
  'hpp',
  'cs',
  'php',
  'rb',
  'go',
  'rs',
  'swift',
  'kt',
  'kts',
  'scala',
  'r',
  'lua',
  'perl',
  'pl',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'json',
  'xml',
  'yml',
  'yaml',
  'toml',
  'csv',
  'tsv',
  'sql',
  'ini',
  'conf',
  'config',
  'cfg',
  'env',
  'properties',
  'gitignore',
  'gitattributes',
  'editorconfig',
  'dockerfile',
  'dockerignore',
  'rst',
  'tex',
  'adoc',
  'asciidoc',
  'makefile',
  'cmake',
  'gradle',
  'maven',
]);
const VIDEO_MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  m4v: 'video/x-m4v',
};
const AUDIO_MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  wma: 'audio/x-ms-wma',
  opus: 'audio/ogg',
};
const FOLDER_ICON = twemojiImg(String.fromCodePoint(0x1f4c1), 'twemoji file-icon');
const IMAGE_ICON = twemojiImg(String.fromCodePoint(parseInt('1f5bc', 16)), 'twemoji');
const DEFAULT_FILE_ICON = twemojiImg(String.fromCodePoint(parseInt('1f4c4', 16)), 'twemoji');

const fileIconCache = new Map<string, string>();
function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  const cached = fileIconCache.get(ext);
  if (cached) return cached;

  const codepoint = FILE_ICON_MAP[ext];
  let icon: string;

  if (!codepoint) {
    icon = DEFAULT_FILE_ICON;
  } else if (codepoint === '1f5bc') {
    icon = IMAGE_ICON;
  } else {
    icon = twemojiImg(String.fromCodePoint(parseInt(codepoint, 16)), 'twemoji');
  }

  fileIconCache.set(ext, icon);
  return icon;
}

async function handleDrop(
  sourcePaths: string[],
  destPath: string,
  operation: 'copy' | 'move'
): Promise<void> {
  try {
    const result =
      operation === 'copy'
        ? await window.electronAPI.copyItems(sourcePaths, destPath)
        : await window.electronAPI.moveItems(sourcePaths, destPath);

    if (result.success) {
      showToast(
        `${operation === 'copy' ? 'Copied' : 'Moved'} ${sourcePaths.length} item(s)`,
        'Success',
        'success'
      );
      await window.electronAPI.clearDragData();

      if (operation === 'move') {
        await updateUndoRedoState();
      }

      await navigateTo(currentPath);
      clearSelection();
    } else {
      showToast(result.error || `Failed to ${operation} items`, 'Error', 'error');
    }
  } catch (error) {
    console.error(`Error during ${operation}:`, error);
    showToast(`Failed to ${operation} items`, 'Error', 'error');
  }
}

function toggleSelection(fileItem: HTMLElement) {
  const itemPath = fileItem.dataset.path;
  if (!itemPath) return;

  fileItem.classList.toggle('selected');
  if (fileItem.classList.contains('selected')) {
    selectedItems.add(itemPath);
  } else {
    selectedItems.delete(itemPath);
  }
  updateStatusBar();

  if (isPreviewPanelVisible && selectedItems.size === 1) {
    const selectedPath = Array.from(selectedItems)[0];
    const file = filePathMap.get(selectedPath);
    if (file && file.isFile) {
      updatePreview(file);
    } else {
      previewRequestId++;
      showEmptyPreview();
    }
  } else if (isPreviewPanelVisible && selectedItems.size !== 1) {
    previewRequestId++;
    showEmptyPreview();
  }
}

function clearSelection() {
  document.querySelectorAll('.file-item.selected').forEach((item) => {
    item.classList.remove('selected');
  });
  selectedItems.clear();
  updateStatusBar();

  if (isPreviewPanelVisible) {
    previewRequestId++;
    showEmptyPreview();
  }
}

function selectAll() {
  document.querySelectorAll('.file-item').forEach((item) => {
    item.classList.add('selected');
    const itemPath = item.getAttribute('data-path');
    if (itemPath) {
      selectedItems.add(itemPath);
    }
  });
  updateStatusBar();
}

let lastSelectedIndex = -1;

function openSelectedItem() {
  if (selectedItems.size !== 1) return;
  const itemPath = Array.from(selectedItems)[0];
  const item = filePathMap.get(itemPath);
  if (item) {
    if (item.isDirectory) {
      navigateTo(item.path);
    } else {
      window.electronAPI.openFile(item.path);
      addToRecentFiles(item.path);
    }
  }
}

function getFileItemsArray(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.file-item')) as HTMLElement[];
}

function getGridColumns(): number {
  const fileGrid = document.getElementById('file-grid');
  if (!fileGrid || viewMode === 'list') return 1;
  const gridStyle = window.getComputedStyle(fileGrid);
  const columns = gridStyle.getPropertyValue('grid-template-columns').split(' ').length;
  return columns || 1;
}

function navigateFileGrid(key: string, shiftKey: boolean) {
  const fileItems = getFileItemsArray();
  if (fileItems.length === 0) return;

  let currentIndex = lastSelectedIndex;
  if (currentIndex === -1 || currentIndex >= fileItems.length) {
    const selectedPath = Array.from(selectedItems)[selectedItems.size - 1];
    currentIndex = fileItems.findIndex((item) => item.getAttribute('data-path') === selectedPath);
  }
  if (currentIndex === -1) currentIndex = 0;

  const columns = getGridColumns();
  let newIndex = currentIndex;

  switch (key) {
    case 'ArrowUp':
      newIndex = Math.max(0, currentIndex - columns);
      break;
    case 'ArrowDown':
      newIndex = Math.min(fileItems.length - 1, currentIndex + columns);
      break;
    case 'ArrowLeft':
      newIndex = Math.max(0, currentIndex - 1);
      break;
    case 'ArrowRight':
      newIndex = Math.min(fileItems.length - 1, currentIndex + 1);
      break;
  }

  if (newIndex !== currentIndex || selectedItems.size === 0) {
    selectItemAtIndex(fileItems, newIndex, shiftKey, currentIndex);
  }
}

function selectFirstItem(shiftKey: boolean) {
  const fileItems = getFileItemsArray();
  if (fileItems.length === 0) return;

  if (shiftKey && lastSelectedIndex !== -1) {
    selectItemAtIndex(fileItems, 0, true, lastSelectedIndex);
  } else {
    selectItemAtIndex(fileItems, 0, false, -1);
  }
}

function selectLastItem(shiftKey: boolean) {
  const fileItems = getFileItemsArray();
  if (fileItems.length === 0) return;

  if (shiftKey && lastSelectedIndex !== -1) {
    selectItemAtIndex(fileItems, fileItems.length - 1, true, lastSelectedIndex);
  } else {
    selectItemAtIndex(fileItems, fileItems.length - 1, false, -1);
  }
}

function selectItemAtIndex(
  fileItems: HTMLElement[],
  index: number,
  shiftKey: boolean,
  anchorIndex: number
) {
  if (index < 0 || index >= fileItems.length) return;

  if (shiftKey && anchorIndex !== -1) {
    const start = Math.min(anchorIndex, index);
    const end = Math.max(anchorIndex, index);
    clearSelection();
    for (let i = start; i <= end; i++) {
      const item = fileItems[i];
      item.classList.add('selected');
      const itemPath = item.getAttribute('data-path');
      if (itemPath) {
        selectedItems.add(itemPath);
      }
    }
  } else {
    clearSelection();
    const item = fileItems[index];
    item.classList.add('selected');
    const itemPath = item.getAttribute('data-path');
    if (itemPath) {
      selectedItems.add(itemPath);
    }
    lastSelectedIndex = index;
  }

  fileItems[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  updateStatusBar();

  if (isPreviewPanelVisible && selectedItems.size === 1) {
    const itemPath = Array.from(selectedItems)[0];
    const fileItem = filePathMap.get(itemPath);
    if (fileItem) {
      updatePreview(fileItem);
    }
  }
}

async function renameSelected() {
  if (selectedItems.size !== 1) return;
  const itemPath = Array.from(selectedItems)[0];
  const fileItems = document.querySelectorAll('.file-item');
  for (const fileItem of Array.from(fileItems)) {
    if (fileItem.getAttribute('data-path') === itemPath) {
      const item = filePathMap.get(itemPath);
      if (item) {
        startInlineRename(fileItem as HTMLElement, item.name, item.path);
      }
      break;
    }
  }
}

async function deleteSelected() {
  if (selectedItems.size === 0) return;

  const count = selectedItems.size;
  const confirmed = await showConfirm(
    `Move ${count} item${count > 1 ? 's' : ''} to ${platformOS === 'win32' ? 'Recycle Bin' : 'Trash'}?`,
    'Move to Trash',
    'warning'
  );

  if (confirmed) {
    let successCount = 0;
    for (const itemPath of selectedItems) {
      const result = await window.electronAPI.trashItem(itemPath);
      if (result.success) successCount++;
    }

    if (successCount > 0) {
      showToast(
        `${successCount} item${successCount > 1 ? 's' : ''} moved to ${platformOS === 'win32' ? 'Recycle Bin' : 'Trash'}`,
        'Success',
        'success'
      );
      await updateUndoRedoState();
      refresh();
    }
  }
}

async function permanentlyDeleteSelected() {
  if (selectedItems.size === 0) return;

  const count = selectedItems.size;
  const confirmed = await showConfirm(
    `${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} PERMANENTLY delete ${count} item${count > 1 ? 's' : ''}? This CANNOT be undone!`,
    'Permanent Delete',
    'error'
  );

  if (confirmed) {
    let successCount = 0;
    for (const itemPath of selectedItems) {
      const result = await window.electronAPI.deleteItem(itemPath);
      if (result.success) successCount++;
    }

    if (successCount > 0) {
      showToast(
        `${successCount} item${successCount > 1 ? 's' : ''} permanently deleted`,
        'Success',
        'success'
      );
      refresh();
    }
  }
}

async function updateUndoRedoState() {
  const state = await window.electronAPI.getUndoRedoState();
  canUndo = state.canUndo;
  canRedo = state.canRedo;

  const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
  const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
  if (undoBtn) undoBtn.disabled = !canUndo;
  if (redoBtn) redoBtn.disabled = !canRedo;
}

async function performUndo() {
  const result = await window.electronAPI.undoAction();
  if (result.success) {
    showToast('Action undone', 'Undo', 'success');
    await updateUndoRedoState();
    refresh();
  } else {
    showToast(result.error || 'Cannot undo', 'Undo Failed', 'warning');
    await updateUndoRedoState();
  }
}

async function performRedo() {
  const result = await window.electronAPI.redoAction();
  if (result.success) {
    showToast('Action redone', 'Redo', 'success');
    await updateUndoRedoState();
    refresh();
  } else {
    showToast(result.error || 'Cannot redo', 'Redo Failed', 'warning');
    await updateUndoRedoState();
  }
}

function goBack() {
  if (historyIndex > 0) {
    historyIndex--;
    const path = history[historyIndex];
    navigateTo(path, true);
  }
}

function goForward() {
  if (historyIndex < history.length - 1) {
    historyIndex++;
    const path = history[historyIndex];
    navigateTo(path, true);
  }
}

function isRootPath(pathValue: string): boolean {
  if (!pathValue) return true;
  if (!isWindowsPath(pathValue)) {
    return pathValue === '/';
  }
  const normalized = normalizeWindowsPath(pathValue);
  if (normalized.startsWith('\\\\')) {
    const parts = normalized.split('\\').filter(Boolean);
    return parts.length <= 2;
  }
  return /^[A-Za-z]:\\?$/.test(normalized);
}

function goUp() {
  if (!currentPath) return;
  if (isRootPath(currentPath)) return;
  const parentPath = path.dirname(currentPath);
  if (!parentPath) return;
  navigateTo(parentPath);
}

function refresh() {
  if (currentPath) {
    navigateTo(currentPath);
  }
}

function updateNavigationButtons() {
  backBtn.disabled = historyIndex <= 0;
  forwardBtn.disabled = historyIndex >= history.length - 1;
  upBtn.disabled = !currentPath || isRootPath(currentPath);
}

function toggleView() {
  // Cycle through: grid → list → column → grid
  if (viewMode === 'grid') {
    viewMode = 'list';
  } else if (viewMode === 'list') {
    viewMode = 'column';
  } else {
    viewMode = 'grid';
  }
  applyViewMode();
  updateViewToggleButton();

  // Save view mode
  currentSettings.viewMode = viewMode;
  window.electronAPI.saveSettings(currentSettings);
}

async function applyViewMode() {
  if (viewMode === 'column') {
    cancelDirectoryRequest();
    if (loading) loading.style.display = 'none';
    fileGrid.style.display = 'none';
    columnView.style.display = 'flex';
    await renderColumnView();
  } else {
    cancelColumnOperations();
    columnView.style.display = 'none';
    fileGrid.style.display = '';
    fileGrid.className = viewMode === 'list' ? 'file-grid list-view' : 'file-grid';

    if (currentPath) {
      let requestId = 0;
      let operationId = '';
      try {
        const request = startDirectoryRequest(currentPath);
        requestId = request.requestId;
        operationId = request.operationId;
        const result = await window.electronAPI.getDirectoryContents(
          currentPath,
          operationId,
          currentSettings.showHiddenFiles
        );
        if (requestId !== directoryRequestId) return;
        if (result.success) {
          renderFiles(result.contents || []);
        }
      } finally {
        finishDirectoryRequest(requestId);
      }
    }
  }
}

let columnPaths: string[] = [];
let columnViewRenderId = 0;
let isRenderingColumnView = false;
const activeColumnOperationIds = new Set<string>();

function cancelColumnOperations(): void {
  for (const operationId of activeColumnOperationIds) {
    window.electronAPI.cancelDirectoryContents(operationId).catch(() => {});
  }
  activeColumnOperationIds.clear();
}

async function renderColumnView() {
  if (!columnView) return;

  cancelColumnOperations();

  const currentRenderId = ++columnViewRenderId;
  while (isRenderingColumnView) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (currentRenderId !== columnViewRenderId) return;
  }

  isRenderingColumnView = true;
  const savedScrollLeft = columnView.scrollLeft;

  try {
    columnView.innerHTML = '';
    columnPaths = [];

    if (!currentPath) {
      await renderDriveColumn();
      return;
    }

    const isWindows = isWindowsPath(currentPath);

    if (isWindows) {
      const parts = currentPath.split('\\').filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        if (i === 0) {
          columnPaths.push(parts[0] + '\\');
        } else {
          columnPaths.push(parts.slice(0, i + 1).join('\\'));
        }
      }
    } else {
      const parts = currentPath.split('/').filter(Boolean);
      columnPaths.push('/');
      for (let i = 0; i < parts.length; i++) {
        columnPaths.push('/' + parts.slice(0, i + 1).join('/'));
      }
    }

    const panePromises = columnPaths.map((colPath, index) =>
      renderColumn(colPath, index, currentRenderId)
    );

    const panes = await Promise.all(panePromises);

    if (currentRenderId !== columnViewRenderId) {
      return;
    }

    for (const pane of panes) {
      if (pane) {
        columnView.appendChild(pane);
      }
    }

    setTimeout(() => {
      if (currentRenderId !== columnViewRenderId) return;
      if (savedScrollLeft > 0) {
        columnView.scrollLeft = savedScrollLeft;
      } else {
        columnView.scrollLeft = columnView.scrollWidth;
      }
    }, 50);
  } finally {
    isRenderingColumnView = false;
  }
}

function addColumnResizeHandle(pane: HTMLElement) {
  const handle = document.createElement('div');
  handle.className = 'column-resize-handle';

  let startX: number;
  let startWidth: number;

  const onMouseMove = (e: MouseEvent) => {
    const delta = e.clientX - startX;
    const newWidth = Math.max(150, Math.min(500, startWidth + delta));
    pane.style.width = newWidth + 'px';
  };

  const onMouseUp = () => {
    handle.classList.remove('resizing');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = pane.offsetWidth;
    handle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  pane.appendChild(handle);
}

async function renderDriveColumn() {
  const pane = document.createElement('div');
  pane.className = 'column-pane';

  try {
    const drives = await window.electronAPI.getDrives();
    drives.forEach((drive) => {
      const item = document.createElement('div');
      item.className = 'column-item is-directory';
      item.dataset.path = drive;
      item.innerHTML = `
        <span class="column-item-icon"><img src="assets/twemoji/1f4bf.svg" class="twemoji" alt="💿" draggable="false" /></span>
        <span class="column-item-name">${escapeHtml(drive)}</span>
        <span class="column-item-arrow">▸</span>
      `;
      item.addEventListener('click', () => handleColumnItemClick(item, drive, true, 0));
      pane.appendChild(item);
    });
  } catch {
    pane.innerHTML = '<div class="column-item" style="opacity: 0.5;">Error loading drives</div>';
  }

  addColumnResizeHandle(pane);
  columnView.appendChild(pane);
}

async function renderColumn(
  columnPath: string,
  columnIndex: number,
  renderId?: number
): Promise<HTMLDivElement | null> {
  if (renderId !== undefined && renderId !== columnViewRenderId) {
    return null;
  }

  const pane = document.createElement('div');
  pane.className = 'column-pane';
  pane.dataset.columnIndex = String(columnIndex);
  pane.dataset.path = columnPath;

  pane.addEventListener('dragover', (e) => {
    if ((e.target as HTMLElement).closest('.column-item')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    if (!e.dataTransfer!.types.includes('text/plain') && e.dataTransfer!.files.length === 0) {
      e.dataTransfer!.dropEffect = 'none';
      return;
    }

    e.dataTransfer!.dropEffect = e.ctrlKey ? 'copy' : 'move';
    pane.classList.add('drag-over');
  });

  pane.addEventListener('dragleave', (e) => {
    if ((e.target as HTMLElement).closest('.column-item')) {
      return;
    }
    e.preventDefault();
    const rect = pane.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX >= rect.right ||
      e.clientY < rect.top ||
      e.clientY >= rect.bottom
    ) {
      pane.classList.remove('drag-over');
    }
  });

  pane.addEventListener('drop', async (e) => {
    if ((e.target as HTMLElement).closest('.column-item')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    pane.classList.remove('drag-over');

    let draggedPaths: string[] = [];

    try {
      const textData = e.dataTransfer!.getData('text/plain');
      if (textData) {
        draggedPaths = JSON.parse(textData);
      }
    } catch {}

    if (draggedPaths.length === 0 && e.dataTransfer!.files.length > 0) {
      draggedPaths = Array.from(e.dataTransfer!.files).map(
        (f) => (f as File & { path: string }).path
      );
    }

    if (draggedPaths.length === 0) {
      const sharedData = await window.electronAPI.getDragData();
      if (sharedData) {
        draggedPaths = sharedData.paths;
      }
    }

    if (draggedPaths.length === 0) {
      return;
    }

    const alreadyInCurrentDir = draggedPaths.some((filePath: string) => {
      const parentDir = path.dirname(filePath);
      return parentDir === columnPath || filePath === columnPath;
    });

    if (alreadyInCurrentDir) {
      showToast('Items are already in this directory', 'Info', 'info');
      return;
    }

    const operation = e.ctrlKey ? 'copy' : 'move';
    await handleDrop(draggedPaths, columnPath, operation);
  });

  try {
    const operationId = createDirectoryOperationId('column');
    activeColumnOperationIds.add(operationId);
    let result: { success: boolean; contents?: FileItem[]; error?: string };
    try {
      result = await window.electronAPI.getDirectoryContents(
        columnPath,
        operationId,
        currentSettings.showHiddenFiles
      );
    } finally {
      activeColumnOperationIds.delete(operationId);
    }
    if (renderId !== undefined && renderId !== columnViewRenderId) {
      return null;
    }
    if (!result.success) {
      throw new Error(result.error || 'Error loading folder');
    }
    const items = result.contents || [];

    const sortedItems = [...items].sort((a, b) => {
      const dirSort = (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0);
      if (dirSort !== 0) return dirSort;
      return NAME_COLLATOR.compare(a.name, b.name);
    });

    const visibleItems = currentSettings.showHiddenFiles
      ? sortedItems
      : sortedItems.filter((item) => !item.isHidden);

    if (visibleItems.length === 0) {
      pane.innerHTML =
        '<div class="column-item" style="opacity: 0.5; font-style: italic;">Empty folder</div>';
    } else {
      visibleItems.forEach((fileItem) => {
        const item = document.createElement('div');
        item.className = 'column-item';
        if (fileItem.isDirectory) item.classList.add('is-directory');
        item.dataset.path = fileItem.path;

        const nextColPath = columnPaths[columnIndex + 1];
        if (nextColPath && fileItem.path === nextColPath) {
          item.classList.add('expanded');
        }

        const icon = fileItem.isDirectory
          ? '<img src="assets/twemoji/1f4c1.svg" class="twemoji" alt="📁" draggable="false" />'
          : getFileIcon(fileItem.name);

        item.innerHTML = `
          <span class="column-item-icon">${icon}</span>
          <span class="column-item-name">${escapeHtml(fileItem.name)}</span>
          ${fileItem.isDirectory ? '<span class="column-item-arrow">▸</span>' : ''}
        `;

        item.addEventListener('click', () =>
          handleColumnItemClick(item, fileItem.path, fileItem.isDirectory, columnIndex)
        );
        item.addEventListener('dblclick', () => {
          if (!fileItem.isDirectory) {
            window.electronAPI.openFile(fileItem.path);
            addToRecentFiles(fileItem.path);
          }
        });

        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();

          pane.querySelectorAll('.column-item').forEach((i) => {
            i.classList.remove('selected');
          });
          item.classList.add('selected');

          clearSelection();
          selectedItems.add(fileItem.path);

          const colPath = columnPaths[columnIndex];
          if (colPath && colPath !== currentPath) {
            currentPath = colPath;
            addressInput.value = colPath;
            updateBreadcrumb(colPath);
          }

          showContextMenu(e.pageX, e.pageY, fileItem);
        });

        item.draggable = true;

        item.addEventListener('dragstart', (e) => {
          e.stopPropagation();

          if (!item.classList.contains('selected')) {
            pane.querySelectorAll('.column-item').forEach((i) => i.classList.remove('selected'));
            item.classList.add('selected');
            clearSelection();
            selectedItems.add(fileItem.path);
          }

          const selectedPaths = Array.from(selectedItems);
          e.dataTransfer!.effectAllowed = 'copyMove';
          e.dataTransfer!.setData('text/plain', JSON.stringify(selectedPaths));

          window.electronAPI.setDragData(selectedPaths);

          item.classList.add('dragging');
        });

        item.addEventListener('dragend', () => {
          item.classList.remove('dragging');
          document.querySelectorAll('.column-item.drag-over').forEach((el) => {
            el.classList.remove('drag-over');
          });
          window.electronAPI.clearDragData();
        });

        if (fileItem.isDirectory) {
          item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (
              !e.dataTransfer!.types.includes('text/plain') &&
              e.dataTransfer!.files.length === 0
            ) {
              e.dataTransfer!.dropEffect = 'none';
              return;
            }

            e.dataTransfer!.dropEffect = e.ctrlKey ? 'copy' : 'move';
            item.classList.add('drag-over');
          });

          item.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = item.getBoundingClientRect();
            if (
              e.clientX < rect.left ||
              e.clientX >= rect.right ||
              e.clientY < rect.top ||
              e.clientY >= rect.bottom
            ) {
              item.classList.remove('drag-over');
            }
          });

          item.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            item.classList.remove('drag-over');

            let draggedPaths: string[] = [];

            try {
              const textData = e.dataTransfer!.getData('text/plain');
              if (textData) {
                draggedPaths = JSON.parse(textData);
              }
            } catch {}

            if (draggedPaths.length === 0 && e.dataTransfer!.files.length > 0) {
              draggedPaths = Array.from(e.dataTransfer!.files).map(
                (f) => (f as File & { path: string }).path
              );
            }

            if (draggedPaths.length === 0) {
              const sharedData = await window.electronAPI.getDragData();
              if (sharedData) {
                draggedPaths = sharedData.paths;
              }
            }

            if (draggedPaths.length === 0 || draggedPaths.includes(fileItem.path)) {
              return;
            }

            const operation = e.ctrlKey ? 'copy' : 'move';
            await handleDrop(draggedPaths, fileItem.path, operation);
          });
        }

        pane.appendChild(item);
      });
    }
  } catch {
    pane.innerHTML = '<div class="column-item" style="opacity: 0.5;">Error loading folder</div>';
  }

  addColumnResizeHandle(pane);
  return pane;
}

async function handleColumnItemClick(
  element: HTMLElement,
  path: string,
  isDirectory: boolean,
  columnIndex: number
) {
  const currentPane = element.closest('.column-pane');
  if (!currentPane) return;

  cancelColumnOperations();
  const clickRenderId = ++columnViewRenderId;
  const allPanes = Array.from(columnView.querySelectorAll('.column-pane'));
  const currentPaneIndex = allPanes.indexOf(currentPane as Element);

  for (let i = allPanes.length - 1; i > currentPaneIndex; i--) {
    allPanes[i].remove();
  }
  columnPaths = columnPaths.slice(0, currentPaneIndex + 1);

  currentPane.querySelectorAll('.column-item').forEach((item) => {
    item.classList.remove('expanded', 'selected');
  });

  if (isDirectory) {
    element.classList.add('expanded');
    columnPaths.push(path);

    currentPath = path;
    addressInput.value = path;
    updateBreadcrumb(path);

    const newPane = await renderColumn(path, currentPaneIndex + 1, clickRenderId);

    if (clickRenderId === columnViewRenderId && newPane) {
      columnView.appendChild(newPane);
    }

    setTimeout(() => {
      if (clickRenderId !== columnViewRenderId) return;
      columnView.scrollLeft = columnView.scrollWidth;
    }, 50);
  } else {
    element.classList.add('selected');
    clearSelection();
    selectedItems.add(path);

    const parentPath = columnPaths[currentPaneIndex];
    if (parentPath && parentPath !== currentPath) {
      currentPath = parentPath;
      addressInput.value = parentPath;
      updateBreadcrumb(parentPath);
    }

    const previewPanel = document.getElementById('preview-panel');
    if (previewPanel && previewPanel.style.display !== 'none') {
      let file = filePathMap.get(path);
      if (!file) {
        const fileName = path.split(/[\\/]/).pop() || '';
        file = {
          name: fileName,
          path: path,
          isDirectory: false,
          isFile: true,
          size: 0,
          modified: new Date(),
          isHidden: fileName.startsWith('.'),
        };
      }
      updatePreview(file);
    }
  }
}

function updateViewToggleButton() {
  if (viewMode === 'list') {
    viewToggleBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16">
        <rect x="2" y="3" width="12" height="2" fill="currentColor" rx="1"/>
        <rect x="2" y="7" width="12" height="2" fill="currentColor" rx="1"/>
        <rect x="2" y="11" width="12" height="2" fill="currentColor" rx="1"/>
      </svg>
    `;
    viewToggleBtn.title = 'Switch to Column View';
  } else if (viewMode === 'column') {
    viewToggleBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16">
        <rect x="1" y="2" width="4" height="12" fill="currentColor" rx="1"/>
        <rect x="6" y="2" width="4" height="12" fill="currentColor" rx="1"/>
        <rect x="11" y="2" width="4" height="12" fill="currentColor" rx="1"/>
      </svg>
    `;
    viewToggleBtn.title = 'Switch to Grid View';
  } else {
    viewToggleBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16">
        <rect x="2" y="2" width="5" height="5" fill="currentColor" rx="1"/>
        <rect x="9" y="2" width="5" height="5" fill="currentColor" rx="1"/>
        <rect x="2" y="9" width="5" height="5" fill="currentColor" rx="1"/>
        <rect x="9" y="9" width="5" height="5" fill="currentColor" rx="1"/>
      </svg>
    `;
    viewToggleBtn.title = 'Switch to List View';
  }
}

async function createNewFile() {
  await createNewFileWithInlineRename();
}

async function createNewFolder() {
  await createNewFolderWithInlineRename();
}

async function createNewFileWithInlineRename() {
  const fileName = 'File';
  let counter = 1;
  let finalFileName = fileName;

  const existingNames = new Set(allFiles.map((f) => f.name));

  while (existingNames.has(finalFileName)) {
    finalFileName = `${fileName} (${counter})`;
    counter++;
  }

  const result = await window.electronAPI.createFile(currentPath, finalFileName);
  if (result.success && result.path) {
    const createdFilePath = result.path;
    await navigateTo(currentPath);

    setTimeout(() => {
      const fileItems = document.querySelectorAll('.file-item');
      for (const item of Array.from(fileItems)) {
        const nameElement = item.querySelector('.file-name');
        if (nameElement && nameElement.textContent === finalFileName) {
          startInlineRename(item as HTMLElement, finalFileName, createdFilePath);
          break;
        }
      }
    }, 100);
  } else {
    await showAlert(result.error || 'Unknown error', 'Error Creating File', 'error');
  }
}

async function createNewFolderWithInlineRename() {
  const folderName = 'New Folder';
  let counter = 1;
  let finalFolderName = folderName;

  const existingNames = new Set(allFiles.map((f) => f.name));

  while (existingNames.has(finalFolderName)) {
    finalFolderName = `${folderName} (${counter})`;
    counter++;
  }

  const result = await window.electronAPI.createFolder(currentPath, finalFolderName);
  if (result.success && result.path) {
    const createdFolderPath = result.path;
    await navigateTo(currentPath);

    setTimeout(() => {
      const fileItems = document.querySelectorAll('.file-item');
      for (const item of Array.from(fileItems)) {
        const nameElement = item.querySelector('.file-name');
        if (nameElement && nameElement.textContent === finalFolderName) {
          startInlineRename(item as HTMLElement, finalFolderName, createdFolderPath);
          break;
        }
      }
    }, 100);
  } else {
    await showAlert(result.error || 'Unknown error', 'Error Creating Folder', 'error');
  }
}

function startInlineRename(fileItem: HTMLElement, currentName: string, itemPath: string) {
  const nameElement = fileItem.querySelector('.file-name') as HTMLElement | null;
  if (!nameElement) return;

  nameElement.style.display = 'none';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file-name-input';
  input.value = currentName;
  fileItem.appendChild(input);

  fileItem.classList.add('renaming');

  input.focus();

  const lastDotIndex = currentName.lastIndexOf('.');
  if (lastDotIndex > 0) {
    input.setSelectionRange(0, lastDotIndex);
  } else {
    input.select();
  }

  let renameHandled = false;

  const finishRename = async () => {
    if (renameHandled) {
      return;
    }
    renameHandled = true;

    input.removeEventListener('blur', finishRename);
    input.removeEventListener('keypress', handleKeyPress);
    input.removeEventListener('keydown', handleKeyDown);

    const newName = input.value.trim();

    if (newName && newName !== currentName) {
      const result = await window.electronAPI.renameItem(itemPath, newName);
      if (result.success) {
        await navigateTo(currentPath);
      } else {
        await showAlert(result.error || 'Unknown error', 'Error Renaming', 'error');
        nameElement.style.display = '';
        input.remove();
        fileItem.classList.remove('renaming');
      }
    } else {
      nameElement.style.display = '';
      input.remove();
      fileItem.classList.remove('renaming');
    }
  };

  const handleKeyPress = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      finishRename();
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      renameHandled = true;
      input.removeEventListener('blur', finishRename);
      input.removeEventListener('keypress', handleKeyPress);
      input.removeEventListener('keydown', handleKeyDown);
      nameElement.style.display = '';
      input.remove();
      fileItem.classList.remove('renaming');
    }
  };

  input.addEventListener('blur', finishRename);
  input.addEventListener('keypress', handleKeyPress);
  input.addEventListener('keydown', handleKeyDown);
}

function showContextMenu(x: number, y: number, item: FileItem) {
  const contextMenu = document.getElementById('context-menu');
  const addToBookmarksItem = document.getElementById('add-to-bookmarks-item');
  const changeFolderIconItem = document.getElementById('change-folder-icon-item');
  const copyPathItem = document.getElementById('copy-path-item');
  const openTerminalItem = document.getElementById('open-terminal-item');
  const compressItem = document.getElementById('compress-item');
  const extractItem = document.getElementById('extract-item');

  if (!contextMenu) return;

  hideEmptySpaceContextMenu();

  contextMenuData = item;

  if (addToBookmarksItem) {
    if (item.isDirectory) {
      addToBookmarksItem.style.display = 'flex';
    } else {
      addToBookmarksItem.style.display = 'none';
    }
  }

  if (changeFolderIconItem) {
    if (item.isDirectory) {
      changeFolderIconItem.style.display = 'flex';
    } else {
      changeFolderIconItem.style.display = 'none';
    }
  }

  if (copyPathItem) {
    if (!item.isDirectory) {
      copyPathItem.style.display = 'flex';
    } else {
      copyPathItem.style.display = 'none';
    }
  }

  if (openTerminalItem) {
    if (item.isDirectory) {
      openTerminalItem.style.display = 'flex';
    } else {
      openTerminalItem.style.display = 'none';
    }
  }

  if (compressItem) {
    compressItem.style.display = 'flex';
  }

  if (extractItem) {
    const fileName = item.name.toLowerCase();
    const isArchive =
      fileName.endsWith('.zip') ||
      fileName.endsWith('.tar.gz') ||
      fileName.endsWith('.tgz') ||
      fileName.endsWith('.7z') ||
      fileName.endsWith('.rar') ||
      fileName.endsWith('.tar') ||
      fileName.endsWith('.gz') ||
      fileName.endsWith('.bz2') ||
      fileName.endsWith('.xz') ||
      fileName.endsWith('.iso') ||
      fileName.endsWith('.cab') ||
      fileName.endsWith('.arj') ||
      fileName.endsWith('.lzh') ||
      fileName.endsWith('.wim');

    if (isArchive && !item.isDirectory) {
      extractItem.style.display = 'flex';
    } else {
      extractItem.style.display = 'none';
    }
  }

  contextMenu.style.display = 'block';

  const menuRect = contextMenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = x;
  let top = y;

  if (left + menuRect.width > viewportWidth) {
    left = viewportWidth - menuRect.width - 10;
  }

  if (top + menuRect.height > viewportHeight) {
    top = viewportHeight - menuRect.height - 10;
  }

  if (left < 10) left = 10;
  if (top < 10) top = 10;

  contextMenu.style.left = left + 'px';
  contextMenu.style.top = top + 'px';

  const submenu = contextMenu.querySelector('.context-submenu') as HTMLElement;
  if (submenu) {
    submenu.classList.remove('flip-left');
    const menuRight = left + menuRect.width;
    const submenuWidth = 160;

    if (menuRight + submenuWidth > viewportWidth - 10) {
      submenu.classList.add('flip-left');
    }
  }
}

let contextMenuFocusedIndex = -1;
let emptySpaceMenuFocusedIndex = -1;

function hideContextMenu() {
  const contextMenuElement = document.getElementById('context-menu');
  if (contextMenuElement) {
    contextMenuElement.style.display = 'none';
    contextMenuData = null;
    clearContextMenuFocus(contextMenuElement);
    contextMenuFocusedIndex = -1;
  }
}

function clearContextMenuFocus(menu: HTMLElement) {
  menu.querySelectorAll('.context-menu-item.focused').forEach((item) => {
    item.classList.remove('focused');
  });
}

function getVisibleMenuItems(menu: HTMLElement): HTMLElement[] {
  const items = menu.querySelectorAll('.context-menu-item');
  return Array.from(items).filter((item) => {
    const el = item as HTMLElement;
    const parent = el.parentElement;
    if (parent?.classList.contains('context-submenu')) return false;
    return el.style.display !== 'none' && el.offsetParent !== null;
  }) as HTMLElement[];
}

function navigateContextMenu(
  menu: HTMLElement,
  direction: 'up' | 'down',
  focusIndex: number
): number {
  const items = getVisibleMenuItems(menu);
  if (items.length === 0) return -1;

  clearContextMenuFocus(menu);

  let newIndex = focusIndex;
  if (direction === 'down') {
    newIndex = focusIndex < items.length - 1 ? focusIndex + 1 : 0;
  } else {
    newIndex = focusIndex > 0 ? focusIndex - 1 : items.length - 1;
  }

  items[newIndex].classList.add('focused');
  items[newIndex].scrollIntoView({ block: 'nearest' });
  return newIndex;
}

function activateContextMenuItem(menu: HTMLElement, focusIndex: number): boolean {
  const items = getVisibleMenuItems(menu);
  if (focusIndex < 0 || focusIndex >= items.length) return false;

  const item = items[focusIndex];
  if (item.classList.contains('has-submenu')) {
    const submenu = item.querySelector('.context-submenu') as HTMLElement;
    if (submenu) {
      submenu.style.display = 'block';
      const submenuItems = submenu.querySelectorAll(
        '.context-menu-item'
      ) as NodeListOf<HTMLElement>;
      if (submenuItems.length > 0) {
        submenuItems[0].classList.add('focused');
      }
    }
    return false;
  }

  item.click();
  return true;
}

function showEmptySpaceContextMenu(x: number, y: number) {
  const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');
  if (!emptySpaceContextMenu) return;

  hideContextMenu();

  emptySpaceContextMenu.style.display = 'block';

  const menuRect = emptySpaceContextMenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = x;
  let top = y;

  if (left + menuRect.width > viewportWidth) {
    left = viewportWidth - menuRect.width - 10;
  }

  if (top + menuRect.height > viewportHeight) {
    top = viewportHeight - menuRect.height - 10;
  }

  if (left < 10) left = 10;
  if (top < 10) top = 10;

  emptySpaceContextMenu.style.left = left + 'px';
  emptySpaceContextMenu.style.top = top + 'px';
}

function hideEmptySpaceContextMenu() {
  const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');
  if (emptySpaceContextMenu) {
    emptySpaceContextMenu.style.display = 'none';
    clearContextMenuFocus(emptySpaceContextMenu);
    emptySpaceMenuFocusedIndex = -1;
  }
}

async function handleEmptySpaceContextMenuAction(action: string | undefined) {
  switch (action) {
    case 'new-folder':
      await createNewFolderWithInlineRename();
      break;

    case 'new-file':
      await createNewFileWithInlineRename();
      break;

    case 'paste':
      await pasteFromClipboard();
      break;

    case 'refresh':
      await navigateTo(currentPath);
      break;

    case 'open-terminal':
      const terminalResult = await window.electronAPI.openTerminal(currentPath);
      if (!terminalResult.success) {
        showToast(terminalResult.error || 'Failed to open terminal', 'Error', 'error');
      }
      break;
  }

  hideEmptySpaceContextMenu();
}

async function handleContextMenuAction(
  action: string | undefined,
  item: FileItem,
  format?: string
) {
  switch (action) {
    case 'open':
      if (item.isDirectory) {
        navigateTo(item.path);
      } else {
        window.electronAPI.openFile(item.path);
        addToRecentFiles(item.path);
      }
      break;

    case 'rename':
      const fileItems = document.querySelectorAll('.file-item');
      for (const fileItem of Array.from(fileItems)) {
        if ((fileItem as HTMLElement).dataset.path === item.path) {
          startInlineRename(fileItem as HTMLElement, item.name, item.path);
          break;
        }
      }
      break;

    case 'copy':
      copyToClipboard();
      break;

    case 'cut':
      cutToClipboard();
      break;

    case 'copy-path':
      try {
        await navigator.clipboard.writeText(item.path);
        showToast('File path copied to clipboard', 'Success', 'success');
      } catch (error) {
        showToast('Failed to copy file path', 'Error', 'error');
      }
      break;

    case 'add-to-bookmarks':
      if (item.isDirectory) {
        await addBookmarkByPath(item.path);
      }
      break;

    case 'change-folder-icon':
      if (item.isDirectory) {
        showFolderIconPicker(item.path);
      }
      break;

    case 'open-terminal':
      const terminalPath = item.isDirectory ? item.path : path.dirname(item.path);
      const terminalResult = await window.electronAPI.openTerminal(terminalPath);
      if (!terminalResult.success) {
        showToast(terminalResult.error || 'Failed to open terminal', 'Error', 'error');
      }
      break;

    case 'properties':
      const propsResult = await window.electronAPI.getItemProperties(item.path);
      if (propsResult.success && propsResult.properties) {
        showPropertiesDialog(propsResult.properties);
      } else {
        showToast(propsResult.error || 'Unknown error', 'Error Getting Properties', 'error');
      }
      break;

    case 'delete':
      await deleteSelected();
      break;

    case 'compress':
      await handleCompress(format || 'zip');
      break;

    case 'extract':
      await handleExtract(item);
      break;
  }
}

async function handleCompress(format: string = 'zip') {
  const selectedPaths = Array.from(selectedItems);

  if (selectedPaths.length === 0) {
    showToast('No items selected', 'Error', 'error');
    return;
  }

  const extensionMap: Record<string, string> = {
    zip: '.zip',
    '7z': '.7z',
    tar: '.tar',
    'tar.gz': '.tar.gz',
  };

  const extension = extensionMap[format] || '.zip';

  let archiveName: string;
  if (selectedPaths.length === 1) {
    const itemName = path.basename(selectedPaths[0]);
    const nameWithoutExt = itemName.replace(/\.[^/.]+$/, '');
    archiveName = `${nameWithoutExt}${extension}`;
  } else {
    const folderName = path.basename(currentPath);
    archiveName = `${folderName}_${selectedPaths.length}_items${extension}`;
  }

  const outputPath = path.join(currentPath, archiveName);
  const operationId = generateOperationId();

  addOperation(operationId, 'compress', archiveName);

  const progressHandler = (progress: {
    operationId?: string;
    current: number;
    total: number;
    name: string;
  }) => {
    if (progress.operationId === operationId) {
      const operation = activeOperations.get(operationId);
      if (operation && !operation.aborted) {
        updateOperation(operationId, progress.current, progress.total, progress.name);
      }
    }
  };

  // Store cleanup function to prevent memory leaks
  const cleanupProgressHandler = window.electronAPI.onCompressProgress(progressHandler);

  try {
    const operation = activeOperations.get(operationId);
    if (operation?.aborted) {
      cleanupProgressHandler();
      removeOperation(operationId);
      return;
    }

    const result = await window.electronAPI.compressFiles(
      selectedPaths,
      outputPath,
      format,
      operationId
    );

    cleanupProgressHandler();
    removeOperation(operationId);

    if (result.success) {
      showToast(`Created ${archiveName}`, 'Compressed Successfully', 'success');
      await navigateTo(currentPath);
    } else {
      showToast(result.error || 'Compression failed', 'Error', 'error');
    }
  } catch (error) {
    cleanupProgressHandler();
    removeOperation(operationId);
    showToast(getErrorMessage(error), 'Compression Error', 'error');
  }
}

async function handleExtract(item: FileItem) {
  const ext = path.extname(item.path).toLowerCase();
  const supportedFormats = [
    '.zip',
    '.tar.gz',
    '.7z',
    '.rar',
    '.tar',
    '.gz',
    '.bz2',
    '.xz',
    '.iso',
    '.cab',
    '.arj',
    '.lzh',
    '.wim',
  ];

  const isSupported = supportedFormats.some((format) => item.path.toLowerCase().endsWith(format));

  if (!isSupported) {
    showToast(
      'Unsupported archive format. Supported: .zip, .7z, .rar, .tar.gz, and more',
      'Error',
      'error'
    );
    return;
  }

  let baseName = path.basename(item.path);
  if (item.path.toLowerCase().endsWith('.tar.gz')) {
    baseName = baseName.replace(/\.tar\.gz$/i, '');
  } else {
    baseName = path.basename(item.path, ext);
  }
  const destPath = path.join(currentPath, baseName);
  const operationId = generateOperationId();

  addOperation(operationId, 'extract', baseName);

  const progressHandler = (progress: {
    operationId?: string;
    current: number;
    total: number;
    name: string;
  }) => {
    if (progress.operationId === operationId) {
      const operation = activeOperations.get(operationId);
      if (operation && !operation.aborted) {
        updateOperation(operationId, progress.current, progress.total, progress.name);
      }
    }
  };

  const cleanupProgressHandler = window.electronAPI.onExtractProgress(progressHandler);

  try {
    const operation = activeOperations.get(operationId);
    if (operation?.aborted) {
      cleanupProgressHandler();
      removeOperation(operationId);
      return;
    }

    const result = await window.electronAPI.extractArchive(item.path, destPath, operationId);

    cleanupProgressHandler();
    removeOperation(operationId);

    if (result.success) {
      showToast(`Extracted to ${baseName}`, 'Extraction Complete', 'success');
      await navigateTo(currentPath);
    } else {
      showToast(result.error || 'Extraction failed', 'Error', 'error');
    }
  } catch (error) {
    cleanupProgressHandler();
    removeOperation(operationId);
    showToast(getErrorMessage(error), 'Extraction Error', 'error');
  }
}

function showPropertiesDialog(props: ItemProperties) {
  const modal = document.getElementById('properties-modal');
  const content = document.getElementById('properties-content');

  if (!modal || !content) return;

  // unique op IDs
  const folderSizeOperationId = `foldersize_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  const checksumOperationId = `checksum_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

  let folderSizeActive = false;
  let checksumActive = false;
  let folderSizeProgressCleanup: (() => void) | null = null;
  let checksumProgressCleanup: (() => void) | null = null;

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 bytes';
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const size = (bytes / Math.pow(1024, i)).toFixed(2);
    return `${bytes.toLocaleString()} bytes (${size} ${units[i]})`;
  };

  const sizeDisplay = formatSize(props.size);

  let html = `
    <div class="property-row">
      <div class="property-label">Name:</div>
      <div class="property-value">${escapeHtml(props.name)}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Type:</div>
      <div class="property-value">${props.isDirectory ? 'Folder' : 'File'}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Size:</div>
      <div class="property-value" id="props-size-value">${sizeDisplay}</div>
    </div>`;

  if (props.isDirectory) {
    html += `
    <div class="property-row property-folder-size">
      <div class="property-label">Contents:</div>
      <div class="property-value">
        <span id="folder-size-info">Not calculated</span>
        <button class="property-btn" id="calculate-folder-size-btn">${twemojiImg(String.fromCodePoint(0x1f4ca), 'twemoji')} Calculate Size</button>
      </div>
    </div>
    <div class="property-row" id="folder-size-progress-row" style="display: none;">
      <div class="property-label"></div>
      <div class="property-value">
        <div class="property-progress-container">
          <div class="property-progress-bar" id="folder-size-progress-bar"></div>
        </div>
        <div class="property-progress-text" id="folder-size-progress-text">Calculating...</div>
        <button class="property-btn property-btn-cancel" id="cancel-folder-size-btn">${twemojiImg(String.fromCodePoint(0x274c), 'twemoji')} Cancel</button>
      </div>
    </div>
    <div class="property-row" id="folder-stats-row" style="display: none;">
      <div class="property-label">File Types:</div>
      <div class="property-value">
        <div id="folder-stats-content" class="folder-stats-content"></div>
      </div>
    </div>`;
  }

  html += `
    <div class="property-row">
      <div class="property-label">Location:</div>
      <div class="property-value property-path">${escapeHtml(props.path)}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Created:</div>
      <div class="property-value">${new Date(props.created).toLocaleString()}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Modified:</div>
      <div class="property-value">${new Date(props.modified).toLocaleString()}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Accessed:</div>
      <div class="property-value">${new Date(props.accessed).toLocaleString()}</div>
    </div>`;

  if (props.isFile) {
    html += `
    <div class="property-separator"></div>
    <div class="property-row property-checksum-header">
      <div class="property-label">Checksums:</div>
      <div class="property-value">
        <button class="property-btn" id="calculate-checksum-btn">${twemojiImg(String.fromCodePoint(0x1f510), 'twemoji')} Calculate Checksums</button>
      </div>
    </div>
    <div class="property-row" id="checksum-progress-row" style="display: none;">
      <div class="property-label"></div>
      <div class="property-value">
        <div class="property-progress-container">
          <div class="property-progress-bar" id="checksum-progress-bar"></div>
        </div>
        <div class="property-progress-text" id="checksum-progress-text">Calculating...</div>
        <button class="property-btn property-btn-cancel" id="cancel-checksum-btn">${twemojiImg(String.fromCodePoint(0x274c), 'twemoji')} Cancel</button>
      </div>
    </div>
    <div class="property-row" id="checksum-md5-row" style="display: none;">
      <div class="property-label">MD5:</div>
      <div class="property-value property-checksum">
        <code id="checksum-md5-value"></code>
        <button class="property-btn-copy" id="copy-md5-btn" title="Copy MD5">${twemojiImg(String.fromCodePoint(0x1f4cb), 'twemoji')}</button>
      </div>
    </div>
    <div class="property-row" id="checksum-sha256-row" style="display: none;">
      <div class="property-label">SHA-256:</div>
      <div class="property-value property-checksum">
        <code id="checksum-sha256-value"></code>
        <button class="property-btn-copy" id="copy-sha256-btn" title="Copy SHA-256">${twemojiImg(String.fromCodePoint(0x1f4cb), 'twemoji')}</button>
      </div>
    </div>`;
  }

  content.innerHTML = html;
  modal.style.display = 'flex';

  const cleanup = () => {
    if (folderSizeActive) {
      window.electronAPI.cancelFolderSizeCalculation(folderSizeOperationId);
      folderSizeActive = false;
    }
    if (checksumActive) {
      window.electronAPI.cancelChecksumCalculation(checksumOperationId);
      checksumActive = false;
    }
    if (folderSizeProgressCleanup) {
      folderSizeProgressCleanup();
      folderSizeProgressCleanup = null;
    }
    if (checksumProgressCleanup) {
      checksumProgressCleanup();
      checksumProgressCleanup = null;
    }
  };

  const closeModal = () => {
    cleanup();
    modal.style.display = 'none';
  };

  if (props.isDirectory) {
    const calculateBtn = document.getElementById('calculate-folder-size-btn');
    const cancelBtn = document.getElementById('cancel-folder-size-btn');
    const progressRow = document.getElementById('folder-size-progress-row');
    const progressBar = document.getElementById('folder-size-progress-bar');
    const progressText = document.getElementById('folder-size-progress-text');
    const sizeInfo = document.getElementById('folder-size-info');

    if (calculateBtn) {
      calculateBtn.addEventListener('click', async () => {
        calculateBtn.style.display = 'none';
        if (progressRow) progressRow.style.display = 'flex';
        folderSizeActive = true;

        // progress listener
        folderSizeProgressCleanup = window.electronAPI.onFolderSizeProgress((progress) => {
          if (progress.operationId === folderSizeOperationId && progressBar && progressText) {
            const currentSize = formatSize(progress.calculatedSize);
            progressText.textContent = `${progress.fileCount} files, ${progress.folderCount} folders - ${currentSize}`;
            progressBar.style.width = '100%';
            progressBar.classList.add('indeterminate');
          }
        });

        try {
          const result = await window.electronAPI.calculateFolderSize(
            props.path,
            folderSizeOperationId
          );

          if (result.success && result.result) {
            const totalSize = formatSize(result.result.totalSize);
            if (sizeInfo) {
              sizeInfo.textContent = `${result.result.fileCount} files, ${result.result.folderCount} folders (${totalSize})`;
            }
            const propsSize = document.getElementById('props-size-value');
            if (propsSize) {
              propsSize.textContent = totalSize;
            }

            if (result.result.fileTypes && result.result.fileTypes.length > 0) {
              const statsRow = document.getElementById('folder-stats-row');
              const statsContent = document.getElementById('folder-stats-content');
              if (statsRow && statsContent) {
                statsRow.style.display = 'flex';
                const formatBytes = (bytes: number): string => {
                  if (bytes === 0) return '0 B';
                  const units = ['B', 'KB', 'MB', 'GB'];
                  const i = Math.floor(Math.log(bytes) / Math.log(1024));
                  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
                };
                statsContent.innerHTML = result.result.fileTypes
                  .map((ft) => {
                    const pct =
                      result.result!.totalSize > 0
                        ? ((ft.size / result.result!.totalSize) * 100).toFixed(1)
                        : '0';
                    return `<div class="file-type-stat">
                    <span class="file-type-ext">${escapeHtml(ft.extension)}</span>
                    <span class="file-type-count">${ft.count} files</span>
                    <span class="file-type-size">${formatBytes(ft.size)} (${pct}%)</span>
                    <div class="file-type-bar" style="width: ${pct}%"></div>
                  </div>`;
                  })
                  .join('');
              }
            }
          } else if (result.error !== 'Calculation cancelled') {
            if (sizeInfo) sizeInfo.textContent = `Error: ${result.error}`;
          }
        } catch (err) {
          if (sizeInfo) sizeInfo.textContent = `Error: ${getErrorMessage(err)}`;
        } finally {
          folderSizeActive = false;
          if (folderSizeProgressCleanup) {
            folderSizeProgressCleanup();
            folderSizeProgressCleanup = null;
          }
          if (progressRow) progressRow.style.display = 'none';
          if (progressBar) {
            progressBar.classList.remove('indeterminate');
            progressBar.style.width = '0%';
          }
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (folderSizeActive) {
          window.electronAPI.cancelFolderSizeCalculation(folderSizeOperationId);
          folderSizeActive = false;
        }
        if (folderSizeProgressCleanup) {
          folderSizeProgressCleanup();
          folderSizeProgressCleanup = null;
        }
        if (progressRow) progressRow.style.display = 'none';
        if (calculateBtn) calculateBtn.style.display = 'inline-flex';
        if (sizeInfo) sizeInfo.textContent = 'Calculation cancelled';
      });
    }
  }

  // checksum calculation
  if (props.isFile) {
    const calculateBtn = document.getElementById('calculate-checksum-btn');
    const cancelBtn = document.getElementById('cancel-checksum-btn');
    const progressRow = document.getElementById('checksum-progress-row');
    const progressBar = document.getElementById('checksum-progress-bar');
    const progressText = document.getElementById('checksum-progress-text');
    const md5Row = document.getElementById('checksum-md5-row');
    const sha256Row = document.getElementById('checksum-sha256-row');
    const md5Value = document.getElementById('checksum-md5-value');
    const sha256Value = document.getElementById('checksum-sha256-value');
    const copyMd5Btn = document.getElementById('copy-md5-btn');
    const copySha256Btn = document.getElementById('copy-sha256-btn');

    if (calculateBtn) {
      calculateBtn.addEventListener('click', async () => {
        calculateBtn.style.display = 'none';
        if (progressRow) progressRow.style.display = 'flex';
        checksumActive = true;

        checksumProgressCleanup = window.electronAPI.onChecksumProgress((progress) => {
          if (progress.operationId === checksumOperationId && progressBar && progressText) {
            progressBar.style.width = `${progress.percent}%`;
            progressText.textContent = `Calculating ${progress.algorithm.toUpperCase()}... ${progress.percent.toFixed(1)}%`;
          }
        });

        try {
          const result = await window.electronAPI.calculateChecksum(
            props.path,
            checksumOperationId,
            ['md5', 'sha256']
          );

          if (result.success && result.result) {
            if (result.result.md5 && md5Row && md5Value) {
              md5Value.textContent = result.result.md5;
              md5Row.style.display = 'flex';
            }
            if (result.result.sha256 && sha256Row && sha256Value) {
              sha256Value.textContent = result.result.sha256;
              sha256Row.style.display = 'flex';
            }
          } else if (result.error !== 'Calculation cancelled') {
            showToast(result.error || 'Checksum calculation failed', 'Error', 'error');
          }
        } catch (err) {
          showToast(getErrorMessage(err), 'Error', 'error');
        } finally {
          checksumActive = false;
          if (checksumProgressCleanup) {
            checksumProgressCleanup();
            checksumProgressCleanup = null;
          }
          if (progressRow) progressRow.style.display = 'none';
          if (progressBar) progressBar.style.width = '0%';
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (checksumActive) {
          window.electronAPI.cancelChecksumCalculation(checksumOperationId);
          checksumActive = false;
        }
        if (checksumProgressCleanup) {
          checksumProgressCleanup();
          checksumProgressCleanup = null;
        }
        if (progressRow) progressRow.style.display = 'none';
        if (calculateBtn) calculateBtn.style.display = 'inline-flex';
      });
    }

    if (copyMd5Btn && md5Value) {
      copyMd5Btn.addEventListener('click', () => {
        navigator.clipboard.writeText(md5Value.textContent || '');
        showToast('MD5 copied to clipboard', 'Copied', 'success');
      });
    }

    if (copySha256Btn && sha256Value) {
      copySha256Btn.addEventListener('click', () => {
        navigator.clipboard.writeText(sha256Value.textContent || '');
        showToast('SHA-256 copied to clipboard', 'Copied', 'success');
      });
    }
  }

  const propsCloseBtn = document.getElementById('properties-close');
  const propsOkBtn = document.getElementById('properties-ok');
  if (propsCloseBtn) propsCloseBtn.onclick = closeModal;
  if (propsOkBtn) propsOkBtn.onclick = closeModal;
  modal.onclick = (e) => {
    if (e.target === modal) closeModal();
  };
}

async function restartAsAdmin() {
  const confirmed = await showDialog(
    'Restart as Administrator',
    "Restarting the app with elevated permissions can lead to possible damage of your computer/files if you don't know what you're doing.",
    'warning',
    true
  );

  if (confirmed) {
    const result = await window.electronAPI.restartAsAdmin();
    if (!result.success) {
      showToast(
        result.error || 'Failed to restart with admin privileges',
        'Restart Failed',
        'error'
      );
    }
  }
}

function stripHtmlTags(html: string): string {
  let text = html.replace(/<[^>]*>/g, '');
  text = text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  text = text.replace(/!\[.*?\]\(.*?\)/g, '');
  text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
  return text;
}

async function checkForUpdates() {
  const btn = document.getElementById('check-updates-btn') as HTMLButtonElement;
  if (!btn) return;

  const originalHTML = btn.innerHTML;
  btn.innerHTML = `${twemojiImg(String.fromCodePoint(0x1f504), 'twemoji')} Checking...`;
  btn.disabled = true;

  try {
    const result = await window.electronAPI.checkForUpdates();

    if (result.success) {
      if (result.isFlatpak) {
        showDialog(
          'Updates via Flatpak',
          `You're running IYERIS as a Flatpak (${result.currentVersion}).\n\n${result.flatpakMessage}\n\nOr use your system's software center to check for updates.`,
          'info',
          false
        );
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        return;
      }

      if (result.isMas) {
        showDialog(
          'Updates via App Store',
          `You're running IYERIS from the Mac App Store (${result.currentVersion}).\n\n${result.masMessage}`,
          'info',
          false
        );
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        return;
      }

      if (result.isMsStore) {
        showDialog(
          'Updates via Microsoft Store',
          `You're running IYERIS from the Microsoft Store (${result.currentVersion}).\n\n${result.msStoreMessage}`,
          'info',
          false
        );
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        return;
      }

      if (result.isMsi) {
        showDialog(
          'Enterprise Installation',
          `You're running IYERIS as an enterprise installation (${result.currentVersion}).\n\n${result.msiMessage}`,
          'info',
          false
        );
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        return;
      }

      if (result.hasUpdate) {
        const updateTitle = result.isBeta ? 'Beta Update Available' : 'Update Available';
        const updateMessage = result.isBeta
          ? `[BETA CHANNEL] A new beta build is available!\n\nCurrent Version: ${result.currentVersion}\nNew Version: ${result.latestVersion}\n\nWould you like to download and install the update?`
          : `A new version is available!\n\nCurrent Version: ${result.currentVersion}\nNew Version: ${result.latestVersion}\n\nWould you like to download and install the update?`;

        const confirmed = await showDialog(updateTitle, updateMessage, 'success', true);

        if (confirmed) {
          await downloadAndInstallUpdate();
        }
      } else {
        if (result.isBeta) {
          showDialog(
            'No Updates Available',
            `You're on the latest beta channel build (${result.currentVersion})!`,
            'info',
            false
          );
        } else {
          showDialog(
            'No Updates Available',
            `You're running the latest version (${result.currentVersion})!`,
            'info',
            false
          );
        }
      }
    } else {
      showDialog(
        'Update Check Failed',
        `Failed to check for updates: ${result.error}`,
        'error',
        false
      );
    }
  } catch (error) {
    showDialog(
      'Update Check Failed',
      `An error occurred while checking for updates: ${getErrorMessage(error)}`,
      'error',
      false
    );
  } finally {
    btn.innerHTML = originalHTML;
    btn.disabled = false;
  }
}

async function downloadAndInstallUpdate() {
  const dialogModal = document.getElementById('dialog-modal') as HTMLElement;
  const dialogTitle = document.getElementById('dialog-title') as HTMLElement;
  const dialogContent = document.getElementById('dialog-content') as HTMLElement;
  const dialogIcon = document.getElementById('dialog-icon') as HTMLElement;
  const dialogOk = document.getElementById('dialog-ok') as HTMLButtonElement;
  const dialogCancel = document.getElementById('dialog-cancel') as HTMLButtonElement;

  dialogIcon.textContent = '⬇️';
  dialogTitle.textContent = 'Downloading Update';
  dialogContent.textContent = 'Preparing download... 0%';
  dialogOk.style.display = 'none';
  dialogCancel.style.display = 'none';
  dialogModal.style.display = 'flex';

  const cleanupProgress = window.electronAPI.onUpdateDownloadProgress((progress) => {
    const percent = progress.percent.toFixed(1);
    const transferred = formatFileSize(progress.transferred);
    const total = formatFileSize(progress.total);
    const speed = formatFileSize(progress.bytesPerSecond);

    dialogContent.textContent = `Downloading update...\n\n${percent}% (${transferred} / ${total})\nSpeed: ${speed}/s`;
  });

  try {
    const downloadResult = await window.electronAPI.downloadUpdate();
    cleanupProgress();

    if (!downloadResult.success) {
      dialogModal.style.display = 'none';
      showDialog(
        'Download Failed',
        `Failed to download update: ${downloadResult.error}`,
        'error',
        false
      );
      return;
    }

    dialogIcon.innerHTML = twemojiImg(String.fromCodePoint(0x2705), 'twemoji-large');
    dialogTitle.textContent = 'Update Downloaded';
    dialogContent.textContent =
      'The update has been downloaded successfully.\n\nThe application will restart to install the update.';
    dialogOk.style.display = 'block';
    dialogOk.textContent = 'Install & Restart';
    dialogCancel.style.display = 'block';
    dialogCancel.textContent = 'Later';

    const installPromise = new Promise<boolean>((resolve) => {
      const handleOk = () => {
        cleanup();
        resolve(true);
      };

      const handleCancel = () => {
        cleanup();
        resolve(false);
      };

      const cleanup = () => {
        dialogOk.removeEventListener('click', handleOk);
        dialogCancel.removeEventListener('click', handleCancel);
      };

      dialogOk.addEventListener('click', handleOk);
      dialogCancel.addEventListener('click', handleCancel);
    });

    const shouldInstall = await installPromise;
    dialogModal.style.display = 'none';

    if (shouldInstall) {
      await window.electronAPI.installUpdate();
    }
  } catch (error) {
    cleanupProgress();
    dialogModal.style.display = 'none';
    showDialog(
      'Update Error',
      `An error occurred during the update process: ${getErrorMessage(error)}`,
      'error',
      false
    );
  }
}

function initSettingsTabs() {
  const tabs = document.querySelectorAll('.settings-tab');
  const sections = document.querySelectorAll('.settings-section');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      // Remove active class from all tabs
      tabs.forEach((t) => t.classList.remove('active'));
      // Add active class to clicked tab
      tab.classList.add('active');

      // Hide all sections
      sections.forEach((section) => section.classList.remove('active'));

      // Show target section
      const targetId = `tab-${tab.getAttribute('data-tab')}`;
      const targetSection = document.getElementById(targetId);
      if (targetSection) {
        targetSection.classList.add('active');
      }
    });
  });
}

document.getElementById('settings-btn')?.addEventListener('click', showSettingsModal);
document.getElementById('settings-close')?.addEventListener('click', hideSettingsModal);
document.getElementById('save-settings-btn')?.addEventListener('click', saveSettings);
document.getElementById('reset-settings-btn')?.addEventListener('click', resetSettings);
document.getElementById('dangerous-options-toggle')?.addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement;
  updateDangerousOptionsVisibility(target.checked);
});
document.getElementById('browse-startup-path-btn')?.addEventListener('click', async () => {
  const result = await window.electronAPI.selectFolder();
  if (result.success && result.path) {
    const startupPathInput = document.getElementById('startup-path-input') as HTMLInputElement;
    if (startupPathInput) {
      startupPathInput.value = result.path;
    }
  }
});
document.getElementById('rebuild-index-btn')?.addEventListener('click', rebuildIndex);
document.getElementById('restart-admin-btn')?.addEventListener('click', restartAsAdmin);
document.getElementById('check-updates-btn')?.addEventListener('click', checkForUpdates);
document.getElementById('github-btn')?.addEventListener('click', () => {
  window.electronAPI.openFile('https://github.com/BurntToasters/IYERIS');
});
document.getElementById('rosie-link')?.addEventListener('click', () => {
  window.electronAPI.openFile('https://rosie.run/support');
});
document.getElementById('twemoji-cc-link')?.addEventListener('click', () => {
  window.electronAPI.openFile('https://github.com/jdecked/twemoji');
});
document.getElementById('help-link')?.addEventListener('click', () => {
  window.electronAPI.openFile('https://help.rosie.run/iyeris/en-us/faq');
});
document.getElementById('heart-button')?.addEventListener('click', () => {
  window.electronAPI.openFile('https://rosie.run/support');
});
document.getElementById('version-indicator')?.addEventListener('click', () => {
  const version = document.getElementById('version-indicator')?.textContent || 'v0.1.0';
  window.electronAPI.openFile(`https://github.com/BurntToasters/IYERIS/releases/tag/${version}`);
});

document.getElementById('settings-search')?.addEventListener('input', (e) => {
  const searchTerm = (e.target as HTMLInputElement).value.toLowerCase().trim();
  const settingItems = document.querySelectorAll('.setting-item, .setting-item-toggle');
  const sections = document.querySelectorAll('.settings-section-card');

  if (!searchTerm) {
    settingItems.forEach((item) => {
      (item as HTMLElement).style.display = '';
      item.classList.remove('search-highlight');
    });
    sections.forEach((section) => {
      (section as HTMLElement).style.display = '';
    });
    return;
  }

  sections.forEach((section) => {
    let hasVisibleItem = false;
    const items = section.querySelectorAll('.setting-item, .setting-item-toggle');

    items.forEach((item) => {
      const label = item.querySelector('.setting-label, span')?.textContent?.toLowerCase() || '';
      const description =
        item.querySelector('.setting-description')?.textContent?.toLowerCase() || '';

      if (label.includes(searchTerm) || description.includes(searchTerm)) {
        (item as HTMLElement).style.display = '';
        item.classList.add('search-highlight');
        hasVisibleItem = true;
      } else {
        (item as HTMLElement).style.display = 'none';
        item.classList.remove('search-highlight');
      }
    });

    (section as HTMLElement).style.display = hasVisibleItem ? '' : 'none';
  });
});

// Export
document.getElementById('export-settings-btn')?.addEventListener('click', async () => {
  try {
    const settingsJson = JSON.stringify(currentSettings, null, 2);
    const blob = new Blob([settingsJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iyeris-settings-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Settings exported successfully', 'Export', 'success');
  } catch (error) {
    showToast('Failed to export settings', 'Export', 'error');
  }
});

// Settings validation
function validateImportedSettings(imported: any): Partial<Settings> {
  const validated: Partial<Settings> = {};

  if (typeof imported.transparency === 'boolean') validated.transparency = imported.transparency;
  if (typeof imported.showDangerousOptions === 'boolean')
    validated.showDangerousOptions = imported.showDangerousOptions;
  if (typeof imported.showHiddenFiles === 'boolean')
    validated.showHiddenFiles = imported.showHiddenFiles;
  if (typeof imported.enableGitStatus === 'boolean')
    validated.enableGitStatus = imported.enableGitStatus;
  if (typeof imported.enableSearchHistory === 'boolean')
    validated.enableSearchHistory = imported.enableSearchHistory;
  if (typeof imported.enableIndexer === 'boolean') validated.enableIndexer = imported.enableIndexer;
  if (typeof imported.minimizeToTray === 'boolean')
    validated.minimizeToTray = imported.minimizeToTray;
  if (typeof imported.startOnLogin === 'boolean') validated.startOnLogin = imported.startOnLogin;
  if (typeof imported.autoCheckUpdates === 'boolean')
    validated.autoCheckUpdates = imported.autoCheckUpdates;
  if (typeof imported.showRecentFiles === 'boolean')
    validated.showRecentFiles = imported.showRecentFiles;
  if (typeof imported.enableTabs === 'boolean') validated.enableTabs = imported.enableTabs;
  if (typeof imported.globalContentSearch === 'boolean')
    validated.globalContentSearch = imported.globalContentSearch;

  if (typeof imported.startupPath === 'string') validated.startupPath = imported.startupPath;

  const validThemes = ['dark', 'light', 'default', 'custom'];
  if (validThemes.includes(imported.theme)) validated.theme = imported.theme;

  const validSortBy = ['name', 'date', 'size', 'type'];
  if (validSortBy.includes(imported.sortBy)) validated.sortBy = imported.sortBy;

  const validSortOrder = ['asc', 'desc'];
  if (validSortOrder.includes(imported.sortOrder)) validated.sortOrder = imported.sortOrder;

  const validViewModes = ['grid', 'list', 'column'];
  if (validViewModes.includes(imported.viewMode)) validated.viewMode = imported.viewMode;

  if (Array.isArray(imported.bookmarks)) {
    validated.bookmarks = imported.bookmarks.filter((b: any) => typeof b === 'string');
  }
  if (Array.isArray(imported.searchHistory)) {
    validated.searchHistory = imported.searchHistory
      .filter((s: any) => typeof s === 'string')
      .slice(0, 100);
  }
  if (Array.isArray(imported.directoryHistory)) {
    validated.directoryHistory = imported.directoryHistory
      .filter((d: any) => typeof d === 'string')
      .slice(0, 100);
  }

  if (imported.customTheme && typeof imported.customTheme === 'object') {
    const ct = imported.customTheme;
    const isValidHex = (s: any) => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
    if (
      typeof ct.name === 'string' &&
      isValidHex(ct.accentColor) &&
      isValidHex(ct.bgPrimary) &&
      isValidHex(ct.bgSecondary) &&
      isValidHex(ct.textPrimary) &&
      isValidHex(ct.textSecondary) &&
      isValidHex(ct.glassBg) &&
      isValidHex(ct.glassBorder)
    ) {
      validated.customTheme = ct;
    }
  }

  return validated;
}

// Import
document.getElementById('import-settings-btn')?.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      const validatedSettings = validateImportedSettings(parsed);

      if (Object.keys(validatedSettings).length === 0) {
        showToast('No valid settings found in file', 'Import', 'warning');
        return;
      }

      currentSettings = { ...currentSettings, ...validatedSettings };
      await window.electronAPI.saveSettings(currentSettings);

      hideSettingsModal();
      showSettingsModal();
      showToast(
        `Imported ${Object.keys(validatedSettings).length} settings successfully`,
        'Import',
        'success'
      );
    } catch (error) {
      showToast('Failed to import settings: Invalid file format', 'Import', 'error');
    }
  };
  input.click();
});

document.getElementById('clear-search-history-btn')?.addEventListener('click', async () => {
  if (confirm('Are you sure you want to clear your search history?')) {
    currentSettings.searchHistory = [];
    await window.electronAPI.saveSettings(currentSettings);
    showToast('Search history cleared', 'Data', 'success');
  }
});

document.getElementById('clear-bookmarks-btn')?.addEventListener('click', async () => {
  if (confirm('Are you sure you want to clear all bookmarks?')) {
    currentSettings.bookmarks = [];
    await window.electronAPI.saveSettings(currentSettings);
    loadBookmarks();
    showToast('Bookmarks cleared', 'Data', 'success');
  }
});

document.getElementById('about-github-btn')?.addEventListener('click', () => {
  window.electronAPI.openFile('https://github.com/BurntToasters/IYERIS');
});
document.getElementById('about-support-btn')?.addEventListener('click', () => {
  window.electronAPI.openFile('https://rosie.run/support');
});
document.getElementById('about-help-btn')?.addEventListener('click', () => {
  window.electronAPI.openFile('https://help.rosie.run/iyeris/en-us/faq');
});
document.getElementById('about-licenses-btn')?.addEventListener('click', () => {
  showLicensesModal();
});
document.getElementById('about-shortcuts-btn')?.addEventListener('click', () => {
  showShortcutsModal();
});
document.getElementById('about-rosie-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  window.electronAPI.openFile('https://rosie.run');
});
document.getElementById('about-twemoji-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  window.electronAPI.openFile('https://github.com/jdecked/twemoji');
});

// Unsaved changes
let hasUnsavedChanges = false;
let themeDropdownChanged = false;

function markSettingsChanged() {
  hasUnsavedChanges = true;
  const indicator = document.querySelector('.settings-unsaved-indicator');
  if (indicator) {
    indicator.classList.add('visible');
  }
}

function clearSettingsChanged() {
  hasUnsavedChanges = false;
  themeDropdownChanged = false;
  const indicator = document.querySelector('.settings-unsaved-indicator');
  if (indicator) {
    indicator.classList.remove('visible');
  }
}

let settingsChangeTrackingInitialized = false;

function initSettingsChangeTracking() {
  if (settingsChangeTrackingInitialized) return;

  const settingsModal = document.getElementById('settings-modal');
  if (!settingsModal) return;

  settingsModal.querySelectorAll('input, select').forEach((input) => {
    input.addEventListener('change', markSettingsChanged);
    if (input.tagName === 'INPUT' && (input as HTMLInputElement).type === 'text') {
      input.addEventListener('input', markSettingsChanged);
    }
  });

  settingsChangeTrackingInitialized = true;
}

// Support Window
function showSupportPopup() {
  const modal = document.getElementById('support-popup-modal');
  if (modal) {
    modal.style.display = 'flex';
  }
}

function hideSupportPopup() {
  const modal = document.getElementById('support-popup-modal');
  if (modal) {
    modal.style.display = 'none';
  }
}

document.getElementById('support-popup-dismiss')?.addEventListener('click', async () => {
  currentSettings.supportPopupDismissed = true;
  await window.electronAPI.saveSettings(currentSettings);
  hideSupportPopup();
});

document.getElementById('support-popup-yes')?.addEventListener('click', () => {
  window.electronAPI.openFile('https://rosie.run/support');
  hideSupportPopup();
});

document.getElementById('zoom-in-btn')?.addEventListener('click', zoomIn);
document.getElementById('zoom-out-btn')?.addEventListener('click', zoomOut);
document.getElementById('zoom-reset-btn')?.addEventListener('click', zoomReset);

document.getElementById('licenses-btn')?.addEventListener('click', showLicensesModal);
document.getElementById('licenses-close')?.addEventListener('click', hideLicensesModal);
document.getElementById('close-licenses-btn')?.addEventListener('click', hideLicensesModal);
document.getElementById('copy-licenses-btn')?.addEventListener('click', copyLicensesText);
const licensesContent = document.getElementById('licenses-content');
if (licensesContent) {
  licensesContent.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const link = target?.closest('a.license-link') as HTMLAnchorElement | null;
    if (!link) return;

    const url = link.dataset.url || link.getAttribute('href');
    if (!url) return;

    event.preventDefault();
    window.electronAPI.openFile(url);
  });
}

document.getElementById('shortcuts-close')?.addEventListener('click', hideShortcutsModal);
document.getElementById('close-shortcuts-btn')?.addEventListener('click', hideShortcutsModal);

document.getElementById('folder-icon-close')?.addEventListener('click', hideFolderIconPicker);
document.getElementById('folder-icon-cancel')?.addEventListener('click', hideFolderIconPicker);
document.getElementById('folder-icon-reset')?.addEventListener('click', resetFolderIcon);

const folderIconModal = document.getElementById('folder-icon-modal');
if (folderIconModal) {
  folderIconModal.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'folder-icon-modal') {
      hideFolderIconPicker();
    }
  });
}

const settingsModal = document.getElementById('settings-modal');
if (settingsModal) {
  settingsModal.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'settings-modal') {
      hideSettingsModal();
    }
  });
}

const licensesModal = document.getElementById('licenses-modal');
if (licensesModal) {
  licensesModal.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'licenses-modal') {
      hideLicensesModal();
    }
  });
}

const shortcutsModal = document.getElementById('shortcuts-modal');
if (shortcutsModal) {
  shortcutsModal.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'shortcuts-modal') {
      hideShortcutsModal();
    }
  });
}

const previewPanel = document.getElementById('preview-panel') as HTMLElement;
const previewContent = document.getElementById('preview-content') as HTMLElement;
const previewToggleBtn = document.getElementById('preview-toggle-btn') as HTMLButtonElement;
const previewCloseBtn = document.getElementById('preview-close') as HTMLButtonElement;

function showEmptyPreview() {
  if (!previewContent) return;
  previewContent.innerHTML = `
    <div class="preview-empty">
      <div class="preview-empty-icon">${twemojiImg(String.fromCodePoint(0x1f441), 'twemoji-xlarge')}</div>
      <p>Select a file to preview</p>
      <small>Press Space for quick look</small>
    </div>
  `;
}

function togglePreviewPanel() {
  isPreviewPanelVisible = !isPreviewPanelVisible;
  if (isPreviewPanelVisible) {
    previewPanel.style.display = 'flex';
    if (selectedItems.size === 1) {
      const selectedPath = Array.from(selectedItems)[0];
      const file = filePathMap.get(selectedPath);
      if (file && file.isFile) {
        updatePreview(file);
      }
    }
  } else {
    previewPanel.style.display = 'none';
    previewRequestId++;
  }
}

function updatePreview(file: FileItem) {
  const requestId = ++previewRequestId;
  if (!file || file.isDirectory) {
    showEmptyPreview();
    return;
  }

  const ext = file.name.split('.').pop()?.toLowerCase() || '';

  if (IMAGE_EXTENSIONS.has(ext)) {
    showImagePreview(file, requestId);
  } else if (TEXT_EXTENSIONS.has(ext)) {
    showTextPreview(file, requestId);
  } else if (VIDEO_EXTENSIONS.has(ext)) {
    showVideoPreview(file, requestId);
  } else if (AUDIO_EXTENSIONS.has(ext)) {
    showAudioPreview(file, requestId);
  } else if (PDF_EXTENSIONS.has(ext)) {
    showPdfPreview(file, requestId);
  } else {
    showFileInfo(file, requestId);
  }
}

async function showImagePreview(file: FileItem, requestId: number) {
  if (!previewContent || requestId !== previewRequestId) return;
  previewContent.innerHTML = `
    <div class="preview-loading">
      <div class="spinner"></div>
      <p>Loading image...</p>
    </div>
  `;

  if (file.size > THUMBNAIL_MAX_SIZE) {
    if (requestId !== previewRequestId) return;
    previewContent.innerHTML = `
      <div class="preview-error">
        Failed to load image: ${escapeHtml('File too large to preview')}
      </div>
      ${generateFileInfo(file, null)}
    `;
    return;
  }

  const props = await window.electronAPI.getItemProperties(file.path);
  if (requestId !== previewRequestId) return;
  const info = props.success && props.properties ? props.properties : null;
  const fileUrl = encodeFileUrl(file.path);
  const altText = escapeHtml(file.name);

  previewContent.innerHTML = `
    <img src="${fileUrl}" class="preview-image" alt="${altText}">
    ${generateFileInfo(file, info)}
  `;

  const img = previewContent.querySelector('.preview-image') as HTMLImageElement | null;
  if (img) {
    img.addEventListener('error', () => {
      if (requestId !== previewRequestId) return;
      previewContent.innerHTML = `
        <div class="preview-error">
          Failed to load image
        </div>
        ${generateFileInfo(file, info)}
      `;
    });
  }
}

let hljs: any = null;
let hljsLoading: Promise<any> | null = null;

const EXT_TO_LANG: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  pyc: 'python',
  pyw: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  r: 'r',
  lua: 'lua',
  perl: 'perl',
  pl: 'perl',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ps1: 'powershell',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  svelte: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  md: 'markdown',
  markdown: 'markdown',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  cmake: 'cmake',
};

async function loadHighlightJs(): Promise<any> {
  if (hljs) return hljs;
  if (hljsLoading) return hljsLoading;

  hljsLoading = new Promise((resolve) => {
    const existingLink = document.querySelector('link[data-highlightjs="theme"]');
    if (!existingLink) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'dist/vendor/highlight.css';
      link.dataset.highlightjs = 'theme';
      document.head.appendChild(link);
    }

    const existingScript = document.querySelector(
      'script[data-highlightjs="core"]'
    ) as HTMLScriptElement | null;
    if (existingScript) {
      existingScript.addEventListener('load', () => {
        hljs = (window as any).hljs || null;
        resolve(hljs);
      });
      existingScript.addEventListener('error', () => resolve(null));
      const existingGlobal = (window as any).hljs;
      if (existingGlobal) {
        hljs = existingGlobal;
        resolve(hljs);
      }
      return;
    }

    const script = document.createElement('script');
    script.src = 'dist/vendor/highlight.js';
    script.dataset.highlightjs = 'core';
    script.onload = () => {
      hljs = (window as any).hljs || null;
      resolve(hljs);
    };
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });

  return hljsLoading;
}

function getLanguageForExt(ext: string): string | null {
  return EXT_TO_LANG[ext.toLowerCase()] || null;
}

async function showTextPreview(file: FileItem, requestId: number) {
  if (!previewContent || requestId !== previewRequestId) return;
  previewContent.innerHTML = `
    <div class="preview-loading">
      <div class="spinner"></div>
      <p>Loading text...</p>
    </div>
  `;

  const result = await window.electronAPI.readFileContent(file.path, 50 * 1024);
  if (requestId !== previewRequestId) return;

  if (result.success && typeof result.content === 'string') {
    const props = await window.electronAPI.getItemProperties(file.path);
    if (requestId !== previewRequestId) return;
    const info = props.success && props.properties ? props.properties : null;
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const lang = getLanguageForExt(ext);

    previewContent.innerHTML = `
      ${result.isTruncated ? `<div class="preview-truncated">${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} File truncated to first 50KB</div>` : ''}
      <pre class="preview-text"><code class="${lang ? `language-${lang}` : ''}">${escapeHtml(result.content)}</code></pre>
      ${generateFileInfo(file, info)}
    `;

    if (lang && currentSettings.enableSyntaxHighlighting) {
      loadHighlightJs().then((hl) => {
        if (requestId !== previewRequestId || !hl) return;
        const codeBlock = previewContent?.querySelector('code');
        if (codeBlock) hl.highlightElement(codeBlock);
      });
    }
  } else {
    previewContent.innerHTML = `
      <div class="preview-error">
        Failed to load text: ${escapeHtml(result.error || 'Unknown error')}
      </div>
      ${generateFileInfo(file, null)}
    `;
  }
}

async function showVideoPreview(file: FileItem, requestId: number) {
  if (!previewContent || requestId !== previewRequestId) return;

  const props = await window.electronAPI.getItemProperties(file.path);
  if (requestId !== previewRequestId) return;
  const info = props.success && props.properties ? props.properties : null;

  const fileUrl = encodeFileUrl(file.path);

  previewContent.innerHTML = `
    <video src="${fileUrl}" class="preview-video" controls controlsList="nodownload">
      Your browser does not support the video tag.
    </video>
    ${generateFileInfo(file, info)}
  `;
}

async function showAudioPreview(file: FileItem, requestId: number) {
  if (!previewContent || requestId !== previewRequestId) return;

  const props = await window.electronAPI.getItemProperties(file.path);
  if (requestId !== previewRequestId) return;
  const info = props.success && props.properties ? props.properties : null;

  const fileUrl = encodeFileUrl(file.path);

  previewContent.innerHTML = `
    <div class="preview-audio-container">
      <div class="preview-audio-icon">${twemojiImg(String.fromCodePoint(0x1f3b5), 'twemoji-xlarge')}</div>
      <audio src="${fileUrl}" class="preview-audio" controls controlsList="nodownload">
        Your browser does not support the audio tag.
      </audio>
    </div>
    ${generateFileInfo(file, info)}
  `;
}

async function showPdfPreview(file: FileItem, requestId: number) {
  if (!previewContent || requestId !== previewRequestId) return;

  const props = await window.electronAPI.getItemProperties(file.path);
  if (requestId !== previewRequestId) return;
  const info = props.success && props.properties ? props.properties : null;

  const fileUrl = encodeFileUrl(file.path);

  previewContent.innerHTML = `
    <iframe src="${fileUrl}" class="preview-pdf" frameborder="0"></iframe>
    ${generateFileInfo(file, info)}
  `;
}

async function showFileInfo(file: FileItem, requestId: number) {
  if (!previewContent || requestId !== previewRequestId) return;
  const props = await window.electronAPI.getItemProperties(file.path);
  if (requestId !== previewRequestId) return;
  const info = props.success && props.properties ? props.properties : null;

  previewContent.innerHTML = `
    <div class="preview-unsupported">
      <div class="preview-unsupported-icon">${getFileIcon(file.name)}</div>
      <div>
        <strong>${escapeHtml(file.name)}</strong>
        <p>Preview not available for this file type</p>
      </div>
    </div>
    ${generateFileInfo(file, info)}
  `;
}

function generateFileInfo(file: FileItem, props: ItemProperties | null): string {
  const size = props ? props.size : file.size;
  const sizeDisplay = formatFileSize(size);
  const modified = props ? new Date(props.modified) : new Date(file.modified);

  return `
    <div class="preview-info">
      <div class="preview-info-item">
        <span class="preview-info-label">Name</span>
        <span class="preview-info-value">${escapeHtml(file.name)}</span>
      </div>
      <div class="preview-info-item">
        <span class="preview-info-label">Type</span>
        <span class="preview-info-value">${file.isDirectory ? 'Folder' : 'File'}</span>
      </div>
      <div class="preview-info-item">
        <span class="preview-info-label">Size</span>
        <span class="preview-info-value">${sizeDisplay}</span>
      </div>
      <div class="preview-info-item">
        <span class="preview-info-label">Location</span>
        <span class="preview-info-value">${escapeHtml(file.path)}</span>
      </div>
      ${
        props && props.created
          ? `
      <div class="preview-info-item">
        <span class="preview-info-label">Created</span>
        <span class="preview-info-value">${new Date(props.created).toLocaleString()}</span>
      </div>`
          : ''
      }
      <div class="preview-info-item">
        <span class="preview-info-label">Modified</span>
        <span class="preview-info-value">${modified.toLocaleDateString()} ${modified.toLocaleTimeString()}</span>
      </div>
      ${
        props && props.accessed
          ? `
      <div class="preview-info-item">
        <span class="preview-info-label">Accessed</span>
        <span class="preview-info-value">${new Date(props.accessed).toLocaleString()}</span>
      </div>`
          : ''
      }
    </div>
  `;
}

const quicklookModal = document.getElementById('quicklook-modal') as HTMLElement;
const quicklookContent = document.getElementById('quicklook-content') as HTMLElement;
const quicklookTitle = document.getElementById('quicklook-title') as HTMLElement;
const quicklookInfo = document.getElementById('quicklook-info') as HTMLElement;
const quicklookClose = document.getElementById('quicklook-close') as HTMLButtonElement;
const quicklookOpen = document.getElementById('quicklook-open') as HTMLButtonElement;
let quicklookRequestId = 0;

async function showQuickLook() {
  if (selectedItems.size !== 1) return;
  if (!quicklookModal || !quicklookTitle || !quicklookContent || !quicklookInfo) return;

  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  const selectedPath = Array.from(selectedItems)[0];
  const file = filePathMap.get(selectedPath);

  if (!file || file.isDirectory) return;

  const requestId = ++quicklookRequestId;
  currentQuicklookFile = file;
  quicklookTitle.textContent = file.name;
  quicklookModal.style.display = 'flex';

  const ext = file.name.split('.').pop()?.toLowerCase() || '';

  quicklookContent.innerHTML = `
    <div class="preview-loading">
      <div class="spinner"></div>
      <p>Loading preview...</p>
    </div>
  `;

  if (IMAGE_EXTENSIONS.has(ext)) {
    if (file.size > THUMBNAIL_MAX_SIZE) {
      quicklookContent.innerHTML = `<div class="preview-error">Image too large to preview</div>`;
      quicklookInfo.textContent = `${formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
    } else {
      const fileUrl = encodeFileUrl(file.path);
      quicklookContent.innerHTML = '';
      const img = document.createElement('img');
      img.src = fileUrl;
      img.alt = file.name;
      img.addEventListener('error', () => {
        if (requestId !== quicklookRequestId || currentQuicklookFile?.path !== file.path) {
          return;
        }
        quicklookContent.innerHTML = `<div class="preview-error">Failed to load image</div>`;
      });
      quicklookContent.appendChild(img);
      quicklookInfo.textContent = `${formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
    }
  } else if (VIDEO_EXTENSIONS.has(ext)) {
    const fileUrl = encodeFileUrl(file.path);
    quicklookContent.innerHTML = '';
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.className = 'preview-video';
    const source = document.createElement('source');
    source.src = fileUrl;
    source.type = VIDEO_MIME_TYPES[ext] || 'video/*';
    video.appendChild(source);
    video.appendChild(document.createTextNode('Your browser does not support the video tag.'));
    quicklookContent.appendChild(video);
    quicklookInfo.textContent = `${formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
  } else if (AUDIO_EXTENSIONS.has(ext)) {
    const fileUrl = encodeFileUrl(file.path);
    quicklookContent.innerHTML = '';
    const container = document.createElement('div');
    container.className = 'preview-audio-container';
    const icon = document.createElement('div');
    icon.className = 'preview-audio-icon';
    icon.innerHTML = twemojiImg(String.fromCodePoint(0x1f3b5), 'twemoji-large');
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.autoplay = true;
    audio.className = 'preview-audio';
    const source = document.createElement('source');
    source.src = fileUrl;
    source.type = AUDIO_MIME_TYPES[ext] || 'audio/*';
    audio.appendChild(source);
    audio.appendChild(document.createTextNode('Your browser does not support the audio tag.'));
    container.appendChild(icon);
    container.appendChild(audio);
    quicklookContent.appendChild(container);
    quicklookInfo.textContent = `${formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
  } else if (PDF_EXTENSIONS.has(ext)) {
    const fileUrl = encodeFileUrl(file.path);
    quicklookContent.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.src = fileUrl;
    iframe.className = 'preview-pdf';
    iframe.setAttribute('frameborder', '0');
    quicklookContent.appendChild(iframe);
    quicklookInfo.textContent = `${formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
  } else if (TEXT_EXTENSIONS.has(ext)) {
    const result = await window.electronAPI.readFileContent(file.path, 100 * 1024);
    if (requestId !== quicklookRequestId || currentQuicklookFile?.path !== file.path) {
      return;
    }
    if (result.success && typeof result.content === 'string') {
      const lang = getLanguageForExt(ext);
      quicklookContent.innerHTML = `
        ${result.isTruncated ? `<div class="preview-truncated">${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} File truncated to first 100KB</div>` : ''}
        <pre class="preview-text"><code class="${lang ? `language-${lang}` : ''}">${escapeHtml(result.content)}</code></pre>
      `;
      quicklookInfo.textContent = `${formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
      if (lang && currentSettings.enableSyntaxHighlighting) {
        loadHighlightJs().then((hl) => {
          if (requestId !== quicklookRequestId || currentQuicklookFile?.path !== file.path || !hl)
            return;
          const codeBlock = quicklookContent?.querySelector('code');
          if (codeBlock) hl.highlightElement(codeBlock);
        });
      }
    } else {
      quicklookContent.innerHTML = `<div class="preview-error">Failed to load text</div>`;
    }
  } else {
    quicklookContent.innerHTML = `
      <div class="preview-unsupported">
        <div class="preview-unsupported-icon">${getFileIcon(file.name)}</div>
        <p>Preview not available for this file type</p>
      </div>
    `;
    quicklookInfo.textContent = `${formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
  }
}

function closeQuickLook() {
  if (quicklookModal) quicklookModal.style.display = 'none';
  currentQuicklookFile = null;
  quicklookRequestId++;
}

if (previewToggleBtn) {
  previewToggleBtn.addEventListener('click', togglePreviewPanel);
}

if (previewCloseBtn) {
  previewCloseBtn.addEventListener('click', () => {
    isPreviewPanelVisible = false;
    if (previewPanel) previewPanel.style.display = 'none';
    previewRequestId++;
  });
}

if (quicklookClose) {
  quicklookClose.addEventListener('click', closeQuickLook);
}

if (quicklookOpen) {
  quicklookOpen.addEventListener('click', () => {
    if (currentQuicklookFile) {
      window.electronAPI.openFile(currentQuicklookFile.path);
      addToRecentFiles(currentQuicklookFile.path);
      closeQuickLook();
    }
  });
}

if (quicklookModal) {
  quicklookModal.addEventListener('click', (e) => {
    if (e.target === quicklookModal) {
      closeQuickLook();
    }
  });
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
    const activeElement = document.activeElement;
    if (
      activeElement &&
      (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')
    ) {
      return;
    }

    const settingsModal = document.getElementById('settings-modal');
    const shortcutsModal = document.getElementById('shortcuts-modal');
    const dialogModal = document.getElementById('dialog-modal');
    const licensesModal = document.getElementById('licenses-modal');

    if (
      (settingsModal && settingsModal.style.display === 'flex') ||
      (shortcutsModal && shortcutsModal.style.display === 'flex') ||
      (dialogModal && dialogModal.style.display === 'flex') ||
      (licensesModal && licensesModal.style.display === 'flex')
    ) {
      return;
    }

    e.preventDefault();
    if (quicklookModal && quicklookModal.style.display === 'flex') {
      closeQuickLook();
    } else {
      showQuickLook();
    }
  }

  if (e.key === 'Escape' && quicklookModal && quicklookModal.style.display === 'flex') {
    closeQuickLook();
  }
});
if (searchInput) {
  searchInput.addEventListener('focus', () => {
    if (currentSettings.enableSearchHistory) {
      showSearchHistoryDropdown();
    }
  });

  searchInput.addEventListener('blur', (e) => {
    setTimeout(() => {
      const searchDropdown = document.getElementById('search-history-dropdown');
      if (searchDropdown && !searchDropdown.matches(':hover')) {
        hideSearchHistoryDropdown();
      }
    }, 150);
  });
}

if (addressInput) {
  addressInput.addEventListener('focus', () => {
    if (currentSettings.enableSearchHistory) {
      showDirectoryHistoryDropdown();
    }
  });

  addressInput.addEventListener('blur', (e) => {
    setTimeout(() => {
      const directoryDropdown = document.getElementById('directory-history-dropdown');
      if (directoryDropdown && !directoryDropdown.matches(':hover')) {
        hideDirectoryHistoryDropdown();
      }
    }, 150);
  });
}

document.addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement;

  if (target.classList.contains('history-item') && target.dataset.query) {
    e.preventDefault();
    const query = target.dataset.query;
    if (searchInput) {
      searchInput.value = query;
      setTimeout(() => searchInput.focus(), 0);
    }
    hideSearchHistoryDropdown();
    performSearch();
    return;
  }

  if (target.classList.contains('history-item') && target.dataset.path) {
    e.preventDefault();
    const path = target.dataset.path;
    navigateTo(path);
    hideDirectoryHistoryDropdown();
    return;
  }

  if (target.classList.contains('history-clear') && target.dataset.action === 'clear-search') {
    e.preventDefault();
    clearSearchHistory();
    return;
  }

  if (target.classList.contains('history-clear') && target.dataset.action === 'clear-directory') {
    e.preventDefault();
    clearDirectoryHistory();
    return;
  }
});

(async () => {
  try {
    console.log('Starting IYERIS...');
    await init();
    console.log('IYERIS initialized successfully');
  } catch (error) {
    console.error('Failed to initialize IYERIS:', error);
    alert('Failed to start IYERIS: ' + getErrorMessage(error));
  }
})();

window.addEventListener('beforeunload', () => {
  stopIndexStatusPolling();
  cancelActiveSearch();
  if (thumbnailObserver) {
    thumbnailObserver.disconnect();
    thumbnailObserver = null;
  }

  if (diskSpaceDebounceTimer) {
    clearTimeout(diskSpaceDebounceTimer);
    diskSpaceDebounceTimer = null;
  }
  if (zoomPopupTimeout) {
    clearTimeout(zoomPopupTimeout);
    zoomPopupTimeout = null;
  }
  if (settingsSaveTimeout) {
    clearTimeout(settingsSaveTimeout);
    settingsSaveTimeout = null;
  }
  if (searchDebounceTimeout) {
    clearTimeout(searchDebounceTimeout);
    searchDebounceTimeout = null;
  }
  if (renderOperationsTimeout) {
    clearTimeout(renderOperationsTimeout);
    renderOperationsTimeout = null;
  }

  filePathMap.clear();
  thumbnailCache.clear();
  pendingThumbnailLoads.length = 0;

  for (const cleanup of ipcCleanupFunctions) {
    try {
      cleanup();
    } catch (e) {
      console.error('[Cleanup] Error cleaning up IPC listener:', e);
    }
  }
  ipcCleanupFunctions.length = 0;
});
