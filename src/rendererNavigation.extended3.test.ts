import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const mockClearHtml = vi.hoisted(() =>
  vi.fn((el: HTMLElement) => {
    if (el) el.innerHTML = '';
  })
);
const mockSetHtml = vi.hoisted(() =>
  vi.fn((el: HTMLElement, html: string) => {
    if (el) el.innerHTML = html;
  })
);

vi.mock('./shared.js', () => ({
  escapeHtml: (s: string) => s,
}));

vi.mock('./rendererDom.js', () => ({
  clearHtml: mockClearHtml,
  setHtml: mockSetHtml,
}));

vi.mock('./rendererUtils.js', () => ({
  twemojiImg: () => '<img>',
}));

import { createNavigationController } from './rendererNavigation';

function flushPromises() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

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
    getDraggedPaths: vi.fn(async () => [] as string[]),
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
            name: 'alpha',
            path: '/workspace/alpha',
            isDirectory: true,
            isFile: false,
            isHidden: false,
          },
          {
            name: 'beta',
            path: '/workspace/beta',
            isDirectory: true,
            isFile: false,
            isHidden: false,
          },
        ],
      }),
    },
    configurable: true,
    writable: true,
  });
}

function dispatchKeydown(el: EventTarget, key: string, extra: Partial<KeyboardEvent> = {}) {
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
  );
}

function createDragEvent(type: string, overrides: Record<string, unknown> = {}): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as unknown as DragEvent;
  Object.defineProperty(event, 'dataTransfer', {
    value: { dropEffect: 'none' },
    writable: true,
  });
  Object.defineProperty(event, 'clientX', { value: overrides.clientX ?? 100 });
  Object.defineProperty(event, 'clientY', { value: overrides.clientY ?? 100 });
  Object.defineProperty(event, 'preventDefault', { value: vi.fn() });
  Object.defineProperty(event, 'stopPropagation', { value: vi.fn() });
  return event;
}

