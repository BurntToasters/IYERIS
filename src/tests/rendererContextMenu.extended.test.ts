// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../rendererCompressExtract.js', () => ({
  isArchivePath: (value: string) => value.endsWith('.zip') || value.endsWith('.7z'),
}));

vi.mock('../fileTypes.js', () => ({
  PDF_EXTENSIONS: new Set(['.pdf']),
}));

import { createContextMenuController } from '../rendererContextMenu';
import type { FileItem } from '../types';

function createDeps() {
  return {
    getFileExtension: (name: string) => name.slice(name.lastIndexOf('.')),
    getCurrentPath: vi.fn(() => '/workspace'),
    getFileElementMap: vi.fn(() => new Map<string, HTMLElement>()),
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
    getSelectedItems: vi.fn().mockReturnValue(new Set()),
    showBatchRenameModal: vi.fn(),
    addNewTab: vi.fn().mockResolvedValue(undefined),
    getTabsEnabled: vi.fn().mockReturnValue(true),
    pasteIntoFolder: vi.fn().mockResolvedValue(undefined),
    duplicateItems: vi.fn().mockResolvedValue(undefined),
    moveSelectedToFolder: vi.fn().mockResolvedValue(null),
    copySelectedToFolder: vi.fn().mockResolvedValue(null),
    moveSelectedToDestination: vi.fn().mockResolvedValue(true),
    copySelectedToDestination: vi.fn().mockResolvedValue(true),
    shareItems: vi.fn().mockResolvedValue(undefined),
    hasClipboardContent: vi.fn().mockReturnValue(false),
    getRecentTransferDestinations: vi.fn().mockReturnValue([]),
    setRecentTransferDestinations: vi.fn(),
  };
}

