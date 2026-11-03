import type { FileItem, ItemProperties } from './types';
import type { ToastAction } from './rendererToasts.js';
import { isExtractableArchivePath } from './archiveFormatCapabilities.js';
import { PDF_EXTENSIONS } from './fileTypes.js';
import { getErrorMessage } from './shared.js';
import { rendererPath as path, renderIcon } from './rendererUtils.js';

type ContextMenuDeps = {
  getFileExtension: (filename: string) => string;
  getCurrentPath: () => string;
  getFileElementMap: () => Map<string, HTMLElement>;
  createNewFolderWithInlineRename: () => Promise<void>;
  createNewFileWithInlineRename: () => Promise<void>;
  pasteFromClipboard: () => Promise<void>;
  navigateTo: (path: string) => Promise<void>;
  showToast: (
    message: string,
    title: string,
    type: 'success' | 'error' | 'info' | 'warning',
    actions?: ToastAction[]
  ) => void;
  openFileEntry: (item: FileItem) => Promise<void>;
  showQuickLookForFile: (item: FileItem) => Promise<void>;
  startInlineRename: (element: HTMLElement, name: string, path: string) => void;
  copyToClipboard: () => void;
  cutToClipboard: () => void;
  addBookmarkByPath: (path: string) => Promise<void>;
  showFolderIconPicker: (path: string) => void;
  showPropertiesDialog: (properties: ItemProperties) => void;
  deleteSelected: (permanent?: boolean) => Promise<void>;
  handleCompress: (format: string) => Promise<void>;
  showCompressOptionsModal: () => void;
  showExtractModal: (archivePath: string, name: string) => void;
  getSelectedItems: () => Set<string>;
  showBatchRenameModal: () => void;
  addNewTab: (path?: string) => Promise<void>;
  getTabsEnabled: () => boolean;
  pasteIntoFolder: (folderPath: string) => Promise<void>;
  duplicateItems: (paths: string[]) => Promise<void>;
  moveSelectedToFolder: () => Promise<string | null>;
  copySelectedToFolder: () => Promise<string | null>;
  moveSelectedToDestination: (destinationPath: string) => Promise<boolean>;
  copySelectedToDestination: (destinationPath: string) => Promise<boolean>;
  shareItems: (filePaths: string[]) => Promise<void>;
  hasClipboardContent: () => boolean;
  getRecentTransferDestinations: () => string[];
  setRecentTransferDestinations: (destinations: string[]) => void;
};

