import { describe, it, expect } from 'vitest';
import { createDefaultSettings } from '../settings';

describe('createDefaultSettings', () => {
  it('returns an object with all required fields', () => {
    const settings = createDefaultSettings();
    expect(settings).toBeDefined();
    expect(typeof settings).toBe('object');
  });

  it('has correct default appearance settings', () => {
    const settings = createDefaultSettings();
    expect(settings.theme).toBe('default');
    expect(settings.viewMode).toBe('grid');
  });

  it('has correct default sorting settings', () => {
    const settings = createDefaultSettings();
    expect(settings.sortBy).toBe('name');
    expect(settings.sortOrder).toBe('asc');
  });

  it('has empty bookmarks array', () => {
    const settings = createDefaultSettings();
    expect(settings.bookmarks).toEqual([]);
  });

  it('has correct default file visibility settings', () => {
    const settings = createDefaultSettings();
    expect(settings.showHiddenFiles).toBe(false);
    expect(settings.showDangerousOptions).toBe(false);
  });

  it('has correct default search settings', () => {
    const settings = createDefaultSettings();
    expect(settings.enableSearchHistory).toBe(true);
    expect(settings.searchHistory).toEqual([]);
    expect(settings.globalContentSearch).toBe(false);
  });

  it('has correct default indexer settings', () => {
    const settings = createDefaultSettings();
    expect(settings.enableIndexer).toBe(true);
  });

  it('has correct default system integration settings', () => {
    const settings = createDefaultSettings();
    expect(settings.minimizeToTray).toBe(false);
    expect(settings.startOnLogin).toBe(false);
    expect(settings.autoCheckUpdates).toBe(true);
  });

  it('has correct default accessibility settings', () => {
    const settings = createDefaultSettings();
    expect(settings.reduceMotion).toBe(false);
    expect(settings.highContrast).toBe(false);
    expect(settings.largeText).toBe(false);
    expect(settings.boldText).toBe(false);
    expect(settings.visibleFocus).toBe(false);
    expect(settings.reduceTransparency).toBe(false);
  });

  it('has correct default tab settings', () => {
    const settings = createDefaultSettings();
    expect(settings.enableTabs).toBe(true);
  });

  it('has correct default feature settings', () => {
    const settings = createDefaultSettings();
    expect(settings.enableSyntaxHighlighting).toBe(true);
    expect(settings.enableGitStatus).toBe(false);
    expect(settings.showRecentFiles).toBe(true);
    expect(settings.showFolderTree).toBe(true);
  });

  it('has correct default update channel', () => {
    const settings = createDefaultSettings();
    expect(settings.updateChannel).toBe('auto');
  });

  it('has empty startup path', () => {
    const settings = createDefaultSettings();
    expect(settings.startupPath).toBe('');
  });

  it('has empty directory history', () => {
    const settings = createDefaultSettings();
    expect(settings.directoryHistory).toEqual([]);
  });

  it('has empty recent files', () => {
    const settings = createDefaultSettings();
    expect(settings.recentFiles).toEqual([]);
  });

  it('has empty folder icons', () => {
    const settings = createDefaultSettings();
    expect(settings.folderIcons).toEqual({});
  });

  it('returns a new object each time', () => {
    const settings1 = createDefaultSettings();
    const settings2 = createDefaultSettings();
    expect(settings1).not.toBe(settings2);
    expect(settings1).toEqual(settings2);
  });
});
