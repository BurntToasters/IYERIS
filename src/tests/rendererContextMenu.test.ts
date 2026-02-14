// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../rendererCompressExtract.js', () => ({
  isArchivePath: (value: string) => value.endsWith('.zip'),
}));

vi.mock('../fileTypes.js', () => ({
  PDF_EXTENSIONS: new Set(['.pdf']),
}));

import { createContextMenuController } from '../rendererContextMenu';
import type { FileItem } from '../types';

function exposeOffsetParent(element: HTMLElement) {
  Object.defineProperty(element, 'offsetParent', {
    get: () => document.body,
    configurable: true,
  });
}

function buildMenus() {
  document.body.innerHTML = `
    <div id="context-menu" style="display:none;position:absolute">
      <div id="open-item" class="context-menu-item">Open</div>
      <div id="add-to-bookmarks-item" class="context-menu-item">Bookmark</div>
      <div id="change-folder-icon-item" class="context-menu-item">Folder Icon</div>
      <div id="copy-path-item" class="context-menu-item">Copy Path</div>
      <div id="open-terminal-item" class="context-menu-item">Open Terminal</div>
      <div id="compress-item" class="context-menu-item has-submenu">
        Compress
        <div class="context-submenu" style="display:none">
          <div id="compress-zip-item" class="context-menu-item">zip</div>
        </div>
      </div>
      <div id="extract-item" class="context-menu-item">Extract</div>
      <div id="preview-pdf-item" class="context-menu-item">Preview PDF</div>
    </div>
    <div id="empty-space-context-menu" style="display:none;position:absolute">
      <div id="empty-new-folder" class="context-menu-item">New Folder</div>
      <div id="empty-open-terminal" class="context-menu-item">Open Terminal</div>
    </div>
  `;

  document.querySelectorAll<HTMLElement>('.context-menu-item').forEach(exposeOffsetParent);
}

function createDeps() {
  return {
    getFileExtension: (name: string) => name.slice(name.lastIndexOf('.')),
    getCurrentPath: () => '/workspace',
    getFileElementMap: () => new Map<string, HTMLElement>(),
    createNewFolderWithInlineRename: vi.fn().mockResolvedValue(undefined),
    createNewFileWithInlineRename: vi.fn().mockResolvedValue(undefined),
    pasteFromClipboard: vi.fn().mockResolvedValue(undefined),
    navigateTo: vi.fn().mockResolvedValue(undefined),
    showToast: vi.fn(),
    openFileEntry: vi.fn().mockResolvedValue(undefined),
    showQuickLookForFile: vi.fn().mockResolvedValue(undefined),
    startInlineRename: vi.fn(),
    copyToClipboard: vi.fn(),
    cutToClipboard: vi.fn(),
    addBookmarkByPath: vi.fn().mockResolvedValue(undefined),
    showFolderIconPicker: vi.fn(),
    showPropertiesDialog: vi.fn(),
    deleteSelected: vi.fn().mockResolvedValue(undefined),
    handleCompress: vi.fn().mockResolvedValue(undefined),
    showCompressOptionsModal: vi.fn(),
    showExtractModal: vi.fn(),
  };
}

describe('createContextMenuController', () => {
  beforeEach(() => {
    buildMenus();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: vi.fn(),
      configurable: true,
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
      configurable: true,
    });
    Object.defineProperty(window, 'electronAPI', {
      value: {
        openTerminal: vi.fn().mockResolvedValue({ success: true }),
        getItemProperties: vi.fn().mockResolvedValue({ success: true, properties: {} }),
      },
      configurable: true,
      writable: true,
    });
  });

  it('shows and hides context-specific menu items', () => {
    const deps = createDeps();
    const controller = createContextMenuController(deps);

    const pdfItem = { path: '/tmp/doc.pdf', name: 'doc.pdf', isDirectory: false } as FileItem;
    controller.showContextMenu(10, 20, pdfItem);

    expect((document.getElementById('preview-pdf-item') as HTMLElement).style.display).toBe('flex');
    expect((document.getElementById('extract-item') as HTMLElement).style.display).toBe('none');

    const archiveItem = {
      path: '/tmp/archive.zip',
      name: 'archive.zip',
      isDirectory: false,
    } as FileItem;
    controller.showContextMenu(10, 20, archiveItem);

    expect((document.getElementById('extract-item') as HTMLElement).style.display).toBe('flex');
    expect((document.getElementById('preview-pdf-item') as HTMLElement).style.display).toBe('none');
  });

  it('copies file path to clipboard and handles clipboard failure', async () => {
    const deps = createDeps();
    const controller = createContextMenuController(deps);
    const item = { path: '/tmp/file.txt', name: 'file.txt', isDirectory: false } as FileItem;

    await controller.handleContextMenuAction('copy-path', item);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/file.txt');
    expect(deps.showToast).toHaveBeenCalledWith(
      'File path copied to clipboard',
      'Success',
      'success'
    );

    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'));
    await controller.handleContextMenuAction('copy-path', item);
    expect(deps.showToast).toHaveBeenCalledWith('Failed to copy file path', 'Error', 'error');
  });

  it('handles keyboard navigation and activates focused item on Enter', () => {
    const deps = createDeps();
    const controller = createContextMenuController(deps);
    const openItem = document.getElementById('open-item') as HTMLElement;
    const clickSpy = vi.fn();
    openItem.addEventListener('click', clickSpy);

    const file = { path: '/tmp/a.txt', name: 'a.txt', isDirectory: false } as FileItem;
    controller.showContextMenu(5, 5, file);

    const handled = controller.handleKeyboardNavigation(
      new KeyboardEvent('keydown', { key: 'Enter' })
    );

    expect(handled).toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('handles empty-space open-terminal errors', async () => {
    const deps = createDeps();
    const controller = createContextMenuController(deps);
    const electronApi = (
      window as unknown as { electronAPI: { openTerminal: ReturnType<typeof vi.fn> } }
    ).electronAPI;
    electronApi.openTerminal = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'terminal unavailable' });

    controller.showEmptySpaceContextMenu(12, 18);
    await controller.handleEmptySpaceContextMenuAction('open-terminal');

    expect(deps.showToast).toHaveBeenCalledWith('terminal unavailable', 'Error', 'error');
    expect((document.getElementById('empty-space-context-menu') as HTMLElement).style.display).toBe(
      'none'
    );
  });
});
