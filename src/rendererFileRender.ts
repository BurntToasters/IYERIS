import type { FileItem, ContentSearchResult, Settings } from './types';
import type { ToastType } from './rendererToasts.js';
import { escapeHtml } from './shared.js';
import {
  IMAGE_EXTENSIONS,
  RAW_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  PDF_EXTENSIONS,
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

type FileRenderConfig = {
  getFileGrid: () => HTMLElement | null;
  getEmptyState: () => HTMLElement | null;
  getCurrentSettings: () => Settings;
  getFileElementMap: () => Map<string, HTMLElement>;
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
  let virtualizedRenderIndex = 0;
  let virtualizedSearchQuery: string | undefined;
  let virtualizedObserver: IntersectionObserver | null = null;
  let virtualizedSentinel: HTMLElement | null = null;

  let renderItemIndex = 0;
  const animationCleanupItems: HTMLElement[] = [];
  let animationCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  const fileIconNodeCache = new Map<string, HTMLElement>();

  let disableEntryAnimation = false;
  let disableThumbnailRendering = false;

  function resetVirtualizedRender(): void {
    if (virtualizedObserver) {
      virtualizedObserver.disconnect();
      virtualizedObserver = null;
    }
    virtualizedItems = [];
    virtualizedRenderIndex = 0;
    virtualizedSearchQuery = undefined;
    if (virtualizedSentinel && virtualizedSentinel.parentElement) {
      virtualizedSentinel.parentElement.removeChild(virtualizedSentinel);
    }
    virtualizedSentinel = null;
  }

  function getVirtualizedObserver(): IntersectionObserver | null {
    const root = document.getElementById('file-view');
    if (!root) return null;
    if (virtualizedObserver) return virtualizedObserver;

    virtualizedObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries.find((item) => item.isIntersecting);
        if (entry && entry.target) {
          virtualizedObserver?.unobserve(entry.target);
          appendNextVirtualizedBatch();
        }
      },
      {
        root,
        rootMargin: '200px',
        threshold: 0.01,
      }
    );
    return virtualizedObserver;
  }

  function ensureVirtualizedSentinel(): void {
    const fileGrid = config.getFileGrid();
    if (!fileGrid) return;
    const observer = getVirtualizedObserver();
    if (!observer) return;

    if (!virtualizedSentinel) {
      virtualizedSentinel = document.createElement('div');
      virtualizedSentinel.style.width = '100%';
      virtualizedSentinel.style.height = '1px';
      virtualizedSentinel.style.pointerEvents = 'none';
    }

    if (virtualizedSentinel.parentElement !== fileGrid) {
      fileGrid.appendChild(virtualizedSentinel);
    } else {
      fileGrid.appendChild(virtualizedSentinel);
    }

    observer.observe(virtualizedSentinel);
  }

  function appendNextVirtualizedBatch(): void {
    const fileGrid = config.getFileGrid();
    if (!fileGrid) return;
    if (virtualizedRenderToken !== renderFilesToken) return;

    const start = virtualizedRenderIndex;
    const end = Math.min(start + VIRTUALIZE_BATCH_SIZE, virtualizedItems.length);
    if (start >= end) {
      if (virtualizedSentinel) {
        virtualizedSentinel.remove();
      }
      return;
    }

    const batch = virtualizedItems.slice(start, end);
    virtualizedRenderIndex = end;
    const paths = appendFileItems(batch, virtualizedSearchQuery);
    config.applyGitIndicatorsToPaths(paths);
    config.updateCutVisuals();
    config.ensureActiveItem();

    if (virtualizedRenderIndex < virtualizedItems.length) {
      ensureVirtualizedSentinel();
    } else if (virtualizedSentinel) {
      virtualizedSentinel.remove();
    }
  }

  function createFileIconNode(iconHtml: string): HTMLElement {
    const cached = fileIconNodeCache.get(iconHtml);
    if (cached) {
      return cached.cloneNode(true) as HTMLElement;
    }
    const wrapper = document.createElement('div');
    wrapper.innerHTML = iconHtml;
    const first = wrapper.firstElementChild;
    const node = first instanceof HTMLElement ? first : document.createElement('span');
    if (!(first instanceof HTMLElement)) {
      node.textContent = iconHtml;
    }
    fileIconNodeCache.set(iconHtml, node.cloneNode(true) as HTMLElement);
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
    config.resetThumbnailObserver();
    fileGrid.innerHTML = '';
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
      if (emptyState) emptyState.style.display = 'flex';
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

      let comparison = 0;

      switch (sortBy) {
        case 'name':
          comparison = config.nameCollator.compare(a.name, b.name);
          break;
        case 'date':
          comparison = (modifiedCache?.get(a) || 0) - (modifiedCache?.get(b) || 0);
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

    disableEntryAnimation = sortedItems.length > ANIMATED_RENDER_ITEM_LIMIT;
    disableThumbnailRendering = sortedItems.length >= THUMBNAIL_RENDER_ITEM_LIMIT;
    config.setDisableEntryAnimation(disableEntryAnimation);
    config.setDisableThumbnailRendering(disableThumbnailRendering);

    if (sortedItems.length >= VIRTUALIZE_THRESHOLD) {
      virtualizedRenderToken = renderToken;
      virtualizedItems = sortedItems;
      virtualizedRenderIndex = 0;
      virtualizedSearchQuery = searchQuery;
      config.updateStatusBar();
      appendNextVirtualizedBatch();
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
    fileItem.setAttribute('role', 'option');
    fileItem.setAttribute('aria-selected', 'false');

    let icon: string;
    if (item.isDirectory) {
      icon = config.getFolderIcon(item.path);
    } else {
      const ext = getFileExtension(item.name);
      const thumbType = RAW_EXTENSIONS.has(ext)
        ? 'raw'
        : IMAGE_EXTENSIONS.has(ext)
          ? 'image'
          : VIDEO_EXTENSIONS.has(ext)
            ? 'video'
            : AUDIO_EXTENSIONS.has(ext)
              ? 'audio'
              : PDF_EXTENSIONS.has(ext)
                ? 'pdf'
                : null;
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

    const sizeDisplay = item.isDirectory ? '--' : formatFileSize(item.size);
    const dateDisplay = config.dateFormatter.format(new Date(item.modified));
    const typeDisplay = item.isDirectory ? 'Folder' : getFileTypeFromName(item.name);

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

    fileItem.innerHTML = `
    <div class="file-main">
      <div class="file-checkbox"><span class="checkbox-mark">✓</span></div>
      <div class="file-icon"></div>
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
    if (virtualizedObserver) {
      virtualizedObserver.disconnect();
      virtualizedObserver = null;
    }
  }

  return {
    renderFiles,
    createFileItem,
    appendFileItems,
    resetVirtualizedRender,
    getFileItemData,
    getFilePathMap: () => filePathMap,
    disconnectVirtualizedObserver,
  };
}
