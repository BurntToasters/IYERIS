import type { Settings } from './types';
import { normalizeIconName } from './rendererUtils.js';

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
  'folder',
  'folder-open',
  'file-text',
  'contact',
  'archive',
  'briefcase',
  'star',
  'sparkles',
  'heart',
  'lightbulb',
  'gamepad-2',
  'music',
  'clapperboard',
  'camera',
  'video',
  'library',
  'book-open',
  'pencil',
  'laptop',
  'monitor',
  'home',
  'building',
  'wrench',
  'settings',
  'lock',
  'unlock',
  'package',
  'inbox',
  'upload',
  'trash-2',
  'cloud',
  'globe',
  'rocket',
  'plane',
  'car',
  'bike',
  'activity',
  'trophy',
  'apple',
  'leaf',
  'trees',
  'sun',
  'palette',
];

export function createFolderIconPickerController(deps: FolderIconPickerDeps) {
  let folderIconPickerPath: string | null = null;
  let gridDelegationAttached = false;

  function attachGridDelegation(grid: HTMLElement): void {
    if (gridDelegationAttached) return;
    gridDelegationAttached = true;
    grid.addEventListener('click', (e) => {
      const option = (e.target as HTMLElement).closest('.folder-icon-option') as HTMLElement | null;
      if (!option) return;
      const icon = option.dataset.icon;
      if (icon && folderIconPickerPath) {
        setFolderIcon(folderIconPickerPath, icon);
        hideFolderIconPicker();
      }
    });
  }

  function showFolderIconPicker(folderPath: string) {
    const modal = document.getElementById('folder-icon-modal');
    const pathDisplay = document.getElementById('folder-icon-path');
    const grid = document.getElementById('folder-icon-grid');

    if (!modal || !pathDisplay || !grid) return;

    folderIconPickerPath = folderPath;
    attachGridDelegation(grid);

    const folderName = folderPath.split(/[/\\]/).pop() || folderPath;
    pathDisplay.textContent = folderName;

    const currentSettings = deps.getCurrentSettings();
    const rawIcon = currentSettings.folderIcons?.[folderPath];
    const currentIcon = rawIcon ? normalizeIconName(rawIcon) : undefined;

    grid.innerHTML = FOLDER_ICON_OPTIONS.map((iconName) => {
      const isSelected = currentIcon === iconName;
      return `
      <div class="folder-icon-option${isSelected ? ' selected' : ''}" data-icon="${iconName}">
        ${deps.twemojiImg(iconName, 'twemoji')}
      </div>
    `;
    }).join('');

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
    try {
      await deps.saveSettings();
    } catch {
      deps.showToast('Failed to save folder icon', 'Error', 'error');
      return;
    }
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
      try {
        await deps.saveSettings();
      } catch {
        deps.showToast('Failed to save folder icon', 'Error', 'error');
        return;
      }
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
