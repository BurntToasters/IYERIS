import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shortcuts.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../shortcuts')>();
  return {
    ...orig,
    SHORTCUT_DEFINITIONS: orig.SHORTCUT_DEFINITIONS,
    getDefaultShortcuts: orig.getDefaultShortcuts,
  };
});

import { createShortcutEngineController } from '../rendererShortcutsEngine';
import type { Settings } from '../types';

function makeDeps(platformOS = 'linux') {
  return {
    getPlatformOS: vi.fn(() => platformOS),
    syncCommandShortcuts: vi.fn(),
    renderShortcutsModal: vi.fn(),
    debouncedSaveSettings: vi.fn(),
  };
}

function makeEngine(platformOS = 'linux') {
  return createShortcutEngineController(makeDeps(platformOS));
}

describe('normalizeModifierKey', () => {
  const engine = makeEngine();

  it('normalizes control variants', () => {
    expect(engine.normalizeModifierKey('control')).toBe('Ctrl');
    expect(engine.normalizeModifierKey('ctrl')).toBe('Ctrl');
    expect(engine.normalizeModifierKey('Control')).toBe('Ctrl');
  });

  it('normalizes shift', () => {
    expect(engine.normalizeModifierKey('shift')).toBe('Shift');
    expect(engine.normalizeModifierKey('Shift')).toBe('Shift');
  });

  it('normalizes alt/option', () => {
    expect(engine.normalizeModifierKey('alt')).toBe('Alt');
    expect(engine.normalizeModifierKey('option')).toBe('Alt');
  });

  it('normalizes meta/cmd/command', () => {
    expect(engine.normalizeModifierKey('meta')).toBe('Meta');
    expect(engine.normalizeModifierKey('cmd')).toBe('Meta');
    expect(engine.normalizeModifierKey('command')).toBe('Meta');
  });

  it('returns null for non-modifier keys', () => {
    expect(engine.normalizeModifierKey('A')).toBe(null);
    expect(engine.normalizeModifierKey('F1')).toBe(null);
    expect(engine.normalizeModifierKey('Space')).toBe(null);
  });
});

describe('normalizeKeyLabel', () => {
  const engine = makeEngine();

  it('returns null for empty string', () => {
    expect(engine.normalizeKeyLabel('')).toBe(null);
  });

  it('returns null for Dead key', () => {
    expect(engine.normalizeKeyLabel('Dead')).toBe(null);
  });

  it('normalizes space', () => {
    expect(engine.normalizeKeyLabel(' ')).toBe('Space');
  });

  it('normalizes Esc to Escape', () => {
    expect(engine.normalizeKeyLabel('Esc')).toBe('Escape');
  });

  it('normalizes Del to Delete', () => {
    expect(engine.normalizeKeyLabel('Del')).toBe('Delete');
  });

  it('normalizes ? to /', () => {
    expect(engine.normalizeKeyLabel('?')).toBe('/');
  });

  it('normalizes + to =', () => {
    expect(engine.normalizeKeyLabel('+')).toBe('=');
  });

  it('normalizes _ to -', () => {
    expect(engine.normalizeKeyLabel('_')).toBe('-');
  });

  it('uppercases single character keys', () => {
    expect(engine.normalizeKeyLabel('a')).toBe('A');
    expect(engine.normalizeKeyLabel('z')).toBe('Z');
  });

  it('passes through multi-char labels', () => {
    expect(engine.normalizeKeyLabel('F5')).toBe('F5');
    expect(engine.normalizeKeyLabel('ArrowUp')).toBe('ArrowUp');
  });

  it('normalizes modifier keys via normalizeModifierKey', () => {
    expect(engine.normalizeKeyLabel('control')).toBe('Ctrl');
    expect(engine.normalizeKeyLabel('cmd')).toBe('Meta');
  });
});

