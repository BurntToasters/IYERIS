import type { ToastAction } from './rendererToasts.js';
import { rendererPath as path } from './rendererUtils.js';
import { ignoreError } from './shared.js';

const SPRING_LOAD_DELAY = 800;

interface DragDropConfig {
  getCurrentPath: () => string;
  getCurrentSettings: () => { fileConflictBehavior?: string };
  getShowToast: () => (
    message: string,
    title: string,
    type: string,
    actions?: ToastAction[]
  ) => void;
  getFileGrid: () => HTMLElement | null;
  getFileView: () => HTMLElement | null;
  getDropIndicator: () => HTMLElement | null;
  getDropIndicatorAction: () => HTMLElement | null;
  getDropIndicatorPath: () => HTMLElement | null;
  consumeEvent: (e: Event) => void;
  clearSelection: () => void;
  navigateTo: (path: string) => Promise<void>;
  updateUndoRedoState: () => Promise<void>;
}

export function createDragDropController(config: DragDropConfig) {
  let springLoadedTimeout: NodeJS.Timeout | null = null;
  let springLoadedFolder: HTMLElement | null = null;

  function getDragOperation(event: DragEvent): 'copy' | 'move' {
    return event.ctrlKey || event.altKey ? 'copy' : 'move';
  }

  async function getDraggedPaths(event: DragEvent): Promise<string[]> {
    let draggedPaths: string[] = [];
    if (!event.dataTransfer) return draggedPaths;

    try {
      const textData = event.dataTransfer.getData('text/plain');
      if (textData) {
        draggedPaths = JSON.parse(textData);
      }
    } catch (error) {
      ignoreError(error);
    }

    if (draggedPaths.length === 0 && event.dataTransfer.files.length > 0) {
      draggedPaths = Array.from(event.dataTransfer.files).map(
        (f) => (f as File & { path: string }).path
      );
    }

    if (draggedPaths.length === 0) {
      const sharedData = await window.electronAPI.getDragData();
      if (sharedData) {
        draggedPaths = sharedData.paths;
      }
    }

    return draggedPaths;
  }

  function showDropIndicator(
    action: 'copy' | 'move' | 'add',
    destPath: string,
    x: number,
    y: number
  ): void {
    const dropIndicator = config.getDropIndicator();
    const dropIndicatorAction = config.getDropIndicatorAction();
    const dropIndicatorPath = config.getDropIndicatorPath();
    if (!dropIndicator || !dropIndicatorAction || !dropIndicatorPath) return;
    const label = path.basename(destPath) || destPath;
    dropIndicatorAction.textContent =
      action === 'copy' ? 'Copy' : action === 'add' ? 'Add' : 'Move';
    dropIndicatorPath.textContent = label;
    dropIndicatorPath.title = destPath;
    dropIndicator.style.display = 'inline-flex';
    dropIndicator.style.left = `${x + 12}px`;
    dropIndicator.style.top = `${y + 12}px`;
  }

  function hideDropIndicator(): void {
    const dropIndicator = config.getDropIndicator();
    if (!dropIndicator) return;
    dropIndicator.style.display = 'none';
  }

  function scheduleSpringLoad(target: HTMLElement, action: () => void): void {
    if (springLoadedFolder !== target) {
      if (springLoadedTimeout) {
        clearTimeout(springLoadedTimeout);
        springLoadedTimeout = null;
      }
      springLoadedFolder?.classList.remove('spring-loading');
      springLoadedFolder = target;
      springLoadedTimeout = setTimeout(() => {
        if (springLoadedFolder === target) {
          target.classList.remove('spring-loading');
          action();
        }
        springLoadedFolder = null;
        springLoadedTimeout = null;
      }, SPRING_LOAD_DELAY);
      setTimeout(() => {
        if (springLoadedFolder === target) {
          target.classList.add('spring-loading');
        }
      }, SPRING_LOAD_DELAY / 2);
    }
  }

  function clearSpringLoad(target?: HTMLElement): void {
    if (!target || springLoadedFolder === target) {
      if (springLoadedTimeout) {
        clearTimeout(springLoadedTimeout);
        springLoadedTimeout = null;
      }
      springLoadedFolder?.classList.remove('spring-loading');
      springLoadedFolder = null;
    }
  }

  function isDropTargetFileItem(target: EventTarget | null): boolean {
    return !!(target as HTMLElement | null)?.closest('.file-item');
  }

  function isDropTargetContentItem(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element) return false;
    return !!(
      element.closest('.file-grid') ||
      element.closest('.column-view') ||
      element.closest('.file-item') ||
      element.closest('.column-item')
    );
  }

  function isDropIntoCurrentDirectory(draggedPaths: string[], destinationPath: string): boolean {
    return draggedPaths.some((dragPath: string) => {
      const parentDir = path.dirname(dragPath);
      return parentDir === destinationPath || dragPath === destinationPath;
    });
  }

  async function handleDrop(
    sourcePaths: string[],
    destPath: string,
    operation: 'copy' | 'move'
  ): Promise<void> {
    const showToast = config.getShowToast();
    try {
      const conflictBehavior = (config.getCurrentSettings().fileConflictBehavior || 'ask') as
        | 'rename'
        | 'ask'
        | 'skip'
        | 'overwrite';
      const result =
        operation === 'copy'
          ? await window.electronAPI.copyItems(sourcePaths, destPath, conflictBehavior)
          : await window.electronAPI.moveItems(sourcePaths, destPath, conflictBehavior);

      if (!result.success) {
        showToast(result.error || `Failed to ${operation} items`, 'Error', 'error', [
          {
            label: 'Retry',
            onClick: () => void handleDrop(sourcePaths, destPath, operation),
          },
        ]);
        return;
      }
      showToast(
        `${operation === 'copy' ? 'Copied' : 'Moved'} ${sourcePaths.length} item(s)`,
        'Success',
        'success'
      );
      await window.electronAPI.clearDragData();

      if (operation === 'move') {
        await config.updateUndoRedoState();
      }

      await config.navigateTo(config.getCurrentPath());
      config.clearSelection();
    } catch (error) {
      console.error(`Error during ${operation}:`, error);
      showToast(`Failed to ${operation} items`, 'Error', 'error', [
        {
          label: 'Retry',
          onClick: () => void handleDrop(sourcePaths, destPath, operation),
        },
      ]);
    }
  }

  function initFileGridDragAndDrop(): void {
    const fileGrid = config.getFileGrid();
    if (!fileGrid) return;

    fileGrid.addEventListener('dragover', (e) => {
      if (isDropTargetFileItem(e.target)) {
        return;
      }
      config.consumeEvent(e);

      if (!e.dataTransfer) return;

      const currentPath = config.getCurrentPath();
      if (!currentPath) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }

      const operation = getDragOperation(e);
      e.dataTransfer.dropEffect = operation;
      fileGrid.classList.add('drag-over');
      showDropIndicator(operation, currentPath, e.clientX, e.clientY);
    });

    fileGrid.addEventListener('dragleave', (e) => {
      config.consumeEvent(e);

      const rect = fileGrid.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX >= rect.right ||
        e.clientY < rect.top ||
        e.clientY >= rect.bottom
      ) {
        fileGrid.classList.remove('drag-over');
        hideDropIndicator();
      }
    });

    fileGrid.addEventListener('drop', async (e) => {
      config.consumeEvent(e);

      fileGrid.classList.remove('drag-over');

      if (isDropTargetFileItem(e.target)) {
        return;
      }

      const draggedPaths = await getDraggedPaths(e);
      const currentPath = config.getCurrentPath();

      if (draggedPaths.length === 0 || !currentPath) {
        hideDropIndicator();
        return;
      }

      if (isDropIntoCurrentDirectory(draggedPaths, currentPath)) {
        config.getShowToast()('Items are already in this directory', 'Info', 'info');
        hideDropIndicator();
        return;
      }

      const operation = getDragOperation(e);
      await handleDrop(draggedPaths, currentPath, operation);
      hideDropIndicator();
    });
  }

  function initFileViewDragAndDrop(): void {
    const fileView = config.getFileView();
    if (!fileView) return;

    fileView.addEventListener('dragover', (e) => {
      if (isDropTargetContentItem(e.target)) {
        return;
      }

      config.consumeEvent(e);

      const currentPath = config.getCurrentPath();
      if (!currentPath) {
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
        return;
      }

      const operation = getDragOperation(e);
      if (e.dataTransfer) e.dataTransfer.dropEffect = operation;
      fileView.classList.add('drag-over');
      showDropIndicator(operation, currentPath, e.clientX, e.clientY);
    });

    fileView.addEventListener('dragleave', (e) => {
      e.preventDefault();
      const rect = fileView.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX >= rect.right ||
        e.clientY < rect.top ||
        e.clientY >= rect.bottom
      ) {
        fileView.classList.remove('drag-over');
        hideDropIndicator();
      }
    });

    fileView.addEventListener('drop', async (e) => {
      if (isDropTargetContentItem(e.target)) {
        return;
      }

      config.consumeEvent(e);

      fileView.classList.remove('drag-over');

      const draggedPaths = await getDraggedPaths(e);
      const currentPath = config.getCurrentPath();

      if (draggedPaths.length === 0 || !currentPath) {
        hideDropIndicator();
        return;
      }

      if (isDropIntoCurrentDirectory(draggedPaths, currentPath)) {
        config.getShowToast()('Items are already in this directory', 'Info', 'info');
        hideDropIndicator();
        return;
      }

      const operation = getDragOperation(e);
      await handleDrop(draggedPaths, currentPath, operation);
      hideDropIndicator();
    });
  }

  function initDragAndDropListeners(): void {
    initFileGridDragAndDrop();
    initFileViewDragAndDrop();
  }

  return {
    getDragOperation,
    getDraggedPaths,
    showDropIndicator,
    hideDropIndicator,
    scheduleSpringLoad,
    clearSpringLoad,
    handleDrop,
    initDragAndDropListeners,
  };
}
