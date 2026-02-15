import type { Settings, FileItem, DriveInfo } from './types';
import { escapeHtml, ignoreError } from './shared.js';
import { isWindowsPath, rendererPath as path } from './rendererUtils.js';
import { isHomeViewPath } from './home.js';

type ColumnViewDeps = {
  columnView: HTMLElement;
  getCurrentPath: () => string;
  setCurrentPath: (value: string) => void;
  getCurrentSettings: () => Settings;
  getSelectedItems: () => Set<string>;
  clearSelection: () => void;
  addressInput: HTMLInputElement;
  updateBreadcrumb: (path: string) => void;
  showToast: (message: string, title: string, type: 'success' | 'error' | 'info') => void;
  showContextMenu: (x: number, y: number, item: FileItem) => void;
  getFileIcon: (filename: string) => string;
  openFileEntry: (item: FileItem) => Promise<void>;
  updatePreview: (file: FileItem) => void;
  consumeEvent: (e: Event) => void;
  getDragOperation: (e: DragEvent) => 'copy' | 'move';
  showDropIndicator: (
    action: 'copy' | 'move' | 'add',
    destPath: string,
    x: number,
    y: number
  ) => void;
  hideDropIndicator: () => void;
  getDraggedPaths: (e: DragEvent) => Promise<string[]>;
  handleDrop: (
    sourcePaths: string[],
    destPath: string,
    operation: 'copy' | 'move'
  ) => Promise<void>;
  scheduleSpringLoad: (target: HTMLElement, action: () => void) => void;
  clearSpringLoad: (target?: HTMLElement) => void;
  createDirectoryOperationId: (prefix: string) => string;
  getCachedDriveInfo: () => DriveInfo[];
  cacheDriveInfo: (drives: DriveInfo[]) => void;
  folderTreeManager: { ensurePathVisible: (path: string) => void };
  getFileByPath: (path: string) => FileItem | undefined;
  nameCollator: Intl.Collator;
};

