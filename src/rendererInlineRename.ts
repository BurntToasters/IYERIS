import type { FileItem } from './types';

type DialogType = 'info' | 'warning' | 'error' | 'success' | 'question';

type InlineRenameDeps = {
  getCurrentPath: () => string;
  getAllFiles: () => FileItem[];
  navigateTo: (path: string) => Promise<void>;
  showToast: (
    message: string,
    title: string,
    type: 'success' | 'error' | 'info' | 'warning'
  ) => void;
  showAlert: (message: string, title: string, type: DialogType) => Promise<void>;
  isHomeViewPath: (path: string) => boolean;
};

const INVALID_FILENAME_CHARS = /[<>:"|?*]/;
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i;

function hasControlChars(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) < 32) return true;
  }
  return false;
}

function getFilenameError(name: string): string | null {
  if (INVALID_FILENAME_CHARS.test(name) || hasControlChars(name)) {
    return 'File name cannot contain < > : " | ? *';
  }
  if (name.endsWith('.') || name.endsWith(' ')) {
    return 'File name cannot end with a period or space';
  }
  if (RESERVED_NAMES.test(name)) {
    return 'That name is reserved by the system';
  }
  return null;
}

export function createInlineRenameController(deps: InlineRenameDeps) {
  async function createNewFile() {
    await createNewFileWithInlineRename();
  }

  async function createNewFolder() {
    await createNewFolderWithInlineRename();
  }

  async function createNewItemWithInlineRename(type: 'file' | 'folder') {
    const currentPath = deps.getCurrentPath();
    if (!currentPath || deps.isHomeViewPath(currentPath)) {
      deps.showToast(`Open a folder to create a ${type}`, 'Create', 'info');
      return;
    }
    const baseName = type === 'file' ? 'File.txt' : 'New Folder';
    let finalName = baseName;
    let counter = 1;
    const existingNames = new Set(deps.getAllFiles().map((f) => f.name));
    while (existingNames.has(finalName)) {
      finalName = `${baseName} (${counter++})`;
    }

    const result =
      type === 'file'
        ? await window.electronAPI.createFile(currentPath, finalName)
        : await window.electronAPI.createFolder(currentPath, finalName);

    if (!result.success) {
      await deps.showAlert(
        result.error || 'Operation failed',
        `Error Creating ${type === 'file' ? 'File' : 'Folder'}`,
        'error'
      );
      return;
    }

    const createdPath = result.path;
    await deps.navigateTo(currentPath);
    setTimeout(() => {
      if (typeof document === 'undefined') return;
      const fileItems = document.querySelectorAll('.file-item');
      for (const item of Array.from(fileItems)) {
        const nameEl = item.querySelector('.file-name');
        if (nameEl?.textContent === finalName) {
          startInlineRename(item as HTMLElement, finalName, createdPath);
          break;
        }
      }
    }, 100);
  }

  async function createNewFileWithInlineRename() {
    return createNewItemWithInlineRename('file');
  }

  async function createNewFolderWithInlineRename() {
    return createNewItemWithInlineRename('folder');
  }

  function startInlineRename(fileItem: HTMLElement, currentName: string, itemPath: string) {
    const nameElement = fileItem.querySelector('.file-name') as HTMLElement | null;
    if (!nameElement) return;

    if (fileItem.classList.contains('renaming')) return;

    nameElement.style.display = 'none';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'file-name-input';
    input.value = currentName;
    const nameContainer = fileItem.querySelector('.file-text') as HTMLElement | null;
    const inputParent = nameContainer || fileItem;
    inputParent.style.position = 'relative';
    inputParent.appendChild(input);

    fileItem.classList.add('renaming');

    input.focus();

    const lastDotIndex = currentName.lastIndexOf('.');
    if (lastDotIndex > 0) {
      input.setSelectionRange(0, lastDotIndex);
    } else {
      input.select();
    }

    let renameHandled = false;
    let errorTooltip: HTMLElement | null = null;

    const showInlineError = (message: string) => {
      clearInlineError();
      input.classList.add('input-error');
      errorTooltip = document.createElement('div');
      errorTooltip.className = 'rename-error-tooltip';
      errorTooltip.textContent = message;
      inputParent.appendChild(errorTooltip);
    };

    const clearInlineError = () => {
      input.classList.remove('input-error');
      if (errorTooltip) {
        errorTooltip.remove();
        errorTooltip = null;
      }
    };

    const cleanup = () => {
      clearInlineError();
      input.removeEventListener('blur', finishRename);
      input.removeEventListener('keypress', handleKeyPress);
      input.removeEventListener('keydown', handleKeyDown);
      input.removeEventListener('input', handleInput);
      nameElement.style.display = '';
      input.remove();
      fileItem.classList.remove('renaming');
    };

    const handleInput = () => {
      const name = input.value.trim();
      if (name) {
        const error = getFilenameError(name);
        if (error) {
          showInlineError(error);
        } else {
          clearInlineError();
        }
      } else {
        clearInlineError();
      }
    };

    const finishRename = async () => {
      if (renameHandled) {
        return;
      }
      renameHandled = true;

      const newName = input.value.trim();

      if (newName && newName !== currentName) {
        const filenameError = getFilenameError(newName);
        if (filenameError) {
          renameHandled = false;
          showInlineError(filenameError);
          input.focus();
          return;
        }
        const result = await window.electronAPI.renameItem(itemPath, newName);
        if (!result.success) {
          renameHandled = false;
          showInlineError(result.error || 'Rename failed');
          input.focus();
          return;
        }
        cleanup();
        nameElement.textContent = newName;
        await deps.navigateTo(deps.getCurrentPath());
      } else {
        cleanup();
      }
    };

    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        finishRename();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        renameHandled = true;
        cleanup();
      }
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keypress', handleKeyPress);
    input.addEventListener('keydown', handleKeyDown);
    input.addEventListener('input', handleInput);
  }

  return {
    createNewFile,
    createNewFolder,
    createNewItemWithInlineRename,
    createNewFileWithInlineRename,
    createNewFolderWithInlineRename,
    startInlineRename,
  };
}