describe('handleContextMenuAction - all branches', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    Object.defineProperty(window, 'tauriAPI', {
      value: {
        openTerminal: vi.fn().mockResolvedValue({ success: true }),
        getItemProperties: vi.fn().mockResolvedValue({ success: true, properties: { size: 100 } }),
      },
      configurable: true,
      writable: true,
    });
  });

  it('handles "open" action', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/a.txt', name: 'a.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('open', item);
    expect(deps.openFileEntry).toHaveBeenCalledWith(item);
  });

  it('handles "preview-pdf" action', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/doc.pdf', name: 'doc.pdf', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('preview-pdf', item);
    expect(deps.showQuickLookForFile).toHaveBeenCalledWith(item);
  });

  it('handles "rename" action when element exists', async () => {
    const deps = createDeps();
    const el = document.createElement('div');
    deps.getFileElementMap.mockReturnValue(new Map([['/file.txt', el]]));
    const ctrl = createContextMenuController(deps);
    const item = { path: '/file.txt', name: 'file.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('rename', item);
    expect(deps.startInlineRename).toHaveBeenCalledWith(el, 'file.txt', '/file.txt');
  });

  it('handles "rename" action when element does not exist', async () => {
    const deps = createDeps();
    deps.getFileElementMap.mockReturnValue(new Map());
    const ctrl = createContextMenuController(deps);
    const item = { path: '/missing.txt', name: 'missing.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('rename', item);
    expect(deps.startInlineRename).not.toHaveBeenCalled();
  });

  it('handles "copy" action', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/x.txt', name: 'x.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('copy', item);
    expect(deps.copyToClipboard).toHaveBeenCalled();
  });

  it('handles "cut" action', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/x.txt', name: 'x.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('cut', item);
    expect(deps.cutToClipboard).toHaveBeenCalled();
  });

  it('handles "add-to-bookmarks" for directory', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/folder', name: 'folder', isDirectory: true } as FileItem;
    await ctrl.handleContextMenuAction('add-to-bookmarks', item);
    expect(deps.addBookmarkByPath).toHaveBeenCalledWith('/folder');
  });

  it('skips "add-to-bookmarks" for non-directory', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/file.txt', name: 'file.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('add-to-bookmarks', item);
    expect(deps.addBookmarkByPath).not.toHaveBeenCalled();
  });

  it('handles "change-folder-icon" for directory', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/folder', name: 'folder', isDirectory: true } as FileItem;
    await ctrl.handleContextMenuAction('change-folder-icon', item);
    expect(deps.showFolderIconPicker).toHaveBeenCalledWith('/folder');
  });

  it('skips "change-folder-icon" for file', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/file.txt', name: 'file.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('change-folder-icon', item);
    expect(deps.showFolderIconPicker).not.toHaveBeenCalled();
  });

  it('handles "open-terminal" for directory', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/mydir', name: 'mydir', isDirectory: true } as FileItem;
    await ctrl.handleContextMenuAction('open-terminal', item);
    expect(window.tauriAPI.openTerminal).toHaveBeenCalledWith('/mydir');
  });

  it('handles "open-terminal" for file (uses dirname)', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/dir/file.txt', name: 'file.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('open-terminal', item);

    expect(window.tauriAPI.openTerminal).toHaveBeenCalledWith('/dir');
  });

  it('handles "open-terminal" failure', async () => {
    const deps = createDeps();
    (window.tauriAPI as unknown as { openTerminal: ReturnType<typeof vi.fn> }).openTerminal = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'no terminal' });
    const ctrl = createContextMenuController(deps);
    const item = { path: '/mydir', name: 'mydir', isDirectory: true } as FileItem;
    await ctrl.handleContextMenuAction('open-terminal', item);
    expect(deps.showToast).toHaveBeenCalledWith('no terminal', 'Error', 'error');
  });

  it('handles "properties" success', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/file.txt', name: 'file.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('properties', item);
    expect(deps.showPropertiesDialog).toHaveBeenCalledWith({ size: 100 });
  });

  it('handles "properties" failure', async () => {
    const deps = createDeps();
    (
      window.tauriAPI as unknown as { getItemProperties: ReturnType<typeof vi.fn> }
    ).getItemProperties = vi.fn().mockResolvedValue({ success: false, error: 'access denied' });
    const ctrl = createContextMenuController(deps);
    const item = { path: '/file.txt', name: 'file.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('properties', item);
    expect(deps.showToast).toHaveBeenCalledWith(
      'access denied',
      'Error Getting Properties',
      'error'
    );
  });

  it('handles "delete" action', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/file.txt', name: 'file.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('delete', item);
    expect(deps.deleteSelected).toHaveBeenCalled();
  });

  it('handles "compress" with default zip format', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/file.txt', name: 'file.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('compress', item);
    expect(deps.handleCompress).toHaveBeenCalledWith('zip');
  });

  it('handles "compress" with explicit 7z format', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/file.txt', name: 'file.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('compress', item, '7z');
    expect(deps.handleCompress).toHaveBeenCalledWith('7z');
  });

  it('handles "compress-advanced" action', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/file.txt', name: 'file.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('compress-advanced', item);
    expect(deps.showCompressOptionsModal).toHaveBeenCalled();
  });

  it('handles "extract" action', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/archive.zip', name: 'archive.zip', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('extract', item);
    expect(deps.showExtractModal).toHaveBeenCalledWith('/archive.zip', 'archive.zip');
  });

  it('handles "open-in-new-tab" only for directories', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);

    await ctrl.handleContextMenuAction('open-in-new-tab', {
      path: '/folder',
      name: 'folder',
      isDirectory: true,
    } as FileItem);
    expect(deps.addNewTab).toHaveBeenCalledWith('/folder');

    await ctrl.handleContextMenuAction('open-in-new-tab', {
      path: '/file.txt',
      name: 'file.txt',
      isDirectory: false,
    } as FileItem);
    expect(deps.addNewTab).toHaveBeenCalledTimes(1);
  });

  it('handles "show-package-contents" only for app bundles', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);

    await ctrl.handleContextMenuAction('show-package-contents', {
      path: '/MyApp.app',
      name: 'MyApp.app',
      isDirectory: true,
      isAppBundle: true,
    } as FileItem);
    expect(deps.navigateTo).toHaveBeenCalledWith('/MyApp.app');

    await ctrl.handleContextMenuAction('show-package-contents', {
      path: '/folder',
      name: 'folder',
      isDirectory: true,
      isAppBundle: false,
    } as FileItem);
    expect(deps.navigateTo).toHaveBeenCalledTimes(1);
  });

  it('handles "batch-rename" action', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/file.txt', name: 'file.txt', isDirectory: false } as FileItem;

    await ctrl.handleContextMenuAction('batch-rename', item);
    expect(deps.showBatchRenameModal).toHaveBeenCalled();
  });

  it('handles "create-symlink" success and refreshes current path', async () => {
    const deps = createDeps();
    (window.tauriAPI as unknown as { createSymlink: ReturnType<typeof vi.fn> }).createSymlink = vi
      .fn()
      .mockResolvedValue({ success: true });

    const ctrl = createContextMenuController(deps);
    const item = { path: '/files/a.txt', name: 'a.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('create-symlink', item);

    expect(window.tauriAPI.createSymlink).toHaveBeenCalledWith(
      '/files/a.txt',
      '/workspace/a.txt - Link'
    );
    expect(deps.showToast).toHaveBeenCalledWith(
      'Created symbolic link "a.txt - Link"',
      'Symlink Created',
      'success'
    );
    expect(deps.navigateTo).toHaveBeenCalledWith('/workspace');
  });

  it('handles "create-symlink" long-name truncation and failure', async () => {
    const deps = createDeps();
    const createSymlink = vi.fn().mockResolvedValue({ success: false, error: 'blocked' });
    (window.tauriAPI as unknown as { createSymlink: ReturnType<typeof vi.fn> }).createSymlink =
      createSymlink;

    const ctrl = createContextMenuController(deps);
    const longName = `${'a'.repeat(260)}.txt`;
    const item = { path: `/files/${longName}`, name: longName, isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('create-symlink', item);

    const [, linkPath] = createSymlink.mock.calls[0] as [string, string];
    const generatedName = linkPath.slice('/workspace/'.length);
    expect(generatedName.length).toBeLessThanOrEqual(255);
    expect(deps.showToast).toHaveBeenCalledWith('blocked', 'Error', 'error');
  });

  it('handles "create-symlink" exceptions', async () => {
    const deps = createDeps();
    (window.tauriAPI as unknown as { createSymlink: ReturnType<typeof vi.fn> }).createSymlink = vi
      .fn()
      .mockRejectedValue(new Error('boom'));

    const ctrl = createContextMenuController(deps);
    const item = { path: '/files/a.txt', name: 'a.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('create-symlink', item);

    expect(deps.showToast).toHaveBeenCalledWith('Failed to create symbolic link', 'Error', 'error');
  });

  it('handles "paste-into" and in-progress guard', async () => {
    const deps = createDeps();
    let resolvePaste: (() => void) | null = null;
    const pastePromise = new Promise<void>((resolve) => {
      resolvePaste = resolve;
    });
    deps.pasteIntoFolder.mockImplementation(() => pastePromise);

    const ctrl = createContextMenuController(deps);
    const dir = { path: '/folder', name: 'folder', isDirectory: true } as FileItem;

    const first = ctrl.handleContextMenuAction('paste-into', dir);
    await ctrl.handleContextMenuAction('paste-into', dir);

    expect(deps.showToast).toHaveBeenCalledWith('Paste already in progress', 'Info', 'info');

    resolvePaste?.();
    await first;
    expect(deps.pasteIntoFolder).toHaveBeenCalledWith('/folder');
  });

  it('handles "paste-into" as a no-op for files', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);

    await ctrl.handleContextMenuAction('paste-into', {
      path: '/file.txt',
      name: 'file.txt',
      isDirectory: false,
    } as FileItem);
    expect(deps.pasteIntoFolder).not.toHaveBeenCalled();
  });

  it('handles duplicate/move-to/copy-to/share actions', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);

    deps.getSelectedItems.mockReturnValue(new Set(['/a', '/b']));
    await ctrl.handleContextMenuAction('duplicate', {
      path: '/item',
      name: 'item',
      isDirectory: false,
    } as FileItem);
    expect(deps.duplicateItems).toHaveBeenCalledWith(['/a', '/b']);

    deps.getSelectedItems.mockReturnValue(new Set());
    await ctrl.handleContextMenuAction('duplicate', {
      path: '/fallback',
      name: 'fallback',
      isDirectory: false,
    } as FileItem);
    expect(deps.duplicateItems).toHaveBeenCalledWith(['/fallback']);

    await ctrl.handleContextMenuAction('move-to', {
      path: '/x',
      name: 'x',
      isDirectory: false,
    } as FileItem);
    expect(deps.moveSelectedToFolder).toHaveBeenCalled();

    await ctrl.handleContextMenuAction('copy-to', {
      path: '/x',
      name: 'x',
      isDirectory: false,
    } as FileItem);
    expect(deps.copySelectedToFolder).toHaveBeenCalled();

    await ctrl.handleContextMenuAction('share', {
      path: '/x',
      name: 'x',
      isDirectory: false,
    } as FileItem);
    expect(deps.shareItems).toHaveBeenCalledWith(['/x']);
  });

  it('handles recent destination actions and updates recents list', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/x', name: 'x', isDirectory: false } as FileItem;

    deps.moveSelectedToFolder.mockResolvedValue('/dest-a');
    deps.copySelectedToFolder.mockResolvedValue('/dest-b');
    deps.getRecentTransferDestinations.mockReturnValue(['/dest-b', '/dest-c']);

    await ctrl.handleContextMenuAction('move-to', item);
    expect(deps.setRecentTransferDestinations).toHaveBeenCalledWith([
      '/dest-a',
      '/dest-b',
      '/dest-c',
    ]);

    await ctrl.handleContextMenuAction('copy-to', item);
    expect(deps.setRecentTransferDestinations).toHaveBeenCalledWith(['/dest-b', '/dest-c']);

    await ctrl.handleContextMenuAction('move-to-recent', item, '/dest-d');
    expect(deps.moveSelectedToDestination).toHaveBeenCalledWith('/dest-d');

    await ctrl.handleContextMenuAction('copy-to-recent', item, '/dest-e');
    expect(deps.copySelectedToDestination).toHaveBeenCalledWith('/dest-e');
  });

  it('routes action errors through the generic error toast', async () => {
    const deps = createDeps();
    deps.moveSelectedToFolder.mockRejectedValue(new Error('move failed'));

    const ctrl = createContextMenuController(deps);
    await ctrl.handleContextMenuAction('move-to', {
      path: '/x',
      name: 'x',
      isDirectory: false,
    } as FileItem);

    expect(deps.showToast).toHaveBeenCalledWith('Action failed: move failed', 'Error', 'error');
  });

  it('does nothing for undefined action', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/file.txt', name: 'file.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction(undefined, item);
    expect(deps.openFileEntry).not.toHaveBeenCalled();
    expect(deps.deleteSelected).not.toHaveBeenCalled();
  });
});

