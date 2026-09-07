import type { Settings } from './types';
import { devLog, escapeHtml, ignoreError } from './shared.js';
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
    if (!segments[0]!.includes(':')) {
      segments[0] = segments[0]! + ':';
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
  navigateTo: (path: string) => void | Promise<void>;
  createDirectoryOperationId: (scope: string) => string;
  cancelDirectoryContents?: (operationId: string) => Promise<unknown>;
  nameCollator: Intl.Collator;
  getFolderIcon: (path: string) => string;
  getDragOperation: (event: DragEvent) => OperationType;
  showDropIndicator: (operation: OperationType, targetPath: string, x: number, y: number) => void;
  hideDropIndicator: () => void;
  getDraggedPaths: (event: DragEvent) => Promise<string[]>;
  handleDrop: (paths: string[], targetPath: string, operation: OperationType) => Promise<boolean>;
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
  let breadcrumbMenuOperationId: string | null = null;
  let breadcrumbMenuFocusIndex = -1;
  let breadcrumbDelegated = false;
  let breadcrumbListenersWired = false;
  let activePath = '';
  let isBreadcrumbCollapsed = false;
  let breadcrumbFullWidth = 0;
  let resizeObserver: ResizeObserver | null = null;
  let directoryHistoryActiveIndex = -1;

  const ensureElements = () => {
    const newContainer = deps.getBreadcrumbContainer();
    if (newContainer !== breadcrumbContainer) {
      breadcrumbContainer = newContainer;
      breadcrumbDelegated = false;
    }
    if (!breadcrumbMenu) breadcrumbMenu = deps.getBreadcrumbMenu();
    if (!addressInput) addressInput = deps.getAddressInput();
  };

  function updateBreadcrumb(currentPath: string): void {
    ensureElements();
    if (!breadcrumbContainer || !addressInput) return;
    ensureBreadcrumbDelegation();

    hideBreadcrumbMenu();
    activePath = currentPath;

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
      isBreadcrumbCollapsed = false;
      breadcrumbFullWidth = 0;
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

    const { segments } = parsePath(currentPath);

    if (segments.length === 0) {
      breadcrumbContainer.style.display = 'none';
      addressInput.style.display = 'block';
      addressInput.value = displayPath;
      return;
    }

    breadcrumbContainer.style.display = 'inline-flex';
    addressInput.style.display = 'none';

    if (segments.length < 4) {
      renderBreadcrumb(currentPath, false);
      isBreadcrumbCollapsed = false;
      breadcrumbFullWidth = 0;
    } else {
      // Render full to measure
      renderBreadcrumb(currentPath, false);
      isBreadcrumbCollapsed = false;

      const scrollWidth = breadcrumbContainer.scrollWidth;
      const clientWidth = breadcrumbContainer.clientWidth;

      if (clientWidth > 0 && scrollWidth > clientWidth) {
        breadcrumbFullWidth = scrollWidth;
        renderBreadcrumb(currentPath, true);
      } else if (clientWidth > 0) {
        breadcrumbFullWidth = scrollWidth;
      }
    }
  }

  function renderBreadcrumb(currentPath: string, collapse: boolean): void {
    if (!breadcrumbContainer) return;
    clearHtml(breadcrumbContainer);

    const { segments, isWindows, isUnc } = parsePath(currentPath);
    const fragment = document.createDocumentFragment();

    if (collapse && segments.length >= 4) {
      // Collapsed rendering: Show first, overflow, and last two segments
      fragment.appendChild(createBreadcrumbItem(segments, 0, isWindows, isUnc));
      fragment.appendChild(createSeparator(isWindows));

      const overflowItem = document.createElement('button');
      overflowItem.type = 'button';
      overflowItem.className = 'breadcrumb-item breadcrumb-overflow';
      overflowItem.textContent = '…';
      overflowItem.setAttribute('aria-haspopup', 'menu');
      overflowItem.setAttribute('aria-expanded', 'false');
      overflowItem.setAttribute('aria-controls', 'breadcrumb-menu');
      overflowItem.setAttribute('aria-label', 'Show collapsed folders');
      fragment.appendChild(overflowItem);

      fragment.appendChild(createSeparator(isWindows));
      fragment.appendChild(createBreadcrumbItem(segments, segments.length - 2, isWindows, isUnc));
      fragment.appendChild(createSeparator(isWindows));
      fragment.appendChild(createBreadcrumbItem(segments, segments.length - 1, isWindows, isUnc));

      isBreadcrumbCollapsed = true;
    } else {
      // Full rendering
      segments.forEach((segment, index) => {
        fragment.appendChild(createBreadcrumbItem(segments, index, isWindows, isUnc));

        if (index < segments.length - 1) {
          fragment.appendChild(createSeparator(isWindows));
        }
      });

      isBreadcrumbCollapsed = false;
    }

    breadcrumbContainer.appendChild(fragment);
  }

  function createBreadcrumbItem(
    segments: string[],
    index: number,
    isWindows: boolean,
    isUnc: boolean
  ): HTMLElement {
    const item = document.createElement('div');
    item.className = 'breadcrumb-item';
    const targetPath = buildPathFromSegments(segments, index, isWindows, isUnc);
    item.title = targetPath;
    item.dataset.path = targetPath;

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'breadcrumb-label';
    label.textContent = segments[index]!;

    const caret = document.createElement('button');
    caret.type = 'button';
    caret.className = 'breadcrumb-caret';
    caret.textContent = '▾';
    caret.setAttribute('aria-haspopup', 'menu');
    caret.setAttribute('aria-expanded', 'false');
    caret.setAttribute('aria-controls', 'breadcrumb-menu');
    caret.setAttribute('aria-label', `Open folder menu for ${segments[index]}`);

    item.appendChild(label);
    item.appendChild(caret);

    return item;
  }

  function createSeparator(isWindows: boolean): HTMLElement {
    const separator = document.createElement('span');
    separator.className = 'breadcrumb-separator';
    separator.textContent = isWindows ? '›' : '/';
    return separator;
  }

  function handleResize(): void {
    if (!isBreadcrumbMode || !activePath || !breadcrumbContainer) return;
    const { segments } = parsePath(activePath);
    if (segments.length < 4) return;

    const availableWidth = breadcrumbContainer.clientWidth;
    if (availableWidth === 0) return;

    if (isBreadcrumbCollapsed) {
      if (availableWidth >= breadcrumbFullWidth) {
        renderBreadcrumb(activePath, false);
      }
    } else {
      if (breadcrumbContainer.scrollWidth > availableWidth) {
        breadcrumbFullWidth = breadcrumbContainer.scrollWidth;
        renderBreadcrumb(activePath, true);
      }
    }
  }

  function showBreadcrumbCollapsedMenu(anchor: HTMLElement): void {
    ensureElements();
    if (!breadcrumbMenu || !activePath) return;
    const menu = breadcrumbMenu;

    if (breadcrumbMenuPath === 'collapsed-menu' && menu.style.display === 'block') {
      hideBreadcrumbMenu();
      return;
    }

    cancelBreadcrumbMenuListing();
    if (breadcrumbMenuAnchor && breadcrumbMenuAnchor !== anchor) {
      breadcrumbMenuAnchor.setAttribute('aria-expanded', 'false');
    }
    breadcrumbMenuPath = 'collapsed-menu';
    breadcrumbMenuAnchor = anchor;
    breadcrumbMenuAnchor.setAttribute('aria-expanded', 'true');
    menu.style.display = 'block';
    breadcrumbMenuFocusIndex = -1;

    const wrapper = anchor.closest('.address-bar-wrapper') as HTMLElement | null;
    if (wrapper) {
      const rect = anchor.getBoundingClientRect();
      const wrapperRect = wrapper.getBoundingClientRect();
      menu.style.left = `${Math.max(0, rect.left - wrapperRect.left)}px`;
      menu.style.top = `${rect.bottom - wrapperRect.top + 4}px`;
    }

    clearHtml(menu);

    const { segments, isWindows, isUnc } = parsePath(activePath);
    // Collapsed segments are indices 1 to segments.length - 3
    const collapsedIndices: number[] = [];
    for (let i = 1; i <= segments.length - 3; i++) {
      collapsedIndices.push(i);
    }

    collapsedIndices.forEach((idx) => {
      const segment = segments[idx]!;
      const targetPath = buildPathFromSegments(segments, idx, isWindows, isUnc);

      const item = document.createElement('button');
      item.className = 'breadcrumb-menu-item';
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;

      // eslint-disable-next-line no-restricted-syntax
      item.innerHTML = `
        <span class="nav-icon">${deps.getFolderIcon(targetPath)}</span>
        <span>${escapeHtml(segment)}</span>
      `;

      item.addEventListener('click', () => {
        hideBreadcrumbMenu();
        void Promise.resolve(deps.navigateTo(targetPath)).catch((error) => {
          reportNavigationFailure(error);
        });
      });

      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          hideBreadcrumbMenu();
          void Promise.resolve(deps.navigateTo(targetPath)).catch((error) => {
            reportNavigationFailure(error);
          });
        }
      });

      menu.appendChild(item);
    });

    menu.setAttribute('aria-busy', 'false');
    focusBreadcrumbMenuItem(0);
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

      const overflowItem = target.closest<HTMLElement>('.breadcrumb-overflow');
      if (overflowItem) {
        e.stopPropagation();
        showBreadcrumbCollapsedMenu(overflowItem);
        return;
      }

      const path = getItemPath(target);
      if (!path) return;

      if (target.classList.contains('breadcrumb-label')) {
        e.stopPropagation();
        void Promise.resolve(deps.navigateTo(path)).catch((error) => {
          reportNavigationFailure(error);
        });
      } else if (target.classList.contains('breadcrumb-caret')) {
        e.stopPropagation();
        void showBreadcrumbMenu(path, target);
      }
    });

    breadcrumbContainer.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;

      const overflowItem = target.closest<HTMLElement>('.breadcrumb-overflow');
      if (overflowItem) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'F4') {
          e.preventDefault();
          showBreadcrumbCollapsedMenu(overflowItem);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          hideBreadcrumbMenu();
        }
        return;
      }

      const item = target.closest<HTMLElement>('.breadcrumb-item');
      const path = item?.dataset.path;
      if (!path) return;

      if (target.classList.contains('breadcrumb-label')) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void Promise.resolve(deps.navigateTo(path)).catch((error) => {
            reportNavigationFailure(error);
          });
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
      try {
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
      } catch (error) {
        devLog('Navigation', 'Breadcrumb drop handler failed', error);
      } finally {
        deps.hideDropIndicator();
      }
    });
  }

  function setupBreadcrumbListeners(): void {
    ensureElements();
    ensureBreadcrumbDelegation();
    if (breadcrumbListenersWired) return;
    breadcrumbListenersWired = true;

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

      if (typeof ResizeObserver !== 'undefined' && !resizeObserver) {
        resizeObserver = new ResizeObserver(() => {
          handleResize();
        });
        resizeObserver.observe(addressBar);
      }
    }

    if (addressInput) {
      addressInput.setAttribute('role', 'combobox');
      addressInput.setAttribute('aria-autocomplete', 'list');
      addressInput.setAttribute('aria-haspopup', 'listbox');
      addressInput.setAttribute('aria-controls', 'directory-history-dropdown');
      addressInput.setAttribute('aria-expanded', 'false');
      addressInput.addEventListener('focus', showDirectoryHistoryDropdown);
      addressInput.addEventListener('blur', () => {
        setTimeout(() => {
          if (!isBreadcrumbMode && deps.getCurrentPath()) {
            isBreadcrumbMode = true;
            updateBreadcrumb(deps.getCurrentPath());
          }
        }, 150);
      });

      addressInput.addEventListener('keydown', (e) => {
        const dropdown = document.getElementById('directory-history-dropdown');
        const isHistoryOpen = !!dropdown && dropdown.style.display === 'block';
        const options = dropdown ? getDirectoryHistoryOptions(dropdown) : [];

        if (isHistoryOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          const delta = e.key === 'ArrowDown' ? 1 : -1;
          const start =
            directoryHistoryActiveIndex < 0 ? (delta > 0 ? -1 : 0) : directoryHistoryActiveIndex;
          setActiveDirectoryHistoryOption(options, start + delta);
        } else if (isHistoryOpen && (e.key === 'Home' || e.key === 'End')) {
          e.preventDefault();
          setActiveDirectoryHistoryOption(options, e.key === 'Home' ? 0 : options.length - 1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const active = isHistoryOpen ? options[directoryHistoryActiveIndex] : undefined;
          if (active) {
            void activateDirectoryHistoryOption(active);
          } else {
            hideDirectoryHistoryDropdown();
            void navigateFromAddressValue();
          }
        } else if (e.key === 'Escape' && isHistoryOpen) {
          e.preventDefault();
          hideDirectoryHistoryDropdown();
          addressInput?.focus();
        } else if (e.key === 'Escape') {
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

    const historyDropdown = document.getElementById('directory-history-dropdown');
    historyDropdown?.addEventListener('mousedown', (event) => event.preventDefault());
    historyDropdown?.addEventListener('click', (event) => {
      const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
      if (option) void activateDirectoryHistoryOption(option);
    });

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
            const text = items[idx]?.textContent?.trim().toLowerCase() || '';
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
    items[safeIndex]!.focus({ preventScroll: true });
  }

  async function showBreadcrumbMenu(targetPath: string, anchor: HTMLElement): Promise<void> {
    ensureElements();
    if (!breadcrumbMenu) return;

    if (breadcrumbMenuPath === targetPath && breadcrumbMenu.style.display === 'block') {
      hideBreadcrumbMenu();
      return;
    }

    cancelBreadcrumbMenuListing();
    if (breadcrumbMenuAnchor && breadcrumbMenuAnchor !== anchor) {
      breadcrumbMenuAnchor.setAttribute('aria-expanded', 'false');
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
    breadcrumbMenuOperationId = operationId;
    let result: Awaited<ReturnType<typeof window.tauriAPI.getDirectoryContents>>;
    try {
      result = await window.tauriAPI.getDirectoryContents(
        targetPath,
        operationId,
        deps.getCurrentSettings().showHiddenFiles
      );
    } catch (error) {
      if (breadcrumbMenuOperationId !== operationId || breadcrumbMenuPath !== targetPath) return;
      breadcrumbMenuOperationId = null;
      breadcrumbMenu.setAttribute('aria-busy', 'false');
      setHtml(
        breadcrumbMenu,
        '<div class="breadcrumb-menu-message" role="menuitem" aria-disabled="true" tabindex="-1">Failed to load</div>'
      );
      reportNavigationFailure(error);
      return;
    }
    // Bail if menu closed or any newer request replaced this one, including a
    // close/reopen cycle for same path.
    if (breadcrumbMenuOperationId !== operationId || breadcrumbMenuPath !== targetPath) return;
    breadcrumbMenuOperationId = null;

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
      // eslint-disable-next-line no-restricted-syntax -- user data via escapeHtml(); icons/numerics are safe
      item.innerHTML = `
      <span class="nav-icon">${deps.getFolderIcon(entry.path)}</span>
      <span>${escapeHtml(entry.name)}</span>
    `;
      item.addEventListener('click', () => {
        hideBreadcrumbMenu();
        void Promise.resolve(deps.navigateTo(entry.path)).catch((error) => {
          reportNavigationFailure(error);
        });
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          hideBreadcrumbMenu();
          void Promise.resolve(deps.navigateTo(entry.path)).catch((error) => {
            reportNavigationFailure(error);
          });
        }
      });
      menu.appendChild(item);
    });

    breadcrumbMenu.setAttribute('aria-busy', 'false');
    focusBreadcrumbMenuItem(0);
  }

  function cancelBreadcrumbMenuListing(): void {
    const operationId = breadcrumbMenuOperationId;
    if (!operationId) return;
    breadcrumbMenuOperationId = null;
    const cancellation = deps.cancelDirectoryContents?.(operationId);
    cancellation?.catch(ignoreError);
  }

  function hideBreadcrumbMenu(): void {
    ensureElements();
    if (!breadcrumbMenu) return;
    cancelBreadcrumbMenuListing();
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
    if (!dropdown) return;
    if (!settings.enableSearchHistory) {
      hideDirectoryHistoryDropdown();
      return;
    }

    const history = settings.directoryHistory || [];

    if (history.length === 0) {
      setHtml(dropdown, '<div class="history-empty">No recent directories</div>');
    } else {
      setHtml(
        dropdown,
        history
          .map(
            (item, index) =>
              `<div class="history-item" id="directory-history-option-${index}" data-path="${escapeHtml(item)}" data-option-action="navigate" role="option" aria-selected="false">${twemojiImg('folder', 'twemoji')} ${escapeHtml(item)}</div>`
          )
          .join('') +
          `<div class="history-clear" id="directory-history-clear" data-action="clear-directory" data-option-action="clear" role="option" aria-selected="false">${twemojiImg('trash-2', 'twemoji')} Clear Directory History</div>`
      );
    }

    dropdown.style.display = 'block';
    directoryHistoryActiveIndex = -1;
    ensureElements();
    addressInput?.setAttribute('aria-expanded', 'true');
    addressInput?.removeAttribute('aria-activedescendant');
  }

  function hideDirectoryHistoryDropdown() {
    const dropdown = document.getElementById('directory-history-dropdown');
    if (dropdown) {
      dropdown.style.display = 'none';
      dropdown.querySelectorAll('[role="option"]').forEach((option) => {
        option.classList.remove('dropdown-active');
        option.setAttribute('aria-selected', 'false');
      });
    }
    directoryHistoryActiveIndex = -1;
    ensureElements();
    addressInput?.setAttribute('aria-expanded', 'false');
    addressInput?.removeAttribute('aria-activedescendant');
  }

  function getDirectoryHistoryOptions(dropdown: HTMLElement): HTMLElement[] {
    return Array.from(dropdown.querySelectorAll<HTMLElement>('[role="option"]'));
  }

  function setActiveDirectoryHistoryOption(options: HTMLElement[], index: number): void {
    if (options.length === 0) return;
    directoryHistoryActiveIndex = (index + options.length) % options.length;
    options.forEach((option, optionIndex) => {
      const selected = optionIndex === directoryHistoryActiveIndex;
      option.classList.toggle('dropdown-active', selected);
      option.setAttribute('aria-selected', String(selected));
    });
    const active = options[directoryHistoryActiveIndex];
    if (active?.id) addressInput?.setAttribute('aria-activedescendant', active.id);
    active?.scrollIntoView({ block: 'nearest' });
  }

  function restoreAddressNavigationFocus(): void {
    setTimeout(() => {
      ensureElements();
      if (addressInput && addressInput.style.display !== 'none') {
        addressInput.focus({ preventScroll: true });
        return;
      }
      breadcrumbContainer
        ?.querySelector<HTMLElement>('.breadcrumb-label, .breadcrumb-overflow')
        ?.focus({ preventScroll: true });
    }, 0);
  }

  function reportNavigationFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    deps.showToast(message || 'Failed to navigate', 'Navigation', 'error');
  }

  async function navigateFromAddressValue(): Promise<void> {
    ensureElements();
    if (!addressInput) return;
    const value = addressInput.value.trim();
    try {
      await deps.navigateTo(value === deps.homeViewLabel ? deps.homeViewPath : value);
    } catch (error) {
      reportNavigationFailure(error);
    } finally {
      restoreAddressNavigationFocus();
    }
  }

  async function activateDirectoryHistoryOption(option: HTMLElement): Promise<void> {
    if (option.dataset.optionAction === 'navigate' && option.dataset.path) {
      hideDirectoryHistoryDropdown();
      try {
        await deps.navigateTo(option.dataset.path);
      } catch (error) {
        reportNavigationFailure(error);
      } finally {
        restoreAddressNavigationFocus();
      }
      return;
    }
    if (option.dataset.optionAction === 'clear') {
      hideDirectoryHistoryDropdown();
      addressInput?.focus();
      try {
        await clearDirectoryHistory();
      } catch (error) {
        reportNavigationFailure(error);
      }
    }
  }

  async function clearDirectoryHistory() {
    const settings = deps.getCurrentSettings();
    settings.directoryHistory = [];
    try {
      const result = await deps.saveSettingsWithTimestamp(settings);
      if (result.success) {
        deps.showToast('Directory history cleared', 'History', 'success');
      } else {
        deps.showToast('Failed to clear directory history', 'History', 'error');
      }
    } catch (error) {
      reportNavigationFailure(error);
    } finally {
      hideDirectoryHistoryDropdown();
    }
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
