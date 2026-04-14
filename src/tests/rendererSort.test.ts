// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Settings } from '../types';
import { createSortController } from '../rendererSort';
import { SORT_BY_VALUES } from '../constants';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    sortBy: 'name',
    sortOrder: 'asc',
    ...overrides,
  } as Settings;
}

function createMockConfig() {
  const sortBtn = document.createElement('button');
  const settings = makeSettings();
  const allFiles: any[] = [];
  const renderFiles = vi.fn();
  const saveSettingsWithTimestamp = vi.fn().mockResolvedValue(undefined);

  return {
    getSortBtn: () => sortBtn,
    getCurrentSettings: () => settings,
    getAllFiles: () => allFiles,
    saveSettingsWithTimestamp,
    renderFiles,
    _settings: settings,
    _allFiles: allFiles,
  };
}

function makeRect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

function addSortMenuItems(types: string[]): HTMLElement[] {
  const sortMenu = document.getElementById('sort-menu') as HTMLElement;
  sortMenu.innerHTML = types
    .map((type) => `<button class="context-menu-item" data-sort="${type}">${type}</button>`)
    .join('');
  return Array.from(sortMenu.querySelectorAll<HTMLElement>('.context-menu-item'));
}

describe('SORT_BY_VALUES', () => {
  it('contains the expected sort types', () => {
    expect(SORT_BY_VALUES).toEqual(['name', 'date', 'size', 'type']);
  });

  it('is a readonly tuple', () => {
    expect(SORT_BY_VALUES.length).toBe(4);
  });
});

