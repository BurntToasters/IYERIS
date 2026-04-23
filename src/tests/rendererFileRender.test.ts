// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FileItem, Settings } from '../types';

vi.mock('../rendererUtils.js', () => ({
  twemojiImg: (emoji: string, cls: string) => `<img class="${cls}" alt="${emoji}">`,
}));

import { createFileRenderController } from '../rendererFileRender';
import * as rendererFileIcons from '../rendererFileIcons';

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

    it('uses app-bundle icon path and application type for app bundles', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const item = makeItem({
        name: 'Example.app',
        path: '/Applications/Example.app',
        isDirectory: true,
        isFile: false,
        isAppBundle: true,
      });

      const el = ctrl.createFileItem(item);

      expect(el.dataset.isAppBundle).toBe('true');
      expect(el.querySelector('.file-type')?.textContent).toBe('Application');
      expect(config.getFolderIcon).not.toHaveBeenCalled();
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

    it('sets thumbnail attributes for office files', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const item = makeItem({ name: 'document.docx', path: '/document.docx' });

      const el = ctrl.createFileItem(item);

      expect(el.classList.contains('has-thumbnail')).toBe(true);
      expect(el.dataset.thumbnailType).toBe('office');
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

    it('sets shortcut dataset and type label', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const item = makeItem({
        name: 'My Shortcut.lnk',
        path: '/My Shortcut.lnk',
        isShortcut: true,
      });

      const el = ctrl.createFileItem(item);

      expect(el.dataset.isShortcut).toBe('true');
      expect(el.querySelector('.file-type')?.textContent).toBe('Shortcut');
    });

    it('sets desktop-entry dataset and application type label', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const item = makeItem({
        name: 'App.desktop',
        path: '/App.desktop',
        isDesktopEntry: true,
      });

      const el = ctrl.createFileItem(item);

      expect(el.dataset.isDesktopEntry).toBe('true');
      expect(el.querySelector('.file-type')?.textContent).toBe('Application');
    });

    it('renders symlink badge when item is symlink', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const item = makeItem({
        name: 'link.txt',
        path: '/link.txt',
        isSymlink: true,
      });

      const el = ctrl.createFileItem(item);

      expect(el.querySelector('.symlink-badge')).toBeTruthy();
    });

    it('keeps leading-dot filename visible when extension hiding is enabled', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(makeSettings({ showFileExtensions: false }));
      const ctrl = createFileRenderController(config);

      const el = ctrl.createFileItem(makeItem({ name: '.env', path: '/.env' }));

      expect(el.querySelector('.file-name')?.textContent).toBe('.env');
    });

    it('renders plain-text icon fallback when icon markup has no element root', () => {
      const config = createMockConfig();
      const iconSpy = vi.spyOn(rendererFileIcons, 'getFileIcon').mockReturnValue('PLAIN_ICON');
      const ctrl = createFileRenderController(config);

      const el = ctrl.createFileItem(makeItem({ name: 'plain.bin', path: '/plain.bin' }));

      expect(el.querySelector('.file-icon')?.textContent).toContain('PLAIN_ICON');
      iconSpy.mockRestore();
    });

    it('omits match line number markup when not provided', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const item = {
        ...makeItem({ name: 'code.ts', path: '/code.ts' }),
        matchContext: 'function hello world',
      };

      const el = ctrl.createFileItem(item, 'hello');

      const matchCtx = el.querySelector('.match-context');
      expect(matchCtx?.innerHTML).not.toContain('match-line-number');
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

    it('handles empty render when empty-state element is absent', () => {
      const config = createMockConfig();
      config.getEmptyState.mockReturnValue(null);
      const ctrl = createFileRenderController(config);

      expect(() => ctrl.renderFiles([])).not.toThrow();
      expect(config.updateStatusBar).toHaveBeenCalled();
    });

    it('returns early when file grid is missing', () => {
      const config = createMockConfig();
      config.getFileGrid.mockReturnValue(null);
      const ctrl = createFileRenderController(config);

      expect(() => ctrl.renderFiles([makeItem()])).not.toThrow();
      expect(config.clearSelection).not.toHaveBeenCalled();
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

    it('sorts by date when modified values are strings', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(makeSettings({ sortBy: 'date', sortOrder: 'asc' }));
      const ctrl = createFileRenderController(config);
      const items = [
        makeItem({ name: 'new.txt', path: '/new.txt', modified: '2025-03-01T00:00:00Z' as any }),
        makeItem({ name: 'old.txt', path: '/old.txt', modified: '2024-01-01T00:00:00Z' as any }),
      ];

      ctrl.renderFiles(items);

      const grid = document.getElementById('file-grid')!;
      const paths = Array.from(grid.querySelectorAll('.file-item')).map((el) =>
        el.getAttribute('data-path')
      );
      expect(paths).toEqual(['/old.txt', '/new.txt']);
    });

    it('sorts by type extension when sortBy is type', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(makeSettings({ sortBy: 'type', sortOrder: 'asc' }));
      const ctrl = createFileRenderController(config);
      const items = [
        makeItem({ name: 'z.txt', path: '/z.txt' }),
        makeItem({ name: 'a.jpg', path: '/a.jpg' }),
        makeItem({ name: 'b.mp3', path: '/b.mp3' }),
      ];

      ctrl.renderFiles(items);

      const grid = document.getElementById('file-grid')!;
      const paths = Array.from(grid.querySelectorAll('.file-item')).map((el) =>
        el.getAttribute('data-path')
      );
      expect(paths).toEqual(['/a.jpg', '/b.mp3', '/z.txt']);
    });

    it('falls back to name sorting when sortBy is unknown', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(makeSettings({ sortBy: 'weird' as any }));
      const ctrl = createFileRenderController(config);
      const items = [
        makeItem({ name: 'banana.txt', path: '/banana.txt' }),
        makeItem({ name: 'apple.txt', path: '/apple.txt' }),
      ];

      ctrl.renderFiles(items);

      const grid = document.getElementById('file-grid')!;
      const paths = Array.from(grid.querySelectorAll('.file-item')).map((el) =>
        el.getAttribute('data-path')
      );
      expect(paths).toEqual(['/apple.txt', '/banana.txt']);
    });

    it('falls back to default name+asc when sort settings are empty', () => {
      const config = createMockConfig();
      config.getCurrentSettings.mockReturnValue(
        makeSettings({ sortBy: '' as any, sortOrder: '' as any })
      );
      const ctrl = createFileRenderController(config);
      const items = [
        makeItem({ name: 'banana.txt', path: '/banana.txt' }),
        makeItem({ name: 'apple.txt', path: '/apple.txt' }),
      ];

      ctrl.renderFiles(items);

      const grid = document.getElementById('file-grid')!;
      const paths = Array.from(grid.querySelectorAll('.file-item')).map((el) =>
        el.getAttribute('data-path')
      );
      expect(paths).toEqual(['/apple.txt', '/banana.txt']);
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

    it('does not add thumbnail hooks when thumbnail rendering is disabled for huge lists', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const items = Array.from({ length: 1200 }, (_, i) =>
        makeItem({ name: `image${i}.jpg`, path: `/image${i}.jpg` })
      );

      ctrl.renderFiles(items);

      const first = document.querySelector('.file-item') as HTMLElement;
      expect(first.classList.contains('has-thumbnail')).toBe(false);
      expect(config.observeThumbnailItem).not.toHaveBeenCalled();
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

    it('disconnects observer and removes sentinel when virtualized render is reset', () => {
      const observe = vi.fn();
      const disconnect = vi.fn();

      class MockIntersectionObserver {
        constructor() {}
        observe = observe;
        unobserve = vi.fn();
        disconnect = disconnect;
      }

      const original = (globalThis as any).IntersectionObserver;
      (globalThis as any).IntersectionObserver = MockIntersectionObserver;

      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const items = Array.from({ length: 1200 }, (_, i) =>
        makeItem({ name: `item${i}.txt`, path: `/item${i}.txt` })
      );
      ctrl.renderFiles(items);
      expect(document.querySelector('#file-grid > div[style*="height: 1px"]')).toBeTruthy();

      ctrl.resetVirtualizedRender();

      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(document.querySelector('#file-grid > div[style*="height: 1px"]')).toBeFalsy();

      if (original) {
        (globalThis as any).IntersectionObserver = original;
      } else {
        delete (globalThis as any).IntersectionObserver;
      }
    });
  });

  describe('disconnectVirtualizedObserver', () => {
    it('can be called without errors', () => {
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);

      expect(() => ctrl.disconnectVirtualizedObserver()).not.toThrow();
    });

    it('disconnects active virtualized observer', () => {
      const observe = vi.fn();
      const unobserve = vi.fn();
      const disconnect = vi.fn();
      const originalIntersectionObserver = globalThis.IntersectionObserver;

      class MockIntersectionObserver {
        constructor() {}
        observe = observe;
        unobserve = unobserve;
        disconnect = disconnect;
      }

      (globalThis as any).IntersectionObserver = MockIntersectionObserver;

      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const items = Array.from({ length: 1200 }, (_, i) =>
        makeItem({ name: `item${i}.txt`, path: `/item${i}.txt` })
      );

      ctrl.renderFiles(items);
      ctrl.disconnectVirtualizedObserver();
      ctrl.disconnectVirtualizedObserver();

      expect(observe).toHaveBeenCalled();
      expect(unobserve).not.toHaveBeenCalled();
      expect(disconnect).toHaveBeenCalledTimes(1);

      if (originalIntersectionObserver) {
        (globalThis as any).IntersectionObserver = originalIntersectionObserver;
      } else {
        delete (globalThis as any).IntersectionObserver;
      }
    });
  });

  describe('virtualized rendering', () => {
    it('appends additional batches through observer intersections and cleans sentinel at end', () => {
      const observe = vi.fn();
      const unobserve = vi.fn();
      const disconnect = vi.fn();
      let callback:
        | ((entries: Array<{ isIntersecting: boolean; target: Element }>) => void)
        | null = null;
      let observedTarget: Element | null = null;
      const original = (globalThis as any).IntersectionObserver;

      class MockIntersectionObserver {
        constructor(cb: typeof callback) {
          callback = cb as any;
        }
        observe = (target: Element) => {
          observedTarget = target;
          observe(target);
        };
        unobserve = unobserve;
        disconnect = disconnect;
      }

      (globalThis as any).IntersectionObserver = MockIntersectionObserver;

      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const items = Array.from({ length: 1200 }, (_, i) =>
        makeItem({ name: `v${i}.txt`, path: `/v${i}.txt` })
      );

      ctrl.renderFiles(items);

      for (let i = 0; i < 12; i++) {
        callback?.([{ isIntersecting: true, target: observedTarget as Element }]);
      }

      const grid = document.getElementById('file-grid')!;
      expect(grid.querySelectorAll('.file-item').length).toBe(1200);
      expect(observe).toHaveBeenCalled();
      expect(unobserve).toHaveBeenCalled();
      expect(document.querySelector('#file-grid > div[style*="height: 1px"]')).toBeFalsy();

      if (original) {
        (globalThis as any).IntersectionObserver = original;
      } else {
        delete (globalThis as any).IntersectionObserver;
      }
    });

    it('handles virtualization when file-view root is missing', () => {
      document.body.innerHTML = `
        <div id="file-grid"></div>
        <div id="empty-state" style="display:none">
          <p>This folder is empty</p>
          <div class="empty-actions"></div>
          <div class="empty-hint"></div>
        </div>
      `;
      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const items = Array.from({ length: 1200 }, (_, i) =>
        makeItem({ name: `x${i}.txt`, path: `/x${i}.txt` })
      );

      expect(() => ctrl.renderFiles(items)).not.toThrow();
      expect(document.querySelectorAll('.file-item').length).toBe(120);
    });
  });

  describe('batch render token guards', () => {
    it('ignores stale requestAnimationFrame batch after a newer render', () => {
      const rafCallbacks: Array<FrameRequestCallback> = [];
      const rafSpy = vi
        .spyOn(globalThis, 'requestAnimationFrame')
        .mockImplementation((cb: FrameRequestCallback) => {
          rafCallbacks.push(cb);
          return 1;
        });

      const config = createMockConfig();
      const ctrl = createFileRenderController(config);
      const firstItems = Array.from({ length: 100 }, (_, i) =>
        makeItem({ name: `old${i}.txt`, path: `/old${i}.txt` })
      );

      ctrl.renderFiles(firstItems);
      ctrl.renderFiles([makeItem({ name: 'new.txt', path: '/new.txt' })]);

      for (const cb of rafCallbacks) {
        cb(0);
      }

      const grid = document.getElementById('file-grid')!;
      const paths = Array.from(grid.querySelectorAll('.file-item')).map((el) =>
        el.getAttribute('data-path')
      );
      expect(paths).toEqual(['/new.txt']);

      rafSpy.mockRestore();
    });
  });
});
