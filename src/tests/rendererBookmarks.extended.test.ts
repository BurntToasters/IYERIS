// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../shared.js', () => ({
  escapeHtml: (value: string) => value,
}));

vi.mock('../rendererUtils.js', () => ({
  twemojiImg: (value: string) => value,
}));

vi.mock('../home.js', () => ({
  isHomeViewPath: (value: string) => value === 'home://',
}));

import { createBookmarksController } from '../rendererBookmarks';

function createDeps(bookmarks: string[], currentPath = '/test') {
  const settings = { bookmarks } as any;

  const deps = {
    bookmarksList: document.getElementById('bookmarks-list') as HTMLElement,
    getCurrentPath: vi.fn(() => currentPath),
    getCurrentSettings: vi.fn(() => settings),
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
    showToast: vi.fn(),
    navigateTo: vi.fn(),
    getDraggedPaths: vi.fn().mockResolvedValue([]),
    getDragOperation: vi.fn().mockReturnValue('copy' as any),
    handleDrop: vi.fn().mockResolvedValue(undefined),
    showDropIndicator: vi.fn(),
    hideDropIndicator: vi.fn(),
    consumeEvent: vi.fn((event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    }),
    renderHomeBookmarks: vi.fn(),
  };

  return { deps, settings };
}

function createDragEvent(type: string, overrides: Record<string, unknown> = {}): DragEvent {
  const evt = new Event(type, { bubbles: true, cancelable: true }) as any;
  evt.clientX = 10;
  evt.clientY = 20;
  evt.dataTransfer = null;
  Object.assign(evt, overrides);
  return evt as DragEvent;
}

function createDragEventWithTransfer(
  type: string,
  types: string[] = [],
  data: Record<string, string> = {},
  extra: Record<string, unknown> = {}
): DragEvent {
  const evt = new Event(type, { bubbles: true, cancelable: true }) as any;
  evt.clientX = extra.clientX ?? 10;
  evt.clientY = extra.clientY ?? 20;
  evt.dataTransfer = {
    types,
    getData: (key: string) => data[key] ?? '',
    setData: vi.fn(),
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
  };
  Object.assign(evt, extra);
  return evt as DragEvent;
}

function flushPromises() {
  return new Promise<void>((r) => setTimeout(r, 0));
}

