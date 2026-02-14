import { describe, it, expect } from 'vitest';
import { getDefaultShortcuts, SHORTCUT_DEFINITIONS } from '../shortcuts';

describe('SHORTCUT_DEFINITIONS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(SHORTCUT_DEFINITIONS)).toBe(true);
    expect(SHORTCUT_DEFINITIONS.length).toBeGreaterThan(0);
  });

  it('every definition has required fields', () => {
    for (const def of SHORTCUT_DEFINITIONS) {
      expect(typeof def.id).toBe('string');
      expect(def.id.length).toBeGreaterThan(0);
      expect(typeof def.title).toBe('string');
      expect(typeof def.category).toBe('string');
      expect(Array.isArray(def.defaultBinding)).toBe(true);
    }
  });

  it('has unique ids', () => {
    const ids = SHORTCUT_DEFINITIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has expected categories', () => {
    const categories = new Set(SHORTCUT_DEFINITIONS.map((d) => d.category));
    expect(categories.has('General')).toBe(true);
    expect(categories.has('Navigation')).toBe(true);
    expect(categories.has('File Operations')).toBe(true);
  });

  it('includes critical shortcut actions', () => {
    const ids = new Set(SHORTCUT_DEFINITIONS.map((d) => d.id));
    expect(ids.has('copy')).toBe(true);
    expect(ids.has('cut')).toBe(true);
    expect(ids.has('paste')).toBe(true);
    expect(ids.has('undo')).toBe(true);
    expect(ids.has('redo')).toBe(true);
    expect(ids.has('select-all')).toBe(true);
    expect(ids.has('search')).toBe(true);
    expect(ids.has('settings')).toBe(true);
    expect(ids.has('new-tab')).toBe(true);
    expect(ids.has('close-tab')).toBe(true);
  });
});

describe('getDefaultShortcuts', () => {
  it('returns an object with all definition ids', () => {
    const shortcuts = getDefaultShortcuts();
    for (const def of SHORTCUT_DEFINITIONS) {
      expect(shortcuts).toHaveProperty(def.id);
      expect(Array.isArray(shortcuts[def.id])).toBe(true);
    }
  });

  it('does not include extra keys beyond definitions', () => {
    const shortcuts = getDefaultShortcuts();
    const definedIds = new Set(SHORTCUT_DEFINITIONS.map((d) => d.id));
    for (const key of Object.keys(shortcuts)) {
      expect(definedIds.has(key)).toBe(true);
    }
  });

  describe('platform-specific bindings', () => {
    it('uses Meta modifier on macOS', () => {
      const shortcuts = getDefaultShortcuts('darwin');
      expect(shortcuts.copy).toContain('Meta');
      expect(shortcuts.paste).toContain('Meta');
      expect(shortcuts.undo).toContain('Meta');
    });

    it('uses Ctrl modifier on Windows', () => {
      const shortcuts = getDefaultShortcuts('win32');
      expect(shortcuts.copy).toContain('Ctrl');
      expect(shortcuts.paste).toContain('Ctrl');
      expect(shortcuts.undo).toContain('Ctrl');
    });

    it('uses Ctrl modifier on Linux', () => {
      const shortcuts = getDefaultShortcuts('linux');
      expect(shortcuts.copy).toContain('Ctrl');
    });

    it('redo uses Shift+Z on Mac, Y on Windows', () => {
      const macShortcuts = getDefaultShortcuts('darwin');
      const winShortcuts = getDefaultShortcuts('win32');

      expect(macShortcuts.redo).toContain('Shift');
      expect(macShortcuts.redo).toContain('Z');
      expect(winShortcuts.redo).toContain('Y');
    });

    it('navigation shortcuts are platform-independent', () => {
      const macShortcuts = getDefaultShortcuts('darwin');
      const winShortcuts = getDefaultShortcuts('win32');

      expect(macShortcuts['go-back']).toEqual(winShortcuts['go-back']);
      expect(macShortcuts['go-forward']).toEqual(winShortcuts['go-forward']);
    });
  });

  it('returns distinct objects on each call', () => {
    const a = getDefaultShortcuts();
    const b = getDefaultShortcuts();
    expect(a).not.toBe(b);
  });
});
