import type { FileItem, ItemProperties } from './types';
import type { ToastAction } from './rendererToasts.js';
import { isArchivePath } from './rendererCompressExtract.js';
import { PDF_EXTENSIONS } from './fileTypes.js';
import { rendererPath as path } from './rendererUtils.js';

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
  moveSelectedToFolder: () => Promise<void>;
  copySelectedToFolder: () => Promise<void>;
  shareItems: (filePaths: string[]) => Promise<void>;
  hasClipboardContent: () => boolean;
};

export function createContextMenuController(deps: ContextMenuDeps) {
  let contextMenuData: FileItem | null = null;
  let contextMenuFocusedIndex = -1;
  let emptySpaceMenuFocusedIndex = -1;

  let elContextMenu: HTMLElement | null = null;
  let elEmptySpaceContextMenu: HTMLElement | null = null;
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
  let elCopyMoveSubmenu: HTMLElement | null = null;
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
    if (!elCopyMoveSubmenu) elCopyMoveSubmenu = document.getElementById('copy-move-submenu');
    if (!elAdvancedSubmenu) elAdvancedSubmenu = document.getElementById('advanced-submenu');
    if (!elShare) elShare = document.getElementById('share-item');
    if (!elShowPackageContents)
      elShowPackageContents = document.getElementById('show-package-contents-item');
  }

  function positionMenuInViewport(menu: HTMLElement, x: number, y: number) {
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (y + rect.height > vh - 10) top = y - rect.height;
    if (left + rect.width > vw - 10) left = vw - rect.width - 10;
    if (top < 10) top = 10;
    if (left < 10) left = 10;
    if (top + rect.height > vh - 10) top = vh - rect.height - 10;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
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
      const parent = el.parentElement;
      if (parent?.classList.contains('context-submenu')) return false;
      return el.style.display !== 'none' && el.offsetParent !== null;
    }) as HTMLElement[];
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

    items[newIndex].classList.add('focused');
    items[newIndex].scrollIntoView({ block: 'nearest' });
    items[newIndex].focus({ preventScroll: true });
    return newIndex;
  }

  function activateContextMenuItem(menu: HTMLElement, focusIndex: number): boolean {
    const items = getVisibleMenuItems(menu);
    if (focusIndex < 0 || focusIndex >= items.length) return false;

    const item = items[focusIndex];
    if (item.classList.contains('has-submenu')) {
      const submenu = item.querySelector('.context-submenu') as HTMLElement;
      if (submenu) {
        submenu.style.display = 'block';
        const submenuItems = submenu.querySelectorAll(
          '.context-menu-item'
        ) as NodeListOf<HTMLElement>;
        if (submenuItems.length > 0) {
          submenuItems[0].classList.add('focused');
          submenuItems[0].focus({ preventScroll: true });
        }
      }
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

    contextMenuData = item;
    contextMenuFocusedIndex = -1;

    const showIf = (el: HTMLElement | null, condition: boolean) => {
      if (el) el.style.display = condition ? 'flex' : 'none';
    };
    const isBundle = !!item.isAppBundle;
    showIf(elAddToBookmarks, item.isDirectory && !isBundle);
    showIf(elOpenInNewTab, item.isDirectory && !isBundle && deps.getTabsEnabled());
    showIf(elChangeFolderIcon, item.isDirectory && !isBundle);
    showIf(elCopyPath, true);
    showIf(elOpenTerminal, item.isDirectory && !isBundle);
    showIf(elCompress, true);
    showIf(elExtract, !item.isDirectory && isArchivePath(item.path));
    showIf(elPreviewPdf, !item.isDirectory && PDF_EXTENSIONS.has(deps.getFileExtension(item.name)));
    showIf(elOpenWithSubmenu, !item.isDirectory);
    showIf(elBatchRename, deps.getSelectedItems().size >= 2);
    showIf(elPasteInto, item.isDirectory && !isBundle && deps.hasClipboardContent());
    showIf(elDuplicate, true);
    showIf(elCopyMoveSubmenu, true);
    showIf(elAdvancedSubmenu, true);
    showIf(elShare, !item.isDirectory || isBundle);
    showIf(elShowPackageContents, isBundle);

    if (elOpenWithSubmenu && !item.isDirectory) {
      setupOpenWithSubmenu(elOpenWithSubmenu, item);
    }

    contextMenu.style.display = 'block';
    positionMenuInViewport(contextMenu, x, y);

    const submenus = contextMenu.querySelectorAll('.context-submenu');
    const menuRight =
      parseFloat(contextMenu.style.left) + contextMenu.getBoundingClientRect().width;
    const shouldFlip = menuRight + 160 > window.innerWidth - 10;
    submenus.forEach((submenu) => {
      submenu.classList.toggle('flip-left', shouldFlip);
    });

    contextMenuFocusedIndex = navigateContextMenu(contextMenu, 'down', contextMenuFocusedIndex);
  }

  function hideContextMenu() {
    ensureElements();
    if (elContextMenu) {
      elContextMenu.style.display = 'none';
      contextMenuData = null;
      clearContextMenuFocus(elContextMenu);
      contextMenuFocusedIndex = -1;
    }
  }

  function showEmptySpaceContextMenu(x: number, y: number) {
    ensureElements();
    if (!elEmptySpaceContextMenu) return;

    hideContextMenu();

    emptySpaceMenuFocusedIndex = -1;
    elEmptySpaceContextMenu.style.display = 'block';
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
      elEmptySpaceContextMenu.style.display = 'none';
      clearContextMenuFocus(elEmptySpaceContextMenu);
      emptySpaceMenuFocusedIndex = -1;
    }
  }

  async function handleEmptySpaceContextMenuAction(action: string | undefined) {
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
        const terminalResult = await window.electronAPI.openTerminal(deps.getCurrentPath());
        if (!terminalResult.success) {
          deps.showToast(terminalResult.error || 'Failed to open terminal', 'Error', 'error');
        }
        break;
      }
    }

    hideEmptySpaceContextMenu();
  }

  async function handleContextMenuAction(
    action: string | undefined,
    item: FileItem,
    format?: string
  ) {
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
          deps.navigateTo(item.path);
        }
        break;

      case 'preview-pdf':
        await deps.showQuickLookForFile(item);
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
          await navigator.clipboard.writeText(item.path);
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
        const terminalResult = await window.electronAPI.openTerminal(terminalPath);
        if (!terminalResult.success) {
          deps.showToast(terminalResult.error || 'Failed to open terminal', 'Error', 'error');
        }
        break;
      }

      case 'properties': {
        const propsResult = await window.electronAPI.getItemProperties(item.path);
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
        await deps.handleCompress(format || 'zip');
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
        const linkName = `${item.name} - Link`;
        const linkPath = path.join(deps.getCurrentPath(), linkName);
        try {
          const result = await window.electronAPI.createSymlink(item.path, linkPath);
          if (result.success) {
            deps.showToast(`Created symbolic link "${linkName}"`, 'Symlink Created', 'success');
            deps.navigateTo(deps.getCurrentPath());
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
          await deps.pasteIntoFolder(item.path);
        }
        break;

      case 'duplicate': {
        const selected = Array.from(deps.getSelectedItems());
        const pathsToDuplicate = selected.length > 0 ? selected : [item.path];
        await deps.duplicateItems(pathsToDuplicate);
        break;
      }

      case 'move-to':
        await deps.moveSelectedToFolder();
        break;

      case 'copy-to':
        await deps.copySelectedToFolder();
        break;

      case 'share':
        await deps.shareItems([item.path]);
        break;
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
        if (items[getFocusIdx()]) {
          if (hasSubmenu) {
            activateContextMenuItem(menu, getFocusIdx());
          } else {
            items[getFocusIdx()].click();
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
        const activeSubmenu = menu.querySelector<HTMLElement>(
          '.context-submenu[style*="display: block"]'
        );
        if (activeSubmenu) {
          activeSubmenu.style.display = '';
          activeSubmenu.querySelectorAll('.context-menu-item.focused').forEach((item) => {
            item.classList.remove('focused');
          });
          const parentItem = activeSubmenu.closest<HTMLElement>('.context-menu-item.has-submenu');
          if (parentItem) {
            parentItem.classList.add('focused');
            parentItem.focus({ preventScroll: true });
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

  function setupOpenWithSubmenu(submenuContainer: HTMLElement, item: FileItem) {
    ensureElements();
    const panel = elOpenWithAppsPanel;
    if (!panel) return;

    panel.innerHTML = '<div class="open-with-loading">Loading apps...</div>';

    let loaded = false;
    const loadApps = async () => {
      if (loaded) return;
      loaded = true;

      try {
        const result = await window.electronAPI.getOpenWithApps(item.path);
        if (!result.success || !result.apps || result.apps.length === 0) {
          panel.innerHTML = '<div class="open-with-loading">No apps found</div>';
          return;
        }

        panel.innerHTML = '';
        for (const app of result.apps) {
          const btn = document.createElement('button');
          btn.className = 'context-menu-item';
          btn.setAttribute('role', 'menuitem');
          btn.setAttribute('tabindex', '0');
          btn.textContent = app.name;
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            hideContextMenu();
            try {
              const openResult = await window.electronAPI.openFileWithApp(item.path, app.id);
              if (!openResult.success) {
                deps.showToast(openResult.error || 'Failed to open file', 'Error', 'error');
              }
            } catch {
              deps.showToast('Failed to open file with selected app', 'Error', 'error');
            }
          });
          panel.appendChild(btn);
        }
      } catch {
        panel.innerHTML = '<div class="open-with-loading">Failed to load apps</div>';
      }
    };

    submenuContainer.addEventListener('mouseenter', () => void loadApps(), { once: true });
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
