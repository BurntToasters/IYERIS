/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSelectionController } from './rendererSelection';

// jsdom doesn't implement scrollIntoView
HTMLElement.prototype.scrollIntoView = function () {};

function createFileItem(path: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'file-item';
  el.dataset.path = path;
  el.setAttribute('data-path', path);
  el.setAttribute('aria-selected', 'false');
  return el;
}

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

function setupFileItems(count: number): HTMLElement[] {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const items: HTMLElement[] = [];
  for (let i = 0; i < count; i++) {
    const item = createFileItem(`/file${i}.txt`);
    container.appendChild(item);
    items.push(item);
  }
  return items;
}

describe('navigateFileGrid - ArrowUp/ArrowDown', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('ArrowDown moves down by column count in grid mode', () => {
    const deps = createDeps();
    // Simulate 3-column grid
    const originalGetComputedStyle = window.getComputedStyle;
    window.getComputedStyle = vi.fn(() => ({
      getPropertyValue: (prop: string) =>
        prop === 'grid-template-columns' ? '100px 100px 100px' : '',
    })) as unknown as typeof window.getComputedStyle;

    setupFileItems(9);
    const ctrl = createSelectionController(deps as any);
    // Select first item
    ctrl.navigateFileGrid('ArrowRight', false); // index 0 → 1
    ctrl.navigateFileGrid('ArrowDown', false); // index 1 → 1+3=4

    expect(deps.selectedItems.has('/file4.txt')).toBe(true);
    expect(deps.selectedItems.size).toBe(1);

    window.getComputedStyle = originalGetComputedStyle;
  });

  it('ArrowUp moves up by column count', () => {
    const deps = createDeps();
    window.getComputedStyle = vi.fn(() => ({
      getPropertyValue: (prop: string) =>
        prop === 'grid-template-columns' ? '100px 100px 100px' : '',
    })) as unknown as typeof window.getComputedStyle;

    setupFileItems(9);
    const ctrl = createSelectionController(deps as any);
    // Navigate to index 6
    for (let i = 0; i < 6; i++) ctrl.navigateFileGrid('ArrowRight', false);
    // Now go up
    ctrl.navigateFileGrid('ArrowUp', false);

    expect(deps.selectedItems.has('/file3.txt')).toBe(true);
    expect(deps.selectedItems.size).toBe(1);

    window.getComputedStyle = vi.fn(() => ({
      getPropertyValue: () => '',
    })) as unknown as typeof window.getComputedStyle;
  });

  it('ArrowDown does not exceed bounds', () => {
    const deps = createDeps();
    window.getComputedStyle = vi.fn(() => ({
      getPropertyValue: (prop: string) =>
        prop === 'grid-template-columns' ? '100px 100px 100px' : '',
    })) as unknown as typeof window.getComputedStyle;

    setupFileItems(3);
    const ctrl = createSelectionController(deps as any);
    ctrl.navigateFileGrid('ArrowDown', false); // Already at 0, +3 would be out of bounds → stays at 2

    window.getComputedStyle = vi.fn(() => ({
      getPropertyValue: () => '',
    })) as unknown as typeof window.getComputedStyle;
  });
});

describe('navigateFileGrid - shift selection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shift+ArrowRight selects a range', () => {
    const deps = createDeps();
    deps.getViewMode.mockReturnValue('list' as any);
    setupFileItems(5);
    const ctrl = createSelectionController(deps as any);

    ctrl.navigateFileGrid('ArrowRight', false); // select index 1
    ctrl.navigateFileGrid('ArrowRight', true); // shift-select index 2
    ctrl.navigateFileGrid('ArrowRight', true); // shift-select index 3

    // With shift, a range from anchor to current should be selected
    expect(deps.selectedItems.size).toBeGreaterThanOrEqual(2);
  });
});

