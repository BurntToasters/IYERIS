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
  let breadcrumbMenuAnchor: HTMLElement | null = null;
  let breadcrumbMenuFocusIndex = -1;
  let breadcrumbDelegated = false;

  const ensureElements = () => {
    if (!breadcrumbContainer) breadcrumbContainer = deps.getBreadcrumbContainer();
    if (!breadcrumbMenu) breadcrumbMenu = deps.getBreadcrumbMenu();
    if (!addressInput) addressInput = deps.getAddressInput();
  };

  function updateBreadcrumb(currentPath: string): void {
    ensureElements();
    if (!breadcrumbContainer || !addressInput) return;
    ensureBreadcrumbDelegation();

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
      const item = document.createElement('div');
      item.className = 'breadcrumb-item';
      item.dataset.path = deps.homeViewPath;
      const labelButton = document.createElement('button');
      labelButton.type = 'button';
      labelButton.className = 'breadcrumb-label';
      labelButton.textContent = deps.homeViewLabel;
      item.appendChild(labelButton);
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
      const item = document.createElement('div');
      item.className = 'breadcrumb-item';
      const targetPath = buildPathFromSegments(segments, index, isWindows, isUnc);
      item.title = targetPath;
      item.dataset.path = targetPath;

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'breadcrumb-label';
      label.textContent = segment;

      const caret = document.createElement('button');
      caret.type = 'button';
      caret.className = 'breadcrumb-caret';
      caret.textContent = '▾';
      caret.setAttribute('aria-haspopup', 'menu');
      caret.setAttribute('aria-expanded', 'false');
      caret.setAttribute('aria-controls', 'breadcrumb-menu');
      caret.setAttribute('aria-label', `Open folder menu for ${segment}`);

      item.appendChild(label);
      item.appendChild(caret);

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

  function ensureBreadcrumbDelegation(): void {
    if (breadcrumbDelegated || !breadcrumbContainer) return;
    breadcrumbDelegated = true;

    const getItemPath = (el: HTMLElement): string | null => {
      const item = el.closest<HTMLElement>('.breadcrumb-item');
      return item?.dataset.path ?? null;
    };

    breadcrumbContainer.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const path = getItemPath(target);
      if (!path) return;

      if (target.classList.contains('breadcrumb-label')) {
        e.stopPropagation();
        deps.navigateTo(path);
      } else if (target.classList.contains('breadcrumb-caret')) {
        e.stopPropagation();
        void showBreadcrumbMenu(path, target);
      }
    });

    breadcrumbContainer.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest<HTMLElement>('.breadcrumb-item');
      const path = item?.dataset.path;
      if (!path) return;

      if (target.classList.contains('breadcrumb-label')) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          deps.navigateTo(path);
        } else if (e.key === 'ArrowDown' || e.key === 'F4') {
          e.preventDefault();
          const caret = item.querySelector<HTMLElement>('.breadcrumb-caret');
          if (caret) void showBreadcrumbMenu(path, caret);
        }
      } else if (target.classList.contains('breadcrumb-caret')) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'F4') {
          e.preventDefault();
          void showBreadcrumbMenu(path, target);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          hideBreadcrumbMenu();
        }
      }
    });

    breadcrumbContainer.addEventListener('dragover', (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest<HTMLElement>('.breadcrumb-item');
      const path = item?.dataset.path;
      if (!item || !path) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.dataTransfer) return;
      const operation = deps.getDragOperation(e);
      e.dataTransfer.dropEffect = operation;
      item.classList.add('drag-over');
      deps.showDropIndicator(operation, path, e.clientX, e.clientY);
    });

    breadcrumbContainer.addEventListener('dragleave', (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest<HTMLElement>('.breadcrumb-item');
      if (!item) return;
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

    breadcrumbContainer.addEventListener('drop', async (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest<HTMLElement>('.breadcrumb-item');
      const path = item?.dataset.path;
      if (!item || !path) return;
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove('drag-over');
      const draggedPaths = await deps.getDraggedPaths(e);
      if (draggedPaths.length === 0) {
        deps.hideDropIndicator();
        return;
      }
      if (draggedPaths.includes(path)) {
        deps.hideDropIndicator();
        return;
      }
      const operation = deps.getDragOperation(e);
      await deps.handleDrop(draggedPaths, path, operation);
      deps.hideDropIndicator();
    });
  }

  function setupBreadcrumbListeners(): void {
    ensureElements();
    ensureBreadcrumbDelegation();

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
          const fileGrid = document.getElementById('file-grid');
          const activeItem = fileGrid?.querySelector<HTMLElement>('.file-item[tabindex="0"]');
          if (activeItem) {
            activeItem.focus();
          }
        }
      });
    }

    if (breadcrumbMenu) {
      breadcrumbMenu.addEventListener('keydown', (e) => {
        if (!breadcrumbMenu || breadcrumbMenu.style.display !== 'block') return;
        const items = getBreadcrumbMenuItems();
        if (items.length === 0) return;

        if (e.key === 'Escape') {
          e.preventDefault();
          hideBreadcrumbMenu();
          return;
        }

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          focusBreadcrumbMenuItem(
            breadcrumbMenuFocusIndex < items.length - 1 ? breadcrumbMenuFocusIndex + 1 : 0
          );
          return;
        }

        if (e.key === 'ArrowUp') {
          e.preventDefault();
          focusBreadcrumbMenuItem(
            breadcrumbMenuFocusIndex > 0 ? breadcrumbMenuFocusIndex - 1 : items.length - 1
          );
          return;
        }

        if (e.key === 'Home') {
          e.preventDefault();
          focusBreadcrumbMenuItem(0);
          return;
        }

        if (e.key === 'End') {
          e.preventDefault();
          focusBreadcrumbMenuItem(items.length - 1);
          return;
        }

        if (e.key === 'Tab') {
          e.preventDefault();
          hideBreadcrumbMenu();
          return;
        }

        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          const char = e.key.toLowerCase();
          const startIndex = breadcrumbMenuFocusIndex + 1;
          for (let i = 0; i < items.length; i++) {
            const idx = (startIndex + i) % items.length;
            const text = items[idx].textContent?.trim().toLowerCase() || '';
            if (text.startsWith(char)) {
              focusBreadcrumbMenuItem(idx);
              return;
            }
          }
        }
      });
    }
  }

  function getBreadcrumbMenuItems(): HTMLElement[] {
    if (!breadcrumbMenu) return [];
    return Array.from(
      breadcrumbMenu.querySelectorAll<HTMLElement>(
        '.breadcrumb-menu-item[role="menuitem"]:not([aria-disabled="true"])'
      )
    );
  }

  function focusBreadcrumbMenuItem(index: number): void {
    if (!breadcrumbMenu) return;
    const items = getBreadcrumbMenuItems();
    if (items.length === 0) return;
    const safeIndex = Math.max(0, Math.min(items.length - 1, index));
    items.forEach((item, itemIndex) => {
      item.tabIndex = itemIndex === safeIndex ? 0 : -1;
    });
    breadcrumbMenuFocusIndex = safeIndex;
    items[safeIndex].focus({ preventScroll: true });
  }

  async function showBreadcrumbMenu(targetPath: string, anchor: HTMLElement): Promise<void> {
    ensureElements();
    if (!breadcrumbMenu) return;

    if (breadcrumbMenuPath === targetPath && breadcrumbMenu.style.display === 'block') {
      hideBreadcrumbMenu();
      return;
    }

    breadcrumbMenuPath = targetPath;
    breadcrumbMenuAnchor = anchor;
    breadcrumbMenuAnchor.setAttribute('aria-expanded', 'true');
    breadcrumbMenu.setAttribute('aria-busy', 'true');
    setHtml(
      breadcrumbMenu,
      '<div class="breadcrumb-menu-message" role="menuitem" aria-disabled="true" tabindex="-1">Loading...</div>'
    );
    breadcrumbMenu.style.display = 'block';
    breadcrumbMenuFocusIndex = -1;

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
        '<div class="breadcrumb-menu-message" role="menuitem" aria-disabled="true" tabindex="-1">Failed to load</div>'
      );
      breadcrumbMenu.setAttribute('aria-busy', 'false');
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
        '<div class="breadcrumb-menu-message" role="menuitem" aria-disabled="true" tabindex="-1">No subfolders</div>'
      );
      breadcrumbMenu.setAttribute('aria-busy', 'false');
      return;
    }

    const menu = breadcrumbMenu;
    if (!menu) return;
    clearHtml(menu);
    entries.forEach((entry) => {
      const item = document.createElement('button');
      item.className = 'breadcrumb-menu-item';
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;
      item.innerHTML = `
      <span class="nav-icon">${deps.getFolderIcon(entry.path)}</span>
      <span>${escapeHtml(entry.name)}</span>
    `;
      item.addEventListener('click', () => {
        hideBreadcrumbMenu();
        deps.navigateTo(entry.path);
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          hideBreadcrumbMenu();
          deps.navigateTo(entry.path);
        }
      });
      menu.appendChild(item);
    });

    breadcrumbMenu.setAttribute('aria-busy', 'false');
    focusBreadcrumbMenuItem(0);
  }

  function hideBreadcrumbMenu(): void {
    ensureElements();
    if (!breadcrumbMenu) return;
    breadcrumbMenu.style.display = 'none';
    clearHtml(breadcrumbMenu);
    breadcrumbMenuPath = null;
    breadcrumbMenuFocusIndex = -1;
    breadcrumbMenu.removeAttribute('aria-busy');
    if (breadcrumbMenuAnchor) {
      breadcrumbMenuAnchor.setAttribute('aria-expanded', 'false');
      breadcrumbMenuAnchor.focus({ preventScroll: true });
      breadcrumbMenuAnchor = null;
    }
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
      setHtml(dropdown, '<div class="history-empty">No recent directories</div>');
    } else {
      setHtml(
        dropdown,
        history
          .map(
            (item) =>
              `<div class="history-item" data-path="${escapeHtml(item)}">${twemojiImg(String.fromCodePoint(0x1f4c1), 'twemoji')} ${escapeHtml(item)}</div>`
          )
          .join('') +
          `<div class="history-clear" data-action="clear-directory">${twemojiImg(String.fromCodePoint(0x1f5d1), 'twemoji')} Clear Directory History</div>`
      );
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
