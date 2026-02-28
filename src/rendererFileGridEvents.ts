import type { FileItem } from './types';

type FileGridEventsConfig = {
  getFileGrid: () => HTMLElement | null;
  getFileItemData: (fileItem: HTMLElement) => FileItem | null;
  getSelectedItems: () => Set<string>;
  getTabsEnabled: () => boolean;
  clearSelection: () => void;
  toggleSelection: (fileItem: HTMLElement) => void;
  showContextMenu: (x: number, y: number, item: FileItem) => void;
  openFileEntry: (item: FileItem) => Promise<void>;
  addNewTab: (path?: string) => void;
  navigateTo: (path: string) => Promise<void>;
  consumeEvent: (e: Event) => void;
  getDragOperation: (e: DragEvent) => 'copy' | 'move';
  getDraggedPaths: (e: DragEvent) => Promise<string[]>;
  showDropIndicator: (
    operation: 'copy' | 'move' | 'add',
    path: string,
    x: number,
    y: number
  ) => void;
  hideDropIndicator: () => void;
  scheduleSpringLoad: (el: HTMLElement, action: () => void) => void;
  clearSpringLoad: (el?: HTMLElement) => void;
  handleDrop: (paths: string[], destPath: string, operation: 'copy' | 'move') => Promise<void>;
  setDragData: (paths: string[]) => void;
  clearDragData: () => void;
};

