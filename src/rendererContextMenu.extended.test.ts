/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./rendererCompressExtract.js', () => ({
  isArchivePath: (value: string) => value.endsWith('.zip') || value.endsWith('.7z'),
}));

vi.mock('./fileTypes.js', () => ({
  PDF_EXTENSIONS: new Set(['.pdf']),
}));

import { createContextMenuController } from './rendererContextMenu';
import type { FileItem } from './types';

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
  };
}

describe('handleContextMenuAction - all branches', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    Object.defineProperty(window, 'electronAPI', {
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
    expect(window.electronAPI.openTerminal).toHaveBeenCalledWith('/mydir');
  });

  it('handles "open-terminal" for file (uses dirname)', async () => {
    const deps = createDeps();
    const ctrl = createContextMenuController(deps);
    const item = { path: '/dir/file.txt', name: 'file.txt', isDirectory: false } as FileItem;
    await ctrl.handleContextMenuAction('open-terminal', item);
    // path.dirname('/dir/file.txt') = '/dir'
    expect(window.electronAPI.openTerminal).toHaveBeenCalledWith('/dir');
  });

  it('handles "open-terminal" failure', async () => {
    const deps = createDeps();
    (window.electronAPI as unknown as { openTerminal: ReturnType<typeof vi.fn> }).openTerminal = vi
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
      window.electronAPI as unknown as { getItemProperties: ReturnType<typeof vi.fn> }
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
    Object.defineProperty(window, 'electronAPI', {
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
    expect(window.electronAPI.openTerminal).toHaveBeenCalledWith('/workspace');
  });

  it('handles "open-terminal" failure', async () => {
    const deps = createDeps();
    deps.getCurrentPath.mockReturnValue('/workspace');
    (window.electronAPI as unknown as { openTerminal: ReturnType<typeof vi.fn> }).openTerminal = vi
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
});
