import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./shared.js', () => ({
  escapeHtml: (s: string) => s,
}));

vi.mock('./rendererDom.js', () => ({
  clearHtml: vi.fn((el: HTMLElement) => {
    if (el) el.innerHTML = '';
  }),
  setHtml: vi.fn((el: HTMLElement, html: string) => {
    if (el) el.innerHTML = html;
  }),
}));

vi.mock('./rendererUtils.js', () => ({
  twemojiImg: () => '<img>',
}));

import { createNavigationController } from './rendererNavigation';

function createDeps(overrides: Record<string, unknown> = {}) {
  const settings = {
    enableSearchHistory: true,
    directoryHistory: [] as string[],
    maxDirectoryHistoryItems: 10,
    showHiddenFiles: false,
    ...((overrides.settingsOverrides as Record<string, unknown>) ?? {}),
  } as Record<string, unknown>;
  return {
    settings,
    getCurrentPath: vi.fn(() => (overrides.currentPath as string) ?? '/workspace'),
    getCurrentSettings: vi.fn(() => settings),
    getBreadcrumbContainer: vi.fn(
      () => document.getElementById('breadcrumb-container') as HTMLElement | null
    ),
    getBreadcrumbMenu: vi.fn(
      () => document.getElementById('breadcrumb-menu') as HTMLElement | null
    ),
    getAddressInput: vi.fn(
      () => document.getElementById('address-input') as HTMLInputElement | null
    ),
    getPathDisplayValue: vi.fn((p: string) => p),
    isHomeViewPath: vi.fn((p: string) => p === 'home-view'),
    homeViewLabel: 'Home',
    homeViewPath: 'home-view',
    navigateTo: vi.fn(),
    createDirectoryOperationId: vi.fn(() => 'op-1'),
    nameCollator: new Intl.Collator(),
    getFolderIcon: vi.fn(() => '📁'),
    getDragOperation: vi.fn(() => 'copy' as const),
    showDropIndicator: vi.fn(),
    hideDropIndicator: vi.fn(),
    getDraggedPaths: vi.fn(async () => []),
    handleDrop: vi.fn(async () => {}),
    debouncedSaveSettings: vi.fn(),
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
    showToast: vi.fn(),
    directoryHistoryMax: 5,
  };
}

function setupNavDOM() {
  document.body.innerHTML = `
    <div class="address-bar-wrapper">
      <div class="address-bar">
        <div id="breadcrumb-container" class="breadcrumb" style="display:inline-flex"></div>
        <input id="address-input" style="display:none" />
      </div>
      <div id="breadcrumb-menu" style="display:none" role="menu"></div>
    </div>
    <div id="directory-history-dropdown" style="display:none"></div>
  `;

  Object.defineProperty(window, 'electronAPI', {
    value: {
      getDirectoryContents: vi.fn().mockResolvedValue({
        success: true,
        contents: [
          {
            name: 'subdir',
            path: '/workspace/subdir',
            isDirectory: true,
            isFile: false,
            isHidden: false,
          },
          {
            name: 'file.txt',
            path: '/workspace/file.txt',
            isDirectory: false,
            isFile: true,
            isHidden: false,
          },
        ],
      }),
    },
    configurable: true,
    writable: true,
  });
}

