/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./shared.js', () => ({
  escapeHtml: (s: string) => s,
}));

vi.mock('./rendererUtils.js', () => ({
  twemojiImg: () => '<img>',
}));

vi.mock('./home.js', () => ({
  isHomeViewPath: (p: string) => p === 'iyeris://home',
}));

import { createBookmarksController } from './rendererBookmarks';

function createDeps(overrides?: Partial<Parameters<typeof createBookmarksController>[0]>) {
  const bookmarksList = document.createElement('div');
  const settings: Record<string, unknown> = {
    bookmarks: ['/bookmark1', '/bookmark2'],
  };
  return {
    bookmarksList,
    getCurrentPath: vi.fn(() => '/current'),
    getCurrentSettings: vi.fn(() => settings),
    saveSettingsWithTimestamp: vi.fn(async () => ({ success: true })),
    showToast: vi.fn(),
    navigateTo: vi.fn(),
    getDraggedPaths: vi.fn(async () => []),
    getDragOperation: vi.fn(() => 'copy' as const),
    handleDrop: vi.fn(async () => {}),
    showDropIndicator: vi.fn(),
    hideDropIndicator: vi.fn(),
    consumeEvent: vi.fn(),
    renderHomeBookmarks: vi.fn(),
    settings,
    ...overrides,
  };
}

describe('loadBookmarks', () => {
  it('renders bookmark items', () => {
    const deps = createDeps();
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    ctrl.loadBookmarks();
    expect(deps.bookmarksList!.querySelectorAll('.bookmark-item').length).toBe(2);
    expect(deps.renderHomeBookmarks).toHaveBeenCalled();
  });

  it('shows empty message when no bookmarks', () => {
    const deps = createDeps();
    deps.settings.bookmarks = [];
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    ctrl.loadBookmarks();
    expect(deps.bookmarksList!.innerHTML).toContain('No bookmarks yet');
  });

  it('shows empty message when bookmarks is undefined', () => {
    const deps = createDeps();
    delete deps.settings.bookmarks;
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    ctrl.loadBookmarks();
    expect(deps.bookmarksList!.innerHTML).toContain('No bookmarks yet');
  });

  it('handles null bookmarksList', () => {
    const deps = createDeps();
    deps.bookmarksList = null as unknown as HTMLDivElement;
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    expect(() => ctrl.loadBookmarks()).not.toThrow();
  });
});

describe('addBookmark', () => {
  it('adds current path as bookmark', async () => {
    const deps = createDeps();
    deps.settings.bookmarks = [];
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    await ctrl.addBookmark();
    expect(deps.settings.bookmarks).toContain('/current');
    expect(deps.saveSettingsWithTimestamp).toHaveBeenCalled();
    expect(deps.showToast).toHaveBeenCalledWith('Bookmark added', 'Bookmarks', 'success');
  });

  it('prevents duplicate bookmark', async () => {
    const deps = createDeps();
    deps.settings.bookmarks = ['/current'];
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    await ctrl.addBookmark();
    expect(deps.showToast).toHaveBeenCalledWith(
      'This folder is already bookmarked',
      'Bookmarks',
      'info'
    );
  });

  it('shows info toast when no path', async () => {
    const deps = createDeps();
    deps.getCurrentPath = vi.fn(() => '');
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    await ctrl.addBookmark();
    expect(deps.showToast).toHaveBeenCalledWith(
      'Open a folder to add a bookmark',
      'Bookmarks',
      'info'
    );
  });

  it('shows info toast when on home view', async () => {
    const deps = createDeps();
    deps.getCurrentPath = vi.fn(() => 'iyeris://home');
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    await ctrl.addBookmark();
    expect(deps.showToast).toHaveBeenCalledWith(
      'Open a folder to add a bookmark',
      'Bookmarks',
      'info'
    );
  });

  it('handles save failure', async () => {
    const deps = createDeps();
    deps.settings.bookmarks = [];
    deps.saveSettingsWithTimestamp = vi.fn(async () => ({ success: false, error: 'disk full' }));
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    await ctrl.addBookmark();
    expect(deps.showToast).toHaveBeenCalledWith('Failed to add bookmark', 'Error', 'error');
  });

  it('initializes bookmarks array if undefined', async () => {
    const deps = createDeps();
    delete deps.settings.bookmarks;
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    await ctrl.addBookmark();
    expect(deps.settings.bookmarks).toContain('/current');
  });
});

describe('addBookmarkByPath', () => {
  it('adds given path as bookmark', async () => {
    const deps = createDeps();
    deps.settings.bookmarks = [];
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    await ctrl.addBookmarkByPath('/new/path');
    expect(deps.settings.bookmarks).toContain('/new/path');
    expect(deps.showToast).toHaveBeenCalledWith('Bookmark added', 'Bookmarks', 'success');
  });
});

describe('removeBookmark', () => {
  it('removes a bookmark', async () => {
    const deps = createDeps();
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    await ctrl.removeBookmark('/bookmark1');
    expect(deps.settings.bookmarks).not.toContain('/bookmark1');
    expect(deps.showToast).toHaveBeenCalledWith('Bookmark removed', 'Bookmarks', 'success');
  });

  it('does nothing when bookmarks is undefined', async () => {
    const deps = createDeps();
    delete deps.settings.bookmarks;
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    await ctrl.removeBookmark('/anything');
    expect(deps.saveSettingsWithTimestamp).not.toHaveBeenCalled();
  });

  it('shows error toast on save failure', async () => {
    const deps = createDeps();
    deps.saveSettingsWithTimestamp = vi.fn(async () => ({ success: false, error: 'fail' }));
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    await ctrl.removeBookmark('/bookmark1');
    expect(deps.showToast).toHaveBeenCalledWith('Failed to remove bookmark', 'Error', 'error');
  });
});

describe('loadBookmarks - interaction', () => {
  it('navigates to bookmark on click', () => {
    const deps = createDeps();
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    ctrl.loadBookmarks();

    const item = deps.bookmarksList!.querySelector('.bookmark-item') as HTMLElement;
    item.click();
    expect(deps.navigateTo).toHaveBeenCalledWith('/bookmark1');
  });

  it('navigates on Enter key', () => {
    const deps = createDeps();
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    ctrl.loadBookmarks();

    const item = deps.bookmarksList!.querySelector('.bookmark-item') as HTMLElement;
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    item.dispatchEvent(event);
    expect(deps.navigateTo).toHaveBeenCalledWith('/bookmark1');
  });

  it('removes bookmark on remove button click', async () => {
    const deps = createDeps();
    const ctrl = createBookmarksController(
      deps as unknown as Parameters<typeof createBookmarksController>[0]
    );
    ctrl.loadBookmarks();

    const removeBtn = deps.bookmarksList!.querySelector('.bookmark-remove') as HTMLElement;
    removeBtn.click();
    // Give the async handler time to complete
    await vi.waitFor(() => {
      expect(deps.showToast).toHaveBeenCalled();
    });
  });
});