describe('rendererBookmarks extended', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="bookmarks-list"></div>';
    (window as any).electronAPI = {
      getItemProperties: vi.fn().mockResolvedValue({
        success: true,
        properties: { isDirectory: true },
      }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadBookmarks', () => {
    it('returns early when bookmarksList is null', () => {
      const settings = { bookmarks: ['/a'] } as any;
      const deps = {
        bookmarksList: null,
        getCurrentPath: vi.fn(() => '/a'),
        getCurrentSettings: vi.fn(() => settings),
        saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
        showToast: vi.fn(),
        navigateTo: vi.fn(),
        getDraggedPaths: vi.fn().mockResolvedValue([]),
        getDragOperation: vi.fn().mockReturnValue('copy' as any),
        handleDrop: vi.fn().mockResolvedValue(undefined),
        showDropIndicator: vi.fn(),
        hideDropIndicator: vi.fn(),
        consumeEvent: vi.fn(),
        renderHomeBookmarks: vi.fn(),
      };

      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();
      expect(deps.renderHomeBookmarks).not.toHaveBeenCalled();
    });

    it('renders empty state when bookmarks is undefined', () => {
      const settings = {} as any;
      const deps = {
        bookmarksList: document.getElementById('bookmarks-list') as HTMLElement,
        getCurrentPath: vi.fn(() => '/a'),
        getCurrentSettings: vi.fn(() => settings),
        saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
        showToast: vi.fn(),
        navigateTo: vi.fn(),
        getDraggedPaths: vi.fn().mockResolvedValue([]),
        getDragOperation: vi.fn().mockReturnValue('copy' as any),
        handleDrop: vi.fn().mockResolvedValue(undefined),
        showDropIndicator: vi.fn(),
        hideDropIndicator: vi.fn(),
        consumeEvent: vi.fn(),
        renderHomeBookmarks: vi.fn(),
      };

      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      expect(deps.bookmarksList.innerHTML).toContain('No bookmarks yet');
      expect(deps.renderHomeBookmarks).toHaveBeenCalled();
    });

    it('uses bookmarkPath as name when path ends with separator (empty last segment)', () => {
      const { deps } = createDeps(['/']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const items = deps.bookmarksList.querySelectorAll('.bookmark-item');
      expect(items.length).toBe(1);

      expect(items[0].getAttribute('aria-label')).toContain('/');
    });

    it('renders bookmark items with correct attributes', () => {
      const { deps } = createDeps(['/projects/myapp', '/downloads']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const items = deps.bookmarksList.querySelectorAll<HTMLElement>('.bookmark-item');
      expect(items.length).toBe(2);
      expect(items[0].dataset.path).toBe('/projects/myapp');
      expect(items[0].getAttribute('role')).toBe('button');
      expect(items[0].tabIndex).toBe(0);
      expect(items[0].getAttribute('aria-label')).toBe('Open bookmark myapp');
      expect(items[0].draggable).toBe(true);
    });

    it('calls renderHomeBookmarks after loading bookmarks', () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();
      expect(deps.renderHomeBookmarks).toHaveBeenCalled();
    });

    it('sets bookmarksDropReady flag and only registers list listeners once', () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);

      const addSpy = vi.spyOn(deps.bookmarksList, 'addEventListener');
      controller.loadBookmarks();
      const firstCallCount = addSpy.mock.calls.length;

      addSpy.mockClear();
      controller.loadBookmarks();
      const secondCallCount = addSpy.mock.calls.length;

      expect(secondCallCount).toBeLessThan(firstCallCount);
    });
  });

  describe('bookmark item click handler', () => {
    it('navigates on click when target is not the remove button', () => {
      const { deps } = createDeps(['/projects']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      item.click();

      expect(deps.navigateTo).toHaveBeenCalledWith('/projects');
    });

    it('does not navigate when clicking the remove button', () => {
      const { deps } = createDeps(['/projects']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const removeBtn = deps.bookmarksList.querySelector('.bookmark-remove') as HTMLElement;
      removeBtn.click();

      expect(deps.navigateTo).not.toHaveBeenCalled();
    });
  });

  describe('bookmark item keydown handler', () => {
    it('navigates on Enter key', () => {
      const { deps } = createDeps(['/projects']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      const preventSpy = vi.spyOn(evt, 'preventDefault');
      item.dispatchEvent(evt);

      expect(preventSpy).toHaveBeenCalled();
      expect(deps.navigateTo).toHaveBeenCalledWith('/projects');
    });

    it('navigates on Space key', () => {
      const { deps } = createDeps(['/projects']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      const evt = new KeyboardEvent('keydown', { key: ' ', bubbles: true });
      const preventSpy = vi.spyOn(evt, 'preventDefault');
      item.dispatchEvent(evt);

      expect(preventSpy).toHaveBeenCalled();
      expect(deps.navigateTo).toHaveBeenCalledWith('/projects');
    });

    it('does not navigate on other keys', () => {
      const { deps } = createDeps(['/projects']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
      item.dispatchEvent(evt);

      expect(deps.navigateTo).not.toHaveBeenCalled();
    });
  });

  describe('bookmark remove button', () => {
    it('calls removeBookmark and stops propagation', async () => {
      const { deps } = createDeps(['/projects', '/downloads']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const removeBtn = deps.bookmarksList.querySelector('.bookmark-remove') as HTMLElement;
      removeBtn.click();
      await flushPromises();

      expect(deps.saveSettingsWithTimestamp).toHaveBeenCalled();
    });
  });

  describe('bookmark item dragstart', () => {
    it('adds dragging class and sets transfer data', () => {
      const { deps } = createDeps(['/projects']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      const evt = createDragEventWithTransfer('dragstart', [], {});
      item.dispatchEvent(evt);

      expect(item.classList.contains('dragging')).toBe(true);
      expect((evt as any).dataTransfer.effectAllowed).toBe('move');
      expect((evt as any).dataTransfer.setData).toHaveBeenCalledWith(
        'text/iyeris-bookmark',
        '/projects'
      );
    });

    it('returns early when dataTransfer is null', () => {
      const { deps } = createDeps(['/projects']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      const evt = createDragEvent('dragstart');
      item.dispatchEvent(evt);

      expect(item.classList.contains('dragging')).toBe(true);
    });
  });

  describe('bookmark item dragend', () => {
    it('removes dragging and drag-over classes and hides indicator', () => {
      const { deps } = createDeps(['/projects']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      item.classList.add('dragging');
      item.classList.add('drag-over');

      const evt = createDragEvent('dragend');
      item.dispatchEvent(evt);

      expect(item.classList.contains('dragging')).toBe(false);
      expect(item.classList.contains('drag-over')).toBe(false);
      expect(deps.hideDropIndicator).toHaveBeenCalled();
    });
  });

  describe('bookmark item dragover', () => {
    it('sets move effect for bookmark drags and does not show drop indicator', () => {
      const { deps } = createDeps(['/a', '/b']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const items = deps.bookmarksList.querySelectorAll('.bookmark-item');
      const evt = createDragEventWithTransfer('dragover', ['text/iyeris-bookmark']);
      items[0].dispatchEvent(evt);

      expect(deps.consumeEvent).toHaveBeenCalled();
      expect((evt as any).dataTransfer.dropEffect).toBe('move');
      expect((items[0] as HTMLElement).classList.contains('drag-over')).toBe(true);
      expect(deps.showDropIndicator).not.toHaveBeenCalled();
    });

    it('sets file drop effect and shows indicator for non-bookmark drags', () => {
      const { deps } = createDeps(['/a']);
      deps.getDragOperation.mockReturnValue('copy');
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      const evt = createDragEventWithTransfer(
        'dragover',
        ['Files'],
        {},
        { clientX: 50, clientY: 60 }
      );
      item.dispatchEvent(evt);

      expect((evt as any).dataTransfer.dropEffect).toBe('copy');
      expect(item.classList.contains('drag-over')).toBe(true);
      expect(deps.showDropIndicator).toHaveBeenCalledWith('copy', '/a', 50, 60);
    });

    it('returns early when dataTransfer is null', () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      const evt = createDragEvent('dragover');
      item.dispatchEvent(evt);

      expect(deps.consumeEvent).toHaveBeenCalled();
      expect(deps.showDropIndicator).not.toHaveBeenCalled();
    });
  });

  describe('bookmark item dragleave', () => {
    it('removes drag-over class when leaving element bounds', () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      item.classList.add('drag-over');

      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 100,
        top: 0,
        bottom: 50,
        width: 100,
        height: 50,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const evt = createDragEventWithTransfer('dragleave', [], {}, { clientX: -5, clientY: 25 });
      item.dispatchEvent(evt);

      expect(deps.consumeEvent).toHaveBeenCalled();
      expect(item.classList.contains('drag-over')).toBe(false);
      expect(deps.hideDropIndicator).toHaveBeenCalled();
    });

    it('removes drag-over when leaving from right side', () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      item.classList.add('drag-over');

      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 100,
        top: 0,
        bottom: 50,
        width: 100,
        height: 50,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const evt = createDragEventWithTransfer('dragleave', [], {}, { clientX: 150, clientY: 25 });
      item.dispatchEvent(evt);

      expect(item.classList.contains('drag-over')).toBe(false);
    });

    it('removes drag-over when leaving from top', () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      item.classList.add('drag-over');

      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 100,
        top: 0,
        bottom: 50,
        width: 100,
        height: 50,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const evt = createDragEventWithTransfer('dragleave', [], {}, { clientX: 50, clientY: -5 });
      item.dispatchEvent(evt);

      expect(item.classList.contains('drag-over')).toBe(false);
    });

    it('removes drag-over when leaving from bottom', () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      item.classList.add('drag-over');

      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 100,
        top: 0,
        bottom: 50,
        width: 100,
        height: 50,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const evt = createDragEventWithTransfer('dragleave', [], {}, { clientX: 50, clientY: 100 });
      item.dispatchEvent(evt);

      expect(item.classList.contains('drag-over')).toBe(false);
    });

    it('does not remove drag-over class when still within bounds', () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      item.classList.add('drag-over');

      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 100,
        top: 0,
        bottom: 50,
        width: 100,
        height: 50,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const evt = createDragEventWithTransfer('dragleave', [], {}, { clientX: 50, clientY: 25 });
      item.dispatchEvent(evt);

      expect(item.classList.contains('drag-over')).toBe(true);
    });
  });

  describe('bookmark item drop - bookmark reorder', () => {
    it('returns early when draggedPath is empty', async () => {
      const { deps } = createDeps(['/a', '/b']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const items = deps.bookmarksList.querySelectorAll('.bookmark-item');
      const evt = createDragEventWithTransfer('drop', ['text/iyeris-bookmark'], {
        'text/iyeris-bookmark': '',
      });
      items[1].dispatchEvent(evt);
      await flushPromises();

      expect(deps.saveSettingsWithTimestamp).not.toHaveBeenCalled();
    });

    it('returns early when dragged path equals target path', async () => {
      const { deps } = createDeps(['/a', '/b']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const items = deps.bookmarksList.querySelectorAll('.bookmark-item');
      const evt = createDragEventWithTransfer('drop', ['text/iyeris-bookmark'], {
        'text/iyeris-bookmark': '/b',
      });
      items[1].dispatchEvent(evt);
      await flushPromises();

      expect(deps.saveSettingsWithTimestamp).not.toHaveBeenCalled();
    });

    it('returns early when bookmarks is undefined', async () => {
      const settingsWithBookmarks = { bookmarks: ['/a', '/b'] } as any;
      const settingsWithout = { bookmarks: undefined } as any;
      let callCount = 0;
      const deps = {
        bookmarksList: document.getElementById('bookmarks-list') as HTMLElement,
        getCurrentPath: vi.fn(() => '/a'),
        getCurrentSettings: vi.fn(() => {
          callCount++;
          return callCount <= 1 ? settingsWithBookmarks : settingsWithout;
        }),
        saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
        showToast: vi.fn(),
        navigateTo: vi.fn(),
        getDraggedPaths: vi.fn().mockResolvedValue([]),
        getDragOperation: vi.fn().mockReturnValue('copy' as any),
        handleDrop: vi.fn().mockResolvedValue(undefined),
        showDropIndicator: vi.fn(),
        hideDropIndicator: vi.fn(),
        consumeEvent: vi.fn(),
        renderHomeBookmarks: vi.fn(),
      };

      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const items = deps.bookmarksList.querySelectorAll('.bookmark-item');
      const evt = createDragEventWithTransfer('drop', ['text/iyeris-bookmark'], {
        'text/iyeris-bookmark': '/a',
      });
      items[1].dispatchEvent(evt);
      await flushPromises();

      expect(deps.saveSettingsWithTimestamp).not.toHaveBeenCalled();
    });

    it('returns early when fromIndex is -1', async () => {
      const { deps } = createDeps(['/a', '/b']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const items = deps.bookmarksList.querySelectorAll('.bookmark-item');
      const evt = createDragEventWithTransfer('drop', ['text/iyeris-bookmark'], {
        'text/iyeris-bookmark': '/nonexistent',
      });
      items[0].dispatchEvent(evt);
      await flushPromises();

      expect(deps.saveSettingsWithTimestamp).not.toHaveBeenCalled();
    });

    it('shows error toast when reorder save fails', async () => {
      const { deps } = createDeps(['/a', '/b']);
      deps.saveSettingsWithTimestamp.mockResolvedValue({ success: false, error: 'disk full' });
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const items = deps.bookmarksList.querySelectorAll('.bookmark-item');
      const evt = createDragEventWithTransfer('drop', ['text/iyeris-bookmark'], {
        'text/iyeris-bookmark': '/a',
      });
      items[1].dispatchEvent(evt);
      await flushPromises();

      expect(deps.showToast).toHaveBeenCalledWith(
        'Failed to reorder bookmarks',
        'Bookmarks',
        'error'
      );
      expect(deps.hideDropIndicator).toHaveBeenCalled();
    });

    it('reorders and reloads on success', async () => {
      const { deps, settings } = createDeps(['/a', '/b']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const items = deps.bookmarksList.querySelectorAll('.bookmark-item');
      const evt = createDragEventWithTransfer('drop', ['text/iyeris-bookmark'], {
        'text/iyeris-bookmark': '/a',
      });
      items[1].dispatchEvent(evt);
      await flushPromises();

      expect(settings.bookmarks).toEqual(['/b', '/a']);
      expect(deps.hideDropIndicator).toHaveBeenCalled();
    });
  });

  describe('bookmark item drop - file drop', () => {
    it('handles file drop on a bookmark item', async () => {
      const { deps } = createDeps(['/projects']);
      deps.getDraggedPaths.mockResolvedValue(['/downloads/file.txt']);
      deps.getDragOperation.mockReturnValue('copy');
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      const evt = createDragEventWithTransfer('drop', ['Files'], {});
      item.dispatchEvent(evt);
      await flushPromises();

      expect(deps.getDraggedPaths).toHaveBeenCalled();
      expect(deps.handleDrop).toHaveBeenCalledWith(['/downloads/file.txt'], '/projects', 'copy');
      expect(deps.hideDropIndicator).toHaveBeenCalled();
    });

    it('returns early when dragged paths is empty for non-bookmark drop', async () => {
      const { deps } = createDeps(['/projects']);
      deps.getDraggedPaths.mockResolvedValue([]);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      const evt = createDragEventWithTransfer('drop', ['Files'], {});
      item.dispatchEvent(evt);
      await flushPromises();

      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('handles drop with no dataTransfer (null check)', async () => {
      const { deps } = createDeps(['/projects']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      const evt = createDragEvent('drop');
      item.dispatchEvent(evt);
      await flushPromises();

      expect(deps.consumeEvent).toHaveBeenCalled();
    });
  });

  describe('bookmarksList dragover handler', () => {
    it('shows add indicator for non-bookmark file drags', () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const evt = createDragEventWithTransfer(
        'dragover',
        ['Files'],
        {},
        { clientX: 30, clientY: 40 }
      );
      deps.bookmarksList.dispatchEvent(evt);

      expect(deps.consumeEvent).toHaveBeenCalled();
      expect(deps.bookmarksList.classList.contains('drag-over')).toBe(true);
      expect((evt as any).dataTransfer.dropEffect).toBe('copy');
      expect(deps.showDropIndicator).toHaveBeenCalledWith('add', 'Bookmarks', 30, 40);
    });

    it('returns early when dataTransfer is null', () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const evt = createDragEvent('dragover');
      deps.bookmarksList.dispatchEvent(evt);

      expect(deps.showDropIndicator).not.toHaveBeenCalled();
    });

    it('returns early for bookmark-type drags', () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const evt = createDragEventWithTransfer('dragover', ['text/iyeris-bookmark']);
      deps.bookmarksList.dispatchEvent(evt);

      expect(deps.showDropIndicator).not.toHaveBeenCalled();
    });
  });

  describe('bookmarksList dragleave handler', () => {
    it('removes drag-over when leaving list bounds from left', () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      deps.bookmarksList.classList.add('drag-over');
      vi.spyOn(deps.bookmarksList, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 200,
        top: 0,
        bottom: 300,
        width: 200,
        height: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const evt = createDragEventWithTransfer('dragleave', [], {}, { clientX: -10, clientY: 150 });
      deps.bookmarksList.dispatchEvent(evt);

      expect(deps.bookmarksList.classList.contains('drag-over')).toBe(false);
      expect(deps.hideDropIndicator).toHaveBeenCalled();
    });

    it('removes drag-over when leaving list bounds from bottom', () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      deps.bookmarksList.classList.add('drag-over');
      vi.spyOn(deps.bookmarksList, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 200,
        top: 0,
        bottom: 300,
        width: 200,
        height: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const evt = createDragEventWithTransfer('dragleave', [], {}, { clientX: 100, clientY: 350 });
      deps.bookmarksList.dispatchEvent(evt);

      expect(deps.bookmarksList.classList.contains('drag-over')).toBe(false);
    });

    it('keeps drag-over when still within list bounds', () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      deps.bookmarksList.classList.add('drag-over');
      vi.spyOn(deps.bookmarksList, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 200,
        top: 0,
        bottom: 300,
        width: 200,
        height: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const evt = createDragEventWithTransfer('dragleave', [], {}, { clientX: 100, clientY: 150 });
      deps.bookmarksList.dispatchEvent(evt);

      expect(deps.bookmarksList.classList.contains('drag-over')).toBe(true);
    });
  });

  describe('bookmarksList drop handler', () => {
    it('returns early when dataTransfer is null', async () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const evt = createDragEvent('drop');
      deps.bookmarksList.dispatchEvent(evt);
      await flushPromises();

      expect(deps.getDraggedPaths).not.toHaveBeenCalled();
    });

    it('hides indicator and returns for bookmark-type drops', async () => {
      const { deps } = createDeps(['/a']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const evt = createDragEventWithTransfer('drop', ['text/iyeris-bookmark'], {
        'text/iyeris-bookmark': '/a',
      });
      deps.bookmarksList.dispatchEvent(evt);
      await flushPromises();

      expect(deps.hideDropIndicator).toHaveBeenCalled();
      expect(deps.getDraggedPaths).not.toHaveBeenCalled();
    });

    it('adds a folder as bookmark when dropping a directory', async () => {
      const { deps, settings } = createDeps(['/a']);
      deps.getDraggedPaths.mockResolvedValue(['/new-folder']);
      (window as any).electronAPI.getItemProperties.mockResolvedValue({
        success: true,
        properties: { isDirectory: true },
      });
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const evt = createDragEventWithTransfer('drop', ['Files'], {});
      deps.bookmarksList.dispatchEvent(evt);
      await flushPromises();

      expect(deps.consumeEvent).toHaveBeenCalled();
      expect((window as any).electronAPI.getItemProperties).toHaveBeenCalledWith('/new-folder');
      expect(deps.saveSettingsWithTimestamp).toHaveBeenCalled();
      expect(settings.bookmarks).toContain('/new-folder');
    });

    it('shows info toast when dropping a non-directory', async () => {
      const { deps } = createDeps(['/a']);
      deps.getDraggedPaths.mockResolvedValue(['/some-file.txt']);
      (window as any).electronAPI.getItemProperties.mockResolvedValue({
        success: true,
        properties: { isDirectory: false },
      });
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const evt = createDragEventWithTransfer('drop', ['Files'], {});
      deps.bookmarksList.dispatchEvent(evt);
      await flushPromises();

      expect(deps.showToast).toHaveBeenCalledWith(
        'Only folders can be bookmarked',
        'Bookmarks',
        'info'
      );
    });

    it('shows error toast when getItemProperties returns success: false', async () => {
      const { deps } = createDeps(['/a']);
      deps.getDraggedPaths.mockResolvedValue(['/some-path']);
      (window as any).electronAPI.getItemProperties.mockResolvedValue({
        success: false,
      });
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const evt = createDragEventWithTransfer('drop', ['Files'], {});
      deps.bookmarksList.dispatchEvent(evt);
      await flushPromises();

      expect(deps.showToast).toHaveBeenCalledWith('Failed to add bookmark', 'Bookmarks', 'error');
    });

    it('shows error toast when getItemProperties throws', async () => {
      const { deps } = createDeps(['/a']);
      deps.getDraggedPaths.mockResolvedValue(['/some-path']);
      (window as any).electronAPI.getItemProperties.mockRejectedValue(new Error('fail'));
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const evt = createDragEventWithTransfer('drop', ['Files'], {});
      deps.bookmarksList.dispatchEvent(evt);
      await flushPromises();

      expect(deps.showToast).toHaveBeenCalledWith('Failed to add bookmark', 'Bookmarks', 'error');
    });

    it('returns early when draggedPaths is empty', async () => {
      const { deps } = createDeps(['/a']);
      deps.getDraggedPaths.mockResolvedValue([]);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const evt = createDragEventWithTransfer('drop', ['Files'], {});
      deps.bookmarksList.dispatchEvent(evt);
      await flushPromises();

      expect((window as any).electronAPI.getItemProperties).not.toHaveBeenCalled();
    });
  });

  describe('addBookmark', () => {
    it('shows info toast when currentPath is empty string', async () => {
      const { deps } = createDeps([], '');
      const controller = createBookmarksController(deps as any);

      await controller.addBookmark();

      expect(deps.showToast).toHaveBeenCalledWith(
        'Open a folder to add a bookmark',
        'Bookmarks',
        'info'
      );
    });

    it('shows info toast when currentPath is home view', async () => {
      const { deps } = createDeps([], 'home://');
      const controller = createBookmarksController(deps as any);

      await controller.addBookmark();

      expect(deps.showToast).toHaveBeenCalledWith(
        'Open a folder to add a bookmark',
        'Bookmarks',
        'info'
      );
    });

    it('delegates to addBookmarkByPath with current path', async () => {
      const { deps, settings } = createDeps([], '/mydir');
      const controller = createBookmarksController(deps as any);

      await controller.addBookmark();

      expect(settings.bookmarks).toContain('/mydir');
      expect(deps.saveSettingsWithTimestamp).toHaveBeenCalled();
      expect(deps.showToast).toHaveBeenCalledWith('Bookmark added', 'Bookmarks', 'success');
    });
  });

  describe('addBookmarkByPath', () => {
    it('initializes bookmarks array when undefined', async () => {
      const settings = {} as any;
      const deps = {
        bookmarksList: document.getElementById('bookmarks-list') as HTMLElement,
        getCurrentPath: vi.fn(() => '/a'),
        getCurrentSettings: vi.fn(() => settings),
        saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
        showToast: vi.fn(),
        navigateTo: vi.fn(),
        getDraggedPaths: vi.fn().mockResolvedValue([]),
        getDragOperation: vi.fn().mockReturnValue('copy' as any),
        handleDrop: vi.fn().mockResolvedValue(undefined),
        showDropIndicator: vi.fn(),
        hideDropIndicator: vi.fn(),
        consumeEvent: vi.fn(),
        renderHomeBookmarks: vi.fn(),
      };

      const controller = createBookmarksController(deps as any);
      await controller.addBookmarkByPath('/new-path');

      expect(settings.bookmarks).toEqual(['/new-path']);
      expect(deps.saveSettingsWithTimestamp).toHaveBeenCalled();
    });

    it('shows info toast when bookmark already exists', async () => {
      const { deps } = createDeps(['/existing']);
      const controller = createBookmarksController(deps as any);

      await controller.addBookmarkByPath('/existing');

      expect(deps.showToast).toHaveBeenCalledWith(
        'This folder is already bookmarked',
        'Bookmarks',
        'info'
      );
      expect(deps.saveSettingsWithTimestamp).not.toHaveBeenCalled();
    });

    it('shows error toast when save fails', async () => {
      const { deps } = createDeps([]);
      deps.saveSettingsWithTimestamp.mockResolvedValue({ success: false, error: 'fail' });
      const controller = createBookmarksController(deps as any);

      await controller.addBookmarkByPath('/new');

      expect(deps.showToast).toHaveBeenCalledWith('Failed to add bookmark', 'Error', 'error');
    });

    it('shows success toast and reloads bookmarks on success', async () => {
      const { deps } = createDeps([]);
      const controller = createBookmarksController(deps as any);

      await controller.addBookmarkByPath('/new');

      expect(deps.showToast).toHaveBeenCalledWith('Bookmark added', 'Bookmarks', 'success');
    });
  });

  describe('removeBookmark', () => {
    it('returns early when bookmarks is undefined', async () => {
      const settings = {} as any;
      const deps = {
        bookmarksList: document.getElementById('bookmarks-list') as HTMLElement,
        getCurrentPath: vi.fn(() => '/a'),
        getCurrentSettings: vi.fn(() => settings),
        saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
        showToast: vi.fn(),
        navigateTo: vi.fn(),
        getDraggedPaths: vi.fn().mockResolvedValue([]),
        getDragOperation: vi.fn().mockReturnValue('copy' as any),
        handleDrop: vi.fn().mockResolvedValue(undefined),
        showDropIndicator: vi.fn(),
        hideDropIndicator: vi.fn(),
        consumeEvent: vi.fn(),
        renderHomeBookmarks: vi.fn(),
      };

      const controller = createBookmarksController(deps as any);
      await controller.removeBookmark('/something');

      expect(deps.saveSettingsWithTimestamp).not.toHaveBeenCalled();
    });

    it('shows error toast when save fails', async () => {
      const { deps } = createDeps(['/a', '/b']);
      deps.saveSettingsWithTimestamp.mockResolvedValue({ success: false, error: 'fail' });
      const controller = createBookmarksController(deps as any);

      await controller.removeBookmark('/a');

      expect(deps.showToast).toHaveBeenCalledWith('Failed to remove bookmark', 'Error', 'error');
    });

    it('removes bookmark and shows success toast', async () => {
      const { deps, settings } = createDeps(['/a', '/b']);
      const controller = createBookmarksController(deps as any);

      await controller.removeBookmark('/a');

      expect(settings.bookmarks).toEqual(['/b']);
      expect(deps.showToast).toHaveBeenCalledWith('Bookmark removed', 'Bookmarks', 'success');
    });
  });

  describe('edge cases', () => {
    it('handles Windows-style backslash paths', () => {
      const { deps } = createDeps(['C:\\Users\\joe\\Documents']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      expect(item.getAttribute('aria-label')).toBe('Open bookmark Documents');
    });

    it('handles path that is just a filename (no separators)', () => {
      const { deps } = createDeps(['myfile']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      expect(item.getAttribute('aria-label')).toBe('Open bookmark myfile');
    });

    it('clears existing bookmarks DOM on reload', () => {
      const { deps } = createDeps(['/a', '/b']);
      const controller = createBookmarksController(deps as any);

      controller.loadBookmarks();
      expect(deps.bookmarksList.querySelectorAll('.bookmark-item').length).toBe(2);

      const settings = deps.getCurrentSettings() as any;
      settings.bookmarks = ['/c'];
      controller.loadBookmarks();

      expect(deps.bookmarksList.querySelectorAll('.bookmark-item').length).toBe(1);
      expect((deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement).dataset.path).toBe(
        '/c'
      );
    });

    it('renders bookmark HTML with icon and label', () => {
      const { deps } = createDeps(['/docs']);
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      expect(item.querySelector('.bookmark-icon')).toBeTruthy();
      expect(item.querySelector('.bookmark-label')).toBeTruthy();
      expect(item.querySelector('.bookmark-remove')).toBeTruthy();
    });

    it('handles dragover with move operation for non-bookmark drags', () => {
      const { deps } = createDeps(['/a']);
      deps.getDragOperation.mockReturnValue('move');
      const controller = createBookmarksController(deps as any);
      controller.loadBookmarks();

      const item = deps.bookmarksList.querySelector('.bookmark-item') as HTMLElement;
      const evt = createDragEventWithTransfer(
        'dragover',
        ['Files'],
        {},
        { clientX: 5, clientY: 5 }
      );
      item.dispatchEvent(evt);

      expect((evt as any).dataTransfer.dropEffect).toBe('move');
      expect(deps.showDropIndicator).toHaveBeenCalledWith('move', '/a', 5, 5);
    });
  });
});