describe('createSortController', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="sort-menu" style="display:none"></div>
      <span id="sort-name"></span>
      <span id="sort-date"></span>
      <span id="sort-size"></span>
      <span id="sort-type"></span>
      <span id="list-sort-name"></span>
      <span id="list-sort-date"></span>
      <span id="list-sort-size"></span>
      <span id="list-sort-type"></span>
      <div class="list-header-cell" data-sort="name"></div>
      <div class="list-header-cell" data-sort="date"></div>
      <div class="list-header-cell" data-sort="size"></div>
      <div class="list-header-cell" data-sort="type"></div>
    `;
  });

  describe('changeSortMode', () => {
    it('sets sortBy and resets order to asc for a new sort type', async () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);

      await ctrl.changeSortMode('date');

      expect(config._settings.sortBy).toBe('date');
      expect(config._settings.sortOrder).toBe('asc');
      expect(config.saveSettingsWithTimestamp).toHaveBeenCalled();
    });

    it('toggles sort order when same sort type is selected', async () => {
      const config = createMockConfig();
      config._settings.sortBy = 'name';
      config._settings.sortOrder = 'asc';
      const ctrl = createSortController(config);

      await ctrl.changeSortMode('name');
      expect(config._settings.sortOrder).toBe('desc');

      await ctrl.changeSortMode('name');
      expect(config._settings.sortOrder).toBe('asc');
    });

    it('ignores invalid sort values', async () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);

      await ctrl.changeSortMode('invalid');
      expect(config.saveSettingsWithTimestamp).not.toHaveBeenCalled();
    });

    it('renders files after sort change when files exist', async () => {
      const config = createMockConfig();
      config._allFiles.push({ name: 'test.txt' });
      const ctrl = createSortController(config);

      await ctrl.changeSortMode('size');
      expect(config.renderFiles).toHaveBeenCalledWith(config._allFiles);
    });

    it('does not render files when allFiles is empty', async () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);

      await ctrl.changeSortMode('size');
      expect(config.renderFiles).not.toHaveBeenCalled();
    });

    it('hides sort menu after changing sort', async () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);
      const sortMenu = document.getElementById('sort-menu')!;
      sortMenu.style.display = 'block';

      await ctrl.changeSortMode('date');
      expect(sortMenu.style.display).toBe('none');
    });
  });

  describe('updateSortIndicators', () => {
    it('shows ascending indicator for active sort column', () => {
      const config = createMockConfig();
      config._settings.sortBy = 'name';
      config._settings.sortOrder = 'asc';
      const ctrl = createSortController(config);

      ctrl.updateSortIndicators();

      expect(document.getElementById('sort-name')!.textContent).toBe('▲');
      expect(document.getElementById('sort-date')!.textContent).toBe('');
    });

    it('shows descending indicator for active sort column', () => {
      const config = createMockConfig();
      config._settings.sortBy = 'size';
      config._settings.sortOrder = 'desc';
      const ctrl = createSortController(config);

      ctrl.updateSortIndicators();

      expect(document.getElementById('sort-size')!.textContent).toBe('▼');
      expect(document.getElementById('sort-name')!.textContent).toBe('');
    });

    it('updates aria-sort attributes on list header cells', () => {
      const config = createMockConfig();
      config._settings.sortBy = 'date';
      config._settings.sortOrder = 'desc';
      const ctrl = createSortController(config);

      ctrl.updateSortIndicators();

      const dateHeader = document.querySelector('[data-sort="date"]')!;
      expect(dateHeader.getAttribute('aria-sort')).toBe('descending');
      const nameHeader = document.querySelector('[data-sort="name"]')!;
      expect(nameHeader.getAttribute('aria-sort')).toBe('none');
    });

    it('updates both sort and list-sort prefixed elements', () => {
      const config = createMockConfig();
      config._settings.sortBy = 'type';
      config._settings.sortOrder = 'asc';
      const ctrl = createSortController(config);

      ctrl.updateSortIndicators();

      expect(document.getElementById('sort-type')!.textContent).toBe('▲');
      expect(document.getElementById('list-sort-type')!.textContent).toBe('▲');
    });
  });

  describe('showSortMenu', () => {
    it('displays the sort menu', () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);
      const sortMenu = document.getElementById('sort-menu')!;

      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'stopPropagation', { value: vi.fn() });

      ctrl.showSortMenu(event);
      expect(sortMenu.style.display).toBe('block');
    });

    it('stops event propagation', () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);

      const stopPropagation = vi.fn();
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'stopPropagation', { value: stopPropagation });

      ctrl.showSortMenu(event);
      expect(stopPropagation).toHaveBeenCalled();
    });

    it('returns early when sort menu element is missing', () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);
      document.getElementById('sort-menu')?.remove();

      const stopPropagation = vi.fn();
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'stopPropagation', { value: stopPropagation });

      ctrl.showSortMenu(event);

      expect(stopPropagation).not.toHaveBeenCalled();
    });

    it('positions and focuses first menu item with aria-expanded true', () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);
      const sortMenu = document.getElementById('sort-menu') as HTMLElement;
      const sortBtn = config.getSortBtn();
      const items = addSortMenuItems(['name', 'size']);

      vi.spyOn(sortBtn, 'getBoundingClientRect').mockReturnValue(
        makeRect({ left: 100, top: 20, bottom: 40, width: 80, right: 180 })
      );
      vi.spyOn(sortMenu, 'getBoundingClientRect').mockReturnValue(
        makeRect({ width: 120, height: 90 })
      );

      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'stopPropagation', { value: vi.fn() });

      ctrl.showSortMenu(event);

      expect(sortMenu.style.left).toBe('100px');
      expect(sortMenu.style.top).toBe('45px');
      expect(sortBtn.getAttribute('aria-expanded')).toBe('true');
      expect(items[0]?.classList.contains('focused')).toBe(true);
      expect(items[0]?.tabIndex).toBe(0);
      expect(items[1]?.tabIndex).toBe(-1);
    });

    it('repositions menu when viewport boundaries would be exceeded', () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);
      const sortMenu = document.getElementById('sort-menu') as HTMLElement;
      const sortBtn = config.getSortBtn();
      addSortMenuItems(['name']);

      Object.defineProperty(window, 'innerWidth', { value: 200, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 120, configurable: true });

      vi.spyOn(sortBtn, 'getBoundingClientRect').mockReturnValue(
        makeRect({ left: 190, top: 20, bottom: 110, width: 10, right: 200 })
      );
      vi.spyOn(sortMenu, 'getBoundingClientRect').mockReturnValue(
        makeRect({ width: 80, height: 80 })
      );

      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'stopPropagation', { value: vi.fn() });
      ctrl.showSortMenu(event);

      expect(sortMenu.style.left).toBe('110px');
      expect(sortMenu.style.top).toBe('10px');
    });
  });

  describe('hideSortMenu', () => {
    it('hides the sort menu', () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);
      const sortMenu = document.getElementById('sort-menu')!;
      sortMenu.style.display = 'block';

      ctrl.hideSortMenu();
      expect(sortMenu.style.display).toBe('none');
    });

    it('clears focused menu items and collapses aria-expanded state', () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);
      const sortMenu = document.getElementById('sort-menu') as HTMLElement;
      addSortMenuItems(['name', 'date']);

      const focusedItem = sortMenu.querySelector('.context-menu-item') as HTMLElement;
      focusedItem.classList.add('focused');
      sortMenu.style.display = 'block';
      config.getSortBtn().setAttribute('aria-expanded', 'true');

      ctrl.hideSortMenu();

      expect(focusedItem.classList.contains('focused')).toBe(false);
      expect(config.getSortBtn().getAttribute('aria-expanded')).toBe('false');
    });
  });

  describe('handleSortMenuKeyNav', () => {
    it('returns false when menu is hidden', () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);
      addSortMenuItems(['name', 'date']);

      const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      expect(ctrl.handleSortMenuKeyNav(event)).toBe(false);
    });

    it('returns false when menu has no items', () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);
      const sortMenu = document.getElementById('sort-menu') as HTMLElement;
      sortMenu.style.display = 'block';

      const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      expect(ctrl.handleSortMenuKeyNav(event)).toBe(false);
    });

    it('supports ArrowDown and ArrowUp navigation with wrapping', () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);
      const sortMenu = document.getElementById('sort-menu') as HTMLElement;
      const items = addSortMenuItems(['name', 'date', 'size']);
      sortMenu.style.display = 'block';

      const down = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      const preventDefaultDown = vi.fn();
      Object.defineProperty(down, 'preventDefault', { value: preventDefaultDown });

      expect(ctrl.handleSortMenuKeyNav(down)).toBe(true);
      expect(preventDefaultDown).toHaveBeenCalled();
      expect(items[0]?.classList.contains('focused')).toBe(true);

      const up = new KeyboardEvent('keydown', { key: 'ArrowUp' });
      const preventDefaultUp = vi.fn();
      Object.defineProperty(up, 'preventDefault', { value: preventDefaultUp });

      expect(ctrl.handleSortMenuKeyNav(up)).toBe(true);
      expect(preventDefaultUp).toHaveBeenCalled();
      expect(items[2]?.classList.contains('focused')).toBe(true);
    });

    it('supports Home and End focus navigation', () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);
      const sortMenu = document.getElementById('sort-menu') as HTMLElement;
      const items = addSortMenuItems(['name', 'date', 'size']);
      sortMenu.style.display = 'block';

      const down = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      Object.defineProperty(down, 'preventDefault', { value: vi.fn() });
      ctrl.handleSortMenuKeyNav(down);

      const end = new KeyboardEvent('keydown', { key: 'End' });
      const preventDefaultEnd = vi.fn();
      Object.defineProperty(end, 'preventDefault', { value: preventDefaultEnd });
      expect(ctrl.handleSortMenuKeyNav(end)).toBe(true);
      expect(preventDefaultEnd).toHaveBeenCalled();
      expect(items[2]?.classList.contains('focused')).toBe(true);

      const home = new KeyboardEvent('keydown', { key: 'Home' });
      const preventDefaultHome = vi.fn();
      Object.defineProperty(home, 'preventDefault', { value: preventDefaultHome });
      expect(ctrl.handleSortMenuKeyNav(home)).toBe(true);
      expect(preventDefaultHome).toHaveBeenCalled();
      expect(items[0]?.classList.contains('focused')).toBe(true);
    });

    it('activates focused sort item on Enter and Space', async () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);
      const sortMenu = document.getElementById('sort-menu') as HTMLElement;
      addSortMenuItems(['size', 'type']);
      sortMenu.style.display = 'block';

      const down = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      Object.defineProperty(down, 'preventDefault', { value: vi.fn() });
      ctrl.handleSortMenuKeyNav(down);

      const enter = new KeyboardEvent('keydown', { key: 'Enter' });
      const preventDefaultEnter = vi.fn();
      Object.defineProperty(enter, 'preventDefault', { value: preventDefaultEnter });
      expect(ctrl.handleSortMenuKeyNav(enter)).toBe(true);
      expect(preventDefaultEnter).toHaveBeenCalled();
      await Promise.resolve();
      expect(config._settings.sortBy).toBe('size');

      sortMenu.style.display = 'block';
      const downAgain = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      Object.defineProperty(downAgain, 'preventDefault', { value: vi.fn() });
      ctrl.handleSortMenuKeyNav(downAgain);

      const space = new KeyboardEvent('keydown', { key: ' ' });
      const preventDefaultSpace = vi.fn();
      Object.defineProperty(space, 'preventDefault', { value: preventDefaultSpace });
      expect(ctrl.handleSortMenuKeyNav(space)).toBe(true);
      expect(preventDefaultSpace).toHaveBeenCalled();
      await Promise.resolve();
      expect(config._settings.sortOrder).toBe('desc');
    });

    it('returns false for unrelated keys', () => {
      const config = createMockConfig();
      const ctrl = createSortController(config);
      const sortMenu = document.getElementById('sort-menu') as HTMLElement;
      addSortMenuItems(['name']);
      sortMenu.style.display = 'block';

      const event = new KeyboardEvent('keydown', { key: 'Tab' });
      expect(ctrl.handleSortMenuKeyNav(event)).toBe(false);
    });
  });
});
