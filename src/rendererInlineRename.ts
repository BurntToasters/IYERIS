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
    const baseName = type === 'file' ? 'File' : 'New Folder';
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

    if (result.success && result.path) {
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
    } else {
      await deps.showAlert(
        result.error || 'Unknown error',
        `Error Creating ${type === 'file' ? 'File' : 'Folder'}`,
        'error'
      );
    }
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
    (nameContainer || fileItem).appendChild(input);

    fileItem.classList.add('renaming');

    input.focus();

    const lastDotIndex = currentName.lastIndexOf('.');
    if (lastDotIndex > 0) {
      input.setSelectionRange(0, lastDotIndex);
    } else {
      input.select();
    }

    let renameHandled = false;

    const finishRename = async () => {
      if (renameHandled) {
        return;
      }
      renameHandled = true;

      input.removeEventListener('blur', finishRename);
      input.removeEventListener('keypress', handleKeyPress);
      input.removeEventListener('keydown', handleKeyDown);

      const newName = input.value.trim();

      if (newName && newName !== currentName) {
        const result = await window.electronAPI.renameItem(itemPath, newName);
        if (result.success) {
          nameElement.style.display = '';
          nameElement.textContent = newName;
          input.remove();
          fileItem.classList.remove('renaming');
          await deps.navigateTo(deps.getCurrentPath());
        } else {
          await deps.showAlert(result.error || 'Unknown error', 'Error Renaming', 'error');
          nameElement.style.display = '';
          input.remove();
          fileItem.classList.remove('renaming');
        }
      } else {
        nameElement.style.display = '';
        input.remove();
        fileItem.classList.remove('renaming');
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
        input.removeEventListener('blur', finishRename);
        input.removeEventListener('keypress', handleKeyPress);
        input.removeEventListener('keydown', handleKeyDown);
        nameElement.style.display = '';
        input.remove();
        fileItem.classList.remove('renaming');
      }
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keypress', handleKeyPress);
    input.addEventListener('keydown', handleKeyDown);
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