describe('NavigationController — extended3', () => {
  beforeEach(() => {
    setupNavDOM();
  });

  describe('setupBreadcrumbListeners', () => {
    it('address bar click switches to address input mode', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');
      ctrl.setupBreadcrumbListeners();

      const addressBar = document.querySelector('.address-bar') as HTMLElement;
      addressBar.click();

      const container = document.getElementById('breadcrumb-container')!;
      const input = document.getElementById('address-input') as HTMLInputElement;
      expect(container.style.display).toBe('none');
      expect(input.style.display).toBe('block');
    });

    it('clicking on breadcrumb container area switches to address mode', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');
      ctrl.setupBreadcrumbListeners();

      const container = document.getElementById('breadcrumb-container')!;
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'target', { value: container });
      document.querySelector('.address-bar')!.dispatchEvent(event);

      expect(container.style.display).toBe('none');
    });

    it('does not switch mode when clicking non-address-bar elements', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');
      ctrl.setupBreadcrumbListeners();

      const container = document.getElementById('breadcrumb-container')!;
      const label = container.querySelector('.breadcrumb-label') as HTMLElement;
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'target', { value: label });
      document.querySelector('.address-bar')!.dispatchEvent(event);

      expect(container.style.display).toBe('inline-flex');
    });

    it('blur on address input restores breadcrumb mode after delay', () => {
      vi.useFakeTimers();
      try {
        const deps = createDeps();
        const ctrl = createNavigationController(deps as any);
        ctrl.updateBreadcrumb('/workspace');
        ctrl.setupBreadcrumbListeners();

        ctrl.toggleBreadcrumbMode();
        const input = document.getElementById('address-input') as HTMLInputElement;
        expect(input.style.display).toBe('block');

        input.dispatchEvent(new Event('blur'));

        vi.advanceTimersByTime(150);

        const container = document.getElementById('breadcrumb-container')!;
        expect(container.style.display).toBe('inline-flex');
        expect(input.style.display).toBe('none');
      } finally {
        vi.useRealTimers();
      }
    });

    it('Escape key on address input restores breadcrumb mode and blurs', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');
      ctrl.setupBreadcrumbListeners();

      ctrl.toggleBreadcrumbMode();
      const input = document.getElementById('address-input') as HTMLInputElement;
      const blurSpy = vi.spyOn(input, 'blur');

      dispatchKeydown(input, 'Escape');

      const container = document.getElementById('breadcrumb-container')!;
      expect(container.style.display).toBe('inline-flex');
      expect(blurSpy).toHaveBeenCalled();
    });

    it('blur does not restore breadcrumb when currentPath is empty', () => {
      vi.useFakeTimers();
      try {
        const deps = createDeps({ currentPath: '' });
        const ctrl = createNavigationController(deps as any);
        ctrl.setupBreadcrumbListeners();
        ctrl.toggleBreadcrumbMode();

        const input = document.getElementById('address-input') as HTMLInputElement;
        input.dispatchEvent(new Event('blur'));
        vi.advanceTimersByTime(200);

        expect(input.style.display).toBe('block');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('breadcrumb menu keyboard navigation', () => {
    async function openMenuWithItems(deps: ReturnType<typeof createDeps>) {
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');
      ctrl.setupBreadcrumbListeners();

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLButtonElement;
      await ctrl.showBreadcrumbMenu('/workspace', caret);

      const menu = document.getElementById('breadcrumb-menu')!;
      return { ctrl, menu, caret };
    }

    it('ArrowDown cycles focus forward through menu items', async () => {
      const deps = createDeps();
      const { menu } = await openMenuWithItems(deps);

      const items = menu.querySelectorAll<HTMLElement>('.breadcrumb-menu-item');
      expect(items.length).toBe(2);

      dispatchKeydown(menu, 'ArrowDown');
      expect(items[1].tabIndex).toBe(0);
      expect(items[0].tabIndex).toBe(-1);

      dispatchKeydown(menu, 'ArrowDown');
      expect(items[0].tabIndex).toBe(0);
    });

    it('ArrowUp cycles focus backward through menu items', async () => {
      const deps = createDeps();
      const { menu } = await openMenuWithItems(deps);

      const items = menu.querySelectorAll<HTMLElement>('.breadcrumb-menu-item');

      dispatchKeydown(menu, 'ArrowUp');
      expect(items[items.length - 1].tabIndex).toBe(0);

      dispatchKeydown(menu, 'ArrowUp');
      expect(items[0].tabIndex).toBe(0);
    });

    it('Home key focuses the first menu item', async () => {
      const deps = createDeps();
      const { menu } = await openMenuWithItems(deps);

      const items = menu.querySelectorAll<HTMLElement>('.breadcrumb-menu-item');
      dispatchKeydown(menu, 'ArrowDown');
      expect(items[1].tabIndex).toBe(0);

      dispatchKeydown(menu, 'Home');
      expect(items[0].tabIndex).toBe(0);
    });

    it('End key focuses the last menu item', async () => {
      const deps = createDeps();
      const { menu } = await openMenuWithItems(deps);

      const items = menu.querySelectorAll<HTMLElement>('.breadcrumb-menu-item');

      dispatchKeydown(menu, 'End');
      expect(items[items.length - 1].tabIndex).toBe(0);
    });

    it('Escape closes the breadcrumb menu', async () => {
      const deps = createDeps();
      const { menu } = await openMenuWithItems(deps);

      expect(menu.style.display).toBe('block');
      dispatchKeydown(menu, 'Escape');
      expect(menu.style.display).toBe('none');
    });

    it('keys do nothing when menu is hidden', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');
      ctrl.setupBreadcrumbListeners();
      const menu = document.getElementById('breadcrumb-menu')!;

      dispatchKeydown(menu, 'ArrowDown');
      dispatchKeydown(menu, 'ArrowUp');
      dispatchKeydown(menu, 'Home');
      dispatchKeydown(menu, 'End');
    });
  });

  describe('breadcrumb label keyboard handlers', () => {
    it('Enter key on label navigates to path', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/home/user');

      const container = document.getElementById('breadcrumb-container')!;
      const labels = container.querySelectorAll('.breadcrumb-label');

      dispatchKeydown(labels[0], 'Enter');
      expect(deps.navigateTo).toHaveBeenCalledWith('/home');
    });

    it('Space key on label navigates to path', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/home/user');

      const container = document.getElementById('breadcrumb-container')!;
      const labels = container.querySelectorAll('.breadcrumb-label');

      dispatchKeydown(labels[1], ' ');
      expect(deps.navigateTo).toHaveBeenCalledWith('/home/user');
    });

    it('ArrowDown on label opens breadcrumb menu', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const label = container.querySelector('.breadcrumb-label') as HTMLElement;

      dispatchKeydown(label, 'ArrowDown');

      await flushPromises();

      const menu = document.getElementById('breadcrumb-menu')!;
      expect(menu.style.display).toBe('block');
    });

    it('F4 on label opens breadcrumb menu', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const label = container.querySelector('.breadcrumb-label') as HTMLElement;

      dispatchKeydown(label, 'F4');

      await flushPromises();

      const menu = document.getElementById('breadcrumb-menu')!;
      expect(menu.style.display).toBe('block');
    });
  });

  describe('breadcrumb caret keyboard handlers', () => {
    it('Enter on caret opens breadcrumb menu', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLElement;

      dispatchKeydown(caret, 'Enter');

      await flushPromises();

      const menu = document.getElementById('breadcrumb-menu')!;
      expect(menu.style.display).toBe('block');
    });

    it('Space on caret opens breadcrumb menu', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLElement;

      dispatchKeydown(caret, ' ');

      await flushPromises();

      const menu = document.getElementById('breadcrumb-menu')!;
      expect(menu.style.display).toBe('block');
    });

    it('ArrowDown on caret opens breadcrumb menu', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLElement;

      dispatchKeydown(caret, 'ArrowDown');

      await flushPromises();

      const menu = document.getElementById('breadcrumb-menu')!;
      expect(menu.style.display).toBe('block');
    });

    it('F4 on caret opens breadcrumb menu', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLElement;

      dispatchKeydown(caret, 'F4');

      await flushPromises();

      const menu = document.getElementById('breadcrumb-menu')!;
      expect(menu.style.display).toBe('block');
    });

    it('Escape on caret hides the breadcrumb menu', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLButtonElement;

      await ctrl.showBreadcrumbMenu('/workspace', caret);
      const menu = document.getElementById('breadcrumb-menu')!;
      expect(menu.style.display).toBe('block');

      dispatchKeydown(caret, 'Escape');
      expect(menu.style.display).toBe('none');
    });
  });

  describe('focusBreadcrumbMenuItem', () => {
    it('sets tabIndex=0 on focused item and -1 on others', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLButtonElement;
      await ctrl.showBreadcrumbMenu('/workspace', caret);

      const menu = document.getElementById('breadcrumb-menu')!;
      const items = menu.querySelectorAll('.breadcrumb-menu-item');

      expect((items[0] as HTMLElement).tabIndex).toBe(0);
      expect((items[1] as HTMLElement).tabIndex).toBe(-1);
    });

    it('clamps out-of-bounds index to valid range via ArrowDown wrap', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');
      ctrl.setupBreadcrumbListeners();

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLButtonElement;
      await ctrl.showBreadcrumbMenu('/workspace', caret);

      const menu = document.getElementById('breadcrumb-menu')!;
      const items = menu.querySelectorAll<HTMLElement>('.breadcrumb-menu-item');

      dispatchKeydown(menu, 'End');
      expect(items[items.length - 1].tabIndex).toBe(0);

      dispatchKeydown(menu, 'ArrowDown');
      expect(items[0].tabIndex).toBe(0);
    });
  });

  describe('menu item click and keydown', () => {
    it('clicking a menu item navigates and hides the menu', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLButtonElement;
      await ctrl.showBreadcrumbMenu('/workspace', caret);

      const menu = document.getElementById('breadcrumb-menu')!;
      const menuItem = menu.querySelector('.breadcrumb-menu-item') as HTMLButtonElement;
      menuItem.click();

      expect(deps.navigateTo).toHaveBeenCalledWith('/workspace/alpha');
      expect(menu.style.display).toBe('none');
    });

    it('Enter on a menu item navigates and hides the menu', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLButtonElement;
      await ctrl.showBreadcrumbMenu('/workspace', caret);

      const menu = document.getElementById('breadcrumb-menu')!;
      const menuItem = menu.querySelector('.breadcrumb-menu-item') as HTMLButtonElement;

      dispatchKeydown(menuItem, 'Enter');

      expect(deps.navigateTo).toHaveBeenCalledWith('/workspace/alpha');
      expect(menu.style.display).toBe('none');
    });

    it('Space on a menu item navigates and hides the menu', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLButtonElement;
      await ctrl.showBreadcrumbMenu('/workspace', caret);

      const menu = document.getElementById('breadcrumb-menu')!;
      const items = menu.querySelectorAll<HTMLElement>('.breadcrumb-menu-item');
      const secondItem = items[1] as HTMLButtonElement;

      dispatchKeydown(secondItem, ' ');

      expect(deps.navigateTo).toHaveBeenCalledWith('/workspace/beta');
      expect(menu.style.display).toBe('none');
    });
  });

  describe('breadcrumb drag-and-drop', () => {
    it('dragover adds drag-over class and shows drop indicator', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const item = container.querySelector('.breadcrumb-item') as HTMLElement;

      const event = createDragEvent('dragover');
      item.dispatchEvent(event);

      expect(item.classList.contains('drag-over')).toBe(true);
      expect(deps.showDropIndicator).toHaveBeenCalledWith('copy', '/workspace', 100, 100);
    });

    it('dragover sets dropEffect from getDragOperation', () => {
      const deps = createDeps();
      deps.getDragOperation.mockReturnValue('move' as any);
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const item = container.querySelector('.breadcrumb-item') as HTMLElement;

      const event = createDragEvent('dragover');
      item.dispatchEvent(event);

      expect(event.dataTransfer!.dropEffect).toBe('move');
    });

    it('dragleave removes drag-over class when cursor leaves bounds', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const item = container.querySelector('.breadcrumb-item') as HTMLElement;

      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        left: 50,
        right: 150,
        top: 50,
        bottom: 100,
        width: 100,
        height: 50,
        x: 50,
        y: 50,
        toJSON: () => {},
      });

      item.classList.add('drag-over');

      const event = createDragEvent('dragleave', { clientX: 10, clientY: 10 });
      item.dispatchEvent(event);

      expect(item.classList.contains('drag-over')).toBe(false);
      expect(deps.hideDropIndicator).toHaveBeenCalled();
    });

    it('dragleave does NOT remove drag-over class when cursor is within bounds', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const item = container.querySelector('.breadcrumb-item') as HTMLElement;

      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        left: 50,
        right: 150,
        top: 50,
        bottom: 100,
        width: 100,
        height: 50,
        x: 50,
        y: 50,
        toJSON: () => {},
      });

      item.classList.add('drag-over');

      const event = createDragEvent('dragleave', { clientX: 75, clientY: 75 });
      item.dispatchEvent(event);

      expect(item.classList.contains('drag-over')).toBe(true);
      expect(deps.hideDropIndicator).not.toHaveBeenCalled();
    });

    it('drop processes dragged paths and calls handleDrop', async () => {
      const deps = createDeps();
      deps.getDraggedPaths.mockResolvedValue(['/other/file.txt']);
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const item = container.querySelector('.breadcrumb-item') as HTMLElement;
      item.classList.add('drag-over');

      const event = createDragEvent('drop');
      item.dispatchEvent(event);

      await flushPromises();
      await flushPromises();

      expect(item.classList.contains('drag-over')).toBe(false);
      expect(deps.handleDrop).toHaveBeenCalledWith(['/other/file.txt'], '/workspace', 'copy');
      expect(deps.hideDropIndicator).toHaveBeenCalled();
    });

    it('drop with empty dragged paths just hides indicator', async () => {
      const deps = createDeps();
      deps.getDraggedPaths.mockResolvedValue([]);
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const item = container.querySelector('.breadcrumb-item') as HTMLElement;

      const event = createDragEvent('drop');
      item.dispatchEvent(event);

      await flushPromises();

      expect(deps.handleDrop).not.toHaveBeenCalled();
      expect(deps.hideDropIndicator).toHaveBeenCalled();
    });

    it('drop where dragged path matches target path is skipped', async () => {
      const deps = createDeps();
      deps.getDraggedPaths.mockResolvedValue(['/workspace']);
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const item = container.querySelector('.breadcrumb-item') as HTMLElement;

      const event = createDragEvent('drop');
      item.dispatchEvent(event);

      await flushPromises();

      expect(deps.handleDrop).not.toHaveBeenCalled();
      expect(deps.hideDropIndicator).toHaveBeenCalled();
    });
  });

  describe('history dropdown item click', () => {
    it('showDirectoryHistoryDropdown renders data-path attributes for history items', () => {
      const deps = createDeps();
      deps.settings.directoryHistory = ['/home/user', '/tmp'];
      const ctrl = createNavigationController(deps as any);
      ctrl.showDirectoryHistoryDropdown();

      const dropdown = document.getElementById('directory-history-dropdown')!;
      const items = dropdown.querySelectorAll('.history-item');
      expect(items.length).toBe(2);
      expect((items[0] as HTMLElement).dataset.path).toBe('/home/user');
      expect((items[1] as HTMLElement).dataset.path).toBe('/tmp');
    });

    it('showDirectoryHistoryDropdown renders clear button with data-action', () => {
      const deps = createDeps();
      deps.settings.directoryHistory = ['/a'];
      const ctrl = createNavigationController(deps as any);
      ctrl.showDirectoryHistoryDropdown();

      const dropdown = document.getElementById('directory-history-dropdown')!;
      const clearBtn = dropdown.querySelector('.history-clear') as HTMLElement;
      expect(clearBtn).not.toBeNull();
      expect(clearBtn.dataset.action).toBe('clear-directory');
    });
  });

  describe('home view breadcrumb label keyboard', () => {
    it('Enter on home label navigates to home view', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('home-view');

      const container = document.getElementById('breadcrumb-container')!;
      const label = container.querySelector('.breadcrumb-label') as HTMLElement;

      dispatchKeydown(label, 'Enter');
      expect(deps.navigateTo).toHaveBeenCalledWith('home-view');
    });

    it('Space on home label navigates to home view', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('home-view');

      const container = document.getElementById('breadcrumb-container')!;
      const label = container.querySelector('.breadcrumb-label') as HTMLElement;

      dispatchKeydown(label, ' ');
      expect(deps.navigateTo).toHaveBeenCalledWith('home-view');
    });

    it('click on home label navigates to home view', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('home-view');

      const container = document.getElementById('breadcrumb-container')!;
      const label = container.querySelector('.breadcrumb-label') as HTMLElement;
      label.click();

      expect(deps.navigateTo).toHaveBeenCalledWith('home-view');
    });
  });

  describe('breadcrumb caret click', () => {
    it('click on caret opens menu', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLButtonElement;
      caret.click();

      await flushPromises();

      const menu = document.getElementById('breadcrumb-menu')!;
      expect(menu.style.display).toBe('block');
    });
  });

  describe('breadcrumb item attributes', () => {
    it('caret has correct ARIA attributes', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLButtonElement;

      expect(caret.getAttribute('aria-haspopup')).toBe('menu');
      expect(caret.getAttribute('aria-expanded')).toBe('false');
      expect(caret.getAttribute('aria-controls')).toBe('breadcrumb-menu');
      expect(caret.getAttribute('aria-label')).toContain('Open folder menu for');
    });

    it('breadcrumb item has data-path and title set', () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/home/user');

      const container = document.getElementById('breadcrumb-container')!;
      const items = container.querySelectorAll('.breadcrumb-item');

      expect((items[0] as HTMLElement).dataset.path).toBe('/home');
      expect((items[0] as HTMLElement).title).toBe('/home');
      expect((items[1] as HTMLElement).dataset.path).toBe('/home/user');
    });
  });

  describe('showBreadcrumbMenu positioning', () => {
    it('sets menu left/top relative to address-bar-wrapper', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLButtonElement;
      const wrapper = document.querySelector('.address-bar-wrapper') as HTMLElement;

      vi.spyOn(caret, 'getBoundingClientRect').mockReturnValue({
        left: 120,
        right: 140,
        top: 10,
        bottom: 30,
        width: 20,
        height: 20,
        x: 120,
        y: 10,
        toJSON: () => {},
      });
      vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        right: 500,
        top: 0,
        bottom: 50,
        width: 400,
        height: 50,
        x: 100,
        y: 0,
        toJSON: () => {},
      });

      await ctrl.showBreadcrumbMenu('/workspace', caret);

      const menu = document.getElementById('breadcrumb-menu')!;
      expect(menu.style.left).toBe('20px');
      expect(menu.style.top).toBe('34px');
    });
  });

  describe('showBreadcrumbMenu aria state', () => {
    it('sets aria-expanded=true on anchor when opened', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLButtonElement;

      await ctrl.showBreadcrumbMenu('/workspace', caret);
      expect(caret.getAttribute('aria-expanded')).toBe('true');
    });

    it('sets aria-busy=false after loading', async () => {
      const deps = createDeps();
      const ctrl = createNavigationController(deps as any);
      ctrl.updateBreadcrumb('/workspace');

      const container = document.getElementById('breadcrumb-container')!;
      const caret = container.querySelector('.breadcrumb-caret') as HTMLButtonElement;

      await ctrl.showBreadcrumbMenu('/workspace', caret);

      const menu = document.getElementById('breadcrumb-menu')!;
      expect(menu.getAttribute('aria-busy')).toBe('false');
    });
  });
});
