import { createFileRenderController } from '../src/rendererFileRender.ts';
import { createDualPaneController } from '../src/rendererDualPane.ts';
import { createColumnViewController } from '../src/rendererColumnView.ts';
import { createSearchController } from '../src/rendererSearch.ts';
import { createTabsController } from '../src/rendererTabs.ts';
import { createSelectionController, moveGridFocusWithinScope } from '../src/rendererSelection.ts';
import { createSortController } from '../src/rendererSort.ts';
import { createCommandPaletteController } from '../src/rendererCommandPalette.ts';
import { createBookmarksController } from '../src/rendererBookmarks.ts';
import { loadMarked, sanitizeMarkdownHtml } from '../src/rendererMarkdown.ts';
import { createPreviewController } from '../src/rendererPreviews.ts';
import { createOperationQueueController } from '../src/rendererOperationQueue.ts';
import { createBatchRenameController } from '../src/rendererBatchRename.ts';
import { createThumbnailController } from '../src/rendererThumbnails.ts';
import { createCompressExtractController } from '../src/rendererCompressExtract.ts';
import { twemojiImg } from '../src/rendererUtils.ts';
import '../src/css/main.css';

const { document, requestAnimationFrame, performance, window, DragEvent } = globalThis;
const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const noop = () => {};
const textOf = (row, selector) => row?.querySelector(selector)?.textContent?.trim() ?? '';
const fixtureItem = (overrides) => ({
  name: '',
  path: '',
  isDirectory: false,
  isFile: true,
  size: 0,
  modified: new Date('2025-01-01T00:00:00Z'),
  isHidden: false,
  ...overrides,
});

// Mock IPC surface shared by the Dual Pane, Column View, and Search suites.
const ipc = {
  clearDragData: 0,
  directoryLoads: [],
  searchIndex: [],
  setDragData: [],
};
const installTauriApi = () => {
  window.tauriAPI = {
    cancelDirectoryContents: async () => ({ success: true }),
    cancelSearch: async () => ({ success: true }),
    clearDragData: async () => {
      ipc.clearDragData += 1;
    },
    getDirectoryContents: async (dirPath) => {
      ipc.directoryLoads.push(dirPath);
      return { success: true, contents: [] };
    },
    searchIndex: async (...args) => {
      ipc.searchIndex.push(args);
      return { success: true, results: [] };
    },
    setDragData: async (paths) => {
      ipc.setDragData.push(paths);
    },
  };
};

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(message);
};

async function runVirtualizationSuite(results) {
  document.body.innerHTML =
    '<div id="file-view" class="file-view" style="height:600px;flex:none"><div id="file-grid" class="file-grid"></div></div><div id="empty-state"></div>';
  const grid = document.getElementById('file-grid');
  const view = document.getElementById('file-view');
  const elements = new Map();
  const settings = {
    showHiddenFiles: true,
    showFileExtensions: true,
    sortBy: 'name',
    sortOrder: 'asc',
  };
  const controller = createFileRenderController({
    getFileGrid: () => grid,
    getEmptyState: () => document.getElementById('empty-state'),
    getCurrentSettings: () => settings,
    getFileElementMap: () => elements,
    showToast: noop,
    clearSelection: noop,
    updateStatusBar: noop,
    markSelectionDirty: noop,
    setHiddenFilesCount: noop,
    getHiddenFilesCount: () => 0,
    setAllFiles: noop,
    setDisableEntryAnimation: noop,
    setDisableThumbnailRendering: noop,
    ensureActiveItem: noop,
    applyGitIndicatorsToPaths: noop,
    updateCutVisuals: noop,
    clearCutPaths: noop,
    clearGitCache: noop,
    observeThumbnailItem: noop,
    resetThumbnailObserver: noop,
    getFolderIcon: () => '',
    nameCollator: new Intl.Collator('en'),
    dateFormatter: new Intl.DateTimeFormat('en-US'),
  });
  const items = Array.from({ length: 15000 }, (_, index) => ({
    name: `${String(index).padStart(5, '0')}-${index % 3 === 0 ? 'long file name with spaces and extra words' : 'file'}.txt`,
    path: `/fixture/${index}`,
    isDirectory: false,
    isFile: true,
    size: 1024,
    modified: new Date('2025-01-01T00:00:00Z'),
    isHidden: false,
  }));
  // Glyph metrics settle asynchronously and change line wrapping, so measure
  // only after the document's fonts are ready.
  await document.fonts?.ready;
  await frame();
  for (const mode of ['grid', 'list']) {
    grid.classList.toggle('list-view', mode === 'list');
    view.scrollTop = 0;
    const start = performance.now();
    controller.renderFiles(items);
    await frame();
    const firstPaintMs = performance.now() - start;
    let maxMounted = 0;
    for (const index of [0, 7499, 14999, 0]) {
      const path = `/fixture/${index}`;
      const item = controller.ensureItemRendered(path);
      await frame();
      assert(item && elements.has(path), `${mode}: item ${index} disappeared`);
      const mounted = grid.querySelectorAll('.file-item').length;
      maxMounted = Math.max(maxMounted, mounted);
      assert(mounted <= 380, `${mode}: mounted ${mounted} entries`);
      const bounds = elements.get(path).getBoundingClientRect();
      const viewport = view.getBoundingClientRect();
      assert(
        bounds.bottom > viewport.top && bounds.top < viewport.bottom,
        `${mode}: item ${index} outside viewport`
      );
      assert(elements.size === mounted, `${mode}: stale element map`);
    }
    view.scrollTop = view.scrollHeight;
    await frame();
    assert(elements.has('/fixture/14999'), `${mode}: scrolling cannot reach last item`);
    results.push({
      mode,
      entries: items.length,
      maxMounted,
      firstPaintMs: Math.round(firstPaintMs),
    });
  }
  controller.renderFiles([]);
}