export function createColumnViewController(deps: ColumnViewDeps) {
  let columnPaths: string[] = [];
  let columnViewRenderId = 0;
  let isRenderingColumnView = false;
  let renderCompleteResolve: (() => void) | null = null;
  const activeColumnOperationIds = new Set<string>();

  function cancelColumnOperations(): void {
    for (const operationId of activeColumnOperationIds) {
      window.electronAPI.cancelDirectoryContents(operationId).catch(ignoreError);
    }
    activeColumnOperationIds.clear();
  }

  async function renderColumnView() {
    if (!deps.columnView) return;

    cancelColumnOperations();
    if (isHomeViewPath(deps.getCurrentPath())) {
      deps.columnView.innerHTML = '';
      return;
    }

    const currentRenderId = ++columnViewRenderId;
    if (isRenderingColumnView) {
      await Promise.race([
        new Promise<void>((resolve) => {
          renderCompleteResolve = resolve;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
      isRenderingColumnView = false;
      renderCompleteResolve = null;
      if (currentRenderId !== columnViewRenderId) return;
    }

    isRenderingColumnView = true;
    const savedScrollLeft = deps.columnView.scrollLeft;

    try {
      deps.columnView.innerHTML = '';
      columnPaths = [];

      if (!deps.getCurrentPath()) {
        await renderDriveColumn();
        return;
      }

      const isWindows = isWindowsPath(deps.getCurrentPath());

      if (isWindows) {
        const parts = deps.getCurrentPath().split('\\').filter(Boolean);
        for (let i = 0; i < parts.length; i++) {
          if (i === 0) {
            columnPaths.push(parts[0] + '\\');
          } else {
            columnPaths.push(parts.slice(0, i + 1).join('\\'));
          }
        }
      } else {
        const parts = deps.getCurrentPath().split('/').filter(Boolean);
        columnPaths.push('/');
        for (let i = 0; i < parts.length; i++) {
          columnPaths.push('/' + parts.slice(0, i + 1).join('/'));
        }
      }

      const panePromises = columnPaths.map((colPath, index) =>
        renderColumn(colPath, index, currentRenderId)
      );

      const panes = await Promise.all(panePromises);

      if (currentRenderId !== columnViewRenderId) {
        return;
      }

      for (const pane of panes) {
        if (pane) {
          deps.columnView.appendChild(pane);
        }
      }

      setTimeout(() => {
        if (currentRenderId !== columnViewRenderId) return;
        if (savedScrollLeft > 0) {
          deps.columnView.scrollLeft = savedScrollLeft;
        } else {
          deps.columnView.scrollLeft = deps.columnView.scrollWidth;
        }
      }, 50);
    } finally {
      isRenderingColumnView = false;
      if (renderCompleteResolve) {
        renderCompleteResolve();
        renderCompleteResolve = null;
      }
    }
  }

  function addColumnResizeHandle(pane: HTMLElement) {
    const handle = document.createElement('div');
    handle.className = 'column-resize-handle';

    let startX: number;
    let startWidth: number;

    const onMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      const newWidth = Math.max(150, Math.min(500, startWidth + delta));
      pane.style.width = newWidth + 'px';
    };

    const onMouseUp = () => {
      handle.classList.remove('resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = pane.offsetWidth;
      handle.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      window.addEventListener('blur', onMouseUp);
    });

    pane.appendChild(handle);
  }

  async function renderDriveColumn() {
    const pane = document.createElement('div');
    pane.className = 'column-pane';

    try {
      const drives =
        deps.getCachedDriveInfo().length > 0
          ? deps.getCachedDriveInfo()
          : await window.electronAPI.getDriveInfo();
      if (deps.getCachedDriveInfo().length === 0) {
        deps.cacheDriveInfo(drives);
      }
      drives.forEach((drive) => {
        const item = document.createElement('div');
        item.className = 'column-item is-directory';
        item.tabIndex = 0;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', 'false');
        item.dataset.path = drive.path;
        item.title = drive.path;
        item.innerHTML = `
        <span class="column-item-icon"><img src="../assets/twemoji/1f4bf.svg" class="twemoji" alt="💿" draggable="false" /></span>
        <span class="column-item-name">${escapeHtml(drive.label || drive.path)}</span>
        <span class="column-item-arrow">▸</span>
      `;
        item.addEventListener('click', () => handleColumnItemClick(item, drive.path, true, 0));
        pane.appendChild(item);
      });
    } catch {
      pane.innerHTML = '<div class="column-item placeholder">Error loading drives</div>';
    }

    addColumnResizeHandle(pane);
    deps.columnView.appendChild(pane);
  }

  async function renderColumn(
    columnPath: string,
    columnIndex: number,
    renderId?: number
  ): Promise<HTMLDivElement | null> {
    if (renderId !== undefined && renderId !== columnViewRenderId) {
      return null;
    }

    const pane = document.createElement('div');
    pane.className = 'column-pane';
    pane.dataset.columnIndex = String(columnIndex);
    pane.dataset.path = columnPath;

    pane.addEventListener('dragover', (e) => {
      if ((e.target as HTMLElement).closest('.column-item')) {
        return;
      }
      deps.consumeEvent(e);

      if (
        !e.dataTransfer ||
        (!e.dataTransfer.types.includes('text/plain') && e.dataTransfer.files.length === 0)
      ) {
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
        return;
      }

      const operation = deps.getDragOperation(e);
      e.dataTransfer.dropEffect = operation;
      pane.classList.add('drag-over');
      deps.showDropIndicator(operation, columnPath, e.clientX, e.clientY);
    });

    pane.addEventListener('dragleave', (e) => {
      if ((e.target as HTMLElement).closest('.column-item')) {
        return;
      }
      e.preventDefault();
      const rect = pane.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX >= rect.right ||
        e.clientY < rect.top ||
        e.clientY >= rect.bottom
      ) {
        pane.classList.remove('drag-over');
        deps.hideDropIndicator();
      }
    });

    pane.addEventListener('drop', async (e) => {
      if ((e.target as HTMLElement).closest('.column-item')) {
        return;
      }
      deps.consumeEvent(e);

      pane.classList.remove('drag-over');

      const draggedPaths = await deps.getDraggedPaths(e);

      if (draggedPaths.length === 0) {
        deps.hideDropIndicator();
        return;
      }

      const alreadyInCurrentDir = draggedPaths.some((filePath: string) => {
        const parentDir = path.dirname(filePath);
        return parentDir === columnPath || filePath === columnPath;
      });

      if (alreadyInCurrentDir) {
        deps.showToast('Items are already in this directory', 'Info', 'info');
        deps.hideDropIndicator();
        return;
      }

      const operation = deps.getDragOperation(e);
      await deps.handleDrop(draggedPaths, columnPath, operation);
      deps.hideDropIndicator();
    });

    try {
      const operationId = deps.createDirectoryOperationId('column');
      activeColumnOperationIds.add(operationId);
      let result: { success: boolean; contents?: FileItem[]; error?: string };
      try {
        result = await window.electronAPI.getDirectoryContents(
          columnPath,
          operationId,
          deps.getCurrentSettings().showHiddenFiles
        );
      } finally {
        activeColumnOperationIds.delete(operationId);
      }
      if (renderId !== undefined && renderId !== columnViewRenderId) {
        return null;
      }
      if (!result.success) {
        throw new Error(result.error || 'Error loading folder');
      }
      const items = result.contents || [];

      const sortedItems = [...items].sort((a, b) => {
        const dirSort = (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0);
        if (dirSort !== 0) return dirSort;
        return deps.nameCollator.compare(a.name, b.name);
      });

      const visibleItems = deps.getCurrentSettings().showHiddenFiles
        ? sortedItems
        : sortedItems.filter((item) => !item.isHidden);

      if (visibleItems.length === 0) {
        pane.innerHTML = '<div class="column-item placeholder">Empty folder</div>';
      } else {
        visibleItems.forEach((fileItem) => {
          const item = document.createElement('div');
          item.className = 'column-item';
          item.tabIndex = 0;
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', 'false');
          if (fileItem.isDirectory) item.classList.add('is-directory');
          item.dataset.path = fileItem.path;

          const nextColPath = columnPaths[columnIndex + 1];
          if (nextColPath && fileItem.path === nextColPath) {
            item.classList.add('expanded');
            item.setAttribute('aria-selected', 'true');
          }

          const icon = fileItem.isDirectory
            ? '<img src="../assets/twemoji/1f4c1.svg" class="twemoji" alt="📁" draggable="false" />'
            : deps.getFileIcon(fileItem.name);

          item.innerHTML = `
          <span class="column-item-icon">${icon}</span>
          <span class="column-item-name">${escapeHtml(fileItem.name)}</span>
          ${fileItem.isDirectory ? '<span class="column-item-arrow">▸</span>' : ''}
        `;

          item.addEventListener('click', () =>
            handleColumnItemClick(item, fileItem.path, fileItem.isDirectory, columnIndex)
          );
          item.addEventListener('dblclick', () => {
            if (!fileItem.isDirectory) {
              void deps.openFileEntry(fileItem);
            }
          });

          item.addEventListener('contextmenu', (e) => {
            deps.consumeEvent(e);

            pane.querySelectorAll('.column-item').forEach((i) => {
              i.classList.remove('selected');
              i.setAttribute('aria-selected', 'false');
            });
            item.classList.add('selected');
            item.setAttribute('aria-selected', 'true');

            deps.clearSelection();
            deps.getSelectedItems().add(fileItem.path);

            const colPath = columnPaths[columnIndex];
            if (colPath && colPath !== deps.getCurrentPath()) {
              deps.setCurrentPath(colPath);
              deps.addressInput.value = colPath;
              deps.updateBreadcrumb(colPath);
            }

            deps.showContextMenu(e.pageX, e.pageY, fileItem);
          });

          item.draggable = true;

          item.addEventListener('dragstart', (e) => {
            e.stopPropagation();

            if (!item.classList.contains('selected')) {
              pane.querySelectorAll('.column-item').forEach((i) => {
                i.classList.remove('selected');
                i.setAttribute('aria-selected', 'false');
              });
              item.classList.add('selected');
              item.setAttribute('aria-selected', 'true');
              deps.clearSelection();
              deps.getSelectedItems().add(fileItem.path);
            }

            const selectedPaths = Array.from(deps.getSelectedItems());
            if (e.dataTransfer) {
              e.dataTransfer.effectAllowed = 'copyMove';
              e.dataTransfer.setData('text/plain', JSON.stringify(selectedPaths));
            }

            window.electronAPI.setDragData(selectedPaths);

            item.classList.add('dragging');
          });

          item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            document.querySelectorAll('.column-item.drag-over').forEach((el) => {
              el.classList.remove('drag-over');
            });
            window.electronAPI.clearDragData();
            deps.clearSpringLoad();
            deps.hideDropIndicator();
          });

          if (fileItem.isDirectory) {
            item.addEventListener('dragover', (e) => {
              deps.consumeEvent(e);

              if (
                !e.dataTransfer ||
                (!e.dataTransfer.types.includes('text/plain') && e.dataTransfer.files.length === 0)
              ) {
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
                return;
              }

              const operation = deps.getDragOperation(e);
              e.dataTransfer.dropEffect = operation;
              item.classList.add('drag-over');
              deps.showDropIndicator(operation, fileItem.path, e.clientX, e.clientY);
              deps.scheduleSpringLoad(item, () => {
                item.classList.remove('drag-over', 'spring-loading');
                handleColumnItemClick(item, fileItem.path, true, columnIndex);
              });
            });

            item.addEventListener('dragleave', (e) => {
              deps.consumeEvent(e);
              const rect = item.getBoundingClientRect();
              if (
                e.clientX < rect.left ||
                e.clientX >= rect.right ||
                e.clientY < rect.top ||
                e.clientY >= rect.bottom
              ) {
                item.classList.remove('drag-over');
                deps.clearSpringLoad(item);
                deps.hideDropIndicator();
              }
            });

            item.addEventListener('drop', async (e) => {
              deps.consumeEvent(e);

              item.classList.remove('drag-over');
              deps.clearSpringLoad(item);

              const draggedPaths = await deps.getDraggedPaths(e);

              if (draggedPaths.length === 0 || draggedPaths.includes(fileItem.path)) {
                deps.hideDropIndicator();
                return;
              }

              const operation = deps.getDragOperation(e);
              await deps.handleDrop(draggedPaths, fileItem.path, operation);
              deps.hideDropIndicator();
            });
          }

          pane.appendChild(item);
        });
      }
    } catch {
      pane.innerHTML = '<div class="column-item placeholder">Error loading folder</div>';
    }

    addColumnResizeHandle(pane);
    return pane;
  }

  async function handleColumnItemClick(
    element: HTMLElement,
    itemPath: string,
    isDirectory: boolean,
    _columnIndex: number
  ) {
    const currentPane = element.closest('.column-pane');
    if (!currentPane) return;

    cancelColumnOperations();
    const clickRenderId = ++columnViewRenderId;
    const allPanes = Array.from(deps.columnView.querySelectorAll('.column-pane'));
    const currentPaneIndex = allPanes.indexOf(currentPane as Element);

    for (let i = allPanes.length - 1; i > currentPaneIndex; i--) {
      allPanes[i].remove();
    }
    columnPaths = columnPaths.slice(0, currentPaneIndex + 1);

    currentPane.querySelectorAll('.column-item').forEach((item) => {
      item.classList.remove('expanded', 'selected');
      item.setAttribute('aria-selected', 'false');
    });

    if (isDirectory) {
      element.classList.add('expanded');
      element.setAttribute('aria-selected', 'true');
      columnPaths.push(itemPath);

      deps.setCurrentPath(itemPath);
      deps.addressInput.value = itemPath;
      deps.updateBreadcrumb(itemPath);
      try {
        deps.folderTreeManager.ensurePathVisible(itemPath);
      } catch (error) {
        ignoreError(error);
      }

      const newPane = await renderColumn(itemPath, currentPaneIndex + 1, clickRenderId);

      if (clickRenderId === columnViewRenderId && newPane) {
        deps.columnView.appendChild(newPane);
      }

      setTimeout(() => {
        if (clickRenderId !== columnViewRenderId) return;
        deps.columnView.scrollLeft = deps.columnView.scrollWidth;
      }, 50);
    } else {
      element.classList.add('selected');
      element.setAttribute('aria-selected', 'true');
      deps.clearSelection();
      deps.getSelectedItems().add(itemPath);

      const parentPath = columnPaths[currentPaneIndex];
      if (parentPath && parentPath !== deps.getCurrentPath()) {
        deps.setCurrentPath(parentPath);
        deps.addressInput.value = parentPath;
        deps.updateBreadcrumb(parentPath);
        try {
          deps.folderTreeManager.ensurePathVisible(parentPath);
        } catch (error) {
          ignoreError(error);
        }
      }

      const previewPanel = document.getElementById('preview-panel');
      if (previewPanel && previewPanel.style.display !== 'none') {
        let file = deps.getFileByPath(itemPath);
        if (!file) {
          const fileName = itemPath.split(/[\\/]/).pop() || '';
          file = {
            name: fileName,
            path: itemPath,
            isDirectory: false,
            isFile: true,
            size: 0,
            modified: new Date(),
            isHidden: fileName.startsWith('.'),
          };
        }
        deps.updatePreview(file);
      }
    }
  }

  return {
    cancelColumnOperations,
    renderColumnView,
  };
}
