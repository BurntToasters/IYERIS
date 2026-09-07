import { createFileRenderController } from '../src/rendererFileRender.ts';
import '../src/css/main.css';

const { document, requestAnimationFrame, performance } = globalThis;
const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

globalThis.runFileRenderSmoke = async () => {
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
  const noop = () => {};
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
  const results = [];
  for (const mode of ['grid', 'list']) {
    grid.classList.toggle('list-view', mode === 'list');
    view.scrollTop = 0;
    const start = performance.now();
    controller.renderFiles(items);
    await frame();
    const firstPaintMs = performance.now() - start;
    let maxMounted = 0;
    for (const index of [0, 7499, 14999, 0]) {
      const item = controller.ensureItemRendered(`/fixture/${index}`);
      await frame();
      assert(item && elements.has(`/fixture/${index}`), `${mode}: item ${index} disappeared`);
      const mounted = grid.querySelectorAll('.file-item').length;
      maxMounted = Math.max(maxMounted, mounted);
      assert(mounted <= 380, `${mode}: mounted ${mounted} entries`);
      const bounds = elements.get(`/fixture/${index}`).getBoundingClientRect();
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
  return results;
};