async function runDualPaneSuite(results) {
  ipc.clearDragData = 0;
  ipc.directoryLoads = [];
  document.body.innerHTML =
    '<div id="dual-pane-secondary" style="display:flex;height:600px"><div id="dual-pane-secondary-path"></div><div id="dual-pane-secondary-list" style="height:560px;overflow:auto"></div></div>';
  const list = document.getElementById('dual-pane-secondary-list');
  assert(list, 'dual-pane: secondary list fixture missing');
  const settings = {
    showHiddenFiles: false,
    showFileExtensions: false,
    sortBy: 'name',
    sortOrder: 'asc',
    dualPaneEnabled: true,
    activePane: 'left',
  };
  const controller = createDualPaneController({
    getCurrentSettings: () => settings,
    getCurrentPath: () => '/fixture',
    getSelectedItems: () => new Set(),
    setSelectedItems: noop,
    getPrimaryPaneSelected: () => new Set(),
    setPrimaryPaneSelected: noop,
    getSecondaryPaneSelected: () => new Set(),
    setSecondaryPaneSelected: noop,
    getFileElementMap: () => new Map(),
    updateStatusBar: noop,
    debouncedSaveSettings: noop,
    showToast: noop,
    refresh: noop,
    navigateTo: noop,
    observeThumbnailItem: noop,
    showContextMenu: noop,
    getDragOperation: () => 'copy',
    getDraggedPaths: async () => [],
    showDropIndicator: noop,
    hideDropIndicator: noop,
    scheduleSpringLoad: noop,
    clearSpringLoad: noop,
    handleDrop: async () => false,
    copySelectedToDestination: async () => false,
    moveSelectedToDestination: async () => false,
    ensureActiveItem: noop,
    invalidateFileItemsCache: noop,
  });
  const rawPath = '/fixture/dual-pane/photo.cr2';
  const hiddenPath = '/fixture/dual-pane/.hidden-thumbnail.txt';
  const sampleName = 'document-000.txt';
  const items = [
    fixtureItem({ name: 'photo.cr2', path: rawPath, size: 20_000_000 }),
    fixtureItem({ name: '.hidden-thumbnail.txt', path: hiddenPath, size: 10, isHidden: true }),
    ...Array.from({ length: 448 }, (_, index) => {
      const name = `document-${String(index).padStart(3, '0')}.txt`;
      return fixtureItem({
        name,
        path: `/fixture/dual-pane/${name}`,
        size: 1024 + index,
      });
    }),
  ];
  controller.renderSecondaryPaneItems(items);
  const initialBatch = list.querySelectorAll('.dual-pane-item').length;
  assert(initialBatch === 200, `dual-pane: initial batch mounted ${initialBatch} rows`);
  await waitFor(
    () => list.querySelectorAll('.dual-pane-item').length === 449,
    `dual-pane: batched rendering stalled at ${list.querySelectorAll('.dual-pane-item').length} rows`
  );
  const mounted = list.querySelectorAll('.dual-pane-item').length;
  const hiddenRows = list.querySelectorAll(`[data-path="${hiddenPath}"]`).length;
  assert(hiddenRows === 0, 'dual-pane: hidden file leaked into the secondary pane');
  const rawRow = list.querySelector(`[data-path="${rawPath}"]`);
  assert(rawRow, 'dual-pane: RAW file missing from the secondary pane');
  assert(
    rawRow.dataset.thumbnailType === 'raw',
    `dual-pane: RAW thumbnail type was ${rawRow.dataset.thumbnailType}`
  );
  assert(
    rawRow.classList.contains('has-thumbnail'),
    'dual-pane: RAW row is not thumbnail-eligible'
  );
  const strippedName = textOf(
    list.querySelector(`[data-path="/fixture/dual-pane/${sampleName}"]`),
    '.dual-pane-item-name'
  );
  assert(strippedName === 'document-000', `dual-pane: extension not stripped (${strippedName})`);
  results.push({
    mode: 'dual-pane',
    entries: items.length,
    visibleEntries: 449,
    initialBatch,
    mounted,
    hiddenExcluded: true,
    rawThumbnailType: rawRow.dataset.thumbnailType,
    strippedName,
  });
}

async function runColumnViewSuite(results) {
  ipc.clearDragData = 0;
  ipc.directoryLoads = [];
  ipc.setDragData = [];
  document.body.innerHTML =
    '<div id="column-view" style="display:flex;height:600px;overflow:auto"></div>';
  const columnView = document.getElementById('column-view');
  assert(columnView, 'column-view: fixture missing');
  const directoryItem = (name, size) =>
    fixtureItem({
      name,
      path: `/fixture/${name}`,
      isDirectory: true,
      isFile: false,
      size,
    });
  const fileItem = (name, size) => fixtureItem({ name, path: `/fixture/${name}`, size });
  const contents = [
    directoryItem('delta-folder', 900_000),
    directoryItem('alpha-folder', 10),
    fileItem('notes.txt', 300),
    fileItem('video.mp4', 5_000_000),
    fileItem('archive.zip', 1_000),
    fileItem('photo.cr2', 2_000_000),
  ];
  window.tauriAPI.getDirectoryContents = async (dirPath) => {
    ipc.directoryLoads.push(dirPath);
    return { success: true, contents: dirPath === '/fixture' ? contents : [] };
  };
  const settings = {
    showHiddenFiles: true,
    showFileExtensions: false,
    sortBy: 'size',
    sortOrder: 'desc',
  };
  const selected = new Set();
  const controller = createColumnViewController({
    columnView,
    getCurrentPath: () => '/fixture',
    setCurrentPath: noop,
    getCurrentSettings: () => settings,
    getSelectedItems: () => selected,
    clearSelection: () => selected.clear(),
    addressInput: document.createElement('input'),
    updateBreadcrumb: noop,
    showToast: noop,
    showContextMenu: noop,
    getFileIcon: () => '',
    openFileEntry: async () => {},
    updatePreview: noop,
    consumeEvent: (event) => {
      event.preventDefault();
      event.stopPropagation();
    },
    getDragOperation: () => 'copy',
    showDropIndicator: noop,
    hideDropIndicator: noop,
    getDraggedPaths: async () => [],
    handleDrop: async () => false,
    scheduleSpringLoad: noop,
    clearSpringLoad: noop,
    createDirectoryOperationId: (prefix) => `${prefix}-1`,
    getCachedDriveInfo: () => [],
    cacheDriveInfo: noop,
    folderTreeManager: { ensurePathVisible: noop },
    getFileByPath: () => undefined,
    nameCollator: new Intl.Collator('en'),
  });
  await controller.renderColumnView();
  const panes = columnView.querySelectorAll('.column-pane');
  assert(panes.length === 2, `column-view: rendered ${panes.length} panes`);
  const pane = panes[panes.length - 1];
  const names = Array.from(pane.querySelectorAll('.column-item:not(.placeholder)')).map((item) =>
    textOf(item, '.column-item-name')
  );
  const directories = Array.from(pane.querySelectorAll('.column-item.is-directory')).map((item) =>
    textOf(item, '.column-item-name')
  );
  assert(
    directories.join(',') === 'delta-folder,alpha-folder',
    `column-view: directory order was ${directories.join(',')}`
  );
  const fileOrder = names.slice(directories.length).join(',');
  assert(fileOrder === 'video,photo,archive,notes', `column-view: file order was ${fileOrder}`);
  assert(
    names.every((name) => !name.includes('.')),
    `column-view: extensions were not stripped (${names.join(',')})`
  );
  const dragTarget = pane.querySelector('[data-path="/fixture/video.mp4"]');
  assert(dragTarget, 'column-view: drag target missing');
  const dragSource = dragTarget.querySelector('.column-item-name') ?? dragTarget;
  dragSource.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
  assert(
    ipc.setDragData.length === 1 && ipc.setDragData[0].join(',') === '/fixture/video.mp4',
    `column-view: delegated dragstart produced ${JSON.stringify(ipc.setDragData)}`
  );
  assert(
    dragTarget.classList.contains('selected') && dragTarget.classList.contains('dragging'),
    'column-view: delegated dragstart did not mark the row'
  );
  dragSource.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }));
  assert(
    ipc.clearDragData === 1 && !dragTarget.classList.contains('dragging'),
    'column-view: delegated dragend did not reset drag state'
  );
  results.push({
    mode: 'column-view',
    panes: panes.length,
    directories: directories.join(','),
    fileOrder,
    extensionsStripped: true,
    dragDelegatedPaths: ipc.setDragData[0].join(','),
    directoryLoads: ipc.directoryLoads.join(','),
  });
}