describe('handleEmptySpaceContextMenuAction - all branches', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'tauriAPI', {
      value: {
        openTerminal: vi.fn().mockResolvedValue({ success: true }),
      },
      configurable: true,
      writable: true,
    });
  });

  it('handles "new-folder"', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    await ctrl.handleEmptySpaceContextMenuAction('new-folder');
    expect(deps.createNewFolderWithInlineRename).toHaveBeenCalled();
  });

  it('handles "new-file"', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    await ctrl.handleEmptySpaceContextMenuAction('new-file');
    expect(deps.createNewFileWithInlineRename).toHaveBeenCalled();
  });

  it('handles "paste"', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    await ctrl.handleEmptySpaceContextMenuAction('paste');
    expect(deps.pasteFromClipboard).toHaveBeenCalled();
  });

  it('handles "refresh" by navigating to current path', async () => {
    const deps = createDeps();
    deps.getCurrentPath.mockReturnValue('/my/folder');
    const ctrl = createContextMenuController(deps);
    await ctrl.handleEmptySpaceContextMenuAction('refresh');
    expect(deps.navigateTo).toHaveBeenCalledWith('/my/folder');
  });

  it('handles "open-terminal" success', async () => {
    const deps = createDeps();
    deps.getCurrentPath.mockReturnValue('/workspace');
    const ctrl = createContextMenuController(deps);
    await ctrl.handleEmptySpaceContextMenuAction('open-terminal');
    expect(window.tauriAPI.openTerminal).toHaveBeenCalledWith('/workspace');
  });

  it('handles "open-terminal" failure', async () => {
    const deps = createDeps();
    deps.getCurrentPath.mockReturnValue('/workspace');
    (window.tauriAPI as unknown as { openTerminal: ReturnType<typeof vi.fn> }).openTerminal = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'no shell' });
    const ctrl = createContextMenuController(deps);
    await ctrl.handleEmptySpaceContextMenuAction('open-terminal');
    expect(deps.showToast).toHaveBeenCalledWith('no shell', 'Error', 'error');
  });

  it('does nothing for undefined action', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    await ctrl.handleEmptySpaceContextMenuAction(undefined);
    expect(deps.createNewFolderWithInlineRename).not.toHaveBeenCalled();
    expect(deps.pasteFromClipboard).not.toHaveBeenCalled();
  });

  it('shows a generic toast when an action throws', async () => {
    const deps = createDeps();
    deps.createNewFolderWithInlineRename.mockRejectedValue(new Error('disk error'));

    const ctrl = createContextMenuController(deps);
    await ctrl.handleEmptySpaceContextMenuAction('new-folder');

    expect(deps.showToast).toHaveBeenCalledWith('Action failed', 'Error', 'error');
  });
});

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
      <div id="open-in-new-tab-item" class="context-menu-item">Open In New Tab</div>
      <div id="copy-path-item" class="context-menu-item">Copy Path</div>
      <div id="open-terminal-item" class="context-menu-item">Open Terminal</div>
      <div id="compress-item" class="context-menu-item has-submenu">
        Compress
        <div class="context-submenu" style="display:none">
          <div id="compress-zip-item" class="context-menu-item">zip</div>
          <div id="compress-tar-item" class="context-menu-item">tar</div>
        </div>
      </div>
      <div id="open-with-submenu" class="context-menu-item has-submenu">
        Open With
        <div class="context-submenu" style="display:none">
          <div id="open-with-apps-panel"></div>
        </div>
      </div>
      <div id="batch-rename-item" class="context-menu-item">Batch Rename</div>
      <div id="paste-into-item" class="context-menu-item">Paste Into</div>
      <div id="duplicate-item" class="context-menu-item">Duplicate</div>
      <div id="copy-move-submenu" class="context-menu-item has-submenu">
        Copy / Move
        <div class="context-submenu" style="display:none">
          <div id="move-to-item" class="context-menu-item">Move To</div>
          <div id="copy-to-item" class="context-menu-item">Copy To</div>
        </div>
      </div>
      <div id="advanced-submenu" class="context-menu-item has-submenu">
        Advanced
        <div class="context-submenu" style="display:none">
          <div id="create-symlink-item" class="context-menu-item">Create Symlink</div>
        </div>
      </div>
      <div id="share-item" class="context-menu-item">Share</div>
      <div id="show-package-contents-item" class="context-menu-item">Show Package Contents</div>
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

