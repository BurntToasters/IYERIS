import type { FileItem, ContentSearchResult, Settings } from './types';
import type { ToastType } from './rendererToasts.js';
import { escapeHtml } from './shared.js';
import {
  IMAGE_EXTENSIONS,
  RAW_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  PDF_EXTENSIONS,
  OFFICE_THUMBNAIL_EXTENSIONS,
} from './fileTypes.js';
import {
  getFileExtension,
  getFileTypeFromName,
  formatFileSize,
  getFileIcon,
  IMAGE_ICON,
} from './rendererFileIcons.js';

const RENDER_BATCH_SIZE = 50;
const VIRTUALIZE_THRESHOLD = 1200;
const VIRTUALIZE_BATCH_SIZE = 120;
const ANIMATED_RENDER_ITEM_LIMIT = 160;
const PERFORMANCE_MODE_ITEM_THRESHOLD = 2400;
const THUMBNAIL_RENDER_ITEM_LIMIT = 1200;
const ENTRY_ANIMATION_STAGGER_ITEMS = 12;
const ENTRY_ANIMATION_STAGGER_MS = 12;
const ENTRY_ANIMATION_CLEANUP_DELAY_MS = 320;

const THUMBNAIL_TYPE_MAP: [Set<string>, string][] = [
  [RAW_EXTENSIONS, 'raw'],
  [IMAGE_EXTENSIONS, 'image'],
  [VIDEO_EXTENSIONS, 'video'],
  [AUDIO_EXTENSIONS, 'audio'],
  [PDF_EXTENSIONS, 'pdf'],
  [OFFICE_THUMBNAIL_EXTENSIONS, 'office'],
];

function getThumbnailType(ext: string): string | null {
  for (const [extSet, type] of THUMBNAIL_TYPE_MAP) {
    if (extSet.has(ext)) return type;
  }
  return null;
}

type FileRenderConfig = {
  getFileGrid: () => HTMLElement | null;
  getEmptyState: () => HTMLElement | null;
  getCurrentSettings: () => Settings;
  getFileElementMap: () => Map<string, HTMLElement>;
  isSelected?: (path: string) => boolean;
  showToast: (message: string, title: string, type: ToastType) => void;
  clearSelection: () => void;
  updateStatusBar: () => void;
  markSelectionDirty: () => void;
  setHiddenFilesCount: (count: number) => void;
  getHiddenFilesCount: () => number;
  setAllFiles: (files: FileItem[]) => void;
  setDisableEntryAnimation: (value: boolean) => void;
  setDisableThumbnailRendering: (value: boolean) => void;
  ensureActiveItem: () => void;
  applyGitIndicatorsToPaths: (paths: string[]) => void;
  updateCutVisuals: () => void;
  clearCutPaths: () => void;
  clearGitCache: () => void;
  observeThumbnailItem: (el: HTMLElement) => void;
  resetThumbnailObserver: () => void;
  getFolderIcon: (path: string) => string;
  nameCollator: Intl.Collator;
  dateFormatter: Intl.DateTimeFormat;
};

