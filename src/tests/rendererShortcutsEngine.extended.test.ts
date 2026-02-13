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
import { getDefaultShortcuts } from '../shortcuts.js';
import type { Settings } from '../types';

function makeDeps(platformOS = 'linux') {
  return {
    getPlatformOS: vi.fn(() => platformOS),
    syncCommandShortcuts: vi.fn(),
    renderShortcutsModal: vi.fn(),
    debouncedSaveSettings: vi.fn(),
  };
}

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

describe('getShortcutActionIdFromEvent', () => {
  it('returns action id when a matching shortcut binding exists', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);
    engine.syncShortcutBindingsFromSettings({ shortcuts: {} } as Settings);

    const result = engine.getShortcutActionIdFromEvent(makeEvent({ key: 'k', ctrlKey: true }));
    expect(result).toBe('command-palette');
  });

  it('returns null when binding has no modifier', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);
    engine.syncShortcutBindingsFromSettings({ shortcuts: {} } as Settings);

    const result = engine.getShortcutActionIdFromEvent(makeEvent({ key: 'a' }));
    expect(result).toBeNull();
  });

  it('returns null when no matching shortcut exists', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);
    engine.syncShortcutBindingsFromSettings({ shortcuts: {} } as Settings);

    const result = engine.getShortcutActionIdFromEvent(
      makeEvent({ key: 'q', ctrlKey: true, shiftKey: true, altKey: true })
    );
    expect(result).toBeNull();
  });

  it('returns null for modifier-only events', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);
    engine.syncShortcutBindingsFromSettings({ shortcuts: {} } as Settings);

    const result = engine.getShortcutActionIdFromEvent(makeEvent({ key: 'Control' }));
    expect(result).toBeNull();
  });
});

describe('formatModifierLabel (mac fall-through)', () => {
  it('returns key as-is on mac when key is not a known modifier', () => {
    const engine = createShortcutEngineController(makeDeps('darwin'));

    expect(engine.formatModifierLabel('Tab')).toBe('Tab');
    expect(engine.formatModifierLabel('Space')).toBe('Space');
    expect(engine.formatModifierLabel('Enter')).toBe('Enter');
  });
});

describe('formatShortcutKeyLabel with modifier keys', () => {
  it('delegates to formatModifierLabel for Ctrl on linux', () => {
    const engine = createShortcutEngineController(makeDeps('linux'));
    expect(engine.formatShortcutKeyLabel('Ctrl')).toBe('Ctrl');
    expect(engine.formatShortcutKeyLabel('Shift')).toBe('Shift');
    expect(engine.formatShortcutKeyLabel('Alt')).toBe('Alt');
    expect(engine.formatShortcutKeyLabel('Meta')).toBe('Meta');
  });

  it('delegates to formatModifierLabel for Ctrl on mac (returns Mac symbols)', () => {
    const engine = createShortcutEngineController(makeDeps('darwin'));
    expect(engine.formatShortcutKeyLabel('Meta')).toBe('⌘ Cmd');
    expect(engine.formatShortcutKeyLabel('Ctrl')).toBe('⌃ Ctrl');
    expect(engine.formatShortcutKeyLabel('Alt')).toBe('⌥ Option');
    expect(engine.formatShortcutKeyLabel('Shift')).toBe('⇧ Shift');
  });

  it('returns PageUp and PageDown labels', () => {
    const engine = createShortcutEngineController(makeDeps('linux'));
    expect(engine.formatShortcutKeyLabel('PageUp')).toBe('Page Up');
    expect(engine.formatShortcutKeyLabel('PageDown')).toBe('Page Down');
  });
});

