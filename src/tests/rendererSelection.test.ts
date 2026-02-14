// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FileItem } from '../types';
import { createSelectionController } from '../rendererSelection';

function createMockDeps() {
  const selectedItems = new Set<string>();

  return {
    getSelectedItems: () => selectedItems,
    setSelectedItems: (items: Set<string>) => {
      selectedItems.clear();
      for (const i of items) selectedItems.add(i);
    },
    updateStatusBar: vi.fn(),
    isPreviewVisible: vi.fn().mockReturnValue(false),
    updatePreview: vi.fn(),
    clearPreview: vi.fn(),
    getFileByPath: vi.fn().mockReturnValue(undefined),
    getViewMode: vi.fn().mockReturnValue('grid' as const),
    getFileGrid: vi.fn(() => document.getElementById('file-grid')),
    openFileEntry: vi.fn(),
    _selectedItems: selectedItems,
  };
}

function addFileItems(paths: string[]): HTMLElement[] {
  const container = document.getElementById('file-view')!;
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

describe('createSelectionController', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="file-view">
        <div id="file-grid" style="display:grid;grid-template-columns:repeat(3, 1fr)"></div>
      </div>
      <div id="selection-rect"></div>
    `;
  });

  describe('toggleSelection', () => {
    it('selects an unselected item', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      const [item] = addFileItems(['/test/file.txt']);

      ctrl.toggleSelection(item);

      expect(item.classList.contains('selected')).toBe(true);
      expect(deps._selectedItems.has('/test/file.txt')).toBe(true);
      expect(deps.updateStatusBar).toHaveBeenCalled();
    });

    it('deselects a selected item', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      const [item] = addFileItems(['/test/file.txt']);

      ctrl.toggleSelection(item);
      ctrl.toggleSelection(item);

      expect(item.classList.contains('selected')).toBe(false);
      expect(deps._selectedItems.has('/test/file.txt')).toBe(false);
    });

    it('updates aria-selected attribute', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      const [item] = addFileItems(['/test/file.txt']);

      ctrl.toggleSelection(item);
      expect(item.getAttribute('aria-selected')).toBe('true');

      ctrl.toggleSelection(item);
      expect(item.getAttribute('aria-selected')).toBe('false');
    });

    it('triggers preview update when single item selected and preview visible', () => {
      const deps = createMockDeps();
      deps.isPreviewVisible.mockReturnValue(true);
      const mockFile = { name: 'file.txt', isFile: true } as FileItem;
      deps.getFileByPath.mockReturnValue(mockFile);
      const ctrl = createSelectionController(deps);
      const [item] = addFileItems(['/test/file.txt']);

      ctrl.toggleSelection(item);

      expect(deps.updatePreview).toHaveBeenCalledWith(mockFile);
    });

    it('clears preview when multiple items selected', () => {
      const deps = createMockDeps();
      deps.isPreviewVisible.mockReturnValue(true);
      const ctrl = createSelectionController(deps);
      const items = addFileItems(['/a', '/b']);

      ctrl.toggleSelection(items[0]);
      ctrl.toggleSelection(items[1]);

      expect(deps.clearPreview).toHaveBeenCalled();
    });

    it('ignores items without data-path', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      const el = document.createElement('div');
      el.className = 'file-item';

      ctrl.toggleSelection(el);
      expect(deps._selectedItems.size).toBe(0);
    });
  });

  describe('clearSelection', () => {
    it('clears all selected items', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      const items = addFileItems(['/a', '/b', '/c']);

      ctrl.toggleSelection(items[0]);
      ctrl.toggleSelection(items[1]);
      ctrl.clearSelection();

      expect(deps._selectedItems.size).toBe(0);
      expect(items[0].classList.contains('selected')).toBe(false);
      expect(items[1].classList.contains('selected')).toBe(false);
    });

    it('clears preview when visible', () => {
      const deps = createMockDeps();
      deps.isPreviewVisible.mockReturnValue(true);
      const ctrl = createSelectionController(deps);
      const items = addFileItems(['/a']);

      ctrl.toggleSelection(items[0]);
      ctrl.clearSelection();

      expect(deps.clearPreview).toHaveBeenCalled();
    });
  });

  describe('selectAll', () => {
    it('selects all file items', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      addFileItems(['/a', '/b', '/c']);

      ctrl.selectAll();

      expect(deps._selectedItems.size).toBe(3);
      expect(deps._selectedItems.has('/a')).toBe(true);
      expect(deps._selectedItems.has('/b')).toBe(true);
      expect(deps._selectedItems.has('/c')).toBe(true);
    });

    it('marks all items as aria-selected', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      const items = addFileItems(['/x', '/y']);

      ctrl.selectAll();

      items.forEach((item) => {
        expect(item.getAttribute('aria-selected')).toBe('true');
      });
    });
  });

  describe('openSelectedItem', () => {
    it('opens the file when exactly one item is selected', () => {
      const deps = createMockDeps();
      const mockFile = { name: 'test.txt' } as FileItem;
      deps.getFileByPath.mockReturnValue(mockFile);
      const ctrl = createSelectionController(deps);
      const [item] = addFileItems(['/test.txt']);

      ctrl.toggleSelection(item);
      ctrl.openSelectedItem();

      expect(deps.openFileEntry).toHaveBeenCalledWith(mockFile);
    });

    it('does nothing when no items selected', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      addFileItems(['/a']);

      ctrl.openSelectedItem();
      expect(deps.openFileEntry).not.toHaveBeenCalled();
    });

    it('does nothing when multiple items selected', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      const items = addFileItems(['/a', '/b']);

      ctrl.toggleSelection(items[0]);
      ctrl.toggleSelection(items[1]);
      ctrl.openSelectedItem();

      expect(deps.openFileEntry).not.toHaveBeenCalled();
    });
  });

  describe('navigateFileGrid', () => {
    it('navigates right', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      const items = addFileItems(['/a', '/b', '/c']);
      ctrl.toggleSelection(items[0]);

      ctrl.navigateFileGrid('ArrowRight', false);

      expect(deps._selectedItems.has('/b')).toBe(true);
      expect(deps._selectedItems.size).toBe(1);
    });

    it('navigates left', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      const items = addFileItems(['/a', '/b', '/c']);
      ctrl.toggleSelection(items[1]);

      ctrl.navigateFileGrid('ArrowLeft', false);

      expect(deps._selectedItems.has('/a')).toBe(true);
      expect(deps._selectedItems.size).toBe(1);
    });

    it('does not go below 0', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      const items = addFileItems(['/a', '/b']);
      ctrl.toggleSelection(items[0]);

      ctrl.navigateFileGrid('ArrowLeft', false);

      expect(deps._selectedItems.has('/a')).toBe(true);
    });

    it('does not exceed array bounds', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      const items = addFileItems(['/a', '/b']);
      ctrl.toggleSelection(items[1]);

      ctrl.navigateFileGrid('ArrowRight', false);

      expect(deps._selectedItems.has('/b')).toBe(true);
    });

    it('handles empty file list', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);

      ctrl.navigateFileGrid('ArrowRight', false);
      expect(deps._selectedItems.size).toBe(0);
    });
  });

  describe('selectFirstItem', () => {
    it('selects the first item', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      addFileItems(['/a', '/b', '/c']);

      ctrl.selectFirstItem(false);

      expect(deps._selectedItems.has('/a')).toBe(true);
      expect(deps._selectedItems.size).toBe(1);
    });

    it('handles empty file list', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);

      ctrl.selectFirstItem(false);
      expect(deps._selectedItems.size).toBe(0);
    });
  });

  describe('selectLastItem', () => {
    it('selects the last item', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      addFileItems(['/a', '/b', '/c']);

      ctrl.selectLastItem(false);

      expect(deps._selectedItems.has('/c')).toBe(true);
      expect(deps._selectedItems.size).toBe(1);
    });
  });

  describe('isRubberBandActive', () => {
    it('returns false initially', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      expect(ctrl.isRubberBandActive()).toBe(false);
    });
  });

  describe('invalidateGridColumnsCache', () => {
    it('does not throw', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      expect(() => ctrl.invalidateGridColumnsCache()).not.toThrow();
    });
  });

  describe('ensureActiveItem', () => {
    it('sets first item as active when no active item', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);
      const items = addFileItems(['/a', '/b']);

      ctrl.ensureActiveItem();

      expect(items[0].tabIndex).toBe(0);
    });

    it('does nothing with empty file list', () => {
      const deps = createMockDeps();
      const ctrl = createSelectionController(deps);

      expect(() => ctrl.ensureActiveItem()).not.toThrow();
    });
  });
});