async function runSearchSuite(results) {
  ipc.searchIndex = [];
  document.body.innerHTML = `
    <div class="search-bar-wrapper" style="display:none">
      <button id="search-btn"></button>
      <input id="search-input" />
      <button id="search-close"></button>
      <button id="search-scope-toggle"></button>
      <button id="search-filter-toggle"></button>
      <div id="search-filters-panel" style="display:none">
        <select id="search-filter-type">
          <option value="all">All Types</option>
          <option value="document">Documents</option>
        </select>
        <input id="search-filter-min-size" type="number" />
        <input id="search-filter-max-size" type="number" />
        <select id="search-filter-size-unit-min"><option value="1024">KB</option></select>
        <select id="search-filter-size-unit-max"><option value="1048576">MB</option></select>
        <input id="search-filter-date-from" type="date" />
        <input id="search-filter-date-to" type="date" />
        <button id="search-filter-clear"></button>
        <button id="search-filter-apply"></button>
        <label><input id="search-in-contents-toggle" type="checkbox" /></label>
        <button id="search-regex-toggle"></button>
      </div>
      <button id="search-save-btn"></button>
    </div>
    <div id="search-history-dropdown" style="display:none"></div>
    <span id="filter-badge" style="display:none"></span>
    <div id="file-grid"></div>
  `;
  const indexResults = Array.from({ length: 60 }, (_, index) =>
    fixtureItem({
      name: `report-${index}.pdf`,
      path: `/fixture/report-${index}.pdf`,
      size: 4096 + index,
    })
  );
  const seenFilters = [];
  window.tauriAPI.searchIndex = async (...args) => {
    ipc.searchIndex.push(args);
    seenFilters.push(args[2]);
    return { success: true, results: indexResults };
  };
  const announcements = [];
  const toasts = [];
  const settings = {
    showHiddenFiles: false,
    enableSearchHistory: false,
    globalContentSearch: false,
  };
  let renderedCount = 0;
  const controller = createSearchController({
    getCurrentPath: () => '/fixture',
    getCurrentSettings: () => settings,
    setAllFiles: (files) => {
      renderedCount = files.length;
    },
    renderFiles: (files) => {
      renderedCount = files.length;
    },
    showLoading: noop,
    hideLoading: noop,
    updateStatusBar: noop,
    showToast: (message, title, type) => {
      toasts.push(`${type}:${title}:${message}`);
    },
    createDirectoryOperationId: (scope) => `${scope}-e2e`,
    navigateTo: async () => {},
    debouncedSaveSettings: noop,
    saveSettingsWithTimestamp: async () => ({ success: true }),
    getFileGrid: () => document.getElementById('file-grid'),
    setHomeViewActive: noop,
    searchDebounceMs: 0,
    searchHistoryMax: 5,
    announceToScreenReader: (message) => {
      announcements.push(message);
    },
  });
  controller.initListeners();
  controller.openSearch(true);
  controller.setQuery('report');
  document.getElementById('search-filter-type').value = 'document';
  document.getElementById('search-filter-apply').click();
  await controller.performSearch();
  const filteredCalls = ipc.searchIndex.filter(
    (args) => args[2] && args[2].fileType === 'document'
  );
  assert(
    filteredCalls.length >= 1,
    `search: searchIndex never received the fileType filter (${JSON.stringify(seenFilters)})`
  );
  const [query, operationId, filters, includeHidden] = filteredCalls[filteredCalls.length - 1];
  assert(query === 'report', `search: unexpected query (${query})`);
  assert(typeof operationId === 'string' && operationId.length > 0, 'search: operationId missing');
  assert(includeHidden === false, `search: includeHidden was ${includeHidden}`);
  assert(renderedCount === 60, `search: rendered ${renderedCount} results`);
  assert(
    announcements.includes('60 results found'),
    `search: announcements were ${JSON.stringify(announcements)}`
  );
  assert(document.querySelector('.search-results-cap-banner') === null, 'search: stray cap banner');
  assert(toasts.length === 0, `search: unexpected toasts ${JSON.stringify(toasts)}`);
  results.push({
    mode: 'search',
    query,
    filterFileType: filters.fileType,
    includeHidden,
    resultCount: renderedCount,
    announcement: announcements[announcements.length - 1],
    capBannerShown: false,
  });
}

async function runTabsNavigationSuite(results) {
  document.body.innerHTML = `
    <div class="titlebar-tabs" id="tab-bar" style="display:none" role="tablist">
      <div class="tab-list" id="tab-list"></div>
      <button class="tab-new-btn" id="new-tab-btn" type="button" aria-label="New tab"></button>
    </div>
    <input id="address-input" />
    <div id="file-view" class="file-view"></div>
  `;
  const tabList = document.getElementById('tab-list');
  assert(tabList, 'tabs-and-navigation: #tab-list fixture missing');
  const state = {
    tabs: [],
    activeTabId: '',
    tabsEnabled: false,
    newTabListenerAttached: false,
    tabCacheAccessOrder: [],
    saveTabStateTimeout: null,
    currentPath: '/workspace',
    history: ['/workspace'],
    historyIndex: 0,
    selectedItems: new Set(),
    allFiles: [],
    scrollTop: 0,
  };
  const settings = { enableTabs: true, startupPath: '' };
  const controller = createTabsController({
    getTabs: () => state.tabs,
    setTabs: (tabs) => {
      state.tabs = tabs;
    },
    getActiveTabId: () => state.activeTabId,
    setActiveTabId: (id) => {
      state.activeTabId = id;
    },
    getTabsEnabled: () => state.tabsEnabled,
    setTabsEnabled: (enabled) => {
      state.tabsEnabled = enabled;
    },
    getTabNewButtonListenerAttached: () => state.newTabListenerAttached,
    setTabNewButtonListenerAttached: (attached) => {
      state.newTabListenerAttached = attached;
    },
    getTabCacheAccessOrder: () => state.tabCacheAccessOrder,
    setTabCacheAccessOrder: (order) => {
      state.tabCacheAccessOrder = order;
    },
    getSaveTabStateTimeout: () => state.saveTabStateTimeout,
    setSaveTabStateTimeout: (timeout) => {
      state.saveTabStateTimeout = timeout;
    },
    getCurrentSettings: () => settings,
    getCurrentPath: () => state.currentPath,
    setCurrentPath: (path) => {
      state.currentPath = path;
    },
    getHistory: () => state.history,
    setHistory: (history) => {
      state.history = history;
    },
    getHistoryIndex: () => state.historyIndex,
    setHistoryIndex: (index) => {
      state.historyIndex = index;
    },
    getSelectedItems: () => state.selectedItems,
    setSelectedItems: (items) => {
      state.selectedItems = items;
    },
    getAllFiles: () => state.allFiles,
    setAllFiles: (files) => {
      state.allFiles = files;
    },
    getFileViewScrollTop: () => state.scrollTop,
    setFileViewScrollTop: (value) => {
      state.scrollTop = value;
    },
    getAddressInput: () => document.getElementById('address-input'),
    getPathDisplayValue: (path) => path,
    isHomeViewPath: () => false,
    homeViewLabel: 'Home',
    homeViewPath: '/home',
    getViewMode: () => 'grid',
    renderFiles: noop,
    renderColumnView: noop,
    updateBreadcrumb: noop,
    updateNavigationButtons: noop,
    setHomeViewActive: noop,
    navigateTo: async (target) => {
      state.currentPath = target;
      state.allFiles = [];
    },
    watchDirectory: noop,
    debouncedSaveSettings: noop,
    saveSettingsWithTimestamp: async () => ({ success: true }),
    maxCachedTabs: 5,
    maxCachedFilesPerTab: 2000,
    isMainWindow: false,
  });
  const tabCount = () => tabList.querySelectorAll('.tab-item').length;

  controller.initializeTabs();
  assert(state.tabsEnabled, 'tabs-and-navigation: controller did not enable tabs');
  assert(
    document.body.classList.contains('tabs-enabled'),
    'tabs-and-navigation: body class missing after initialization'
  );
  let maxTabsRendered = tabCount();
  assert(maxTabsRendered === 1, `tabs-and-navigation: initial tab count ${maxTabsRendered}`);

  // Real button wiring from initializeTabs, not a direct addNewTab call.
  document.getElementById('new-tab-btn').click();
  await frame();
  assert(
    state.currentPath === '/home',
    `tabs-and-navigation: new-tab button left ${state.currentPath}`
  );
  maxTabsRendered = Math.max(maxTabsRendered, tabCount());

  await controller.addNewTab('/workspace/alpha');
  await controller.addNewTab('/workspace/beta');
  maxTabsRendered = Math.max(maxTabsRendered, tabCount());
  assert(tabCount() === 4, `tabs-and-navigation: expected 4 tabs, saw ${tabCount()}`);
  const alphaTab = state.tabs.find((tab) => tab.path === '/workspace/alpha');
  const betaTab = state.tabs.find((tab) => tab.path === '/workspace/beta');
  const homeTab = state.tabs.find((tab) => tab.path === '/home');
  assert(alphaTab && betaTab && homeTab, 'tabs-and-navigation: tab data missing after addNewTab');

  controller.switchToTab(alphaTab.id);
  await waitFor(
    () => state.currentPath === '/workspace/alpha',
    'tabs-and-navigation: switchToTab did not navigate'
  );
  await frame();
  const activePathAfterSwitch = state.currentPath;
  const activeItem = tabList.querySelector('.tab-item.active');
  assert(
    activeItem?.dataset.tabId === alphaTab.id,
    'tabs-and-navigation: .tab-item.active does not match the active tab'
  );

  controller.closeTab(homeTab.id);
  controller.closeTab(betaTab.id);
  await frame();
  assert(tabCount() === 2, `tabs-and-navigation: closeTab left ${tabCount()} tabs`);

  controller.restoreClosedTab();
  await waitFor(
    () => tabCount() === 3 && state.currentPath === '/workspace/beta',
    'tabs-and-navigation: restoreClosedTab did not reopen the closed tab'
  );
  const reopenedPath = state.tabs.find((tab) => tab.id === state.activeTabId)?.path ?? '';
  assert(
    reopenedPath === '/workspace/beta',
    `tabs-and-navigation: reopened ${reopenedPath} instead of the closed tab`
  );
  assert(
    tabList.querySelectorAll('.tab-item .tab-close').length === tabCount(),
    'tabs-and-navigation: tab close buttons missing'
  );
  results.push({
    mode: 'tabs-and-navigation',
    maxTabsRendered,
    activePathAfterSwitch,
    reopenedPath,
  });
}