describe('normalizeShortcutBinding', () => {
  const engine = makeEngine();

  it('orders modifiers in canonical order', () => {
    expect(engine.normalizeShortcutBinding(['Alt', 'Ctrl', 'A'])).toEqual(['Ctrl', 'Alt', 'A']);
  });

  it('deduplicates modifiers', () => {
    expect(engine.normalizeShortcutBinding(['Ctrl', 'ctrl', 'A'])).toEqual(['Ctrl', 'A']);
  });

  it('only keeps the first main key', () => {
    expect(engine.normalizeShortcutBinding(['Ctrl', 'A', 'B'])).toEqual(['Ctrl', 'A']);
  });

  it('returns empty for empty binding', () => {
    expect(engine.normalizeShortcutBinding([])).toEqual([]);
  });

  it('handles modifier-only bindings', () => {
    expect(engine.normalizeShortcutBinding(['Ctrl', 'Shift'])).toEqual(['Ctrl', 'Shift']);
  });

  it('normalizes key labels', () => {
    expect(engine.normalizeShortcutBinding(['control', 'a'])).toEqual(['Ctrl', 'A']);
  });

  it('filters out Dead keys', () => {
    expect(engine.normalizeShortcutBinding(['Ctrl', 'Dead', 'K'])).toEqual(['Ctrl', 'K']);
  });
});

describe('serializeShortcut', () => {
  const engine = makeEngine();

  it('joins binding with ::', () => {
    expect(engine.serializeShortcut(['Ctrl', 'Shift', 'A'])).toBe('Ctrl::Shift::A');
  });

  it('handles single key', () => {
    expect(engine.serializeShortcut(['F5'])).toBe('F5');
  });

  it('handles empty binding', () => {
    expect(engine.serializeShortcut([])).toBe('');
  });
});

describe('hasModifier', () => {
  const engine = makeEngine();

  it('returns true when binding contains a modifier', () => {
    expect(engine.hasModifier(['Ctrl', 'A'])).toBe(true);
    expect(engine.hasModifier(['Meta', 'Shift', 'Z'])).toBe(true);
  });

  it('returns false when no modifiers present', () => {
    expect(engine.hasModifier(['F5'])).toBe(false);
    expect(engine.hasModifier(['A'])).toBe(false);
  });

  it('returns false for empty binding', () => {
    expect(engine.hasModifier([])).toBe(false);
  });
});

describe('areBindingsEqual', () => {
  const engine = makeEngine();

  it('considers identical bindings equal', () => {
    expect(engine.areBindingsEqual(['Ctrl', 'A'], ['Ctrl', 'A'])).toBe(true);
  });

  it('considers differently ordered modifiers equal after normalization', () => {
    expect(engine.areBindingsEqual(['Alt', 'Ctrl', 'A'], ['Ctrl', 'Alt', 'A'])).toBe(true);
  });

  it('considers different bindings not equal', () => {
    expect(engine.areBindingsEqual(['Ctrl', 'A'], ['Ctrl', 'B'])).toBe(false);
  });

  it('considers case variants equal after normalization', () => {
    expect(engine.areBindingsEqual(['ctrl', 'a'], ['Ctrl', 'A'])).toBe(true);
  });
});

describe('eventToBinding', () => {
  const engine = makeEngine();

  function makeEvent(opts: Partial<KeyboardEvent> = {}): KeyboardEvent {
    return {
      key: 'a',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ...opts,
    } as KeyboardEvent;
  }

  it('converts a simple keystroke', () => {
    expect(engine.eventToBinding(makeEvent({ key: 'a' }))).toEqual(['A']);
  });

  it('includes Ctrl modifier', () => {
    expect(engine.eventToBinding(makeEvent({ key: 'a', ctrlKey: true }))).toEqual(['Ctrl', 'A']);
  });

  it('includes multiple modifiers in order', () => {
    expect(
      engine.eventToBinding(makeEvent({ key: 'a', ctrlKey: true, shiftKey: true, altKey: true }))
    ).toEqual(['Ctrl', 'Shift', 'Alt', 'A']);
  });

  it('returns null for modifier-only events', () => {
    expect(engine.eventToBinding(makeEvent({ key: 'Control' }))).toBe(null);
    expect(engine.eventToBinding(makeEvent({ key: 'Shift' }))).toBe(null);
  });

  it('ignores shift for ? key', () => {
    const binding = engine.eventToBinding(makeEvent({ key: '?', shiftKey: true }));
    expect(binding).toEqual(['/']);
  });

  it('ignores shift for + key', () => {
    const binding = engine.eventToBinding(makeEvent({ key: '+', shiftKey: true }));
    expect(binding).toEqual(['=']);
  });

  it('returns null for Dead key events', () => {
    expect(engine.eventToBinding(makeEvent({ key: 'Dead' }))).toBe(null);
  });
});