describe('selectFirstItem with shift', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shift-selects from current to first', () => {
    const deps = createDeps();
    deps.getViewMode.mockReturnValue('list' as any);
    setupFileItems(5);
    const ctrl = createSelectionController(deps as any);

    // Select a middle item first
    ctrl.navigateFileGrid('ArrowRight', false);
    ctrl.navigateFileGrid('ArrowRight', false);
    // Now shift-select to first
    ctrl.selectFirstItem(true);

    expect(deps.selectedItems.has('/file0.txt')).toBe(true);
    expect(deps.selectedItems.size).toBeGreaterThanOrEqual(2);
  });
});

describe('selectLastItem with shift', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shift-selects from current to last', () => {
    const deps = createDeps();
    deps.getViewMode.mockReturnValue('list' as any);
    setupFileItems(5);
    const ctrl = createSelectionController(deps as any);

    // Select first item
    ctrl.navigateFileGrid('ArrowRight', false);
    // Shift-select to last
    ctrl.selectLastItem(true);

    expect(deps.selectedItems.has('/file4.txt')).toBe(true);
    expect(deps.selectedItems.size).toBeGreaterThanOrEqual(2);
  });
});

describe('toggleSelection - preview behavior', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('updates preview when single file selected and preview visible', () => {
    const deps = createDeps();
    deps.isPreviewVisible.mockReturnValue(true);
    setupFileItems(3);
    const ctrl = createSelectionController(deps as any);

    const items = document.querySelectorAll('.file-item');
    ctrl.toggleSelection(items[0] as HTMLElement);

    expect(deps.updatePreview).toHaveBeenCalled();
  });

  it('clears preview when folder selected', () => {
    const deps = createDeps();
    deps.isPreviewVisible.mockReturnValue(true);
    deps.getFileByPath.mockReturnValue({
      name: 'folder',
      path: '/folder',
      isFile: false,
      isDirectory: true,
      size: 0,
      modified: Date.now(),
    });

    setupFileItems(1);
    const ctrl = createSelectionController(deps as any);

    const items = document.querySelectorAll('.file-item');
    ctrl.toggleSelection(items[0] as HTMLElement);

    expect(deps.clearPreview).toHaveBeenCalled();
  });
});

describe('navigateByPage', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does nothing with no file grid', () => {
    const deps = createDeps();
    deps.getFileGrid.mockReturnValue(null as any);
    setupFileItems(10);
    const ctrl = createSelectionController(deps as any);
    expect(() => ctrl.navigateByPage('down', false)).not.toThrow();
  });

  it('does nothing with empty file list', () => {
    const deps = createDeps();
    const ctrl = createSelectionController(deps as any);
    expect(() => ctrl.navigateByPage('up', false)).not.toThrow();
  });
});

describe('getGridColumns cache (via invalidateGridColumnsCache)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('invalidateGridColumnsCache forces recalculation', () => {
    const deps = createDeps();
    deps.getViewMode.mockReturnValue('list' as any);
    setupFileItems(3);
    const ctrl = createSelectionController(deps as any);

    // First navigation uses list mode (1 column)
    ctrl.navigateFileGrid('ArrowRight', false);

    // Invalidate cache and switch to grid mode
    ctrl.invalidateGridColumnsCache();
    deps.getViewMode.mockReturnValue('grid');

    // Should recalculate columns
    ctrl.navigateFileGrid('ArrowRight', false);
    // Test just verifies no crash
  });
});

describe('setupRubberBandSelection', () => {
  it('does not throw when no file-view or selection-rect', () => {
    document.body.innerHTML = '';
    const deps = createDeps();
    const ctrl = createSelectionController(deps as any);
    expect(() => ctrl.setupRubberBandSelection()).not.toThrow();
  });

  it('sets up rubber band elements when DOM present', () => {
    document.body.innerHTML = `
      <div id="file-view"></div>
      <div id="selection-rect"></div>
    `;
    const deps = createDeps();
    const ctrl = createSelectionController(deps as any);
    expect(() => ctrl.setupRubberBandSelection()).not.toThrow();
    expect(ctrl.isRubberBandActive()).toBe(false);
  });
});
