import { describe, it, expect } from 'vitest';
import { createDefaultHomeSettings } from './homeSettings';

describe('createDefaultHomeSettings', () => {
  it('returns an object with all required fields', () => {
    const settings = createDefaultHomeSettings();
    expect(settings).toBeDefined();
    expect(typeof settings).toBe('object');
  });

  it('has correct default section visibility', () => {
    const settings = createDefaultHomeSettings();
    expect(settings.showQuickAccess).toBe(true);
    expect(settings.showRecents).toBe(true);
    expect(settings.showBookmarks).toBe(true);
    expect(settings.showDrives).toBe(true);
    expect(settings.showDiskUsage).toBe(true);
  });

  it('has empty hidden quick access items', () => {
    const settings = createDefaultHomeSettings();
    expect(settings.hiddenQuickAccessItems).toEqual([]);
  });

  it('has correct default quick access order', () => {
    const settings = createDefaultHomeSettings();
    expect(settings.quickAccessOrder).toContain('userhome');
    expect(settings.quickAccessOrder).toContain('desktop');
    expect(settings.quickAccessOrder).toContain('documents');
    expect(settings.quickAccessOrder).toContain('downloads');
    expect(settings.quickAccessOrder).toContain('music');
    expect(settings.quickAccessOrder).toContain('videos');
    expect(settings.quickAccessOrder).toContain('browse');
    expect(settings.quickAccessOrder).toContain('trash');
    expect(Array.isArray(settings.quickAccessOrder)).toBe(true);
  });

  it('has correct default section order', () => {
    const settings = createDefaultHomeSettings();
    expect(settings.sectionOrder).toEqual(['quick-access', 'recents', 'bookmarks', 'drives']);
  });

  it('has empty pinned recents', () => {
    const settings = createDefaultHomeSettings();
    expect(settings.pinnedRecents).toEqual([]);
  });

  it('has compact cards disabled by default', () => {
    const settings = createDefaultHomeSettings();
    expect(settings.compactCards).toBe(false);
  });

  it('has correct default sidebar quick access order', () => {
    const settings = createDefaultHomeSettings();
    expect(settings.sidebarQuickAccessOrder).toContain('home');
    expect(settings.sidebarQuickAccessOrder).toContain('userhome');
    expect(settings.sidebarQuickAccessOrder).toContain('browse');
    expect(settings.sidebarQuickAccessOrder).toContain('desktop');
    expect(settings.sidebarQuickAccessOrder).toContain('documents');
    expect(settings.sidebarQuickAccessOrder).toContain('downloads');
    expect(settings.sidebarQuickAccessOrder).toContain('music');
    expect(settings.sidebarQuickAccessOrder).toContain('videos');
    expect(settings.sidebarQuickAccessOrder).toContain('trash');
    expect(Array.isArray(settings.sidebarQuickAccessOrder)).toBe(true);
  });

  it('has empty hidden sidebar quick access items', () => {
    const settings = createDefaultHomeSettings();
    expect(settings.hiddenSidebarQuickAccessItems).toEqual([]);
  });

  it('returns a new object each time', () => {
    const settings1 = createDefaultHomeSettings();
    const settings2 = createDefaultHomeSettings();
    expect(settings1).not.toBe(settings2);
    expect(settings1).toEqual(settings2);
  });

  it('returns mutable arrays', () => {
    const settings = createDefaultHomeSettings();
    settings.quickAccessOrder.push('test');
    expect(settings.quickAccessOrder).toContain('test');

    const fresh = createDefaultHomeSettings();
    expect(fresh.quickAccessOrder).not.toContain('test');
  });
});
