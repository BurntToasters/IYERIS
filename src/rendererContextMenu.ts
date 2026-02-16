import type { FileItem, ItemProperties } from './types';
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
    type: 'success' | 'error' | 'info' | 'warning'
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
};

export function createContextMenuController(deps: ContextMenuDeps) {
  let contextMenuData: FileItem | null = null;
  let contextMenuFocusedIndex = -1;
  let emptySpaceMenuFocusedIndex = -1;

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

    let newIndex = focusIndex;
    if (direction === 'down') {
      newIndex = focusIndex < items.length - 1 ? focusIndex + 1 : 0;
    } else {
      newIndex = focusIndex > 0 ? focusIndex - 1 : items.length - 1;
    }

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
    const contextMenu = document.getElementById('context-menu');
    const addToBookmarksItem = document.getElementById('add-to-bookmarks-item');
    const changeFolderIconItem = document.getElementById('change-folder-icon-item');
    const copyPathItem = document.getElementById('copy-path-item');
    const openTerminalItem = document.getElementById('open-terminal-item');
    const compressItem = document.getElementById('compress-item');
    const extractItem = document.getElementById('extract-item');
    const previewPdfItem = document.getElementById('preview-pdf-item');

    if (!contextMenu) return;

    hideEmptySpaceContextMenu();

    contextMenuData = item;
    contextMenuFocusedIndex = -1;

    const showIf = (el: HTMLElement | null, condition: boolean) => {
      if (el) el.style.display = condition ? 'flex' : 'none';
    };
    showIf(addToBookmarksItem, item.isDirectory);
    showIf(changeFolderIconItem, item.isDirectory);
    showIf(copyPathItem, true);
    showIf(openTerminalItem, item.isDirectory);
    showIf(compressItem, true);
    showIf(extractItem, !item.isDirectory && isArchivePath(item.path));
    showIf(
      previewPdfItem,
      !item.isDirectory && PDF_EXTENSIONS.has(deps.getFileExtension(item.name))
    );

    contextMenu.style.display = 'block';
    positionMenuInViewport(contextMenu, x, y);

    const submenu = contextMenu.querySelector('.context-submenu') as HTMLElement;
    if (submenu) {
      submenu.classList.remove('flip-left');
      const menuRight =
        parseFloat(contextMenu.style.left) + contextMenu.getBoundingClientRect().width;
      if (menuRight + 160 > window.innerWidth - 10) {
        submenu.classList.add('flip-left');
      }
    }

    contextMenuFocusedIndex = navigateContextMenu(contextMenu, 'down', contextMenuFocusedIndex);
  }

  function hideContextMenu() {
    const contextMenuElement = document.getElementById('context-menu');
    if (contextMenuElement) {
      contextMenuElement.style.display = 'none';
      contextMenuData = null;
      clearContextMenuFocus(contextMenuElement);
      contextMenuFocusedIndex = -1;
    }
  }

  function showEmptySpaceContextMenu(x: number, y: number) {
    const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');
    if (!emptySpaceContextMenu) return;

    hideContextMenu();

    emptySpaceMenuFocusedIndex = -1;
    emptySpaceContextMenu.style.display = 'block';
    positionMenuInViewport(emptySpaceContextMenu, x, y);
    emptySpaceMenuFocusedIndex = navigateContextMenu(
      emptySpaceContextMenu,
      'down',
      emptySpaceMenuFocusedIndex
    );
  }

  function hideEmptySpaceContextMenu() {
    const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');
    if (emptySpaceContextMenu) {
      emptySpaceContextMenu.style.display = 'none';
      clearContextMenuFocus(emptySpaceContextMenu);
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
        if (propsResult.success && propsResult.properties) {
          deps.showPropertiesDialog(propsResult.properties);
        } else {
          deps.showToast(propsResult.error || 'Unknown error', 'Error Getting Properties', 'error');
        }
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
    }
  }

  function handleKeyboardNavigation(e: KeyboardEvent): boolean {
    const contextMenu = document.getElementById('context-menu');
    const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');

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
