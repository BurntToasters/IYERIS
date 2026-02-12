import type { Settings } from './types';
import { escapeHtml } from './shared.js';
import { twemojiImg } from './rendererUtils.js';
import { isHomeViewPath } from './home.js';

type BookmarksDeps = {
  bookmarksList: HTMLElement | null;
  getCurrentPath: () => string;
  getCurrentSettings: () => Settings;
  saveSettingsWithTimestamp: (settings: Settings) => Promise<{ success: boolean; error?: string }>;
  showToast: (message: string, title: string, type: 'success' | 'error' | 'info') => void;
  navigateTo: (path: string) => void;
  getDraggedPaths: (e: DragEvent) => Promise<string[]>;
  getDragOperation: (e: DragEvent) => 'copy' | 'move';
  handleDrop: (
    sourcePaths: string[],
    destPath: string,
    operation: 'copy' | 'move'
  ) => Promise<void>;
  showDropIndicator: (
    action: 'copy' | 'move' | 'add',
    destPath: string,
    x: number,
    y: number
  ) => void;
  hideDropIndicator: () => void;
  consumeEvent: (e: Event) => void;
  renderHomeBookmarks: () => void;
};

export function createBookmarksController(deps: BookmarksDeps) {
  const {
    bookmarksList,
    getCurrentPath,
    getCurrentSettings,
    saveSettingsWithTimestamp,
    showToast,
    navigateTo,
    getDraggedPaths,
    getDragOperation,
    handleDrop,
    showDropIndicator,
    hideDropIndicator,
    consumeEvent,
    renderHomeBookmarks,
  } = deps;

  let bookmarksDropReady = false;

  function loadBookmarks() {
    if (!bookmarksList) return;
    bookmarksList.innerHTML = '';

    const currentSettings = getCurrentSettings();
    if (!currentSettings.bookmarks || currentSettings.bookmarks.length === 0) {
      bookmarksList.innerHTML = '<div class="sidebar-empty">No bookmarks yet</div>';
      renderHomeBookmarks();
      return;
    }

    currentSettings.bookmarks.forEach((bookmarkPath) => {
      const bookmarkItem = document.createElement('div');
      bookmarkItem.className = 'bookmark-item';
      bookmarkItem.dataset.path = bookmarkPath;
      const pathParts = bookmarkPath.split(/[/\\]/);
      const name = pathParts[pathParts.length - 1] || bookmarkPath;
      bookmarkItem.setAttribute('role', 'button');
      bookmarkItem.tabIndex = 0;
      bookmarkItem.setAttribute('aria-label', `Open bookmark ${name}`);

      bookmarkItem.innerHTML = `
      <span class="bookmark-icon">${twemojiImg(String.fromCodePoint(0x2b50), 'twemoji')}</span>
      <span class="bookmark-label">${escapeHtml(name)}</span>
      <button class="bookmark-remove" type="button" title="Remove bookmark" aria-label="Remove bookmark">${twemojiImg(String.fromCodePoint(0x274c), 'twemoji')}</button>
    `;

      bookmarkItem.addEventListener('click', (e) => {
        if (!(e.target as HTMLElement).classList.contains('bookmark-remove')) {
          navigateTo(bookmarkPath);
        }
      });

      bookmarkItem.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigateTo(bookmarkPath);
        }
      });

      const removeBtn = bookmarkItem.querySelector('.bookmark-remove');
      if (removeBtn) {
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          removeBookmark(bookmarkPath);
        });
      }

      bookmarkItem.draggable = true;
      bookmarkItem.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        bookmarkItem.classList.add('dragging');
        if (!e.dataTransfer) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/iyeris-bookmark', bookmarkPath);
      });

      bookmarkItem.addEventListener('dragend', () => {
        bookmarkItem.classList.remove('dragging');
        bookmarkItem.classList.remove('drag-over');
        hideDropIndicator();
      });

      bookmarkItem.addEventListener('dragover', (e) => {
        consumeEvent(e);
        if (!e.dataTransfer) return;
        const isBookmarkDrag = e.dataTransfer.types.includes('text/iyeris-bookmark');
        const operation = getDragOperation(e);
        e.dataTransfer.dropEffect = isBookmarkDrag ? 'move' : operation;
        bookmarkItem.classList.add('drag-over');
        if (!isBookmarkDrag) {
          showDropIndicator(operation, bookmarkPath, e.clientX, e.clientY);
        }
      });

      bookmarkItem.addEventListener('dragleave', (e) => {
        consumeEvent(e);
        const rect = bookmarkItem.getBoundingClientRect();
        if (
          e.clientX < rect.left ||
          e.clientX >= rect.right ||
          e.clientY < rect.top ||
          e.clientY >= rect.bottom
        ) {
          bookmarkItem.classList.remove('drag-over');
          hideDropIndicator();
        }
      });

      bookmarkItem.addEventListener('drop', async (e) => {
        consumeEvent(e);
        bookmarkItem.classList.remove('drag-over');

        if (e.dataTransfer?.types.includes('text/iyeris-bookmark')) {
          const draggedPath = e.dataTransfer.getData('text/iyeris-bookmark');
          if (!draggedPath || draggedPath === bookmarkPath) return;
          const currentSettings = getCurrentSettings();
          if (!currentSettings.bookmarks) return;
          const fromIndex = currentSettings.bookmarks.indexOf(draggedPath);
          const toIndex = currentSettings.bookmarks.indexOf(bookmarkPath);
          if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;
          const updated = [...currentSettings.bookmarks];
          updated.splice(fromIndex, 1);
          updated.splice(toIndex, 0, draggedPath);
          currentSettings.bookmarks = updated;
          const saveResult = await saveSettingsWithTimestamp(currentSettings);
          if (saveResult.success) {
            loadBookmarks();
          } else {
            showToast('Failed to reorder bookmarks', 'Bookmarks', 'error');
          }
          hideDropIndicator();
          return;
        }

        const draggedPaths = await getDraggedPaths(e);
        if (draggedPaths.length === 0) return;
        const operation = getDragOperation(e);
        await handleDrop(draggedPaths, bookmarkPath, operation);
        hideDropIndicator();
      });

      bookmarksList.appendChild(bookmarkItem);
    });

    if (!bookmarksDropReady && bookmarksList) {
      bookmarksList.addEventListener('dragover', (e) => {
        if (!e.dataTransfer) return;
        if (e.dataTransfer.types.includes('text/iyeris-bookmark')) return;
        consumeEvent(e);
        bookmarksList.classList.add('drag-over');
        e.dataTransfer.dropEffect = 'copy';
        showDropIndicator('add', 'Bookmarks', e.clientX, e.clientY);
      });

      bookmarksList.addEventListener('dragleave', (e) => {
        const rect = bookmarksList.getBoundingClientRect();
        if (
          e.clientX < rect.left ||
          e.clientX >= rect.right ||
          e.clientY < rect.top ||
          e.clientY >= rect.bottom
        ) {
          bookmarksList.classList.remove('drag-over');
          hideDropIndicator();
        }
      });

      bookmarksList.addEventListener('drop', async (e) => {
        if (!e.dataTransfer) return;
        if (e.dataTransfer.types.includes('text/iyeris-bookmark')) {
          hideDropIndicator();
          return;
        }
        consumeEvent(e);
        bookmarksList.classList.remove('drag-over');
        hideDropIndicator();

        const draggedPaths = await getDraggedPaths(e);
        if (draggedPaths.length === 0) return;
        const targetPath = draggedPaths[0];
        try {
          const propsResult = await window.electronAPI.getItemProperties(targetPath);
          if (propsResult.success && propsResult.properties?.isDirectory) {
            await addBookmarkByPath(targetPath);
          } else {
            showToast('Only folders can be bookmarked', 'Bookmarks', 'info');
          }
        } catch {
          showToast('Failed to add bookmark', 'Bookmarks', 'error');
        }
      });

      bookmarksDropReady = true;
    }

    renderHomeBookmarks();
  }

  async function addBookmark() {
    const currentPath = getCurrentPath();
    if (!currentPath || isHomeViewPath(currentPath)) {
      showToast('Open a folder to add a bookmark', 'Bookmarks', 'info');
      return;
    }
    await addBookmarkByPath(currentPath);
  }

  async function addBookmarkByPath(path: string) {
    const currentSettings = getCurrentSettings();
    if (!currentSettings.bookmarks) {
      currentSettings.bookmarks = [];
    }

    if (currentSettings.bookmarks.includes(path)) {
      showToast('This folder is already bookmarked', 'Bookmarks', 'info');
      return;
    }

    currentSettings.bookmarks.push(path);
    const result = await saveSettingsWithTimestamp(currentSettings);

    if (result.success) {
      loadBookmarks();
      showToast('Bookmark added', 'Bookmarks', 'success');
    } else {
      showToast('Failed to add bookmark', 'Error', 'error');
    }
  }

  async function removeBookmark(path: string) {
    const currentSettings = getCurrentSettings();
    if (!currentSettings.bookmarks) return;

    currentSettings.bookmarks = currentSettings.bookmarks.filter((b) => b !== path);
    const result = await saveSettingsWithTimestamp(currentSettings);

    if (result.success) {
      loadBookmarks();
      showToast('Bookmark removed', 'Bookmarks', 'success');
    } else {
      showToast('Failed to remove bookmark', 'Error', 'error');
    }
  }

  return {
    loadBookmarks,
    addBookmark,
    addBookmarkByPath,
    removeBookmark,
  };
}
