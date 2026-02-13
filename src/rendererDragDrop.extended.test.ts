/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDragDropController } from './rendererDragDrop';

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
      <div id="file-view"></div>
      <div id="file-grid"></div>
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
      // copy should NOT call updateUndoRedoState
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

      expect(showToast).toHaveBeenCalledWith('disk full', 'Error', 'error');
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

      expect(showToast).toHaveBeenCalledWith('Failed to move items', 'Error', 'error');
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

      expect(showToast).toHaveBeenCalledWith('Failed to copy items', 'Error', 'error');
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
      // getDragData returns null
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
      // Should not throw
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
      // Should not throw
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

      // After half the delay, the spring-loading class is added
      vi.advanceTimersByTime(400);
      expect(target.classList.contains('spring-loading')).toBe(true);

      // After full delay, action fires
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
      ctrl.scheduleSpringLoad(target, action2); // same target, should be ignored

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
      ctrl.clearSpringLoad(); // no arg

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
      ctrl.clearSpringLoad(otherTarget); // different target, should not cancel

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
});