export function createContextMenuController(deps: ContextMenuDeps) {
  let contextMenuData: FileItem | null = null;
  let contextMenuFocusedIndex = -1;
  let emptySpaceMenuFocusedIndex = -1;
  let contextMenuReturnFocus: HTMLElement | null = null;
  let emptySpaceMenuReturnFocus: HTMLElement | null = null;

  let elContextMenu: HTMLElement | null = null;
  let elEmptySpaceContextMenu: HTMLElement | null = null;
  let menuInteractionAbortController: AbortController | null = null;
  let contextSubmenuSequence = 0;
  const contextSubmenusByParent = new WeakMap<HTMLElement, HTMLElement>();
  const contextSubmenuPlaceholders = new WeakMap<HTMLElement, Comment>();
  const contextSubmenuParents = new WeakMap<HTMLElement, HTMLElement>();
  let openWithRequestToken = 0;
  let openWithAppsLoaded = false;
  let openWithFocusOnLoad = false;
  let pasteInProgress = false;
  let elAddToBookmarks: HTMLElement | null = null;
  let elChangeFolderIcon: HTMLElement | null = null;
  let elCopyPath: HTMLElement | null = null;
  let elOpenTerminal: HTMLElement | null = null;
  let elCompress: HTMLElement | null = null;
  let elExtract: HTMLElement | null = null;
  let elPreviewPdf: HTMLElement | null = null;
  let elOpenWithSubmenu: HTMLElement | null = null;
  let elBatchRename: HTMLElement | null = null;
  let elOpenInNewTab: HTMLElement | null = null;
  let elOpenWithAppsPanel: HTMLElement | null = null;
  let elPasteInto: HTMLElement | null = null;
  let elDuplicate: HTMLElement | null = null;
  let elRename: HTMLElement | null = null;
  let elDelete: HTMLElement | null = null;
  let elOpen: HTMLElement | null = null;
  let elCut: HTMLElement | null = null;
  let elCopy: HTMLElement | null = null;
  let elCopyMoveSubmenu: HTMLElement | null = null;
  let elCopyMoveRecentList: HTMLElement | null = null;
  let elCopyMoveRecentSeparator: HTMLElement | null = null;
  let elAdvancedSubmenu: HTMLElement | null = null;
  let elShare: HTMLElement | null = null;
  let elShowPackageContents: HTMLElement | null = null;

  function ensureElements() {
    if (!elContextMenu) elContextMenu = document.getElementById('context-menu');
    if (!elEmptySpaceContextMenu)
      elEmptySpaceContextMenu = document.getElementById('empty-space-context-menu');
    if (!elAddToBookmarks) elAddToBookmarks = document.getElementById('add-to-bookmarks-item');
    if (!elChangeFolderIcon)
      elChangeFolderIcon = document.getElementById('change-folder-icon-item');
    if (!elCopyPath) elCopyPath = document.getElementById('copy-path-item');
    if (!elOpenTerminal) elOpenTerminal = document.getElementById('open-terminal-item');
    if (!elCompress) elCompress = document.getElementById('compress-item');
    if (!elExtract) elExtract = document.getElementById('extract-item');
    if (!elPreviewPdf) elPreviewPdf = document.getElementById('preview-pdf-item');
    if (!elOpenWithSubmenu) elOpenWithSubmenu = document.getElementById('open-with-submenu');
    if (!elBatchRename) elBatchRename = document.getElementById('batch-rename-item');
    if (!elOpenInNewTab) elOpenInNewTab = document.getElementById('open-in-new-tab-item');
    if (!elOpenWithAppsPanel) elOpenWithAppsPanel = document.getElementById('open-with-apps-panel');
    if (!elPasteInto) elPasteInto = document.getElementById('paste-into-item');
    if (!elDuplicate) elDuplicate = document.getElementById('duplicate-item');
    if (!elRename)
      elRename = elContextMenu?.querySelector('[data-action="rename"]') as HTMLElement | null;
    if (!elDelete)
      elDelete = elContextMenu?.querySelector('[data-action="delete"]') as HTMLElement | null;
    if (!elOpen)
      elOpen = elContextMenu?.querySelector('[data-action="open"]') as HTMLElement | null;
    if (!elCut) elCut = elContextMenu?.querySelector('[data-action="cut"]') as HTMLElement | null;
    if (!elCopy)
      elCopy = elContextMenu?.querySelector('[data-action="copy"]') as HTMLElement | null;
    if (!elCopyMoveSubmenu) elCopyMoveSubmenu = document.getElementById('copy-move-submenu');
    if (!elCopyMoveRecentList)
      elCopyMoveRecentList = document.getElementById('copy-move-recent-list');
    if (!elCopyMoveRecentSeparator)
      elCopyMoveRecentSeparator = document.getElementById('copy-move-recent-separator');
    if (!elAdvancedSubmenu) elAdvancedSubmenu = document.getElementById('advanced-submenu');
    if (!elShare) elShare = document.getElementById('share-item');
    if (!elShowPackageContents)
      elShowPackageContents = document.getElementById('show-package-contents-item');
  }

  function positionMenuInViewport(menu: HTMLElement, x: number, y: number) {
    const margin = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxWidth = Math.max(0, vw - margin * 2);
    const maxHeight = Math.max(0, vh - margin * 2);
    menu.style.maxWidth = `${maxWidth}px`;
    menu.style.maxHeight = `${maxHeight}px`;

    const rect = menu.getBoundingClientRect();
    const width = Math.min(rect.width, maxWidth);
    const height = Math.min(rect.height, maxHeight);
    let left = x + width > vw - margin ? x - width : x;
    let top = y + height > vh - margin ? y - height : y;
    left = Math.max(margin, Math.min(left, vw - width - margin));
    top = Math.max(margin, Math.min(top, vh - height - margin));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function invalidateOpenWithRequest(resetPanel = true) {
    openWithRequestToken += 1;
    openWithAppsLoaded = false;
    openWithFocusOnLoad = false;
    const panel = elOpenWithAppsPanel;
    if (resetPanel && panel) {
      panel.innerHTML = '<div class="open-with-loading">Loading apps...</div>';
    }
  }

  function getContextSubmenu(parent: HTMLElement): HTMLElement | null {
    return (
      parent.querySelector<HTMLElement>('.context-submenu') ??
      contextSubmenusByParent.get(parent) ??
      null
    );
  }

  function portalContextSubmenu(parent: HTMLElement, submenu: HTMLElement) {
    if (submenu.parentElement === parent) {
      const placeholder = document.createComment('context-menu-submenu');
      parent.insertBefore(placeholder, submenu);
      contextSubmenuPlaceholders.set(submenu, placeholder);
    }

    if (!submenu.id) {
      contextSubmenuSequence += 1;
      submenu.id = `context-menu-submenu-${contextSubmenuSequence}`;
    }
    contextSubmenusByParent.set(parent, submenu);
    contextSubmenuParents.set(submenu, parent);
    submenu.dataset.contextMenuOwner = parent.closest<HTMLElement>('.context-menu')?.id || '';
    parent.setAttribute('aria-controls', submenu.id);
    if (submenu.parentElement !== document.body) document.body.appendChild(submenu);
  }

  function restoreContextSubmenu(parent: HTMLElement, submenu: HTMLElement) {
    const placeholder = contextSubmenuPlaceholders.get(submenu);
    if (placeholder?.parentNode === parent) {
      parent.insertBefore(submenu, placeholder);
      placeholder.remove();
    }
    submenu.removeAttribute('data-context-menu-owner');
  }

  function isContextMenuRelatedNode(menu: HTMLElement, target: Node | null): boolean {
    if (!target) return false;
    if (menu.contains(target)) return true;
    if (!(target instanceof Element)) return false;
    const submenu = target.closest<HTMLElement>('.context-submenu');
    return submenu?.dataset.contextMenuOwner === menu.id;
  }

  function getContextSubmenuParentForTarget(
    menu: HTMLElement,
    target: Element
  ): HTMLElement | null {
    const menuItem = target.closest<HTMLElement>('.context-menu-item.has-submenu');
    if (menuItem && menu.contains(menuItem)) return menuItem;

    const submenu = target.closest<HTMLElement>('.context-submenu');
    if (submenu?.dataset.contextMenuOwner !== menu.id) return null;
    const parent = contextSubmenuParents.get(submenu);
    return parent && menu.contains(parent) ? parent : null;
  }

  function getActiveContextSubmenu(menu: HTMLElement): HTMLElement | null {
    const parent = Array.from(
      menu.querySelectorAll<HTMLElement>('.context-menu-item.has-submenu')
    ).find((item) => item.getAttribute('aria-expanded') === 'true');
    return parent ? getContextSubmenu(parent) : null;
  }

  function positionContextSubmenu(parent: HTMLElement, submenu: HTMLElement) {
    const margin = 10;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    submenu.style.maxWidth = `${Math.max(0, viewportWidth - margin * 2)}px`;
    submenu.style.maxHeight = `${Math.max(0, viewportHeight - margin * 2)}px`;

    const parentRect = parent.getBoundingClientRect();
    const submenuRect = submenu.getBoundingClientRect();
    const rightSpace = viewportWidth - margin - parentRect.right;
    const leftSpace = parentRect.left - margin;
    const placeLeft = submenuRect.width > rightSpace && leftSpace > rightSpace;
    const preferredLeft = placeLeft
      ? parentRect.left - submenuRect.width + 2
      : parentRect.right - 2;
    const left = Math.max(
      margin,
      Math.min(preferredLeft, viewportWidth - submenuRect.width - margin)
    );
    const top = Math.max(
      margin,
      Math.min(parentRect.top - 4, viewportHeight - submenuRect.height - margin)
    );

    submenu.classList.toggle('flip-left', placeLeft);
    submenu.style.left = `${left}px`;
    submenu.style.top = `${top}px`;
  }

  function closeContextSubmenu(parent: HTMLElement, restoreFocus = false) {
    const submenu = getContextSubmenu(parent);
    if (!submenu) return;

    const wasOpen =
      submenu.style.display === 'block' || parent.getAttribute('aria-expanded') === 'true';
    const restoreParentFocus = restoreFocus || submenu.contains(document.activeElement);
    submenu.querySelectorAll('.context-menu-item.focused').forEach((item) => {
      item.classList.remove('focused');
    });
    submenu.style.display = '';
    submenu.style.removeProperty('left');
    submenu.style.removeProperty('top');
    submenu.style.removeProperty('max-width');
    submenu.style.removeProperty('max-height');
    submenu.classList.remove('flip-left');
    parent.setAttribute('aria-expanded', 'false');
    restoreContextSubmenu(parent, submenu);

    if (parent === elOpenWithSubmenu && wasOpen) {
      invalidateOpenWithRequest();
    }

    if (restoreParentFocus) {
      if (elContextMenu) {
        const items = getVisibleMenuItems(elContextMenu);
        contextMenuFocusedIndex = items.indexOf(parent);
      }
      parent.classList.add('focused');
      parent.focus({ preventScroll: true });
    }
  }

  function closeContextSubmenus(menu: HTMLElement, restoreFocus = false) {
    menu.querySelectorAll<HTMLElement>('.context-menu-item.has-submenu').forEach((parent) => {
      const submenu = getContextSubmenu(parent);
      const parentIsActive = parent.getAttribute('aria-expanded') === 'true';
      const focusIsInSubmenu = !!submenu?.contains(document.activeElement);
      closeContextSubmenu(parent, restoreFocus && (parentIsActive || focusIsInSubmenu));
    });
  }

  function focusFirstSubmenuItem(submenu: HTMLElement): boolean {
    const firstItem = Array.from(submenu.querySelectorAll<HTMLElement>('.context-menu-item')).find(
      (item) =>
        item.style.display !== 'none' &&
        !item.classList.contains('is-disabled') &&
        item.getAttribute('aria-disabled') !== 'true' &&
        item.getClientRects().length > 0
    );
    if (!firstItem) return false;
    submenu.querySelectorAll('.context-menu-item.focused').forEach((item) => {
      item.classList.remove('focused');
    });
    firstItem.classList.add('focused');
    firstItem.scrollIntoView({ block: 'nearest' });
    firstItem.focus({ preventScroll: true });
    return true;
  }

  function openContextSubmenu(parent: HTMLElement, focusFirstItem = false) {
    const menu = parent.closest<HTMLElement>('.context-menu');
    const submenu = getContextSubmenu(parent);
    if (!menu || !submenu) return;

    const isAlreadyOpen = submenu.style.display === 'block';
    menu.querySelectorAll<HTMLElement>('.context-menu-item.has-submenu').forEach((otherParent) => {
      if (otherParent !== parent) closeContextSubmenu(otherParent);
    });

    if (!isAlreadyOpen) {
      portalContextSubmenu(parent, submenu);
      submenu.style.display = 'block';
      parent.setAttribute('aria-expanded', 'true');
      positionContextSubmenu(parent, submenu);
    }

    if (parent === elOpenWithSubmenu) {
      if (focusFirstItem) openWithFocusOnLoad = true;
      loadOpenWithApps();
    }

    if (focusFirstItem && !focusFirstSubmenuItem(submenu)) {
      parent.classList.add('focused');
      parent.focus({ preventScroll: true });
    }
  }

  function bindContextMenuInteractions(menu: HTMLElement) {
    menuInteractionAbortController?.abort();
    const controller = new AbortController();
    menuInteractionAbortController = controller;
    const { signal } = controller;

    const reposition = () => {
      if (menu.style.display !== 'block') return;
      const left = Number.parseFloat(menu.style.left) || 10;
      const top = Number.parseFloat(menu.style.top) || 10;
      positionMenuInViewport(menu, left, top);
      const activeParent = Array.from(
        menu.querySelectorAll<HTMLElement>('.context-menu-item.has-submenu')
      ).find((parent) => parent.getAttribute('aria-expanded') === 'true');
      const submenu = activeParent ? getContextSubmenu(activeParent) : null;
      if (activeParent && submenu?.style.display === 'block') {
        positionContextSubmenu(activeParent, submenu);
      }
    };

    document.addEventListener(
      'pointerover',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const parent = getContextSubmenuParentForTarget(menu, target);
        if (parent) {
          openContextSubmenu(parent);
        } else if (menu.contains(target)) {
          const activeParent = Array.from(
            menu.querySelectorAll<HTMLElement>('.context-menu-item.has-submenu')
          ).find((candidate) => candidate.getAttribute('aria-expanded') === 'true');
          if (activeParent) closeContextSubmenu(activeParent);
        }
      },
      { signal }
    );
    document.addEventListener(
      'pointerout',
      (event) => {
        if (!isContextMenuRelatedNode(menu, event.target instanceof Node ? event.target : null)) {
          return;
        }
        if (
          isContextMenuRelatedNode(
            menu,
            event.relatedTarget instanceof Node ? event.relatedTarget : null
          )
        ) {
          return;
        }
        closeContextSubmenus(menu);
      },
      { signal }
    );
    menu.addEventListener('scroll', () => closeContextSubmenus(menu, true), {
      passive: true,
      signal,
    });
    window.addEventListener('resize', reposition, { signal });
    window.addEventListener('scroll', reposition, { capture: true, signal });
  }

  function clearContextMenuFocus(menu: HTMLElement) {
    menu.querySelectorAll('.context-menu-item.focused').forEach((item) => {
      item.classList.remove('focused');
    });
  }

  function getVisibleMenuItems(menu: HTMLElement): HTMLElement[] {
    const items = menu.querySelectorAll('.context-menu-item');
    return Array.from(items).filter((item) => {
      const el = item as HTMLElement;
      if (el.closest('.context-submenu')) return false;
      if (el.classList.contains('is-disabled') || el.getAttribute('aria-disabled') === 'true')
        return false;
      return el.style.display !== 'none' && el.getClientRects().length > 0;
    }) as HTMLElement[];
  }

  function setItemDisabled(el: HTMLElement | null, disabled: boolean) {
    if (!el) return;
    el.classList.toggle('is-disabled', disabled);
    el.setAttribute('aria-disabled', String(disabled));
    el.setAttribute('tabindex', disabled ? '-1' : '0');
  }

  function setMenuLabel(el: HTMLElement | null, baseLabel: string, selectedCount: number) {
    if (!el) return;
    const label = selectedCount > 1 ? `${baseLabel} ${selectedCount} items` : baseLabel;
    const labelEl = el.querySelector('.context-menu-label');
    if (labelEl) {
      labelEl.textContent = label;
    }
  }

  function normalizeRecentDestinations(destinations: string[]): string[] {
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const destination of destinations) {
      const trimmed = destination.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(trimmed);
      if (deduped.length >= 8) break;
    }
    return deduped;
  }

  function rememberRecentDestination(destinationPath: string): void {
    const destination = destinationPath.trim();
    if (!destination) return;
    const next = normalizeRecentDestinations([
      destination,
      ...deps.getRecentTransferDestinations(),
    ]);
    deps.setRecentTransferDestinations(next);
  }

  function isDestinationInvalidForSelection(
    destinationPath: string,
    fallbackItemPath: string
  ): boolean {
    const selected = deps.getSelectedItems();
    const sourcePaths = selected.size > 0 ? Array.from(selected) : [fallbackItemPath];
    return sourcePaths.some((sourcePath) => {
      const parentDir = path.dirname(sourcePath);
      return parentDir === destinationPath || sourcePath === destinationPath;
    });
  }

  function renderRecentDestinationItems(fallbackItemPath: string): void {
    if (!elCopyMoveRecentList || !elCopyMoveRecentSeparator) return;
    elCopyMoveRecentList.replaceChildren();
    const destinations = normalizeRecentDestinations(deps.getRecentTransferDestinations());

    if (destinations.length === 0) {
      elCopyMoveRecentSeparator.style.display = 'none';
      return;
    }

    for (const destinationPath of destinations) {
      const destinationName = path.basename(destinationPath) || destinationPath;
      const invalidTarget = isDestinationInvalidForSelection(destinationPath, fallbackItemPath);

      const moveItem = document.createElement('button');
      moveItem.type = 'button';
      moveItem.className = 'context-menu-item';
      moveItem.dataset.action = 'move-to-recent';
      moveItem.dataset.destination = destinationPath;
      moveItem.setAttribute('role', 'menuitem');
      moveItem.setAttribute('tabindex', '0');
      moveItem.title = destinationPath;
      // eslint-disable-next-line no-restricted-syntax -- user data via escapeHtml(); icons/numerics are safe
      moveItem.innerHTML = `
        ${renderIcon('upload', 'twemoji')}
        Move to ${escapeLabel(destinationName)}
      `;
      setItemDisabled(moveItem, invalidTarget);
      elCopyMoveRecentList.appendChild(moveItem);

      const copyItem = document.createElement('button');
      copyItem.type = 'button';
      copyItem.className = 'context-menu-item';
      copyItem.dataset.action = 'copy-to-recent';
      copyItem.dataset.destination = destinationPath;
      copyItem.setAttribute('role', 'menuitem');
      copyItem.setAttribute('tabindex', '0');
      copyItem.title = destinationPath;
      // eslint-disable-next-line no-restricted-syntax -- user data via escapeHtml(); icons/numerics are safe
      copyItem.innerHTML = `
        ${renderIcon('download', 'twemoji')}
        Copy to ${escapeLabel(destinationName)}
      `;
      setItemDisabled(copyItem, invalidTarget);
      elCopyMoveRecentList.appendChild(copyItem);
    }

    elCopyMoveRecentSeparator.style.display = 'block';
  }

  function escapeLabel(value: string): string {
    return value.replace(/[&<>"']/g, (char) => {
      switch (char) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        default:
          return char;
      }
    });
  }

  function normalizeSeparators(menu: HTMLElement) {
    const children = Array.from(menu.children) as HTMLElement[];
    let hasVisibleItem = false;
    let pendingSeparator: HTMLElement | null = null;
    for (const child of children) {
      if (child.classList.contains('context-menu-separator')) {
        child.style.display = 'none';
        pendingSeparator = child;
        continue;
      }
      if (child.style.display === 'none') continue;
      if (hasVisibleItem && pendingSeparator) pendingSeparator.style.display = 'block';
      hasVisibleItem = true;
      pendingSeparator = null;
    }
  }

  function navigateContextMenu(
    menu: HTMLElement,
    direction: 'up' | 'down',
    focusIndex: number
  ): number {
    const items = getVisibleMenuItems(menu);
    if (items.length === 0) return -1;

    clearContextMenuFocus(menu);

    const newIndex =
      direction === 'down'
        ? focusIndex < items.length - 1
          ? focusIndex + 1
          : 0
        : focusIndex > 0
          ? focusIndex - 1
          : items.length - 1;

    items[newIndex]!.classList.add('focused');
    items[newIndex]!.scrollIntoView({ block: 'nearest' });
    items[newIndex]!.focus({ preventScroll: true });
    return newIndex;
  }

  function activateContextMenuItem(menu: HTMLElement, focusIndex: number): boolean {
    const items = getVisibleMenuItems(menu);
    if (focusIndex < 0 || focusIndex >= items.length) return false;

    const item = items[focusIndex]!;
    if (item.classList.contains('has-submenu')) {
      openContextSubmenu(item, true);
      return false;
    }

    item.click();
    return true;
  }

  function showContextMenu(x: number, y: number, item: FileItem) {
    ensureElements();
    const contextMenu = elContextMenu;

    if (!contextMenu) return;
    hideEmptySpaceContextMenu();
    closeContextSubmenus(contextMenu);
    if (!isContextMenuRelatedNode(contextMenu, document.activeElement)) {
      contextMenuReturnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }

    contextMenuData = item;
    contextMenuFocusedIndex = -1;

    const showIf = (el: HTMLElement | null, condition: boolean) => {
      if (el) el.style.display = condition ? 'flex' : 'none';
    };
    const isBundle = !!item.isAppBundle;
    const selectedCount = Math.max(deps.getSelectedItems().size, 1);
    const isMultiSelect = selectedCount > 1;
    showIf(elAddToBookmarks, item.isDirectory && !isBundle);
    showIf(elOpenInNewTab, item.isDirectory && !isBundle && deps.getTabsEnabled());
    showIf(elChangeFolderIcon, item.isDirectory && !isBundle);
    showIf(elCopyPath, true);
    showIf(elOpenTerminal, item.isDirectory && !isBundle);
    showIf(elCompress, true);
    showIf(elExtract, !item.isDirectory && isExtractableArchivePath(item.path));
    showIf(elPreviewPdf, !item.isDirectory && PDF_EXTENSIONS.has(deps.getFileExtension(item.name)));
    showIf(elOpenWithSubmenu, !item.isDirectory);
    showIf(elBatchRename, deps.getSelectedItems().size >= 2);
    showIf(elPasteInto, item.isDirectory && !isBundle && deps.hasClipboardContent());
    showIf(elDuplicate, true);
    showIf(elRename, !isMultiSelect);
    showIf(elCopyMoveSubmenu, true);
    showIf(elAdvancedSubmenu, true);
    showIf(elShare, !item.isDirectory || isBundle);
    showIf(elShowPackageContents, isBundle);
    setItemDisabled(elOpen, isMultiSelect);
    setMenuLabel(elCopy, 'Copy', selectedCount);
    setMenuLabel(elCut, 'Cut', selectedCount);
    setMenuLabel(elDelete, 'Delete', selectedCount);
    setMenuLabel(elDuplicate, 'Duplicate', selectedCount);
    renderRecentDestinationItems(item.path);

    if (elOpenWithSubmenu && !item.isDirectory) {
      setupOpenWithSubmenu();
    }

    contextMenu.style.display = 'block';
    normalizeSeparators(contextMenu);
    positionMenuInViewport(contextMenu, x, y);
    bindContextMenuInteractions(contextMenu);

    contextMenuFocusedIndex = navigateContextMenu(contextMenu, 'down', contextMenuFocusedIndex);
  }

  function hideContextMenu() {
    ensureElements();
    if (elContextMenu) {
      const restoreFocus = isContextMenuRelatedNode(elContextMenu, document.activeElement);
      menuInteractionAbortController?.abort();
      menuInteractionAbortController = null;
      invalidateOpenWithRequest();
      closeContextSubmenus(elContextMenu);
      elContextMenu.style.display = 'none';
      contextMenuData = null;
      clearContextMenuFocus(elContextMenu);
      contextMenuFocusedIndex = -1;
      if (restoreFocus) contextMenuReturnFocus?.focus({ preventScroll: true });
      contextMenuReturnFocus = null;
    }
  }

  function showEmptySpaceContextMenu(x: number, y: number) {
    ensureElements();
    if (!elEmptySpaceContextMenu) return;
    hideContextMenu();
    if (!elEmptySpaceContextMenu.contains(document.activeElement)) {
      emptySpaceMenuReturnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }

    emptySpaceMenuFocusedIndex = -1;
    elEmptySpaceContextMenu.style.display = 'block';
    normalizeSeparators(elEmptySpaceContextMenu);
    positionMenuInViewport(elEmptySpaceContextMenu, x, y);
    emptySpaceMenuFocusedIndex = navigateContextMenu(
      elEmptySpaceContextMenu,
      'down',
      emptySpaceMenuFocusedIndex
    );
  }

  function hideEmptySpaceContextMenu() {
    ensureElements();
    if (elEmptySpaceContextMenu) {
      const restoreFocus = elEmptySpaceContextMenu.contains(document.activeElement);
      elEmptySpaceContextMenu.style.display = 'none';
      clearContextMenuFocus(elEmptySpaceContextMenu);
      emptySpaceMenuFocusedIndex = -1;
      if (restoreFocus) emptySpaceMenuReturnFocus?.focus({ preventScroll: true });
      emptySpaceMenuReturnFocus = null;
    }
  }

  async function handleEmptySpaceContextMenuAction(action: string | undefined) {
    try {
      switch (action) {
        case 'new-folder':
          await deps.createNewFolderWithInlineRename();
          break;

        case 'new-file':
          await deps.createNewFileWithInlineRename();
          break;

        case 'paste':
          await deps.pasteFromClipboard();
          break;

        case 'refresh':
          await deps.navigateTo(deps.getCurrentPath());
          break;

        case 'open-terminal': {
          const terminalResult = await window.tauriAPI.openTerminal(deps.getCurrentPath());
          if (!terminalResult.success) {
            deps.showToast(terminalResult.error || 'Failed to open terminal', 'Error', 'error');
          }
          break;
        }
      }
    } catch {
      deps.showToast('Action failed', 'Error', 'error');
    }

    hideEmptySpaceContextMenu();
  }

  async function handleContextMenuAction(
    action: string | undefined,
    item: FileItem,
    actionParam?: string
  ) {
    try {
      switch (action) {
        case 'open':
          await deps.openFileEntry(item);
          break;

        case 'open-in-new-tab':
          if (item.isDirectory) {
            await deps.addNewTab(item.path);
          }
          break;

        case 'show-package-contents':
          if (item.isAppBundle) {
            void deps.navigateTo(item.path);
          }
          break;

        case 'preview-pdf':
          await deps.showQuickLookForFile(item);
          break;

        case 'refresh':
          await deps.navigateTo(deps.getCurrentPath());
          break;

        case 'rename': {
          const fileItem = deps.getFileElementMap().get(item.path);
          if (fileItem) {
            deps.startInlineRename(fileItem, item.name, item.path);
          }
          break;
        }

        case 'copy':
          deps.copyToClipboard();
          break;

        case 'cut':
          deps.cutToClipboard();
          break;

        case 'copy-path':
          try {
            await window.tauriAPI.writeToSystemClipboard(item.path);
            deps.showToast('File path copied to clipboard', 'Success', 'success');
          } catch {
            deps.showToast('Failed to copy file path', 'Error', 'error');
          }
          break;

        case 'add-to-bookmarks':
          if (item.isDirectory) {
            await deps.addBookmarkByPath(item.path);
          }
          break;

        case 'change-folder-icon':
          if (item.isDirectory) {
            deps.showFolderIconPicker(item.path);
          }
          break;

        case 'open-terminal': {
          const terminalPath = item.isDirectory ? item.path : path.dirname(item.path);
          const terminalResult = await window.tauriAPI.openTerminal(terminalPath);
          if (!terminalResult.success) {
            deps.showToast(terminalResult.error || 'Failed to open terminal', 'Error', 'error');
          }
          break;
        }

        case 'properties': {
          const propsResult = await window.tauriAPI.getItemProperties(item.path);
          if (!propsResult.success) {
            deps.showToast(
              propsResult.error || 'Failed to get properties',
              'Error Getting Properties',
              'error'
            );
            break;
          }
          deps.showPropertiesDialog(propsResult.properties);
          break;
        }

        case 'delete':
          await deps.deleteSelected();
          break;

        case 'compress':
          await deps.handleCompress(actionParam || 'zip');
          break;

        case 'compress-advanced':
          deps.showCompressOptionsModal();
          break;

        case 'extract':
          deps.showExtractModal(item.path, item.name);
          break;

        case 'batch-rename':
          deps.showBatchRenameModal();
          break;

        case 'create-symlink': {
          let linkName = `${item.name} - Link`;
          if (linkName.length > 255) {
            const dotIdx = item.name.lastIndexOf('.');
            const ext = dotIdx > 0 ? item.name.slice(dotIdx) : '';
            const base = item.name.slice(0, 248 - ext.length);
            linkName = `${base} - Link${ext}`;
          }
          const linkPath = path.join(deps.getCurrentPath(), linkName);
          try {
            const result = await window.tauriAPI.createSymlink(item.path, linkPath);
            if (result.success) {
              deps.showToast(`Created symbolic link "${linkName}"`, 'Symlink Created', 'success');
              void deps.navigateTo(deps.getCurrentPath());
            } else {
              deps.showToast(result.error || 'Failed to create symlink', 'Error', 'error');
            }
          } catch {
            deps.showToast('Failed to create symbolic link', 'Error', 'error');
          }
          break;
        }

        case 'paste-into':
          if (item.isDirectory) {
            if (pasteInProgress) {
              deps.showToast('Paste already in progress', 'Info', 'info');
              break;
            }
            pasteInProgress = true;
            try {
              await deps.pasteIntoFolder(item.path);
            } finally {
              pasteInProgress = false;
            }
          }
          break;

        case 'duplicate': {
          const selected = Array.from(deps.getSelectedItems());
          const pathsToDuplicate = selected.length > 0 ? selected : [item.path];
          await deps.duplicateItems(pathsToDuplicate);
          break;
        }

        case 'move-to':
          {
            const destinationPath = await deps.moveSelectedToFolder();
            if (destinationPath) rememberRecentDestination(destinationPath);
          }
          break;

        case 'copy-to':
          {
            const destinationPath = await deps.copySelectedToFolder();
            if (destinationPath) rememberRecentDestination(destinationPath);
          }
          break;

        case 'move-to-recent':
          if (actionParam) {
            const moved = await deps.moveSelectedToDestination(actionParam);
            if (moved) rememberRecentDestination(actionParam);
          }
          break;

        case 'copy-to-recent':
          if (actionParam) {
            const copied = await deps.copySelectedToDestination(actionParam);
            if (copied) rememberRecentDestination(actionParam);
          }
          break;

        case 'share':
          await deps.shareItems([item.path]);
          break;
      }
    } catch (error) {
      deps.showToast('Action failed: ' + getErrorMessage(error), 'Error', 'error');
    }
  }

  function handleKeyboardNavigation(e: KeyboardEvent): boolean {
    ensureElements();
    const contextMenu = elContextMenu;
    const emptySpaceContextMenu = elEmptySpaceContextMenu;

    const handleMenuKeyNav = (
      menu: HTMLElement | null,
      getFocusIdx: () => number,
      setFocusIdx: (n: number) => void,
      hasSubmenu: boolean
    ): boolean => {
      if (!menu || menu.style.display !== 'block') return false;

      // If a submenu is open, navigate within it for ArrowDown/Up/Enter
      if (hasSubmenu) {
        const activeSubmenu = getActiveContextSubmenu(menu);
        if (activeSubmenu) {
          const submenuItems = Array.from(
            activeSubmenu.querySelectorAll<HTMLElement>('.context-menu-item')
          ).filter(
            (el) =>
              el.style.display !== 'none' &&
              el.getClientRects().length > 0 &&
              !el.classList.contains('is-disabled') &&
              el.getAttribute('aria-disabled') !== 'true'
          );
          if (submenuItems.length > 0) {
            const focusedSubIdx = submenuItems.findIndex((el) => el.classList.contains('focused'));
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              const nextIdx = focusedSubIdx < submenuItems.length - 1 ? focusedSubIdx + 1 : 0;
              submenuItems.forEach((el) => el.classList.remove('focused'));
              submenuItems[nextIdx]!.classList.add('focused');
              submenuItems[nextIdx]!.scrollIntoView({ block: 'nearest' });
              submenuItems[nextIdx]!.focus({ preventScroll: true });
              return true;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              const nextIdx = focusedSubIdx > 0 ? focusedSubIdx - 1 : submenuItems.length - 1;
              submenuItems.forEach((el) => el.classList.remove('focused'));
              submenuItems[nextIdx]!.classList.add('focused');
              submenuItems[nextIdx]!.scrollIntoView({ block: 'nearest' });
              submenuItems[nextIdx]!.focus({ preventScroll: true });
              return true;
            }
            if (e.key === 'Enter' && focusedSubIdx >= 0) {
              e.preventDefault();
              submenuItems[focusedSubIdx]!.click();
              return true;
            }
          }
        }
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIdx(navigateContextMenu(menu, 'down', getFocusIdx()));
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIdx(navigateContextMenu(menu, 'up', getFocusIdx()));
        return true;
      }
      if (e.key === 'Enter' && getFocusIdx() >= 0) {
        e.preventDefault();
        const items = getVisibleMenuItems(menu);
        const focusedItem = items[getFocusIdx()];
        if (focusedItem) {
          if (hasSubmenu) {
            activateContextMenuItem(menu, getFocusIdx());
          } else {
            focusedItem.click();
          }
        }
        return true;
      }
      if (hasSubmenu && e.key === 'ArrowRight') {
        const items = getVisibleMenuItems(menu);
        if (getFocusIdx() >= 0 && items[getFocusIdx()]?.classList.contains('has-submenu')) {
          e.preventDefault();
          activateContextMenuItem(menu, getFocusIdx());
        }
        return true;
      }
      if (hasSubmenu && e.key === 'ArrowLeft') {
        e.preventDefault();
        const activeSubmenu = getActiveContextSubmenu(menu);
        if (activeSubmenu) {
          activeSubmenu.querySelectorAll('.context-menu-item.focused').forEach((item) => {
            item.classList.remove('focused');
          });
          const parentItem = contextSubmenuParents.get(activeSubmenu);
          if (parentItem) {
            closeContextSubmenu(parentItem, true);
          }
        }
        return true;
      }
      return false;
    };

    if (
      handleMenuKeyNav(
        contextMenu,
        () => contextMenuFocusedIndex,
        (v) => {
          contextMenuFocusedIndex = v;
        },
        true
      )
    )
      return true;
    if (
      handleMenuKeyNav(
        emptySpaceContextMenu,
        () => emptySpaceMenuFocusedIndex,
        (v) => {
          emptySpaceMenuFocusedIndex = v;
        },
        false
      )
    )
      return true;

    return false;
  }

  function setupOpenWithSubmenu() {
    invalidateOpenWithRequest(false);
    if (elOpenWithAppsPanel) {
      elOpenWithAppsPanel.innerHTML = '<div class="open-with-loading">Loading apps...</div>';
    }
  }

  function loadOpenWithApps() {
    ensureElements();
    const panel = elOpenWithAppsPanel;
    const submenuContainer = elOpenWithSubmenu;
    const item = contextMenuData;
    if (
      !panel ||
      !submenuContainer ||
      !item ||
      item.isDirectory ||
      openWithAppsLoaded ||
      submenuContainer.getAttribute('aria-expanded') !== 'true'
    ) {
      return;
    }

    openWithAppsLoaded = true;
    const requestToken = openWithRequestToken;
    const isCurrentRequest = () =>
      requestToken === openWithRequestToken &&
      contextMenuData?.path === item.path &&
      elContextMenu?.style.display === 'block' &&
      submenuContainer.getAttribute('aria-expanded') === 'true' &&
      panel.style.display === 'block';

    const showApps = async () => {
      try {
        const result = await window.tauriAPI.getOpenWithApps(item.path);
        if (!isCurrentRequest()) return;
        if (!result.success || !result.apps || result.apps.length === 0) {
          panel.innerHTML = '<div class="open-with-loading">No apps found</div>';
          openWithFocusOnLoad = false;
          return;
        }

        panel.replaceChildren();
        for (const app of result.apps) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'context-menu-item';
          btn.setAttribute('role', 'menuitem');
          btn.setAttribute('tabindex', '0');
          btn.textContent = app.name;
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            hideContextMenu();
            try {
              const openResult = await window.tauriAPI.openFileWithApp(item.path, app.id);
              if (!openResult.success) {
                deps.showToast(openResult.error || 'Failed to open file', 'Error', 'error');
              }
            } catch {
              deps.showToast('Failed to open file with selected app', 'Error', 'error');
            }
          });
          panel.appendChild(btn);
        }

        positionContextSubmenu(submenuContainer, panel);
        if (openWithFocusOnLoad && document.activeElement === submenuContainer) {
          openWithFocusOnLoad = false;
          focusFirstSubmenuItem(panel);
        }
      } catch {
        if (!isCurrentRequest()) return;
        panel.innerHTML = '<div class="open-with-loading">Failed to load apps</div>';
        openWithFocusOnLoad = false;
      }
    };

    void showApps();
  }

  return {
    showContextMenu,
    hideContextMenu,
    showEmptySpaceContextMenu,
    hideEmptySpaceContextMenu,
    handleContextMenuAction,
    handleEmptySpaceContextMenuAction,
    handleKeyboardNavigation,
    getContextMenuData: () => contextMenuData,
  };
}
