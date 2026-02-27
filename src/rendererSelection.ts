import type { FileItem } from './types';

type SelectionDeps = {
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
};

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
    setActiveItem(fileItems[0], false);
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

    if (deps.isPreviewVisible() && selectedItems.size === 1) {
      const selectedPath = Array.from(selectedItems)[0];
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
    const scope = getSelectionScope();
    scope.querySelectorAll('.file-item.selected').forEach((item) => {
      setSelectedState(item as HTMLElement, false);
    });
    const selectedItems = deps.getSelectedItems();
    selectedItems.clear();
    deps.onSelectionChanged?.();
    deps.updateStatusBar();
    ensureActiveItem();

    if (deps.isPreviewVisible()) {
      deps.clearPreview();
    }
  }

  function selectAll() {
    const selectedItems = deps.getSelectedItems();
    selectedItems.clear();
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
  }

  function openSelectedItem() {
    const selectedItems = deps.getSelectedItems();
    if (selectedItems.size !== 1) return;
    const itemPath = Array.from(selectedItems)[0];
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
    const scope = getSelectionScope();
    return Array.from(scope.querySelectorAll('.file-item')) as HTMLElement[];
  }

  function getGridColumns(): number {
    const fileGrid = deps.getFileGrid();
    if (!fileGrid || deps.getViewMode() === 'list') return 1;
    const now = Date.now();
    if (gridColumnsCache && now - gridColumnsCache.time < 200) return gridColumnsCache.value;
    const gridStyle = window.getComputedStyle(fileGrid);
    const columns = gridStyle.getPropertyValue('grid-template-columns').split(' ').length;
    const result = columns || 1;
    gridColumnsCache = { value: result, time: now };
    return result;
  }

  function invalidateGridColumnsCache(): void {
    gridColumnsCache = null;
  }

  function navigateFileGrid(key: string, shiftKey: boolean) {
    const fileItems = getFileItemsArray();
    if (fileItems.length === 0) return;

    let currentIndex = lastSelectedIndex;
    if (currentIndex === -1 || currentIndex >= fileItems.length) {
      const selectedItems = deps.getSelectedItems();
      const selectedPath = Array.from(selectedItems)[selectedItems.size - 1];
      currentIndex = fileItems.findIndex((item) => item.getAttribute('data-path') === selectedPath);
    }
    if (currentIndex === -1) currentIndex = 0;

    const columns = getGridColumns();
    let newIndex = currentIndex;

    switch (key) {
      case 'ArrowUp':
        newIndex = Math.max(0, currentIndex - columns);
        break;
      case 'ArrowDown':
        newIndex = Math.min(fileItems.length - 1, currentIndex + columns);
        break;
      case 'ArrowLeft':
        newIndex = Math.max(0, currentIndex - 1);
        break;
      case 'ArrowRight':
        newIndex = Math.min(fileItems.length - 1, currentIndex + 1);
        break;
    }

    const selectedItems = deps.getSelectedItems();
    if (newIndex !== currentIndex || selectedItems.size === 0) {
      selectItemAtIndex(fileItems, newIndex, shiftKey, currentIndex);
    }
  }

  function selectFirstItem(shiftKey: boolean) {
    const fileItems = getFileItemsArray();
    if (fileItems.length === 0) return;

    if (shiftKey && lastSelectedIndex !== -1) {
      selectItemAtIndex(fileItems, 0, true, lastSelectedIndex);
    } else {
      selectItemAtIndex(fileItems, 0, false, -1);
    }
  }

  function selectLastItem(shiftKey: boolean) {
    const fileItems = getFileItemsArray();
    if (fileItems.length === 0) return;

    if (shiftKey && lastSelectedIndex !== -1) {
      selectItemAtIndex(fileItems, fileItems.length - 1, true, lastSelectedIndex);
    } else {
      selectItemAtIndex(fileItems, fileItems.length - 1, false, -1);
    }
  }

  function navigateByPage(direction: 'up' | 'down', shiftKey: boolean) {
    const fileItems = getFileItemsArray();
    if (fileItems.length === 0) return;

    const fileGrid = deps.getFileGrid();
    if (!fileGrid) return;

    const columns = getGridColumns();
    const gridRect = fileGrid.getBoundingClientRect();
    const firstItem = fileItems[0];
    if (!firstItem) return;

    const itemRect = firstItem.getBoundingClientRect();
    const itemHeight = itemRect.height + 8;
    const visibleRows = Math.max(1, Math.floor(gridRect.height / itemHeight));
    const pageSize = visibleRows * columns;

    let currentIndex = lastSelectedIndex;
    if (currentIndex === -1 || currentIndex >= fileItems.length) {
      const selectedItems = deps.getSelectedItems();
      const selectedPath = Array.from(selectedItems)[selectedItems.size - 1];
      currentIndex = fileItems.findIndex((item) => item.getAttribute('data-path') === selectedPath);
    }
    if (currentIndex === -1) currentIndex = 0;

    let newIndex: number;
    if (direction === 'up') {
      newIndex = Math.max(0, currentIndex - pageSize);
    } else {
      newIndex = Math.min(fileItems.length - 1, currentIndex + pageSize);
    }

    const selectedItems = deps.getSelectedItems();
    if (newIndex !== currentIndex || selectedItems.size === 0) {
      selectItemAtIndex(fileItems, newIndex, shiftKey, currentIndex);
    }
  }

  function selectItemAtIndex(
    fileItems: HTMLElement[],
    index: number,
    shiftKey: boolean,
    anchorIndex: number
  ) {
    if (index < 0 || index >= fileItems.length) return;

    if (shiftKey && anchorIndex !== -1) {
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);
      clearSelection();
      const selectedItems = deps.getSelectedItems();
      for (let i = start; i <= end; i++) {
        const item = fileItems[i];
        setSelectedState(item, true);
        const itemPath = item.getAttribute('data-path');
        if (itemPath) {
          selectedItems.add(itemPath);
        }
      }
    } else {
      clearSelection();
      const item = fileItems[index];
      setSelectedState(item, true);
      const itemPath = item.getAttribute('data-path');
      if (itemPath) {
        deps.getSelectedItems().add(itemPath);
      }
    }

    lastSelectedIndex = index;
    setActiveItem(fileItems[index], true);
    deps.onSelectionChanged?.();
    deps.updateStatusBar();

    if (deps.isPreviewVisible() && deps.getSelectedItems().size === 1) {
      const itemPath = Array.from(deps.getSelectedItems())[0];
      const fileItem = deps.getFileByPath(itemPath);
      if (fileItem) {
        deps.updatePreview(fileItem);
      }
    }
  }

  function setupRubberBandSelection(): void {
    const fileView = document.getElementById('file-view');
    const selectionRect = document.getElementById('selection-rect');
    if (!fileView || !selectionRect) return;

    fileView.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement;
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
    });

    document.addEventListener('mousemove', (e) => {
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
          } else if (!rubberBandInitialSelection.has(cached.path)) {
            setSelectedState(cached.el, false);
          }
        }

        deps.setSelectedItems(nextSelection);
        deps.onSelectionChanged?.();
        deps.updateStatusBar();
      });
    });

    document.addEventListener('mouseup', () => {
      if (!isRubberBandActive) return;
      isRubberBandActive = false;
      rubberBandStart = null;
      cachedItemRects = [];
      if (rubberBandRafId !== null) {
        cancelAnimationFrame(rubberBandRafId);
        rubberBandRafId = null;
      }
      selectionRect.classList.remove('active');
    });

    window.addEventListener('blur', () => {
      if (!isRubberBandActive) return;
      isRubberBandActive = false;
      rubberBandStart = null;
      cachedItemRects = [];
      if (rubberBandRafId !== null) {
        cancelAnimationFrame(rubberBandRafId);
        rubberBandRafId = null;
      }
      selectionRect.classList.remove('active');
    });
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
  };
}
