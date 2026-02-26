import { escapeHtml } from './shared.js';
import type { Settings } from './types';
import type { ShortcutBinding, ShortcutDefinition } from './shortcuts.js';

type ToastType = 'success' | 'error' | 'info' | 'warning';

type ShortcutToken = { keys: string[] } | { text: string };

interface FixedShortcutItem {
  title: string;
  tokens: ShortcutToken[];
}

interface ShortcutsUiDeps {
  isMacPlatform: () => boolean;
  formatShortcutKeyLabel: (key: string) => string;
  getDefaultShortcuts: () => Record<string, ShortcutBinding>;
  shortcutDefinitions: ShortcutDefinition[];
  getShortcutBindings: () => Record<string, ShortcutBinding>;
  setShortcutBindings: (bindings: Record<string, ShortcutBinding>) => void;
  normalizeShortcutBinding: (binding: ShortcutBinding) => ShortcutBinding;
  areBindingsEqual: (a: ShortcutBinding, b: ShortcutBinding) => boolean;
  getCurrentSettings: () => Settings;
  rebuildShortcutLookup: () => void;
  syncCommandShortcuts: () => void;
  debouncedSaveSettings: (delay?: number) => void;
  eventToBinding: (e: KeyboardEvent) => ShortcutBinding | null;
  hasModifier: (binding: ShortcutBinding) => boolean;
  serializeShortcut: (binding: ShortcutBinding) => string;
  reservedShortcutLookup: Map<string, { label: string; actionId?: string }>;
  shortcutLookup: Map<string, string>;
  shortcutDefinitionById: Map<string, ShortcutDefinition>;
  showToast: (message: string, title?: string, type?: ToastType) => void;
}

