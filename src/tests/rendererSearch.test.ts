import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./shared.js', () => ({
  escapeHtml: (s: string) => s,
  ignoreError: () => {},
}));

vi.mock('./rendererDom.js', () => ({
  clearHtml: vi.fn(),
  getById: vi.fn(() => null),
}));

vi.mock('./rendererUtils.js', () => ({
  twemojiImg: () => '<img>',
}));

vi.mock('./home.js', () => ({
  isHomeViewPath: (p: string) => p === 'home-view',
}));

import { createSearchController } from './rendererSearch';

function createDeps() {
  const settings = {
    enableSearchHistory: true,
    searchHistory: [] as string[],
    maxSearchHistoryItems: 10,
    globalContentSearch: false,
  } as Record<string, unknown>;
  return {
    settings,
    getCurrentPath: vi.fn(() => '/workspace'),
    getCurrentSettings: vi.fn(() => settings),
    setAllFiles: vi.fn(),
    renderFiles: vi.fn(),
    showLoading: vi.fn(),
    hideLoading: vi.fn(),
    updateStatusBar: vi.fn(),
    showToast: vi.fn(),
    createDirectoryOperationId: vi.fn(() => 'op-1'),
    navigateTo: vi.fn(),
    debouncedSaveSettings: vi.fn(),
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
    getFileGrid: vi.fn(() => null),
    searchDebounceMs: 200,
    searchHistoryMax: 5,
  };
}

describe('addToSearchHistory', () => {
  it('adds query to history', () => {
    const deps = createDeps();
    const ctrl = createSearchController(deps as any);
    ctrl.addToSearchHistory('hello');
    expect(deps.settings.searchHistory).toContain('hello');
    expect(deps.debouncedSaveSettings).toHaveBeenCalled();
  });

  it('deduplicates existing entries', () => {
    const deps = createDeps();
    deps.settings.searchHistory = ['world', 'hello', 'foo'];
    const ctrl = createSearchController(deps as any);
    ctrl.addToSearchHistory('hello');
    const hist = deps.settings.searchHistory as string[];
    expect(hist[0]).toBe('hello');
    expect(hist.filter((q: string) => q === 'hello').length).toBe(1);
  });

  it('caps history to maxSearchHistoryItems', () => {
    const deps = createDeps();
    deps.settings.searchHistory = ['a', 'b', 'c', 'd', 'e'];
    deps.settings.maxSearchHistoryItems = 3;
    const ctrl = createSearchController(deps as any);
    ctrl.addToSearchHistory('new');
    const hist = deps.settings.searchHistory as string[];
    expect(hist.length).toBe(3);
    expect(hist[0]).toBe('new');
  });

  it('does nothing if enableSearchHistory is false', () => {
    const deps = createDeps();
    deps.settings.enableSearchHistory = false;
    const ctrl = createSearchController(deps as any);
    ctrl.addToSearchHistory('ignore');
    expect((deps.settings.searchHistory as string[]).length).toBe(0);
    expect(deps.debouncedSaveSettings).not.toHaveBeenCalled();
  });

  it('skips empty/whitespace query', () => {
    const deps = createDeps();
    const ctrl = createSearchController(deps as any);
    ctrl.addToSearchHistory('   ');
    expect((deps.settings.searchHistory as string[]).length).toBe(0);
  });

  it('initializes searchHistory array if missing', () => {
    const deps = createDeps();
    delete deps.settings.searchHistory;
    const ctrl = createSearchController(deps as any);
    ctrl.addToSearchHistory('first');
    expect(deps.settings.searchHistory).toEqual(['first']);
  });

  it('clamps maxSearchHistoryItems between 1 and 20', () => {
    const deps = createDeps();

    deps.settings.maxSearchHistoryItems = -5;
    const ctrl = createSearchController(deps as any);
    ctrl.addToSearchHistory('x');
    ctrl.addToSearchHistory('y');
    const hist = deps.settings.searchHistory as string[];
    expect(hist.length).toBe(1);
    expect(hist[0]).toBe('y');
  });
});

describe('getStatusText', () => {
  it('returns inactive when not in search mode', () => {
    const deps = createDeps();
    const ctrl = createSearchController(deps as any);
    const status = ctrl.getStatusText();
    expect(status.active).toBe(false);
    expect(status.text).toBe('');
  });
});

describe('isSearchMode / isGlobalSearch', () => {
  it('defaults to false', () => {
    const deps = createDeps();
    const ctrl = createSearchController(deps as any);
    expect(ctrl.isSearchMode()).toBe(false);
    expect(ctrl.isGlobalSearch()).toBe(false);
  });
});

describe('getQuery / setQuery', () => {
  it('returns empty when no input element', () => {
    const deps = createDeps();
    const ctrl = createSearchController(deps as any);
    expect(ctrl.getQuery()).toBe('');
  });

  it('setQuery does not throw when no input element', () => {
    const deps = createDeps();
    const ctrl = createSearchController(deps as any);
    expect(() => ctrl.setQuery('test')).not.toThrow();
  });
});

describe('cancelActiveSearch', () => {
  it('does not throw when no active search', () => {
    const deps = createDeps();
    const ctrl = createSearchController(deps as any);
    expect(() => ctrl.cancelActiveSearch()).not.toThrow();
  });
});