describe('handleKeyboardNavigation - context menu ArrowDown/ArrowUp (line 365)', () => {
  beforeEach(() => {
    buildMenus();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: vi.fn(),
      configurable: true,
    });
    Object.defineProperty(window, 'tauriAPI', {
      value: {
        openTerminal: vi.fn().mockResolvedValue({ success: true }),
        getItemProperties: vi.fn().mockResolvedValue({ success: true, properties: {} }),
      },
      configurable: true,
      writable: true,
    });
  });

  it('ArrowDown advances focus index via setFocusIdx callback', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    const file = { path: '/tmp/a.txt', name: 'a.txt', isDirectory: false } as FileItem;
    ctrl.showContextMenu(5, 5, file);

    const handled = ctrl.handleKeyboardNavigation(
      new KeyboardEvent('keydown', { key: 'ArrowDown' })
    );
    expect(handled).toBe(true);

    const contextMenu = document.getElementById('context-menu') as HTMLElement;
    const focused = contextMenu.querySelectorAll('.context-menu-item.focused');
    expect(focused.length).toBe(1);
  });

  it('ArrowUp moves focus backwards via setFocusIdx callback', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    const file = { path: '/tmp/a.txt', name: 'a.txt', isDirectory: false } as FileItem;
    ctrl.showContextMenu(5, 5, file);

    ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

    const handled = ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(handled).toBe(true);
  });

  it('ArrowRight activates submenu on has-submenu item', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    const file = { path: '/tmp/a.txt', name: 'a.txt', isDirectory: false } as FileItem;
    ctrl.showContextMenu(5, 5, file);

    const contextMenu = document.getElementById('context-menu') as HTMLElement;
    const allItems = Array.from(contextMenu.querySelectorAll('.context-menu-item')).filter((el) => {
      const html = el as HTMLElement;
      const parent = html.parentElement;
      return (
        !parent?.classList.contains('context-submenu') &&
        html.style.display !== 'none' &&
        html.offsetParent !== null
      );
    });
    const submenuIdx = allItems.findIndex((el) => (el as HTMLElement).id === 'compress-item');

    for (let i = 0; i < submenuIdx; i++) {
      ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    }

    const handled = ctrl.handleKeyboardNavigation(
      new KeyboardEvent('keydown', { key: 'ArrowRight' })
    );
    expect(handled).toBe(true);

    const submenu = contextMenu.querySelector('#compress-item .context-submenu') as HTMLElement;
    expect(submenu.style.display).toBe('block');
  });

  it('ArrowRight returns true even when focused item is not a submenu', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    const file = { path: '/tmp/a.txt', name: 'a.txt', isDirectory: false } as FileItem;
    ctrl.showContextMenu(5, 5, file);

    const handled = ctrl.handleKeyboardNavigation(
      new KeyboardEvent('keydown', { key: 'ArrowRight' })
    );
    expect(handled).toBe(true);
  });
});