describe('setShortcutBindings', () => {
  it('replaces the internal shortcutBindings', () => {
    const engine = createShortcutEngineController(makeDeps());
    const custom = { 'my-action': ['Ctrl', 'M'] };
    engine.setShortcutBindings(custom);
    expect(engine.getShortcutBindings()).toBe(custom);
  });

  it('affects getShortcutBinding results', () => {
    const engine = createShortcutEngineController(makeDeps());
    engine.setShortcutBindings({ 'my-action': ['Ctrl', 'M'] });
    expect(engine.getShortcutBinding('my-action')).toEqual(['Ctrl', 'M']);
    expect(engine.getShortcutBinding('nonexistent')).toBeUndefined();
  });

  it('sets empty bindings', () => {
    const engine = createShortcutEngineController(makeDeps());
    engine.setShortcutBindings({});
    expect(Object.keys(engine.getShortcutBindings()).length).toBe(0);
  });
});

describe('syncShortcutBindingsFromSettings (extended)', () => {
  it('saves settings when save option is true and changes were made', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);

    const settings = {} as Settings;
    engine.syncShortcutBindingsFromSettings(settings, { save: true });
    expect(deps.debouncedSaveSettings).toHaveBeenCalledWith(100);
  });

  it('does not save when save option is true but no changes were made', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);

    const defaults = getDefaultShortcuts('linux');
    const settings = { shortcuts: { ...defaults } } as unknown as Settings;
    engine.syncShortcutBindingsFromSettings(settings, { save: true });
    expect(deps.debouncedSaveSettings).not.toHaveBeenCalled();
  });

  it('does not save when save option is false even if changes occurred', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);
    const settings = {} as Settings;
    engine.syncShortcutBindingsFromSettings(settings, { save: false });
    expect(deps.debouncedSaveSettings).not.toHaveBeenCalled();
  });

  it('resets invalid binding without modifier to default', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);

    const settings = {
      shortcuts: {
        'command-palette': ['A'],
      },
    } as unknown as Settings;
    engine.syncShortcutBindingsFromSettings(settings);
    const bindings = engine.getShortcutBindings();

    expect(bindings['command-palette']).toEqual(['Ctrl', 'K']);
  });

  it('handles reserved shortcut conflict by falling back to default', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);

    const defaults = getDefaultShortcuts('linux');
    const shortcuts: Record<string, string[]> = { ...defaults };
    shortcuts['command-palette'] = ['Ctrl', 'R'];
    const settings = { shortcuts } as unknown as Settings;
    engine.syncShortcutBindingsFromSettings(settings);
    const bindings = engine.getShortcutBindings();

    expect(bindings['command-palette']).toEqual(['Ctrl', 'K']);
  });

  it('clears binding to empty when duplicate and fallback also used', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);
    const defaults = getDefaultShortcuts('linux');
    const shortcuts: Record<string, string[]> = { ...defaults };

    shortcuts['command-palette'] = ['Ctrl', ','];
    shortcuts['settings'] = ['Ctrl', ','];
    const settings = { shortcuts } as unknown as Settings;
    engine.syncShortcutBindingsFromSettings(settings);
    const bindings = engine.getShortcutBindings();

    expect(bindings['settings']).toEqual([]);
  });

  it('resolves duplicate by falling back to default when available', () => {
    const deps = makeDeps();
    const engine = createShortcutEngineController(deps);
    const defaults = getDefaultShortcuts('linux');
    const shortcuts: Record<string, string[]> = { ...defaults };

    shortcuts['settings'] = defaults['command-palette'];
    const settings = { shortcuts } as unknown as Settings;
    engine.syncShortcutBindingsFromSettings(settings);
    const bindings = engine.getShortcutBindings();
    const cpKey = engine.serializeShortcut(bindings['command-palette'] || []);
    const settingsKey = engine.serializeShortcut(bindings['settings'] || []);
    if (cpKey && settingsKey) {
      expect(cpKey).not.toBe(settingsKey);
    }
  });
});