export function createFileRenderController(config: FileRenderConfig) {
  let renderFilesToken = 0;
  const filePathMap: Map<string, FileItem> = new Map();
  let virtualizedRenderToken = 0;
  let virtualizedItems: FileItem[] = [];
  let orderedFiles: FileItem[] = [];
  let virtualizedSearchQuery: string | undefined;
  let virtualRoot: HTMLElement | null = null;
  let virtualResize: ResizeObserver | null = null;
  let virtualFrame: number | null = null;
  let windowStart = -1;
  let rowHeight = 0;

  let renderItemIndex = 0;
  const animationCleanupItems: HTMLElement[] = [];
  let animationCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  const fileIconNodeCache = new Map<string, Element>();

  let disableEntryAnimation = false;
  let disableThumbnailRendering = false;

  function resetVirtualizedRender(): void {
    virtualRoot?.removeEventListener('scroll', scheduleWindow);
    virtualResize?.disconnect();
    virtualResize = null;
    virtualRoot = null;
    if (virtualFrame !== null) cancelAnimationFrame(virtualFrame);
    virtualFrame = null;
    virtualizedItems = [];
    orderedFiles = [];
    virtualizedSearchQuery = undefined;
    windowStart = -1;
    rowHeight = 0;
  }

  function scheduleWindow(): void {
    if (virtualFrame !== null) return;
    virtualFrame = requestAnimationFrame(() => {
      virtualFrame = null;
      renderWindow();
    });
  }

  function renderWindow(requestedIndex?: number): void {
    const grid = config.getFileGrid();
    if (!grid || virtualizedItems.length === 0 || virtualizedRenderToken !== renderFilesToken)
      return;
    const style = getComputedStyle(grid);
    const columns = Math.max(1, style.gridTemplateColumns.split(' ').filter(Boolean).length);
    const gap = parseFloat(style.rowGap) || 0;
    const first = grid.querySelector<HTMLElement>('.file-item');
    rowHeight =
      first?.getBoundingClientRect().height ||
      rowHeight ||
      (grid.classList.contains('list-view') ? 40 : 140);
    const stride = rowHeight + gap;
    const offset = virtualRoot
      ? grid.getBoundingClientRect().top -
        virtualRoot.getBoundingClientRect().top +
        virtualRoot.scrollTop
      : 0;
    const row =
      requestedIndex === undefined
        ? Math.max(0, Math.floor(((virtualRoot?.scrollTop || 0) - offset) / stride))
        : Math.floor(requestedIndex / columns);
    const rowsPerWindow = Math.max(1, Math.ceil((VIRTUALIZE_BATCH_SIZE * 3) / columns));
    const totalRows = Math.ceil(virtualizedItems.length / columns);
    const startRow = Math.max(
      0,
      Math.min(row - Math.floor(rowsPerWindow / 3), totalRows - rowsPerWindow)
    );
    const start = startRow * columns;
    if (start === windowStart && requestedIndex === undefined) return;
    windowStart = start;
    const end = Math.min(virtualizedItems.length, start + rowsPerWindow * columns);
    const focusedPath = grid.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.path
      : undefined;
    grid.style.overflowAnchor = 'none';
    grid.replaceChildren();
    config.getFileElementMap().clear();
    const spacer = (height: number) => {
      if (height <= 0) return;
      const element = document.createElement('div');
      element.setAttribute('aria-hidden', 'true');
      element.style.cssText = `grid-column: 1 / -1; height: ${height}px; pointer-events: none;`;
      grid.appendChild(element);
    };
    spacer(Math.max(0, startRow * stride - gap));
    const paths = appendFileItems(virtualizedItems.slice(start, end), virtualizedSearchQuery);
    spacer(Math.max(0, (totalRows - Math.ceil(end / columns)) * stride - gap));
    config.markSelectionDirty();
    config.applyGitIndicatorsToPaths(paths);
    config.updateCutVisuals();
    if (focusedPath) config.getFileElementMap().get(focusedPath)?.focus({ preventScroll: true });
    config.ensureActiveItem();
    if (requestedIndex !== undefined && virtualRoot) virtualRoot.scrollTop = offset + row * stride;
  }

  function ensureItemRendered(path: string): HTMLElement | null {
    const index = orderedFiles.findIndex((item) => item.path === path);
    if (index < 0) return null;
    if (virtualizedItems.length > 0) renderWindow(index);
    else if (!config.getFileElementMap().has(path)) {
      // A keyboard action can arrive between animation-frame batches.
      const paths = appendFileItems(orderedFiles);
      config.applyGitIndicatorsToPaths(paths);
      config.markSelectionDirty();
    }
    return config.getFileElementMap().get(path) ?? null;
  }

  function createFileIconNode(iconHtml: string): Element {
    const cached = fileIconNodeCache.get(iconHtml);
    if (cached) {
      return cached.cloneNode(true) as Element;
    }
    const wrapper = document.createElement('div');
    wrapper.innerHTML = iconHtml;
    const first = wrapper.firstElementChild;
    const node = first ? first : document.createElement('span');
    if (!first) {
      node.textContent = iconHtml;
    }
    fileIconNodeCache.set(iconHtml, node.cloneNode(true) as Element);
    return node;
  }

  function scheduleAnimationCleanup(): void {
    if (animationCleanupTimer) return;
    animationCleanupTimer = setTimeout(() => {
      animationCleanupTimer = null;
      const batch = animationCleanupItems.splice(0);
      for (const el of batch) {
        el.classList.remove('animate-in');
        el.style.animationDelay = '';
      }
      if (animationCleanupItems.length > 0) {
        scheduleAnimationCleanup();
      }
    }, ENTRY_ANIMATION_CLEANUP_DELAY_MS);
  }

  function appendFileItems(items: FileItem[], searchQuery?: string): string[] {
    const fileGrid = config.getFileGrid();
    if (!fileGrid) return [];
    const fileElementMap = config.getFileElementMap();
    const fragment = document.createDocumentFragment();
    const paths: string[] = [];
    const shouldAnimate =
      !disableEntryAnimation && !document.body.classList.contains('reduce-motion');

    for (const item of items) {
      if (fileElementMap.has(item.path)) continue;
      const fileItem = createFileItem(item, searchQuery);
      if (shouldAnimate) {
        const delayIndex = renderItemIndex % ENTRY_ANIMATION_STAGGER_ITEMS;
        const delayMs = delayIndex * ENTRY_ANIMATION_STAGGER_MS;
        fileItem.classList.add('animate-in');
        fileItem.style.animationDelay = `${delayMs / 1000}s`;
        animationCleanupItems.push(fileItem);
      }
      renderItemIndex++;
      fileElementMap.set(item.path, fileItem);
      fragment.appendChild(fileItem);
      paths.push(item.path);
    }

    fileGrid.appendChild(fragment);
    if (shouldAnimate && animationCleanupItems.length > 0) {
      scheduleAnimationCleanup();
    }
    return paths;
  }

  function updateHiddenFilesCount(items: FileItem[], append = false): void {
    const count = items.reduce((acc, item) => acc + (item.isHidden ? 1 : 0), 0);
    config.setHiddenFilesCount(append ? config.getHiddenFilesCount() + count : count);
  }

  function renderFiles(items: FileItem[], searchQuery?: string) {
    const fileGrid = config.getFileGrid();
    const emptyState = config.getEmptyState();
    if (!fileGrid) return;

    const renderToken = ++renderFilesToken;
    resetVirtualizedRender();
    if (animationCleanupTimer) {
      clearTimeout(animationCleanupTimer);
      animationCleanupTimer = null;
    }
    config.resetThumbnailObserver();
    fileGrid.replaceChildren();
    renderItemIndex = 0;
    disableEntryAnimation = false;
    disableThumbnailRendering = false;
    config.setDisableEntryAnimation(false);
    config.setDisableThumbnailRendering(false);
    config.clearSelection();
    config.setAllFiles(items);
    document.body.classList.toggle(
      'performance-mode',
      items.length >= PERFORMANCE_MODE_ITEM_THRESHOLD
    );
    updateHiddenFilesCount(items);

    filePathMap.clear();
    config.getFileElementMap().clear();
    config.markSelectionDirty();
    config.clearGitCache();
    config.clearCutPaths();

    const LARGE_FOLDER_THRESHOLD = 10000;
    if (items.length >= LARGE_FOLDER_THRESHOLD) {
      config.showToast(
        `This folder contains ${items.length.toLocaleString()} items. Performance may be affected.`,
        'Large Folder',
        'warning'
      );
    }

    const settings = config.getCurrentSettings();
    const visibleItems = settings.showHiddenFiles ? items : items.filter((item) => !item.isHidden);

    if (visibleItems.length === 0) {
      if (emptyState) {
        const emptyText = emptyState.querySelector('p');
        const emptyActions = emptyState.querySelector('.empty-actions') as HTMLElement | null;
        const emptyHint = emptyState.querySelector('.empty-hint') as HTMLElement | null;
        if (searchQuery) {
          if (emptyText) emptyText.textContent = 'No files matching your search';
          if (emptyActions) emptyActions.style.display = 'none';
          if (emptyHint) emptyHint.style.display = 'none';
        } else {
          if (emptyText) emptyText.textContent = 'This folder is empty';
          if (emptyActions) emptyActions.style.display = '';
          if (emptyHint) emptyHint.style.display = '';
        }
        emptyState.style.display = 'flex';
      }
      config.updateStatusBar();
      return;
    }

    if (emptyState) emptyState.style.display = 'none';

    for (const item of visibleItems) {
      filePathMap.set(item.path, item);
    }

    const sortBy = settings.sortBy || 'name';
    const sortOrder = settings.sortOrder || 'asc';
    const extCache = sortBy === 'type' ? new Map<FileItem, string>() : null;
    const modifiedCache = sortBy === 'date' ? new Map<FileItem, number>() : null;

    if (sortBy === 'type') {
      visibleItems.forEach((item) => {
        if (!item.isDirectory) {
          const ext = getFileExtension(item.name);
          extCache?.set(item, ext);
        }
      });
    } else if (sortBy === 'date') {
      visibleItems.forEach((item) => {
        const time =
          item.modified instanceof Date
            ? item.modified.getTime()
            : new Date(item.modified).getTime();
        modifiedCache?.set(item, time);
      });
    }

    const sortedItems = [...visibleItems].sort((a, b) => {
      const dirSort = (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0);
      if (dirSort !== 0) return dirSort;

      let comparison: number;

      switch (sortBy) {
        case 'name':
          comparison = config.nameCollator.compare(a.name, b.name);
          break;
        case 'date':
          comparison = (modifiedCache?.get(a) ?? -Infinity) - (modifiedCache?.get(b) ?? -Infinity);
          break;
        case 'size':
          comparison = a.size - b.size;
          break;
        case 'type': {
          const extA = extCache?.get(a) || '';
          const extB = extCache?.get(b) || '';
          comparison = config.nameCollator.compare(extA, extB);
          break;
        }
        default:
          comparison = config.nameCollator.compare(a.name, b.name);
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    orderedFiles = sortedItems;
    disableEntryAnimation = sortedItems.length > ANIMATED_RENDER_ITEM_LIMIT;
    disableThumbnailRendering = sortedItems.length >= THUMBNAIL_RENDER_ITEM_LIMIT;
    config.setDisableEntryAnimation(disableEntryAnimation);
    config.setDisableThumbnailRendering(disableThumbnailRendering);

    if (sortedItems.length >= VIRTUALIZE_THRESHOLD) {
      virtualizedRenderToken = renderToken;
      virtualizedItems = sortedItems;
      virtualRoot = document.getElementById('file-view');
      virtualRoot?.addEventListener('scroll', scheduleWindow, { passive: true });
      if (typeof ResizeObserver !== 'undefined') {
        virtualResize = new ResizeObserver(() => {
          windowStart = -1;
          scheduleWindow();
        });
        if (virtualRoot) virtualResize.observe(virtualRoot);
      }
      virtualizedSearchQuery = searchQuery;
      config.updateStatusBar();
      renderWindow();
      windowStart = -1;
      scheduleWindow();
      return;
    }

    const batchSize = RENDER_BATCH_SIZE;
    let currentBatch = 0;

    const renderBatch = () => {
      if (renderToken !== renderFilesToken) return;
      const start = currentBatch * batchSize;
      const end = Math.min(start + batchSize, sortedItems.length);
      const batch = sortedItems.slice(start, end);
      const paths = appendFileItems(batch, searchQuery);
      config.applyGitIndicatorsToPaths(paths);
      currentBatch++;

      if (renderToken !== renderFilesToken) return;
      if (end < sortedItems.length) {
        requestAnimationFrame(renderBatch);
      } else {
        config.updateCutVisuals();
        config.updateStatusBar();
        config.ensureActiveItem();
      }
    };

    renderBatch();
  }

  function createFileItem(item: FileItem, searchQuery?: string): HTMLElement {
    const settings = config.getCurrentSettings();
    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    fileItem.tabIndex = -1;
    fileItem.dataset.path = item.path;
    fileItem.dataset.isDirectory = String(item.isDirectory);
    if (item.isAppBundle) fileItem.dataset.isAppBundle = 'true';
    if (item.isShortcut) fileItem.dataset.isShortcut = 'true';
    if (item.isDesktopEntry) fileItem.dataset.isDesktopEntry = 'true';
    fileItem.setAttribute('role', 'option');
    const isSelected = config.isSelected?.(item.path) ?? false;
    fileItem.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    if (isSelected) fileItem.classList.add('selected');

    let icon: string;
    if (item.isAppBundle) {
      icon = getFileIcon(item.name);
    } else if (item.isDirectory) {
      icon = config.getFolderIcon(item.path);
    } else {
      const ext = getFileExtension(item.name);
      const thumbType = getThumbnailType(ext);
      if (thumbType) {
        icon = thumbType === 'image' || thumbType === 'raw' ? IMAGE_ICON : getFileIcon(item.name);
        if (!disableThumbnailRendering) {
          fileItem.classList.add('has-thumbnail');
          fileItem.dataset.thumbnailType = thumbType;
          config.observeThumbnailItem(fileItem);
        }
      } else {
        icon = getFileIcon(item.name);
      }
    }

    const sizeDisplay = item.isDirectory && !item.isAppBundle ? '--' : formatFileSize(item.size);
    const dateDisplay = config.dateFormatter.format(new Date(item.modified));
    const typeDisplay = item.isAppBundle
      ? 'Application'
      : item.isDesktopEntry
        ? 'Application'
        : item.isShortcut
          ? 'Shortcut'
          : item.isDirectory
            ? 'Folder'
            : getFileTypeFromName(item.name);

    const ariaDescription = item.isDirectory
      ? `${typeDisplay}, modified ${dateDisplay}`
      : `${typeDisplay}, ${sizeDisplay}, modified ${dateDisplay}`;
    fileItem.setAttribute('aria-label', item.name);
    fileItem.setAttribute('aria-description', ariaDescription);

    const contentResult = item as ContentSearchResult;
    let matchContextHtml = '';
    if (contentResult.matchContext && searchQuery && searchQuery.length <= 500) {
      const escapedContext = escapeHtml(contentResult.matchContext);
      const escapedQuery = escapeHtml(searchQuery);
      const regex = new RegExp(`(${escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      const highlightedContext = escapedContext.replace(
        regex,
        '<span class="match-highlight">$1</span>'
      );
      const lineInfo = contentResult.matchLineNumber
        ? `<span class="match-line-number">Line ${contentResult.matchLineNumber}</span>`
        : '';
      matchContextHtml = `<div class="match-context">${highlightedContext}${lineInfo}</div>`;
    }

    let displayName = item.name;
    if (settings.showFileExtensions === false && !item.isDirectory) {
      const lastDot = item.name.lastIndexOf('.');
      if (lastDot > 0) {
        displayName = item.name.substring(0, lastDot);
      }
    }

    const symlinkBadge = item.isSymlink
      ? '<span class="symlink-badge" role="img" aria-label="Symbolic link">⤳</span>'
      : '';

    // eslint-disable-next-line no-restricted-syntax -- user data via escapeHtml(); icons/numerics are safe
    fileItem.innerHTML = `
    <div class="file-main">
      <div class="file-checkbox"><span class="checkbox-mark">✓</span></div>
      <div class="file-icon">${symlinkBadge}</div>
      <div class="file-text">
        <div class="file-name">${escapeHtml(displayName)}</div>
        ${matchContextHtml}
      </div>
    </div>
    <div class="file-info">
      <span class="file-type">${escapeHtml(typeDisplay)}</span>
      <span class="file-size" data-path="${escapeHtml(item.path)}">${sizeDisplay}</span>
      <span class="file-modified">${dateDisplay}</span>
    </div>
  `;
    const fileIcon = fileItem.querySelector('.file-icon');
    if (fileIcon) {
      fileIcon.appendChild(createFileIconNode(icon));
    }
    fileItem.draggable = true;

    return fileItem;
  }

  function getFileItemData(fileItem: HTMLElement): FileItem | null {
    const itemPath = fileItem.dataset.path;
    if (!itemPath) return null;
    return filePathMap.get(itemPath) ?? null;
  }

  function disconnectVirtualizedObserver(): void {
    resetVirtualizedRender();
  }

  return {
    getOrderedFiles: () => orderedFiles,
    ensureItemRendered,
    renderFiles,
    createFileItem,
    appendFileItems,
    resetVirtualizedRender,
    getFileItemData,
    getFilePathMap: () => filePathMap,
    disconnectVirtualizedObserver,
  };
}
