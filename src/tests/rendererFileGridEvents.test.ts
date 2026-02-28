// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileGridEventsController } from '../rendererFileGridEvents';

function createConfig() {
  const fileGrid = document.getElementById('file-grid') as HTMLElement;
  const selectedItems = new Set<string>();
  const item = {
    name: 'test.txt',
    path: '/dest/test.txt',
    isDirectory: false,
    isFile: true,
    size: 1,
    modified: new Date('2025-01-01T00:00:00.000Z'),
    isHidden: false,
  };

  const config = {
    getFileGrid: () => fileGrid,
    getFileItemData: vi.fn().mockReturnValue(item),
    getSelectedItems: () => selectedItems,
    getTabsEnabled: vi.fn().mockReturnValue(true),
    clearSelection: vi.fn(),
    toggleSelection: vi.fn(),
    showContextMenu: vi.fn(),
    openFileEntry: vi.fn().mockResolvedValue(undefined),
    addNewTab: vi.fn(),
    navigateTo: vi.fn().mockResolvedValue(undefined),
    consumeEvent: vi.fn((e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    }),
    getDragOperation: vi.fn().mockReturnValue('move' as const),
    getDraggedPaths: vi.fn().mockResolvedValue([]),
    showDropIndicator: vi.fn(),
    hideDropIndicator: vi.fn(),
    scheduleSpringLoad: vi.fn(),
    clearSpringLoad: vi.fn(),
    handleDrop: vi.fn().mockResolvedValue(undefined),
    setDragData: vi.fn(),
    clearDragData: vi.fn(),
  };

  return { config, fileGrid };
}

describe('createFileGridEventsController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div id="file-grid">
        <div class="file-item" data-path="/dest/test.txt"></div>
      </div>
    `;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('suppresses open when ctrl/cmd multi-select is followed by fast double click', () => {
    const { config, fileGrid } = createConfig();
    const controller = createFileGridEventsController(config);
    controller.setupFileGridEventDelegation();

    const fileItem = fileGrid.querySelector('.file-item') as HTMLElement;
    fileItem.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    fileItem.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(config.openFileEntry).not.toHaveBeenCalled();
  });

  it('opens file after suppression window expires', () => {
    const { config, fileGrid } = createConfig();
    const controller = createFileGridEventsController(config);
    controller.setupFileGridEventDelegation();

    const fileItem = fileGrid.querySelector('.file-item') as HTMLElement;
    fileItem.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    vi.advanceTimersByTime(600);
    fileItem.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(config.openFileEntry).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/dest/test.txt' })
    );
  });
});
