import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFolderIconPickerController } from './rendererFolderIconPicker';

function createDeps(overrides: Record<string, unknown> = {}) {
  const settings: { folderIcons?: { [path: string]: string } } = {
    folderIcons: {},
    ...overrides,
  };

  const deps = {
    getCurrentSettings: vi.fn(() => settings),
    getCurrentPath: vi.fn(() => '/home/user/Documents'),
    navigateTo: vi.fn().mockResolvedValue(undefined),
    showToast: vi.fn(),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    activateModal: vi.fn(),
    deactivateModal: vi.fn(),
    twemojiImg: vi.fn((emoji: string, cls: string) => `<img class="${cls}" alt="${emoji}" />`),
    folderIcon: '<img class="default-folder-icon" />',
  };

  return { deps, settings };
}

function setupDOM() {
  document.body.innerHTML = `
    <div id="folder-icon-modal" style="display:none">
      <span id="folder-icon-path"></span>
      <div id="folder-icon-grid"></div>
    </div>
  `;
}

describe('createFolderIconPickerController', () => {
  beforeEach(() => {
    setupDOM();
  });

  describe('showFolderIconPicker', () => {
    it('displays the modal and populates the grid', () => {
      const { deps } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/home/user/Documents');

      const modal = document.getElementById('folder-icon-modal')!;
      expect(modal.style.display).toBe('flex');
      expect(deps.activateModal).toHaveBeenCalledWith(modal);

      const pathDisplay = document.getElementById('folder-icon-path')!;
      expect(pathDisplay.textContent).toBe('Documents');

      const grid = document.getElementById('folder-icon-grid')!;
      const options = grid.querySelectorAll('.folder-icon-option');
      expect(options.length).toBeGreaterThan(0);
    });

    it('extracts the last segment of a unix path for the path display', () => {
      const { deps } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/a/b/MyFolder');

      const pathDisplay = document.getElementById('folder-icon-path')!;
      expect(pathDisplay.textContent).toBe('MyFolder');
    });

    it('extracts the last segment of a windows path for the path display', () => {
      const { deps } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('C:\\Users\\Me\\Desktop');

      const pathDisplay = document.getElementById('folder-icon-path')!;
      expect(pathDisplay.textContent).toBe('Desktop');
    });

    it('uses folderPath as display when path has no separators', () => {
      const { deps } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('standalone');

      const pathDisplay = document.getElementById('folder-icon-path')!;
      expect(pathDisplay.textContent).toBe('standalone');
    });

    it('marks the currently selected icon as selected', () => {
      const emoji = String.fromCodePoint(0x2b50);
      const { deps } = createDeps({ folderIcons: { '/test/path': emoji } });
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/test/path');

      const grid = document.getElementById('folder-icon-grid')!;
      const selected = grid.querySelectorAll('.folder-icon-option.selected');
      expect(selected.length).toBeGreaterThanOrEqual(1);
    });

    it('does not mark any icon as selected when there is no current icon', () => {
      const { deps } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/some/new/path');

      const grid = document.getElementById('folder-icon-grid')!;
      const selected = grid.querySelectorAll('.folder-icon-option.selected');
      expect(selected.length).toBe(0);
    });

    it('calls twemojiImg for each icon option', () => {
      const { deps } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/path');

      expect(deps.twemojiImg).toHaveBeenCalled();

      expect(deps.twemojiImg.mock.calls.length).toBeGreaterThan(10);
    });

    it('does nothing when DOM elements are missing', () => {
      document.body.innerHTML = '';
      const { deps } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/path');

      expect(deps.activateModal).not.toHaveBeenCalled();
    });

    it('does nothing when grid element is missing', () => {
      document.body.innerHTML = `
        <div id="folder-icon-modal" style="display:none">
          <span id="folder-icon-path"></span>
        </div>
      `;
      const { deps } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/path');

      expect(deps.activateModal).not.toHaveBeenCalled();
    });

    it('does nothing when path display element is missing', () => {
      document.body.innerHTML = `
        <div id="folder-icon-modal" style="display:none">
          <div id="folder-icon-grid"></div>
        </div>
      `;
      const { deps } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/path');

      expect(deps.activateModal).not.toHaveBeenCalled();
    });
  });

  describe('grid click interactions', () => {
    it('sets icon and hides picker when a grid option is clicked', async () => {
      const { deps, settings } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/home/user/Music');

      const grid = document.getElementById('folder-icon-grid')!;
      const firstOption = grid.querySelector('.folder-icon-option') as HTMLElement;
      expect(firstOption).toBeTruthy();

      firstOption.click();

      await vi.waitFor(() => {
        expect(deps.saveSettings).toHaveBeenCalled();
      });

      const icon = firstOption.dataset.icon!;
      expect(settings.folderIcons!['/home/user/Music']).toBe(icon);
      expect(deps.showToast).toHaveBeenCalledWith('Folder icon updated', 'Success', 'success');

      const modal = document.getElementById('folder-icon-modal')!;
      expect(modal.style.display).toBe('none');
      expect(deps.deactivateModal).toHaveBeenCalledWith(modal);
    });

    it('navigates to current path after setting icon', async () => {
      const { deps } = createDeps();
      deps.getCurrentPath.mockReturnValue('/current');
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/some/folder');

      const grid = document.getElementById('folder-icon-grid')!;
      const option = grid.querySelector('.folder-icon-option') as HTMLElement;
      option.click();

      await vi.waitFor(() => {
        expect(deps.navigateTo).toHaveBeenCalledWith('/current');
      });
    });

    it('does not navigate when getCurrentPath returns empty', async () => {
      const { deps } = createDeps();
      deps.getCurrentPath.mockReturnValue('');
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/some/folder');

      const grid = document.getElementById('folder-icon-grid')!;
      const option = grid.querySelector('.folder-icon-option') as HTMLElement;
      option.click();

      await vi.waitFor(() => {
        expect(deps.saveSettings).toHaveBeenCalled();
      });

      expect(deps.navigateTo).not.toHaveBeenCalled();
    });
  });

  describe('hideFolderIconPicker', () => {
    it('hides the modal and deactivates it', () => {
      const { deps } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);

      const modal = document.getElementById('folder-icon-modal')!;
      modal.style.display = 'flex';

      ctrl.hideFolderIconPicker();

      expect(modal.style.display).toBe('none');
      expect(deps.deactivateModal).toHaveBeenCalledWith(modal);
    });

    it('does nothing when modal element is missing', () => {
      document.body.innerHTML = '';
      const { deps } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.hideFolderIconPicker();

      expect(deps.deactivateModal).not.toHaveBeenCalled();
    });
  });

  describe('setFolderIcon', () => {
    it('sets the icon on the settings and saves', async () => {
      const { deps, settings } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);

      await ctrl.setFolderIcon('/my/folder', '⭐');

      expect(settings.folderIcons!['/my/folder']).toBe('⭐');
      expect(deps.saveSettings).toHaveBeenCalled();
      expect(deps.showToast).toHaveBeenCalledWith('Folder icon updated', 'Success', 'success');
    });

    it('creates the folderIcons object if it does not exist', async () => {
      const { deps, settings } = createDeps();
      delete settings.folderIcons;
      const ctrl = createFolderIconPickerController(deps as any);

      await ctrl.setFolderIcon('/new/folder', '❤️');

      expect(settings.folderIcons).toBeDefined();
      expect(settings.folderIcons!['/new/folder']).toBe('❤️');
      expect(deps.saveSettings).toHaveBeenCalled();
    });

    it('navigates to current path after setting', async () => {
      const { deps } = createDeps();
      deps.getCurrentPath.mockReturnValue('/current/dir');
      const ctrl = createFolderIconPickerController(deps as any);

      await ctrl.setFolderIcon('/folder', '🌟');

      expect(deps.navigateTo).toHaveBeenCalledWith('/current/dir');
    });

    it('does not navigate when getCurrentPath returns empty string', async () => {
      const { deps } = createDeps();
      deps.getCurrentPath.mockReturnValue('');
      const ctrl = createFolderIconPickerController(deps as any);

      await ctrl.setFolderIcon('/folder', '🌟');

      expect(deps.navigateTo).not.toHaveBeenCalled();
    });

    it('overwrites an existing icon', async () => {
      const { deps, settings } = createDeps({ folderIcons: { '/folder': '⭐' } });
      const ctrl = createFolderIconPickerController(deps as any);

      await ctrl.setFolderIcon('/folder', '❤️');

      expect(settings.folderIcons!['/folder']).toBe('❤️');
    });
  });

  describe('resetFolderIcon', () => {
    it('deletes the icon for the current picker path and saves', async () => {
      const emoji = String.fromCodePoint(0x2b50);
      const { deps, settings } = createDeps({ folderIcons: { '/target': emoji } });
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/target');

      await ctrl.resetFolderIcon();

      expect(settings.folderIcons!['/target']).toBeUndefined();
      expect(deps.saveSettings).toHaveBeenCalled();
      expect(deps.showToast).toHaveBeenCalledWith(
        'Folder icon reset to default',
        'Success',
        'success'
      );
    });

    it('navigates to current path after reset', async () => {
      const emoji = String.fromCodePoint(0x2b50);
      const { deps } = createDeps({ folderIcons: { '/target': emoji } });
      deps.getCurrentPath.mockReturnValue('/current');
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/target');
      await ctrl.resetFolderIcon();

      expect(deps.navigateTo).toHaveBeenCalledWith('/current');
    });

    it('does not navigate when getCurrentPath returns empty', async () => {
      const emoji = String.fromCodePoint(0x2b50);
      const { deps } = createDeps({ folderIcons: { '/target': emoji } });
      deps.getCurrentPath.mockReturnValue('');
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/target');
      await ctrl.resetFolderIcon();

      expect(deps.navigateTo).not.toHaveBeenCalled();
    });

    it('hides the picker after reset', async () => {
      const emoji = String.fromCodePoint(0x2b50);
      const { deps } = createDeps({ folderIcons: { '/target': emoji } });
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/target');
      await ctrl.resetFolderIcon();

      const modal = document.getElementById('folder-icon-modal')!;
      expect(modal.style.display).toBe('none');
    });

    it('does nothing when folderIconPickerPath is not set (picker never shown)', async () => {
      const { deps } = createDeps({ folderIcons: { '/target': '⭐' } });
      const ctrl = createFolderIconPickerController(deps as any);

      await ctrl.resetFolderIcon();

      expect(deps.saveSettings).not.toHaveBeenCalled();
      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('does nothing when the path has no icon to reset', async () => {
      const { deps } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/no-icon-path');
      await ctrl.resetFolderIcon();

      expect(deps.saveSettings).not.toHaveBeenCalled();
      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('does nothing when folderIcons is undefined', async () => {
      const { deps, settings } = createDeps();
      delete settings.folderIcons;
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/path');
      await ctrl.resetFolderIcon();

      expect(deps.saveSettings).not.toHaveBeenCalled();
    });
  });

  describe('getFolderIcon', () => {
    it('returns custom icon via twemojiImg when folder has a custom icon', () => {
      const { deps } = createDeps({ folderIcons: { '/custom': '🌟' } });
      const ctrl = createFolderIconPickerController(deps as any);

      const result = ctrl.getFolderIcon('/custom');

      expect(deps.twemojiImg).toHaveBeenCalledWith('🌟', 'twemoji file-icon');
      expect(result).toContain('twemoji file-icon');
    });

    it('returns default folderIcon when folder has no custom icon', () => {
      const { deps } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);

      const result = ctrl.getFolderIcon('/no-custom');

      expect(result).toBe('<img class="default-folder-icon" />');
      expect(deps.twemojiImg).not.toHaveBeenCalled();
    });

    it('returns default folderIcon when folderIcons is undefined', () => {
      const { deps, settings } = createDeps();
      delete settings.folderIcons;
      const ctrl = createFolderIconPickerController(deps as any);

      const result = ctrl.getFolderIcon('/path');

      expect(result).toBe(deps.folderIcon);
    });
  });

  describe('show then hide lifecycle', () => {
    it('toggles modal visibility on show then hide', () => {
      const { deps } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);
      const modal = document.getElementById('folder-icon-modal')!;

      expect(modal.style.display).toBe('none');

      ctrl.showFolderIconPicker('/path');
      expect(modal.style.display).toBe('flex');

      ctrl.hideFolderIconPicker();
      expect(modal.style.display).toBe('none');
    });

    it('show replaces grid contents each time', () => {
      const { deps } = createDeps();
      const ctrl = createFolderIconPickerController(deps as any);
      const grid = document.getElementById('folder-icon-grid')!;

      ctrl.showFolderIconPicker('/first');
      const firstHTML = grid.innerHTML;

      ctrl.showFolderIconPicker('/second');
      const secondHTML = grid.innerHTML;

      expect(firstHTML).toBe(secondHTML);
    });

    it('resetFolderIcon clears folderIconPickerPath so subsequent reset is a no-op', async () => {
      const emoji = String.fromCodePoint(0x2b50);
      const { deps } = createDeps({ folderIcons: { '/target': emoji } });
      const ctrl = createFolderIconPickerController(deps as any);

      ctrl.showFolderIconPicker('/target');
      await ctrl.resetFolderIcon();

      deps.saveSettings.mockClear();
      deps.showToast.mockClear();

      await ctrl.resetFolderIcon();
      expect(deps.saveSettings).not.toHaveBeenCalled();
      expect(deps.showToast).not.toHaveBeenCalled();
    });
  });
});
