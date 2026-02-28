// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FileItem, Settings } from '../types';

vi.mock('../rendererUtils.js', () => ({
  twemojiImg: (emoji: string, cls: string) => `<img class="${cls}" alt="${emoji}">`,
}));

import { createFileRenderController } from '../rendererFileRender';

function makeItem(overrides: Partial<FileItem> = {}): FileItem {
  return {
    name: 'file.txt',
    path: '/home/user/file.txt',
    isDirectory: false,
    isFile: true,
    size: 1024,
    modified: new Date('2025-01-01T00:00:00Z'),
    isHidden: false,
    ...overrides,
  };
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    shortcuts: {},
    theme: 'dark',
    useSystemTheme: false,
    sortBy: 'name',
    sortOrder: 'asc',
    bookmarks: [],
    viewMode: 'grid',
    showDangerousOptions: false,
    startupPath: '',
    showHiddenFiles: true,
    enableSearchHistory: false,
    searchHistory: [],
    savedSearches: [],
    directoryHistory: [],
    enableIndexer: false,
    minimizeToTray: false,
    startOnLogin: false,
    autoCheckUpdates: false,
    showRecentFiles: false,
    showFolderTree: false,
    useLegacyTreeSpacing: false,
    enableTabs: false,
    globalContentSearch: false,
    globalClipboard: false,
    enableSyntaxHighlighting: false,
    enableGitStatus: false,
    gitIncludeUntracked: false,
    showFileHoverCard: false,
    showFileCheckboxes: false,
    reduceMotion: false,
    highContrast: false,
    largeText: false,
    boldText: false,
    visibleFocus: false,
    reduceTransparency: false,
    liquidGlassMode: false,
    uiDensity: 'default',
    updateChannel: 'stable',
    themedIcons: false,
    disableHardwareAcceleration: false,
    useSystemFontSize: false,
    confirmFileOperations: true,
    fileConflictBehavior: 'ask',
    skipElevationConfirmation: false,
    maxThumbnailSizeMB: 10,
    thumbnailQuality: 'medium',
    autoPlayVideos: false,
    previewPanelPosition: 'right',
    maxPreviewSizeMB: 50,
    gridColumns: 'auto',
    iconSize: 64,
    compactFileInfo: false,
    showFileExtensions: true,
    maxSearchHistoryItems: 20,
    maxDirectoryHistoryItems: 20,
    ...overrides,
  };
}

function createMockConfig() {
  const fileElementMap = new Map<string, HTMLElement>();
  let hiddenFilesCount = 0;

  return {
    getFileGrid: vi.fn(() => document.getElementById('file-grid')),
    getEmptyState: vi.fn(() => document.getElementById('empty-state')),
    getCurrentSettings: vi.fn(() => makeSettings()),
    getFileElementMap: vi.fn(() => fileElementMap),
    showToast: vi.fn(),
    clearSelection: vi.fn(),
    updateStatusBar: vi.fn(),
    markSelectionDirty: vi.fn(),
    setHiddenFilesCount: vi.fn((count: number) => {
      hiddenFilesCount = count;
    }),
    getHiddenFilesCount: vi.fn(() => hiddenFilesCount),
    setAllFiles: vi.fn(),
    setDisableEntryAnimation: vi.fn(),
    setDisableThumbnailRendering: vi.fn(),
    ensureActiveItem: vi.fn(),
    applyGitIndicatorsToPaths: vi.fn(),
    updateCutVisuals: vi.fn(),
    clearCutPaths: vi.fn(),
    clearGitCache: vi.fn(),
    observeThumbnailItem: vi.fn(),
    resetThumbnailObserver: vi.fn(),
    getFolderIcon: vi.fn(() => '<img class="twemoji" alt="📁">'),
    nameCollator: new Intl.Collator('en', { sensitivity: 'base' }),
    dateFormatter: new Intl.DateTimeFormat('en-US'),
    _fileElementMap: fileElementMap,
  };
}

