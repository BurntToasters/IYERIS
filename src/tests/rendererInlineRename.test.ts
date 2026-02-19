// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInlineRenameController } from '../rendererInlineRename';

function createDeps() {
  return {
    getCurrentPath: vi.fn(() => '/workspace'),
    getAllFiles: vi.fn(() => [
      {
        name: 'existing.txt',
        path: '/workspace/existing.txt',
        isFile: true,
        isDirectory: false,
        size: 100,
        modified: Date.now(),
      },
    ]),
    navigateTo: vi.fn(async () => {}),
    showToast: vi.fn(),
    showAlert: vi.fn(async () => {}),
    isHomeViewPath: vi.fn((p: string) => p === 'iyeris://home'),
  };
}

describe('createNewItemWithInlineRename', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="file-grid"></div>';
    (window as unknown as Record<string, unknown>).electronAPI = {
      createFile: vi.fn(async () => ({ success: true, path: '/workspace/File' })),
      createFolder: vi.fn(async () => ({ success: true, path: '/workspace/New Folder' })),
      renameItem: vi.fn(async () => ({ success: true })),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a file', async () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewItemWithInlineRename('file');

    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(api.createFile).toHaveBeenCalledWith('/workspace', 'File.txt');
    expect(deps.navigateTo).toHaveBeenCalledWith('/workspace');
  });

  it('creates a folder', async () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewItemWithInlineRename('folder');

    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(api.createFolder).toHaveBeenCalledWith('/workspace', 'New Folder');
    expect(deps.navigateTo).toHaveBeenCalledWith('/workspace');
  });

  it('shows toast when on home view', async () => {
    const deps = createDeps();
    deps.getCurrentPath = vi.fn(() => 'iyeris://home');
    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewItemWithInlineRename('file');
    expect(deps.showToast).toHaveBeenCalledWith('Open a folder to create a file', 'Create', 'info');
  });

  it('shows toast when no current path', async () => {
    const deps = createDeps();
    deps.getCurrentPath = vi.fn(() => '');
    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewItemWithInlineRename('folder');
    expect(deps.showToast).toHaveBeenCalledWith(
      'Open a folder to create a folder',
      'Create',
      'info'
    );
  });

  it('avoids name collision with existing files', async () => {
    const deps = createDeps();
    deps.getAllFiles = vi.fn(() => [
      {
        name: 'File.txt',
        path: '/workspace/File.txt',
        isFile: true,
        isDirectory: false,
        size: 0,
        modified: 0,
      },
      {
        name: 'File.txt (1)',
        path: '/workspace/File.txt (1)',
        isFile: true,
        isDirectory: false,
        size: 0,
        modified: 0,
      },
    ]);

    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.createFile.mockResolvedValue({ success: true, path: '/workspace/File.txt (2)' });

    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewItemWithInlineRename('file');

    expect(api.createFile).toHaveBeenCalledWith('/workspace', 'File.txt (2)');
  });

  it('avoids name collision for folders', async () => {
    const deps = createDeps();
    deps.getAllFiles = vi.fn(() => [
      {
        name: 'New Folder',
        path: '/workspace/New Folder',
        isFile: false,
        isDirectory: true,
        size: 0,
        modified: 0,
      },
    ]);

    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.createFolder.mockResolvedValue({ success: true, path: '/workspace/New Folder (1)' });

    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewItemWithInlineRename('folder');

    expect(api.createFolder).toHaveBeenCalledWith('/workspace', 'New Folder (1)');
  });

  it('shows alert on API failure', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.createFile.mockResolvedValue({ success: false, error: 'Permission denied' });

    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewItemWithInlineRename('file');

    expect(deps.showAlert).toHaveBeenCalledWith(
      'Permission denied',
      'Error Creating File',
      'error'
    );
  });

  it('shows unknown error when no error message', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.createFile.mockResolvedValue({ success: false });

    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewItemWithInlineRename('file');

    expect(deps.showAlert).toHaveBeenCalledWith('Operation failed', 'Error Creating File', 'error');
  });
});

