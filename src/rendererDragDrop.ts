import type { ToastAction } from './rendererToasts.js';
import { isPermissionDeniedError } from './rendererClipboard.js';
import { rendererPath as path } from './rendererUtils.js';
import { devLog } from './shared.js';
import { t } from './i18n.js';

const SPRING_LOAD_DELAY = 800;
const NATIVE_DROP_CACHE_MS = 1500;

interface DragDropConfig {
  getCurrentPath: () => string;
  getCurrentSettings: () => { fileConflictBehavior?: string };
  getShowToast: () => (
    message: string,
    title: string,
    type: string,
    actions?: ToastAction[]
  ) => void;
  showConfirm?: (message: string, title: string, type: 'warning') => Promise<boolean>;
  getFileGrid: () => HTMLElement | null;
  getFileView: () => HTMLElement | null;
  getDropIndicator: () => HTMLElement | null;
  getDropIndicatorAction: () => HTMLElement | null;
  getDropIndicatorPath: () => HTMLElement | null;
  consumeEvent: (e: Event) => void;
  clearSelection: () => void;
  navigateTo: (path: string) => Promise<void>;
  updateUndoRedoState: () => Promise<void>;
  getPlatformOS: () => string;
  generateOperationId?: () => string;
  addOperation?: (
    id: string,
    kind: 'copy' | 'move',
    name: string,
    options?: { cancellable?: boolean; total?: number; retry?: () => void }
  ) => void;
  updateOperation?: (id: string, update: { currentFile?: string; status?: 'active' }) => void;
  completeOperation?: (id: string, status: 'done' | 'failed', error?: string) => void;
}