async function runSelectionSortSuite(results) {
  document.body.innerHTML = `
    <div id="file-view" class="file-view" style="height:400px">
      <div id="file-grid" class="file-grid"></div>
    </div>
    <button id="sort-btn" type="button" aria-expanded="false"></button>
    <div id="sort-menu" class="sort-menu" role="menu" style="display:none">
      <button type="button" class="context-menu-item" data-sort="name" role="menuitem"><span class="sort-indicator" id="sort-name"></span></button>
      <button type="button" class="context-menu-item" data-sort="date" role="menuitem"><span class="sort-indicator" id="sort-date"></span></button>
      <button type="button" class="context-menu-item" data-sort="size" role="menuitem"><span class="sort-indicator" id="sort-size"></span></button>
      <button type="button" class="context-menu-item" data-sort="type" role="menuitem"><span class="sort-indicator" id="sort-type"></span></button>
    </div>
  `;
  const grid = document.getElementById('file-grid');
  const sortMenu = document.getElementById('sort-menu');
  assert(grid && sortMenu, 'selection-and-sort: fixture elements missing');
  const files = Array.from({ length: 12 }, (_, index) =>
    fixtureItem({
      name: `file-${String(index).padStart(2, '0')}.txt`,
      path: `/workspace/file-${String(index).padStart(2, '0')}.txt`,
      size: 128 + index,
    })
  );
  grid.innerHTML = files
    .map(
      (file, index) =>
        `<div class="file-item" data-path="${file.path}" tabindex="${index === 0 ? 0 : -1}"><span class="file-name">${file.name}</span></div>`
    )
    .join('');
  const selected = new Set();
  const announcements = [];
  const controller = createSelectionController({
    getOrderedFiles: () => files,
    ensureItemRendered: (path) => grid.querySelector(`[data-path="${path}"]`),
    getSelectedItems: () => selected,
    setSelectedItems: noop,
    updateStatusBar: noop,
    onSelectionChanged: noop,
    isPreviewVisible: () => false,
    updatePreview: noop,
    clearPreview: noop,
    getFileByPath: (path) => files.find((file) => file.path === path),
    getViewMode: () => 'grid',
    getFileGrid: () => grid,
    openFileEntry: noop,
    announceToScreenReader: (message) => announcements.push(message),
  });

  const focusBefore = grid.querySelector('.file-item[tabindex="0"]');
  moveGridFocusWithinScope(grid, 'ArrowRight', 'grid');
  const focusAfterRight = grid.querySelector('.file-item[tabindex="0"]');
  assert(
    focusAfterRight && focusAfterRight !== focusBefore,
    'selection-and-sort: ArrowRight did not move grid focus'
  );
  assert(
    focusAfterRight.tabIndex === 0 && focusBefore.tabIndex === -1,
    'selection-and-sort: roving tabindex was not maintained'
  );
  moveGridFocusWithinScope(grid, 'ArrowDown', 'grid');
  const focusAfterDown = grid.querySelector('.file-item[tabindex="0"]');
  assert(
    focusAfterDown && focusAfterDown !== focusAfterRight,
    'selection-and-sort: ArrowDown did not move grid focus'
  );

  controller.selectAll();
  const selectedAllCount = selected.size;
  assert(
    selectedAllCount === files.length,
    `selection-and-sort: selectAll selected ${selectedAllCount}`
  );
  assert(
    grid.querySelectorAll('.file-item.selected').length === files.length,
    'selection-and-sort: selectAll did not mark every mounted row'
  );
  controller.clearSelection();
  assert(
    selected.size === 0 && grid.querySelectorAll('.file-item.selected').length === 0,
    'selection-and-sort: clearSelection left rows selected'
  );
  controller.selectSingleItem(grid.querySelector('.file-item'));
  assert(selected.size === 1, 'selection-and-sort: selectSingleItem did not select one row');

  // rendererSelection exposes no dedicated invert primitive; invert through the
  // production toggle path by clearing and re-selecting the complement.
  const beforeInvert = [...selected];
  controller.clearSelection();
  for (const file of files) {
    if (beforeInvert.includes(file.path)) continue;
    const row = grid.querySelector(`[data-path="${file.path}"]`);
    controller.toggleSelection(row);
  }
  const invertedCount = selected.size;
  assert(
    invertedCount === files.length - beforeInvert.length,
    `selection-and-sort: inverted selection was ${invertedCount}`
  );

  const sortSettings = { sortBy: 'name', sortOrder: 'asc', viewMode: 'grid' };
  let sortRenders = 0;
  const sortController = createSortController({
    getSortBtn: () => document.getElementById('sort-btn'),
    getCurrentSettings: () => sortSettings,
    getAllFiles: () => files,
    saveSettingsWithTimestamp: async () => ({ success: true }),
    renderFiles: () => {
      sortRenders += 1;
    },
  });
  sortController.showSortMenu(new window.MouseEvent('click'));
  assert(
    sortMenu.style.display === 'block',
    'selection-and-sort: showSortMenu did not open the menu'
  );
  assert(
    document.getElementById('sort-name').textContent === '▲',
    'selection-and-sort: name sort indicator missing'
  );
  assert(
    document.activeElement === sortMenu.querySelector('.context-menu-item'),
    'selection-and-sort: showSortMenu did not focus the first item'
  );
  assert(
    sortController.handleSortMenuKeyNav(
      new window.KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true })
    ) === true,
    'selection-and-sort: sort menu key navigation failed'
  );
  sortController.hideSortMenu();
  assert(sortMenu.style.display === 'none', 'selection-and-sort: hideSortMenu left the menu open');
  await sortController.changeSortMode('size');
  assert(
    sortSettings.sortBy === 'size' && sortSettings.sortOrder === 'asc',
    `selection-and-sort: sort settings were ${sortSettings.sortBy}/${sortSettings.sortOrder}`
  );
  assert(
    document.getElementById('sort-size').textContent === '▲' &&
      document.getElementById('sort-name').textContent === '',
    'selection-and-sort: sort indicators did not follow the change'
  );
  assert(
    sortRenders === 1 && announcements.length > 0,
    'selection-and-sort: sort change did not re-render or announce the selection'
  );
  results.push({
    mode: 'selection-and-sort',
    selectedAllCount,
    invertedCount,
    activeSortBy: sortSettings.sortBy,
  });
}