describe('NavigationController — extended', () => {
  beforeEach(() => {
    setupNavDOM();
  });

  describe('updateBreadcrumb', () => {
    it('shows breadcrumb items for a unix path', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/home/user/Documents');
      const container = document.getElementById('breadcrumb-container')!;
      expect(container.style.display).toBe('inline-flex');

      const items = container.querySelectorAll('.breadcrumb-item');
      expect(items.length).toBe(3);
    });

    it('shows home label for home-view path', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('home-view');
      const container = document.getElementById('breadcrumb-container')!;
      const label = container.querySelector('.breadcrumb-label');
      expect(label?.textContent).toBe('Home');
    });

    it('shows address input when path is empty', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('');
      const container = document.getElementById('breadcrumb-container')!;
      expect(container.style.display).toBe('none');
      const input = document.getElementById('address-input') as HTMLInputElement;
      expect(input.style.display).toBe('block');
    });

    it('adds separators between segments', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/a/b/c');
      const container = document.getElementById('breadcrumb-container')!;
      const separators = container.querySelectorAll('.breadcrumb-separator');
      expect(separators.length).toBe(2);
    });

    it('navigates when breadcrumb label is clicked', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/home/user');
      const container = document.getElementById('breadcrumb-container')!;
      const labels = container.querySelectorAll('.breadcrumb-label');

      (labels[0] as HTMLElement).click();
      expect(deps.navigateTo).toHaveBeenCalledWith('/home');
    });
  });

  describe('toggleBreadcrumbMode', () => {
    it('switches to address input mode', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');
      ctrl.toggleBreadcrumbMode();
      const container = document.getElementById('breadcrumb-container')!;
      expect(container.style.display).toBe('none');
      const input = document.getElementById('address-input') as HTMLInputElement;
      expect(input.style.display).toBe('block');
      expect(input.value).toBe('/workspace');
    });

    it('switches back to breadcrumb mode', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.toggleBreadcrumbMode();
      ctrl.toggleBreadcrumbMode();
      const container = document.getElementById('breadcrumb-container')!;
      expect(container.style.display).toBe('inline-flex');
    });
  });

  describe('showBreadcrumbMenu', () => {
    it('loads and displays subfolder menu items', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLButtonElement;

      await ctrl.showBreadcrumbMenu('/workspace', caret);

      const menu = document.getElementById('breadcrumb-menu')!;
      expect(menu.style.display).toBe('block');

      const items = menu.querySelectorAll('.breadcrumb-menu-item');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('subdir');
    });

    it('shows "No subfolders" when directory has no subfolders', async () => {
      (
        window as unknown as { electronAPI: { getDirectoryContents: ReturnType<typeof vi.fn> } }
      ).electronAPI.getDirectoryContents.mockResolvedValue({
        success: true,
        contents: [
          {
            name: 'file.txt',
            path: '/workspace/file.txt',
            isDirectory: false,
            isFile: true,
            isHidden: false,
          },
        ],
      });
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      const caret = document.createElement('button');
      await ctrl.showBreadcrumbMenu('/workspace', caret);
      const menu = document.getElementById('breadcrumb-menu')!;
      expect(menu.innerHTML).toContain('No subfolders');
    });

    it('shows "Failed to load" on API failure', async () => {
      (
        window as unknown as { electronAPI: { getDirectoryContents: ReturnType<typeof vi.fn> } }
      ).electronAPI.getDirectoryContents.mockResolvedValue({ success: false });
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      const caret = document.createElement('button');
      await ctrl.showBreadcrumbMenu('/workspace', caret);
      const menu = document.getElementById('breadcrumb-menu')!;
      expect(menu.innerHTML).toContain('Failed to load');
    });

    it('toggles off when called twice with same path', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      const caret = document.createElement('button');

      await ctrl.showBreadcrumbMenu('/workspace', caret);
      expect(ctrl.isBreadcrumbMenuOpen()).toBe(true);

      await ctrl.showBreadcrumbMenu('/workspace', caret);
      expect(ctrl.isBreadcrumbMenuOpen()).toBe(false);
    });
  });

  describe('hideBreadcrumbMenu', () => {
    it('hides menu and restores focus to anchor', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      const caret = document.createElement('button');
      document.body.appendChild(caret);
      const focusSpy = vi.spyOn(caret, 'focus');

      await ctrl.showBreadcrumbMenu('/workspace', caret);
      ctrl.hideBreadcrumbMenu();

      const menu = document.getElementById('breadcrumb-menu')!;
      expect(menu.style.display).toBe('none');
      expect(caret.getAttribute('aria-expanded')).toBe('false');
      expect(focusSpy).toHaveBeenCalled();
    });
  });

  describe('showDirectoryHistoryDropdown', () => {
    it('shows empty message when no history', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.showDirectoryHistoryDropdown();
      const dropdown = document.getElementById('directory-history-dropdown')!;
      expect(dropdown.style.display).toBe('block');
      expect(dropdown.innerHTML).toContain('No recent directories');
    });

    it('shows history items with clear button', () => {
      const deps = createDeps();
      deps.settings.directoryHistory = ['/a', '/b'];
      const ctrl = createNavigationController(deps as any);
      ctrl.showDirectoryHistoryDropdown();
      const dropdown = document.getElementById('directory-history-dropdown')!;
      expect(dropdown.innerHTML).toContain('/a');
      expect(dropdown.innerHTML).toContain('/b');
      expect(dropdown.innerHTML).toContain('Clear Directory History');
    });

    it('does nothing when dropdown is missing', () => {
      document.getElementById('directory-history-dropdown')!.remove();
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);

      ctrl.showDirectoryHistoryDropdown();
    });

    it('does nothing when enableSearchHistory is false', () => {
      const deps = createDeps({ settingsOverrides: { enableSearchHistory: false } });
      const ctrl = createNavigationController(deps as any);
      ctrl.showDirectoryHistoryDropdown();
      const dropdown = document.getElementById('directory-history-dropdown')!;
      expect(dropdown.style.display).toBe('none');
    });
  });

  describe('hideDirectoryHistoryDropdown', () => {
    it('hides the dropdown', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      const dropdown = document.getElementById('directory-history-dropdown')!;
      dropdown.style.display = 'block';
      ctrl.hideDirectoryHistoryDropdown();
      expect(dropdown.style.display).toBe('none');
    });
  });

  describe('clearDirectoryHistory', () => {
    it('clears history, saves, and shows toast', () => {
      const deps = createDeps();
      deps.settings.directoryHistory = ['/a', '/b'];
      const ctrl = createNavigationController(deps as any);
      ctrl.clearDirectoryHistory();
      expect(deps.settings.directoryHistory).toEqual([]);
      expect(deps.saveSettingsWithTimestamp).toHaveBeenCalledWith(deps.settings);
      expect(deps.showToast).toHaveBeenCalledWith(
        'Directory history cleared',
        'History',
        'success'
      );
    });
  });

  describe('isBreadcrumbMenuOpen', () => {
    it('returns false when menu is not displayed', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      expect(ctrl.isBreadcrumbMenuOpen()).toBe(false);
    });
  });

  describe('getBreadcrumbMenuElement', () => {
    it('returns the menu element', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      expect(ctrl.getBreadcrumbMenuElement()).toBe(document.getElementById('breadcrumb-menu'));
    });
  });
});