export function createDragDropController(config: DragDropConfig) {
  let springLoadedTimeout: NodeJS.Timeout | null = null;
  let springLoadedFolder: HTMLElement | null = null;
  let springLoadAnimTimer: NodeJS.Timeout | null = null;
  let dropInProgress = false;
  let nativeDropPaths: string[] = [];
  let nativeDropPathsAt = 0;
  let nativeDragDropUnlisten: (() => void) | null = null;

  function updateQueued(
    operationId: string | undefined,
    update: { currentFile?: string; status?: 'active' }
  ): void {
    if (operationId) config.updateOperation?.(operationId, update);
  }

  function completeQueued(
    operationId: string | undefined,
    status: 'done' | 'failed',
    error?: string
  ): void {
    if (operationId) config.completeOperation?.(operationId, status, error);
  }

  function isAbsolutePath(value: string): boolean {
    return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
  }

  function decodeFileUrl(value: string): string {
    try {
      const url = new URL(value);
      if (url.protocol !== 'file:') return '';
      let decodedPath = '';
      try {
        decodedPath = decodeURIComponent(url.pathname || '');
      } catch {
        decodedPath = url.pathname || '';
      }

      if (
        config.getPlatformOS() === 'win32' &&
        url.hostname &&
        /^[A-Za-z]$/.test(url.hostname) &&
        decodedPath.startsWith('/')
      ) {
        return `${url.hostname.toUpperCase()}:${decodedPath.replace(/\//g, '\\')}`;
      }

      if (config.getPlatformOS() === 'win32' && /^\/[A-Za-z]:[\\/]/.test(decodedPath)) {
        decodedPath = decodedPath.slice(1);
      }

      if (url.hostname && url.hostname !== 'localhost') {
        if (config.getPlatformOS() === 'win32') {
          return `\\\\${url.hostname}${decodedPath.replace(/\//g, '\\')}`;
        }
        return `//${url.hostname}${decodedPath}`;
      }
      return decodedPath;
    } catch {
      return '';
    }
  }

  function normalizeDraggedPath(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    let normalized = value.trim();
    if (!normalized) return null;

    const hasWrappingQuotes =
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"));
    if (hasWrappingQuotes && normalized.length >= 2) {
      normalized = normalized.slice(1, -1).trim();
      if (!normalized) return null;
    }

    if (normalized.startsWith('file://')) {
      normalized = decodeFileUrl(normalized);
      if (!normalized) return null;
    }

    if (normalized.startsWith('/.file/id=')) {
      return null;
    }

    if (!isAbsolutePath(normalized)) {
      return null;
    }

    return normalized;
  }

  function normalizeDraggedPaths(value: unknown): string[] {
    const candidates = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    const normalized = new Set<string>();
    for (const candidate of candidates) {
      const normalizedPath = normalizeDraggedPath(candidate);
      if (normalizedPath) {
        normalized.add(normalizedPath);
      }
    }
    return Array.from(normalized);
  }

  function consumeNativeDropPaths(): string[] {
    if (nativeDropPaths.length === 0) return [];
    if (Date.now() - nativeDropPathsAt > NATIVE_DROP_CACHE_MS) {
      nativeDropPaths = [];
      return [];
    }
    const paths = nativeDropPaths;
    nativeDropPaths = [];
    return paths;
  }

  function extractPathsFromText(textData: string): string[] {
    const trimmed = textData.trim();
    if (!trimmed) return [];
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return normalizeDraggedPaths(lines.length > 1 ? lines : trimmed);
  }

  function readDataTransferText(dataTransfer: DataTransfer, format: string): string {
    try {
      return dataTransfer.getData(format);
    } catch {
      return '';
    }
  }

  function getDragOperation(event: DragEvent): 'copy' | 'move' {
    return event.ctrlKey || event.metaKey || event.altKey ? 'copy' : 'move';
  }

  async function getDraggedPaths(event: DragEvent): Promise<string[]> {
    let draggedPaths: string[] = [];
    if (!event.dataTransfer) return draggedPaths;

    const textData = readDataTransferText(event.dataTransfer, 'text/plain');
    if (textData) {
      try {
        const parsed: unknown = JSON.parse(textData);
        if (Array.isArray(parsed)) draggedPaths = normalizeDraggedPaths(parsed);
      } catch {
        draggedPaths = extractPathsFromText(textData);
      }
    }

    if (draggedPaths.length === 0) {
      const uriListData = readDataTransferText(event.dataTransfer, 'text/uri-list');
      if (uriListData) {
        draggedPaths = extractPathsFromText(uriListData);
      }
    }

    if (draggedPaths.length === 0) {
      const publicFileUrlData = readDataTransferText(event.dataTransfer, 'public.file-url');
      if (publicFileUrlData) {
        draggedPaths = extractPathsFromText(publicFileUrlData);
      }
    }

    if (draggedPaths.length === 0 && event.dataTransfer.files.length > 0) {
      draggedPaths = normalizeDraggedPaths(
        Array.from(event.dataTransfer.files).map((file) => {
          const fromFilePath = (file as File & { path?: string | null }).path;
          if (typeof fromFilePath === 'string' && fromFilePath.trim()) {
            return fromFilePath;
          }
          try {
            return window.tauriAPI.getPathForFile?.(file) || '';
          } catch {
            return '';
          }
        })
      );
    }

    if (draggedPaths.length === 0) {
      draggedPaths = consumeNativeDropPaths();
    }

    if (draggedPaths.length === 0) {
      try {
        const sharedData = await window.tauriAPI.getDragData();
        if (sharedData && Array.isArray(sharedData.paths)) {
          draggedPaths = normalizeDraggedPaths(sharedData.paths);
        }
      } catch {
        draggedPaths = [];
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
      if (springLoadAnimTimer) {
        clearTimeout(springLoadAnimTimer);
        springLoadAnimTimer = null;
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
      springLoadAnimTimer = setTimeout(() => {
        if (springLoadedFolder === target) {
          target.classList.add('spring-loading');
        }
        springLoadAnimTimer = null;
      }, SPRING_LOAD_DELAY / 2);
    }
  }

  function clearSpringLoad(target?: HTMLElement): void {
    if (!target || springLoadedFolder === target) {
      if (springLoadedTimeout) {
        clearTimeout(springLoadedTimeout);
        springLoadedTimeout = null;
      }
      if (springLoadAnimTimer) {
        clearTimeout(springLoadAnimTimer);
        springLoadAnimTimer = null;
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

  function isDescendantPath(child: string, parent: string): boolean {
    if (!child || !parent) return false;
    const norm = (p: string) => p.replace(/[/\\]+$/, '').replace(/\\/g, '/');
    const c = norm(child);
    const p = norm(parent);
    if (c === p) return false;
    return c.toLowerCase().startsWith(p.toLowerCase() + '/');
  }

  function isDropIntoCurrentDirectory(draggedPaths: string[], destinationPath: string): boolean {
    return draggedPaths.some((dragPath: string) => {
      if (!dragPath) return false;
      const parentDir = path.dirname(dragPath);
      return parentDir === destinationPath || dragPath === destinationPath;
    });
  }

  async function handleDrop(
    sourcePaths: string[],
    destPath: string,
    operation: 'copy' | 'move'
  ): Promise<boolean> {
    if (dropInProgress) return false;
    for (const sp of sourcePaths) {
      if (sp === destPath || isDescendantPath(destPath, sp)) {
        config.getShowToast()(
          'Cannot drop a folder into itself or a descendant',
          'Invalid Drop',
          'warning'
        );
        return false;
      }
    }
    dropInProgress = true;
    devLog('DragDrop', `handleDrop: ${operation} ${sourcePaths.length} item(s) to ${destPath}`);
    const showToast = config.getShowToast();
    const operationId = config.addOperation
      ? (config.generateOperationId?.() ?? `drop_${Date.now()}_${Math.random().toString(36)}`)
      : undefined;
    const retry = () => void handleDrop(sourcePaths, destPath, operation);
    if (operationId) {
      config.addOperation?.(
        operationId,
        operation,
        `${sourcePaths.length} item(s) to ${path.basename(destPath) || destPath}`,
        {
          cancellable: true,
          total: sourcePaths.length,
          retry,
        }
      );
    }
    try {
      const conflictBehavior = (config.getCurrentSettings().fileConflictBehavior || 'ask') as
        | 'rename'
        | 'ask'
        | 'skip'
        | 'overwrite';
      const result =
        operation === 'copy'
          ? operationId
            ? await window.tauriAPI.copyItems(sourcePaths, destPath, conflictBehavior, operationId)
            : await window.tauriAPI.copyItems(sourcePaths, destPath, conflictBehavior)
          : operationId
            ? await window.tauriAPI.moveItems(sourcePaths, destPath, conflictBehavior, operationId)
            : await window.tauriAPI.moveItems(sourcePaths, destPath, conflictBehavior);

      if (!result.success) {
        if (isPermissionDeniedError(result.error)) {
          const confirmed = config.showConfirm
            ? await config.showConfirm(
                'This operation requires administrator privileges. You will be prompted to authorize.',
                'Elevated Permissions Required',
                'warning'
              )
            : false;
          if (confirmed) {
            updateQueued(operationId, {
              currentFile: 'Waiting for elevated permissions...',
              status: 'active',
            });
            const elevResult =
              operation === 'copy'
                ? await window.tauriAPI.elevatedCopyBatch(sourcePaths, destPath)
                : await window.tauriAPI.elevatedMoveBatch(sourcePaths, destPath);
            if (elevResult.success) {
              completeQueued(operationId, 'done');
              showToast(
                `${operation === 'copy' ? 'Copied' : 'Moved'} ${sourcePaths.length} item(s) (elevated)`,
                'Success',
                'success'
              );
              await window.tauriAPI.clearDragData();
              if (operation === 'move') {
                await config.updateUndoRedoState();
              }
              await config.navigateTo(config.getCurrentPath());
              config.clearSelection();
              return true;
            }
            completeQueued(
              operationId,
              'failed',
              elevResult.error || `Elevated ${operation} failed`
            );
            showToast(
              elevResult.error || t('dragDrop.elevatedFailed', { operation }),
              t('common.error'),
              'error'
            );
            return false;
          }
          completeQueued(operationId, 'failed', 'Operation cancelled');
          showToast(t('dragDrop.operationCancelled'), t('common.info'), 'info');
          return false;
        }
        completeQueued(operationId, 'failed', result.error || `Failed to ${operation} items`);
        showToast(result.error || t('dragDrop.failed', { operation }), t('common.error'), 'error', [
          {
            label: t('common.retry'),
            onClick: () => void handleDrop(sourcePaths, destPath, operation),
          },
        ]);
        return false;
      }
      completeQueued(operationId, 'done');
      showToast(
        `${operation === 'copy' ? 'Copied' : 'Moved'} ${sourcePaths.length} item(s)`,
        'Success',
        'success'
      );
      await window.tauriAPI.clearDragData();

      if (operation === 'move') {
        await config.updateUndoRedoState();
      }

      await config.navigateTo(config.getCurrentPath());
      config.clearSelection();
      return true;
    } catch (error) {
      console.error(`Error during ${operation}:`, error);
      completeQueued(operationId, 'failed', String(error));
      showToast(t('dragDrop.failed', { operation }), t('common.error'), 'error', [
        {
          label: t('common.retry'),
          onClick: () => void handleDrop(sourcePaths, destPath, operation),
        },
      ]);
      return false;
    } finally {
      dropInProgress = false;
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
      hideDropIndicator();

      if (isDropTargetFileItem(e.target)) {
        return;
      }

      try {
        const draggedPaths = await getDraggedPaths(e);
        const currentPath = config.getCurrentPath();

        if (draggedPaths.length === 0 || !currentPath) {
          if (draggedPaths.length === 0 && e.dataTransfer?.files.length) {
            config.getShowToast()('Could not resolve dropped file paths', 'Drop Failed', 'warning');
          }
          return;
        }

        if (isDropIntoCurrentDirectory(draggedPaths, currentPath)) {
          config.getShowToast()(t('toast.alreadyInDirectory'), t('common.info'), 'info');
          return;
        }

        const operation = getDragOperation(e);
        await handleDrop(draggedPaths, currentPath, operation);
      } catch (error) {
        console.error('Error handling drop:', error);
        config.getShowToast()('Failed to handle drop', 'Error', 'error');
      }
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
        // Clean up drag state before the early return so the highlight
        // doesn't get stuck when dropping onto a file item.
        fileView.classList.remove('drag-over');
        hideDropIndicator();
        return;
      }

      config.consumeEvent(e);

      fileView.classList.remove('drag-over');

      try {
        const draggedPaths = await getDraggedPaths(e);
        const currentPath = config.getCurrentPath();

        if (draggedPaths.length === 0 || !currentPath) {
          if (draggedPaths.length === 0 && e.dataTransfer?.files.length) {
            config.getShowToast()('Could not resolve dropped file paths', 'Drop Failed', 'warning');
          }
          return;
        }

        if (isDropIntoCurrentDirectory(draggedPaths, currentPath)) {
          config.getShowToast()(t('toast.alreadyInDirectory'), t('common.info'), 'info');
          return;
        }

        const operation = getDragOperation(e);
        await handleDrop(draggedPaths, currentPath, operation);
      } catch (error) {
        console.error('Error handling drop:', error);
        config.getShowToast()('Failed to handle drop', 'Error', 'error');
      } finally {
        hideDropIndicator();
      }
    });
  }

  function initDragAndDropListeners(): void {
    initFileGridDragAndDrop();
    initFileViewDragAndDrop();
    if (!nativeDragDropUnlisten && window.tauriAPI.onNativeDragDrop) {
      nativeDragDropUnlisten = window.tauriAPI.onNativeDragDrop((event) => {
        if (event.type === 'drop' || event.type === 'enter') {
          nativeDropPaths = normalizeDraggedPaths(event.paths || []);
          nativeDropPathsAt = Date.now();
        } else if (event.type === 'leave') {
          nativeDropPaths = [];
        }
      });
    }
  }

  function destroyDragAndDropListeners(): void {
    nativeDragDropUnlisten?.();
    nativeDragDropUnlisten = null;
    nativeDropPaths = [];
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
    destroyDragAndDropListeners,
  };
}