export function createFileGridEventsController(config: FileGridEventsConfig) {
  const MODIFIER_DOUBLE_CLICK_SUPPRESSION_MS = 500;
  let fileGridDelegationReady = false;
  let suppressOpenPath: string | null = null;
  let suppressOpenUntil = 0;

  function getFileItemElement(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const fileItem = target.closest('.file-item');
    return fileItem instanceof HTMLElement ? fileItem : null;
  }

  function setupFileGridEventDelegation(): void {
    const fileGrid = config.getFileGrid();
    if (!fileGrid || fileGridDelegationReady) return;
    fileGridDelegationReady = true;

    fileGrid.addEventListener(
      'mouseenter',
      (e) => {
        const target = e.target;
        if (!(target instanceof HTMLImageElement)) return;
        if (target.dataset.animated !== 'true') return;
        const animatedSrc = target.dataset.animatedSrc;
        if (animatedSrc && target.src !== animatedSrc) {
          target.src = animatedSrc;
        }
      },
      true
    );

    fileGrid.addEventListener(
      'mouseleave',
      (e) => {
        const target = e.target;
        if (!(target instanceof HTMLImageElement)) return;
        if (target.dataset.animated !== 'true') return;
        const staticSrc = target.dataset.staticSrc;
        if (staticSrc && target.src !== staticSrc) {
          target.src = staticSrc;
        }
      },
      true
    );

    fileGrid.addEventListener('click', (e) => {
      const fileItem = getFileItemElement(e.target);
      if (!fileItem) return;

      if (e.ctrlKey || e.metaKey) {
        const itemPath = fileItem.dataset.path || null;
        if (itemPath) {
          suppressOpenPath = itemPath;
          suppressOpenUntil = Date.now() + MODIFIER_DOUBLE_CLICK_SUPPRESSION_MS;
        }
      }

      if (!e.ctrlKey && !e.metaKey) {
        config.clearSelection();
      }
      config.toggleSelection(fileItem);
    });

    fileGrid.addEventListener('dblclick', (e) => {
      const fileItem = getFileItemElement(e.target);
      if (!fileItem) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

      const itemPath = fileItem.dataset.path || '';
      if (itemPath && suppressOpenPath === itemPath && Date.now() <= suppressOpenUntil) {
        return;
      }

      const item = config.getFileItemData(fileItem);
      if (!item) return;
      void config.openFileEntry(item);
    });

    fileGrid.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      const fileItem = getFileItemElement(e.target);
      if (!fileItem) return;
      const item = config.getFileItemData(fileItem);
      if (!item || !item.isDirectory || item.isAppBundle || !config.getTabsEnabled()) return;
      e.preventDefault();
      config.addNewTab(item.path);
    });

    fileGrid.addEventListener('contextmenu', (e) => {
      const fileItem = getFileItemElement(e.target);
      if (!fileItem) return;
      const item = config.getFileItemData(fileItem);
      if (!item) return;
      e.preventDefault();
      if (!fileItem.classList.contains('selected')) {
        config.clearSelection();
        config.toggleSelection(fileItem);
      }
      config.showContextMenu(e.pageX, e.pageY, item);
    });

    fileGrid.addEventListener('dragstart', (e) => {
      const fileItem = getFileItemElement(e.target);
      if (!fileItem) return;
      e.stopPropagation();

      if (!fileItem.classList.contains('selected')) {
        config.clearSelection();
        config.toggleSelection(fileItem);
      }

      const selectedPaths = Array.from(config.getSelectedItems());
      if (!e.dataTransfer) return;

      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', JSON.stringify(selectedPaths));
      config.setDragData(selectedPaths);
      fileItem.classList.add('dragging');

      if (selectedPaths.length > 1) {
        const dragImage = document.createElement('div');
        dragImage.className = 'drag-image';
        dragImage.textContent = `${selectedPaths.length} items`;
        dragImage.style.position = 'absolute';
        dragImage.style.top = '-1000px';
        document.body.appendChild(dragImage);
        e.dataTransfer.setDragImage(dragImage, 0, 0);
        requestAnimationFrame(() => dragImage.remove());
      }
    });

    fileGrid.addEventListener('dragend', (e) => {
      const fileItem = getFileItemElement(e.target);
      if (!fileItem) return;
      fileItem.classList.remove('dragging');
      document.querySelectorAll('.file-item.drag-over').forEach((el) => {
        el.classList.remove('drag-over', 'spring-loading');
      });
      document.getElementById('file-grid')?.classList.remove('drag-over');
      config.clearDragData();
      config.clearSpringLoad();
      config.hideDropIndicator();
    });

    fileGrid.addEventListener('dragover', (e) => {
      const fileItem = getFileItemElement(e.target);
      if (!fileItem) return;
      if (fileItem.dataset.isDirectory !== 'true' || fileItem.dataset.isAppBundle === 'true')
        return;

      config.consumeEvent(e);

      if (!e.dataTransfer) return;
      if (!e.dataTransfer.types.includes('text/plain') && e.dataTransfer.files.length === 0) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      const operation = config.getDragOperation(e);
      e.dataTransfer.dropEffect = operation;
      fileItem.classList.add('drag-over');

      const item = config.getFileItemData(fileItem);
      if (item && item.isDirectory) {
        config.showDropIndicator(operation, item.path, e.clientX, e.clientY);
        config.scheduleSpringLoad(fileItem, () => {
          fileItem.classList.remove('drag-over', 'spring-loading');
          config.navigateTo(item.path);
        });
      }
    });

    fileGrid.addEventListener('dragleave', (e) => {
      const fileItem = getFileItemElement(e.target);
      if (!fileItem) return;
      if (fileItem.dataset.isDirectory !== 'true' || fileItem.dataset.isAppBundle === 'true')
        return;

      config.consumeEvent(e);

      const rect = fileItem.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX >= rect.right ||
        e.clientY < rect.top ||
        e.clientY >= rect.bottom
      ) {
        fileItem.classList.remove('drag-over', 'spring-loading');
        config.clearSpringLoad(fileItem);
        config.hideDropIndicator();
      }
    });

    fileGrid.addEventListener('drop', async (e) => {
      const fileItem = getFileItemElement(e.target);
      if (!fileItem) return;
      if (fileItem.dataset.isDirectory !== 'true' || fileItem.dataset.isAppBundle === 'true')
        return;

      config.consumeEvent(e);

      fileItem.classList.remove('drag-over');
      config.clearSpringLoad(fileItem);

      const draggedPaths = await config.getDraggedPaths(e);

      const item = config.getFileItemData(fileItem);
      if (!item || draggedPaths.length === 0 || draggedPaths.includes(item.path)) {
        config.hideDropIndicator();
        return;
      }

      const operation = config.getDragOperation(e);
      await config.handleDrop(draggedPaths, item.path, operation);
      config.hideDropIndicator();
    });
  }

  return {
    setupFileGridEventDelegation,
    getFileItemElement,
  };
}