describe('formatModifierLabel', () => {
  it('returns key as-is on non-mac', () => {
    const engine = makeEngine('linux');
    expect(engine.formatModifierLabel('Ctrl')).toBe('Ctrl');
    expect(engine.formatModifierLabel('Meta')).toBe('Meta');
  });

  it('returns Mac symbols on darwin', () => {
    const engine = makeEngine('darwin');
    expect(engine.formatModifierLabel('Meta')).toBe('⌘ Cmd');
    expect(engine.formatModifierLabel('Ctrl')).toBe('⌃ Ctrl');
    expect(engine.formatModifierLabel('Alt')).toBe('⌥ Option');
    expect(engine.formatModifierLabel('Shift')).toBe('⇧ Shift');
  });
});

describe('formatShortcutKeyLabel', () => {
  const engine = makeEngine('linux');

  it('maps arrow keys to symbols', () => {
    expect(engine.formatShortcutKeyLabel('ArrowLeft')).toBe('←');
    expect(engine.formatShortcutKeyLabel('ArrowRight')).toBe('→');
    expect(engine.formatShortcutKeyLabel('ArrowUp')).toBe('↑');
    expect(engine.formatShortcutKeyLabel('ArrowDown')).toBe('↓');
  });

  it('maps Escape to Esc', () => {
    expect(engine.formatShortcutKeyLabel('Escape')).toBe('Esc');
  });

  it('maps / to ?', () => {
    expect(engine.formatShortcutKeyLabel('/')).toBe('?');
  });

  it('uppercases single char keys', () => {
    expect(engine.formatShortcutKeyLabel('a')).toBe('A');
  });

  it('passes through multi-char labels', () => {
    expect(engine.formatShortcutKeyLabel('F5')).toBe('F5');
    expect(engine.formatShortcutKeyLabel('Space')).toBe('Space');
  });
});

describe('rebuildFixedShortcuts', () => {
  it('registers F5 and Ctrl+R on non-mac', () => {
    const engine = makeEngine('linux');
    engine.rebuildFixedShortcuts();
    expect(engine.fixedShortcutLookup.get('F5')).toBe('refresh');
    expect(engine.fixedShortcutLookup.get('Ctrl::R')).toBe('refresh');
  });

  it('registers Ctrl+Shift+Z as redo on non-mac', () => {
    const engine = makeEngine('linux');
    engine.rebuildFixedShortcuts();
    expect(engine.fixedShortcutLookup.get('Ctrl::Shift::Z')).toBe('redo');
  });

  it('registers Meta+Z/Meta+Shift+Z on mac', () => {
    const engine = makeEngine('darwin');
    engine.rebuildFixedShortcuts();
    expect(engine.fixedShortcutLookup.get('Meta::Z')).toBe('undo');
    expect(engine.fixedShortcutLookup.get('Shift::Meta::Z')).toBe('redo');
  });
});

