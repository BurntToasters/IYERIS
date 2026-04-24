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
    showConfirm: vi.fn(async () => true),
    isHomeViewPath: vi.fn((p: string) => p === 'iyeris://home'),
  };
}

function createRenameFileItem(name: string) {
  const fileItem = document.createElement('div');
  const textContainer = document.createElement('div');
  textContainer.className = 'file-text';
  const nameEl = document.createElement('span');
  nameEl.className = 'file-name';
  nameEl.textContent = name;
  textContainer.appendChild(nameEl);
  fileItem.appendChild(textContainer);
  document.body.appendChild(fileItem);
  return { fileItem, nameEl };
}

describe('createNewItemWithInlineRename', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="file-grid"></div>';
    (window as unknown as Record<string, unknown>).tauriAPI = {
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

    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(api.createFile).toHaveBeenCalledWith('/workspace', 'File.txt');
    expect(deps.navigateTo).toHaveBeenCalledWith('/workspace');
  });

  it('creates a folder', async () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewItemWithInlineRename('folder');

    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
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
        name: 'File (1).txt',
        path: '/workspace/File (1).txt',
        isFile: true,
        isDirectory: false,
        size: 0,
        modified: 0,
      },
    ]);

    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.createFile.mockResolvedValue({ success: true, path: '/workspace/File (2).txt' });

    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewItemWithInlineRename('file');

    expect(api.createFile).toHaveBeenCalledWith('/workspace', 'File (2).txt');
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

    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.createFolder.mockResolvedValue({ success: true, path: '/workspace/New Folder (1)' });

    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewItemWithInlineRename('folder');

    expect(api.createFolder).toHaveBeenCalledWith('/workspace', 'New Folder (1)');
  });

  it('shows alert on API failure', async () => {
    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
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
    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.createFile.mockResolvedValue({ success: false });

    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewItemWithInlineRename('file');

    expect(deps.showAlert).toHaveBeenCalledWith('Operation failed', 'Error Creating File', 'error');
  });

  it('starts inline rename after create when created item is present', async () => {
    const deps = createDeps();
    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.createFile.mockResolvedValue({ success: true, path: '/workspace/File.txt' });

    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    fileItem.setAttribute('data-path', '/workspace/File.txt');
    const textContainer = document.createElement('div');
    textContainer.className = 'file-text';
    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = 'File.txt';
    textContainer.appendChild(nameEl);
    fileItem.appendChild(textContainer);
    document.body.appendChild(fileItem);

    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewItemWithInlineRename('file');
    await vi.advanceTimersByTimeAsync(120);

    expect(fileItem.classList.contains('renaming')).toBe(true);
    expect(fileItem.querySelector('.file-name-input')).not.toBeNull();
  });

  it('does not start inline rename when path changes before timer fires', async () => {
    let currentPath = '/workspace';
    const deps = createDeps();
    deps.getCurrentPath = vi.fn(() => currentPath);
    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.createFile.mockResolvedValue({ success: true, path: '/workspace/File.txt' });

    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    fileItem.setAttribute('data-path', '/workspace/File.txt');
    const textContainer = document.createElement('div');
    textContainer.className = 'file-text';
    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = 'File.txt';
    textContainer.appendChild(nameEl);
    fileItem.appendChild(textContainer);
    document.body.appendChild(fileItem);

    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewItemWithInlineRename('file');
    currentPath = '/workspace/other';
    await vi.advanceTimersByTimeAsync(120);

    expect(fileItem.classList.contains('renaming')).toBe(false);
    expect(fileItem.querySelector('.file-name-input')).toBeNull();
  });

  it('clears pending inline-rename timer when creating another item', async () => {
    const deps = createDeps();
    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.createFile
      .mockResolvedValueOnce({ success: true, path: '/workspace/File.txt' })
      .mockResolvedValueOnce({ success: true, path: '/workspace/File (1).txt' });

    const firstItem = document.createElement('div');
    firstItem.className = 'file-item';
    firstItem.setAttribute('data-path', '/workspace/File.txt');
    const firstText = document.createElement('div');
    firstText.className = 'file-text';
    const firstName = document.createElement('span');
    firstName.className = 'file-name';
    firstName.textContent = 'File.txt';
    firstText.appendChild(firstName);
    firstItem.appendChild(firstText);
    document.body.appendChild(firstItem);

    const secondItem = document.createElement('div');
    secondItem.className = 'file-item';
    secondItem.setAttribute('data-path', '/workspace/File (1).txt');
    const secondText = document.createElement('div');
    secondText.className = 'file-text';
    const secondName = document.createElement('span');
    secondName.className = 'file-name';
    secondName.textContent = 'File (1).txt';
    secondText.appendChild(secondName);
    secondItem.appendChild(secondText);
    document.body.appendChild(secondItem);

    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewItemWithInlineRename('file');
    await ctrl.createNewItemWithInlineRename('file');
    await vi.advanceTimersByTimeAsync(120);

    expect(firstItem.classList.contains('renaming')).toBe(false);
    expect(secondItem.classList.contains('renaming')).toBe(true);
  });
});

