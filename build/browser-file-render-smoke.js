import { createFileRenderController } from '../src/rendererFileRender.ts';
import { createDualPaneController } from '../src/rendererDualPane.ts';
import { createColumnViewController } from '../src/rendererColumnView.ts';
import { createSearchController } from '../src/rendererSearch.ts';
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

globalThis.runFileRenderSmoke = async () => {
  installTauriApi();
  const results = [];
  await runVirtualizationSuite(results);
  await runDualPaneSuite(results);
  await runColumnViewSuite(results);
  await runSearchSuite(results);
  return results;
};
