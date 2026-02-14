// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../rendererDom.js', () => ({
  clearHtml: vi.fn((el: HTMLElement) => {
    if (el) el.innerHTML = '';
  }),
}));

vi.mock('../shared.js', () => ({
  escapeHtml: (s: string) => s,
}));

import { createCommandPaletteController } from '../rendererCommandPalette';

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    activateModal: vi.fn(),
    deactivateModal: vi.fn(),
    showToast: vi.fn(),
    getShortcutBinding: vi.fn(() => undefined),
    fixedShortcuts: {} as Record<string, string[]>,
    remappableCommandIds: new Set<string>(),
    formatShortcutKeyLabel: vi.fn((k: string) => k),
    getTabsEnabled: vi.fn(() => (overrides.tabsEnabled as boolean) ?? true),
    actions: {
      createNewFolder: vi.fn(),
      createNewFile: vi.fn(),
      refresh: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      goUp: vi.fn(),
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

function setupCommandPaletteDOM() {
  document.body.innerHTML = `
    <div id="command-palette-modal" style="display:none">
      <input id="command-palette-input" type="text" />
      <div id="command-palette-results" style="display:flex"></div>
      <div id="command-palette-empty" style="display:none"></div>
    </div>
  `;

  HTMLElement.prototype.scrollIntoView = function () {};
}

describe('createCommandPaletteController', () => {
  beforeEach(() => {
    setupCommandPaletteDOM();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initCommandPalette', () => {
    it('registers commands and sets up listeners', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();

      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);
      const results = document.getElementById('command-palette-results')!;
      const items = results.querySelectorAll('.command-palette-item');
      expect(items.length).toBeGreaterThan(0);
    });

    it('does nothing when DOM elements are missing', () => {
      document.body.innerHTML = '';
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);

      ctrl.initCommandPalette();
    });

    it('registers commands only once', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);
      const count1 = document.querySelectorAll('.command-palette-item').length;

      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);
      const count2 = document.querySelectorAll('.command-palette-item').length;
      expect(count2).toBe(count1);
    });
  });

  describe('showCommandPalette', () => {
    it('displays modal and renders all commands', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const modal = document.getElementById('command-palette-modal')!;
      expect(modal.style.display).toBe('flex');
      expect(deps.activateModal).toHaveBeenCalledWith(modal, { restoreFocus: false });
      const items = document.querySelectorAll('.command-palette-item');
      expect(items.length).toBeGreaterThan(10);
    });

    it('clears input value on open', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      const input = document.getElementById('command-palette-input') as HTMLInputElement;
      input.value = 'previous';
      ctrl.showCommandPalette();
      expect(input.value).toBe('');
    });

    it('does nothing when elements are missing', () => {
      document.body.innerHTML = '';
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);

      ctrl.showCommandPalette();
      expect(deps.activateModal).not.toHaveBeenCalled();
    });
  });

  describe('hideCommandPalette', () => {
    it('hides modal and deactivates it', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      ctrl.hideCommandPalette();
      const modal = document.getElementById('command-palette-modal')!;
      expect(modal.style.display).toBe('none');
      expect(deps.deactivateModal).toHaveBeenCalledWith(modal, { restoreFocus: false });
    });

    it('restores previous focus', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();

      const btn = document.createElement('button');
      btn.id = 'prev-focus';
      document.body.appendChild(btn);
      btn.focus();

      ctrl.showCommandPalette();
      ctrl.hideCommandPalette();

      expect(document.activeElement).toBe(btn);
    });
  });

  describe('search filtering', () => {
    it('filters commands by title', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const input = document.getElementById('command-palette-input') as HTMLInputElement;
      input.value = 'New Folder';
      input.dispatchEvent(new Event('input'));

      const results = document.getElementById('command-palette-results')!;
      const items = results.querySelectorAll('.command-palette-item');
      expect(items.length).toBeGreaterThanOrEqual(1);
    });

    it('filters commands by description', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const input = document.getElementById('command-palette-input') as HTMLInputElement;
      input.value = 'reload current';
      input.dispatchEvent(new Event('input'));

      const results = document.getElementById('command-palette-results')!;
      const items = results.querySelectorAll('.command-palette-item');
      expect(items.length).toBeGreaterThanOrEqual(1);
    });

    it('shows empty state when no commands match', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const input = document.getElementById('command-palette-input') as HTMLInputElement;
      input.value = 'xyznonexistent123';
      input.dispatchEvent(new Event('input'));

      const results = document.getElementById('command-palette-results')!;
      const empty = document.getElementById('command-palette-empty')!;
      expect(results.style.display).toBe('none');
      expect(empty.style.display).toBe('flex');
    });

    it('shows all commands when query is cleared', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const input = document.getElementById('command-palette-input') as HTMLInputElement;
      input.value = 'xyz';
      input.dispatchEvent(new Event('input'));
      input.value = '';
      input.dispatchEvent(new Event('input'));

      const items = document.querySelectorAll('.command-palette-item');
      expect(items.length).toBeGreaterThan(10);
    });
  });

  describe('keyboard navigation', () => {
    it('ArrowDown moves focus to next item', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const input = document.getElementById('command-palette-input') as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      const items = document.querySelectorAll('.command-palette-item');
      expect(items[0].classList.contains('focused')).toBe(true);
    });

    it('ArrowUp moves focus to previous item', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const input = document.getElementById('command-palette-input') as HTMLInputElement;

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));

      const items = document.querySelectorAll('.command-palette-item');
      expect(items[0].classList.contains('focused')).toBe(true);
      expect(items[1].classList.contains('focused')).toBe(false);
    });

    it('Enter executes the focused command', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const input = document.getElementById('command-palette-input') as HTMLInputElement;

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

      const modal = document.getElementById('command-palette-modal')!;
      expect(modal.style.display).toBe('none');
    });

    it('Enter executes first item when no focus', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const input = document.getElementById('command-palette-input') as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

      const modal = document.getElementById('command-palette-modal')!;
      expect(modal.style.display).toBe('none');
    });

    it('Escape hides the palette', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const input = document.getElementById('command-palette-input') as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      const modal = document.getElementById('command-palette-modal')!;
      expect(modal.style.display).toBe('none');
    });
  });

  describe('command execution', () => {
    it('clicking a command item executes it', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const items = document.querySelectorAll('.command-palette-item');
      (items[0] as HTMLElement).click();

      const modal = document.getElementById('command-palette-modal')!;
      expect(modal.style.display).toBe('none');
    });

    it('shows error toast when command execution throws', () => {
      const deps = createDeps();
      deps.actions.createNewFolder = vi.fn(() => {
        throw new Error('boom');
      });
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const items = document.querySelectorAll('.command-palette-item');
      (items[0] as HTMLElement).click();

      expect(deps.showToast).toHaveBeenCalledWith(
        expect.stringContaining('Failed to execute command'),
        'Command Error',
        'error'
      );
    });

    it('mouseenter sets focus on item', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const items = document.querySelectorAll('.command-palette-item');
      items[2].dispatchEvent(new Event('mouseenter'));
      expect(items[2].classList.contains('focused')).toBe(true);
    });
  });

  describe('syncCommandShortcuts', () => {
    it('updates shortcuts from remappable bindings', () => {
      const deps = createDeps();
      deps.remappableCommandIds = new Set(['new-folder']);
      deps.getShortcutBinding = vi.fn((id: string) =>
        id === 'new-folder' ? ['Ctrl', 'N'] : undefined
      ) as any;
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.syncCommandShortcuts();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const items = document.querySelectorAll('.command-palette-item');
      const firstItem = items[0];
      expect(firstItem.innerHTML).toContain('command-palette-key');
    });

    it('re-renders when palette is visible', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const countBefore = document.querySelectorAll('.command-palette-item').length;
      ctrl.syncCommandShortcuts();
      const countAfter = document.querySelectorAll('.command-palette-item').length;
      expect(countAfter).toBe(countBefore);
    });
  });

  describe('modal overlay click', () => {
    it('hides palette when clicking modal overlay', () => {
      const deps = createDeps();
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const modal = document.getElementById('command-palette-modal')!;

      modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(modal.style.display).toBe('none');
    });
  });

  describe('new-tab command', () => {
    it('calls addNewTab when tabs are enabled', () => {
      const deps = createDeps({ tabsEnabled: true });
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const input = document.getElementById('command-palette-input') as HTMLInputElement;
      input.value = 'New Tab';
      input.dispatchEvent(new Event('input'));

      const items = document.querySelectorAll('.command-palette-item');
      expect(items.length).toBeGreaterThanOrEqual(1);
      (items[0] as HTMLElement).click();
      expect(deps.actions.addNewTab).toHaveBeenCalled();
    });

    it('does not call addNewTab when tabs are disabled', () => {
      const deps = createDeps({ tabsEnabled: false });
      const ctrl = createCommandPaletteController(deps);
      ctrl.initCommandPalette();
      ctrl.showCommandPalette();
      vi.advanceTimersByTime(100);

      const input = document.getElementById('command-palette-input') as HTMLInputElement;
      input.value = 'New Tab';
      input.dispatchEvent(new Event('input'));

      const items = document.querySelectorAll('.command-palette-item');
      (items[0] as HTMLElement).click();
      expect(deps.actions.addNewTab).not.toHaveBeenCalled();
    });
  });
});
