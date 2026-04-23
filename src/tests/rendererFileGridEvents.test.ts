// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared.js', () => ({
  devLog: vi.fn(),
}));

import type { FileItem } from '../types';
import { devLog } from '../shared.js';
import { createFileGridEventsController } from '../rendererFileGridEvents';

type DragEventOptions = {
  noDataTransfer?: boolean;
  types?: string[];
  filesLength?: number;
  clientX?: number;
  clientY?: number;
};

type MockDataTransfer = {
  effectAllowed: string;
  dropEffect: string;
  types: string[];
  files: {
    length: number;
  };
  setData: ReturnType<typeof vi.fn>;
  setDragImage: ReturnType<typeof vi.fn>;
};

function createDragEvent(
  type: string,
  options: DragEventOptions = {}
): DragEvent & { dataTransfer: MockDataTransfer | null } {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent & {
    dataTransfer: MockDataTransfer | null;
  };

  Object.defineProperty(event, 'clientX', {
    configurable: true,
    value: options.clientX ?? 30,
  });
  Object.defineProperty(event, 'clientY', {
    configurable: true,
    value: options.clientY ?? 30,
  });

  if (options.noDataTransfer) {
    Object.defineProperty(event, 'dataTransfer', {
      configurable: true,
      value: null,
    });
    return event;
  }

  const files = { length: options.filesLength ?? 0 };
  const dataTransfer = {
    effectAllowed: '',
    dropEffect: 'move',
    types: options.types ?? ['text/plain'],
    files,
    setData: vi.fn(),
    setDragImage: vi.fn(),
  };

  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: dataTransfer,
  });

  return event;
}

