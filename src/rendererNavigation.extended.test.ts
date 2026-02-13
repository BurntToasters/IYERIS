/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./shared.js', () => ({
  escapeHtml: (s: string) => s,
}));

vi.mock('./rendererDom.js', () => ({
  clearHtml: vi.fn(),
  setHtml: vi.fn(),
}));

vi.mock('./rendererUtils.js', () => ({
  twemojiImg: () => '<img>',
}));

import { createNavigationController } from './rendererNavigation';

function createDeps() {
  const settings = {
    enableSearchHistory: true,
    directoryHistory: [] as string[],
    maxDirectoryHistoryItems: 10,
  } as Record<string, unknown>;
  return {
    settings,
    getCurrentPath: vi.fn(() => '/workspace'),
    getCurrentSettings: vi.fn(() => settings),
    getBreadcrumbContainer: vi.fn(() => null),
    getBreadcrumbMenu: vi.fn(() => null),
    getAddressInput: vi.fn(() => null),
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

describe('addToDirectoryHistory', () => {
  it('adds directory path to history', () => {
    const deps = createDeps();
    const ctrl = createNavigationController(deps as any);
    ctrl.addToDirectoryHistory('/home/user/Documents');
    expect(deps.settings.directoryHistory).toContain('/home/user/Documents');
    expect(deps.debouncedSaveSettings).toHaveBeenCalled();
  });

  it('deduplicates existing entries', () => {
    const deps = createDeps();
    deps.settings.directoryHistory = ['/a', '/b', '/c'];
    const ctrl = createNavigationController(deps as any);
    ctrl.addToDirectoryHistory('/b');
    const hist = deps.settings.directoryHistory as string[];
    expect(hist[0]).toBe('/b');
    expect(hist.filter((d: string) => d === '/b').length).toBe(1);
    expect(hist.length).toBe(3);
  });

  it('caps to maxDirectoryHistoryItems', () => {
    const deps = createDeps();
    deps.settings.directoryHistory = ['/a', '/b', '/c', '/d', '/e'];
    deps.settings.maxDirectoryHistoryItems = 3;
    const ctrl = createNavigationController(deps as any);
    ctrl.addToDirectoryHistory('/new');
    const hist = deps.settings.directoryHistory as string[];
    expect(hist.length).toBe(3);
    expect(hist[0]).toBe('/new');
  });

  it('skips when enableSearchHistory is false', () => {
    const deps = createDeps();
    deps.settings.enableSearchHistory = false;
    const ctrl = createNavigationController(deps as any);
    ctrl.addToDirectoryHistory('/foo');
    expect((deps.settings.directoryHistory as string[]).length).toBe(0);
    expect(deps.debouncedSaveSettings).not.toHaveBeenCalled();
  });

  it('skips empty/whitespace path', () => {
    const deps = createDeps();
    const ctrl = createNavigationController(deps as any);
    ctrl.addToDirectoryHistory('  ');
    expect((deps.settings.directoryHistory as string[]).length).toBe(0);
  });

  it('skips home view path', () => {
    const deps = createDeps();
    const ctrl = createNavigationController(deps as any);
    ctrl.addToDirectoryHistory('home-view');
    expect((deps.settings.directoryHistory as string[]).length).toBe(0);
  });

  it('initializes directoryHistory if undefined', () => {
    const deps = createDeps();
    delete deps.settings.directoryHistory;
    const ctrl = createNavigationController(deps as any);
    ctrl.addToDirectoryHistory('/first');
    expect(deps.settings.directoryHistory).toEqual(['/first']);
  });
});

describe('clearDirectoryHistory', () => {
  it('clears history and saves settings', () => {
    const deps = createDeps();
    deps.settings.directoryHistory = ['/a', '/b'];
    const ctrl = createNavigationController(deps as any);
    ctrl.clearDirectoryHistory();
    expect(deps.settings.directoryHistory).toEqual([]);
    expect(deps.saveSettingsWithTimestamp).toHaveBeenCalledWith(deps.settings);
    expect(deps.showToast).toHaveBeenCalledWith('Directory history cleared', 'History', 'success');
  });
});
