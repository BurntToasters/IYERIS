// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDragDropController } from '../rendererDragDrop';

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createDragEvent(
  type: string,
  options: {
    textData?: string;
    files?: Array<{ path: string }>;
    ctrlKey?: boolean;
    altKey?: boolean;
    clientX?: number;
    clientY?: number;
    noDataTransfer?: boolean;
  } = {}
): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  if (options.noDataTransfer) {
    Object.assign(event, { dataTransfer: null });
    return event;
  }
  const dataTransfer = {
    files: options.files ?? [],
    dropEffect: 'move',
    getData: vi.fn((key: string) => (key === 'text/plain' ? options.textData || '' : '')),
  };
  Object.assign(event, {
    dataTransfer,
    ctrlKey: !!options.ctrlKey,
    altKey: !!options.altKey,
    clientX: options.clientX ?? 20,
    clientY: options.clientY ?? 20,
  });
  return event;
}

function createConfig(overrides: Record<string, unknown> = {}) {
  const showToast = vi.fn();
  const config = {
    getCurrentPath: () => (overrides.currentPath as string) ?? '/dest',
    getCurrentSettings: () => ({ fileConflictBehavior: 'ask' }) as never,
    getShowToast: () => showToast,
    getFileGrid: () => document.getElementById('file-grid'),
    getFileView: () => document.getElementById('file-view'),
    getDropIndicator: () => document.getElementById('drop-indicator'),
    getDropIndicatorAction: () => document.getElementById('drop-indicator-action'),
    getDropIndicatorPath: () => document.getElementById('drop-indicator-path'),
    consumeEvent: vi.fn((e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    }),
    clearSelection: vi.fn(),
    navigateTo: vi.fn().mockResolvedValue(undefined),
    updateUndoRedoState: vi.fn().mockResolvedValue(undefined),
  };
  return { config, showToast };
}

