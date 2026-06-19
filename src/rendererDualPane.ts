import type { Settings, FileItem } from './types';
import { escapeHtml, getErrorMessage, ignoreError } from './shared.js';
import { t } from './i18n.js';
import { rendererPath as path } from './rendererUtils.js';
import { formatFileSize, getFileIcon } from './rendererFileIcons.js';
import { NAME_COLLATOR, DATE_FORMATTER } from './rendererLocalConstants.js';

type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface DualPaneDeps {
  getCurrentSettings: () => Settings;
  getCurrentPath: () => string;
  getSelectedItems: () => Set<string>;
  setSelectedItems: (value: Set<string>) => void;
  getPrimaryPaneSelected: () => Set<string>;
  setPrimaryPaneSelected: (value: Set<string>) => void;
  getSecondaryPaneSelected: () => Set<string>;
  setSecondaryPaneSelected: (value: Set<string>) => void;
  getFileElementMap: () => Map<string, HTMLElement>;
  updateStatusBar: () => void;
  debouncedSaveSettings: (delay?: number) => void;
  showToast: (message: string, title: string, type: ToastType) => void;
  refresh: (reason?: string) => void;
  navigateTo: (pathValue: string) => void;
  observeThumbnailItem: (row: HTMLElement, scope: string) => void;
  showContextMenu: (x: number, y: number, item: FileItem) => void;
  getDragOperation: (event: DragEvent) => 'copy' | 'move';
  getDraggedPaths: (event: DragEvent) => Promise<string[]>;
  showDropIndicator: (operation: 'copy' | 'move', targetPath: string, x: number, y: number) => void;
  hideDropIndicator: () => void;
  scheduleSpringLoad: (row: HTMLElement, action: () => void) => void;
  clearSpringLoad: () => void;
  handleDrop: (paths: string[], destPath: string, operation: 'copy' | 'move') => Promise<void>;
  copySelectedToDestination: (destPath: string) => Promise<boolean>;
  moveSelectedToDestination: (destPath: string) => Promise<boolean>;
}

