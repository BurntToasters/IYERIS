import { describe, it, expect } from 'vitest';
import { createSettingsDiagnosticsSnapshot } from './diagnosticsHandlers';
import type { Settings } from './types';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: 'dark',
    useSystemTheme: false,
    sortBy: 'name',
    sortOrder: 'asc',
    viewMode: 'grid',
    showDangerousOptions: false,
    showHiddenFiles: false,
    enableSearchHistory: true,
    enableIndexer: true,
    minimizeToTray: false,
    startOnLogin: false,
    autoCheckUpdates: true,
    showRecentFiles: true,
    showFolderTree: true,
    enableTabs: true,
    globalContentSearch: false,
    globalClipboard: false,
    enableSyntaxHighlighting: true,
    enableGitStatus: false,
    gitIncludeUntracked: false,
    showFileHoverCard: true,
    showFileCheckboxes: false,
    reduceMotion: false,
    highContrast: false,
    largeText: false,
    boldText: false,
    visibleFocus: false,
    reduceTransparency: false,
    liquidGlassMode: false,
    uiDensity: 'normal',
    updateChannel: 'stable',
    themedIcons: false,
    disableHardwareAcceleration: false,
    useSystemFontSize: false,
    confirmFileOperations: true,
    fileConflictBehavior: 'ask',
    skipElevationConfirmation: false,
    maxThumbnailSizeMB: 10,
    thumbnailQuality: 80,
    autoPlayVideos: false,
    previewPanelPosition: 'right',
    maxPreviewSizeMB: 50,
    gridColumns: 'auto',
    iconSize: 'medium',
    compactFileInfo: false,
    showFileExtensions: true,
    maxSearchHistoryItems: 50,
    maxDirectoryHistoryItems: 50,
    bookmarks: [],
    searchHistory: [],
    directoryHistory: [],
    recentFiles: [],
    startupPath: '',
    customTheme: undefined,
    folderIcons: {},
    shortcuts: {},
    tabState: undefined,
    ...overrides,
  } as unknown as Settings;
}

describe('createSettingsDiagnosticsSnapshot', () => {
  it('includes scalar settings keys', () => {
    const settings = makeSettings();
    const snapshot = createSettingsDiagnosticsSnapshot(settings);
    expect(snapshot.theme).toBe('dark');
    expect(snapshot.sortBy).toBe('name');
    expect(snapshot.viewMode).toBe('grid');
    expect(snapshot.showHiddenFiles).toBe(false);
    expect(snapshot.enableTabs).toBe(true);
  });

  it('includes startupPathConfigured flag', () => {
    expect(createSettingsDiagnosticsSnapshot(makeSettings()).startupPathConfigured).toBe(false);
    expect(
      createSettingsDiagnosticsSnapshot(makeSettings({ startupPath: '/home/user' }))
        .startupPathConfigured
    ).toBe(true);
  });

  it('includes customThemeName', () => {
    expect(createSettingsDiagnosticsSnapshot(makeSettings()).customThemeName).toBe(null);
    expect(
      createSettingsDiagnosticsSnapshot(
        makeSettings({ customTheme: { name: 'My Theme' } } as Partial<Settings>)
      ).customThemeName
    ).toBe('My Theme');
  });

  it('includes counts for arrays and objects', () => {
    const settings = makeSettings({
      bookmarks: ['/a', '/b', '/c'] as unknown as Settings['bookmarks'],
      searchHistory: ['foo', 'bar'] as unknown as Settings['searchHistory'],
      directoryHistory: ['/x'] as unknown as Settings['directoryHistory'],
      recentFiles: ['/r1', '/r2'] as unknown as Settings['recentFiles'],
      folderIcons: { '/a': 'icon1', '/b': 'icon2' } as unknown as Settings['folderIcons'],
      shortcuts: { open: ['Ctrl', 'O'] } as unknown as Settings['shortcuts'],
    });
    const snapshot = createSettingsDiagnosticsSnapshot(settings);
    const counts = snapshot.counts as Record<string, number>;
    expect(counts.bookmarks).toBe(3);
    expect(counts.searchHistory).toBe(2);
    expect(counts.directoryHistory).toBe(1);
    expect(counts.recentFiles).toBe(2);
    expect(counts.folderIcons).toBe(2);
    expect(counts.shortcuts).toBe(1);
  });

  it('handles tabState counts', () => {
    const withTabs = makeSettings({
      tabState: { tabs: [{}, {}, {}] } as unknown as Settings['tabState'],
    });
    const withoutTabs = makeSettings();

    const snapWith = createSettingsDiagnosticsSnapshot(withTabs);
    const snapWithout = createSettingsDiagnosticsSnapshot(withoutTabs);

    expect((snapWith.counts as Record<string, number>).tabs).toBe(3);
    expect((snapWithout.counts as Record<string, number>).tabs).toBe(0);
  });

  it('does not include sensitive data like paths or bookmarks', () => {
    const settings = makeSettings({
      bookmarks: ['/secret/path'] as unknown as Settings['bookmarks'],
      startupPath: '/home/user/secret',
    });
    const snapshot = createSettingsDiagnosticsSnapshot(settings);
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain('/secret/path');
    expect(json).not.toContain('/home/user/secret');
  });

  it('handles empty folderIcons and shortcuts', () => {
    const settings = makeSettings({ folderIcons: undefined, shortcuts: undefined });
    const snapshot = createSettingsDiagnosticsSnapshot(settings);
    const counts = snapshot.counts as Record<string, number>;
    expect(counts.folderIcons).toBe(0);
    expect(counts.shortcuts).toBe(0);
  });

  it('returns a plain object with expected shape', () => {
    const snapshot = createSettingsDiagnosticsSnapshot(makeSettings());
    expect(typeof snapshot).toBe('object');
    expect(snapshot.counts).toBeDefined();
    expect(typeof snapshot.startupPathConfigured).toBe('boolean');
  });
});
