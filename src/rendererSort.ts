import type { Settings } from './types';
import { SORT_BY_VALUES, isOneOf } from './constants.js';

function isOneOfSortBy(value: string): value is (typeof SORT_BY_VALUES)[number] {
  return isOneOf(value, SORT_BY_VALUES);
}

type SortControllerConfig = {
  getSortBtn: () => HTMLElement;
  getCurrentSettings: () => Settings;
  getAllFiles: () => import('./types').FileItem[];
  saveSettingsWithTimestamp: (settings: Settings) => Promise<unknown>;
  renderFiles: (files: import('./types').FileItem[]) => void;
};

export function createSortController(config: SortControllerConfig) {
  function showSortMenu(e: MouseEvent) {
    const sortMenu = document.getElementById('sort-menu');
    if (!sortMenu) return;

    const rect = config.getSortBtn().getBoundingClientRect();
    sortMenu.style.display = 'block';

    const menuRect = sortMenu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = rect.left;
    let top = rect.bottom + 5;

    if (left + menuRect.width > viewportWidth) {
      left = viewportWidth - menuRect.width - 10;
    }

    if (top + menuRect.height > viewportHeight) {
      top = rect.top - menuRect.height - 5;
    }

    if (left < 10) left = 10;
    if (top < 10) top = 10;

    sortMenu.style.left = left + 'px';
    sortMenu.style.top = top + 'px';

    updateSortIndicators();

    e.stopPropagation();
  }

  function hideSortMenu() {
    const sortMenu = document.getElementById('sort-menu');
    if (sortMenu) {
      sortMenu.style.display = 'none';
    }
  }

  function updateSortIndicators() {
    const settings = config.getCurrentSettings();
    ['name', 'date', 'size', 'type'].forEach((sortType) => {
      const text = settings.sortBy === sortType ? (settings.sortOrder === 'asc' ? '▲' : '▼') : '';
      for (const prefix of ['sort', 'list-sort']) {
        const el = document.getElementById(`${prefix}-${sortType}`);
        if (el) el.textContent = text;
      }
    });

    document.querySelectorAll<HTMLElement>('.list-header-cell').forEach((cell) => {
      const sortType = cell.dataset.sort;
      if (!sortType) return;
      const ariaSort =
        settings.sortBy === sortType
          ? settings.sortOrder === 'asc'
            ? 'ascending'
            : 'descending'
          : 'none';
      cell.setAttribute('aria-sort', ariaSort);
    });
  }

  async function changeSortMode(sortBy: string) {
    if (!isOneOfSortBy(sortBy)) {
      return;
    }
    const settings = config.getCurrentSettings();
    if (settings.sortBy === sortBy) {
      settings.sortOrder = settings.sortOrder === 'asc' ? 'desc' : 'asc';
    } else {
      settings.sortBy = sortBy;
      settings.sortOrder = 'asc';
    }

    await config.saveSettingsWithTimestamp(settings);
    hideSortMenu();
    updateSortIndicators();

    const allFiles = config.getAllFiles();
    if (allFiles.length > 0) {
      config.renderFiles(allFiles);
    }
  }

  return { showSortMenu, hideSortMenu, updateSortIndicators, changeSortMode };
}