describe('createNewFile / createNewFolder convenience wrappers', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (window as unknown as Record<string, unknown>).electronAPI = {
      createFile: vi.fn(async () => ({ success: true, path: '/workspace/File' })),
      createFolder: vi.fn(async () => ({ success: true, path: '/workspace/New Folder' })),
      renameItem: vi.fn(async () => ({ success: true })),
    };
  });

  it('createNewFile delegates to createNewItemWithInlineRename', async () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewFile();
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(api.createFile).toHaveBeenCalled();
  });

  it('createNewFolder delegates to createNewItemWithInlineRename', async () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewFolder();
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(api.createFolder).toHaveBeenCalled();
  });
});

describe('startInlineRename', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (window as unknown as Record<string, unknown>).electronAPI = {
      renameItem: vi.fn(async () => ({ success: true })),
    };
  });

  it('sets up input with file name', () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);

    const fileItem = document.createElement('div');
    const textContainer = document.createElement('div');
    textContainer.className = 'file-text';
    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = 'readme.md';
    textContainer.appendChild(nameEl);
    fileItem.appendChild(textContainer);
    document.body.appendChild(fileItem);

    ctrl.startInlineRename(fileItem, 'readme.md', '/workspace/readme.md');

    expect(fileItem.classList.contains('renaming')).toBe(true);
    const input = fileItem.querySelector('.file-name-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('readme.md');
  });

  it('does nothing when already renaming', () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);

    const fileItem = document.createElement('div');
    fileItem.classList.add('renaming');
    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    fileItem.appendChild(nameEl);

    ctrl.startInlineRename(fileItem, 'test.txt', '/workspace/test.txt');
    expect(fileItem.querySelector('.file-name-input')).toBeNull();
  });

  it('does nothing when no name element', () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    const fileItem = document.createElement('div');
    expect(() => ctrl.startInlineRename(fileItem, 'test.txt', '/path')).not.toThrow();
  });

  it('restores original name on Escape', () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);

    const fileItem = document.createElement('div');
    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = 'original.txt';
    fileItem.appendChild(nameEl);
    document.body.appendChild(fileItem);

    ctrl.startInlineRename(fileItem, 'original.txt', '/workspace/original.txt');

    const input = fileItem.querySelector('.file-name-input') as HTMLInputElement;
    input.value = 'changed.txt';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(fileItem.classList.contains('renaming')).toBe(false);
    expect(nameEl.style.display).toBe('');
    expect(fileItem.querySelector('.file-name-input')).toBeNull();
  });

  it('calls renameItem on Enter with changed name', async () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);

    const fileItem = document.createElement('div');
    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = 'old.txt';
    fileItem.appendChild(nameEl);
    document.body.appendChild(fileItem);

    ctrl.startInlineRename(fileItem, 'old.txt', '/workspace/old.txt');

    const input = fileItem.querySelector('.file-name-input') as HTMLInputElement;
    input.value = 'new.txt';
    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));

    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    await vi.waitFor(() => {
      expect(api.renameItem).toHaveBeenCalledWith('/workspace/old.txt', 'new.txt');
    });
  });

  it('reverts without API call when name unchanged', async () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);

    const fileItem = document.createElement('div');
    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = 'same.txt';
    fileItem.appendChild(nameEl);
    document.body.appendChild(fileItem);

    ctrl.startInlineRename(fileItem, 'same.txt', '/workspace/same.txt');

    const input = fileItem.querySelector('.file-name-input') as HTMLInputElement;

    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(fileItem.classList.contains('renaming')).toBe(false);
    });

    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(api.renameItem).not.toHaveBeenCalled();
  });

  it('shows alert on rename failure', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.renameItem.mockResolvedValue({ success: false, error: 'Item exists' });

    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);

    const fileItem = document.createElement('div');
    const textEl = document.createElement('div');
    textEl.className = 'file-text';
    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = 'old.txt';
    textEl.appendChild(nameEl);
    fileItem.appendChild(textEl);
    document.body.appendChild(fileItem);

    ctrl.startInlineRename(fileItem, 'old.txt', '/workspace/old.txt');

    const input = fileItem.querySelector('.file-name-input') as HTMLInputElement;
    input.value = 'conflict.txt';
    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(input.classList.contains('input-error')).toBe(true);
      const tooltip = fileItem.querySelector('.rename-error-tooltip');
      expect(tooltip).not.toBeNull();
      expect(tooltip!.textContent).toBe('Item exists');
    });
  });
});