export function createDualPaneController(deps: DualPaneDeps) {
  let secondaryPanePath = '';
  let secondaryPaneItems: FileItem[] = [];
  const secondaryFilePathMap = new Map<string, FileItem>();
  const secondaryFileElementMap = new Map<string, HTMLElement>();

  function getDualPaneElement<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  function getActiveFileGridScope(): HTMLElement | null {
    const settings = deps.getCurrentSettings();
    const isSecondary = settings.dualPaneEnabled === true && settings.activePane === 'right';
    return document.getElementById(isSecondary ? 'dual-pane-secondary-list' : 'file-grid');
  }

  function renderSecondaryPaneItems(items: FileItem[]): void {
    const list = getDualPaneElement<HTMLElement>('dual-pane-secondary-list');
    if (!list) return;
    const settings = deps.getCurrentSettings();
    const secondaryPaneSelectedItems = deps.getSecondaryPaneSelected();
    list.replaceChildren();
    secondaryFilePathMap.clear();
    secondaryFileElementMap.clear();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dual-pane-empty';
      empty.textContent = 'No items';
      list.appendChild(empty);
      return;
    }
    const sortBy = settings.sortBy || 'name';
    const sortOrder = settings.sortOrder || 'asc';
    const sorted = [...items].sort((a, b) => {
      const dirSort = (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0);
      if (dirSort !== 0) return dirSort;
      const comparison =
        sortBy === 'date'
          ? new Date(a.modified).getTime() - new Date(b.modified).getTime()
          : sortBy === 'size'
            ? a.size - b.size
            : sortBy === 'type'
              ? (() => {
                  const extA = path.extname(a.name).toLowerCase();
                  const extB = path.extname(b.name).toLowerCase();
                  return NAME_COLLATOR.compare(extA, extB);
                })()
              : NAME_COLLATOR.compare(a.name, b.name);
      return sortOrder === 'asc' ? comparison : -comparison;
    });
    let thumbnailCount = 0;
    const thumbnailCap = 400;
    for (const item of sorted) {
      secondaryFilePathMap.set(item.path, item);
      const row = document.createElement('div');
      row.className = 'file-item dual-pane-item';
      row.dataset.path = item.path;
      row.dataset.directory = String(item.isDirectory);
      row.dataset.isDirectory = String(item.isDirectory);
      row.tabIndex = -1;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      const icon = getFileIcon(item.name);
      const thumbType = item.isDirectory
        ? ''
        : path.extname(item.name).toLowerCase().replace('.', '');
      const canThumb =
        !item.isDirectory &&
        [
          'png',
          'jpg',
          'jpeg',
          'gif',
          'webp',
          'bmp',
          'tiff',
          'avif',
          'heic',
          'heif',
          'mp4',
          'mov',
          'mkv',
          'avi',
          'webm',
          'mp3',
          'wav',
          'flac',
          'm4a',
          'aac',
          'ogg',
          'pdf',
          'docx',
          'xlsx',
          'pptx',
        ].includes(thumbType);
      if (canThumb && thumbnailCount < thumbnailCap) {
        row.classList.add('has-thumbnail');
        row.dataset.thumbnailType = ['pdf'].includes(thumbType)
          ? 'pdf'
          : ['docx', 'xlsx', 'pptx'].includes(thumbType)
            ? 'office'
            : ['mp4', 'mov', 'mkv', 'avi', 'webm'].includes(thumbType)
              ? 'video'
              : ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'].includes(thumbType)
                ? 'audio'
                : 'image';
        thumbnailCount++;
      }
      // eslint-disable-next-line no-restricted-syntax -- user data via escapeHtml(); icons/numerics are safe
      row.innerHTML = `
      <div class="file-main">
        <div class="file-checkbox"><span class="checkbox-mark">✓</span></div>
        <div class="file-icon">${icon}</div>
        <div class="file-text">
          <div class="file-name dual-pane-item-name">${escapeHtml(item.name)}</div>
        </div>
      </div>
      <div class="file-info">
        <span class="file-type">${item.isDirectory ? 'Folder' : escapeHtml(path.extname(item.name).replace('.', '').toUpperCase() || 'File')}</span>
        <span class="file-size">${item.isDirectory ? '--' : formatFileSize(item.size)}</span>
        <span class="file-modified">${DATE_FORMATTER.format(new Date(item.modified))}</span>
      </div>
    `;
      secondaryFileElementMap.set(item.path, row);
      if (secondaryPaneSelectedItems.has(item.path)) {
        row.classList.add('selected');
        row.setAttribute('aria-selected', 'true');
      }
      if (row.classList.contains('has-thumbnail')) {
        deps.observeThumbnailItem(row, 'dual-pane-secondary-list');
      }
      list.appendChild(row);
    }
  }

  function syncDualPaneControls(): void {
    const settings = deps.getCurrentSettings();
    const enabled = settings.dualPaneEnabled === true;
    const secondary = getDualPaneElement<HTMLElement>('dual-pane-secondary');
    const copyBtn = getDualPaneElement<HTMLButtonElement>('copy-to-other-pane-btn');
    const moveBtn = getDualPaneElement<HTMLButtonElement>('move-to-other-pane-btn');
    const hasSelection = deps.getSelectedItems().size > 0;
    const hasTargetPath =
      settings.activePane === 'right' ? Boolean(deps.getCurrentPath()) : Boolean(secondaryPanePath);
    if (secondary) secondary.style.display = enabled ? 'flex' : 'none';
    if (copyBtn) {
      copyBtn.style.display = enabled ? '' : 'none';
      copyBtn.disabled = !enabled || !hasTargetPath || !hasSelection;
    }
    if (moveBtn) {
      moveBtn.style.display = enabled ? '' : 'none';
      moveBtn.disabled = !enabled || !hasTargetPath || !hasSelection;
    }
  }

  function syncPaneSelectionVisuals(): void {
    const primaryPaneSelectedItems = deps.getPrimaryPaneSelected();
    const secondaryPaneSelectedItems = deps.getSecondaryPaneSelected();
    deps.getFileElementMap().forEach((el, itemPath) => {
      const isSelected = primaryPaneSelectedItems.has(itemPath);
      el.classList.toggle('selected', isSelected);
      el.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });
    secondaryFileElementMap.forEach((el, itemPath) => {
      const isSelected = secondaryPaneSelectedItems.has(itemPath);
      el.classList.toggle('selected', isSelected);
      el.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });
  }

  function setActivePane(pane: 'left' | 'right', persist = true): void {
    const settings = deps.getCurrentSettings();
    if (settings.activePane !== pane) {
      if (settings.activePane === 'right') {
        deps.setSecondaryPaneSelected(new Set(deps.getSelectedItems()));
        deps.setSelectedItems(new Set(deps.getPrimaryPaneSelected()));
      } else {
        deps.setPrimaryPaneSelected(new Set(deps.getSelectedItems()));
        deps.setSelectedItems(new Set(deps.getSecondaryPaneSelected()));
      }
    }
    settings.activePane = pane;
    document.body.classList.toggle('active-pane-right', pane === 'right');
    syncPaneSelectionVisuals();
    deps.updateStatusBar();
    if (persist) {
      deps.debouncedSaveSettings();
    }
  }

  async function loadSecondaryPane(pathValue: string): Promise<void> {
    if (!pathValue) return;
    const settings = deps.getCurrentSettings();
    const pathLabel = getDualPaneElement<HTMLElement>('dual-pane-secondary-path');
    try {
      const result = await window.tauriAPI.getDirectoryContents(
        pathValue,
        undefined,
        settings.showHiddenFiles,
        false
      );
      if (!result.success) {
        deps.showToast(result.error || t('toast.dualPane.loadFailed'), 'Dual Pane', 'error');
        return;
      }
      secondaryPanePath = pathValue;
      secondaryPaneItems = result.contents || [];
      const validSecondaryPaths = new Set(secondaryPaneItems.map((item) => item.path));
      deps.setSecondaryPaneSelected(
        new Set(
          Array.from(deps.getSecondaryPaneSelected()).filter((itemPath) =>
            validSecondaryPaths.has(itemPath)
          )
        )
      );
      if (pathLabel) {
        pathLabel.textContent = secondaryPanePath;
        pathLabel.title = secondaryPanePath;
      }
      renderSecondaryPaneItems(secondaryPaneItems);
      if (settings.activePane === 'right') {
        deps.setSelectedItems(new Set(deps.getSecondaryPaneSelected()));
      }
      syncDualPaneControls();
    } catch (error) {
      deps.showToast(getErrorMessage(error), 'Dual Pane', 'error');
    }
  }

  async function copySelectionToOtherPane(): Promise<void> {
    const settings = deps.getCurrentSettings();
    if (deps.getSelectedItems().size === 0) return;
    const destinationPath =
      settings.dualPaneEnabled && settings.activePane === 'right'
        ? deps.getCurrentPath()
        : secondaryPanePath;
    if (!destinationPath) return;
    const ok = await deps.copySelectedToDestination(destinationPath);
    if (ok) {
      if (secondaryPanePath) void loadSecondaryPane(secondaryPanePath);
      if (settings.activePane === 'right') {
        deps.refresh('dual-pane-copy-from-secondary');
      } else {
        deps.refresh('dual-pane-copy-from-primary');
      }
    }
  }

  async function moveSelectionToOtherPane(): Promise<void> {
    const settings = deps.getCurrentSettings();
    if (deps.getSelectedItems().size === 0) return;
    const destinationPath =
      settings.dualPaneEnabled && settings.activePane === 'right'
        ? deps.getCurrentPath()
        : secondaryPanePath;
    if (!destinationPath) return;
    const ok = await deps.moveSelectedToDestination(destinationPath);
    if (ok) {
      if (secondaryPanePath) void loadSecondaryPane(secondaryPanePath);
      if (settings.activePane === 'right') {
        deps.refresh('dual-pane-move-from-secondary');
      } else {
        deps.refresh('dual-pane-move-from-primary');
      }
    }
  }

  function clearSecondarySelection(): void {
    deps.getSecondaryPaneSelected().clear();
    secondaryFileElementMap.forEach((el) => {
      el.classList.remove('selected');
      el.setAttribute('aria-selected', 'false');
    });
    deps.setSelectedItems(new Set());
    deps.updateStatusBar();
  }

  function selectSecondaryItem(itemPath: string, append = false): void {
    const secondaryPaneSelectedItems = deps.getSecondaryPaneSelected();
    if (!append) {
      secondaryPaneSelectedItems.clear();
      secondaryFileElementMap.forEach((el) => {
        el.classList.remove('selected');
        el.setAttribute('aria-selected', 'false');
      });
    }
    secondaryPaneSelectedItems.add(itemPath);
    const row = secondaryFileElementMap.get(itemPath);
    if (row) {
      row.classList.add('selected');
      row.setAttribute('aria-selected', 'true');
    }
    deps.setSelectedItems(new Set(secondaryPaneSelectedItems));
    deps.updateStatusBar();
  }

  function clearSecondaryDropVisuals(): void {
    document.getElementById('dual-pane-secondary-list')?.classList.remove('drag-over');
    document.querySelectorAll('.dual-pane-item.drag-over').forEach((el) => {
      el.classList.remove('drag-over', 'spring-loading');
    });
  }

  function clearSecondaryPane(): void {
    secondaryPanePath = '';
    secondaryPaneItems = [];
    deps.getSecondaryPaneSelected().clear();
    renderSecondaryPaneItems([]);
  }

  function setupListeners(): void {
    const fileView = document.getElementById('file-view');
    fileView?.addEventListener('mousedown', () => {
      if (deps.getCurrentSettings().dualPaneEnabled) {
        setActivePane('left');
      }
    });

    document.getElementById('dual-pane-secondary')?.addEventListener('mousedown', () => {
      if (deps.getCurrentSettings().dualPaneEnabled) {
        setActivePane('right');
      }
    });

    document.getElementById('copy-to-other-pane-btn')?.addEventListener('click', () => {
      void copySelectionToOtherPane();
    });
    document.getElementById('move-to-other-pane-btn')?.addEventListener('click', () => {
      void moveSelectionToOtherPane();
    });
    document.getElementById('dual-pane-secondary-open-here-btn')?.addEventListener('click', () => {
      deps.navigateTo(secondaryPanePath);
    });
    document.getElementById('dual-pane-secondary-sync-btn')?.addEventListener('click', () => {
      void loadSecondaryPane(deps.getCurrentPath());
    });
    document
      .getElementById('dual-pane-secondary-browse-btn')
      ?.addEventListener('click', async () => {
        const result = await window.tauriAPI.selectFolder();
        if (result.success) void loadSecondaryPane(result.path);
      });

    document.getElementById('dual-pane-secondary-list')?.addEventListener('dblclick', (event) => {
      const target = event.target as HTMLElement | null;
      const row = target?.closest<HTMLElement>('.file-item');
      if (!row) return;
      const itemPath = row.dataset.path || '';
      if (!itemPath) return;
      if (row.dataset.directory === 'true') {
        void loadSecondaryPane(itemPath);
        return;
      }
      void window.tauriAPI.openFile(itemPath);
    });

    window.addEventListener('dual-pane-open-directory', (event: Event) => {
      const customEvent = event as CustomEvent<{ path?: string }>;
      const targetPath = customEvent.detail?.path;
      if (!targetPath) return;
      void loadSecondaryPane(targetPath);
    });

    document.getElementById('dual-pane-secondary-list')?.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const row = target?.closest<HTMLElement>('.file-item');
      if (!row) {
        clearSecondarySelection();
        return;
      }
      if (deps.getCurrentSettings().dualPaneEnabled) {
        setActivePane('right');
      }
      const itemPath = row.dataset.path || '';
      if (!itemPath) return;
      const secondaryPaneSelectedItems = deps.getSecondaryPaneSelected();
      const toggle = event.metaKey || event.ctrlKey;
      if (toggle && secondaryPaneSelectedItems.has(itemPath)) {
        secondaryPaneSelectedItems.delete(itemPath);
        row.classList.remove('selected');
        row.setAttribute('aria-selected', 'false');
        deps.setSelectedItems(new Set(secondaryPaneSelectedItems));
        deps.updateStatusBar();
      } else {
        selectSecondaryItem(itemPath, toggle);
      }
    });

    document
      .getElementById('dual-pane-secondary-list')
      ?.addEventListener('contextmenu', (event) => {
        const target = event.target as HTMLElement | null;
        const row = target?.closest<HTMLElement>('.file-item');
        if (!row) return;
        event.preventDefault();
        if (deps.getCurrentSettings().dualPaneEnabled) {
          setActivePane('right');
        }
        const itemPath = row.dataset.path || '';
        if (!itemPath) return;
        if (!deps.getSecondaryPaneSelected().has(itemPath)) {
          selectSecondaryItem(itemPath, false);
        }
        const item = secondaryFilePathMap.get(itemPath);
        if (item) {
          showContextMenuAt(event, item);
        }
      });

    document.getElementById('dual-pane-secondary-list')?.addEventListener('dragstart', (event) => {
      const target = event.target as HTMLElement | null;
      const row = target?.closest<HTMLElement>('.file-item');
      if (!row || !event.dataTransfer) return;
      if (deps.getCurrentSettings().dualPaneEnabled) {
        setActivePane('right');
      }
      const itemPath = row.dataset.path || '';
      if (!itemPath) return;
      if (!deps.getSecondaryPaneSelected().has(itemPath)) {
        selectSecondaryItem(itemPath, false);
      }
      const selectedPaths = Array.from(deps.getSecondaryPaneSelected());
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData('text/plain', JSON.stringify(selectedPaths));
      window.tauriAPI.setDragData(selectedPaths).catch(ignoreError);
      row.classList.add('dragging');
    });

    document.getElementById('dual-pane-secondary-list')?.addEventListener('dragend', (event) => {
      const target = event.target as HTMLElement | null;
      const row = target?.closest<HTMLElement>('.file-item');
      row?.classList.remove('dragging');
      clearSecondaryDropVisuals();
      deps.clearSpringLoad();
      deps.hideDropIndicator();
      window.tauriAPI.clearDragData().catch(ignoreError);
    });

    document.getElementById('dual-pane-secondary-list')?.addEventListener('dragover', (event) => {
      event.preventDefault();
      const target = event.target as HTMLElement | null;
      const row = target?.closest<HTMLElement>('.file-item');
      const operation = deps.getDragOperation(event);
      if (event.dataTransfer) event.dataTransfer.dropEffect = operation;

      if (row && row.dataset.isDirectory === 'true' && row.dataset.isAppBundle !== 'true') {
        document.querySelectorAll('.dual-pane-item.drag-over').forEach((el) => {
          if (el !== row) el.classList.remove('drag-over', 'spring-loading');
        });
        document.getElementById('dual-pane-secondary-list')?.classList.remove('drag-over');
        row.classList.add('drag-over');
        const itemPath = row.dataset.path || '';
        if (itemPath) {
          deps.showDropIndicator(operation, itemPath, event.clientX, event.clientY);
          deps.scheduleSpringLoad(row, () => {
            row.classList.remove('drag-over', 'spring-loading');
            void loadSecondaryPane(itemPath);
          });
          return;
        }
      }

      deps.clearSpringLoad();
      document.querySelectorAll('.dual-pane-item.drag-over').forEach((el) => {
        el.classList.remove('drag-over', 'spring-loading');
      });
      document.getElementById('dual-pane-secondary-list')?.classList.add('drag-over');
      if (secondaryPanePath) {
        deps.showDropIndicator(operation, secondaryPanePath, event.clientX, event.clientY);
      }
    });

    document.getElementById('dual-pane-secondary-list')?.addEventListener('dragleave', (event) => {
      const list = document.getElementById('dual-pane-secondary-list');
      if (!list) return;
      const rect = list.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX >= rect.right ||
        event.clientY < rect.top ||
        event.clientY >= rect.bottom
      ) {
        clearSecondaryDropVisuals();
        deps.clearSpringLoad();
        deps.hideDropIndicator();
      }
    });

    document.getElementById('dual-pane-secondary-list')?.addEventListener('drop', async (event) => {
      event.preventDefault();
      const target = event.target as HTMLElement | null;
      const row = target?.closest<HTMLElement>('.file-item');
      clearSecondaryDropVisuals();
      deps.clearSpringLoad();
      try {
        const draggedPaths = await deps.getDraggedPaths(event);
        if (draggedPaths.length === 0) return;
        const operation = deps.getDragOperation(event);
        let destinationPath = secondaryPanePath;
        if (row && row.dataset.isDirectory === 'true') {
          destinationPath = row.dataset.path || destinationPath;
        }
        if (!destinationPath) return;
        const sameDirectory = draggedPaths.some(
          (draggedPath) => path.dirname(draggedPath) === destinationPath
        );
        if (sameDirectory) {
          deps.showToast(t('toast.alreadyInDirectory'), 'Info', 'info');
          return;
        }
        await deps.handleDrop(draggedPaths, destinationPath, operation);
        if (secondaryPanePath) {
          void loadSecondaryPane(secondaryPanePath);
        }
      } catch (error) {
        deps.showToast(getErrorMessage(error), 'Drag and Drop', 'error');
      } finally {
        deps.hideDropIndicator();
      }
    });
  }

  function showContextMenuAt(event: MouseEvent, item: FileItem): void {
    deps.showContextMenu(event.pageX, event.pageY, item);
  }

  return {
    getActiveFileGridScope,
    renderSecondaryPaneItems,
    syncDualPaneControls,
    syncPaneSelectionVisuals,
    setActivePane,
    loadSecondaryPane,
    copySelectionToOtherPane,
    moveSelectionToOtherPane,
    clearSecondarySelection,
    selectSecondaryItem,
    clearSecondaryDropVisuals,
    setupListeners,
    clearSecondaryPane,
    getSecondaryPanePath: () => secondaryPanePath,
    getSecondaryPaneItems: () => secondaryPaneItems,
    getSecondaryFilePathMap: () => secondaryFilePathMap,
    getSecondaryFileElementMap: () => secondaryFileElementMap,
  };
}
