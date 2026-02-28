import type { Settings } from './types';
import { SHORTCUT_DEFINITIONS, getDefaultShortcuts } from './shortcuts.js';
import type { ShortcutBinding, ShortcutDefinition } from './shortcuts.js';

interface ReservedShortcut {
  label: string;
  actionId?: string;
}

interface ShortcutEngineDeps {
  getPlatformOS: () => string;
  syncCommandShortcuts: () => void;
  renderShortcutsModal: () => void;
  debouncedSaveSettings: (delay: number) => void;
}

export function createShortcutEngineController(deps: ShortcutEngineDeps) {
  const MODIFIER_ORDER = ['Ctrl', 'Shift', 'Alt', 'Meta'];
  const MODIFIER_SET = new Set(MODIFIER_ORDER);
  const shortcutLookup = new Map<string, string>();
  const fixedShortcutLookup = new Map<string, string>();
  const reservedShortcutLookup = new Map<string, ReservedShortcut>();
  let shortcutBindings: Record<string, ShortcutBinding> = {};

  const shortcutDefinitionById = new Map<string, ShortcutDefinition>(
    SHORTCUT_DEFINITIONS.map((def) => [def.id, def])
  );

  function isMacPlatform(): boolean {
    const platformOS = deps.getPlatformOS();
    if (platformOS) return platformOS === 'darwin';
    return typeof process !== 'undefined' && process.platform === 'darwin';
  }

  function normalizeModifierKey(key: string): string | null {
    const lower = key.toLowerCase();
    if (lower === 'control' || lower === 'ctrl') return 'Ctrl';
    if (lower === 'shift') return 'Shift';
    if (lower === 'alt' || lower === 'option') return 'Alt';
    if (lower === 'meta' || lower === 'cmd' || lower === 'command') return 'Meta';
    return null;
  }

  function normalizeKeyLabel(key: string): string | null {
    if (!key || key === 'Dead') return null;
    const modifier = normalizeModifierKey(key);
    if (modifier) return modifier;
    if (key === ' ') return 'Space';
    if (key === 'Esc') return 'Escape';
    if (key === 'Del') return 'Delete';
    if (key === '?') return '/';
    if (key === '+') return '=';
    if (key === '_') return '-';
    if (key.length === 1) return key.toUpperCase();
    return key;
  }

  function normalizeShortcutBinding(binding: string[]): ShortcutBinding {
    const modifiers = new Set<string>();
    let mainKey: string | null = null;
    for (const part of binding) {
      const normalized = normalizeKeyLabel(part);
      if (!normalized) continue;
      if (MODIFIER_SET.has(normalized)) {
        modifiers.add(normalized);
      } else if (!mainKey) {
        mainKey = normalized;
      }
    }
    const orderedModifiers = MODIFIER_ORDER.filter((mod) => modifiers.has(mod));
    return mainKey ? [...orderedModifiers, mainKey] : orderedModifiers;
  }

  function serializeShortcut(binding: ShortcutBinding): string {
    return binding.join('::');
  }

  function hasModifier(binding: ShortcutBinding): boolean {
    return binding.some((key) => MODIFIER_SET.has(key));
  }

  function eventToBinding(e: KeyboardEvent): ShortcutBinding | null {
    const key = normalizeKeyLabel(e.key);
    if (!key || MODIFIER_SET.has(key)) return null;
    const modifiers: string[] = [];
    const ignoreShift = e.shiftKey && (e.key === '?' || e.key === '+' || e.key === '_');
    if (e.ctrlKey) modifiers.push('Ctrl');
    if (e.shiftKey && !ignoreShift) modifiers.push('Shift');
    if (e.altKey) modifiers.push('Alt');
    if (e.metaKey) modifiers.push('Meta');
    return normalizeShortcutBinding([...modifiers, key]);
  }

  function rebuildShortcutLookup(): void {
    shortcutLookup.clear();
    for (const [id, binding] of Object.entries(shortcutBindings)) {
      if (binding.length === 0) continue;
      shortcutLookup.set(serializeShortcut(binding), id);
    }
  }

  function registerFixedShortcut(binding: ShortcutBinding, actionId: string): void {
    const normalized = normalizeShortcutBinding(binding);
    if (normalized.length === 0) return;
    fixedShortcutLookup.set(serializeShortcut(normalized), actionId);
  }

  function registerReservedShortcut(
    binding: ShortcutBinding,
    actionId: string | null,
    label: string
  ): void {
    const normalized = normalizeShortcutBinding(binding);
    if (normalized.length === 0) return;
    reservedShortcutLookup.set(serializeShortcut(normalized), {
      label,
      actionId: actionId ?? undefined,
    });
  }

  function rebuildFixedShortcuts(): void {
    fixedShortcutLookup.clear();
    registerFixedShortcut(['F5'], 'refresh');
    registerFixedShortcut(['Ctrl', 'R'], 'refresh');
    registerFixedShortcut(['Meta', 'R'], 'refresh');
    if (!isMacPlatform()) {
      registerFixedShortcut(['Ctrl', 'L'], 'focus-address-bar');
      registerFixedShortcut(['Ctrl', 'Shift', 'Z'], 'redo');
    } else {
      registerFixedShortcut(['Meta', 'Z'], 'undo');
      registerFixedShortcut(['Meta', 'Shift', 'Z'], 'redo');
    }
  }

  function rebuildReservedShortcuts(): void {
    reservedShortcutLookup.clear();
    registerReservedShortcut(['F5'], 'refresh', 'Refresh');
    registerReservedShortcut(['Ctrl', 'R'], 'refresh', 'Refresh');
    registerReservedShortcut(['Meta', 'R'], 'refresh', 'Refresh');
    registerReservedShortcut(['Shift', 'Delete'], null, 'Permanent Delete');
    registerReservedShortcut(['Shift', 'ArrowUp'], null, 'Extend Selection');
    registerReservedShortcut(['Shift', 'ArrowDown'], null, 'Extend Selection');
    registerReservedShortcut(['Shift', 'ArrowLeft'], null, 'Extend Selection');
    registerReservedShortcut(['Shift', 'ArrowRight'], null, 'Extend Selection');
    if (!isMacPlatform()) {
      registerReservedShortcut(['Ctrl', 'L'], 'focus-address-bar', 'Focus Address Bar');
      registerReservedShortcut(['Ctrl', 'Shift', 'Z'], 'redo', 'Redo');
    } else {
      registerReservedShortcut(['Meta', 'Z'], 'undo', 'Undo');
      registerReservedShortcut(['Meta', 'Shift', 'Z'], 'redo', 'Redo');
    }
  }

  function getFixedShortcutActionIdFromEvent(e: KeyboardEvent): string | null {
    const binding = eventToBinding(e);
    if (!binding) return null;
    return fixedShortcutLookup.get(serializeShortcut(binding)) ?? null;
  }

  function syncShortcutBindingsFromSettings(
    settings: Settings,
    options: { save?: boolean; render?: boolean } = {}
  ): void {
    rebuildFixedShortcuts();
    rebuildReservedShortcuts();
    const defaults = getDefaultShortcuts(isMacPlatform() ? 'darwin' : 'linux');
    const normalized: Record<string, ShortcutBinding> = {};
    const used = new Set<string>();
    let changed = false;

    for (const def of SHORTCUT_DEFINITIONS) {
      const raw = settings.shortcuts?.[def.id] || defaults[def.id];
      let binding = normalizeShortcutBinding(raw);
      if (binding.length > 0 && (!hasModifier(binding) || binding.length < 2)) {
        binding = normalizeShortcutBinding(defaults[def.id]);
        changed = true;
      }
      if (binding.length > 0) {
        let serialized = serializeShortcut(binding);
        const reservedEntry = reservedShortcutLookup.get(serialized);
        if (reservedEntry && reservedEntry.actionId !== def.id) {
          const fallback = normalizeShortcutBinding(defaults[def.id]);
          const fallbackSerialized = serializeShortcut(fallback);
          if (serialized !== fallbackSerialized) {
            binding = fallback;
            serialized = fallbackSerialized;
            changed = true;
          }
        }
        if (binding.length > 0 && used.has(serialized)) {
          const fallback = normalizeShortcutBinding(defaults[def.id]);
          const fallbackSerialized = serializeShortcut(fallback);
          if (!used.has(fallbackSerialized)) {
            binding = fallback;
          } else {
            binding = [];
          }
          changed = true;
          serialized = serializeShortcut(binding);
        }
        if (binding.length > 0) {
          used.add(serialized);
        }
      }
      normalized[def.id] = binding;
    }

    if (!settings.shortcuts) {
      settings.shortcuts = normalized;
      changed = true;
    } else if (changed) {
      settings.shortcuts = normalized;
    }

    shortcutBindings = normalized;
    rebuildShortcutLookup();
    deps.syncCommandShortcuts();
    if (options.render) {
      deps.renderShortcutsModal();
    }
    if (options.save && changed) {
      deps.debouncedSaveSettings(100);
    }
  }

  function getShortcutBinding(id: string): ShortcutBinding | undefined {
    const binding = shortcutBindings[id];
    return binding && binding.length > 0 ? binding : undefined;
  }

  function getShortcutActionIdFromEvent(e: KeyboardEvent): string | null {
    const binding = eventToBinding(e);
    if (!binding || !hasModifier(binding)) return null;
    return shortcutLookup.get(serializeShortcut(binding)) ?? null;
  }

  function areBindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
    return (
      serializeShortcut(normalizeShortcutBinding(a)) ===
      serializeShortcut(normalizeShortcutBinding(b))
    );
  }

  function formatModifierLabel(key: string): string {
    if (!isMacPlatform()) return key;
    if (key === 'Meta') return '⌘ Cmd';
    if (key === 'Ctrl') return '⌃ Ctrl';
    if (key === 'Alt') return '⌥ Option';
    if (key === 'Shift') return '⇧ Shift';
    return key;
  }

  function formatShortcutKeyLabel(key: string): string {
    if (MODIFIER_SET.has(key)) {
      return formatModifierLabel(key);
    }
    const labels: Record<string, string> = {
      ArrowLeft: '←',
      ArrowRight: '→',
      ArrowUp: '↑',
      ArrowDown: '↓',
      Escape: 'Esc',
      PageUp: 'Page Up',
      PageDown: 'Page Down',
      '/': '?',
    };
    return labels[key] || (key.length === 1 ? key.toUpperCase() : key);
  }

  return {
    isMacPlatform,
    normalizeModifierKey,
    normalizeKeyLabel,
    normalizeShortcutBinding,
    serializeShortcut,
    hasModifier,
    eventToBinding,
    rebuildShortcutLookup,
    registerFixedShortcut,
    registerReservedShortcut,
    rebuildFixedShortcuts,
    rebuildReservedShortcuts,
    getFixedShortcutActionIdFromEvent,
    syncShortcutBindingsFromSettings,
    getShortcutBinding,
    getShortcutActionIdFromEvent,
    areBindingsEqual,
    formatModifierLabel,
    formatShortcutKeyLabel,
    getShortcutBindings: () => shortcutBindings,
    setShortcutBindings: (bindings: Record<string, ShortcutBinding>) => {
      shortcutBindings = bindings;
    },
    shortcutLookup,
    fixedShortcutLookup,
    reservedShortcutLookup,
    shortcutDefinitionById,
    MODIFIER_ORDER,
    MODIFIER_SET,
  };
}