describe('handleKeyboardNavigation - empty space context menu (lines 371-383)', () => {
  beforeEach(() => {
    buildMenus();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: vi.fn(),
      configurable: true,
    });
    Object.defineProperty(window, 'tauriAPI', {
      value: {
        openTerminal: vi.fn().mockResolvedValue({ success: true }),
        getItemProperties: vi.fn().mockResolvedValue({ success: true, properties: {} }),
      },
      configurable: true,
      writable: true,
    });
  });

  it('ArrowDown advances focus in empty space context menu', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    ctrl.showEmptySpaceContextMenu(10, 10);

    const handled = ctrl.handleKeyboardNavigation(
      new KeyboardEvent('keydown', { key: 'ArrowDown' })
    );
    expect(handled).toBe(true);

    const emptyMenu = document.getElementById('empty-space-context-menu') as HTMLElement;
    const focused = emptyMenu.querySelectorAll('.context-menu-item.focused');
    expect(focused.length).toBe(1);
  });

  it('ArrowUp moves focus backwards in empty space context menu', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    ctrl.showEmptySpaceContextMenu(10, 10);

    ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

    const handled = ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(handled).toBe(true);
  });

  it('Enter clicks focused item in empty space context menu', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    ctrl.showEmptySpaceContextMenu(10, 10);

    const emptyMenu = document.getElementById('empty-space-context-menu') as HTMLElement;
    const firstItem = emptyMenu.querySelector('.context-menu-item') as HTMLElement;
    const clickSpy = vi.fn();
    firstItem.addEventListener('click', clickSpy);

    const handled = ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(handled).toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('ArrowRight is not handled for empty space menu (no submenu)', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    ctrl.showEmptySpaceContextMenu(10, 10);

    const handled = ctrl.handleKeyboardNavigation(
      new KeyboardEvent('keydown', { key: 'ArrowRight' })
    );
    expect(handled).toBe(false);
  });
});

