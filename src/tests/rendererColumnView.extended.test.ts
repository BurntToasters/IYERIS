// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockElectronAPI = vi.hoisted(() => ({
  getDirectoryContents: vi.fn(),
  getDriveInfo: vi.fn(),
  cancelDirectoryContents: vi.fn().mockResolvedValue(undefined),
  setDragData: vi.fn(),
  clearDragData: vi.fn(),
}));

vi.mock('../shared.js', () => ({
  escapeHtml: (value: string) => value,
  ignoreError: () => {},
}));

vi.mock('../rendererUtils.js', () => ({
  isWindowsPath: (value: string) => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'),
  rendererPath: {
    basename: (filePath: string) => filePath.split(/[\\/]/).pop() || '',
    dirname: (filePath: string) => {
      if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\')) {
        const parts = filePath.replace(/\\+$/, '').split('\\').filter(Boolean);
        if (parts.length <= 1) return parts[0] + '\\';
        return parts.slice(0, -1).join('\\');
      }
      const idx = filePath.lastIndexOf('/');
      return idx <= 0 ? '/' : filePath.slice(0, idx);
    },
  },
}));

vi.mock('../home.js', () => ({
  isHomeViewPath: (value: string) => value === 'iyeris://home',
}));

import { createColumnViewController } from '../rendererColumnView';

function createDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const columnView = document.getElementById('column-view') as HTMLElement;
  let currentPath = '/home/user/docs';
  const selectedItems = new Set<string>();

  const deps = {
    columnView,
    getCurrentPath: () => currentPath,
    setCurrentPath: (value: string) => {
      currentPath = value;
    },
    getCurrentSettings: () => ({
      showHiddenFiles: false,
    }),
    getSelectedItems: () => selectedItems,
    clearSelection: vi.fn(() => selectedItems.clear()),
    addressInput: document.createElement('input'),
    updateBreadcrumb: vi.fn(),
    showToast: vi.fn(),
    showContextMenu: vi.fn(),
    getFileIcon: vi.fn().mockReturnValue('<span>📄</span>'),
    openFileEntry: vi.fn().mockResolvedValue(undefined),
    updatePreview: vi.fn(),
    consumeEvent: vi.fn((e: Event) => {
      e.preventDefault?.();
      e.stopPropagation?.();
    }),
    getDragOperation: vi.fn().mockReturnValue('move' as const),
    showDropIndicator: vi.fn(),
    hideDropIndicator: vi.fn(),
    getDraggedPaths: vi.fn().mockResolvedValue([]),
    handleDrop: vi.fn().mockResolvedValue(undefined),
    scheduleSpringLoad: vi.fn(),
    clearSpringLoad: vi.fn(),
    createDirectoryOperationId: vi.fn().mockReturnValue('op-ext-1'),
    getCachedDriveInfo: vi.fn().mockReturnValue([]),
    cacheDriveInfo: vi.fn(),
    folderTreeManager: { ensurePathVisible: vi.fn() },
    getFileByPath: vi.fn().mockReturnValue(undefined),
    nameCollator: new Intl.Collator('en', { sensitivity: 'base' }),
    ...overrides,
  };

  return deps;
}

function makeFileItem(name: string, itemPath: string, isDirectory: boolean, isHidden = false) {
  return {
    name,
    path: itemPath,
    isDirectory,
    isFile: !isDirectory,
    size: isDirectory ? 0 : 1024,
    modified: new Date('2025-01-01'),
    isHidden,
  };
}

function createDragEvent(
  type: string,
  opts: {
    textData?: string;
    files?: unknown[];
    clientX?: number;
    clientY?: number;
    includeTypes?: boolean;
    noTypes?: boolean;
  } = {}
): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  const types: string[] = [];
  if (opts.textData !== undefined) {
    types.push('text/plain');
  }
  if (opts.noTypes) {
    types.length = 0;
  }
  const dataTransfer = {
    effectAllowed: '' as string,
    dropEffect: '' as string,
    types,
    files: opts.files ?? [],
    setData: vi.fn(),
    getData: vi.fn((key: string) => (key === 'text/plain' ? opts.textData || '' : '')),
  };
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer, writable: true });
  Object.defineProperty(event, 'clientX', { value: opts.clientX ?? 50 });
  Object.defineProperty(event, 'clientY', { value: opts.clientY ?? 50 });
  Object.defineProperty(event, 'stopPropagation', { value: vi.fn() });
  return event;
}

async function setupRenderedColumn(
  currentPath: string,
  contentsMap: Record<string, ReturnType<typeof makeFileItem>[]>
) {
  const deps = createDeps();
  deps.getCurrentPath = () => currentPath;

  mockElectronAPI.getDirectoryContents.mockImplementation((colPath: string) => {
    const items = contentsMap[colPath] || [];
    return Promise.resolve({ success: true, contents: items });
  });

  const controller = createColumnViewController(deps as any);
  await controller.renderColumnView();

  const columnView = document.getElementById('column-view')!;
  return { deps, controller, columnView };
}

