import type { FileItem } from './types';

type SelectionDeps = {
  getOrderedFiles?: () => FileItem[];
  ensureItemRendered?: (path: string) => HTMLElement | null;
  getSelectedItems: () => Set<string>;
  setSelectedItems: (items: Set<string>) => void;
  updateStatusBar: () => void;
  onSelectionChanged?: () => void;
  isPreviewVisible: () => boolean;
  updatePreview: (file: FileItem) => void;
  clearPreview: () => void;
  getFileByPath: (path: string) => FileItem | undefined;
  getViewMode: () => 'grid' | 'list' | 'column';
  getFileGrid: () => HTMLElement | null;
  openFileEntry: (file: FileItem) => void;
  announceToScreenReader?: (message: string) => void;
};

export function moveGridFocusWithinScope(
  scope: HTMLElement,
  key: string,
  viewMode: 'grid' | 'list' | 'column'
): void {
  const items = Array.from(scope.querySelectorAll<HTMLElement>('.file-item'));
  if (items.length === 0) return;

  const activeItem = scope.querySelector<HTMLElement>('.file-item[tabindex="0"]');
  let currentIndex = activeItem ? items.indexOf(activeItem) : 0;
  if (currentIndex === -1) currentIndex = 0;

  const columns =
    viewMode === 'list'
      ? 1
      : window.getComputedStyle(scope).getPropertyValue('grid-template-columns').split(' ')
          .length || 1;

  let newIndex: number;
  switch (key) {
    case 'ArrowUp':
      newIndex = Math.max(0, currentIndex - columns);
      break;
    case 'ArrowDown':
      newIndex = Math.min(items.length - 1, currentIndex + columns);
      break;
    case 'ArrowLeft':
      newIndex = Math.max(0, currentIndex - 1);
      break;
    case 'ArrowRight':
      newIndex = Math.min(items.length - 1, currentIndex + 1);
      break;
    default:
      return;
  }

  if (newIndex !== currentIndex) {
    if (activeItem) activeItem.tabIndex = -1;
    items[newIndex]!.tabIndex = 0;
    items[newIndex]!.focus({ preventScroll: true });
    items[newIndex]!.scrollIntoView({ block: 'nearest' });
  }
}