describe('getFixedShortcutActionIdFromEvent', () => {
  it('returns action id for F5 refresh', () => {
    const engine = createShortcutEngineController(makeDeps());
    engine.rebuildFixedShortcuts();
    const result = engine.getFixedShortcutActionIdFromEvent(makeEvent({ key: 'F5' }));
    expect(result).toBe('refresh');
  });

  it('returns null for unregistered fixed shortcut', () => {
    const engine = createShortcutEngineController(makeDeps());
    engine.rebuildFixedShortcuts();
    const result = engine.getFixedShortcutActionIdFromEvent(makeEvent({ key: 'q', ctrlKey: true }));
    expect(result).toBeNull();
  });

  it('returns null for modifier-only event', () => {
    const engine = createShortcutEngineController(makeDeps());
    engine.rebuildFixedShortcuts();
    const result = engine.getFixedShortcutActionIdFromEvent(makeEvent({ key: 'Shift' }));
    expect(result).toBeNull();
  });
});

describe('isMacPlatform', () => {
  it('returns true when getPlatformOS returns darwin', () => {
    const engine = createShortcutEngineController(makeDeps('darwin'));
    expect(engine.isMacPlatform()).toBe(true);
  });

  it('returns false when getPlatformOS returns linux', () => {
    const engine = createShortcutEngineController(makeDeps('linux'));
    expect(engine.isMacPlatform()).toBe(false);
  });

  it('falls back to process.platform when getPlatformOS returns empty string', () => {
    const engine = createShortcutEngineController(makeDeps(''));

    expect(engine.isMacPlatform()).toBe(false);
  });
});

describe('eventToBinding edge cases', () => {
  it('ignores shift for _ key', () => {
    const engine = createShortcutEngineController(makeDeps());
    const binding = engine.eventToBinding(makeEvent({ key: '_', shiftKey: true }));
    expect(binding).toEqual(['-']);
  });

  it('includes Meta modifier', () => {
    const engine = createShortcutEngineController(makeDeps());
    const binding = engine.eventToBinding(makeEvent({ key: 'a', metaKey: true }));
    expect(binding).toEqual(['Meta', 'A']);
  });

  it('returns null for empty key', () => {
    const engine = createShortcutEngineController(makeDeps());
    const binding = engine.eventToBinding(makeEvent({ key: '' }));
    expect(binding).toBeNull();
  });
});

describe('rebuildShortcutLookup', () => {
  it('skips empty bindings during rebuild', () => {
    const engine = createShortcutEngineController(makeDeps());
    engine.setShortcutBindings({
      test: ['Ctrl', 'T'],
      empty: [],
    });
    engine.rebuildShortcutLookup();
    expect(engine.shortcutLookup.has('Ctrl::T')).toBe(true);
    expect(engine.shortcutLookup.size).toBe(1);
  });
});

describe('registerReservedShortcut edge cases', () => {
  it('handles null actionId by storing undefined', () => {
    const engine = createShortcutEngineController(makeDeps());
    engine.registerReservedShortcut(['Shift', 'Delete'], null as any, 'Permanent Delete');
    const entry = engine.reservedShortcutLookup.get('Shift::Delete');
    expect(entry?.label).toBe('Permanent Delete');
    expect(entry?.actionId).toBeUndefined();
  });
});

describe('shortcutDefinitionById', () => {
  it('contains all SHORTCUT_DEFINITIONS keyed by id', () => {
    const engine = createShortcutEngineController(makeDeps());
    expect(engine.shortcutDefinitionById.has('command-palette')).toBe(true);
    expect(engine.shortcutDefinitionById.has('copy')).toBe(true);
    expect(engine.shortcutDefinitionById.get('copy')?.title).toBe('Copy');
  });
});

describe('getShortcutBinding edge cases', () => {
  it('returns undefined for id with empty binding array', () => {
    const engine = createShortcutEngineController(makeDeps());
    engine.setShortcutBindings({ empty: [] });
    expect(engine.getShortcutBinding('empty')).toBeUndefined();
  });

  it('returns the binding when it has entries', () => {
    const engine = createShortcutEngineController(makeDeps());
    engine.setShortcutBindings({ test: ['Ctrl', 'A'] });
    expect(engine.getShortcutBinding('test')).toEqual(['Ctrl', 'A']);
  });
});