async function runCommandPaletteBookmarksSuite(results) {
  document.body.innerHTML = `
    <div class="modal-overlay" id="command-palette-modal" style="display:none">
      <div class="modal">
        <input id="command-palette-input" autocomplete="off" />
        <div id="command-palette-results"></div>
        <div id="command-palette-empty" style="display:none"></div>
      </div>
    </div>
    <div id="bookmarks-list" role="list"></div>
  `;
  const fired = [];
  const actions = {
    createNewFolder: () => fired.push('createNewFolder'),
    createNewFile: () => fired.push('createNewFile'),
    refresh: () => fired.push('refresh'),
    goBack: () => fired.push('goBack'),
    goForward: () => fired.push('goForward'),
    goUp: () => fired.push('goUp'),
    goHome: () => fired.push('goHome'),
    findDuplicates: () => fired.push('findDuplicates'),
    showSettingsModal: () => fired.push('showSettingsModal'),
    showShortcutsModal: () => fired.push('showShortcutsModal'),
    selectAll: () => fired.push('selectAll'),
    copyToClipboard: () => fired.push('copyToClipboard'),
    cutToClipboard: () => fired.push('cutToClipboard'),
    pasteFromClipboard: () => fired.push('pasteFromClipboard'),
    deleteSelected: () => fired.push('deleteSelected'),
    renameSelected: () => fired.push('renameSelected'),
    setViewMode: (mode) => fired.push(`setViewMode:${mode}`),
    addNewTab: () => fired.push('addNewTab'),
  };
  const palette = createCommandPaletteController({
    activateModal: noop,
    deactivateModal: noop,
    showToast: noop,
    getShortcutBinding: () => undefined,
    fixedShortcuts: {},
    remappableCommandIds: new Set(),
    formatShortcutKeyLabel: (key) => key,
    getTabsEnabled: () => true,
    twemojiImg,
    actions,
  });
  palette.initCommandPalette();
  palette.showCommandPalette();
  const modal = document.getElementById('command-palette-modal');
  const input = document.getElementById('command-palette-input');
  assert(
    modal.style.display === 'flex' && input,
    'command-palette-and-bookmarks: palette did not open'
  );

  input.value = 'duplicate';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  const items = Array.from(
    document.querySelectorAll('#command-palette-results .command-palette-item')
  );
  assert(items.length >= 1, 'command-palette-and-bookmarks: query matched no commands');
  const matchedCommandTitles = items.map((item) => textOf(item, '.command-palette-item-title'));
  assert(
    matchedCommandTitles.includes('Copy'),
    `command-palette-and-bookmarks: matched ${matchedCommandTitles.join(',')}`
  );
  input.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  );
  await frame();
  assert(fired.length === 1, `command-palette-and-bookmarks: executed ${JSON.stringify(fired)}`);
  const executedCommandId = fired[0];
  assert(
    modal.style.display === 'none',
    'command-palette-and-bookmarks: palette did not close after execution'
  );

  const settings = { bookmarks: [] };
  const bookmarksList = document.getElementById('bookmarks-list');
  const bookmarks = createBookmarksController({
    bookmarksList,
    getCurrentPath: () => '/workspace/alpha',
    getCurrentSettings: () => settings,
    saveSettingsWithTimestamp: async () => ({ success: true }),
    showToast: noop,
    navigateTo: noop,
    getDraggedPaths: async () => [],
    getDragOperation: () => 'copy',
    handleDrop: async () => false,
    showDropIndicator: noop,
    hideDropIndicator: noop,
    consumeEvent: noop,
    renderHomeBookmarks: noop,
  });
  await bookmarks.addBookmark();
  await bookmarks.addBookmarkByPath('/workspace/beta');
  const bookmarksAdded = bookmarksList.querySelectorAll('.bookmark-item').length;
  assert(bookmarksAdded === 2, `command-palette-and-bookmarks: added ${bookmarksAdded} bookmarks`);
  const removeButton = bookmarksList.querySelector('.bookmark-item .bookmark-remove');
  assert(removeButton, 'command-palette-and-bookmarks: bookmark remove control missing');
  removeButton.click();
  await waitFor(
    () => bookmarksList.querySelectorAll('.bookmark-item').length === 1,
    'command-palette-and-bookmarks: removing a bookmark did not update the list'
  );
  const bookmarksRemaining = bookmarksList.querySelectorAll('.bookmark-item').length;
  assert(
    settings.bookmarks.length === bookmarksRemaining,
    'command-palette-and-bookmarks: bookmark state and DOM diverged'
  );
  results.push({
    mode: 'command-palette-and-bookmarks',
    matchedCommands: matchedCommandTitles.length,
    matchedCommandTitles: matchedCommandTitles.join(', '),
    executedCommand: true,
    executedCommandId,
    bookmarksAdded,
    bookmarksRemaining,
  });
}