describe('handleKeyboardNavigation - returns false when no menu is open (line 394)', () => {
  beforeEach(() => {
    buildMenus();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: vi.fn(),
      configurable: true,
    });
    Object.defineProperty(window, 'tauriAPI', {
      value: {
        openTerminal: vi.fn().mockResolvedValue({ success: true }),
        getItemProperties: vi.fn().mockResolvedValue({ success: true, properties: {} }),
      },
      configurable: true,
      writable: true,
    });
  });

  it('returns false for ArrowDown when neither menu is open', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    const handled = ctrl.handleKeyboardNavigation(
      new KeyboardEvent('keydown', { key: 'ArrowDown' })
    );
    expect(handled).toBe(false);
  });

  it('returns false for Enter when neither menu is open', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    const handled = ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(handled).toBe(false);
  });

  it('returns false after both menus are hidden', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    const file = { path: '/tmp/a.txt', name: 'a.txt', isDirectory: false } as FileItem;

    ctrl.showContextMenu(5, 5, file);
    ctrl.hideContextMenu();

    const handled = ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(handled).toBe(false);
  });
});

describe('getContextMenuData (line 394)', () => {
  beforeEach(() => {
    buildMenus();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: vi.fn(),
      configurable: true,
    });
    Object.defineProperty(window, 'tauriAPI', {
      value: {
        openTerminal: vi.fn().mockResolvedValue({ success: true }),
        getItemProperties: vi.fn().mockResolvedValue({ success: true, properties: {} }),
      },
      configurable: true,
      writable: true,
    });
  });

  it('returns null initially', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    expect(ctrl.getContextMenuData()).toBeNull();
  });

  it('returns the item after showContextMenu', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    const item = { path: '/tmp/file.txt', name: 'file.txt', isDirectory: false } as FileItem;
    ctrl.showContextMenu(10, 20, item);
    expect(ctrl.getContextMenuData()).toBe(item);
  });

  it('returns null after hideContextMenu', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    const item = { path: '/tmp/file.txt', name: 'file.txt', isDirectory: false } as FileItem;
    ctrl.showContextMenu(10, 20, item);
    ctrl.hideContextMenu();
    expect(ctrl.getContextMenuData()).toBeNull();
  });
});