export function createShortcutsUiController(deps: ShortcutsUiDeps) {
  let isShortcutCaptureActive = false;
  let activeShortcutCapture: {
    id: string;
    button: HTMLButtonElement;
    item: HTMLElement;
  } | null = null;
  let shortcutCaptureCleanup: (() => void) | null = null;

  function getFixedShortcutsByCategory(): Map<string, FixedShortcutItem[]> {
    const refreshModifier = deps.isMacPlatform() ? 'Meta' : 'Ctrl';
    const entries: [string, FixedShortcutItem[]][] = [
      [
        'General',
        [
          {
            title: 'Refresh',
            tokens: [{ keys: ['F5'] }, { text: 'or' }, { keys: [refreshModifier, 'R'] }],
          },
          {
            title: 'Close Search',
            tokens: [{ keys: ['Escape'] }],
          },
        ],
      ],
      [
        'Navigation',
        [
          {
            title: 'Navigate Files',
            tokens: [
              { keys: ['ArrowUp'] },
              { keys: ['ArrowDown'] },
              { keys: ['ArrowLeft'] },
              { keys: ['ArrowRight'] },
            ],
          },
          {
            title: 'Open Selected',
            tokens: [{ keys: ['Enter'] }],
          },
          {
            title: 'First / Last File',
            tokens: [{ keys: ['Home'] }, { text: '/' }, { keys: ['End'] }],
          },
          {
            title: 'Page Up / Page Down',
            tokens: [{ keys: ['PageUp'] }, { text: '/' }, { keys: ['PageDown'] }],
          },
          {
            title: 'Go to Parent (Backspace)',
            tokens: [{ keys: ['Backspace'] }],
          },
          {
            title: 'Cycle Pane Focus',
            tokens: [{ keys: ['F6'] }],
          },
          {
            title: 'Context Menu',
            tokens: [{ keys: ['Shift', 'F10'] }],
          },
        ],
      ],
      [
        'File Operations',
        [
          {
            title: 'Rename',
            tokens: [{ keys: ['F2'] }],
          },
          {
            title: 'Delete (Trash)',
            tokens: [{ keys: ['Delete'] }],
          },
          {
            title: 'Permanent Delete',
            tokens: [{ keys: ['Shift', 'Delete'] }],
          },
        ],
      ],
      [
        'Selection',
        [
          {
            title: 'Multi-select',
            tokens: [{ keys: ['Ctrl'] }, { text: '+' }, { text: 'Click' }],
          },
          {
            title: 'Extend Selection',
            tokens: [
              { keys: ['Shift'] },
              { text: '+' },
              { keys: ['ArrowUp'] },
              { keys: ['ArrowDown'] },
              { keys: ['ArrowLeft'] },
              { keys: ['ArrowRight'] },
            ],
          },
          {
            title: 'Move Focus (No Select)',
            tokens: [
              { keys: ['Ctrl'] },
              { text: '+' },
              { keys: ['ArrowUp'] },
              { keys: ['ArrowDown'] },
              { keys: ['ArrowLeft'] },
              { keys: ['ArrowRight'] },
            ],
          },
          {
            title: 'Toggle Selection at Cursor',
            tokens: [{ keys: ['Ctrl', 'Space'] }],
          },
        ],
      ],
    ];
    const undoRedoItems: FixedShortcutItem[] = [];
    if (!deps.isMacPlatform()) {
      undoRedoItems.push({
        title: 'Redo (Alternate)',
        tokens: [{ keys: ['Ctrl', 'Shift', 'Z'] }],
      });
    }

    if (undoRedoItems.length > 0) {
      entries.push(['Undo/Redo', undoRedoItems]);
    }

    entries.push([
      'View',
      [
        {
          title: 'Quick Look',
          tokens: [{ keys: ['Space'] }],
        },
      ],
    ]);

    return new Map<string, FixedShortcutItem[]>(entries);
  }

  function renderShortcutTokens(tokens: ShortcutToken[]): string {
    const tokenHtml = tokens
      .map((token) => {
        if ('text' in token) {
          return `<span class="shortcut-text">${escapeHtml(token.text)}</span>`;
        }
        const keyHtml = token.keys
          .map((key, index) => {
            const label = escapeHtml(deps.formatShortcutKeyLabel(key));
            const plus =
              index < token.keys.length - 1 ? '<span class="shortcut-plus">+</span>' : '';
            return `<kbd>${label}</kbd>${plus}`;
          })
          .join('');
        return `<span class="shortcut-token">${keyHtml}</span>`;
      })
      .join('');
    return `<span class="shortcut-keys">${tokenHtml}</span>`;
  }

  function renderShortcutsModal(): void {
    const container = document.getElementById('shortcuts-modal-sections');
    if (!container) return;

    container.innerHTML = '';
    const defaults = deps.getDefaultShortcuts();
    const fixedShortcutsByCategory = getFixedShortcutsByCategory();
    const shortcutBindings = deps.getShortcutBindings();

    const categories = new Map<string, ShortcutDefinition[]>();
    for (const def of deps.shortcutDefinitions) {
      const list = categories.get(def.category) || [];
      list.push(def);
      categories.set(def.category, list);
    }

    const orderedCategories = Array.from(categories.keys());
    for (const category of fixedShortcutsByCategory.keys()) {
      if (!categories.has(category)) {
        orderedCategories.push(category);
      }
    }

    for (const category of orderedCategories) {
      const remappable = categories.get(category) || [];
      const fixed = fixedShortcutsByCategory.get(category) || [];
      if (remappable.length === 0 && fixed.length === 0) continue;

      const section = document.createElement('div');
      section.className = 'shortcuts-section';
      section.innerHTML = `<h3>${escapeHtml(category)}</h3>`;

      for (const def of remappable) {
        const defaultBinding = defaults[def.id] || [];
        const binding = shortcutBindings[def.id] ?? defaultBinding;
        const isDefault = deps.areBindingsEqual(binding, defaultBinding);
        const keyMarkup =
          binding.length > 0
            ? renderShortcutTokens([{ keys: binding }])
            : '<span class="shortcut-keys"><span class="shortcut-text">Unassigned</span></span>';
        const item = document.createElement('div');
        item.className = 'shortcut-item';
        item.dataset.shortcutId = def.id;
        item.innerHTML = `
        <div class="shortcut-info">
          <span class="shortcut-description">${escapeHtml(def.title)}</span>
        </div>
        <div class="shortcut-controls">
          ${keyMarkup}
          <button class="modal-button secondary" data-shortcut-action="edit">Change</button>
          <button class="modal-button secondary compact" data-shortcut-action="reset" ${isDefault ? 'disabled' : ''}>Reset</button>
        </div>
      `;
        section.appendChild(item);
      }

      for (const fixedItem of fixed) {
        const item = document.createElement('div');
        item.className = 'shortcut-item fixed';
        item.innerHTML = `
        <div class="shortcut-info">
          <span class="shortcut-description">${escapeHtml(fixedItem.title)}</span>
        </div>
        <div class="shortcut-controls">
          ${renderShortcutTokens(fixedItem.tokens)}
        </div>
      `;
        section.appendChild(item);
      }

      container.appendChild(section);
    }
  }

  function initShortcutsModal(): void {
    const container = document.getElementById('shortcuts-modal-sections');
    if (!container) return;

    container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const button = target.closest('button[data-shortcut-action]') as HTMLButtonElement | null;
      if (!button) return;
      if (button.disabled) return;
      const item = button.closest('[data-shortcut-id]') as HTMLElement | null;
      if (!item || !item.dataset.shortcutId) return;
      const action = button.dataset.shortcutAction;
      if (action === 'edit') {
        startShortcutCapture(item.dataset.shortcutId, button, item);
        return;
      }
      if (action === 'reset') {
        resetShortcutBinding(item.dataset.shortcutId);
      }
    });
  }

  function startShortcutCapture(id: string, button: HTMLButtonElement, item: HTMLElement): void {
    stopShortcutCapture();

    activeShortcutCapture = { id, button, item };
    isShortcutCaptureActive = true;
    item.classList.add('is-recording');
    button.textContent = 'Press keys...';

    const handleKeydown = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        stopShortcutCapture();
        return;
      }

      const binding = deps.eventToBinding(e);
      if (!binding) {
        return;
      }

      if (!deps.hasModifier(binding)) {
        deps.showToast('Shortcuts must include a modifier key', 'Shortcut Required', 'warning');
        return;
      }

      const serialized = deps.serializeShortcut(binding);
      const reservedEntry = deps.reservedShortcutLookup.get(serialized);
      if (reservedEntry && reservedEntry.actionId !== id) {
        deps.showToast(`Reserved for ${reservedEntry.label}`, 'Shortcut Reserved', 'warning');
        return;
      }
      const conflictId = deps.shortcutLookup.get(serialized);
      if (conflictId && conflictId !== id) {
        const conflictTitle = deps.shortcutDefinitionById.get(conflictId)?.title || conflictId;
        deps.showToast(`Already used by "${conflictTitle}"`, 'Shortcut In Use', 'warning');
        return;
      }

      stopShortcutCapture();
      setShortcutBinding(id, binding);
    };

    window.addEventListener('keydown', handleKeydown, true);
    shortcutCaptureCleanup = () => {
      window.removeEventListener('keydown', handleKeydown, true);
    };
  }

  function stopShortcutCapture(): void {
    if (shortcutCaptureCleanup) {
      shortcutCaptureCleanup();
      shortcutCaptureCleanup = null;
    }

    if (activeShortcutCapture) {
      activeShortcutCapture.item.classList.remove('is-recording');
      activeShortcutCapture.button.textContent = 'Change';
    }

    activeShortcutCapture = null;
    isShortcutCaptureActive = false;
  }

  function setShortcutBinding(id: string, binding: ShortcutBinding): void {
    const normalized = deps.normalizeShortcutBinding(binding);
    const settings = deps.getCurrentSettings();
    settings.shortcuts = {
      ...(settings.shortcuts || {}),
      [id]: normalized,
    };
    const nextBindings = {
      ...deps.getShortcutBindings(),
      [id]: normalized,
    };
    deps.setShortcutBindings(nextBindings);
    deps.rebuildShortcutLookup();
    deps.syncCommandShortcuts();
    renderShortcutsModal();
    deps.debouncedSaveSettings(100);
  }

  function resetShortcutBinding(id: string): void {
    const defaults = deps.getDefaultShortcuts();
    setShortcutBinding(id, defaults[id] || []);
  }

  return {
    renderShortcutsModal,
    initShortcutsModal,
    stopShortcutCapture,
    isShortcutCaptureActive: () => isShortcutCaptureActive,
  };
}