describe('createFileRenderController', () => {
  beforeEach(() => {
    // IntersectionObserver is not available in jsdom
    if (typeof IntersectionObserver === 'undefined') {
      (globalThis as any).IntersectionObserver = class {
        constructor() {}
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
    document.body.innerHTML = `
      <div id="file-view">
        <div id="file-grid"></div>
      </div>
      <div id="empty-state" style="display:none">
        <p>This folder is empty</p>
        <div class="empty-actions"></div>
        <div class="empty-hint"></div>
      </div>
    `;
  });

  describe('createFileItem', () => {
    it('creates a DOM element for a file', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const item = makeItem({ name: 'document.txt', path: '/home/user/document.txt' });

      const el = ctrl.createFileItem(item);

      expect(el.tagName).toBe('DIV');
      expect(el.classList.contains('file-item')).toBe(true);
      expect(el.dataset.path).toBe('/home/user/document.txt');
      expect(el.dataset.isDirectory).toBe('false');
      expect(el.getAttribute('role')).toBe('option');
      expect(el.getAttribute('aria-selected')).toBe('false');
      expect(el.getAttribute('aria-label')).toBe('document.txt');
      expect(el.draggable).toBe(true);
    });

    it('creates a DOM element for a directory', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const item = makeItem({
        name: 'Projects',
        path: '/home/user/Projects',
        isDirectory: true,
        isFile: false,
        size: 0,
      });

      const el = ctrl.createFileItem(item);

      expect(el.dataset.isDirectory).toBe('true');
      expect(config.getFolderIcon).toHaveBeenCalledWith('/home/user/Projects');
    });

    it('shows file size for files and "--" for directories', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);

      const file = ctrl.createFileItem(makeItem({ size: 2048 }));
      const dir = ctrl.createFileItem(
        makeItem({ isDirectory: true, isFile: false, name: 'dir', path: '/dir' })
      );

      const fileSize = file.querySelector('.file-size');
      const dirSize = dir.querySelector('.file-size');
      expect(fileSize?.textContent).toBe('2 KB');
      expect(dirSize?.textContent).toBe('--');
    });

    it('hides file extension when showFileExtensions is false', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(makeSettings({ showFileExtensions: false }));
      const ctrl = createFileRenderController(config);

      const el = ctrl.createFileItem(makeItem({ name: 'report.pdf', path: '/report.pdf' }));

      const fileName = el.querySelector('.file-name');
      expect(fileName?.textContent).toBe('report');
    });

    it('shows full file name when showFileExtensions is true', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(makeSettings({ showFileExtensions: true }));
      const ctrl = createFileRenderController(config);

      const el = ctrl.createFileItem(makeItem({ name: 'report.pdf', path: '/report.pdf' }));

      const fileName = el.querySelector('.file-name');
      expect(fileName?.textContent).toBe('report.pdf');
    });

    it('renders match context for content search results', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const item = {
        ...makeItem({ name: 'code.ts', path: '/code.ts' }),
        matchContext: 'function hello world',
        matchLineNumber: 42,
      };

      const el = ctrl.createFileItem(item, 'hello');

      const matchCtx = el.querySelector('.match-context');
      expect(matchCtx).not.toBeNull();
      expect(matchCtx?.innerHTML).toContain('match-highlight');
      expect(matchCtx?.innerHTML).toContain('Line 42');
    });

    it('sets thumbnail attributes for image files', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const item = makeItem({ name: 'photo.jpg', path: '/photo.jpg' });

      const el = ctrl.createFileItem(item);

      expect(el.classList.contains('has-thumbnail')).toBe(true);
      expect(el.dataset.thumbnailType).toBe('image');
      expect(config.observeThumbnailItem).toHaveBeenCalledWith(el);
    });

    it('sets thumbnail attributes for video files', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const item = makeItem({ name: 'clip.mp4', path: '/clip.mp4' });

      const el = ctrl.createFileItem(item);

      expect(el.classList.contains('has-thumbnail')).toBe(true);
      expect(el.dataset.thumbnailType).toBe('video');
    });

    it('does not set thumbnail for non-media files', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const item = makeItem({ name: 'readme.md', path: '/readme.md' });

      const el = ctrl.createFileItem(item);

      expect(el.classList.contains('has-thumbnail')).toBe(false);
      expect(el.dataset.thumbnailType).toBeUndefined();
    });

    it('sets type display for directories as "Folder"', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const item = makeItem({
        name: 'src',
        path: '/src',
        isDirectory: true,
        isFile: false,
      });

      const el = ctrl.createFileItem(item);

      const typeEl = el.querySelector('.file-type');
      expect(typeEl?.textContent).toBe('Folder');
    });
  });

  describe('renderFiles', () => {
    it('renders items into the file grid', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const items = [
        makeItem({ name: 'a.txt', path: '/a.txt' }),
        makeItem({ name: 'b.txt', path: '/b.txt' }),
      ];

      ctrl.renderFiles(items);

      const grid = document.getElementById('file-grid')!;
      const fileItems = grid.querySelectorAll('.file-item');
      expect(fileItems.length).toBe(2);
    });

    it('shows empty state when no visible items exist', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);

      ctrl.renderFiles([]);

      const emptyState = document.getElementById('empty-state')!;
      expect(emptyState.style.display).toBe('flex');
      expect(config.updateStatusBar).toHaveBeenCalled();
    });

    it('shows search-specific empty text when searchQuery is provided', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);

      ctrl.renderFiles([], 'missing-file');

      const emptyText = document.querySelector('#empty-state p');
      expect(emptyText?.textContent).toBe('No files matching your search');
    });

    it('hides hidden files when showHiddenFiles is false', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(makeSettings({ showHiddenFiles: false }));
      const ctrl = createFileRenderController(config);
      const items = [
        makeItem({ name: '.hidden', path: '/.hidden', isHidden: true }),
        makeItem({ name: 'visible.txt', path: '/visible.txt', isHidden: false }),
      ];

      ctrl.renderFiles(items);

      const grid = document.getElementById('file-grid')!;
      const fileItems = grid.querySelectorAll('.file-item');
      expect(fileItems.length).toBe(1);
    });

    it('shows hidden files when showHiddenFiles is true', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(makeSettings({ showHiddenFiles: true }));
      const ctrl = createFileRenderController(config);
      const items = [
        makeItem({ name: '.hidden', path: '/.hidden', isHidden: true }),
        makeItem({ name: 'visible.txt', path: '/visible.txt', isHidden: false }),
      ];

      ctrl.renderFiles(items);

      const grid = document.getElementById('file-grid')!;
      const fileItems = grid.querySelectorAll('.file-item');
      expect(fileItems.length).toBe(2);
    });

    it('clears previous items before rendering new ones', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);

      ctrl.renderFiles([makeItem({ name: 'old.txt', path: '/old.txt' })]);
      ctrl.renderFiles([makeItem({ name: 'new.txt', path: '/new.txt' })]);

      const grid = document.getElementById('file-grid')!;
      const fileItems = grid.querySelectorAll('.file-item');
      expect(fileItems.length).toBe(1);
      expect(fileItems[0].getAttribute('data-path')).toBe('/new.txt');
    });

    it('calls clearSelection and setAllFiles', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const items = [makeItem()];

      ctrl.renderFiles(items);

      expect(config.clearSelection).toHaveBeenCalled();
      expect(config.setAllFiles).toHaveBeenCalledWith(items);
    });

    it('sorts directories before files', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const items = [
        makeItem({ name: 'file.txt', path: '/file.txt', isDirectory: false }),
        makeItem({
          name: 'folder',
          path: '/folder',
          isDirectory: true,
          isFile: false,
          size: 0,
        }),
      ];

      ctrl.renderFiles(items);

      const grid = document.getElementById('file-grid')!;
      const fileItems = grid.querySelectorAll('.file-item');
      expect(fileItems[0].getAttribute('data-path')).toBe('/folder');
      expect(fileItems[1].getAttribute('data-path')).toBe('/file.txt');
    });

    it('sorts items by name ascending by default', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(makeSettings({ sortBy: 'name', sortOrder: 'asc' }));
      const ctrl = createFileRenderController(config);
      const items = [
        makeItem({ name: 'banana.txt', path: '/banana.txt' }),
        makeItem({ name: 'apple.txt', path: '/apple.txt' }),
        makeItem({ name: 'cherry.txt', path: '/cherry.txt' }),
      ];

      ctrl.renderFiles(items);

      const grid = document.getElementById('file-grid')!;
      const paths = Array.from(grid.querySelectorAll('.file-item')).map((el) =>
        el.getAttribute('data-path')
      );
      expect(paths).toEqual(['/apple.txt', '/banana.txt', '/cherry.txt']);
    });

    it('sorts items by name descending', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(
        makeSettings({ sortBy: 'name', sortOrder: 'desc' })
      );
      const ctrl = createFileRenderController(config);
      const items = [
        makeItem({ name: 'apple.txt', path: '/apple.txt' }),
        makeItem({ name: 'cherry.txt', path: '/cherry.txt' }),
        makeItem({ name: 'banana.txt', path: '/banana.txt' }),
      ];

      ctrl.renderFiles(items);

      const grid = document.getElementById('file-grid')!;
      const paths = Array.from(grid.querySelectorAll('.file-item')).map((el) =>
        el.getAttribute('data-path')
      );
      expect(paths).toEqual(['/cherry.txt', '/banana.txt', '/apple.txt']);
    });

    it('sorts items by size', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(makeSettings({ sortBy: 'size', sortOrder: 'asc' }));
      const ctrl = createFileRenderController(config);
      const items = [
        makeItem({ name: 'large.txt', path: '/large.txt', size: 9999 }),
        makeItem({ name: 'small.txt', path: '/small.txt', size: 10 }),
        makeItem({ name: 'medium.txt', path: '/medium.txt', size: 500 }),
      ];

      ctrl.renderFiles(items);

      const grid = document.getElementById('file-grid')!;
      const paths = Array.from(grid.querySelectorAll('.file-item')).map((el) =>
        el.getAttribute('data-path')
      );
      expect(paths).toEqual(['/small.txt', '/medium.txt', '/large.txt']);
    });

    it('sorts items by date', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(makeSettings({ sortBy: 'date', sortOrder: 'asc' }));
      const ctrl = createFileRenderController(config);
      const items = [
        makeItem({ name: 'newest.txt', path: '/newest.txt', modified: new Date('2025-03-01') }),
        makeItem({ name: 'oldest.txt', path: '/oldest.txt', modified: new Date('2024-01-01') }),
        makeItem({ name: 'middle.txt', path: '/middle.txt', modified: new Date('2024-06-15') }),
      ];

      ctrl.renderFiles(items);

      const grid = document.getElementById('file-grid')!;
      const paths = Array.from(grid.querySelectorAll('.file-item')).map((el) =>
        el.getAttribute('data-path')
      );
      expect(paths).toEqual(['/oldest.txt', '/middle.txt', '/newest.txt']);
    });

    it('shows large folder toast for 10000+ items', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const items = Array.from({ length: 10000 }, (_, i) =>
        makeItem({ name: `file${i}.txt`, path: `/file${i}.txt` })
      );

      ctrl.renderFiles(items);

      expect(config.showToast).toHaveBeenCalledWith(
        expect.stringContaining('10,000'),
        'Large Folder',
        'warning'
      );
    });

    it('does not show large folder toast for small folders', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const items = [makeItem()];

      ctrl.renderFiles(items);

      expect(config.showToast).not.toHaveBeenCalled();
    });

    it('applies performance-mode class for large item counts', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const items = Array.from({ length: 2400 }, (_, i) =>
        makeItem({ name: `f${i}.txt`, path: `/f${i}.txt` })
      );

      ctrl.renderFiles(items);

      expect(document.body.classList.contains('performance-mode')).toBe(true);
    });

    it('does not apply performance-mode class for small item counts', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);

      ctrl.renderFiles([makeItem()]);

      expect(document.body.classList.contains('performance-mode')).toBe(false);
    });

    it('disables entry animation for more than 160 items', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const items = Array.from({ length: 161 }, (_, i) =>
        makeItem({ name: `f${i}.txt`, path: `/f${i}.txt` })
      );

      ctrl.renderFiles(items);

      expect(config.setDisableEntryAnimation).toHaveBeenCalledWith(true);
    });

    it('disables thumbnail rendering for 1200+ items', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const items = Array.from({ length: 1200 }, (_, i) =>
        makeItem({ name: `f${i}.txt`, path: `/f${i}.txt` })
      );

      ctrl.renderFiles(items);

      expect(config.setDisableThumbnailRendering).toHaveBeenCalledWith(true);
    });

    it('clears git cache and cut paths on render', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);

      ctrl.renderFiles([makeItem()]);

      expect(config.clearGitCache).toHaveBeenCalled();
      expect(config.clearCutPaths).toHaveBeenCalled();
    });
  });

  describe('appendFileItems', () => {
    it('appends items to existing grid content', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const grid = document.getElementById('file-grid')!;

      const existing = document.createElement('div');
      existing.className = 'file-item';
      existing.dataset.path = '/existing.txt';
      grid.appendChild(existing);

      ctrl.appendFileItems([makeItem({ name: 'new.txt', path: '/new.txt' })]);

      expect(grid.querySelectorAll('.file-item').length).toBe(2);
    });

    it('registers items in the file element map', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);

      ctrl.appendFileItems([makeItem({ name: 'test.txt', path: '/test.txt' })]);

      expect(config._fileElementMap.has('/test.txt')).toBe(true);
    });

    it('returns paths of appended items', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const items = [
        makeItem({ name: 'a.txt', path: '/a.txt' }),
        makeItem({ name: 'b.txt', path: '/b.txt' }),
      ];

      const paths = ctrl.appendFileItems(items);

      expect(paths).toEqual(['/a.txt', '/b.txt']);
    });

    it('returns empty array when file grid is missing', () => {
      const config = createMockConfig();
      config.getFileGrid.mockReturnValue(null);
      const ctrl = createFileRenderController(config);

      const paths = ctrl.appendFileItems([makeItem()]);

      expect(paths).toEqual([]);
    });
  });

  describe('getFileItemData', () => {
    it('returns FileItem for a rendered element', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const item = makeItem({ name: 'test.txt', path: '/test.txt' });

      ctrl.renderFiles([item]);

      const grid = document.getElementById('file-grid')!;
      const el = grid.querySelector('.file-item') as HTMLElement;
      const data = ctrl.getFileItemData(el);

      expect(data).not.toBeNull();
      expect(data!.name).toBe('test.txt');
      expect(data!.path).toBe('/test.txt');
    });

    it('returns null for an element without data-path', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);

      const el = document.createElement('div');
      const data = ctrl.getFileItemData(el);

      expect(data).toBeNull();
    });

    it('returns null for an element with unknown path', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);

      ctrl.renderFiles([makeItem()]);

      const el = document.createElement('div');
      el.dataset.path = '/nonexistent.txt';
      const data = ctrl.getFileItemData(el);

      expect(data).toBeNull();
    });
  });

  describe('getFilePathMap', () => {
    it('returns a map of paths to FileItems after render', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const items = [
        makeItem({ name: 'a.txt', path: '/a.txt' }),
        makeItem({ name: 'b.txt', path: '/b.txt' }),
      ];

      ctrl.renderFiles(items);

      const map = ctrl.getFilePathMap();
      expect(map.size).toBe(2);
      expect(map.has('/a.txt')).toBe(true);
      expect(map.has('/b.txt')).toBe(true);
    });

    it('clears map on new render', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);

      ctrl.renderFiles([makeItem({ name: 'old.txt', path: '/old.txt' })]);
      ctrl.renderFiles([makeItem({ name: 'new.txt', path: '/new.txt' })]);

      const map = ctrl.getFilePathMap();
      expect(map.size).toBe(1);
      expect(map.has('/new.txt')).toBe(true);
      expect(map.has('/old.txt')).toBe(false);
    });
  });

  describe('resetVirtualizedRender', () => {
    it('can be called without errors before any render', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);

      expect(() => ctrl.resetVirtualizedRender()).not.toThrow();
    });

    it('can be called after a render without errors', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);

      ctrl.renderFiles([makeItem()]);

      expect(() => ctrl.resetVirtualizedRender()).not.toThrow();
    });
  });

  describe('disconnectVirtualizedObserver', () => {
    it('can be called without errors', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);

      expect(() => ctrl.disconnectVirtualizedObserver()).not.toThrow();
    });
  });
});