describe('context menu rendering and keyboard edge branches', () => {
  beforeEach(() => {
    buildMenus();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: vi.fn(),
      configurable: true,
    });
    Object.defineProperty(window, 'tauriAPI', {
      value: {
        openTerminal: vi.fn().mockResolvedValue({ success: true }),
        getItemProperties: vi.fn().mockResolvedValue({ success: true, properties: {} }),
        getOpenWithApps: vi.fn().mockResolvedValue({ success: true, apps: [] }),
        openFileWithApp: vi.fn().mockResolvedValue({ success: true }),
      },
      configurable: true,
      writable: true,
    });
  });

  it('toggles conditional menu item visibility for folders, files, and app bundles', () => {
    const deps = createDeps();
    deps.getSelectedItems.mockReturnValue(new Set(['/a', '/b']));
    deps.hasClipboardContent.mockReturnValue(true);

    const ctrl = createContextMenuController(deps as any);
    ctrl.showContextMenu(20, 30, {
      path: '/folder',
      name: 'folder',
      isDirectory: true,
      isAppBundle: false,
    } as FileItem);

    expect((document.getElementById('open-in-new-tab-item') as HTMLElement).style.display).toBe(
      'flex'
    );
    expect((document.getElementById('paste-into-item') as HTMLElement).style.display).toBe('flex');
    expect((document.getElementById('add-to-bookmarks-item') as HTMLElement).style.display).toBe(
      'flex'
    );
    expect((document.getElementById('open-with-submenu') as HTMLElement).style.display).toBe(
      'none'
    );

    ctrl.showContextMenu(25, 35, {
      path: '/document.txt',
      name: 'document.txt',
      isDirectory: false,
    } as FileItem);
    expect((document.getElementById('open-with-submenu') as HTMLElement).style.display).toBe(
      'flex'
    );
    expect((document.getElementById('share-item') as HTMLElement).style.display).toBe('flex');

    ctrl.showContextMenu(30, 40, {
      path: '/MyApp.app',
      name: 'MyApp.app',
      isDirectory: true,
      isAppBundle: true,
    } as FileItem);
    expect(
      (document.getElementById('show-package-contents-item') as HTMLElement).style.display
    ).toBe('flex');
    expect((document.getElementById('add-to-bookmarks-item') as HTMLElement).style.display).toBe(
      'none'
    );
  });

  it('handles ArrowLeft to close an open submenu and restore parent focus', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    ctrl.showContextMenu(5, 5, {
      path: '/tmp/a.txt',
      name: 'a.txt',
      isDirectory: false,
    } as FileItem);

    const contextMenu = document.getElementById('context-menu') as HTMLElement;
    const topLevelItems = Array.from(contextMenu.querySelectorAll('.context-menu-item')).filter(
      (el) => {
        const html = el as HTMLElement;
        return (
          !html.parentElement?.classList.contains('context-submenu') &&
          html.style.display !== 'none' &&
          html.offsetParent !== null
        );
      }
    );
    const submenuIdx = topLevelItems.findIndex((el) => (el as HTMLElement).id === 'compress-item');
    for (let i = 0; i < submenuIdx; i++) {
      ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    }

    ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    const submenu = contextMenu.querySelector('#compress-item .context-submenu') as HTMLElement;
    expect(submenu.style.display).toBe('block');

    const handled = ctrl.handleKeyboardNavigation(
      new KeyboardEvent('keydown', { key: 'ArrowLeft' })
    );
    expect(handled).toBe(true);
    expect(submenu.style.display).toBe('');
    expect(
      (document.getElementById('compress-item') as HTMLElement).classList.contains('focused')
    ).toBe(true);
  });

  it('navigates and activates submenu items with ArrowDown/ArrowUp/Enter', () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    ctrl.showContextMenu(5, 5, {
      path: '/tmp/a.txt',
      name: 'a.txt',
      isDirectory: false,
    } as FileItem);

    const contextMenu = document.getElementById('context-menu') as HTMLElement;
    const topLevelItems = Array.from(contextMenu.querySelectorAll('.context-menu-item')).filter(
      (el) => {
        const html = el as HTMLElement;
        return (
          !html.parentElement?.classList.contains('context-submenu') &&
          html.style.display !== 'none' &&
          html.offsetParent !== null
        );
      }
    );
    const submenuIdx = topLevelItems.findIndex((el) => (el as HTMLElement).id === 'compress-item');
    for (let i = 0; i < submenuIdx; i++) {
      ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    }

    ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'ArrowRight' }));

    const firstSubItem = document.getElementById('compress-zip-item') as HTMLElement;
    const subClickSpy = vi.fn();
    firstSubItem.addEventListener('click', subClickSpy);

    expect(ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(
      true
    );
    expect(ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'ArrowUp' }))).toBe(
      true
    );
    expect(ctrl.handleKeyboardNavigation(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(
      true
    );
    expect(subClickSpy).toHaveBeenCalledTimes(1);
  });

  it('handles empty menus without visible items', () => {
    document.getElementById('empty-space-context-menu')!.innerHTML = '';

    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    ctrl.showEmptySpaceContextMenu(10, 10);

    const handled = ctrl.handleKeyboardNavigation(
      new KeyboardEvent('keydown', { key: 'ArrowDown' })
    );
    expect(handled).toBe(true);
    expect(document.querySelector('#empty-space-context-menu .focused')).toBeNull();
  });

  it('returns early when context menu containers are missing', () => {
    document.body.innerHTML = '';
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);

    expect(() => {
      ctrl.showContextMenu(10, 10, {
        path: '/x.txt',
        name: 'x.txt',
        isDirectory: false,
      } as FileItem);
      ctrl.showEmptySpaceContextMenu(10, 10);
    }).not.toThrow();
  });

  it('repositions the menu when it would overflow the viewport', () => {
    const prevWidth = window.innerWidth;
    const prevHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 120 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 120 });

    const contextMenu = document.getElementById('context-menu') as HTMLElement;
    contextMenu.getBoundingClientRect = vi.fn(() => ({
      width: 200,
      height: 150,
      top: 0,
      left: 0,
      right: 200,
      bottom: 150,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));

    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    ctrl.showContextMenu(115, 115, {
      path: '/x.txt',
      name: 'x.txt',
      isDirectory: false,
    } as FileItem);

    expect(contextMenu.style.left).toBe('10px');
    expect(contextMenu.style.top).toBe('-40px');

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: prevWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: prevHeight });
  });
});

