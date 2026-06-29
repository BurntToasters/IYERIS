// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockTauriAPI = vi.hoisted(() => ({
  getDirectoryContents: vi.fn(),
}));

vi.mock('../shared.js', () => ({
  escapeHtml: (value: string) => value,
  getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  ignoreError: () => {},
}));

vi.mock('../i18n.js', () => ({
  t: (key: string) => key,
}));

vi.mock('../rendererUtils.js', () => ({
  rendererPath: {
    basename: (filePath: string) => filePath.split(/[\\/]/).pop() || '',
    dirname: (filePath: string) => {
      const idx = filePath.lastIndexOf('/');
      return idx <= 0 ? '/' : filePath.slice(0, idx);
    },
    extname: (filePath: string) => {
      const base = filePath.split(/[\\/]/).pop() || '';
      const idx = base.lastIndexOf('.');
      return idx > 0 ? base.slice(idx) : '';
    },
  },
  openFileWithFeedback: vi.fn(),
}));

vi.mock('../rendererFileIcons.js', () => ({
  formatFileSize: (size: number) => `${size} B`,
  getFileIcon: () => '<span>icon</span>',
}));

vi.mock('../rendererLocalConstants.js', () => ({
  NAME_COLLATOR: new Intl.Collator('en', { sensitivity: 'base' }),
  DATE_FORMATTER: new Intl.DateTimeFormat('en-US'),
}));

import { createDualPaneController } from '../rendererDualPane';
import type { FileItem, Settings } from '../types';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    showHiddenFiles: false,
    sortBy: 'name',
    sortOrder: 'asc',
    dualPaneEnabled: true,
    activePane: 'left',
    ...overrides,
  } as Settings;
}

function createDeps() {
  const settings = makeSettings();
  const selectedItems = new Set<string>();
  const primaryPaneSelected = new Set<string>();
  const secondaryPaneSelected = new Set<string>();

  return {
    getCurrentSettings: () => settings,
    getCurrentPath: () => '/home/user/left',
    getSelectedItems: () => selectedItems,
    setSelectedItems: (value: Set<string>) => {
      selectedItems.clear();
      value.forEach((item) => selectedItems.add(item));
    },
    getPrimaryPaneSelected: () => primaryPaneSelected,
    setPrimaryPaneSelected: (value: Set<string>) => {
      primaryPaneSelected.clear();
      value.forEach((item) => primaryPaneSelected.add(item));
    },
    getSecondaryPaneSelected: () => secondaryPaneSelected,
    setSecondaryPaneSelected: (value: Set<string>) => {
      secondaryPaneSelected.clear();
      value.forEach((item) => secondaryPaneSelected.add(item));
    },
    getFileElementMap: () => new Map<string, HTMLElement>(),
    updateStatusBar: vi.fn(),
    debouncedSaveSettings: vi.fn(),
    showToast: vi.fn(),
    refresh: vi.fn(),
    navigateTo: vi.fn(),
    observeThumbnailItem: vi.fn(),
    showContextMenu: vi.fn(),
    getDragOperation: vi.fn().mockReturnValue('copy' as const),
    getDraggedPaths: vi.fn().mockResolvedValue([]),
    showDropIndicator: vi.fn(),
    hideDropIndicator: vi.fn(),
    scheduleSpringLoad: vi.fn(),
    clearSpringLoad: vi.fn(),
    handleDrop: vi.fn().mockResolvedValue(undefined),
    copySelectedToDestination: vi.fn().mockResolvedValue(true),
    moveSelectedToDestination: vi.fn().mockResolvedValue(true),
    ensureActiveItem: vi.fn(),
    invalidateFileItemsCache: vi.fn(),
  };
}

describe('createDualPaneController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
    document.body.innerHTML = `
      <div id="dual-pane-secondary-list"></div>
      <div id="dual-pane-secondary-path"></div>
    `;
    Object.defineProperty(window, 'tauriAPI', {
      value: { ...mockTauriAPI },
      configurable: true,
      writable: true,
    });
  });

  it('renders secondary pane items and empty state', () => {
    const deps = createDeps();
    const controller = createDualPaneController(deps as any);

    controller.renderSecondaryPaneItems([]);
    expect(document.getElementById('dual-pane-secondary-list')!.textContent).toContain(
      'dualPane.empty'
    );

    const items: FileItem[] = [
      {
        name: 'alpha.txt',
        path: '/home/user/right/alpha.txt',
        isDirectory: false,
        isFile: true,
        size: 12,
        modified: new Date('2025-01-01'),
        isHidden: false,
      },
    ];
    controller.renderSecondaryPaneItems(items);
    const list = document.getElementById('dual-pane-secondary-list')!;
    expect(list.querySelector('.file-item')).toBeTruthy();
    expect(list.textContent).toContain('alpha.txt');
  });

  it('loads secondary pane and toasts on backend failure', async () => {
    const deps = createDeps();
    mockTauriAPI.getDirectoryContents.mockResolvedValue({
      success: false,
      error: 'permission denied',
    });
    const controller = createDualPaneController(deps as any);

    await controller.loadSecondaryPane('/home/user/right');

    expect(deps.showToast).toHaveBeenCalledWith('permission denied', 'dualPane.title', 'error');
  });

  it('switches active pane and persists selection buckets', () => {
    const deps = createDeps();
    deps.getSelectedItems().add('/home/user/left/a.txt');
    const controller = createDualPaneController(deps as any);

    controller.setActivePane('right', false);

    expect(deps.getCurrentSettings().activePane).toBe('right');
    expect(document.body.classList.contains('active-pane-right')).toBe(true);
    expect(deps.getPrimaryPaneSelected().has('/home/user/left/a.txt')).toBe(true);
    expect(deps.invalidateFileItemsCache).toHaveBeenCalled();
    expect(deps.ensureActiveItem).toHaveBeenCalled();
  });
});