async function runPreviewsMarkdownSuite(results) {
  document.body.innerHTML = `
    <div class="preview-panel" id="preview-panel" style="display:none">
      <button id="preview-toggle-btn" type="button" aria-controls="preview-panel"></button>
      <button id="preview-close" type="button"></button>
      <div class="preview-content" id="preview-content"></div>
    </div>
    <div class="modal-overlay" id="quicklook-modal" style="display:none">
      <h3 id="quicklook-title"></h3>
      <div id="quicklook-content"></div>
      <span id="quicklook-info"></span>
      <button id="quicklook-close" type="button"></button>
      <button id="quicklook-open" type="button"></button>
    </div>
  `;
  const markdownSource = [
    '# Smoke Heading',
    '',
    'Paragraph with `inline code`.',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    '[safe link](https://example.com/docs)',
    '',
    '<script>window.__xss = 1;</script>',
    '<img src=x onerror="window.__xss = 1">',
    '<a href="javascript:window.__xss = 1">bad</a>',
  ].join('\n');
  window.__xss = undefined;
  window.tauriAPI.readFileContent = async () => ({
    success: true,
    content: markdownSource,
    isTruncated: false,
  });
  window.tauriAPI.getItemProperties = async (path) => ({
    success: true,
    properties: {
      path,
      name: 'notes.md',
      size: markdownSource.length,
      isDirectory: false,
      isFile: true,
      created: new Date('2025-01-01T00:00:00Z'),
      modified: new Date('2025-01-01T00:00:00Z'),
      accessed: new Date('2025-01-01T00:00:00Z'),
    },
  });
  const previewFile = fixtureItem({
    name: 'notes.md',
    path: '/workspace/notes.md',
    size: markdownSource.length,
  });
  const settings = { maxPreviewSizeMB: 50, enableSyntaxHighlighting: false, autoPlayVideos: false };
  const preview = createPreviewController({
    getSelectedItems: () => new Set([previewFile.path]),
    getFileByPath: (path) => (path === previewFile.path ? previewFile : undefined),
    getCurrentSettings: () => settings,
    formatFileSize: (size) => `${size} B`,
    getFileExtension: (name) => name.split('.').pop()?.toLowerCase() ?? '',
    getFileIcon: () => '',
    openFileEntry: noop,
    openExternal: noop,
    showToast: noop,
  });
  preview.initPreviewUi();
  preview.togglePreviewPanel();
  const panel = document.getElementById('preview-panel');
  assert(panel.style.display === 'flex', 'previews-and-markdown: preview panel did not open');
  await waitFor(
    () => document.querySelector('#preview-content .preview-markdown h1'),
    'previews-and-markdown: controller never rendered the markdown preview'
  );
  const previewContent = document.getElementById('preview-content');

  const xssBlocked = window.__xss === undefined;
  assert(xssBlocked, 'previews-and-markdown: XSS payload executed');
  assert(
    previewContent.querySelectorAll('script').length === 0,
    'previews-and-markdown: script element survived sanitization'
  );
  assert(
    previewContent.querySelectorAll('[onerror]').length === 0,
    'previews-and-markdown: onerror attribute survived sanitization'
  );
  const linkHrefs = Array.from(previewContent.querySelectorAll('a')).map(
    (link) => link.getAttribute('href') ?? ''
  );
  assert(
    linkHrefs.every((href) => !/^\s*javascript:/i.test(href)),
    `previews-and-markdown: javascript: link survived (${linkHrefs.join(', ')})`
  );
  assert(
    textOf(previewContent, '.preview-markdown h1') === 'Smoke Heading',
    'previews-and-markdown: heading did not render'
  );
  const codeBlock = previewContent.querySelector('.preview-markdown pre code');
  assert(
    codeBlock && codeBlock.textContent.includes('const answer = 42;'),
    'previews-and-markdown: fenced code block did not render'
  );
  assert(
    previewContent.querySelector('.preview-markdown a')?.getAttribute('href') ===
      'https://example.com/docs',
    'previews-and-markdown: safe https link did not render'
  );

  // Exercise the loader and sanitizer directly as well, mirroring how any
  // caller would render markdown outside the preview controller.
  const markedModule = await loadMarked();
  assert(
    markedModule && typeof markedModule.marked.parse === 'function',
    'previews-and-markdown: marked loader unavailable'
  );
  const directHtml = await sanitizeMarkdownHtml(
    markedModule.marked.parse(markdownSource, { async: false, breaks: true })
  );
  const probe = document.createElement('div');
  probe.innerHTML = directHtml;
  assert(
    probe.querySelectorAll('script, [onerror]').length === 0,
    'previews-and-markdown: direct sanitize left active content'
  );
  assert(
    textOf(probe, 'h1') === 'Smoke Heading',
    'previews-and-markdown: direct render lost heading'
  );
  assert(
    !/javascript:/i.test(directHtml),
    'previews-and-markdown: direct sanitize kept a javascript: URL'
  );

  document.getElementById('preview-close').click();
  await waitFor(
    () => panel.style.display === 'none',
    'previews-and-markdown: close button did not hide the panel'
  );
  results.push({
    mode: 'previews-and-markdown',
    markdownRendered: true,
    xssBlocked: true,
  });
}

async function runOperationsModalsSuite(results) {
  document.body.innerHTML = `
    <div id="progress-panel" class="progress-panel" role="region" style="display:none">
      <button id="progress-panel-close" type="button"></button>
      <span id="progress-panel-count"></span>
      <div id="progress-panel-content"></div>
    </div>
    <div class="modal-overlay" id="batch-rename-modal" style="display:none">
      <select id="batch-rename-mode" class="settings-select">
        <option value="find-replace">Find &amp; Replace</option>
        <option value="sequential">Sequential</option>
        <option value="extension">Extension</option>
      </select>
      <div id="batch-rename-fields-find-replace">
        <input id="batch-rename-find" />
        <input id="batch-rename-replace" />
        <input type="checkbox" id="batch-rename-use-regex" />
      </div>
      <div id="batch-rename-fields-sequential" style="display:none">
        <input id="batch-rename-prefix" />
        <input id="batch-rename-start" type="number" />
      </div>
      <div id="batch-rename-fields-extension" style="display:none">
        <input id="batch-rename-new-ext" />
      </div>
      <div class="batch-rename-preview-list" id="batch-rename-preview-list"></div>
      <button id="batch-rename-close" type="button"></button>
      <button id="batch-rename-cancel" type="button"></button>
      <button id="batch-rename-apply" type="button"></button>
    </div>
  `;
  const panelState = { collapsed: false };
  const cancelledIds = [];
  const queue = createOperationQueueController({
    cancelArchiveOperation: async () => ({ success: true }),
    cancelChecksumCalculation: async () => ({ success: true }),
    cancelFileOperation: async (id) => {
      cancelledIds.push(id);
      return { success: true };
    },
    getOperationPanelCollapsed: () => panelState.collapsed,
    setOperationPanelCollapsed: (collapsed) => {
      panelState.collapsed = collapsed;
    },
  });

  queue.addOperation('op-copy', 'copy', 'Copy items', { cancellable: true, total: 10 });
  queue.updateOperation('op-copy', { current: 4, total: 10, currentFile: 'file-04.txt' });
  await waitFor(
    () => document.querySelector('#progress-panel-content .operation-queue-cancel'),
    'operations-and-modals: operation card never rendered a cancel button'
  );
  document.querySelector('#progress-panel-content .operation-queue-cancel').click();
  await waitFor(
    () => queue.isOperationCancelling('op-copy'),
    'operations-and-modals: cancel click did not move the operation to cancelling'
  );
  const queueCancelled =
    queue.isOperationCancelling('op-copy') && cancelledIds.join(',') === 'op-copy';
  queue.completeOperation('op-copy', 'done');
  queue.addOperation('op-delete', 'delete', 'Delete items', { total: 3 });
  queue.updateOperation('op-delete', { current: 1, total: 3 });
  queue.completeOperation('op-delete', 'failed', 'Permission denied');
  await waitFor(
    () => document.querySelector('#progress-panel-content .operation-queue-item.is-failed'),
    'operations-and-modals: failed operation card never rendered'
  );
  assert(
    document.getElementById('progress-panel').style.display === 'flex',
    'operations-and-modals: failure did not reveal the progress panel'
  );
  assert(
    textOf(
      document.querySelector('#progress-panel-content .operation-queue-item.is-failed'),
      '.operation-queue-file'
    ) === 'Permission denied',
    'operations-and-modals: failure reason missing from the card'
  );

  const renameItems = [
    { name: 'file-alpha.txt', path: '/workspace/file-alpha.txt', isDirectory: false },
    { name: 'file-beta.txt', path: '/workspace/file-beta.txt', isDirectory: false },
    { name: 'file-gamma.txt', path: '/workspace/file-gamma.txt', isDirectory: false },
  ];
  const renameSelected = new Set(renameItems.map((item) => item.path));
  const batchRenameCalls = [];
  window.tauriAPI.batchRename = async (entries) => {
    batchRenameCalls.push(entries);
    return { success: true };
  };
  const batchRename = createBatchRenameController({
    getSelectedItems: () => renameSelected,
    getAllFiles: () => renameItems,
    showToast: noop,
    activateModal: noop,
    deactivateModal: noop,
    refresh: noop,
    updateUndoRedoState: async () => {},
    showConfirm: async () => true,
  });
  batchRename.initListeners();
  batchRename.showBatchRenameModal();
  const modal = document.getElementById('batch-rename-modal');
  assert(modal.style.display === 'flex', 'operations-and-modals: batch rename modal did not open');
  const findInput = document.getElementById('batch-rename-find');
  const replaceInput = document.getElementById('batch-rename-replace');
  findInput.value = 'file';
  replaceInput.value = 'doc';
  findInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  replaceInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  const previewList = document.getElementById('batch-rename-preview-list');
  const previewNames = Array.from(previewList.querySelectorAll('.batch-rename-preview-new')).map(
    (element) => element.textContent.trim()
  );
  assert(
    previewNames.join(',') === 'doc-alpha.txt,doc-beta.txt,doc-gamma.txt',
    `operations-and-modals: preview showed ${previewNames.join(',')}`
  );
  document.getElementById('batch-rename-apply').click();
  await waitFor(
    () => batchRenameCalls.length === 1 && modal.style.display === 'none',
    'operations-and-modals: applying the batch rename did not complete'
  );
  const batchRenamedCount = batchRenameCalls[0].length;
  assert(
    batchRenamedCount === 3 &&
      batchRenameCalls[0].every((entry) => entry.newName.startsWith('doc-')),
    `operations-and-modals: batch rename payload was ${JSON.stringify(batchRenameCalls[0])}`
  );
  results.push({
    mode: 'operations-and-modals',
    queueCancelled,
    batchRenamedCount,
  });
}

