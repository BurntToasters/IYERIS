// @vitest-environment jsdom
/**
 * Regression tests for the command palette.
 * N8: renderCommandPaletteResults must clear aria-activedescendant from the
 *     search input before rebuilding the results list.  Previously stale
 *     ids pointing at removed option elements were left in place, causing
 *     assistive technology to announce nonexistent items.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../rendererDom.js', () => ({
  clearHtml: (el: Element | null) => {
    if (el) el.replaceChildren();
  },
}));
vi.mock('../shared.js', () => ({
  escapeHtml: (v: string) => v,
  devLog: vi.fn(),
}));
vi.mock('../rendererUtils.js', () => ({
  twemojiImg: () => '<img />',
}));

import { createCommandPaletteController } from '../rendererCommandPalette';

function buildDom() {
  // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
  document.body.innerHTML = `
    <div id="command-palette-modal" style="display:none">
      <input id="command-palette-input" type="text" aria-autocomplete="list"
             aria-controls="command-palette-results" role="combobox"
             aria-expanded="false" />
      <div id="command-palette-results" role="listbox" style="display:flex"></div>
      <div id="command-palette-empty"  style="display:none"></div>
    </div>
  `;
  HTMLElement.prototype.scrollIntoView = function () {};
}

function createDeps() {
  return {
    activateModal: vi.fn(),
    deactivateModal: vi.fn(),
    showToast: vi.fn(),
    getShortcutBinding: vi.fn(() => undefined),
    fixedShortcuts: {} as Record<string, string[]>,
    remappableCommandIds: new Set<string>(),
    formatShortcutKeyLabel: vi.fn((k: string) => k),
    getTabsEnabled: vi.fn(() => true),
    twemojiImg: vi.fn((emoji: string) => `<img alt="${emoji}" />`),
    actions: {
      createNewFolder: vi.fn(),
      createNewFile: vi.fn(),
      refresh: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      goUp: vi.fn(),
      goHome: vi.fn(),
      findDuplicates: vi.fn(),
      showSettingsModal: vi.fn(),
      showShortcutsModal: vi.fn(),
      selectAll: vi.fn(),
      copyToClipboard: vi.fn(),
      cutToClipboard: vi.fn(),
      pasteFromClipboard: vi.fn(),
      deleteSelected: vi.fn(),
      renameSelected: vi.fn(),
      setViewMode: vi.fn(),
      addNewTab: vi.fn(),
    },
  };
}

describe('rendererCommandPalette — N8 stale aria-activedescendant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildDom();
  });

  it('removes aria-activedescendant from input when results are re-rendered', () => {
    const ctrl = createCommandPaletteController(createDeps() as any);
    ctrl.initCommandPalette();
    ctrl.showCommandPalette();

    const input = document.getElementById('command-palette-input') as HTMLInputElement;

    // Simulate a focused result — sets aria-activedescendant.
    input.setAttribute('aria-activedescendant', 'command-palette-option-0');
    expect(input.getAttribute('aria-activedescendant')).toBe('command-palette-option-0');

    // Typing forces a re-render of results (renderCommandPaletteResults is called).
    input.value = 'set';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // The stale aria-activedescendant must have been cleared.
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('removes aria-activedescendant when the search input is cleared', () => {
    const ctrl = createCommandPaletteController(createDeps() as any);
    ctrl.initCommandPalette();
    ctrl.showCommandPalette();

    const input = document.getElementById('command-palette-input') as HTMLInputElement;
    input.setAttribute('aria-activedescendant', 'command-palette-option-1');

    // Clear the search → full list re-render.
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('does not set aria-activedescendant when results are rendered without keyboard focus', () => {
    const ctrl = createCommandPaletteController(createDeps() as any);
    ctrl.initCommandPalette();
    ctrl.showCommandPalette();

    const input = document.getElementById('command-palette-input') as HTMLInputElement;

    // Render results via an input event without ever focusing an item.
    input.value = 'f';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Nothing focused yet — attribute must be absent.
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('clears aria-activedescendant on showCommandPalette (re-open resets stale focus)', () => {
    const ctrl = createCommandPaletteController(createDeps() as any);
    ctrl.initCommandPalette();

    const input = document.getElementById('command-palette-input') as HTMLInputElement;
    input.setAttribute('aria-activedescendant', 'command-palette-option-99');

    ctrl.showCommandPalette();

    // Re-opening resets all stale focus state.
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });
});