describe('rebuildReservedShortcuts', () => {
  it('registers reserved shortcuts', () => {
    const engine = makeEngine('linux');
    engine.rebuildReservedShortcuts();
    expect(engine.reservedShortcutLookup.has('F5')).toBe(true);
    expect(engine.reservedShortcutLookup.get('F5')?.label).toBe('Refresh');
    expect(engine.reservedShortcutLookup.has('Shift::Delete')).toBe(true);
    expect(engine.reservedShortcutLookup.get('Shift::Delete')?.label).toBe('Permanent Delete');
  });

  it('registers extend selection shortcuts', () => {
    const engine = makeEngine('linux');
    engine.rebuildReservedShortcuts();
    expect(engine.reservedShortcutLookup.get('Shift::ArrowUp')?.label).toBe('Extend Selection');
    expect(engine.reservedShortcutLookup.get('Shift::ArrowDown')?.label).toBe('Extend Selection');
  });
});

describe('syncShortcutBindingsFromSettings', () => {
  it('populates shortcutBindings from settings', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);
    const settings = { shortcuts: {} } as Settings;
    engine.syncShortcutBindingsFromSettings(settings);
    const bindings = engine.getShortcutBindings();
    expect(Object.keys(bindings).length).toBeGreaterThan(0);
  });

  it('fills missing shortcuts with defaults', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);
    const settings = { shortcuts: {} } as Settings;
    engine.syncShortcutBindingsFromSettings(settings);
    const bindings = engine.getShortcutBindings();
    expect(bindings['command-palette']).toBeDefined();
    expect(bindings['command-palette']!.length).toBeGreaterThan(0);
  });

  it('calls syncCommandShortcuts', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);
    engine.syncShortcutBindingsFromSettings({ shortcuts: {} } as Settings);
    expect(deps.syncCommandShortcuts).toHaveBeenCalled();
  });

  it('calls renderShortcutsModal when render option set', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);
    engine.syncShortcutBindingsFromSettings({ shortcuts: {} } as Settings, { render: true });
    expect(deps.renderShortcutsModal).toHaveBeenCalled();
  });

  it('deduplicates conflicting shortcuts', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);
    const settings = {
      shortcuts: {
        open: ['Ctrl', 'O'],
        'new-tab': ['Ctrl', 'O'],
      },
    } as unknown as Settings;
    engine.syncShortcutBindingsFromSettings(settings);
    const bindings = engine.getShortcutBindings();
    const openSerialized = engine.serializeShortcut(bindings['open'] || []);
    const newTabSerialized = engine.serializeShortcut(bindings['new-tab'] || []);
    expect(openSerialized).not.toBe(newTabSerialized);
  });

  it('initializes settings.shortcuts if null', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);
    const settings = {} as Settings;
    engine.syncShortcutBindingsFromSettings(settings);
    expect(settings.shortcuts).toBeDefined();
  });
});

describe('getShortcutBinding', () => {
  it('returns binding for registered shortcut', () => {
    const engine = makeEngine();
    engine.syncShortcutBindingsFromSettings({ shortcuts: {} } as Settings);
    const binding = engine.getShortcutBinding('command-palette');
    expect(binding).toBeDefined();
    expect(binding!.length).toBeGreaterThan(0);
  });

  it('returns undefined for empty or missing binding', () => {
    const engine = makeEngine();
    expect(engine.getShortcutBinding('nonexistent')).toBeUndefined();
  });
});

describe('registerFixedShortcut / registerReservedShortcut', () => {
  it('registers and retrieves fixed shortcuts', () => {
    const engine = makeEngine();
    engine.registerFixedShortcut(['Ctrl', 'P'], 'print');
    expect(engine.fixedShortcutLookup.get('Ctrl::P')).toBe('print');
  });

  it('registers and retrieves reserved shortcuts', () => {
    const engine = makeEngine();
    engine.registerReservedShortcut(['Ctrl', 'Q'], 'quit', 'Quit App');
    const entry = engine.reservedShortcutLookup.get('Ctrl::Q');
    expect(entry?.label).toBe('Quit App');
    expect(entry?.actionId).toBe('quit');
  });

  it('ignores empty bindings', () => {
    const engine = makeEngine();
    engine.registerFixedShortcut([], 'nothing');
    expect(engine.fixedShortcutLookup.size).toBe(0);
  });
});