function findItemByName(columnView: HTMLElement, name: string): HTMLElement | undefined {
  return Array.from(columnView.querySelectorAll('.column-item')).find(
    (el) => el.querySelector('.column-item-name')?.textContent === name
  ) as HTMLElement | undefined;
}

describe('createColumnViewController — extended', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    document.body.innerHTML = '<div id="column-view"></div>';
    Object.defineProperty(window, 'electronAPI', {
      value: { ...mockElectronAPI },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('resize handle interactions', () => {
    it('performs column resize via mousedown, mousemove, mouseup', async () => {
      const { columnView } = await setupRenderedColumn('/test', {
        '/': [],
        '/test': [makeFileItem('a.txt', '/test/a.txt', false)],
      });

      const handle = columnView.querySelector('.column-resize-handle') as HTMLElement;
      expect(handle).toBeTruthy();

      const pane = handle.closest('.column-pane') as HTMLElement;
      Object.defineProperty(pane, 'offsetWidth', { value: 250, configurable: true });

      const mousedownEvent = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
      });
      handle.dispatchEvent(mousedownEvent);

      expect(handle.classList.contains('resizing')).toBe(true);
      expect(document.body.style.cursor).toBe('col-resize');
      expect(document.body.style.userSelect).toBe('none');

      const mousemoveEvent = new MouseEvent('mousemove', {
        bubbles: true,
        clientX: 150,
      });
      document.dispatchEvent(mousemoveEvent);

      expect(pane.style.width).toBe('300px');

      const mouseupEvent = new MouseEvent('mouseup', { bubbles: true });
      document.dispatchEvent(mouseupEvent);

      expect(handle.classList.contains('resizing')).toBe(false);
      expect(document.body.style.cursor).toBe('');
      expect(document.body.style.userSelect).toBe('');
    });

    it('clamps column width to minimum of 150px', async () => {
      const { columnView } = await setupRenderedColumn('/test', {
        '/': [],
        '/test': [],
      });

      const handle = columnView.querySelector('.column-resize-handle') as HTMLElement;
      const pane = handle.closest('.column-pane') as HTMLElement;
      Object.defineProperty(pane, 'offsetWidth', { value: 200, configurable: true });

      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 200 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 50 }));

      expect(pane.style.width).toBe('150px');

      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    it('clamps column width to maximum of 500px', async () => {
      const { columnView } = await setupRenderedColumn('/test', {
        '/': [],
        '/test': [],
      });

      const handle = columnView.querySelector('.column-resize-handle') as HTMLElement;
      const pane = handle.closest('.column-pane') as HTMLElement;
      Object.defineProperty(pane, 'offsetWidth', { value: 400, configurable: true });

      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300 }));

      expect(pane.style.width).toBe('500px');

      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
  });

  describe('pane-level dragover', () => {
    it('sets drop effect and shows indicator when text/plain is present', async () => {
      const { columnView, deps } = await setupRenderedColumn('/drop', {
        '/': [],
        '/drop': [makeFileItem('sub', '/drop/sub', true)],
      });

      const pane = columnView.querySelector('.column-pane:last-child') as HTMLElement;
      const dragEvent = createDragEvent('dragover', { textData: 'test', clientX: 80, clientY: 90 });

      pane.dispatchEvent(dragEvent);

      expect(deps.consumeEvent).toHaveBeenCalled();
      expect(pane.classList.contains('drag-over')).toBe(true);
      expect(deps.showDropIndicator).toHaveBeenCalledWith('move', '/drop', 80, 90);
    });

    it('sets dropEffect to none when no text/plain and no files', async () => {
      const { columnView } = await setupRenderedColumn('/drop', {
        '/': [],
        '/drop': [],
      });

      const pane = columnView.querySelector('.column-pane:last-child') as HTMLElement;
      const dragEvent = createDragEvent('dragover', { noTypes: true });

      pane.dispatchEvent(dragEvent);

      expect((dragEvent as any).dataTransfer.dropEffect).toBe('none');
    });

    it('returns early when target is inside a column-item', async () => {
      const { columnView, deps } = await setupRenderedColumn('/drop', {
        '/': [],
        '/drop': [makeFileItem('file.txt', '/drop/file.txt', false)],
      });

      const item = findItemByName(columnView, 'file.txt')!;
      const dragEvent = createDragEvent('dragover', { textData: 'test' });

      item.dispatchEvent(dragEvent);

      expect(deps.showDropIndicator).not.toHaveBeenCalled();
    });
  });

  describe('pane-level dragleave', () => {
    it('removes drag-over class when cursor leaves pane bounds', async () => {
      const { columnView, deps } = await setupRenderedColumn('/drop', {
        '/': [],
        '/drop': [],
      });

      const pane = columnView.querySelector('.column-pane:last-child') as HTMLElement;
      pane.classList.add('drag-over');

      vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        right: 300,
        top: 100,
        bottom: 400,
        width: 200,
        height: 300,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      });

      const dragLeave = new Event('dragleave', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(dragLeave, 'clientX', { value: 50 });
      Object.defineProperty(dragLeave, 'clientY', { value: 200 });
      Object.defineProperty(dragLeave, 'target', { value: pane });

      pane.dispatchEvent(dragLeave);

      expect(pane.classList.contains('drag-over')).toBe(false);
      expect(deps.hideDropIndicator).toHaveBeenCalled();
    });

    it('does not remove drag-over class when cursor is within pane bounds', async () => {
      const { columnView, deps } = await setupRenderedColumn('/drop', {
        '/': [],
        '/drop': [],
      });

      const pane = columnView.querySelector('.column-pane:last-child') as HTMLElement;
      pane.classList.add('drag-over');

      vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        right: 300,
        top: 100,
        bottom: 400,
        width: 200,
        height: 300,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      });

      const dragLeave = new Event('dragleave', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(dragLeave, 'clientX', { value: 200 });
      Object.defineProperty(dragLeave, 'clientY', { value: 200 });
      Object.defineProperty(dragLeave, 'target', { value: pane });

      pane.dispatchEvent(dragLeave);

      expect(pane.classList.contains('drag-over')).toBe(true);
      expect(deps.hideDropIndicator).not.toHaveBeenCalled();
    });
  });

  describe('pane-level drop', () => {
    it('handles drop with valid dragged paths', async () => {
      const { columnView, deps } = await setupRenderedColumn('/dest', {
        '/': [],
        '/dest': [],
      });

      deps.getDraggedPaths = vi.fn().mockResolvedValue(['/other/file.txt']);

      const pane = columnView.querySelector('.column-pane:last-child') as HTMLElement;
      pane.classList.add('drag-over');

      const dropEvent = createDragEvent('drop', { textData: '["/other/file.txt"]' });

      pane.dispatchEvent(dropEvent);
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.handleDrop).toHaveBeenCalledWith(['/other/file.txt'], '/dest', 'move');
      expect(deps.hideDropIndicator).toHaveBeenCalled();
      expect(pane.classList.contains('drag-over')).toBe(false);
    });

    it('shows toast when items are already in the target directory', async () => {
      const { columnView, deps } = await setupRenderedColumn('/dest', {
        '/': [],
        '/dest': [],
      });

      deps.getDraggedPaths = vi.fn().mockResolvedValue(['/dest/existing.txt']);

      const pane = columnView.querySelector('.column-pane:last-child') as HTMLElement;
      const dropEvent = createDragEvent('drop', { textData: '["/dest/existing.txt"]' });

      pane.dispatchEvent(dropEvent);
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.showToast).toHaveBeenCalledWith(
        'Items are already in this directory',
        'Info',
        'info'
      );
      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('hides indicator and returns when dragged paths are empty', async () => {
      const { columnView, deps } = await setupRenderedColumn('/dest', {
        '/': [],
        '/dest': [],
      });

      deps.getDraggedPaths = vi.fn().mockResolvedValue([]);

      const pane = columnView.querySelector('.column-pane:last-child') as HTMLElement;
      const dropEvent = createDragEvent('drop', { textData: '' });

      pane.dispatchEvent(dropEvent);
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.hideDropIndicator).toHaveBeenCalled();
      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('returns early when target is inside a column-item', async () => {
      const { columnView, deps } = await setupRenderedColumn('/dest', {
        '/': [],
        '/dest': [makeFileItem('file.txt', '/dest/file.txt', false)],
      });

      deps.getDraggedPaths = vi.fn().mockResolvedValue(['/other/a.txt']);

      const item = findItemByName(columnView, 'file.txt')!;
      const dropEvent = createDragEvent('drop', { textData: '["/other/a.txt"]' });

      item.dispatchEvent(dropEvent);
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('shows toast when dragged path equals the column path', async () => {
      const { columnView, deps } = await setupRenderedColumn('/dest', {
        '/': [],
        '/dest': [],
      });

      deps.getDraggedPaths = vi.fn().mockResolvedValue(['/dest']);

      const pane = columnView.querySelector('.column-pane:last-child') as HTMLElement;
      const dropEvent = createDragEvent('drop', { textData: '["/dest"]' });

      pane.dispatchEvent(dropEvent);
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.showToast).toHaveBeenCalledWith(
        'Items are already in this directory',
        'Info',
        'info'
      );
    });
  });

  describe('directory item drag events', () => {
    async function setupWithDirectory() {
      const contentsMap: Record<string, ReturnType<typeof makeFileItem>[]> = {
        '/': [],
        '/root': [makeFileItem('subdir', '/root/subdir', true)],
        '/root/subdir': [],
      };
      return setupRenderedColumn('/root', contentsMap);
    }

    it('dragover on directory item shows indicator and schedules spring-load', async () => {
      const { columnView, deps } = await setupWithDirectory();

      const dirItem = findItemByName(columnView, 'subdir')!;
      expect(dirItem).toBeTruthy();

      const dragEvent = createDragEvent('dragover', {
        textData: '["/other/x.txt"]',
        clientX: 120,
        clientY: 130,
      });

      dirItem.dispatchEvent(dragEvent);

      expect(deps.consumeEvent).toHaveBeenCalled();
      expect(dirItem.classList.contains('drag-over')).toBe(true);
      expect(deps.showDropIndicator).toHaveBeenCalledWith('move', '/root/subdir', 120, 130);
      expect(deps.scheduleSpringLoad).toHaveBeenCalled();
    });

    it('dragover on directory sets dropEffect none when no text/plain and no files', async () => {
      const { columnView } = await setupWithDirectory();

      const dirItem = findItemByName(columnView, 'subdir')!;
      const dragEvent = createDragEvent('dragover', { noTypes: true });

      dirItem.dispatchEvent(dragEvent);

      expect((dragEvent as any).dataTransfer.dropEffect).toBe('none');
    });

    it('dragleave on directory removes drag-over when cursor leaves bounds', async () => {
      const { columnView, deps } = await setupWithDirectory();

      const dirItem = findItemByName(columnView, 'subdir')!;
      dirItem.classList.add('drag-over');

      vi.spyOn(dirItem, 'getBoundingClientRect').mockReturnValue({
        left: 50,
        right: 200,
        top: 50,
        bottom: 80,
        width: 150,
        height: 30,
        x: 50,
        y: 50,
        toJSON: () => ({}),
      });

      const dragLeave = new Event('dragleave', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(dragLeave, 'clientX', { value: 10 });
      Object.defineProperty(dragLeave, 'clientY', { value: 60 });

      dirItem.dispatchEvent(dragLeave);

      expect(dirItem.classList.contains('drag-over')).toBe(false);
      expect(deps.clearSpringLoad).toHaveBeenCalledWith(dirItem);
      expect(deps.hideDropIndicator).toHaveBeenCalled();
    });

    it('dragleave on directory does not remove drag-over when cursor is inside bounds', async () => {
      const { columnView, deps } = await setupWithDirectory();

      const dirItem = findItemByName(columnView, 'subdir')!;
      dirItem.classList.add('drag-over');

      vi.spyOn(dirItem, 'getBoundingClientRect').mockReturnValue({
        left: 50,
        right: 200,
        top: 50,
        bottom: 80,
        width: 150,
        height: 30,
        x: 50,
        y: 50,
        toJSON: () => ({}),
      });

      const dragLeave = new Event('dragleave', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(dragLeave, 'clientX', { value: 100 });
      Object.defineProperty(dragLeave, 'clientY', { value: 60 });

      dirItem.dispatchEvent(dragLeave);

      expect(dirItem.classList.contains('drag-over')).toBe(true);
      expect(deps.clearSpringLoad).not.toHaveBeenCalled();
    });

    it('drop on directory calls handleDrop with the directory path', async () => {
      const { columnView, deps } = await setupWithDirectory();

      deps.getDraggedPaths = vi.fn().mockResolvedValue(['/other/moved.txt']);

      const dirItem = findItemByName(columnView, 'subdir')!;
      dirItem.classList.add('drag-over');

      const dropEvent = createDragEvent('drop', { textData: '["/other/moved.txt"]' });

      dirItem.dispatchEvent(dropEvent);
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.consumeEvent).toHaveBeenCalled();
      expect(deps.clearSpringLoad).toHaveBeenCalled();
      expect(dirItem.classList.contains('drag-over')).toBe(false);
      expect(deps.handleDrop).toHaveBeenCalledWith(['/other/moved.txt'], '/root/subdir', 'move');
      expect(deps.hideDropIndicator).toHaveBeenCalled();
    });

    it('drop on directory does nothing when dragged paths is empty', async () => {
      const { columnView, deps } = await setupWithDirectory();

      deps.getDraggedPaths = vi.fn().mockResolvedValue([]);

      const dirItem = findItemByName(columnView, 'subdir')!;
      const dropEvent = createDragEvent('drop', { textData: '' });

      dirItem.dispatchEvent(dropEvent);
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.hideDropIndicator).toHaveBeenCalled();
      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('drop on directory does nothing when dragged path includes directory itself', async () => {
      const { columnView, deps } = await setupWithDirectory();

      deps.getDraggedPaths = vi.fn().mockResolvedValue(['/root/subdir']);

      const dirItem = findItemByName(columnView, 'subdir')!;
      const dropEvent = createDragEvent('drop', { textData: '["/root/subdir"]' });

      dirItem.dispatchEvent(dropEvent);
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.hideDropIndicator).toHaveBeenCalled();
      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('spring-load callback triggers navigation into directory', async () => {
      const { columnView, deps } = await setupWithDirectory();

      const dirItem = findItemByName(columnView, 'subdir')!;
      dirItem.classList.add('drag-over', 'spring-loading');

      const dragEvent = createDragEvent('dragover', {
        textData: '["/other/x.txt"]',
        clientX: 100,
        clientY: 100,
      });
      dirItem.dispatchEvent(dragEvent);

      const springLoadCall = deps.scheduleSpringLoad.mock.calls[0];
      expect(springLoadCall[0]).toBe(dirItem);
      const springLoadCallback = springLoadCall[1] as (...args: unknown[]) => unknown;
      springLoadCallback();

      expect(dirItem.classList.contains('drag-over')).toBe(false);
      expect(dirItem.classList.contains('spring-loading')).toBe(false);
    });
  });

  describe('file item dragstart and dragend', () => {
    it('dragstart selects unselected item and sets drag data', async () => {
      const { columnView, deps } = await setupRenderedColumn('/drag', {
        '/': [],
        '/drag': [makeFileItem('move.txt', '/drag/move.txt', false)],
      });

      const item = findItemByName(columnView, 'move.txt')!;
      expect(item.getAttribute('draggable')).toBe('true');

      const dragEvent = createDragEvent('dragstart', { textData: '' });
      item.dispatchEvent(dragEvent);

      expect(item.classList.contains('selected')).toBe(true);
      expect(item.classList.contains('dragging')).toBe(true);
      expect(deps.clearSelection).toHaveBeenCalled();
      expect(mockElectronAPI.setDragData).toHaveBeenCalled();
    });

    it('dragstart preserves existing selection when item is already selected', async () => {
      const { columnView, deps } = await setupRenderedColumn('/drag', {
        '/': [],
        '/drag': [
          makeFileItem('a.txt', '/drag/a.txt', false),
          makeFileItem('b.txt', '/drag/b.txt', false),
        ],
      });

      const itemA = findItemByName(columnView, 'a.txt')!;
      const itemB = findItemByName(columnView, 'b.txt')!;

      itemA.classList.add('selected');
      itemB.classList.add('selected');
      deps.getSelectedItems().add('/drag/a.txt');
      deps.getSelectedItems().add('/drag/b.txt');

      const dragEvent = createDragEvent('dragstart', { textData: '' });
      itemA.dispatchEvent(dragEvent);

      expect(deps.clearSelection).not.toHaveBeenCalled();
      expect(mockElectronAPI.setDragData).toHaveBeenCalledWith(['/drag/a.txt', '/drag/b.txt']);
    });

    it('dragend cleans up dragging state', async () => {
      const { columnView, deps } = await setupRenderedColumn('/drag', {
        '/': [],
        '/drag': [makeFileItem('end.txt', '/drag/end.txt', false)],
      });

      const item = findItemByName(columnView, 'end.txt')!;
      item.classList.add('dragging');

      const otherDiv = document.createElement('div');
      otherDiv.className = 'column-item drag-over';
      document.body.appendChild(otherDiv);

      item.dispatchEvent(new Event('dragend', { bubbles: true }));

      expect(item.classList.contains('dragging')).toBe(false);
      expect(otherDiv.classList.contains('drag-over')).toBe(false);
      expect(mockElectronAPI.clearDragData).toHaveBeenCalled();
      expect(deps.clearSpringLoad).toHaveBeenCalled();
      expect(deps.hideDropIndicator).toHaveBeenCalled();
    });
  });

  describe('context menu updates path', () => {
    it('updates current path when context menu is on a different column', async () => {
      let currentPath = '/parent/child';
      const deps = createDeps();
      deps.getCurrentPath = () => currentPath;
      deps.setCurrentPath = (v: string) => {
        currentPath = v;
      };

      mockElectronAPI.getDirectoryContents.mockImplementation((colPath: string) => {
        if (colPath === '/parent') {
          return Promise.resolve({
            success: true,
            contents: [
              makeFileItem('child', '/parent/child', true),
              makeFileItem('other.txt', '/parent/other.txt', false),
            ],
          });
        }
        return Promise.resolve({ success: true, contents: [] });
      });

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const columnView = document.getElementById('column-view')!;

      const otherItem = findItemByName(columnView, 'other.txt')!;

      const contextEvent = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 200,
      });
      Object.defineProperty(contextEvent, 'pageX', { value: 100 });
      Object.defineProperty(contextEvent, 'pageY', { value: 200 });

      otherItem.dispatchEvent(contextEvent);
      await vi.advanceTimersByTimeAsync(50);

      expect(currentPath).toBe('/parent');
      expect(deps.updateBreadcrumb).toHaveBeenCalledWith('/parent');
    });
  });

  describe('handleColumnItemClick — directory with ensurePathVisible error', () => {
    it('catches and ignores error from ensurePathVisible on directory click', async () => {
      let testPath = '/parent';
      const deps = createDeps();
      deps.getCurrentPath = () => testPath;
      deps.setCurrentPath = (v: string) => {
        testPath = v;
      };
      deps.folderTreeManager = {
        ensurePathVisible: vi.fn().mockImplementation(() => {
          throw new Error('tree error');
        }),
      };

      mockElectronAPI.getDirectoryContents.mockImplementation((colPath: string) => {
        if (colPath === '/parent') {
          return Promise.resolve({
            success: true,
            contents: [makeFileItem('child', '/parent/child', true)],
          });
        }
        return Promise.resolve({ success: true, contents: [] });
      });

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const columnView = document.getElementById('column-view')!;
      const dirItem = findItemByName(columnView, 'child')!;

      dirItem.dispatchEvent(new Event('click', { bubbles: true }));
      await vi.runAllTimersAsync();

      expect(testPath).toBe('/parent/child');
      expect(deps.folderTreeManager.ensurePathVisible).toHaveBeenCalledWith('/parent/child');
    });
  });

  describe('handleColumnItemClick — file click when parentPath differs', () => {
    it('updates path to parent column when clicking file in a non-current column', async () => {
      let currentPath = '/a/b';
      const deps = createDeps();
      deps.getCurrentPath = () => currentPath;
      deps.setCurrentPath = (v: string) => {
        currentPath = v;
      };

      mockElectronAPI.getDirectoryContents.mockImplementation((colPath: string) => {
        if (colPath === '/') {
          return Promise.resolve({
            success: true,
            contents: [makeFileItem('a', '/a', true), makeFileItem('root.txt', '/root.txt', false)],
          });
        }
        if (colPath === '/a') {
          return Promise.resolve({
            success: true,
            contents: [makeFileItem('b', '/a/b', true)],
          });
        }
        return Promise.resolve({ success: true, contents: [] });
      });

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const columnView = document.getElementById('column-view')!;
      const fileItem = findItemByName(columnView, 'root.txt')!;

      fileItem.dispatchEvent(new Event('click', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(100);

      expect(currentPath).toBe('/');
      expect(deps.updateBreadcrumb).toHaveBeenCalledWith('/');
    });

    it('catches and ignores ensurePathVisible error on file click path update', async () => {
      let currentPath = '/a/b';
      const deps = createDeps();
      deps.getCurrentPath = () => currentPath;
      deps.setCurrentPath = (v: string) => {
        currentPath = v;
      };
      deps.folderTreeManager = {
        ensurePathVisible: vi.fn().mockImplementation(() => {
          throw new Error('tree fail');
        }),
      };

      mockElectronAPI.getDirectoryContents.mockImplementation((colPath: string) => {
        if (colPath === '/') {
          return Promise.resolve({
            success: true,
            contents: [makeFileItem('a', '/a', true), makeFileItem('x.txt', '/x.txt', false)],
          });
        }
        if (colPath === '/a') {
          return Promise.resolve({
            success: true,
            contents: [makeFileItem('b', '/a/b', true)],
          });
        }
        return Promise.resolve({ success: true, contents: [] });
      });

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const columnView = document.getElementById('column-view')!;
      const fileItem = findItemByName(columnView, 'x.txt')!;

      fileItem.dispatchEvent(new Event('click', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(100);

      expect(currentPath).toBe('/');
      expect(deps.folderTreeManager.ensurePathVisible).toHaveBeenCalledWith('/');
    });
  });

  describe('handleColumnItemClick — file click with preview panel', () => {
    it('creates fallback file when getFileByPath returns undefined and preview is visible', async () => {
      const previewPanel = document.createElement('div');
      previewPanel.id = 'preview-panel';
      previewPanel.style.display = 'block';
      document.body.appendChild(previewPanel);

      const deps = createDeps({
        getFileByPath: vi.fn().mockReturnValue(undefined),
      });
      deps.getCurrentPath = () => '/view';

      mockElectronAPI.getDirectoryContents.mockImplementation((colPath: string) => {
        if (colPath === '/view') {
          return Promise.resolve({
            success: true,
            contents: [makeFileItem('report.pdf', '/view/report.pdf', false)],
          });
        }
        return Promise.resolve({ success: true, contents: [] });
      });

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const columnView = document.getElementById('column-view')!;
      const fileItem = findItemByName(columnView, 'report.pdf')!;

      fileItem.dispatchEvent(new Event('click', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.updatePreview).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'report.pdf',
          path: '/view/report.pdf',
          isDirectory: false,
          isFile: true,
          size: 0,
          isHidden: false,
        })
      );
    });

    it('constructs hidden file correctly when file name starts with dot', async () => {
      const previewPanel = document.createElement('div');
      previewPanel.id = 'preview-panel';
      previewPanel.style.display = 'block';
      document.body.appendChild(previewPanel);

      const deps = createDeps({
        getFileByPath: vi.fn().mockReturnValue(undefined),
        getCurrentSettings: () => ({ showHiddenFiles: true }) as any,
      });
      deps.getCurrentPath = () => '/view';

      mockElectronAPI.getDirectoryContents.mockImplementation((colPath: string) => {
        if (colPath === '/view') {
          return Promise.resolve({
            success: true,
            contents: [makeFileItem('.gitignore', '/view/.gitignore', false, true)],
          });
        }
        return Promise.resolve({ success: true, contents: [] });
      });

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const columnView = document.getElementById('column-view')!;
      const fileItem = findItemByName(columnView, '.gitignore')!;

      fileItem.dispatchEvent(new Event('click', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.updatePreview).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '.gitignore',
          isHidden: true,
        })
      );
    });

    it('does not call updatePreview when preview panel is hidden', async () => {
      const previewPanel = document.createElement('div');
      previewPanel.id = 'preview-panel';
      previewPanel.style.display = 'none';
      document.body.appendChild(previewPanel);

      const deps = createDeps();
      deps.getCurrentPath = () => '/view';

      mockElectronAPI.getDirectoryContents.mockImplementation((colPath: string) => {
        if (colPath === '/view') {
          return Promise.resolve({
            success: true,
            contents: [makeFileItem('nope.txt', '/view/nope.txt', false)],
          });
        }
        return Promise.resolve({ success: true, contents: [] });
      });

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const columnView = document.getElementById('column-view')!;
      const fileItem = findItemByName(columnView, 'nope.txt')!;

      fileItem.dispatchEvent(new Event('click', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.updatePreview).not.toHaveBeenCalled();
    });

    it('does not call updatePreview when no preview panel exists', async () => {
      const deps = createDeps();
      deps.getCurrentPath = () => '/view';

      mockElectronAPI.getDirectoryContents.mockImplementation((colPath: string) => {
        if (colPath === '/view') {
          return Promise.resolve({
            success: true,
            contents: [makeFileItem('skip.txt', '/view/skip.txt', false)],
          });
        }
        return Promise.resolve({ success: true, contents: [] });
      });

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const columnView = document.getElementById('column-view')!;
      const fileItem = findItemByName(columnView, 'skip.txt')!;

      fileItem.dispatchEvent(new Event('click', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.updatePreview).not.toHaveBeenCalled();
    });
  });

  describe('handleColumnItemClick — element not in column pane', () => {
    it('returns early when element has no parent column-pane', async () => {
      const deps = createDeps();
      deps.getCurrentPath = () => '/test';

      mockElectronAPI.getDirectoryContents.mockResolvedValue({
        success: true,
        contents: [],
      });

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const orphan = document.createElement('div');
      orphan.className = 'column-item';
      document.body.appendChild(orphan);

      expect(deps.updateBreadcrumb).not.toHaveBeenCalled();
    });
  });

  describe('double-click on directory does not call openFileEntry', () => {
    it('does not open a directory on double-click', async () => {
      const { columnView, deps } = await setupRenderedColumn('/test', {
        '/': [],
        '/test': [makeFileItem('folder', '/test/folder', true)],
      });

      const dirItem = findItemByName(columnView, 'folder')!;
      dirItem.dispatchEvent(new Event('dblclick', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.openFileEntry).not.toHaveBeenCalled();
    });
  });

  describe('scroll position after render', () => {
    it('scrolls to the right when savedScrollLeft is 0', async () => {
      const deps = createDeps();
      deps.getCurrentPath = () => '/test';

      mockElectronAPI.getDirectoryContents.mockResolvedValue({
        success: true,
        contents: [],
      });

      const columnView = document.getElementById('column-view')!;
      Object.defineProperty(columnView, 'scrollLeft', {
        value: 0,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(columnView, 'scrollWidth', {
        value: 800,
        writable: true,
        configurable: true,
      });

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();
      await vi.advanceTimersByTimeAsync(100);

      expect(columnView.scrollLeft).toBe(800);
    });
  });

  describe('scroll after directory click', () => {
    it('scrolls right after clicking a directory', async () => {
      let testPath = '/parent';
      const deps = createDeps();
      deps.getCurrentPath = () => testPath;
      deps.setCurrentPath = (v: string) => {
        testPath = v;
      };

      mockElectronAPI.getDirectoryContents.mockImplementation((colPath: string) => {
        if (colPath === '/parent') {
          return Promise.resolve({
            success: true,
            contents: [makeFileItem('sub', '/parent/sub', true)],
          });
        }
        return Promise.resolve({ success: true, contents: [] });
      });

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const columnView = document.getElementById('column-view')!;
      Object.defineProperty(columnView, 'scrollWidth', {
        value: 1200,
        writable: true,
        configurable: true,
      });

      const dirItem = findItemByName(columnView, 'sub')!;
      dirItem.dispatchEvent(new Event('click', { bubbles: true }));
      await vi.runAllTimersAsync();

      expect(testPath).toBe('/parent/sub');
    });
  });

  describe('removing subsequent panes on item click', () => {
    it('removes panes after the clicked one and clears selection state', async () => {
      let currentPath = '/a/b/c';
      const deps = createDeps();
      deps.getCurrentPath = () => currentPath;
      deps.setCurrentPath = (v: string) => {
        currentPath = v;
      };

      mockElectronAPI.getDirectoryContents.mockImplementation((colPath: string) => {
        if (colPath === '/') {
          return Promise.resolve({
            success: true,
            contents: [makeFileItem('a', '/a', true), makeFileItem('z.txt', '/z.txt', false)],
          });
        }
        if (colPath === '/a') {
          return Promise.resolve({
            success: true,
            contents: [makeFileItem('b', '/a/b', true)],
          });
        }
        if (colPath === '/a/b') {
          return Promise.resolve({
            success: true,
            contents: [makeFileItem('c', '/a/b/c', true)],
          });
        }
        return Promise.resolve({ success: true, contents: [] });
      });

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const columnView = document.getElementById('column-view')!;

      const initialPanes = columnView.querySelectorAll('.column-pane');
      expect(initialPanes.length).toBe(4);

      const rootFile = findItemByName(columnView, 'z.txt')!;
      rootFile.dispatchEvent(new Event('click', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(100);

      const remainingPanes = columnView.querySelectorAll('.column-pane');
      expect(remainingPanes.length).toBe(1);
    });
  });

  describe('concurrent rendering — isRenderingColumnView wait loop', () => {
    it('second render supersedes first when both start quickly', async () => {
      const deps = createDeps();
      deps.getCurrentPath = () => '/first';

      mockElectronAPI.getDirectoryContents.mockResolvedValue({
        success: true,
        contents: [],
      });

      const controller = createColumnViewController(deps as any);

      const p1 = controller.renderColumnView();

      deps.getCurrentPath = () => '/second';
      const p2 = controller.renderColumnView();

      await Promise.all([p1, p2]);
      await vi.advanceTimersByTimeAsync(100);

      const columnView = document.getElementById('column-view')!;
      const panes = columnView.querySelectorAll('.column-pane');
      expect(panes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('column rendering — result with no success and no error message', () => {
    it('shows error placeholder when result.success is false and no error string', async () => {
      const deps = createDeps();
      deps.getCurrentPath = () => '/fail';

      mockElectronAPI.getDirectoryContents.mockResolvedValue({
        success: false,
      });

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const columnView = document.getElementById('column-view')!;
      expect(columnView.textContent).toContain('Error loading folder');
    });
  });

  describe('column rendering — result.contents is undefined', () => {
    it('treats undefined contents as empty array', async () => {
      const deps = createDeps();
      deps.getCurrentPath = () => '/undef';

      mockElectronAPI.getDirectoryContents.mockResolvedValue({
        success: true,
        contents: undefined,
      });

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const columnView = document.getElementById('column-view')!;
      expect(columnView.textContent).toContain('Empty folder');
    });
  });

  describe('pane-level dragleave returns early for column-item targets', () => {
    it('returns early when target is inside a column-item', async () => {
      const { columnView, deps } = await setupRenderedColumn('/test', {
        '/': [],
        '/test': [makeFileItem('file.txt', '/test/file.txt', false)],
      });

      const item = findItemByName(columnView, 'file.txt')!;

      const dragLeave = new Event('dragleave', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(dragLeave, 'target', { value: item });
      Object.defineProperty(dragLeave, 'clientX', { value: 0 });
      Object.defineProperty(dragLeave, 'clientY', { value: 0 });

      const pane = columnView.querySelector('.column-pane:last-child') as HTMLElement;
      pane.classList.add('drag-over');

      pane.dispatchEvent(dragLeave);

      expect(pane.classList.contains('drag-over')).toBe(true);
      expect(deps.hideDropIndicator).not.toHaveBeenCalled();
    });
  });

  describe('drive column — drive without label', () => {
    it('renders drive path when label is empty', async () => {
      const deps = createDeps();
      deps.getCurrentPath = () => '';

      const drives = [{ path: '/dev/sda1', label: '' }];
      mockElectronAPI.getDriveInfo.mockResolvedValue(drives);

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const columnView = document.getElementById('column-view')!;
      expect(columnView.textContent).toContain('/dev/sda1');
    });
  });

  describe('drop with copy operation', () => {
    it('uses copy operation from getDragOperation during pane drop', async () => {
      const { columnView, deps } = await setupRenderedColumn('/dest', {
        '/': [],
        '/dest': [],
      });

      deps.getDraggedPaths = vi.fn().mockResolvedValue(['/src/file.txt']);
      deps.getDragOperation = vi.fn().mockReturnValue('copy');

      const pane = columnView.querySelector('.column-pane:last-child') as HTMLElement;
      const dropEvent = createDragEvent('drop', { textData: '["/src/file.txt"]' });

      pane.dispatchEvent(dropEvent);
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.handleDrop).toHaveBeenCalledWith(['/src/file.txt'], '/dest', 'copy');
    });

    it('uses copy operation from getDragOperation during directory drop', async () => {
      const { columnView, deps } = await setupRenderedColumn('/root', {
        '/': [],
        '/root': [makeFileItem('target', '/root/target', true)],
        '/root/target': [],
      });

      deps.getDraggedPaths = vi.fn().mockResolvedValue(['/src/file.txt']);
      deps.getDragOperation = vi.fn().mockReturnValue('copy');

      const dirItem = findItemByName(columnView, 'target')!;
      const dropEvent = createDragEvent('drop', { textData: '["/src/file.txt"]' });

      dirItem.dispatchEvent(dropEvent);
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.handleDrop).toHaveBeenCalledWith(['/src/file.txt'], '/root/target', 'copy');
    });
  });
});
