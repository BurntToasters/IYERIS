import type { FileItem } from './types';
import type { DialogType } from './rendererModals.js';
import { isPermissionDeniedError } from './rendererClipboard.js';

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
  showConfirm: (message: string, title: string, type: 'warning') => Promise<boolean>;
  isHomeViewPath: (path: string) => boolean;
  announceToScreenReader?: (message: string) => void;
};

const INVALID_FILENAME_CHARS = /[<>:"|?*]/;
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i;
const BIDI_CONTROL_CHARS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const MAX_FILENAME_LENGTH = 255;

function hasControlChars(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) < 32) return true;
  }
  return false;
}

function getFilenameError(name: string): string | null {
  if (name === '.' || name === '..') {
    return 'File name cannot be . or ..';
  }
  if (INVALID_FILENAME_CHARS.test(name) || hasControlChars(name)) {
    return 'File name cannot contain < > : " | ? *';
  }
  if (BIDI_CONTROL_CHARS.test(name)) {
    return 'File name cannot contain bidirectional control characters';
  }
  if (name.length > MAX_FILENAME_LENGTH) {
    return 'File name is too long (max 255 characters)';
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
  let pendingRenameTimeout: ReturnType<typeof setTimeout> | null = null;

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
    const stem = type === 'file' ? 'File' : 'New Folder';
    const ext = type === 'file' ? '.txt' : '';
    let finalName = `${stem}${ext}`;
    let counter = 1;
    const existingNames = new Set(deps.getAllFiles().map((f) => f.name));
    while (existingNames.has(finalName)) {
      finalName = `${stem} (${counter++})${ext}`;
    }

    const result =
      type === 'file'
        ? await window.tauriAPI.createFile(currentPath, finalName)
        : await window.tauriAPI.createFolder(currentPath, finalName);

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
    if (pendingRenameTimeout) clearTimeout(pendingRenameTimeout);
    pendingRenameTimeout = setTimeout(() => {
      pendingRenameTimeout = null;
      if (typeof document === 'undefined') return;
      if (deps.getCurrentPath() !== currentPath) return;
      const fileItems = document.querySelectorAll('.file-item');
      for (const item of Array.from(fileItems)) {
        if (item.getAttribute('data-path') === createdPath) {
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
    input.setAttribute('aria-label', 'Rename file');
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
    let renameInProgress = false;
    let errorTooltip: HTMLElement | null = null;

    const showInlineError = (message: string) => {
      clearInlineError();
      input.classList.add('input-error');
      input.setAttribute('aria-invalid', 'true');
      errorTooltip = document.createElement('div');
      errorTooltip.className = 'rename-error-tooltip';
      errorTooltip.id = 'rename-error-msg';
      errorTooltip.textContent = message;
      input.setAttribute('aria-describedby', 'rename-error-msg');
      inputParent.appendChild(errorTooltip);
    };

    const clearInlineError = () => {
      input.classList.remove('input-error');
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
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
      if (renameHandled || renameInProgress) {
        return;
      }
      renameInProgress = true;

      const newName = input.value.trim();

      if (newName && newName !== currentName) {
        const filenameError = getFilenameError(newName);
        if (filenameError) {
          renameInProgress = false;
          showInlineError(filenameError);
          input.focus();
          return;
        }
        try {
          const result = await window.tauriAPI.renameItem(itemPath, newName);
          if (!result.success) {
            if (isPermissionDeniedError(result.error)) {
              const confirmed = await deps.showConfirm(
                'Renaming this item requires administrator privileges. You will be prompted to authorize.',
                'Elevated Permissions Required',
                'warning'
              );
              if (confirmed) {
                const elevResult = await window.tauriAPI.elevatedRename(itemPath, newName);
                if (!elevResult.success) {
                  showInlineError(elevResult.error || 'Elevated rename failed');
                  input.focus();
                  return;
                }
              } else {
                showInlineError('Operation cancelled');
                input.focus();
                return;
              }
            } else {
              showInlineError(result.error || 'Rename failed');
              input.focus();
              return;
            }
          }
        } catch {
          showInlineError('Rename failed');
          input.focus();
          return;
        } finally {
          renameInProgress = false;
        }
        renameHandled = true;
        cleanup();
        nameElement.textContent = newName;
        deps.announceToScreenReader?.(`Renamed to ${newName}`);
        await deps.navigateTo(deps.getCurrentPath());
      } else {
        renameHandled = true;
        cleanup();
      }
    };

    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        void finishRename();
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