function createConfig() {
  const fileGrid = document.getElementById('file-grid') as HTMLElement;
  const selectedItems = new Set<string>();
  const fileItems: Record<string, FileItem> = {
    '/dest/test.txt': {
      name: 'test.txt',
      path: '/dest/test.txt',
      isDirectory: false,
      isAppBundle: false,
      isFile: true,
      size: 1,
      modified: new Date('2025-01-01T00:00:00.000Z'),
      isHidden: false,
    },
    '/dest/folder': {
      name: 'folder',
      path: '/dest/folder',
      isDirectory: true,
      isAppBundle: false,
      isFile: false,
      size: 1,
      modified: new Date('2025-01-01T00:00:00.000Z'),
      isHidden: false,
    },
    '/dest/app.app': {
      name: 'app.app',
      path: '/dest/app.app',
      isDirectory: true,
      isAppBundle: true,
      isFile: false,
      size: 1,
      modified: new Date('2025-01-01T00:00:00.000Z'),
      isHidden: false,
    },
  };

  const config = {
    getFileGrid: () => fileGrid,
    getFileItemData: vi.fn<(fileItem: HTMLElement) => FileItem | null>((fileItem: HTMLElement) => {
      const path = fileItem.dataset.path || '';
      return fileItems[path] ?? null;
    }),
    getSelectedItems: () => selectedItems,
    getTabsEnabled: vi.fn().mockReturnValue(true),
    clearSelection: vi.fn(),
    toggleSelection: vi.fn((fileItem: HTMLElement) => {
      const path = fileItem.dataset.path;
      if (!path) return;
      if (selectedItems.has(path)) {
        selectedItems.delete(path);
      } else {
        selectedItems.add(path);
      }
    }),
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

  return { config, fileGrid, selectedItems };
}

describe('createFileGridEventsController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div id="file-grid" class="drag-over">
        <div class="file-item" data-path="/dest/test.txt" data-is-directory="false"></div>
        <div class="file-item" data-path="/dest/folder" data-is-directory="true"></div>
        <div class="file-item" data-path="/dest/app.app" data-is-directory="true" data-is-app-bundle="true"></div>
      </div>
    `;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns file item element only for valid targets', () => {
    const { config, fileGrid } = createConfig();
    const controller = createFileGridEventsController(config);

    const fileItem = fileGrid.querySelector('.file-item') as HTMLElement;
    const child = document.createElement('span');
    fileItem.appendChild(child);

    expect(controller.getFileItemElement(child)).toBe(fileItem);
    expect(controller.getFileItemElement(null)).toBeNull();
    expect(controller.getFileItemElement(document.createTextNode('x'))).toBeNull();
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

  it('clears selection only when click has no ctrl/meta modifier', () => {
    const { config, fileGrid } = createConfig();
    const controller = createFileGridEventsController(config);
    controller.setupFileGridEventDelegation();

    const fileItem = fileGrid.querySelector('.file-item') as HTMLElement;
    fileItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fileItem.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));

    expect(config.clearSelection).toHaveBeenCalledTimes(1);
    expect(config.toggleSelection).toHaveBeenCalledTimes(2);
  });

  it('does not open entry on modified double click', () => {
    const { config, fileGrid } = createConfig();
    const controller = createFileGridEventsController(config);
    controller.setupFileGridEventDelegation();

    const fileItem = fileGrid.querySelector('.file-item') as HTMLElement;
    fileItem.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, shiftKey: true }));

    expect(config.openFileEntry).not.toHaveBeenCalled();
  });

  it('opens directory in new tab on middle click only when eligible', () => {
    const { config, fileGrid } = createConfig();
    const controller = createFileGridEventsController(config);
    controller.setupFileGridEventDelegation();

    const dirItem = fileGrid.querySelector('[data-path="/dest/folder"]') as HTMLElement;
    const middleClick = new MouseEvent('auxclick', {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    dirItem.dispatchEvent(middleClick);

    expect(middleClick.defaultPrevented).toBe(true);
    expect(config.addNewTab).toHaveBeenCalledWith('/dest/folder');

    (config.getTabsEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    dirItem.dispatchEvent(
      new MouseEvent('auxclick', {
        bubbles: true,
        cancelable: true,
        button: 1,
      })
    );
    expect(config.addNewTab).toHaveBeenCalledTimes(1);
  });

  it('shows context menu and selects item if it was not selected', () => {
    const { config, fileGrid } = createConfig();
    const controller = createFileGridEventsController(config);
    controller.setupFileGridEventDelegation();

    const fileItem = fileGrid.querySelector('[data-path="/dest/test.txt"]') as HTMLElement;
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fileItem.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(config.clearSelection).toHaveBeenCalledTimes(1);
    expect(config.toggleSelection).toHaveBeenCalledWith(fileItem);
    expect(config.showContextMenu).toHaveBeenCalledWith(
      0,
      0,
      expect.objectContaining({
        path: '/dest/test.txt',
      })
    );
  });

  it('does not reselect item that is already selected on context menu', () => {
    const { config, fileGrid } = createConfig();
    const controller = createFileGridEventsController(config);
    controller.setupFileGridEventDelegation();

    const fileItem = fileGrid.querySelector('[data-path="/dest/test.txt"]') as HTMLElement;
    fileItem.classList.add('selected');
    fileItem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    expect(config.clearSelection).not.toHaveBeenCalled();
    expect(config.toggleSelection).not.toHaveBeenCalled();
    expect(config.showContextMenu).toHaveBeenCalledTimes(1);
  });

  it('sets drag payload and drag image for multi-selection', () => {
    const { config, fileGrid, selectedItems } = createConfig();
    const controller = createFileGridEventsController(config);
    controller.setupFileGridEventDelegation();

    selectedItems.add('/dest/test.txt');
    selectedItems.add('/dest/folder');

    const fileItem = fileGrid.querySelector('[data-path="/dest/test.txt"]') as HTMLElement;
    fileItem.classList.add('selected');

    const dragEvent = createDragEvent('dragstart');
    fileItem.dispatchEvent(dragEvent);

    const dataTransfer = dragEvent.dataTransfer;
    if (!dataTransfer) throw new Error('missing dataTransfer');

    expect(dataTransfer.effectAllowed).toBe('copyMove');
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      'text/plain',
      JSON.stringify(['/dest/test.txt', '/dest/folder'])
    );
    expect(config.setDragData).toHaveBeenCalledWith(['/dest/test.txt', '/dest/folder']);
    expect(fileItem.classList.contains('dragging')).toBe(true);
    expect(dataTransfer.setDragImage).toHaveBeenCalledTimes(1);

    vi.runAllTimers();
    expect(document.querySelector('.drag-image')).toBeNull();
  });

  it('skips drag payload setup when dragstart has no dataTransfer', () => {
    const { config, fileGrid } = createConfig();
    const controller = createFileGridEventsController(config);
    controller.setupFileGridEventDelegation();

    const fileItem = fileGrid.querySelector('[data-path="/dest/test.txt"]') as HTMLElement;
    const dragEvent = createDragEvent('dragstart', { noDataTransfer: true });
    fileItem.dispatchEvent(dragEvent);

    expect(config.setDragData).not.toHaveBeenCalled();
  });

  it('cleans drag state on dragend', () => {
    const { config, fileGrid } = createConfig();
    const controller = createFileGridEventsController(config);
    controller.setupFileGridEventDelegation();

    const fileItem = fileGrid.querySelector('[data-path="/dest/test.txt"]') as HTMLElement;
    const dirItem = fileGrid.querySelector('[data-path="/dest/folder"]') as HTMLElement;
    fileItem.classList.add('dragging');
    dirItem.classList.add('drag-over', 'spring-loading');

    fileItem.dispatchEvent(createDragEvent('dragend'));

    expect(fileItem.classList.contains('dragging')).toBe(false);
    expect(dirItem.classList.contains('drag-over')).toBe(false);
    expect(dirItem.classList.contains('spring-loading')).toBe(false);
    expect(fileGrid.classList.contains('drag-over')).toBe(false);
    expect(config.clearDragData).toHaveBeenCalledTimes(1);
    expect(config.clearSpringLoad).toHaveBeenCalledTimes(1);
    expect(config.hideDropIndicator).toHaveBeenCalledTimes(1);
  });

  it('handles dragover guards and spring-load scheduling for directories', async () => {
    const { config, fileGrid } = createConfig();
    const controller = createFileGridEventsController(config);
    controller.setupFileGridEventDelegation();

    const fileItem = fileGrid.querySelector('[data-path="/dest/test.txt"]') as HTMLElement;
    fileItem.dispatchEvent(createDragEvent('dragover'));
    expect(config.consumeEvent).not.toHaveBeenCalled();

    const dirItem = fileGrid.querySelector('[data-path="/dest/folder"]') as HTMLElement;

    const invalidDragEvent = createDragEvent('dragover', { types: ['Files'], filesLength: 0 });
    dirItem.dispatchEvent(invalidDragEvent);
    expect(config.consumeEvent).toHaveBeenCalledTimes(1);
    expect(invalidDragEvent.dataTransfer?.dropEffect).toBe('none');

    const validDragEvent = createDragEvent('dragover', { types: ['text/plain'] });
    dirItem.dispatchEvent(validDragEvent);

    expect(config.getDragOperation).toHaveBeenCalled();
    expect(config.showDropIndicator).toHaveBeenCalledWith('move', '/dest/folder', 30, 30);
    expect(config.scheduleSpringLoad).toHaveBeenCalledTimes(1);

    const springAction = (config.scheduleSpringLoad as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as (() => void) | undefined;
    springAction?.();
    await Promise.resolve();
    expect(config.navigateTo).toHaveBeenCalledWith('/dest/folder');
  });

  it('clears spring load on dragleave when pointer leaves directory bounds', () => {
    const { config, fileGrid } = createConfig();
    const controller = createFileGridEventsController(config);
    controller.setupFileGridEventDelegation();

    const dirItem = fileGrid.querySelector('[data-path="/dest/folder"]') as HTMLElement;
    dirItem.classList.add('drag-over', 'spring-loading');
    vi.spyOn(dirItem, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      toJSON: () => ({}),
    });

    dirItem.dispatchEvent(createDragEvent('dragleave', { clientX: 120, clientY: 120 }));

    expect(dirItem.classList.contains('drag-over')).toBe(false);
    expect(config.clearSpringLoad).toHaveBeenCalledWith(dirItem);
    expect(config.hideDropIndicator).toHaveBeenCalled();
  });

  it('runs drop handler for valid payload and destination', async () => {
    const { config, fileGrid } = createConfig();
    const controller = createFileGridEventsController(config);
    controller.setupFileGridEventDelegation();

    (config.getDraggedPaths as ReturnType<typeof vi.fn>).mockResolvedValue(['/src/a.txt']);

    const dirItem = fileGrid.querySelector('[data-path="/dest/folder"]') as HTMLElement;
    await dirItem.dispatchEvent(createDragEvent('drop'));
    await Promise.resolve();

    expect(config.consumeEvent).toHaveBeenCalled();
    expect(config.clearSpringLoad).toHaveBeenCalledWith(dirItem);
    expect(config.handleDrop).toHaveBeenCalledWith(['/src/a.txt'], '/dest/folder', 'move');
    expect(config.hideDropIndicator).toHaveBeenCalled();
  });

  it('skips drop handling for self-target path and logs thrown errors', async () => {
    const { config, fileGrid } = createConfig();
    const controller = createFileGridEventsController(config);
    controller.setupFileGridEventDelegation();

    const dirItem = fileGrid.querySelector('[data-path="/dest/folder"]') as HTMLElement;

    (config.getDraggedPaths as ReturnType<typeof vi.fn>).mockResolvedValue(['/dest/folder']);
    dirItem.dispatchEvent(createDragEvent('drop'));
    await Promise.resolve();
    expect(config.handleDrop).not.toHaveBeenCalled();

    (config.getDraggedPaths as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('drop-fail'));
    dirItem.dispatchEvent(createDragEvent('drop'));
    await Promise.resolve();
    expect(devLog).toHaveBeenCalledWith('Drop', 'Drop handler failed', expect.any(Error));
  });

  it('avoids duplicate event binding across repeated setup calls', () => {
    const { config, fileGrid } = createConfig();
    const controller = createFileGridEventsController(config);

    controller.setupFileGridEventDelegation();
    controller.setupFileGridEventDelegation();

    const fileItem = fileGrid.querySelector('[data-path="/dest/test.txt"]') as HTMLElement;
    fileItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(config.toggleSelection).toHaveBeenCalledTimes(1);
  });
});