describe('createNewFile / createNewFolder convenience wrappers', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (window as unknown as Record<string, unknown>).tauriAPI = {
      createFile: vi.fn(async () => ({ success: true, path: '/workspace/File' })),
      createFolder: vi.fn(async () => ({ success: true, path: '/workspace/New Folder' })),
      renameItem: vi.fn(async () => ({ success: true })),
    };
  });

  it('createNewFile delegates to createNewItemWithInlineRename', async () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewFile();
    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(api.createFile).toHaveBeenCalled();
  });

  it('createNewFolder delegates to createNewItemWithInlineRename', async () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewFolder();
    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(api.createFolder).toHaveBeenCalled();
  });

  it('createNewFileWithInlineRename delegates to createNewItemWithInlineRename', async () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewFileWithInlineRename();
    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(api.createFile).toHaveBeenCalled();
  });

  it('createNewFolderWithInlineRename delegates to createNewItemWithInlineRename', async () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    await ctrl.createNewFolderWithInlineRename();
    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(api.createFolder).toHaveBeenCalled();
  });
});

describe('startInlineRename', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (window as unknown as Record<string, unknown>).tauriAPI = {
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

    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
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

    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(api.renameItem).not.toHaveBeenCalled();
  });

  it('shows alert on rename failure', async () => {
    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
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

  it('calls renameItem on blur with changed name', async () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    const { fileItem } = createRenameFileItem('old.txt');

    ctrl.startInlineRename(fileItem, 'old.txt', '/workspace/old.txt');

    const input = fileItem.querySelector('.file-name-input') as HTMLInputElement;
    input.value = 'blurred.txt';
    input.dispatchEvent(new Event('blur', { bubbles: true }));

    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    await vi.waitFor(() => {
      expect(api.renameItem).toHaveBeenCalledWith('/workspace/old.txt', 'blurred.txt');
    });
  });

  it('shows and clears inline validation error as input changes', () => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    const { fileItem } = createRenameFileItem('old.txt');

    ctrl.startInlineRename(fileItem, 'old.txt', '/workspace/old.txt');

    const input = fileItem.querySelector('.file-name-input') as HTMLInputElement;
    input.value = 'bad<name.txt';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('input-error')).toBe(true);
    expect(fileItem.querySelector('.rename-error-tooltip')?.textContent).toBe(
      'File name cannot contain < > : " | ? *'
    );

    input.value = 'good-name.txt';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('input-error')).toBe(false);
    expect(fileItem.querySelector('.rename-error-tooltip')).toBeNull();
  });

  it.each([
    ['.', 'File name cannot be . or ..'],
    ['CON', 'That name is reserved by the system'],
    [`bad${String.fromCharCode(1)}name`, 'File name cannot contain < > : " | ? *'],
    [`abc\u202Edef.txt`, 'File name cannot contain bidirectional control characters'],
    ['a'.repeat(256), 'File name is too long (max 255 characters)'],
    ['trailing.', 'File name cannot end with a period or space'],
  ])('rejects invalid filename %s', async (candidateName, expectedError) => {
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    const { fileItem } = createRenameFileItem('old.txt');

    ctrl.startInlineRename(fileItem, 'old.txt', '/workspace/old.txt');

    const input = fileItem.querySelector('.file-name-input') as HTMLInputElement;
    input.value = candidateName;
    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(fileItem.querySelector('.rename-error-tooltip')?.textContent).toBe(expectedError);
    });

    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(api.renameItem).not.toHaveBeenCalled();
  });

  it('uses fallback rename failed message when API error is missing', async () => {
    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.renameItem.mockResolvedValue({ success: false });

    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    const { fileItem } = createRenameFileItem('old.txt');
    ctrl.startInlineRename(fileItem, 'old.txt', '/workspace/old.txt');

    const input = fileItem.querySelector('.file-name-input') as HTMLInputElement;
    input.value = 'new.txt';
    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(fileItem.querySelector('.rename-error-tooltip')?.textContent).toBe('Rename failed');
    });
  });

  it('shows operation cancelled when elevation is declined', async () => {
    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.renameItem.mockResolvedValue({ success: false, error: 'permission denied' });
    api.elevatedRename = vi.fn();

    const deps = createDeps();
    deps.showConfirm = vi.fn(async () => false);
    const ctrl = createInlineRenameController(deps as any);
    const { fileItem } = createRenameFileItem('old.txt');
    ctrl.startInlineRename(fileItem, 'old.txt', '/workspace/old.txt');

    const input = fileItem.querySelector('.file-name-input') as HTMLInputElement;
    input.value = 'new.txt';
    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(fileItem.querySelector('.rename-error-tooltip')?.textContent).toBe(
        'Operation cancelled'
      );
    });
    expect(api.elevatedRename).not.toHaveBeenCalled();
  });

  it('shows fallback elevated rename error when elevated rename fails', async () => {
    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.renameItem.mockResolvedValue({ success: false, error: 'permission denied' });
    api.elevatedRename = vi.fn(async () => ({ success: false }));

    const deps = createDeps();
    deps.showConfirm = vi.fn(async () => true);
    const ctrl = createInlineRenameController(deps as any);
    const { fileItem } = createRenameFileItem('old.txt');
    ctrl.startInlineRename(fileItem, 'old.txt', '/workspace/old.txt');

    const input = fileItem.querySelector('.file-name-input') as HTMLInputElement;
    input.value = 'new.txt';
    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(fileItem.querySelector('.rename-error-tooltip')?.textContent).toBe(
        'Elevated rename failed'
      );
    });
    expect(api.elevatedRename).toHaveBeenCalledWith('/workspace/old.txt', 'new.txt');
  });

  it('renames successfully through elevated flow and announces for screen readers', async () => {
    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.renameItem.mockResolvedValue({ success: false, error: 'permission denied' });
    api.elevatedRename = vi.fn(async () => ({ success: true }));

    const deps = createDeps();
    deps.showConfirm = vi.fn(async () => true);
    const announceToScreenReader = vi.fn();
    const ctrl = createInlineRenameController({
      ...deps,
      announceToScreenReader,
    } as any);
    const { fileItem, nameEl } = createRenameFileItem('old.txt');
    ctrl.startInlineRename(fileItem, 'old.txt', '/workspace/old.txt');

    const input = fileItem.querySelector('.file-name-input') as HTMLInputElement;
    input.value = 'elevated.txt';
    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(fileItem.classList.contains('renaming')).toBe(false);
    });
    expect(nameEl.textContent).toBe('elevated.txt');
    expect(announceToScreenReader).toHaveBeenCalledWith('Renamed to elevated.txt');
    expect(deps.navigateTo).toHaveBeenCalledWith('/workspace');
  });

  it('shows rename failed when rename API throws', async () => {
    const api = window.tauriAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.renameItem.mockRejectedValue(new Error('boom'));

    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    const { fileItem } = createRenameFileItem('old.txt');
    ctrl.startInlineRename(fileItem, 'old.txt', '/workspace/old.txt');

    const input = fileItem.querySelector('.file-name-input') as HTMLInputElement;
    input.value = 'new.txt';
    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(fileItem.querySelector('.rename-error-tooltip')?.textContent).toBe('Rename failed');
    });
  });

  it('selects filename stem before extension on setup', () => {
    const setSelectionRangeSpy = vi
      .spyOn(HTMLInputElement.prototype, 'setSelectionRange')
      .mockImplementation(() => {});
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    const { fileItem } = createRenameFileItem('photo.png');

    ctrl.startInlineRename(fileItem, 'photo.png', '/workspace/photo.png');

    expect(setSelectionRangeSpy).toHaveBeenCalledWith(0, 5);
    setSelectionRangeSpy.mockRestore();
  });

  it('selects whole filename when no extension is present', () => {
    const selectSpy = vi.spyOn(HTMLInputElement.prototype, 'select').mockImplementation(() => {});
    const deps = createDeps();
    const ctrl = createInlineRenameController(deps as any);
    const { fileItem } = createRenameFileItem('README');

    ctrl.startInlineRename(fileItem, 'README', '/workspace/README');

    expect(selectSpy).toHaveBeenCalled();
    selectSpy.mockRestore();
  });
});