export function createSelectionController(deps: SelectionDeps) {
  let lastSelectedIndex = -1;
  let isRubberBandActive = false;
  let rubberBandStart: { x: number; y: number } | null = null;
  let rubberBandInitialSelection: Set<string> = new Set();
  let activeItem: HTMLElement | null = null;
  let rubberBandRafId: number | null = null;
  let cachedItemRects: {
    el: HTMLElement;
    path: string;
    left: number;
    top: number;
    right: number;
    bottom: number;
  }[] = [];
  let gridColumnsCache: { value: number; time: number } | null = null;
  let fileItemsArrayCache: HTMLElement[] | null = null;
  let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  const onResize = () => {
    if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = setTimeout(() => {
      gridColumnsCache = null;
    }, 150);
  };
  window.addEventListener('resize', onResize);

  function setSelectedState(fileItem: HTMLElement, selected: boolean) {
    fileItem.classList.toggle('selected', selected);
    fileItem.setAttribute('aria-selected', selected ? 'true' : 'false');
  }

  function setActiveItem(fileItem: HTMLElement | null, shouldFocus: boolean) {
    if (activeItem && activeItem !== fileItem) {
      activeItem.tabIndex = -1;
    }
    activeItem = fileItem;
    if (activeItem) {
      activeItem.tabIndex = 0;
      if (shouldFocus) {
        activeItem.focus({ preventScroll: true });
        activeItem.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function ensureActiveItem(): void {
    if (activeItem && document.contains(activeItem)) return;
    const fileItems = getFileItemsArray();
    if (fileItems.length === 0) return;
    setActiveItem(fileItems[0]!, false);
  }

  function toggleSelection(fileItem: HTMLElement) {
    const itemPath = fileItem.dataset.path;
    if (!itemPath) return;

    const willSelect = !fileItem.classList.contains('selected');
    setSelectedState(fileItem, willSelect);
    const selectedItems = deps.getSelectedItems();
    if (willSelect) {
      selectedItems.add(itemPath);
    } else {
      selectedItems.delete(itemPath);
    }
    deps.onSelectionChanged?.();
    deps.updateStatusBar();
    setActiveItem(fileItem, true);

    const count = selectedItems.size;
    deps.announceToScreenReader?.(`${count} item${count !== 1 ? 's' : ''} selected`);

    if (deps.isPreviewVisible() && selectedItems.size === 1) {
      const selectedPath = Array.from(selectedItems)[0]!;
      const file = deps.getFileByPath(selectedPath);
      if (file && file.isFile) {
        deps.updatePreview(file);
      } else {
        deps.clearPreview();
      }
    } else if (deps.isPreviewVisible() && selectedItems.size !== 1) {
      deps.clearPreview();
    }
  }

  function clearSelection() {
    lastSelectedIndex = -1;
    const selectedItems = deps.getSelectedItems();
    if (selectedItems.size > 0) {
      const scope = getSelectionScope();
      const selectedEls = scope.querySelectorAll('.file-item.selected');
      selectedEls.forEach((item) => {
        setSelectedState(item as HTMLElement, false);
      });
    }
    selectedItems.clear();
    deps.onSelectionChanged?.();
    deps.updateStatusBar();
    ensureActiveItem();
    deps.announceToScreenReader?.('Selection cleared');

    if (deps.isPreviewVisible()) {
      deps.clearPreview();
    }
  }

  function selectAll() {
    const selectedItems = deps.getSelectedItems();
    selectedItems.clear();
    for (const item of getOrderedFiles()) if (item.path) selectedItems.add(item.path);
    getFileItemsArray().forEach((item) => {
      setSelectedState(item as HTMLElement, true);
      const itemPath = item.getAttribute('data-path');
      if (itemPath) {
        selectedItems.add(itemPath);
      }
    });
    deps.onSelectionChanged?.();
    deps.updateStatusBar();
    ensureActiveItem();

    const count = selectedItems.size;
    deps.announceToScreenReader?.(`${count} item${count !== 1 ? 's' : ''} selected`);
  }

  function openSelectedItem() {
    const selectedItems = deps.getSelectedItems();
    if (selectedItems.size !== 1) return;
    const itemPath = Array.from(selectedItems)[0]!;
    const item = deps.getFileByPath(itemPath);
    if (item) {
      void deps.openFileEntry(item);
    }
  }

  function getSelectionScope(): ParentNode {
    const grid = deps.getFileGrid();
    if (!grid || !grid.isConnected) return document;
    if (grid.querySelector('.file-item')) return grid;
    return document.querySelector('.file-item') ? document : grid;
  }

  function getFileItemsArray(): HTMLElement[] {
    if (fileItemsArrayCache && !deps.getOrderedFiles) return fileItemsArrayCache;
    const scope = getSelectionScope();
    fileItemsArrayCache = Array.from(scope.querySelectorAll('.file-item')) as HTMLElement[];
    return fileItemsArrayCache;
  }

  function invalidateFileItemsCache(): void {
    fileItemsArrayCache = null;
  }

  function getGridColumns(): number {
    const fileGrid = deps.getFileGrid();
    if (!fileGrid || deps.getViewMode() === 'list') return 1;
    const now = Date.now();
    if (gridColumnsCache && now - gridColumnsCache.time < 1000) return gridColumnsCache.value;
    const gridStyle = window.getComputedStyle(fileGrid);
    const columns = gridStyle.getPropertyValue('grid-template-columns').split(' ').length;
    const result = columns || 1;
    gridColumnsCache = { value: result, time: now };
    return result;
  }

  function invalidateGridColumnsCache(): void {
    gridColumnsCache = null;
  }

  function getOrderedFiles(): Array<Pick<FileItem, 'path'>> {
    return (
      deps.getOrderedFiles?.() ??
      getFileItemsArray().map((item) => ({ path: item.dataset.path || '' }))
    );
  }

  function currentIndex(files: Array<Pick<FileItem, 'path'>>): number {
    if (lastSelectedIndex >= 0 && lastSelectedIndex < files.length) return lastSelectedIndex;
    const selected = Array.from(deps.getSelectedItems());
    return Math.max(
      0,
      files.findIndex((file) => file.path === selected[selected.length - 1])
    );
  }

  function selectIndex(index: number, shiftKey: boolean): void {
    const files = getOrderedFiles();
    const target = files[index];
    if (!target) return;
    const anchor = currentIndex(files);
    clearSelection();
    const selected = deps.getSelectedItems();
    const start = shiftKey ? Math.min(anchor, index) : index;
    const end = shiftKey ? Math.max(anchor, index) : index;
    for (let i = start; i <= end; i++) selected.add(files[i]!.path);
    const mounted = deps.ensureItemRendered?.(target.path);
    invalidateFileItemsCache();
    const elements = getFileItemsArray();
    for (const element of elements)
      setSelectedState(element, selected.has(element.dataset.path || ''));
    setActiveItem(
      mounted ?? elements.find((element) => element.dataset.path === target.path) ?? null,
      true
    );
    lastSelectedIndex = index;
    deps.onSelectionChanged?.();
    deps.updateStatusBar();
    const preview = deps.getFileByPath(target.path);
    if (deps.isPreviewVisible() && selected.size === 1 && preview) deps.updatePreview(preview);
  }

  function navigateFileGrid(key: string, shiftKey: boolean) {
    const files = getOrderedFiles();
    const delta = (
      {
        ArrowUp: -getGridColumns(),
        ArrowDown: getGridColumns(),
        ArrowLeft: -1,
        ArrowRight: 1,
      } as Record<string, number>
    )[key];
    if (delta === undefined || files.length === 0) return;
    selectIndex(Math.max(0, Math.min(files.length - 1, currentIndex(files) + delta)), shiftKey);
  }

  function selectFirstItem(shiftKey: boolean) {
    selectIndex(0, shiftKey);
  }
  function selectLastItem(shiftKey: boolean) {
    selectIndex(getOrderedFiles().length - 1, shiftKey);
  }

  function navigateByPage(direction: 'up' | 'down', shiftKey: boolean) {
    const files = getOrderedFiles();
    const grid = deps.getFileGrid();
    const first = getFileItemsArray()[0];
    if (!grid || !first || files.length === 0) return;
    const viewport = grid.closest('.file-view') ?? grid;
    const height = first.getBoundingClientRect().height + 8;
    const pageSize =
      Math.max(1, Math.floor(viewport.getBoundingClientRect().height / height)) * getGridColumns();
    const delta = direction === 'up' ? -pageSize : pageSize;
    selectIndex(Math.max(0, Math.min(files.length - 1, currentIndex(files) + delta)), shiftKey);
  }

  function selectSingleItem(fileItem: HTMLElement): void {
    const index = getOrderedFiles().findIndex((file) => file.path === fileItem.dataset.path);
    if (index !== -1) selectIndex(index, false);
  }

  function setupRubberBandSelection(): void {
    const fileView = document.getElementById('file-view');
    const selectionRect = document.getElementById('selection-rect');
    if (!fileView || !selectionRect) return;
    let rubberBandLastIndex = -1;

    fileView.addEventListener('mousedown', (e) => {
      if (!(e.target instanceof HTMLElement)) return;
      const target = e.target;
      if (target.closest('.file-item') || target.closest('.empty-state') || e.button !== 0) {
        return;
      }

      const fileViewRect = fileView.getBoundingClientRect();
      rubberBandStart = {
        x: e.clientX - fileViewRect.left + fileView.scrollLeft,
        y: e.clientY - fileViewRect.top + fileView.scrollTop,
      };

      if (e.shiftKey) {
        rubberBandInitialSelection = new Set(deps.getSelectedItems());
      } else {
        rubberBandInitialSelection.clear();
        clearSelection();
      }

      isRubberBandActive = true;
      selectionRect.style.left = `${rubberBandStart.x}px`;
      selectionRect.style.top = `${rubberBandStart.y}px`;
      selectionRect.style.width = '0';
      selectionRect.style.height = '0';
      selectionRect.classList.add('active');

      const fvRect = fileView.getBoundingClientRect();
      cachedItemRects = [];
      getSelectionScope()
        .querySelectorAll('.file-item')
        .forEach((item) => {
          const el = item as HTMLElement;
          const r = el.getBoundingClientRect();
          cachedItemRects.push({
            el,
            path: el.dataset.path || '',
            left: r.left - fvRect.left + fileView.scrollLeft,
            top: r.top - fvRect.top + fileView.scrollTop,
            right: r.left - fvRect.left + fileView.scrollLeft + r.width,
            bottom: r.top - fvRect.top + fileView.scrollTop + r.height,
          });
        });

      e.preventDefault();

      document.addEventListener('mousemove', onRubberBandMouseMove);
      document.addEventListener('mouseup', onRubberBandMouseUp);
      window.addEventListener('blur', onRubberBandBlur);
    });

    const onRubberBandMouseMove = (e: MouseEvent) => {
      if (!isRubberBandActive || !rubberBandStart) return;
      if (rubberBandRafId !== null) return;

      rubberBandRafId = requestAnimationFrame(() => {
        rubberBandRafId = null;
        if (!isRubberBandActive || !rubberBandStart) return;

        const fileViewRect = fileView.getBoundingClientRect();
        const currentX = e.clientX - fileViewRect.left + fileView.scrollLeft;
        const currentY = e.clientY - fileViewRect.top + fileView.scrollTop;

        const left = Math.min(rubberBandStart.x, currentX);
        const top = Math.min(rubberBandStart.y, currentY);
        const width = Math.abs(currentX - rubberBandStart.x);
        const height = Math.abs(currentY - rubberBandStart.y);

        selectionRect.style.left = `${left}px`;
        selectionRect.style.top = `${top}px`;
        selectionRect.style.width = `${width}px`;
        selectionRect.style.height = `${height}px`;

        const selRect = { left, top, right: left + width, bottom: top + height };
        const nextSelection = new Set(rubberBandInitialSelection);

        for (const cached of cachedItemRects) {
          const intersects =
            selRect.left < cached.right &&
            selRect.right > cached.left &&
            selRect.top < cached.bottom &&
            selRect.bottom > cached.top;

          if (intersects && cached.path) {
            setSelectedState(cached.el, true);
            nextSelection.add(cached.path);
            const currentIndex = getOrderedFiles().findIndex((file) => file.path === cached.path);
            if (currentIndex !== -1) {
              rubberBandLastIndex = currentIndex;
            }
          } else if (!rubberBandInitialSelection.has(cached.path)) {
            setSelectedState(cached.el, false);
          }
        }

        deps.setSelectedItems(nextSelection);
        deps.onSelectionChanged?.();
        deps.updateStatusBar();
      });
    };

    const cleanupRubberBand = () => {
      if (!isRubberBandActive) return;
      isRubberBandActive = false;
      rubberBandStart = null;
      cachedItemRects = [];
      if (rubberBandLastIndex >= 0) {
        lastSelectedIndex = rubberBandLastIndex;
      }
      if (rubberBandRafId !== null) {
        cancelAnimationFrame(rubberBandRafId);
        rubberBandRafId = null;
      }
      selectionRect.classList.remove('active');
      document.removeEventListener('mousemove', onRubberBandMouseMove);
      document.removeEventListener('mouseup', onRubberBandMouseUp);
      window.removeEventListener('blur', onRubberBandBlur);
    };

    const onRubberBandMouseUp = () => cleanupRubberBand();
    const onRubberBandBlur = () => cleanupRubberBand();
  }

  function destroy() {
    window.removeEventListener('resize', onResize);
    if (resizeDebounceTimer) {
      clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = null;
    }
  }

  return {
    toggleSelection,
    clearSelection,
    selectAll,
    openSelectedItem,
    navigateFileGrid,
    selectFirstItem,
    selectLastItem,
    navigateByPage,
    setupRubberBandSelection,
    isRubberBandActive: () => isRubberBandActive,
    ensureActiveItem,
    invalidateGridColumnsCache,
    invalidateFileItemsCache,
    selectSingleItem,
    destroy,
  };
}
