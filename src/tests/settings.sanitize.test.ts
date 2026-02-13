import { describe, it, expect } from 'vitest';
import { sanitizeSettings, createDefaultSettings } from '../settings';

describe('sanitizeSettings', () => {
  const defaults = createDefaultSettings();

  describe('non-object input', () => {
    it('returns defaults for null', () => {
      const result = sanitizeSettings(null);
      expect(result.theme).toBe(defaults.theme);
      expect(result.viewMode).toBe(defaults.viewMode);
    });

    it('returns defaults for undefined', () => {
      const result = sanitizeSettings(undefined);
      expect(result.sortBy).toBe(defaults.sortBy);
    });

    it('returns defaults for a string', () => {
      const result = sanitizeSettings('not an object');
      expect(result.theme).toBe(defaults.theme);
    });

    it('returns defaults for a number', () => {
      const result = sanitizeSettings(42);
      expect(result.viewMode).toBe(defaults.viewMode);
    });

    it('returns defaults for an array', () => {
      const result = sanitizeSettings([1, 2, 3]);
      expect(result.sortBy).toBe(defaults.sortBy);
    });

    it('returns defaults for boolean', () => {
      const result = sanitizeSettings(true);
      expect(result.theme).toBe(defaults.theme);
    });
  });

  describe('empty object', () => {
    it('returns all defaults for empty object', () => {
      const result = sanitizeSettings({});
      expect(result.theme).toBe(defaults.theme);
      expect(result.viewMode).toBe(defaults.viewMode);
      expect(result.sortBy).toBe(defaults.sortBy);
      expect(result.sortOrder).toBe(defaults.sortOrder);
      expect(result.showHiddenFiles).toBe(defaults.showHiddenFiles);
    });
  });

  describe('enum fields', () => {
    it('accepts valid theme values', () => {
      expect(sanitizeSettings({ theme: 'dark' }).theme).toBe('dark');
      expect(sanitizeSettings({ theme: 'light' }).theme).toBe('light');
      expect(sanitizeSettings({ theme: 'nord' }).theme).toBe('nord');
      expect(sanitizeSettings({ theme: 'catppuccin' }).theme).toBe('catppuccin');
      expect(sanitizeSettings({ theme: 'dracula' }).theme).toBe('dracula');
      expect(sanitizeSettings({ theme: 'solarized' }).theme).toBe('solarized');
      expect(sanitizeSettings({ theme: 'github' }).theme).toBe('github');
      expect(sanitizeSettings({ theme: 'custom' }).theme).toBe('custom');
    });

    it('rejects invalid theme values', () => {
      expect(sanitizeSettings({ theme: 'invalid' }).theme).toBe(defaults.theme);
      expect(sanitizeSettings({ theme: 123 }).theme).toBe(defaults.theme);
      expect(sanitizeSettings({ theme: null }).theme).toBe(defaults.theme);
    });

    it('accepts valid sortBy values', () => {
      expect(sanitizeSettings({ sortBy: 'name' }).sortBy).toBe('name');
      expect(sanitizeSettings({ sortBy: 'date' }).sortBy).toBe('date');
      expect(sanitizeSettings({ sortBy: 'size' }).sortBy).toBe('size');
      expect(sanitizeSettings({ sortBy: 'type' }).sortBy).toBe('type');
    });

    it('rejects invalid sortBy values', () => {
      expect(sanitizeSettings({ sortBy: 'nope' }).sortBy).toBe(defaults.sortBy);
    });

    it('accepts valid sortOrder values', () => {
      expect(sanitizeSettings({ sortOrder: 'asc' }).sortOrder).toBe('asc');
      expect(sanitizeSettings({ sortOrder: 'desc' }).sortOrder).toBe('desc');
    });

    it('rejects invalid sortOrder values', () => {
      expect(sanitizeSettings({ sortOrder: 'up' }).sortOrder).toBe(defaults.sortOrder);
    });

    it('accepts valid viewMode values', () => {
      expect(sanitizeSettings({ viewMode: 'grid' }).viewMode).toBe('grid');
      expect(sanitizeSettings({ viewMode: 'list' }).viewMode).toBe('list');
      expect(sanitizeSettings({ viewMode: 'column' }).viewMode).toBe('column');
    });

    it('rejects invalid viewMode values', () => {
      expect(sanitizeSettings({ viewMode: 'table' }).viewMode).toBe(defaults.viewMode);
    });

    it('accepts valid uiDensity values', () => {
      expect(sanitizeSettings({ uiDensity: 'compact' }).uiDensity).toBe('compact');
      expect(sanitizeSettings({ uiDensity: 'default' }).uiDensity).toBe('default');
      expect(sanitizeSettings({ uiDensity: 'larger' }).uiDensity).toBe('larger');
    });

    it('rejects invalid uiDensity values', () => {
      expect(sanitizeSettings({ uiDensity: 'tiny' }).uiDensity).toBe(defaults.uiDensity);
    });

    it('accepts valid updateChannel values', () => {
      expect(sanitizeSettings({ updateChannel: 'auto' }).updateChannel).toBe('auto');
      expect(sanitizeSettings({ updateChannel: 'beta' }).updateChannel).toBe('beta');
      expect(sanitizeSettings({ updateChannel: 'stable' }).updateChannel).toBe('stable');
    });

    it('rejects invalid updateChannel values', () => {
      expect(sanitizeSettings({ updateChannel: 'canary' }).updateChannel).toBe(
        defaults.updateChannel
      );
    });

    it('accepts valid fileConflictBehavior values', () => {
      expect(sanitizeSettings({ fileConflictBehavior: 'ask' }).fileConflictBehavior).toBe('ask');
      expect(sanitizeSettings({ fileConflictBehavior: 'rename' }).fileConflictBehavior).toBe(
        'rename'
      );
      expect(sanitizeSettings({ fileConflictBehavior: 'skip' }).fileConflictBehavior).toBe('skip');
      expect(sanitizeSettings({ fileConflictBehavior: 'overwrite' }).fileConflictBehavior).toBe(
        'overwrite'
      );
    });

    it('rejects invalid fileConflictBehavior values', () => {
      expect(sanitizeSettings({ fileConflictBehavior: 'delete' }).fileConflictBehavior).toBe(
        defaults.fileConflictBehavior
      );
    });

    it('accepts valid thumbnailQuality values', () => {
      expect(sanitizeSettings({ thumbnailQuality: 'low' }).thumbnailQuality).toBe('low');
      expect(sanitizeSettings({ thumbnailQuality: 'medium' }).thumbnailQuality).toBe('medium');
      expect(sanitizeSettings({ thumbnailQuality: 'high' }).thumbnailQuality).toBe('high');
    });

    it('accepts valid previewPanelPosition values', () => {
      expect(sanitizeSettings({ previewPanelPosition: 'right' }).previewPanelPosition).toBe(
        'right'
      );
      expect(sanitizeSettings({ previewPanelPosition: 'bottom' }).previewPanelPosition).toBe(
        'bottom'
      );
    });

    it('accepts valid gridColumns values', () => {
      expect(sanitizeSettings({ gridColumns: 'auto' }).gridColumns).toBe('auto');
      expect(sanitizeSettings({ gridColumns: '4' }).gridColumns).toBe('4');
      expect(sanitizeSettings({ gridColumns: '6' }).gridColumns).toBe('6');
    });

    it('rejects invalid gridColumns values', () => {
      expect(sanitizeSettings({ gridColumns: '10' }).gridColumns).toBe(defaults.gridColumns);
    });
  });

  describe('boolean fields', () => {
    it('accepts valid boolean values', () => {
      expect(sanitizeSettings({ showHiddenFiles: true }).showHiddenFiles).toBe(true);
      expect(sanitizeSettings({ showHiddenFiles: false }).showHiddenFiles).toBe(false);
      expect(sanitizeSettings({ reduceMotion: true }).reduceMotion).toBe(true);
      expect(sanitizeSettings({ highContrast: true }).highContrast).toBe(true);
      expect(sanitizeSettings({ largeText: true }).largeText).toBe(true);
      expect(sanitizeSettings({ boldText: true }).boldText).toBe(true);
      expect(sanitizeSettings({ visibleFocus: true }).visibleFocus).toBe(true);
      expect(sanitizeSettings({ liquidGlassMode: true }).liquidGlassMode).toBe(true);
      expect(sanitizeSettings({ enableTabs: false }).enableTabs).toBe(false);
      expect(sanitizeSettings({ enableGitStatus: true }).enableGitStatus).toBe(true);
      expect(sanitizeSettings({ autoPlayVideos: true }).autoPlayVideos).toBe(true);
      expect(sanitizeSettings({ compactFileInfo: true }).compactFileInfo).toBe(true);
      expect(sanitizeSettings({ showFileExtensions: false }).showFileExtensions).toBe(false);
      expect(sanitizeSettings({ useLegacyTreeSpacing: true }).useLegacyTreeSpacing).toBe(true);
    });

    it('ignores non-boolean values for boolean fields', () => {
      expect(sanitizeSettings({ showHiddenFiles: 'yes' }).showHiddenFiles).toBe(
        defaults.showHiddenFiles
      );
      expect(sanitizeSettings({ reduceMotion: 1 }).reduceMotion).toBe(defaults.reduceMotion);
      expect(sanitizeSettings({ enableTabs: null }).enableTabs).toBe(defaults.enableTabs);
      expect(sanitizeSettings({ useLegacyTreeSpacing: 'yes' }).useLegacyTreeSpacing).toBe(
        defaults.useLegacyTreeSpacing
      );
    });
  });

  describe('numeric fields', () => {
    it('accepts valid numeric values', () => {
      expect(sanitizeSettings({ maxThumbnailSizeMB: 20 }).maxThumbnailSizeMB).toBe(20);
      expect(sanitizeSettings({ maxPreviewSizeMB: 100 }).maxPreviewSizeMB).toBe(100);
      expect(sanitizeSettings({ iconSize: 128 }).iconSize).toBe(128);
      expect(sanitizeSettings({ sidebarWidth: 250 }).sidebarWidth).toBe(250);
      expect(sanitizeSettings({ previewPanelWidth: 400 }).previewPanelWidth).toBe(400);
    });

    it('rejects zero or negative for size fields', () => {
      expect(sanitizeSettings({ maxThumbnailSizeMB: 0 }).maxThumbnailSizeMB).toBe(
        defaults.maxThumbnailSizeMB
      );
      expect(sanitizeSettings({ maxThumbnailSizeMB: -5 }).maxThumbnailSizeMB).toBe(
        defaults.maxThumbnailSizeMB
      );
      expect(sanitizeSettings({ iconSize: 0 }).iconSize).toBe(defaults.iconSize);
    });

    it('rejects NaN and Infinity', () => {
      expect(sanitizeSettings({ maxThumbnailSizeMB: NaN }).maxThumbnailSizeMB).toBe(
        defaults.maxThumbnailSizeMB
      );
      expect(sanitizeSettings({ maxThumbnailSizeMB: Infinity }).maxThumbnailSizeMB).toBe(
        defaults.maxThumbnailSizeMB
      );
    });

    it('rejects non-numeric types', () => {
      expect(sanitizeSettings({ iconSize: 'big' }).iconSize).toBe(defaults.iconSize);
      expect(sanitizeSettings({ iconSize: true }).iconSize).toBe(defaults.iconSize);
    });
  });

  describe('integer fields', () => {
    it('accepts valid integer values', () => {
      expect(sanitizeSettings({ launchCount: 5 }).launchCount).toBe(5);
      expect(sanitizeSettings({ maxSearchHistoryItems: 10 }).maxSearchHistoryItems).toBe(10);
      expect(sanitizeSettings({ maxDirectoryHistoryItems: 8 }).maxDirectoryHistoryItems).toBe(8);
    });

    it('truncates fractional values', () => {
      expect(sanitizeSettings({ launchCount: 3.9 }).launchCount).toBe(3);
    });

    it('rejects negative values for non-negative integer fields', () => {
      expect(sanitizeSettings({ launchCount: -1 }).launchCount).toBe(defaults.launchCount);
      expect(sanitizeSettings({ maxSearchHistoryItems: -5 }).maxSearchHistoryItems).toBe(
        defaults.maxSearchHistoryItems
      );
    });
  });

  describe('string fields', () => {
    it('accepts valid string values', () => {
      expect(sanitizeSettings({ startupPath: '/Users/test' }).startupPath).toBe('/Users/test');
    });

    it('ignores non-string values', () => {
      expect(sanitizeSettings({ startupPath: 42 }).startupPath).toBe(defaults.startupPath);
      expect(sanitizeSettings({ startupPath: null }).startupPath).toBe(defaults.startupPath);
    });
  });

  describe('array fields', () => {
    it('accepts valid string arrays', () => {
      expect(sanitizeSettings({ bookmarks: ['/a', '/b'] }).bookmarks).toEqual(['/a', '/b']);
      expect(sanitizeSettings({ searchHistory: ['test'] }).searchHistory).toEqual(['test']);
      expect(sanitizeSettings({ recentFiles: ['/file.txt'] }).recentFiles).toEqual(['/file.txt']);
    });

    it('filters non-string elements from arrays', () => {
      expect(sanitizeSettings({ bookmarks: ['/a', 42, null, '/b'] }).bookmarks).toEqual([
        '/a',
        '/b',
      ]);
    });

    it('uses defaults when field is not an array', () => {
      expect(sanitizeSettings({ bookmarks: 'not-an-array' }).bookmarks).toEqual(defaults.bookmarks);
    });
  });

  describe('shortcuts', () => {
    it('preserves valid shortcut bindings', () => {
      const result = sanitizeSettings({
        shortcuts: { search: ['Ctrl', 'F'] },
      });
      expect(result.shortcuts.search).toEqual(['Ctrl', 'F']);
    });

    it('keeps default bindings for unspecified actions', () => {
      const result = sanitizeSettings({ shortcuts: { search: ['Ctrl', 'F'] } });
      expect(result.shortcuts.undo).toEqual(defaults.shortcuts.undo);
    });

    it('ignores unknown shortcut keys', () => {
      const result = sanitizeSettings({
        shortcuts: { 'totally-fake-action': ['Ctrl', 'Z'] },
      });
      expect((result.shortcuts as Record<string, unknown>)['totally-fake-action']).toBeUndefined();
    });

    it('filters non-string elements in bindings', () => {
      const result = sanitizeSettings({
        shortcuts: { search: ['Ctrl', 42, 'F'] },
      });
      expect(result.shortcuts.search).toEqual(['Ctrl', 'F']);
    });

    it('ignores non-array bindings', () => {
      const result = sanitizeSettings({
        shortcuts: { search: 'Ctrl+F' },
      });
      expect(result.shortcuts.search).toEqual(defaults.shortcuts.search);
    });

    it('rejects reserved key names', () => {
      const result = sanitizeSettings({
        shortcuts: { __proto__: ['Ctrl', 'P'], constructor: ['Ctrl', 'C'] },
      });
      expect(result.shortcuts).not.toHaveProperty('__proto__');
    });
  });

  describe('folderIcons', () => {
    it('accepts valid string record', () => {
      const result = sanitizeSettings({ folderIcons: { '/home': '1f4c1' } });
      expect(result.folderIcons).toEqual({ '/home': '1f4c1' });
    });

    it('filters non-string values from record', () => {
      const result = sanitizeSettings({ folderIcons: { '/a': 'icon', '/b': 42 } });
      expect(result.folderIcons).toEqual({ '/a': 'icon' });
    });

    it('ignores reserved keys in folderIcons', () => {
      const result = sanitizeSettings({ folderIcons: { __proto__: 'icon' } });
      expect(result.folderIcons).toEqual({});
    });
  });

  describe('customTheme', () => {
    it('accepts a valid customTheme object', () => {
      const theme = {
        name: 'My Theme',
        accentColor: '#ff0000',
        bgPrimary: '#111',
        bgSecondary: '#222',
        textPrimary: '#fff',
        textSecondary: '#ccc',
        glassBg: 'rgba(0,0,0,0.5)',
        glassBorder: 'rgba(255,255,255,0.1)',
      };
      const result = sanitizeSettings({ customTheme: theme });
      expect(result.customTheme).toEqual(theme);
    });

    it('rejects customTheme missing required fields', () => {
      const result = sanitizeSettings({ customTheme: { name: 'Bad' } });
      expect(result.customTheme).toBeUndefined();
    });

    it('rejects non-object customTheme', () => {
      const result = sanitizeSettings({ customTheme: 'nope' });
      expect(result.customTheme).toBeUndefined();
    });
  });

  describe('listColumnWidths', () => {
    it('accepts valid column widths', () => {
      const result = sanitizeSettings({ listColumnWidths: { name: 200, size: 100 } });
      expect(result.listColumnWidths).toEqual({ name: 200, size: 100 });
    });

    it('rejects non-numeric column widths', () => {
      const result = sanitizeSettings({ listColumnWidths: { name: 'wide' } });
      expect(result.listColumnWidths).toBeUndefined();
    });
  });

  describe('tabState', () => {
    it('accepts valid tab state', () => {
      const result = sanitizeSettings({
        tabState: {
          tabs: [{ id: 'tab1', path: '/home', history: ['/home'], historyIndex: 0 }],
          activeTabId: 'tab1',
        },
      });
      expect(result.tabState).toBeDefined();
      expect(result.tabState!.tabs.length).toBe(1);
      expect(result.tabState!.activeTabId).toBe('tab1');
    });

    it('rejects tabs missing id or path', () => {
      const result = sanitizeSettings({
        tabState: {
          tabs: [{ id: 'tab1' }],
          activeTabId: 'tab1',
        },
      });
      expect(result.tabState).toBeUndefined();
    });

    it('clamps historyIndex to valid range', () => {
      const result = sanitizeSettings({
        tabState: {
          tabs: [{ id: 't', path: '/x', history: ['/a', '/b'], historyIndex: 999 }],
          activeTabId: 't',
        },
      });
      expect(result.tabState!.tabs[0].historyIndex).toBe(1);
    });

    it('defaults activeTabId when missing', () => {
      const result = sanitizeSettings({
        tabState: {
          tabs: [
            { id: 'a', path: '/a' },
            { id: 'b', path: '/b' },
          ],
          activeTabId: 'nonexistent',
        },
      });
      expect(result.tabState!.activeTabId).toBe('a');
    });
  });

  describe('prototype pollution protection', () => {
    it('ignores __proto__ in shortcuts', () => {
      const malicious = JSON.parse('{"shortcuts": {"__proto__": ["evil"]}}');
      const result = sanitizeSettings(malicious);
      expect((result as unknown as Record<string, unknown>).__proto__).not.toEqual(['evil']);
    });

    it('ignores constructor in folderIcons', () => {
      const result = sanitizeSettings({ folderIcons: { constructor: 'bad' } });
      expect(result.folderIcons).toEqual({});
    });
  });

  describe('partial valid input', () => {
    it('merges partial valid input with defaults', () => {
      const result = sanitizeSettings({
        theme: 'dark',
        showHiddenFiles: true,
        sortBy: 'size',
      });
      expect(result.theme).toBe('dark');
      expect(result.showHiddenFiles).toBe(true);
      expect(result.sortBy).toBe('size');
      expect(result.sortOrder).toBe(defaults.sortOrder);
      expect(result.viewMode).toBe(defaults.viewMode);
    });

    it('applies valid fields and ignores invalid ones', () => {
      const result = sanitizeSettings({
        theme: 'nord',
        sortBy: 'invalidSort',
        showHiddenFiles: 'notABoolean',
        iconSize: 96,
      });
      expect(result.theme).toBe('nord');
      expect(result.sortBy).toBe(defaults.sortBy);
      expect(result.showHiddenFiles).toBe(defaults.showHiddenFiles);
      expect(result.iconSize).toBe(96);
    });
  });

  describe('does not mutate defaults', () => {
    it('returns a new object each time', () => {
      const a = sanitizeSettings({});
      const b = sanitizeSettings({});
      expect(a).not.toBe(b);
      expect(a.bookmarks).not.toBe(b.bookmarks);
      expect(a.shortcuts).not.toBe(b.shortcuts);
    });
  });
});
