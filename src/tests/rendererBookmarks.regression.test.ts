// @vitest-environment jsdom
/**
 * Regression tests for bookmarks.
 * N6a: addBookmarkByPath, removeBookmark, and drag-reorder must roll back
 *      in-memory state when the save to disk fails.  Previously in-memory
 *      state was mutated before the save, leaving memory/disk diverged on
 *      failure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared.js', () => ({ escapeHtml: (v: string) => v }));
vi.mock('../rendererUtils.js', () => ({
  twemojiImg: (v: string) => v,
  renderIcon: (v: string) => `<span>${v}</span>`,
}));
vi.mock('../home.js', () => ({ isHomeViewPath: (v: string) => v === 'home://' }));

import { createBookmarksController } from '../rendererBookmarks';

function createDropEvent(draggedPath: string): DragEvent {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
  Object.assign(event, {
    dataTransfer: {
      types: ['text/iyeris-bookmark'],
      getData: (key: string) => (key === 'text/iyeris-bookmark' ? draggedPath : ''),
      files: [],
    },
    clientX: 10,
    clientY: 10,
  });
  return event;
}

function createDeps(
  bookmarks: string[],
  saveResult: { success: boolean; error?: string } = { success: true }
) {
  const settings = { bookmarks: [...bookmarks] };
  return {
    deps: {
      bookmarksList: document.getElementById('bookmarks-list') as HTMLElement,
      getCurrentPath: () => '/some/path',
      getCurrentSettings: () => settings as never,
      saveSettingsWithTimestamp: vi.fn().mockResolvedValue(saveResult),
      showToast: vi.fn(),
      navigateTo: vi.fn(),
      getDraggedPaths: vi.fn().mockResolvedValue([]),
      getDragOperation: vi.fn().mockReturnValue('move'),
      handleDrop: vi.fn().mockResolvedValue(undefined),
      showDropIndicator: vi.fn(),
      hideDropIndicator: vi.fn(),
      consumeEvent: vi.fn((e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      }),
      renderHomeBookmarks: vi.fn(),
    },
    settings,
  };
}

describe('rendererBookmarks — N6a rollback on save failure', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="bookmarks-list"></div>';
    Object.defineProperty(window, 'tauriAPI', {
      value: { setDragData: vi.fn(), clearDragData: vi.fn() },
      configurable: true,
      writable: true,
    });
  });

  // addBookmarkByPath --------------------------------------------------------
  describe('addBookmarkByPath', () => {
    it('does NOT keep the bookmark in memory when save fails', async () => {
      const { deps, settings } = createDeps(['/existing'], { success: false, error: 'I/O error' });
      const ctrl = createBookmarksController(deps as any);

      await ctrl.addBookmarkByPath('/new-bookmark');

      // Memory must have been rolled back to the pre-mutation state.
      expect(settings.bookmarks).toEqual(['/existing']);
    });

    it('shows error toast on save failure', async () => {
      const { deps } = createDeps([], { success: false, error: 'disk full' });
      const ctrl = createBookmarksController(deps as any);

      await ctrl.addBookmarkByPath('/anywhere');

      expect(deps.showToast).toHaveBeenCalledWith(expect.any(String), 'Error', 'error');
    });

    it('keeps the bookmark in memory on successful save', async () => {
      const { deps, settings } = createDeps(['/existing']);
      const ctrl = createBookmarksController(deps as any);

      await ctrl.addBookmarkByPath('/new');

      expect(settings.bookmarks).toEqual(['/existing', '/new']);
    });
  });

  // removeBookmark -----------------------------------------------------------
  describe('removeBookmark', () => {
    it('does NOT remove the bookmark from memory when save fails', async () => {
      const { deps, settings } = createDeps(['/a', '/b'], {
        success: false,
        error: 'write error',
      });
      const ctrl = createBookmarksController(deps as any);

      await ctrl.removeBookmark('/a');

      // Rollback: /a must still be in bookmarks.
      expect(settings.bookmarks).toContain('/a');
    });

    it('shows error toast on save failure', async () => {
      const { deps } = createDeps(['/a'], { success: false });
      const ctrl = createBookmarksController(deps as any);

      await ctrl.removeBookmark('/a');

      expect(deps.showToast).toHaveBeenCalledWith(expect.any(String), 'Error', 'error');
    });

    it('removes the bookmark from memory on successful save', async () => {
      const { deps, settings } = createDeps(['/a', '/b']);
      const ctrl = createBookmarksController(deps as any);

      await ctrl.removeBookmark('/a');

      expect(settings.bookmarks).toEqual(['/b']);
    });
  });

  // drag reorder -------------------------------------------------------------
  describe('drag-reorder', () => {
    it('rolls back reorder in memory when save fails', async () => {
      const { deps, settings } = createDeps(['/a', '/b', '/c'], {
        success: false,
        error: 'write error',
      });
      const ctrl = createBookmarksController(deps as any);
      ctrl.loadBookmarks();

      const bookmarkItems = deps.bookmarksList.querySelectorAll<HTMLElement>('.bookmark-item');

      // Drag '/a' onto '/b'.
      bookmarkItems[1]!.dispatchEvent(createDropEvent('/a'));
      await Promise.resolve();

      // Rollback: order must be unchanged.
      expect(settings.bookmarks).toEqual(['/a', '/b', '/c']);
    });

    it('applies reorder in memory on successful save', async () => {
      const { deps, settings } = createDeps(['/a', '/b', '/c']);
      const ctrl = createBookmarksController(deps as any);
      ctrl.loadBookmarks();

      const bookmarkItems = deps.bookmarksList.querySelectorAll<HTMLElement>('.bookmark-item');

      bookmarkItems[1]!.dispatchEvent(createDropEvent('/a'));
      await Promise.resolve();

      // '/a' moved after '/b'.
      expect(settings.bookmarks).toEqual(['/b', '/a', '/c']);
    });
  });
});
