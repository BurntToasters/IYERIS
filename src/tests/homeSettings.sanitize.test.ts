import { describe, it, expect } from 'vitest';
import { createDefaultHomeSettings, sanitizeHomeSettings } from './homeSettings';

describe('sanitizeHomeSettings', () => {
  it('returns defaults when raw is not an object', () => {
    const defaults = createDefaultHomeSettings();
    expect(sanitizeHomeSettings(null)).toEqual(defaults);
    expect(sanitizeHomeSettings(undefined)).toEqual(defaults);
    expect(sanitizeHomeSettings(42)).toEqual(defaults);
    expect(sanitizeHomeSettings('string')).toEqual(defaults);
    expect(sanitizeHomeSettings([])).toEqual(defaults);
  });

  it('returns defaults when raw is an empty object', () => {
    const result = sanitizeHomeSettings({});
    const defaults = createDefaultHomeSettings();
    expect(result).toEqual(defaults);
  });

  it('overrides boolean fields from raw input', () => {
    const result = sanitizeHomeSettings({
      showQuickAccess: false,
      showRecents: false,
      showBookmarks: false,
      showDrives: false,
      showDiskUsage: false,
      compactCards: true,
    });
    expect(result.showQuickAccess).toBe(false);
    expect(result.showRecents).toBe(false);
    expect(result.showBookmarks).toBe(false);
    expect(result.showDrives).toBe(false);
    expect(result.showDiskUsage).toBe(false);
    expect(result.compactCards).toBe(true);
  });

  it('ignores non-boolean values for boolean fields', () => {
    const defaults = createDefaultHomeSettings();
    const result = sanitizeHomeSettings({
      showQuickAccess: 'yes',
      showRecents: 1,
      showBookmarks: null,
      compactCards: undefined,
    });
    expect(result.showQuickAccess).toBe(defaults.showQuickAccess);
    expect(result.showRecents).toBe(defaults.showRecents);
    expect(result.showBookmarks).toBe(defaults.showBookmarks);
    expect(result.compactCards).toBe(defaults.compactCards);
  });

  it('overrides array fields with sanitized string arrays', () => {
    const result = sanitizeHomeSettings({
      hiddenQuickAccessItems: ['item1', 'item2'],
      quickAccessOrder: ['desktop', 'downloads'],
      sectionOrder: ['recents', 'drives'],
      pinnedRecents: ['/path/to/file'],
      sidebarQuickAccessOrder: ['home', 'desktop'],
      hiddenSidebarQuickAccessItems: ['trash'],
    });
    expect(result.hiddenQuickAccessItems).toEqual(['item1', 'item2']);
    expect(result.quickAccessOrder).toEqual(['desktop', 'downloads']);
    expect(result.sectionOrder).toEqual(['recents', 'drives']);
    expect(result.pinnedRecents).toEqual(['/path/to/file']);
    expect(result.sidebarQuickAccessOrder).toEqual(['home', 'desktop']);
    expect(result.hiddenSidebarQuickAccessItems).toEqual(['trash']);
  });

  it('filters non-string values from arrays', () => {
    const result = sanitizeHomeSettings({
      hiddenQuickAccessItems: ['valid', 42, null, 'also-valid', undefined],
    });
    expect(result.hiddenQuickAccessItems).toEqual(['valid', 'also-valid']);
  });

  it('ignores non-array values for array fields', () => {
    const defaults = createDefaultHomeSettings();
    const result = sanitizeHomeSettings({
      hiddenQuickAccessItems: 'not-an-array',
      quickAccessOrder: 42,
      sectionOrder: null,
    });
    expect(result.hiddenQuickAccessItems).toEqual(defaults.hiddenQuickAccessItems);
    expect(result.quickAccessOrder).toEqual(defaults.quickAccessOrder);
    expect(result.sectionOrder).toEqual(defaults.sectionOrder);
  });

  it('removes reserved keys (__proto__, constructor, prototype)', () => {
    const raw = Object.create(null);
    raw.__proto__ = 'evil';
    raw.constructor = 'evil';
    raw.prototype = 'evil';
    raw.showRecents = false;

    const result = sanitizeHomeSettings(raw);
    expect(result.showRecents).toBe(false);

    expect(typeof result).toBe('object');
  });

  it('uses custom defaults when provided', () => {
    const customDefaults = createDefaultHomeSettings();
    customDefaults.showQuickAccess = false;
    customDefaults.compactCards = true;

    const result = sanitizeHomeSettings({}, customDefaults);
    expect(result.showQuickAccess).toBe(false);
    expect(result.compactCards).toBe(true);
  });

  it('returns a new object independent from defaults', () => {
    const defaults = createDefaultHomeSettings();
    const result = sanitizeHomeSettings({});
    result.showQuickAccess = false;
    result.quickAccessOrder.push('newItem');
    expect(defaults.showQuickAccess).toBe(true);
    expect(defaults.quickAccessOrder).not.toContain('newItem');
  });

  it('handles extra unknown keys by ignoring them', () => {
    const result = sanitizeHomeSettings({
      unknownField: 'value',
      anotherUnknown: 42,
      showRecents: true,
    });
    expect(result.showRecents).toBe(true);

    expect(result).not.toHaveProperty('unknownField');
  });
});
