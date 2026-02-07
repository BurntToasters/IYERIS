import type { Settings } from './types';
import { escapeHtml } from './shared.js';
import { clearHtml, setHtml } from './rendererDom.js';
import { twemojiImg } from './rendererUtils.js';

type OperationType = 'copy' | 'move';

export type ParsePathResult = { segments: string[]; isWindows: boolean; isUnc: boolean };

export function parsePath(filePath: string): ParsePathResult {
  const isUnc = filePath.startsWith('\\\\');
  const isWindows = isUnc || /^[A-Za-z]:/.test(filePath);
  const normalizedPath = filePath.replace(/\\/g, '/');
  const segments = normalizedPath.split('/').filter((s) => s.length > 0);
  if (isWindows && !isUnc && segments.length > 0) {
    if (!segments[0].includes(':')) {
      segments[0] = segments[0] + ':';
    }
  }

  return { segments, isWindows, isUnc };
}

export function buildPathFromSegments(
  segments: string[],
  index: number,
  isWindows: boolean,
  isUnc: boolean
): string {
  if (index < 0) return '';

  const pathSegments = segments.slice(0, index + 1);

  if (isWindows) {
    if (isUnc) {
      if (pathSegments.length <= 2) {
        return `\\\\${pathSegments.join('\\')}\\`;
      }
      return `\\\\${pathSegments.join('\\')}`;
    }
    if (pathSegments.length === 1) {
      return pathSegments[0] + '\\';
    }
    return pathSegments.join('\\');
  } else {
    return '/' + pathSegments.join('/');
  }
}

type NavigationDeps = {
  getCurrentPath: () => string;
  getCurrentSettings: () => Settings;
  getBreadcrumbContainer: () => HTMLElement | null;
  getBreadcrumbMenu: () => HTMLElement | null;
  getAddressInput: () => HTMLInputElement | null;
  getPathDisplayValue: (path: string) => string;
  isHomeViewPath: (path: string) => boolean;
  homeViewLabel: string;
  homeViewPath: string;
  navigateTo: (path: string) => void;
  createDirectoryOperationId: (scope: string) => string;
  nameCollator: Intl.Collator;
  getFolderIcon: (path: string) => string;
  getDragOperation: (event: DragEvent) => OperationType;
  showDropIndicator: (operation: OperationType, targetPath: string, x: number, y: number) => void;
  hideDropIndicator: () => void;
  getDraggedPaths: (event: DragEvent) => Promise<string[]>;
  handleDrop: (paths: string[], targetPath: string, operation: OperationType) => Promise<void>;
  debouncedSaveSettings: () => void;
  saveSettingsWithTimestamp: (settings: Settings) => Promise<{ success: boolean; error?: string }>;
  showToast: (
    message: string,
    title: string,
    type: 'success' | 'error' | 'info' | 'warning'
  ) => void;
  directoryHistoryMax: number;
};