describe('setupOpenWithSubmenu branches', () => {
  beforeEach(() => {
    buildMenus();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: vi.fn(),
      configurable: true,
    });
    Object.defineProperty(window, 'tauriAPI', {
      value: {
        openTerminal: vi.fn().mockResolvedValue({ success: true }),
        getItemProperties: vi.fn().mockResolvedValue({ success: true, properties: {} }),
        getOpenWithApps: vi.fn().mockResolvedValue({
          success: true,
          apps: [{ id: 'app.id', name: 'OpenWith App' }],
        }),
        openFileWithApp: vi.fn().mockResolvedValue({ success: true }),
      },
      configurable: true,
      writable: true,
    });
  });

  it('loads apps on hover once and aborts previous listeners on re-setup', async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    const file = { path: '/tmp/a.txt', name: 'a.txt', isDirectory: false } as FileItem;

    ctrl.showContextMenu(10, 10, file);
    ctrl.showContextMenu(12, 12, file);
    expect(abortSpy).toHaveBeenCalled();

    const openWith = document.getElementById('open-with-submenu') as HTMLElement;
    openWith.dispatchEvent(new Event('mouseenter'));
    openWith.dispatchEvent(new Event('focus'));

    await vi.waitFor(() => {
      const panel = document.getElementById('open-with-apps-panel') as HTMLElement;
      expect(panel.querySelectorAll('button.context-menu-item').length).toBe(1);
    });

    expect(window.tauriAPI.getOpenWithApps).toHaveBeenCalledTimes(1);
    abortSpy.mockRestore();
  });

  it('shows "No apps found" when no apps are returned', async () => {
    (window.tauriAPI as unknown as { getOpenWithApps: ReturnType<typeof vi.fn> }).getOpenWithApps =
      vi.fn().mockResolvedValue({ success: true, apps: [] });

    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    ctrl.showContextMenu(10, 10, {
      path: '/tmp/a.txt',
      name: 'a.txt',
      isDirectory: false,
    } as FileItem);

    (document.getElementById('open-with-submenu') as HTMLElement).dispatchEvent(
      new Event('mouseenter')
    );
    await vi.waitFor(() => {
      expect(
        (document.getElementById('open-with-apps-panel') as HTMLElement).textContent
      ).toContain('No apps found');
    });
  });

  it('shows "Failed to load apps" when loading apps throws', async () => {
    (window.tauriAPI as unknown as { getOpenWithApps: ReturnType<typeof vi.fn> }).getOpenWithApps =
      vi.fn().mockRejectedValue(new Error('load failure'));

    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    ctrl.showContextMenu(10, 10, {
      path: '/tmp/a.txt',
      name: 'a.txt',
      isDirectory: false,
    } as FileItem);

    (document.getElementById('open-with-submenu') as HTMLElement).dispatchEvent(
      new Event('mouseenter')
    );
    await vi.waitFor(() => {
      expect(
        (document.getElementById('open-with-apps-panel') as HTMLElement).textContent
      ).toContain('Failed to load apps');
    });
  });

  it('shows an error toast when opening with app fails or throws', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    ctrl.showContextMenu(10, 10, {
      path: '/tmp/a.txt',
      name: 'a.txt',
      isDirectory: false,
    } as FileItem);

    (document.getElementById('open-with-submenu') as HTMLElement).dispatchEvent(
      new Event('mouseenter')
    );
    await vi.waitFor(() => {
      expect(document.querySelector('#open-with-apps-panel button')).toBeTruthy();
    });

    const appButton = document.querySelector('#open-with-apps-panel button') as HTMLButtonElement;

    (window.tauriAPI as unknown as { openFileWithApp: ReturnType<typeof vi.fn> }).openFileWithApp =
      vi.fn().mockResolvedValue({ success: false, error: 'cannot open' });
    appButton.click();
    await vi.waitFor(() => {
      expect(deps.showToast).toHaveBeenCalledWith('cannot open', 'Error', 'error');
    });

    (window.tauriAPI as unknown as { openFileWithApp: ReturnType<typeof vi.fn> }).openFileWithApp =
      vi.fn().mockRejectedValue(new Error('boom'));
    appButton.click();
    await vi.waitFor(() => {
      expect(deps.showToast).toHaveBeenCalledWith(
        'Failed to open file with selected app',
        'Error',
        'error'
      );
    });
  });

  it('returns early when open-with panel is missing', () => {
    const panel = document.getElementById('open-with-apps-panel');
    panel?.remove();

    const deps = createDeps();
    const ctrl = createContextMenuController(deps as any);
    expect(() => {
      ctrl.showContextMenu(10, 10, {
        path: '/tmp/a.txt',
        name: 'a.txt',
        isDirectory: false,
      } as FileItem);
    }).not.toThrow();
  });
});
