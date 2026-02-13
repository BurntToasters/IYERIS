import type { Settings } from './types';

type FolderIconPickerDeps = {
  getCurrentSettings: () => Settings;
  getCurrentPath: () => string;
  navigateTo: (path: string) => Promise<void>;
  showToast: (
    message: string,
    title: string,
    type: 'success' | 'error' | 'info' | 'warning'
  ) => void;
  saveSettings: () => Promise<void>;
  activateModal: (modal: HTMLElement) => void;
  deactivateModal: (modal: HTMLElement) => void;
  twemojiImg: (emoji: string, className: string) => string;
  folderIcon: string;
};

const FOLDER_ICON_OPTIONS = [
  0x1f4c1, 0x1f4c2, 0x1f4c3, 0x1f5c2, 0x1f5c3, 0x1f4bc, 0x2b50, 0x1f31f, 0x2764, 0x1f499, 0x1f49a,
  0x1f49b, 0x1f4a1, 0x1f3ae, 0x1f3b5, 0x1f3ac, 0x1f4f7, 0x1f4f9, 0x1f4da, 0x1f4d6, 0x1f4dd, 0x270f,
  0x1f4bb, 0x1f5a5, 0x1f3e0, 0x1f3e2, 0x1f6e0, 0x2699, 0x1f512, 0x1f513, 0x1f4e6, 0x1f4e5, 0x1f4e4,
  0x1f5d1, 0x2601, 0x1f310, 0x1f680, 0x2708, 0x1f697, 0x1f6b2, 0x26bd, 0x1f3c0, 0x1f352, 0x1f34e,
  0x1f33f, 0x1f333, 0x1f308, 0x2600,
];

export function createFolderIconPickerController(deps: FolderIconPickerDeps) {
  let folderIconPickerPath: string | null = null;

  function showFolderIconPicker(folderPath: string) {
    const modal = document.getElementById('folder-icon-modal');
    const pathDisplay = document.getElementById('folder-icon-path');
    const grid = document.getElementById('folder-icon-grid');

    if (!modal || !pathDisplay || !grid) return;

    folderIconPickerPath = folderPath;

    const folderName = folderPath.split(/[/\\]/).pop() || folderPath;
    pathDisplay.textContent = folderName;

    const currentSettings = deps.getCurrentSettings();
    const currentIcon = currentSettings.folderIcons?.[folderPath];

    grid.innerHTML = FOLDER_ICON_OPTIONS.map((code) => {
      const emoji = String.fromCodePoint(code);
      const isSelected = currentIcon === emoji;
      return `
      <div class="folder-icon-option${isSelected ? ' selected' : ''}" data-icon="${emoji}">
        ${deps.twemojiImg(emoji, 'twemoji')}
      </div>
    `;
    }).join('');

    grid.querySelectorAll('.folder-icon-option').forEach((option) => {
      option.addEventListener('click', () => {
        const icon = (option as HTMLElement).dataset.icon;
        if (icon && folderIconPickerPath) {
          setFolderIcon(folderIconPickerPath, icon);
          hideFolderIconPicker();
        }
      });
    });

    modal.style.display = 'flex';
    deps.activateModal(modal);
  }

  function hideFolderIconPicker() {
    const modal = document.getElementById('folder-icon-modal');
    if (modal) {
      modal.style.display = 'none';
      deps.deactivateModal(modal);
    }
    folderIconPickerPath = null;
  }

  async function setFolderIcon(folderPath: string, icon: string) {
    const currentSettings = deps.getCurrentSettings();
    if (!currentSettings.folderIcons) {
      currentSettings.folderIcons = {};
    }
    currentSettings.folderIcons[folderPath] = icon;
    await deps.saveSettings();
    const currentPath = deps.getCurrentPath();
    if (currentPath) navigateTo(currentPath);
    deps.showToast('Folder icon updated', 'Success', 'success');
  }

  async function resetFolderIcon() {
    const currentSettings = deps.getCurrentSettings();
    if (
      folderIconPickerPath &&
      currentSettings.folderIcons &&
      currentSettings.folderIcons[folderIconPickerPath]
    ) {
      delete currentSettings.folderIcons[folderIconPickerPath];
      await deps.saveSettings();
      const currentPath = deps.getCurrentPath();
      if (currentPath) navigateTo(currentPath);
      deps.showToast('Folder icon reset to default', 'Success', 'success');
    }
    hideFolderIconPicker();
  }

  function navigateTo(path: string) {
    void deps.navigateTo(path);
  }

  function getFolderIcon(folderPath: string): string {
    const currentSettings = deps.getCurrentSettings();
    const customIcon = currentSettings.folderIcons?.[folderPath];
    if (customIcon) {
      return deps.twemojiImg(customIcon, 'twemoji file-icon');
    }
    return deps.folderIcon;
  }

  return {
    showFolderIconPicker,
    hideFolderIconPicker,
    setFolderIcon,
    resetFolderIcon,
    getFolderIcon,
  };
}