export function createNavigationController(deps: NavigationDeps) {
  let isBreadcrumbMode = true;
  let breadcrumbContainer: HTMLElement | null = null;
  let breadcrumbMenu: HTMLElement | null = null;
  let addressInput: HTMLInputElement | null = null;
  let breadcrumbMenuPath: string | null = null;

  const ensureElements = () => {
    if (!breadcrumbContainer) breadcrumbContainer = deps.getBreadcrumbContainer();
    if (!breadcrumbMenu) breadcrumbMenu = deps.getBreadcrumbMenu();
    if (!addressInput) addressInput = deps.getAddressInput();
  };

  function updateBreadcrumb(currentPath: string): void {
    ensureElements();
    if (!breadcrumbContainer || !addressInput) return;

    hideBreadcrumbMenu();

    const displayPath = currentPath ? deps.getPathDisplayValue(currentPath) : '';

    if (!isBreadcrumbMode || !currentPath) {
      breadcrumbContainer.style.display = 'none';
      addressInput.style.display = 'block';
      addressInput.value = displayPath;
      return;
    }

    if (deps.isHomeViewPath(currentPath)) {
      breadcrumbContainer.style.display = 'inline-flex';
      addressInput.style.display = 'none';
      clearHtml(breadcrumbContainer);
      const item = document.createElement('span');
      item.className = 'breadcrumb-item';
      item.textContent = deps.homeViewLabel;
      item.addEventListener('click', () => deps.navigateTo(deps.homeViewPath));
      breadcrumbContainer.appendChild(item);
      return;
    }

    const { segments, isWindows, isUnc } = parsePath(currentPath);

    if (segments.length === 0) {
      breadcrumbContainer.style.display = 'none';
      addressInput.style.display = 'block';
      addressInput.value = displayPath;
      return;
    }

    breadcrumbContainer.style.display = 'inline-flex';
    addressInput.style.display = 'none';
    clearHtml(breadcrumbContainer);

    const container = breadcrumbContainer;

    segments.forEach((segment, index) => {
      const item = document.createElement('span');
      item.className = 'breadcrumb-item';
      const targetPath = buildPathFromSegments(segments, index, isWindows, isUnc);
      item.title = targetPath;
      item.dataset.path = targetPath;

      const label = document.createElement('span');
      label.textContent = segment;

      const caret = document.createElement('span');
      caret.className = 'breadcrumb-caret';
      caret.textContent = '▾';

      item.appendChild(label);
      item.appendChild(caret);

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = e.target as HTMLElement;
        if (target.classList.contains('breadcrumb-caret')) {
          showBreadcrumbMenu(targetPath, item);
          return;
        }
        deps.navigateTo(targetPath);
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const operation = deps.getDragOperation(e);
        e.dataTransfer!.dropEffect = operation;
        item.classList.add('drag-over');
        deps.showDropIndicator(operation, targetPath, e.clientX, e.clientY);
      });

      item.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = item.getBoundingClientRect();
        if (
          e.clientX < rect.left ||
          e.clientX >= rect.right ||
          e.clientY < rect.top ||
          e.clientY >= rect.bottom
        ) {
          item.classList.remove('drag-over');
          deps.hideDropIndicator();
        }
      });

      item.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.classList.remove('drag-over');
        const draggedPaths = await deps.getDraggedPaths(e);
        if (draggedPaths.length === 0) {
          deps.hideDropIndicator();
          return;
        }
        if (draggedPaths.includes(targetPath)) {
          deps.hideDropIndicator();
          return;
        }
        const operation = deps.getDragOperation(e);
        await deps.handleDrop(draggedPaths, targetPath, operation);
        deps.hideDropIndicator();
      });

      container.appendChild(item);

      if (index < segments.length - 1) {
        const separator = document.createElement('span');
        separator.className = 'breadcrumb-separator';
        separator.textContent = isWindows ? '›' : '/';
        container.appendChild(separator);
      }
    });
  }

  function toggleBreadcrumbMode(): void {
    isBreadcrumbMode = !isBreadcrumbMode;
    ensureElements();

    if (isBreadcrumbMode) {
      updateBreadcrumb(deps.getCurrentPath());
    } else {
      if (breadcrumbContainer) breadcrumbContainer.style.display = 'none';
      if (addressInput) {
        addressInput.style.display = 'block';
        addressInput.value = deps.getPathDisplayValue(deps.getCurrentPath());
        addressInput.focus();
        addressInput.select();
      }
    }
  }

  function setupBreadcrumbListeners(): void {
    ensureElements();

    const addressBar = document.querySelector('.address-bar');
    if (addressBar) {
      addressBar.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (
          target.classList.contains('address-bar') ||
          target.classList.contains('breadcrumb') ||
          target.id === 'breadcrumb-container'
        ) {
          if (isBreadcrumbMode) {
            toggleBreadcrumbMode();
          }
        }
      });
    }

    if (addressInput) {
      addressInput.addEventListener('blur', () => {
        setTimeout(() => {
          if (!isBreadcrumbMode && deps.getCurrentPath()) {
            isBreadcrumbMode = true;
            updateBreadcrumb(deps.getCurrentPath());
          }
        }, 150);
      });

      addressInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          isBreadcrumbMode = true;
          updateBreadcrumb(deps.getCurrentPath());
          addressInput?.blur();
        }
      });
    }
  }

  async function showBreadcrumbMenu(targetPath: string, anchor: HTMLElement): Promise<void> {
    ensureElements();
    if (!breadcrumbMenu) return;

    if (breadcrumbMenuPath === targetPath && breadcrumbMenu.style.display === 'block') {
      hideBreadcrumbMenu();
      return;
    }

    breadcrumbMenuPath = targetPath;
    setHtml(
      breadcrumbMenu,
      '<div class="breadcrumb-menu-item" style="opacity: 0.6;">Loading...</div>'
    );
    breadcrumbMenu.style.display = 'block';

    const wrapper = anchor.closest('.address-bar-wrapper') as HTMLElement | null;
    if (wrapper) {
      const rect = anchor.getBoundingClientRect();
      const wrapperRect = wrapper.getBoundingClientRect();
      breadcrumbMenu.style.left = `${Math.max(0, rect.left - wrapperRect.left)}px`;
      breadcrumbMenu.style.top = `${rect.bottom - wrapperRect.top + 4}px`;
    }

    const operationId = deps.createDirectoryOperationId('breadcrumb');
    const result = await window.electronAPI.getDirectoryContents(
      targetPath,
      operationId,
      deps.getCurrentSettings().showHiddenFiles
    );

    if (!result.success) {
      setHtml(
        breadcrumbMenu,
        '<div class="breadcrumb-menu-item" style="opacity: 0.6;">Failed to load</div>'
      );
      return;
    }

    const settings = deps.getCurrentSettings();
    const entries = (result.contents || []).filter(
      (entry) => entry.isDirectory && (settings.showHiddenFiles || !entry.isHidden)
    );
    entries.sort((a, b) => deps.nameCollator.compare(a.name, b.name));

    if (entries.length === 0) {
      setHtml(
        breadcrumbMenu,
        '<div class="breadcrumb-menu-item" style="opacity: 0.6;">No subfolders</div>'
      );
      return;
    }

    const menu = breadcrumbMenu;
    if (!menu) return;
    clearHtml(menu);
    entries.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'breadcrumb-menu-item';
      item.innerHTML = `
      <span class="nav-icon">${deps.getFolderIcon(entry.path)}</span>
      <span>${escapeHtml(entry.name)}</span>
    `;
      item.addEventListener('click', () => {
        hideBreadcrumbMenu();
        deps.navigateTo(entry.path);
      });
      menu.appendChild(item);
    });
  }

  function hideBreadcrumbMenu(): void {
    ensureElements();
    if (!breadcrumbMenu) return;
    breadcrumbMenu.style.display = 'none';
    clearHtml(breadcrumbMenu);
    breadcrumbMenuPath = null;
  }

  function addToDirectoryHistory(dirPath: string) {
    const settings = deps.getCurrentSettings();
    if (!settings.enableSearchHistory || !dirPath.trim()) return;
    if (deps.isHomeViewPath(dirPath)) return;
    if (!settings.directoryHistory) {
      settings.directoryHistory = [];
    }
    const maxDirectoryHistoryItems = Math.max(
      1,
      Math.min(20, settings.maxDirectoryHistoryItems || deps.directoryHistoryMax)
    );
    settings.directoryHistory = settings.directoryHistory.filter((item) => item !== dirPath);
    settings.directoryHistory.unshift(dirPath);
    settings.directoryHistory = settings.directoryHistory.slice(0, maxDirectoryHistoryItems);
    deps.debouncedSaveSettings();
  }

  function showDirectoryHistoryDropdown() {
    const dropdown = document.getElementById('directory-history-dropdown');
    const settings = deps.getCurrentSettings();
    if (!dropdown || !settings.enableSearchHistory) return;

    const history = settings.directoryHistory || [];

    if (history.length === 0) {
      dropdown.innerHTML = '<div class="history-empty">No recent directories</div>';
    } else {
      dropdown.innerHTML =
        history
          .map(
            (item) =>
              `<div class="history-item" data-path="${escapeHtml(item)}">${twemojiImg(String.fromCodePoint(0x1f4c1), 'twemoji')} ${escapeHtml(item)}</div>`
          )
          .join('') +
        `<div class="history-clear" data-action="clear-directory">${twemojiImg(String.fromCodePoint(0x1f5d1), 'twemoji')} Clear Directory History</div>`;
    }

    dropdown.style.display = 'block';
  }

  function hideDirectoryHistoryDropdown() {
    const dropdown = document.getElementById('directory-history-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  }

  function clearDirectoryHistory() {
    const settings = deps.getCurrentSettings();
    settings.directoryHistory = [];
    deps.saveSettingsWithTimestamp(settings);
    hideDirectoryHistoryDropdown();
    deps.showToast('Directory history cleared', 'History', 'success');
  }

  function getBreadcrumbMenuElement(): HTMLElement | null {
    ensureElements();
    return breadcrumbMenu;
  }

  function isBreadcrumbMenuOpen(): boolean {
    ensureElements();
    return !!breadcrumbMenu && breadcrumbMenu.style.display === 'block';
  }

  return {
    updateBreadcrumb,
    toggleBreadcrumbMode,
    setupBreadcrumbListeners,
    showBreadcrumbMenu,
    hideBreadcrumbMenu,
    addToDirectoryHistory,
    showDirectoryHistoryDropdown,
    hideDirectoryHistoryDropdown,
    clearDirectoryHistory,
    getBreadcrumbMenuElement,
    isBreadcrumbMenuOpen,
  };
}
