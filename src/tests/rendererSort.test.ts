import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Settings } from './types';
import { createSortController, SORT_BY_VALUES } from './rendererSort';

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
  });
});
