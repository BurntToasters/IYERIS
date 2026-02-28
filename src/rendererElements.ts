function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required DOM element: #${id}`);
  return el as T;
}

export const addressInput = requireElement<HTMLInputElement>('address-input');
export const fileGrid = requireElement<HTMLElement>('file-grid');
fileGrid.setAttribute('role', 'listbox');
fileGrid.setAttribute('aria-label', 'File list');
export const fileView = requireElement<HTMLElement>('file-view');
export const columnView = requireElement<HTMLElement>('column-view');
export const homeView = requireElement<HTMLElement>('home-view');
export const loading = requireElement<HTMLElement>('loading');
export const loadingText = requireElement<HTMLElement>('loading-text');
export const emptyState = requireElement<HTMLElement>('empty-state');
export const backBtn = requireElement<HTMLButtonElement>('back-btn');
export const forwardBtn = requireElement<HTMLButtonElement>('forward-btn');
export const upBtn = requireElement<HTMLButtonElement>('up-btn');
export const refreshBtn = requireElement<HTMLButtonElement>('refresh-btn');
export const newFileBtn = requireElement<HTMLButtonElement>('new-file-btn');
export const newFolderBtn = requireElement<HTMLButtonElement>('new-folder-btn');
export const viewToggleBtn = requireElement<HTMLButtonElement>('view-toggle-btn');
export const viewOptions = requireElement<HTMLElement>('view-options');
export const listHeader = requireElement<HTMLElement>('list-header');
export const folderTree = requireElement<HTMLElement>('folder-tree');
export const sidebarResizeHandle = requireElement<HTMLElement>('sidebar-resize-handle');
export const drivesList = requireElement<HTMLElement>('drives-list');
export const sortBtn = requireElement<HTMLButtonElement>('sort-btn');
export const bookmarksList = requireElement<HTMLElement>('bookmarks-list');
export const bookmarkAddBtn = requireElement<HTMLButtonElement>('bookmark-add-btn');
export const dropIndicator = requireElement<HTMLElement>('drop-indicator');
export const dropIndicatorAction = requireElement<HTMLElement>('drop-indicator-action');
export const dropIndicatorPath = requireElement<HTMLElement>('drop-indicator-path');
export const previewResizeHandle = requireElement<HTMLElement>('preview-resize-handle');
export const selectionCopyBtn = requireElement<HTMLButtonElement>('selection-copy-btn');
export const selectionCutBtn = requireElement<HTMLButtonElement>('selection-cut-btn');
export const selectionMoveBtn = requireElement<HTMLButtonElement>('selection-move-btn');
export const selectionRenameBtn = requireElement<HTMLButtonElement>('selection-rename-btn');
export const selectionDeleteBtn = requireElement<HTMLButtonElement>('selection-delete-btn');
export const statusItems = requireElement<HTMLElement>('status-items');
export const statusSelected = requireElement<HTMLElement>('status-selected');
export const statusSearch = requireElement<HTMLElement>('status-search');
export const statusSearchText = requireElement<HTMLElement>('status-search-text');
export const selectionIndicator = requireElement<HTMLElement>('selection-indicator');
export const selectionCount = requireElement<HTMLElement>('selection-count');
export const statusHidden = requireElement<HTMLElement>('status-hidden');

const srAnnouncements = document.getElementById('sr-announcements');

export function announceToScreenReader(message: string): void {
  if (!srAnnouncements) return;
  srAnnouncements.textContent = '';
  requestAnimationFrame(() => {
    srAnnouncements.textContent = message;
  });
}