function thumbnailDataUrl(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="${color}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function createThumbnailRow(item, thumbnailType = 'image') {
  const row = document.createElement('div');
  row.className = 'file-item has-thumbnail';
  row.dataset.path = item.path;
  row.dataset.thumbnailType = thumbnailType;
  const icon = document.createElement('div');
  icon.className = 'file-icon';
  row.append(icon);
  document.body.append(row);
  return row;
}

async function readThumbnailPixel(row, expected, message) {
  await waitFor(() => {
    const image = row.querySelector('img.file-thumbnail');
    return image?.complete && image.naturalWidth > 0;
  }, `${message}: image did not decode`);
  const image = row.querySelector('img.file-thumbnail');
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext('2d');
  assert(context, `${message}: canvas context unavailable`);
  context.drawImage(image, 0, 0, 2, 2);
  const pixel = Array.from(context.getImageData(1, 1, 1, 1).data).slice(0, 3);
  assert(
    pixel.every((channel, index) => Math.abs(channel - expected[index]) <= 2),
    `${message}: expected pixel ${expected.join(',')}, received ${pixel.join(',')}`
  );
  return pixel;
}

function makeThumbnailController(itemsByPath, settings) {
  return createThumbnailController({
    getCurrentSettings: () => settings,
    getFileIcon: () => '<span class="thumbnail-fallback">file</span>',
    getFileExtension: (name) => name.split('.').pop()?.toLowerCase() || '',
    formatFileSize: (bytes) => `${bytes} bytes`,
    getFileByPath: (filePath) => itemsByPath.get(filePath),
  });
}

async function runThumbnailFingerprintSuite(results) {
  document.body.innerHTML = '';
  const settings = {
    thumbnailQuality: 'medium',
    maxThumbnailSizeMB: 20,
    maxPreviewSizeMB: 100,
  };
  const itemV1 = fixtureItem({
    name: 'photo.jpg',
    path: '/fixture/photo.jpg',
    size: 100,
    modified: new Date('2025-01-01T00:00:00Z'),
  });
  const itemV2 = {
    ...itemV1,
    size: 101,
    modified: new Date('2025-01-01T00:00:01Z'),
  };
  const itemsByPath = new Map([[itemV1.path, itemV1]]);
  const cacheCalls = [];
  const expectedResponses = [
    {
      mtime: itemV1.modified.getTime(),
      size: itemV1.size,
      variant: 'v1:medium:image',
      color: '#ff0000',
    },
    {
      mtime: itemV2.modified.getTime(),
      size: itemV2.size,
      variant: 'v1:medium:image',
      color: '#00ff00',
    },
    {
      mtime: itemV2.modified.getTime(),
      size: itemV2.size,
      variant: 'v1:high:image',
      color: '#0000ff',
    },
    {
      mtime: itemV2.modified.getTime(),
      size: itemV2.size,
      variant: 'v1:high:raw',
      color: '#ffff00',
    },
  ];
  window.tauriAPI.getCachedThumbnail = async (filePath, mtime, size, variant) => {
    cacheCalls.push({ filePath, mtime, size, variant });
    const expected = expectedResponses.shift();
    assert(expected, `thumbnails: unexpected cache lookup ${variant}`);
    assert(filePath === itemV1.path, `thumbnails: unexpected path ${filePath}`);
    assert(
      mtime === expected.mtime && size === expected.size && variant === expected.variant,
      `thumbnails: lookup fingerprint mismatch ${JSON.stringify({ mtime, size, variant })}`
    );
    return { success: true, dataUrl: thumbnailDataUrl(expected.color) };
  };
  window.tauriAPI.saveCachedThumbnail = async () => ({ success: true });

  const controller = makeThumbnailController(itemsByPath, settings);
  const row = createThumbnailRow(itemV1);
  controller.loadThumbnail(row, itemV1);
  await readThumbnailPixel(row, [255, 0, 0], 'thumbnails: initial image');

  itemsByPath.set(itemV2.path, itemV2);
  controller.loadThumbnail(row, itemV2);
  await readThumbnailPixel(row, [0, 255, 0], 'thumbnails: changed file fingerprint');

  settings.thumbnailQuality = 'high';
  controller.loadThumbnail(row, itemV2);
  await readThumbnailPixel(row, [0, 0, 255], 'thumbnails: changed quality variant');

  row.dataset.thumbnailType = 'raw';
  controller.loadThumbnail(row, itemV2);
  await readThumbnailPixel(row, [255, 255, 0], 'thumbnails: changed type variant');
  assert(expectedResponses.length === 0, 'thumbnails: not all variant lookups ran');
  controller.destroy();

  document.body.innerHTML = '';
  const sharedItem = fixtureItem({
    name: 'shared.jpg',
    path: '/fixture/shared.jpg',
    size: 200,
    modified: new Date('2025-01-01T00:00:02Z'),
  });
  const sharedItems = new Map([[sharedItem.path, sharedItem]]);
  let releaseSharedLookup;
  const sharedLookup = new Promise((resolve) => {
    releaseSharedLookup = resolve;
  });
  const sharedCalls = [];
  window.tauriAPI.getCachedThumbnail = (...args) => {
    sharedCalls.push(args);
    return sharedLookup;
  };
  const sharedController = makeThumbnailController(sharedItems, settings);
  const firstRow = createThumbnailRow(sharedItem);
  const secondRow = createThumbnailRow(sharedItem);
  sharedController.loadThumbnail(firstRow, sharedItem);
  sharedController.loadThumbnail(secondRow, sharedItem);
  await Promise.resolve();
  await Promise.resolve();
  assert(sharedCalls.length === 1, `thumbnails: identical work used ${sharedCalls.length} lookups`);
  releaseSharedLookup({ success: true, dataUrl: thumbnailDataUrl('#ff00ff') });
  await readThumbnailPixel(firstRow, [255, 0, 255], 'thumbnails: first shared row');
  await readThumbnailPixel(secondRow, [255, 0, 255], 'thumbnails: second shared row');
  sharedController.destroy();

  document.body.innerHTML = '';
  const oldItem = fixtureItem({
    name: 'old.jpg',
    path: '/fixture/old.jpg',
    size: 300,
    modified: new Date('2025-01-01T00:00:03Z'),
  });
  const newItem = fixtureItem({
    name: 'new.jpg',
    path: '/fixture/new.jpg',
    size: 400,
    modified: new Date('2025-01-01T00:00:04Z'),
  });
  const reusedItems = new Map([
    [oldItem.path, oldItem],
    [newItem.path, newItem],
  ]);
  let releaseOldLookup;
  const oldLookup = new Promise((resolve) => {
    releaseOldLookup = resolve;
  });
  window.tauriAPI.getCachedThumbnail = (filePath) =>
    filePath === oldItem.path
      ? oldLookup
      : Promise.resolve({ success: true, dataUrl: thumbnailDataUrl('#00ffff') });
  const reusedController = makeThumbnailController(reusedItems, settings);
  const reusedRow = createThumbnailRow(oldItem);
  reusedController.loadThumbnail(reusedRow, oldItem);
  reusedRow.dataset.path = newItem.path;
  reusedController.loadThumbnail(reusedRow, newItem);
  await readThumbnailPixel(reusedRow, [0, 255, 255], 'thumbnails: replacement row');
  releaseOldLookup({ success: true, dataUrl: thumbnailDataUrl('#ff8800') });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await readThumbnailPixel(reusedRow, [0, 255, 255], 'thumbnails: stale completion guard');
  assert(
    reusedRow.querySelector('img.file-thumbnail')?.getAttribute('src') ===
      thumbnailDataUrl('#00ffff'),
    'thumbnails: old request replaced the current row image'
  );
  reusedController.destroy();

  results.push({
    mode: 'thumbnails-fingerprint-and-inflight',
    fingerprintLookups: cacheCalls.length,
    variants: ['v1:medium:image', 'v1:high:image', 'v1:high:raw'],
    identicalWorkLookups: sharedCalls.length,
    staleCompletionBlocked: true,
  });
}

