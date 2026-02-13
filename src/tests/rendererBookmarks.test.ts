// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

function createDropEvent(draggedBookmarkPath: string): DragEvent {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
  Object.assign(event, {
    dataTransfer: {
      types: ['text/iyeris-bookmark'],
      getData: (key: string) => (key === 'text/iyeris-bookmark' ? draggedBookmarkPath : ''),
    },
    clientX: 12,
    clientY: 20,
  });
  return event;
}

function createDeps(bookmarks: string[], currentPath: () => string) {
  const settings = { bookmarks };

  const deps = {
    bookmarksList: document.getElementById('bookmarks-list') as HTMLElement,
    getCurrentPath: currentPath,
    getCurrentSettings: () => settings as never,
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
    showToast: vi.fn(),
    navigateTo: vi.fn(),
    getDraggedPaths: vi.fn().mockResolvedValue([]),
    getDragOperation: vi.fn().mockReturnValue('move'),
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

describe('createBookmarksController', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="bookmarks-list"></div>';
    Object.defineProperty(window, 'electronAPI', {
      value: {
        getItemProperties: vi.fn().mockResolvedValue({
          success: true,
          properties: { isDirectory: true },
        }),
      },
      configurable: true,
      writable: true,
    });
  });

  it('renders empty state when no bookmarks exist', () => {
    const { deps } = createDeps([], () => '/a');
    const controller = createBookmarksController(deps);

    controller.loadBookmarks();

    expect(deps.bookmarksList.textContent).toContain('No bookmarks yet');
    expect(deps.renderHomeBookmarks).toHaveBeenCalledTimes(1);
  });

  it('prevents duplicate bookmarks', async () => {
    const { deps } = createDeps(['/projects'], () => '/projects');
    const controller = createBookmarksController(deps);

    await controller.addBookmarkByPath('/projects');

    expect(deps.saveSettingsWithTimestamp).not.toHaveBeenCalled();
    expect(deps.showToast).toHaveBeenCalledWith(
      'This folder is already bookmarked',
      'Bookmarks',
      'info'
    );
  });

  it('adds and removes bookmarks successfully', async () => {
    const { deps, settings } = createDeps(['/projects'], () => '/projects');
    const controller = createBookmarksController(deps);

    await controller.addBookmarkByPath('/downloads');
    expect(settings.bookmarks).toEqual(['/projects', '/downloads']);
    expect(deps.saveSettingsWithTimestamp).toHaveBeenCalledTimes(1);

    await controller.removeBookmark('/projects');
    expect(settings.bookmarks).toEqual(['/downloads']);
    expect(deps.saveSettingsWithTimestamp).toHaveBeenCalledTimes(2);
    expect(deps.showToast).toHaveBeenCalledWith('Bookmark removed', 'Bookmarks', 'success');
  });

  it('reorders bookmarks through bookmark drag/drop', async () => {
    const { deps, settings } = createDeps(['/a', '/b'], () => '/a');
    const controller = createBookmarksController(deps);
    controller.loadBookmarks();

    const bookmarkItems = deps.bookmarksList.querySelectorAll<HTMLElement>('.bookmark-item');
    expect(bookmarkItems.length).toBe(2);

    bookmarkItems[1].dispatchEvent(createDropEvent('/a'));
    await Promise.resolve();

    expect(settings.bookmarks).toEqual(['/b', '/a']);
    expect(deps.saveSettingsWithTimestamp).toHaveBeenCalled();
  });

  it('shows an info toast when trying to add bookmark from home view', async () => {
    const { deps } = createDeps([], () => 'home://');
    const controller = createBookmarksController(deps);

    await controller.addBookmark();

    expect(deps.showToast).toHaveBeenCalledWith(
      'Open a folder to add a bookmark',
      'Bookmarks',
      'info'
    );
  });
});