describe('createDragDropController — extended', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="file-view">
        <div class="column-view">
          <div class="column-item" data-path="/dest/sub-dir" data-type="directory">sub-dir</div>
        </div>
      </div>
      <div id="file-grid">
        <div class="file-item" data-path="/dest/folder" data-type="directory">folder</div>
        <div class="file-item" data-path="/dest/readme.md" data-type="file">readme.md</div>
      </div>
      <div id="drop-indicator" style="display:none">
        <span id="drop-indicator-action"></span>
        <span id="drop-indicator-path"></span>
      </div>
    `;
    Object.defineProperty(window, 'electronAPI', {
      value: {
        getDragData: vi.fn().mockResolvedValue(null),
        copyItems: vi.fn().mockResolvedValue({ success: true }),
        moveItems: vi.fn().mockResolvedValue({ success: true }),
        clearDragData: vi.fn().mockResolvedValue(undefined),
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleDrop', () => {
    it('handles copy operation', async () => {
      const { config, showToast } = createConfig();
      const ctrl = createDragDropController(config);
      const electronAPI = (
        window as unknown as { electronAPI: Record<string, ReturnType<typeof vi.fn>> }
      ).electronAPI;

      await ctrl.handleDrop(['/src.txt'], '/dest', 'copy');

      expect(electronAPI.copyItems).toHaveBeenCalledWith(['/src.txt'], '/dest', 'ask');
      expect(electronAPI.moveItems).not.toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledWith('Copied 1 item(s)', 'Success', 'success');

      expect(config.updateUndoRedoState).not.toHaveBeenCalled();
    });

    it('shows error toast on failure', async () => {
      const electronAPI = {
        getDragData: vi.fn(),
        copyItems: vi.fn().mockResolvedValue({ success: false, error: 'disk full' }),
        moveItems: vi.fn(),
        clearDragData: vi.fn(),
      };
      Object.defineProperty(window, 'electronAPI', {
        value: electronAPI,
        configurable: true,
        writable: true,
      });
      const { config, showToast } = createConfig();
      const ctrl = createDragDropController(config);

      await ctrl.handleDrop(['/src.txt'], '/dest', 'copy');

      expect(showToast).toHaveBeenCalledWith('disk full', 'Error', 'error', expect.any(Array));
      expect(config.navigateTo).not.toHaveBeenCalled();
    });

    it('shows generic error when no error message', async () => {
      Object.defineProperty(window, 'electronAPI', {
        value: {
          getDragData: vi.fn(),
          copyItems: vi.fn(),
          moveItems: vi.fn().mockResolvedValue({ success: false }),
          clearDragData: vi.fn(),
        },
        configurable: true,
        writable: true,
      });
      const { config, showToast } = createConfig();
      const ctrl = createDragDropController(config);

      await ctrl.handleDrop(['/a'], '/dest', 'move');

      expect(showToast).toHaveBeenCalledWith(
        'Failed to move items',
        'Error',
        'error',
        expect.any(Array)
      );
    });

    it('catches exceptions and shows error toast', async () => {
      Object.defineProperty(window, 'electronAPI', {
        value: {
          getDragData: vi.fn(),
          copyItems: vi.fn().mockRejectedValue(new Error('boom')),
          moveItems: vi.fn(),
          clearDragData: vi.fn(),
        },
        configurable: true,
        writable: true,
      });
      const { config, showToast } = createConfig();
      const ctrl = createDragDropController(config);

      await ctrl.handleDrop(['/a'], '/dest', 'copy');

      expect(showToast).toHaveBeenCalledWith(
        'Failed to copy items',
        'Error',
        'error',
        expect.any(Array)
      );
    });
  });

  describe('getDraggedPaths', () => {
    it('returns empty array when dataTransfer is null', async () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      const result = await ctrl.getDraggedPaths(createDragEvent('drop', { noDataTransfer: true }));
      expect(result).toEqual([]);
    });

    it('falls back to files when text parse fails', async () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      const result = await ctrl.getDraggedPaths(
        createDragEvent('drop', {
          textData: 'not-json',
          files: [{ path: '/from-file.txt' }] as never,
        })
      );
      expect(result).toEqual(['/from-file.txt']);
    });

    it('falls back to electronAPI.getDragData when text and files empty', async () => {
      Object.defineProperty(window, 'electronAPI', {
        value: {
          getDragData: vi.fn().mockResolvedValue({ paths: ['/shared.txt'] }),
          copyItems: vi.fn(),
          moveItems: vi.fn(),
          clearDragData: vi.fn(),
        },
        configurable: true,
        writable: true,
      });
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      const result = await ctrl.getDraggedPaths(createDragEvent('drop'));
      expect(result).toEqual(['/shared.txt']);
    });

    it('returns empty when all fallbacks return nothing', async () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      const result = await ctrl.getDraggedPaths(createDragEvent('drop'));
      expect(result).toEqual([]);
    });

    it('falls back to file entries when text payload is a non-path JSON string', async () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      const result = await ctrl.getDraggedPaths(
        createDragEvent('drop', {
          textData: JSON.stringify('id=6571367.6378738'),
          files: [{ path: '/real-file.txt' }] as never,
        })
      );
      expect(result).toEqual(['/real-file.txt']);
    });

    it('ignores file entries that do not expose a path', async () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      const result = await ctrl.getDraggedPaths(
        createDragEvent('drop', {
          files: [{} as never],
        })
      );
      expect(result).toEqual([]);
    });

    it('supports windows file:// drive URLs with host-style drive letters', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        const { config } = createConfig();
        const ctrl = createDragDropController(config);
        const result = await ctrl.getDraggedPaths(
          createDragEvent('drop', {
            textData: 'file://C:/Users/test/file.txt',
          })
        );
        expect(result).toEqual(['C:/Users/test/file.txt']);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('returns empty paths when shared drag-data lookup fails', async () => {
      Object.defineProperty(window, 'electronAPI', {
        value: {
          getDragData: vi.fn().mockRejectedValue(new Error('ipc unavailable')),
          copyItems: vi.fn(),
          moveItems: vi.fn(),
          clearDragData: vi.fn(),
        },
        configurable: true,
        writable: true,
      });
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      const result = await ctrl.getDraggedPaths(createDragEvent('drop'));
      expect(result).toEqual([]);
    });
  });

  describe('showDropIndicator', () => {
    it('shows Move action label', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.showDropIndicator('move', '/dest', 10, 10);
      expect(document.getElementById('drop-indicator-action')!.textContent).toBe('Move');
    });

    it('shows Add action label', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.showDropIndicator('add' as 'copy', '/dest', 10, 10);
      expect(document.getElementById('drop-indicator-action')!.textContent).toBe('Add');
    });

    it('does nothing when indicator elements are missing', () => {
      document.body.innerHTML = '';
      const { config } = createConfig();
      const ctrl = createDragDropController(config);

      ctrl.showDropIndicator('copy', '/dest', 0, 0);
    });

    it('uses full path as label when basename is empty', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.showDropIndicator('copy', '/', 0, 0);
      expect(document.getElementById('drop-indicator-path')!.textContent).toBe('/');
    });
  });

  describe('hideDropIndicator', () => {
    it('does nothing when indicator element is missing', () => {
      document.body.innerHTML = '';
      const { config } = createConfig();
      const ctrl = createDragDropController(config);

      ctrl.hideDropIndicator();
    });
  });

  describe('scheduleSpringLoad / clearSpringLoad', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('runs spring load action after delay', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      const target = document.createElement('div');
      const action = vi.fn();

      ctrl.scheduleSpringLoad(target, action);

      vi.advanceTimersByTime(400);
      expect(target.classList.contains('spring-loading')).toBe(true);

      vi.advanceTimersByTime(400);
      expect(action).toHaveBeenCalledTimes(1);
      expect(target.classList.contains('spring-loading')).toBe(false);
    });

    it('cancels previous spring load when target changes', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      const target1 = document.createElement('div');
      const target2 = document.createElement('div');
      const action1 = vi.fn();
      const action2 = vi.fn();

      ctrl.scheduleSpringLoad(target1, action1);
      vi.advanceTimersByTime(100);
      ctrl.scheduleSpringLoad(target2, action2);

      vi.advanceTimersByTime(800);
      expect(action1).not.toHaveBeenCalled();
      expect(action2).toHaveBeenCalledTimes(1);
    });

    it('does not re-schedule for same target', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      const target = document.createElement('div');
      const action1 = vi.fn();
      const action2 = vi.fn();

      ctrl.scheduleSpringLoad(target, action1);
      ctrl.scheduleSpringLoad(target, action2);

      vi.advanceTimersByTime(800);
      expect(action1).toHaveBeenCalledTimes(1);
      expect(action2).not.toHaveBeenCalled();
    });

    it('clearSpringLoad cancels pending spring load', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      const target = document.createElement('div');
      const action = vi.fn();

      ctrl.scheduleSpringLoad(target, action);
      vi.advanceTimersByTime(400);
      ctrl.clearSpringLoad(target);

      vi.advanceTimersByTime(800);
      expect(action).not.toHaveBeenCalled();
      expect(target.classList.contains('spring-loading')).toBe(false);
    });

    it('clearSpringLoad with no arg clears any spring load', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      const target = document.createElement('div');
      const action = vi.fn();

      ctrl.scheduleSpringLoad(target, action);
      ctrl.clearSpringLoad();

      vi.advanceTimersByTime(800);
      expect(action).not.toHaveBeenCalled();
    });

    it('clearSpringLoad ignores different target', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      const target = document.createElement('div');
      const otherTarget = document.createElement('div');
      const action = vi.fn();

      ctrl.scheduleSpringLoad(target, action);
      ctrl.clearSpringLoad(otherTarget);

      vi.advanceTimersByTime(800);
      expect(action).toHaveBeenCalledTimes(1);
    });
  });

  describe('initDragAndDropListeners', () => {
    it('does not throw when grid/view elements are null', () => {
      document.body.innerHTML = '';
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      expect(() => ctrl.initDragAndDropListeners()).not.toThrow();
    });
  });

  describe('initFileGridDragAndDrop — event dispatching', () => {
    it('adds drag-over class and shows indicator on dragover (non file-item target)', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileGrid = document.getElementById('file-grid')!;
      const dragover = createDragEvent('dragover', { clientX: 100, clientY: 200 });
      Object.defineProperty(dragover, 'target', { value: fileGrid });
      fileGrid.dispatchEvent(dragover);

      expect(fileGrid.classList.contains('drag-over')).toBe(true);
      expect(config.consumeEvent).toHaveBeenCalled();
      expect(document.getElementById('drop-indicator')!.style.display).toBe('inline-flex');
    });

    it('sets dropEffect to "none" when getCurrentPath returns empty', () => {
      const { config } = createConfig({ currentPath: '' });
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileGrid = document.getElementById('file-grid')!;
      const dragover = createDragEvent('dragover');
      Object.defineProperty(dragover, 'target', { value: fileGrid });
      fileGrid.dispatchEvent(dragover);

      expect((dragover as any).dataTransfer.dropEffect).toBe('none');
    });

    it('shows "Copy" indicator when ctrlKey held on dragover', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileGrid = document.getElementById('file-grid')!;
      const dragover = createDragEvent('dragover', { ctrlKey: true, clientX: 10, clientY: 10 });
      Object.defineProperty(dragover, 'target', { value: fileGrid });
      fileGrid.dispatchEvent(dragover);

      expect((dragover as any).dataTransfer.dropEffect).toBe('copy');
      expect(document.getElementById('drop-indicator-action')!.textContent).toBe('Copy');
    });

    it('returns early on dragover when target is a .file-item', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileItem = document.querySelector('#file-grid .file-item') as HTMLElement;
      const dragover = createDragEvent('dragover');
      fileItem.dispatchEvent(dragover);

      expect(config.consumeEvent).not.toHaveBeenCalled();
    });

    it('removes drag-over class on dragleave when cursor exits bounds', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileGrid = document.getElementById('file-grid')!;
      fileGrid.classList.add('drag-over');
      fileGrid.getBoundingClientRect = () =>
        ({ left: 0, right: 500, top: 0, bottom: 500 }) as DOMRect;

      const dragleave = createDragEvent('dragleave', { clientX: 600, clientY: 600 });
      fileGrid.dispatchEvent(dragleave);

      expect(fileGrid.classList.contains('drag-over')).toBe(false);
      expect(document.getElementById('drop-indicator')!.style.display).toBe('none');
    });

    it('keeps drag-over class on dragleave when cursor is within bounds', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileGrid = document.getElementById('file-grid')!;
      fileGrid.classList.add('drag-over');
      fileGrid.getBoundingClientRect = () =>
        ({ left: 0, right: 500, top: 0, bottom: 500 }) as DOMRect;

      const dragleave = createDragEvent('dragleave', { clientX: 250, clientY: 250 });
      fileGrid.dispatchEvent(dragleave);

      expect(fileGrid.classList.contains('drag-over')).toBe(true);
    });

    it('returns early on drop when target is a .file-item', async () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileItem = document.querySelector('#file-grid .file-item') as HTMLElement;
      const dropEvt = createDragEvent('drop', {
        textData: JSON.stringify(['/other/file.txt']),
      });
      fileItem.dispatchEvent(dropEvt);
      await Promise.resolve();

      const electronAPI = (window as any).electronAPI;
      expect(electronAPI.moveItems).not.toHaveBeenCalled();
      expect(electronAPI.copyItems).not.toHaveBeenCalled();
    });

    it('hides indicator when drop has no dragged paths', async () => {
      const { config, showToast } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileGrid = document.getElementById('file-grid')!;
      const dropEvt = createDragEvent('drop', { textData: '' });
      Object.defineProperty(dropEvt, 'target', { value: fileGrid });
      fileGrid.dispatchEvent(dropEvt);
      await Promise.resolve();

      expect(showToast).not.toHaveBeenCalled();
    });

    it('handles non-array JSON drop payloads without throwing', async () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileGrid = document.getElementById('file-grid')!;
      const dropEvt = createDragEvent('drop', {
        textData: JSON.stringify('id=6571367.6378738'),
      });
      Object.defineProperty(dropEvt, 'target', { value: fileGrid });
      fileGrid.dispatchEvent(dropEvt);
      await flushPromises();

      const electronAPI = (window as any).electronAPI;
      expect(electronAPI.moveItems).not.toHaveBeenCalled();
      expect(electronAPI.copyItems).not.toHaveBeenCalled();
      expect(document.getElementById('drop-indicator')!.style.display).toBe('none');
    });

    it('performs move on drop (default, no modifier key)', async () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileGrid = document.getElementById('file-grid')!;
      const dropEvt = createDragEvent('drop', {
        textData: JSON.stringify(['/other/file.txt']),
      });
      Object.defineProperty(dropEvt, 'target', { value: fileGrid });
      fileGrid.dispatchEvent(dropEvt);
      await flushPromises();

      const electronAPI = (window as any).electronAPI;
      expect(electronAPI.moveItems).toHaveBeenCalledWith(['/other/file.txt'], '/dest', 'ask');
      expect(config.updateUndoRedoState).toHaveBeenCalled();
    });

    it('performs copy on drop when ctrlKey is held', async () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileGrid = document.getElementById('file-grid')!;
      const dropEvt = createDragEvent('drop', {
        textData: JSON.stringify(['/other/file.txt']),
        ctrlKey: true,
      });
      Object.defineProperty(dropEvt, 'target', { value: fileGrid });
      fileGrid.dispatchEvent(dropEvt);
      await flushPromises();

      const electronAPI = (window as any).electronAPI;
      expect(electronAPI.copyItems).toHaveBeenCalledWith(['/other/file.txt'], '/dest', 'ask');
      expect(electronAPI.moveItems).not.toHaveBeenCalled();
    });

    it('shows toast when dragged path equals destination (same file)', async () => {
      const { config, showToast } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileGrid = document.getElementById('file-grid')!;
      const dropEvt = createDragEvent('drop', {
        textData: JSON.stringify(['/dest']),
      });
      Object.defineProperty(dropEvt, 'target', { value: fileGrid });
      fileGrid.dispatchEvent(dropEvt);
      await Promise.resolve();

      expect(showToast).toHaveBeenCalledWith('Items are already in this directory', 'Info', 'info');
    });
  });

  describe('initFileViewDragAndDrop — event dispatching', () => {
    it('adds drag-over class on dragover when target is NOT a content item', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileView = document.getElementById('file-view')!;
      const dragover = createDragEvent('dragover', { clientX: 50, clientY: 50 });
      Object.defineProperty(dragover, 'target', { value: fileView });
      fileView.dispatchEvent(dragover);

      expect(fileView.classList.contains('drag-over')).toBe(true);
      expect(config.consumeEvent).toHaveBeenCalled();
    });

    it('returns early on dragover when target is a .column-item (content item)', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const columnItem = document.querySelector('.column-item') as HTMLElement;
      const dragover = createDragEvent('dragover');
      columnItem.dispatchEvent(dragover);

      expect(config.consumeEvent).not.toHaveBeenCalled();
    });

    it('sets dropEffect to "none" on file-view dragover when no currentPath', () => {
      const { config } = createConfig({ currentPath: '' });
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileView = document.getElementById('file-view')!;
      const dragover = createDragEvent('dragover');
      Object.defineProperty(dragover, 'target', { value: fileView });
      fileView.dispatchEvent(dragover);

      expect((dragover as any).dataTransfer.dropEffect).toBe('none');
    });

    it('removes drag-over class on file-view dragleave when cursor exits bounds', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileView = document.getElementById('file-view')!;
      fileView.classList.add('drag-over');
      fileView.getBoundingClientRect = () =>
        ({ left: 0, right: 400, top: 0, bottom: 400 }) as DOMRect;

      const dragleave = createDragEvent('dragleave', { clientX: 500, clientY: 500 });
      fileView.dispatchEvent(dragleave);

      expect(fileView.classList.contains('drag-over')).toBe(false);
    });

    it('keeps drag-over class on file-view dragleave when cursor is within bounds', () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileView = document.getElementById('file-view')!;
      fileView.classList.add('drag-over');
      fileView.getBoundingClientRect = () =>
        ({ left: 0, right: 400, top: 0, bottom: 400 }) as DOMRect;

      const dragleave = createDragEvent('dragleave', { clientX: 200, clientY: 200 });
      fileView.dispatchEvent(dragleave);

      expect(fileView.classList.contains('drag-over')).toBe(true);
    });

    it('returns early on file-view drop when target is a content item', async () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const columnItem = document.querySelector('.column-item') as HTMLElement;
      const dropEvt = createDragEvent('drop', {
        textData: JSON.stringify(['/other/file.txt']),
      });
      columnItem.dispatchEvent(dropEvt);
      await Promise.resolve();

      const electronAPI = (window as any).electronAPI;
      expect(electronAPI.moveItems).not.toHaveBeenCalled();
      expect(electronAPI.copyItems).not.toHaveBeenCalled();
    });

    it('performs move on file-view drop', async () => {
      const { config, showToast } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileView = document.getElementById('file-view')!;
      const dropEvt = createDragEvent('drop', {
        textData: JSON.stringify(['/source/data.txt']),
      });
      Object.defineProperty(dropEvt, 'target', { value: fileView });
      fileView.dispatchEvent(dropEvt);
      await flushPromises();

      const electronAPI = (window as any).electronAPI;
      expect(electronAPI.moveItems).toHaveBeenCalledWith(['/source/data.txt'], '/dest', 'ask');
      expect(showToast).toHaveBeenCalledWith('Moved 1 item(s)', 'Success', 'success');
    });

    it('shows toast when items already in current dir on file-view drop', async () => {
      const { config, showToast } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileView = document.getElementById('file-view')!;
      const dropEvt = createDragEvent('drop', {
        textData: JSON.stringify(['/dest/existing.txt']),
      });
      Object.defineProperty(dropEvt, 'target', { value: fileView });
      fileView.dispatchEvent(dropEvt);
      await Promise.resolve();

      expect(showToast).toHaveBeenCalledWith('Items are already in this directory', 'Info', 'info');
    });

    it('hides indicator when file-view drop has no dragged paths', async () => {
      const { config, showToast } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileView = document.getElementById('file-view')!;
      const dropEvt = createDragEvent('drop', { textData: '' });
      Object.defineProperty(dropEvt, 'target', { value: fileView });
      fileView.dispatchEvent(dropEvt);
      await Promise.resolve();

      expect(showToast).not.toHaveBeenCalled();
      expect(document.getElementById('drop-indicator')!.style.display).toBe('none');
    });
  });

  describe('handleDrop — move vs copy undo and multi-item', () => {
    it('calls updateUndoRedoState only for move, not copy', async () => {
      const { config } = createConfig();
      const ctrl = createDragDropController(config);

      await ctrl.handleDrop(['/a.txt'], '/dest', 'move');
      expect(config.updateUndoRedoState).toHaveBeenCalledTimes(1);

      config.updateUndoRedoState.mockClear();
      await ctrl.handleDrop(['/a.txt'], '/dest', 'copy');
      expect(config.updateUndoRedoState).not.toHaveBeenCalled();
    });

    it('reports correct count in toast for multiple items', async () => {
      const { config, showToast } = createConfig();
      const ctrl = createDragDropController(config);

      await ctrl.handleDrop(['/a.txt', '/b.txt', '/c.txt'], '/dest', 'move');

      expect(showToast).toHaveBeenCalledWith('Moved 3 item(s)', 'Success', 'success');
    });

    it('uses fileConflictBehavior from settings', async () => {
      const { config } = createConfig();
      (config as any).getCurrentSettings = () => ({ fileConflictBehavior: 'overwrite' });
      const ctrl = createDragDropController(config);

      await ctrl.handleDrop(['/a.txt'], '/dest', 'copy');

      const electronAPI = (window as any).electronAPI;
      expect(electronAPI.copyItems).toHaveBeenCalledWith(['/a.txt'], '/dest', 'overwrite');
    });

    it('defaults fileConflictBehavior to "ask" when undefined', async () => {
      const { config } = createConfig();
      (config as any).getCurrentSettings = () => ({});
      const ctrl = createDragDropController(config);

      await ctrl.handleDrop(['/a.txt'], '/dest', 'move');

      const electronAPI = (window as any).electronAPI;
      expect(electronAPI.moveItems).toHaveBeenCalledWith(['/a.txt'], '/dest', 'ask');
    });
  });

  describe('isDropIntoCurrentDirectory — edge cases via drop', () => {
    it('detects when dragPath parent matches dest (file in same dir)', async () => {
      const { config, showToast } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileGrid = document.getElementById('file-grid')!;
      const dropEvt = createDragEvent('drop', {
        textData: JSON.stringify(['/dest/somefile.txt']),
      });
      Object.defineProperty(dropEvt, 'target', { value: fileGrid });
      fileGrid.dispatchEvent(dropEvt);
      await Promise.resolve();

      expect(showToast).toHaveBeenCalledWith('Items are already in this directory', 'Info', 'info');
    });

    it('allows drop when dragged file comes from different directory', async () => {
      const { config, showToast } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileGrid = document.getElementById('file-grid')!;
      const dropEvt = createDragEvent('drop', {
        textData: JSON.stringify(['/completely-different/path.txt']),
      });
      Object.defineProperty(dropEvt, 'target', { value: fileGrid });
      fileGrid.dispatchEvent(dropEvt);
      await flushPromises();

      const electronAPI = (window as any).electronAPI;
      expect(electronAPI.moveItems).toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledWith('Moved 1 item(s)', 'Success', 'success');
    });

    it('rejects drop when any of multiple paths are in current dir', async () => {
      const { config, showToast } = createConfig();
      const ctrl = createDragDropController(config);
      ctrl.initDragAndDropListeners();

      const fileGrid = document.getElementById('file-grid')!;
      const dropEvt = createDragEvent('drop', {
        textData: JSON.stringify(['/other/ok.txt', '/dest/clash.txt']),
      });
      Object.defineProperty(dropEvt, 'target', { value: fileGrid });
      fileGrid.dispatchEvent(dropEvt);
      await Promise.resolve();

      expect(showToast).toHaveBeenCalledWith('Items are already in this directory', 'Info', 'info');
    });
  });
});
