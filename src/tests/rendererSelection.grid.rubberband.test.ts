// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { createSelectionController } from '../rendererSelection';

HTMLElement.prototype.scrollIntoView = function () {};

const mockRaf = vi.hoisted(() => {
  let rafId = 0;
  let rafCallback: FrameRequestCallback | null = null;
  return {
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      rafCallback = cb;
      return ++rafId;
    },
    cancelAnimationFrame: vi.fn(),
    flushRaf: () => {
      if (rafCallback) {
        rafCallback(performance.now());
        rafCallback = null;
      }
    },
    getRafCallback: () => rafCallback,
  };
});

function createDeps() {
  const selectedItems = new Set<string>();
  const fileGrid = document.createElement('div');
  fileGrid.id = 'file-grid';

  return {
    getSelectedItems: vi.fn(() => selectedItems),
    setSelectedItems: vi.fn((items: Set<string>) => {
      selectedItems.clear();
      items.forEach((i) => selectedItems.add(i));
    }),
    updateStatusBar: vi.fn(),
    isPreviewVisible: vi.fn(() => false),
    updatePreview: vi.fn(),
    clearPreview: vi.fn(),
    getFileByPath: vi.fn((p: string) => ({
      name: p.split('/').pop(),
      path: p,
      isFile: true,
      isDirectory: false,
      size: 100,
      modified: Date.now(),
    })),
    getViewMode: vi.fn(() => 'grid' as const),
    getFileGrid: vi.fn(() => fileGrid),
    openFileEntry: vi.fn(),
    selectedItems,
    fileGrid,
  };
}

function setupDOM(): void {
  document.body.innerHTML = `
    <div id="file-view">
      <div id="file-grid" style="display:grid;grid-template-columns:repeat(3,100px)"></div>
    </div>
    <div id="selection-rect"></div>
  `;
}

function addFileItems(paths: string[], parent?: HTMLElement): HTMLElement[] {
  const container = parent ?? document.body;
  return paths.map((p) => {
    const el = document.createElement('div');
    el.className = 'file-item';
    el.dataset.path = p;
    el.setAttribute('data-path', p);
    el.setAttribute('aria-selected', 'false');
    el.tabIndex = -1;
    el.scrollIntoView = vi.fn();
    container.appendChild(el);
    return el;
  });
}