async function runArchiveWhitespacePasswordSuite(results) {
  document.body.innerHTML = `
    <div id="extract-modal" style="display:none">
      <div id="extract-modal-message"></div>
      <label id="extract-password-field"><input id="extract-password" type="password" /></label>
      <input id="extract-destination-input" />
      <div id="extract-preview-path"></div>
    </div>
  `;
  const extractCalls = [];
  window.tauriAPI.onExtractProgress = () => noop;
  window.tauriAPI.extractArchive = async (...args) => {
    extractCalls.push(args);
    return { success: true };
  };
  const controller = createCompressExtractController({
    getCurrentPath: () => '/fixture',
    getSelectedItems: () => new Set(),
    getAllFiles: () => [],
    showToast: noop,
    showConfirm: async () => true,
    navigateTo: async () => {},
    activateModal: noop,
    deactivateModal: noop,
    addToRecentFiles: noop,
    generateOperationId: () => 'extract-whitespace-e2e',
    addOperation: noop,
    getOperation: () => ({ aborted: false }),
    updateOperation: noop,
    completeOperation: noop,
    removeOperation: noop,
    isWindowsPlatform: () => false,
  });
  controller.showExtractModal('/fixture/archive.zip');
  const password = ' \t ';
  document.getElementById('extract-password').value = password;
  await controller.confirmExtractModal();
  assert(extractCalls.length === 1, 'archive-password: extraction IPC was not called');
  assert(
    extractCalls[0][3] === password,
    `archive-password: whitespace changed (${JSON.stringify(extractCalls[0][3])})`
  );
  results.push({ mode: 'archive-whitespace-password', exactWhitespacePreserved: true });
}

async function runOperationQueueLifetimeSuite(results) {
  document.body.innerHTML = `
    <div id="progress-panel" class="progress-panel" role="region" style="display:none">
      <button id="progress-panel-close" type="button"></button>
      <span id="progress-panel-count"></span>
      <div id="progress-panel-content"></div>
    </div>
  `;
  const panelState = { collapsed: false };
  let retryCount = 0;
  const queue = createOperationQueueController({
    cancelArchiveOperation: async () => ({ success: true }),
    cancelChecksumCalculation: async () => ({ success: true }),
    getOperationPanelCollapsed: () => panelState.collapsed,
    setOperationPanelCollapsed: (collapsed) => {
      panelState.collapsed = collapsed;
    },
  });
  queue.addOperation('e2e-done', 'copy', 'Completed item');
  queue.completeOperation('e2e-done', 'done');
  queue.addOperation('e2e-failed', 'delete', 'Failed item', { retry: () => (retryCount += 1) });
  queue.completeOperation('e2e-failed', 'failed', 'Fixture failure');
  await waitFor(
    () => document.querySelector('#progress-panel-content .operation-queue-item.is-failed'),
    'operation-queue-lifetime: failed card never rendered'
  );
  await new Promise((resolve) => setTimeout(resolve, 4250));
  await frame();
  const failedCard = document.querySelector(
    '#progress-panel-content .operation-queue-item.is-failed'
  );
  assert(failedCard, 'operation-queue-lifetime: failed card disappeared after four seconds');
  assert(
    !queue.getOperation('e2e-done'),
    'operation-queue-lifetime: successful card did not expire after four seconds'
  );
  const retryButton = failedCard.querySelector('.operation-queue-retry');
  assert(retryButton, 'operation-queue-lifetime: failed card has no retry action');
  retryButton.click();
  assert(retryCount === 1, 'operation-queue-lifetime: retry action was not invoked');
  assert(!queue.getOperation('e2e-failed'), 'operation-queue-lifetime: retry did not dismiss card');
  queue.cleanup();
  results.push({
    mode: 'operation-queue-lifetime',
    failedVisibleAfterMs: 4250,
    doneExpired: true,
    retryDismissedFailure: true,
  });
}

// The bundle can execute while the parser is still running (inside <head> or
// before the implicit body exists), so every suite must wait for the body.
const documentReady = () =>
  new Promise((resolve) => {
    if (document.body) {
      resolve();
      return;
    }
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });

globalThis.runFileRenderSmoke = async () => {
  await documentReady();
  installTauriApi();
  const results = [];
  globalThis.fileRenderSmokeResults = results;
  await runVirtualizationSuite(results);
  await runDualPaneSuite(results);
  await runColumnViewSuite(results);
  await runSearchSuite(results);
  await runTabsNavigationSuite(results);
  await runSelectionSortSuite(results);
  await runCommandPaletteBookmarksSuite(results);
  await runPreviewsMarkdownSuite(results);
  await runOperationsModalsSuite(results);
  await runThumbnailFingerprintSuite(results);
  await runArchiveWhitespacePasswordSuite(results);
  await runOperationQueueLifetimeSuite(results);
  return results;
};