describe('rendererSelection extended2', () => {
  beforeEach(() => {
    setupDOM();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('navigateByPage - actual page navigation', () => {
    it('navigates down by a full page of items', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('list' as any);
      const fileGrid = document.getElementById('file-grid')!;
      deps.getFileGrid.mockReturnValue(fileGrid as any);

      vi.spyOn(fileGrid, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 300,
        height: 240,
        top: 0,
        left: 0,
        right: 300,
        bottom: 240,
        toJSON: () => {},
      });

      const items = addFileItems(Array.from({ length: 20 }, (_, i) => `/file${i}.txt`));
      items.forEach((item) => {
        vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
          x: 0,
          y: 0,
          width: 300,
          height: 22,
          top: 0,
          left: 0,
          right: 300,
          bottom: 22,
          toJSON: () => {},
        });
      });

      const ctrl = createSelectionController(deps as any);

      ctrl.navigateFileGrid('ArrowRight', false);
      expect(deps.selectedItems.has('/file1.txt')).toBe(true);

      ctrl.navigateByPage('down', false);

      expect(deps.selectedItems.size).toBe(1);
      const selected = Array.from(deps.selectedItems)[0];

      expect(selected).not.toBe('/file1.txt');
    });

    it('navigates up by a full page of items', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('list' as any);
      const fileGrid = document.getElementById('file-grid')!;
      deps.getFileGrid.mockReturnValue(fileGrid as any);

      vi.spyOn(fileGrid, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 300,
        height: 240,
        top: 0,
        left: 0,
        right: 300,
        bottom: 240,
        toJSON: () => {},
      });

      const items = addFileItems(Array.from({ length: 20 }, (_, i) => `/file${i}.txt`));
      items.forEach((item) => {
        vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
          x: 0,
          y: 0,
          width: 300,
          height: 22,
          top: 0,
          left: 0,
          right: 300,
          bottom: 22,
          toJSON: () => {},
        });
      });

      const ctrl = createSelectionController(deps as any);

      for (let i = 0; i < 15; i++) ctrl.navigateFileGrid('ArrowRight', false);
      expect(deps.selectedItems.has('/file15.txt')).toBe(true);

      ctrl.navigateByPage('up', false);

      const selected = Array.from(deps.selectedItems)[0];
      expect(selected).not.toBe('/file15.txt');
    });

    it('navigates down with shift key for range selection', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('list' as any);
      const fileGrid = document.getElementById('file-grid')!;
      deps.getFileGrid.mockReturnValue(fileGrid as any);

      vi.spyOn(fileGrid, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 300,
        height: 240,
        top: 0,
        left: 0,
        right: 300,
        bottom: 240,
        toJSON: () => {},
      });

      const items = addFileItems(Array.from({ length: 20 }, (_, i) => `/file${i}.txt`));
      items.forEach((item) => {
        vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
          x: 0,
          y: 0,
          width: 300,
          height: 22,
          top: 0,
          left: 0,
          right: 300,
          bottom: 22,
          toJSON: () => {},
        });
      });

      const ctrl = createSelectionController(deps as any);
      ctrl.navigateFileGrid('ArrowRight', false);

      ctrl.navigateByPage('down', true);

      expect(deps.selectedItems.size).toBeGreaterThan(1);
    });

    it('clamps page-down to last item', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('list' as any);
      const fileGrid = document.getElementById('file-grid')!;
      deps.getFileGrid.mockReturnValue(fileGrid as any);

      vi.spyOn(fileGrid, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 300,
        height: 1000,
        top: 0,
        left: 0,
        right: 300,
        bottom: 1000,
        toJSON: () => {},
      });

      const items = addFileItems(['/a.txt', '/b.txt', '/c.txt']);
      items.forEach((item) => {
        vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
          x: 0,
          y: 0,
          width: 300,
          height: 22,
          top: 0,
          left: 0,
          right: 300,
          bottom: 22,
          toJSON: () => {},
        });
      });

      const ctrl = createSelectionController(deps as any);
      ctrl.selectFirstItem(false);
      ctrl.navigateByPage('down', false);

      expect(deps.selectedItems.has('/c.txt')).toBe(true);
      expect(deps.selectedItems.size).toBe(1);
    });

    it('clamps page-up to first item', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('list' as any);
      const fileGrid = document.getElementById('file-grid')!;
      deps.getFileGrid.mockReturnValue(fileGrid as any);

      vi.spyOn(fileGrid, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 300,
        height: 1000,
        top: 0,
        left: 0,
        right: 300,
        bottom: 1000,
        toJSON: () => {},
      });

      const items = addFileItems(['/a.txt', '/b.txt', '/c.txt']);
      items.forEach((item) => {
        vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
          x: 0,
          y: 0,
          width: 300,
          height: 22,
          top: 0,
          left: 0,
          right: 300,
          bottom: 22,
          toJSON: () => {},
        });
      });

      const ctrl = createSelectionController(deps as any);
      ctrl.selectLastItem(false);
      ctrl.navigateByPage('up', false);

      expect(deps.selectedItems.has('/a.txt')).toBe(true);
      expect(deps.selectedItems.size).toBe(1);
    });

    it('does not move when page size exceeds current position going up', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('list' as any);
      const fileGrid = document.getElementById('file-grid')!;
      deps.getFileGrid.mockReturnValue(fileGrid as any);

      vi.spyOn(fileGrid, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 300,
        height: 500,
        top: 0,
        left: 0,
        right: 300,
        bottom: 500,
        toJSON: () => {},
      });

      const items = addFileItems(['/a.txt', '/b.txt']);
      items.forEach((item) => {
        vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
          x: 0,
          y: 0,
          width: 300,
          height: 22,
          top: 0,
          left: 0,
          right: 300,
          bottom: 22,
          toJSON: () => {},
        });
      });

      const ctrl = createSelectionController(deps as any);
      ctrl.selectFirstItem(false);
      ctrl.navigateByPage('up', false);

      expect(deps.selectedItems.has('/a.txt')).toBe(true);
    });

    it('navigateByPage resolves currentIndex from selected items when lastSelectedIndex is stale', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('list' as any);
      const fileGrid = document.getElementById('file-grid')!;
      deps.getFileGrid.mockReturnValue(fileGrid as any);

      vi.spyOn(fileGrid, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 300,
        height: 100,
        top: 0,
        left: 0,
        right: 300,
        bottom: 100,
        toJSON: () => {},
      });

      const items = addFileItems(Array.from({ length: 10 }, (_, i) => `/file${i}.txt`));
      items.forEach((item) => {
        vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
          x: 0,
          y: 0,
          width: 300,
          height: 22,
          top: 0,
          left: 0,
          right: 300,
          bottom: 22,
          toJSON: () => {},
        });
      });

      const ctrl = createSelectionController(deps as any);

      deps.selectedItems.add('/file5.txt');

      ctrl.navigateByPage('down', false);

      expect(deps.selectedItems.size).toBe(1);
    });

    it('navigateByPage with grid multi-column uses correct page size', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('grid' as any);
      const fileGrid = document.getElementById('file-grid')!;
      deps.getFileGrid.mockReturnValue(fileGrid as any);

      vi.spyOn(fileGrid, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 300,
        height: 100,
        top: 0,
        left: 0,
        right: 300,
        bottom: 100,
        toJSON: () => {},
      });

      const originalGetComputedStyle = window.getComputedStyle;
      window.getComputedStyle = vi.fn(() => ({
        getPropertyValue: (prop: string) =>
          prop === 'grid-template-columns' ? '100px 100px 100px' : '',
      })) as unknown as typeof window.getComputedStyle;

      const items = addFileItems(Array.from({ length: 30 }, (_, i) => `/file${i}.txt`));
      items.forEach((item) => {
        vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
          x: 0,
          y: 0,
          width: 100,
          height: 22,
          top: 0,
          left: 0,
          right: 100,
          bottom: 22,
          toJSON: () => {},
        });
      });

      const ctrl = createSelectionController(deps as any);
      ctrl.selectFirstItem(false);
      ctrl.navigateByPage('down', false);

      expect(deps.selectedItems.size).toBe(1);
      const selected = Array.from(deps.selectedItems)[0];
      expect(selected).not.toBe('/file0.txt');

      window.getComputedStyle = originalGetComputedStyle;
    });
  });

  describe('getGridColumns cache behavior', () => {
    it('returns cached value within 200ms without recomputing', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('grid');
      const fileGrid = document.getElementById('file-grid')!;
      deps.getFileGrid.mockReturnValue(fileGrid as any);

      const getComputedStyleSpy = vi.fn(() => ({
        getPropertyValue: (prop: string) =>
          prop === 'grid-template-columns' ? '100px 100px 100px' : '',
      }));
      const originalGetComputedStyle = window.getComputedStyle;
      window.getComputedStyle = getComputedStyleSpy as unknown as typeof window.getComputedStyle;

      const items = addFileItems(['/a', '/b', '/c', '/d', '/e', '/f']);
      const ctrl = createSelectionController(deps as any);

      ctrl.navigateFileGrid('ArrowDown', false);
      const callCount1 = getComputedStyleSpy.mock.calls.length;

      ctrl.navigateFileGrid('ArrowDown', false);
      const callCount2 = getComputedStyleSpy.mock.calls.length;

      expect(callCount2).toBe(callCount1);

      window.getComputedStyle = originalGetComputedStyle;
    });

    it('returns 1 column for list view mode', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('list' as any);

      const items = addFileItems(['/a', '/b', '/c']);
      const ctrl = createSelectionController(deps as any);

      ctrl.selectFirstItem(false);
      ctrl.navigateFileGrid('ArrowDown', false);

      expect(deps.selectedItems.has('/b')).toBe(true);
      expect(deps.selectedItems.size).toBe(1);
    });

    it('returns 1 when getFileGrid returns null', () => {
      const deps = createDeps();
      deps.getFileGrid.mockReturnValue(null as any);

      const items = addFileItems(['/a', '/b', '/c']);
      const ctrl = createSelectionController(deps as any);

      ctrl.selectFirstItem(false);
      ctrl.navigateFileGrid('ArrowDown', false);

      expect(deps.selectedItems.has('/b')).toBe(true);
    });

    it('returns 1 when grid-template-columns is empty', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('grid');
      const fileGrid = document.getElementById('file-grid')!;
      deps.getFileGrid.mockReturnValue(fileGrid as any);

      const originalGetComputedStyle = window.getComputedStyle;
      window.getComputedStyle = vi.fn(() => ({
        getPropertyValue: () => '',
      })) as unknown as typeof window.getComputedStyle;

      const items = addFileItems(['/a', '/b', '/c']);
      const ctrl = createSelectionController(deps as any);

      ctrl.selectFirstItem(false);
      ctrl.navigateFileGrid('ArrowDown', false);

      expect(deps.selectedItems.has('/b')).toBe(true);

      window.getComputedStyle = originalGetComputedStyle;
    });
  });

  describe('selectItemAtIndex edge cases', () => {
    it('updates preview during navigation when preview is visible', () => {
      const deps = createDeps();
      deps.isPreviewVisible.mockReturnValue(true);

      const items = addFileItems(['/a.txt', '/b.txt', '/c.txt']);
      const ctrl = createSelectionController(deps as any);

      ctrl.navigateFileGrid('ArrowRight', false);

      expect(deps.updatePreview).toHaveBeenCalled();
    });

    it('does not update preview when getFileByPath returns undefined', () => {
      const deps = createDeps();
      deps.isPreviewVisible.mockReturnValue(true);
      deps.getFileByPath.mockReturnValue(undefined as any);

      const items = addFileItems(['/a.txt', '/b.txt']);
      const ctrl = createSelectionController(deps as any);

      ctrl.navigateFileGrid('ArrowRight', false);

      expect(deps.updatePreview).not.toHaveBeenCalled();
    });

    it('shift-select creates range between anchor and target', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('list' as any);

      const items = addFileItems(['/a', '/b', '/c', '/d', '/e']);
      const ctrl = createSelectionController(deps as any);

      ctrl.navigateFileGrid('ArrowRight', false);

      ctrl.navigateFileGrid('ArrowRight', true);

      expect(deps.selectedItems.size).toBe(2);
      expect(deps.selectedItems.has('/b')).toBe(true);
      expect(deps.selectedItems.has('/c')).toBe(true);
    });

    it('does not select when index is out of bounds (handled via navigation clamping)', () => {
      const deps = createDeps();

      const items = addFileItems(['/a']);
      const ctrl = createSelectionController(deps as any);

      ctrl.selectFirstItem(false);

      ctrl.navigateFileGrid('ArrowRight', false);

      expect(deps.selectedItems.has('/a')).toBe(true);
      expect(deps.selectedItems.size).toBe(1);
    });
  });

  describe('navigateFileGrid - currentIndex fallback', () => {
    it('falls back to index 0 when lastSelectedIndex is -1 and no selected items match', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('list' as any);

      const items = addFileItems(['/a', '/b', '/c']);
      const ctrl = createSelectionController(deps as any);

      ctrl.navigateFileGrid('ArrowRight', false);

      expect(deps.selectedItems.has('/b')).toBe(true);
    });

    it('resolves currentIndex from selectedItems when lastSelectedIndex exceeds array length', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('list' as any);

      let items = addFileItems(Array.from({ length: 10 }, (_, i) => `/file${i}.txt`));
      const ctrl = createSelectionController(deps as any);
      ctrl.selectLastItem(false);

      items.forEach((el) => el.remove());
      items = addFileItems(['/new0.txt', '/new1.txt', '/new2.txt']);

      ctrl.navigateFileGrid('ArrowRight', false);

      expect(deps.selectedItems.size).toBe(1);
    });

    it('selects when selectedItems size is 0 even if newIndex equals currentIndex', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('list' as any);

      const items = addFileItems(['/a']);
      const ctrl = createSelectionController(deps as any);

      ctrl.navigateFileGrid('ArrowLeft', false);

      expect(deps.selectedItems.has('/a')).toBe(true);
      expect(deps.selectedItems.size).toBe(1);
    });
  });

  describe('openSelectedItem edge cases', () => {
    it('does not open when getFileByPath returns undefined', () => {
      const deps = createDeps();
      deps.getFileByPath.mockReturnValue(undefined as any);

      const items = addFileItems(['/a.txt']);
      const ctrl = createSelectionController(deps as any);

      ctrl.toggleSelection(items[0]);
      ctrl.openSelectedItem();

      expect(deps.openFileEntry).not.toHaveBeenCalled();
    });
  });

  describe('toggleSelection - preview edge cases', () => {
    it('clears preview when item is deselected leaving 0 selected and preview visible', () => {
      const deps = createDeps();
      deps.isPreviewVisible.mockReturnValue(true);

      const items = addFileItems(['/a.txt']);
      const ctrl = createSelectionController(deps as any);

      ctrl.toggleSelection(items[0]);
      deps.clearPreview.mockClear();
      deps.updatePreview.mockClear();

      ctrl.toggleSelection(items[0]);

      expect(deps.clearPreview).toHaveBeenCalled();
    });

    it('clears preview when file is not found by path (undefined)', () => {
      const deps = createDeps();
      deps.isPreviewVisible.mockReturnValue(true);
      deps.getFileByPath.mockReturnValue(undefined as any);

      const items = addFileItems(['/missing.txt']);
      const ctrl = createSelectionController(deps as any);

      ctrl.toggleSelection(items[0]);

      expect(deps.clearPreview).toHaveBeenCalled();
    });
  });

  describe('ensureActiveItem - active item already in document', () => {
    it('does not change active item when it already exists in the document', () => {
      const deps = createDeps();
      const items = addFileItems(['/a', '/b']);
      const ctrl = createSelectionController(deps as any);

      ctrl.toggleSelection(items[0]);

      ctrl.ensureActiveItem();

      expect(items[0].tabIndex).toBe(0);
    });

    it('resets active item when the previous active item is removed from DOM', () => {
      const deps = createDeps();
      const items = addFileItems(['/a', '/b', '/c']);
      const ctrl = createSelectionController(deps as any);

      ctrl.toggleSelection(items[0]);

      items[0].remove();

      ctrl.ensureActiveItem();

      const remainingItems = document.querySelectorAll('.file-item');
      expect((remainingItems[0] as HTMLElement).tabIndex).toBe(0);
    });
  });

  describe('setActiveItem behavior', () => {
    it('removes tabIndex from previous active item when setting a new one', () => {
      const deps = createDeps();
      const items = addFileItems(['/a', '/b']);
      const ctrl = createSelectionController(deps as any);

      ctrl.toggleSelection(items[0]);
      expect(items[0].tabIndex).toBe(0);

      ctrl.toggleSelection(items[1]);

      expect(items[0].tabIndex).toBe(-1);
      expect(items[1].tabIndex).toBe(0);
    });
  });

  describe('selectFirstItem and selectLastItem - no shift when no prior selection', () => {
    it('selectFirstItem with shift but no prior selection selects only first', () => {
      const deps = createDeps();
      const items = addFileItems(['/a', '/b', '/c']);
      const ctrl = createSelectionController(deps as any);

      ctrl.selectFirstItem(true);

      expect(deps.selectedItems.has('/a')).toBe(true);
    });

    it('selectLastItem with shift but no prior selection selects only last', () => {
      const deps = createDeps();
      const items = addFileItems(['/a', '/b', '/c']);
      const ctrl = createSelectionController(deps as any);

      ctrl.selectLastItem(true);

      expect(deps.selectedItems.has('/c')).toBe(true);
    });
  });

  describe('setupRubberBandSelection - event handlers', () => {
    it('ignores mousedown on a file-item', () => {
      setupDOM();
      const deps = createDeps();
      const fileView = document.getElementById('file-view')!;
      deps.getFileGrid.mockReturnValue(document.getElementById('file-grid') as any);

      const ctrl = createSelectionController(deps as any);
      ctrl.setupRubberBandSelection();

      const fileItem = document.createElement('div');
      fileItem.className = 'file-item';
      fileItem.dataset.path = '/test';
      fileView.appendChild(fileItem);

      const event = new MouseEvent('mousedown', {
        button: 0,
        clientX: 50,
        clientY: 50,
        bubbles: true,
      });
      fileItem.dispatchEvent(event);

      expect(ctrl.isRubberBandActive()).toBe(false);
    });

    it('ignores mousedown on empty-state element', () => {
      setupDOM();
      const deps = createDeps();
      const fileView = document.getElementById('file-view')!;

      const ctrl = createSelectionController(deps as any);
      ctrl.setupRubberBandSelection();

      const emptyState = document.createElement('div');
      emptyState.className = 'empty-state';
      fileView.appendChild(emptyState);

      const event = new MouseEvent('mousedown', {
        button: 0,
        clientX: 50,
        clientY: 50,
        bubbles: true,
      });
      emptyState.dispatchEvent(event);

      expect(ctrl.isRubberBandActive()).toBe(false);
    });

    it('ignores right-click (button !== 0)', () => {
      setupDOM();
      const deps = createDeps();
      const fileView = document.getElementById('file-view')!;

      const ctrl = createSelectionController(deps as any);
      ctrl.setupRubberBandSelection();

      const event = new MouseEvent('mousedown', {
        button: 2,
        clientX: 50,
        clientY: 50,
        bubbles: true,
      });
      fileView.dispatchEvent(event);

      expect(ctrl.isRubberBandActive()).toBe(false);
    });

    it('activates rubber band on valid mousedown on file-view background', () => {
      setupDOM();
      const deps = createDeps();
      const fileView = document.getElementById('file-view')!;

      vi.spyOn(fileView, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 500,
        height: 500,
        top: 0,
        left: 0,
        right: 500,
        bottom: 500,
        toJSON: () => {},
      });
      Object.defineProperty(fileView, 'scrollLeft', { value: 0, writable: true });
      Object.defineProperty(fileView, 'scrollTop', { value: 0, writable: true });

      const ctrl = createSelectionController(deps as any);
      ctrl.setupRubberBandSelection();

      const event = new MouseEvent('mousedown', {
        button: 0,
        clientX: 250,
        clientY: 250,
        bubbles: true,
        cancelable: true,
      });
      fileView.dispatchEvent(event);

      expect(ctrl.isRubberBandActive()).toBe(true);

      const selectionRect = document.getElementById('selection-rect')!;
      expect(selectionRect.classList.contains('active')).toBe(true);
    });

    it('preserves initial selection on shift+mousedown', () => {
      setupDOM();
      const deps = createDeps();
      const fileView = document.getElementById('file-view')!;

      vi.spyOn(fileView, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 500,
        height: 500,
        top: 0,
        left: 0,
        right: 500,
        bottom: 500,
        toJSON: () => {},
      });
      Object.defineProperty(fileView, 'scrollLeft', { value: 0, writable: true });
      Object.defineProperty(fileView, 'scrollTop', { value: 0, writable: true });

      deps.selectedItems.add('/existing.txt');

      const ctrl = createSelectionController(deps as any);
      ctrl.setupRubberBandSelection();

      const event = new MouseEvent('mousedown', {
        button: 0,
        clientX: 250,
        clientY: 250,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      fileView.dispatchEvent(event);

      expect(ctrl.isRubberBandActive()).toBe(true);

      expect(deps.selectedItems.has('/existing.txt')).toBe(true);
    });

    it('clears selection on mousedown without shift', () => {
      setupDOM();
      const deps = createDeps();
      const fileView = document.getElementById('file-view')!;

      vi.spyOn(fileView, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 500,
        height: 500,
        top: 0,
        left: 0,
        right: 500,
        bottom: 500,
        toJSON: () => {},
      });
      Object.defineProperty(fileView, 'scrollLeft', { value: 0, writable: true });
      Object.defineProperty(fileView, 'scrollTop', { value: 0, writable: true });

      const item = document.createElement('div');
      item.className = 'file-item selected';
      item.dataset.path = '/pre.txt';
      item.setAttribute('data-path', '/pre.txt');
      item.setAttribute('aria-selected', 'true');
      fileView.appendChild(item);
      deps.selectedItems.add('/pre.txt');

      const ctrl = createSelectionController(deps as any);
      ctrl.setupRubberBandSelection();

      const event = new MouseEvent('mousedown', {
        button: 0,
        clientX: 400,
        clientY: 400,
        bubbles: true,
        cancelable: true,
      });
      fileView.dispatchEvent(event);

      expect(deps.selectedItems.size).toBe(0);
    });

    it('handles mousemove during active rubber band, updating selection rect', () => {
      setupDOM();
      const deps = createDeps();
      const fileView = document.getElementById('file-view')!;

      vi.spyOn(fileView, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 500,
        height: 500,
        top: 0,
        left: 0,
        right: 500,
        bottom: 500,
        toJSON: () => {},
      });
      Object.defineProperty(fileView, 'scrollLeft', { value: 0, writable: true });
      Object.defineProperty(fileView, 'scrollTop', { value: 0, writable: true });

      const item = document.createElement('div');
      item.className = 'file-item';
      item.dataset.path = '/hit.txt';
      item.setAttribute('data-path', '/hit.txt');
      item.setAttribute('aria-selected', 'false');
      fileView.appendChild(item);
      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        x: 100,
        y: 100,
        width: 80,
        height: 30,
        top: 100,
        left: 100,
        right: 180,
        bottom: 130,
        toJSON: () => {},
      });

      const origRAF = window.requestAnimationFrame;
      window.requestAnimationFrame = (cb: FrameRequestCallback) => {
        cb(performance.now());
        return 1;
      };

      const ctrl = createSelectionController(deps as any);
      ctrl.setupRubberBandSelection();

      fileView.dispatchEvent(
        new MouseEvent('mousedown', {
          button: 0,
          clientX: 50,
          clientY: 50,
          bubbles: true,
          cancelable: true,
        })
      );

      document.dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: 200,
          clientY: 200,
          bubbles: true,
        })
      );

      expect(deps.selectedItems.has('/hit.txt')).toBe(true);

      window.requestAnimationFrame = origRAF;
    });

    it('deselects items that no longer intersect during mousemove', () => {
      setupDOM();
      const deps = createDeps();
      const fileView = document.getElementById('file-view')!;

      vi.spyOn(fileView, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 500,
        height: 500,
        top: 0,
        left: 0,
        right: 500,
        bottom: 500,
        toJSON: () => {},
      });
      Object.defineProperty(fileView, 'scrollLeft', { value: 0, writable: true });
      Object.defineProperty(fileView, 'scrollTop', { value: 0, writable: true });

      const item = document.createElement('div');
      item.className = 'file-item';
      item.dataset.path = '/miss.txt';
      item.setAttribute('data-path', '/miss.txt');
      item.setAttribute('aria-selected', 'false');
      fileView.appendChild(item);
      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        x: 400,
        y: 400,
        width: 50,
        height: 30,
        top: 400,
        left: 400,
        right: 450,
        bottom: 430,
        toJSON: () => {},
      });

      const origRAF = window.requestAnimationFrame;
      window.requestAnimationFrame = (cb: FrameRequestCallback) => {
        cb(performance.now());
        return 1;
      };

      const ctrl = createSelectionController(deps as any);
      ctrl.setupRubberBandSelection();

      fileView.dispatchEvent(
        new MouseEvent('mousedown', {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
          cancelable: true,
        })
      );

      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 50, clientY: 50, bubbles: true })
      );

      expect(deps.selectedItems.has('/miss.txt')).toBe(false);
      expect(item.classList.contains('selected')).toBe(false);

      window.requestAnimationFrame = origRAF;
    });

    it('mouseup deactivates rubber band and cleans up', () => {
      setupDOM();
      const deps = createDeps();
      const fileView = document.getElementById('file-view')!;

      vi.spyOn(fileView, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 500,
        height: 500,
        top: 0,
        left: 0,
        right: 500,
        bottom: 500,
        toJSON: () => {},
      });
      Object.defineProperty(fileView, 'scrollLeft', { value: 0, writable: true });
      Object.defineProperty(fileView, 'scrollTop', { value: 0, writable: true });

      const ctrl = createSelectionController(deps as any);
      ctrl.setupRubberBandSelection();

      fileView.dispatchEvent(
        new MouseEvent('mousedown', {
          button: 0,
          clientX: 50,
          clientY: 50,
          bubbles: true,
          cancelable: true,
        })
      );
      expect(ctrl.isRubberBandActive()).toBe(true);

      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      expect(ctrl.isRubberBandActive()).toBe(false);
      const selectionRect = document.getElementById('selection-rect')!;
      expect(selectionRect.classList.contains('active')).toBe(false);
    });

    it('mouseup when not active does nothing', () => {
      setupDOM();
      const deps = createDeps();

      const ctrl = createSelectionController(deps as any);
      ctrl.setupRubberBandSelection();

      expect(ctrl.isRubberBandActive()).toBe(false);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      expect(ctrl.isRubberBandActive()).toBe(false);
    });

    it('mousemove is ignored when rubber band is not active', () => {
      setupDOM();
      const deps = createDeps();

      const ctrl = createSelectionController(deps as any);
      ctrl.setupRubberBandSelection();

      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 100, clientY: 100, bubbles: true })
      );

      expect(deps.setSelectedItems).not.toHaveBeenCalled();
    });

    it('cancels pending rAF on mouseup', () => {
      setupDOM();
      const deps = createDeps();
      const fileView = document.getElementById('file-view')!;

      vi.spyOn(fileView, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 500,
        height: 500,
        top: 0,
        left: 0,
        right: 500,
        bottom: 500,
        toJSON: () => {},
      });
      Object.defineProperty(fileView, 'scrollLeft', { value: 0, writable: true });
      Object.defineProperty(fileView, 'scrollTop', { value: 0, writable: true });

      let pendingCallback: FrameRequestCallback | null = null;
      const origRAF = window.requestAnimationFrame;
      const origCAF = window.cancelAnimationFrame;
      window.requestAnimationFrame = (cb: FrameRequestCallback) => {
        pendingCallback = cb;
        return 42;
      };
      const cancelSpy = vi.fn();
      window.cancelAnimationFrame = cancelSpy;

      const ctrl = createSelectionController(deps as any);
      ctrl.setupRubberBandSelection();

      fileView.dispatchEvent(
        new MouseEvent('mousedown', {
          button: 0,
          clientX: 50,
          clientY: 50,
          bubbles: true,
          cancelable: true,
        })
      );

      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 100, clientY: 100, bubbles: true })
      );

      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      expect(cancelSpy).toHaveBeenCalledWith(42);

      window.requestAnimationFrame = origRAF;
      window.cancelAnimationFrame = origCAF;
    });

    it('skips mousemove rAF when one is already pending', () => {
      setupDOM();
      const deps = createDeps();
      const fileView = document.getElementById('file-view')!;

      vi.spyOn(fileView, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 500,
        height: 500,
        top: 0,
        left: 0,
        right: 500,
        bottom: 500,
        toJSON: () => {},
      });
      Object.defineProperty(fileView, 'scrollLeft', { value: 0, writable: true });
      Object.defineProperty(fileView, 'scrollTop', { value: 0, writable: true });

      let rafCallCount = 0;
      const origRAF = window.requestAnimationFrame;
      window.requestAnimationFrame = (cb: FrameRequestCallback) => {
        rafCallCount++;
        return rafCallCount;
      };

      const ctrl = createSelectionController(deps as any);
      ctrl.setupRubberBandSelection();

      fileView.dispatchEvent(
        new MouseEvent('mousedown', {
          button: 0,
          clientX: 50,
          clientY: 50,
          bubbles: true,
          cancelable: true,
        })
      );

      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 100, clientY: 100, bubbles: true })
      );
      const afterFirst = rafCallCount;

      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 150, clientY: 150, bubbles: true })
      );
      const afterSecond = rafCallCount;

      expect(afterSecond).toBe(afterFirst);

      window.requestAnimationFrame = origRAF;
    });
  });

  describe('selectAll edge cases', () => {
    it('handles items without data-path attribute gracefully', () => {
      const deps = createDeps();
      const ctrl = createSelectionController(deps as any);

      const el = document.createElement('div');
      el.className = 'file-item';

      document.body.appendChild(el);

      const goodEl = document.createElement('div');
      goodEl.className = 'file-item';
      goodEl.setAttribute('data-path', '/good.txt');
      document.body.appendChild(goodEl);

      ctrl.selectAll();

      expect(deps.selectedItems.has('/good.txt')).toBe(true);
      expect(deps.selectedItems.size).toBe(1);
    });
  });

  describe('clearSelection with preview not visible', () => {
    it('does not call clearPreview when preview is not visible', () => {
      const deps = createDeps();
      deps.isPreviewVisible.mockReturnValue(false);

      const items = addFileItems(['/a', '/b']);
      const ctrl = createSelectionController(deps as any);

      ctrl.toggleSelection(items[0]);
      ctrl.clearSelection();

      expect(deps.clearPreview).not.toHaveBeenCalled();
    });
  });

  describe('navigateByPage - firstItem null guard', () => {
    it('handles case when first item getBoundingClientRect returns zero height', () => {
      const deps = createDeps();
      deps.getViewMode.mockReturnValue('list' as any);
      const fileGrid = document.getElementById('file-grid')!;
      deps.getFileGrid.mockReturnValue(fileGrid as any);

      vi.spyOn(fileGrid, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 300,
        height: 100,
        top: 0,
        left: 0,
        right: 300,
        bottom: 100,
        toJSON: () => {},
      });

      const items = addFileItems(['/a', '/b', '/c']);

      items.forEach((item) => {
        vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
          x: 0,
          y: 0,
          width: 300,
          height: 0,
          top: 0,
          left: 0,
          right: 300,
          bottom: 0,
          toJSON: () => {},
        });
      });

      const ctrl = createSelectionController(deps as any);
      ctrl.selectFirstItem(false);

      expect(() => ctrl.navigateByPage('down', false)).not.toThrow();
    });
  });
});
