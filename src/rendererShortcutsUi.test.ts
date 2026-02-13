/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./shared.js', () => ({
  escapeHtml: (t: unknown) => String(t ?? ''),
}));

import { createShortcutsUiController } from './rendererShortcutsUi.js';

type Deps = Parameters<typeof createShortcutsUiController>[0];

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    isMacPlatform: () => false,
    formatShortcutKeyLabel: (key: string) => key,
    getDefaultShortcuts: () => ({ 'action-a': ['Ctrl', 'A'], 'action-b': ['Ctrl', 'B'] }),
    shortcutDefinitions: [
      { id: 'action-a', title: 'Action A', category: 'General', keys: ['Ctrl', 'A'] },
      { id: 'action-b', title: 'Action B', category: 'General', keys: ['Ctrl', 'B'] },
    ] as any[],
    getShortcutBindings: () => ({ 'action-a': ['Ctrl', 'A'], 'action-b': ['Ctrl', 'B'] }),
    setShortcutBindings: vi.fn(),
    normalizeShortcutBinding: (b: any) => b,
    areBindingsEqual: (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b),
    getCurrentSettings: () => ({}) as any,
    rebuildShortcutLookup: vi.fn(),
    syncCommandShortcuts: vi.fn(),
    debouncedSaveSettings: vi.fn(),
    eventToBinding: vi.fn((e: KeyboardEvent) => [e.ctrlKey ? 'Ctrl' : '', e.key].filter(Boolean)),
    hasModifier: vi.fn((b: any) =>
      b.some((k: string) => ['Ctrl', 'Meta', 'Alt', 'Shift'].includes(k))
    ),
    serializeShortcut: vi.fn((b: any) => b.join('+')),
    reservedShortcutLookup: new Map(),
    shortcutLookup: new Map(),
    shortcutDefinitionById: new Map([
      [
        'action-a',
        { id: 'action-a', title: 'Action A', category: 'General', keys: ['Ctrl', 'A'] } as any,
      ],
      [
        'action-b',
        { id: 'action-b', title: 'Action B', category: 'General', keys: ['Ctrl', 'B'] } as any,
      ],
    ]),
    showToast: vi.fn(),
    ...overrides,
  };
}

describe('rendererShortcutsUi', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('renderShortcutsModal', () => {
    it('renders sections with remappable and fixed shortcut items', () => {
      document.body.innerHTML = '<div id="shortcuts-modal-sections"></div>';
      const deps = makeDeps();
      const ctrl = createShortcutsUiController(deps);
      ctrl.renderShortcutsModal();

      const container = document.getElementById('shortcuts-modal-sections')!;
      expect(container.innerHTML).toContain('General');
      expect(container.innerHTML).toContain('Action A');
      expect(container.innerHTML).toContain('Change');
      // Fixed items
      expect(container.innerHTML).toContain('Refresh');
      expect(container.innerHTML).toContain('Navigate Files');
    });

    it('does nothing without container', () => {
      const deps = makeDeps();
      const ctrl = createShortcutsUiController(deps);
      ctrl.renderShortcutsModal(); // no error
    });

    it('shows Unassigned for empty binding', () => {
      document.body.innerHTML = '<div id="shortcuts-modal-sections"></div>';
      const deps = makeDeps({
        getShortcutBindings: () => ({ 'action-a': [], 'action-b': ['Ctrl', 'B'] }),
      });
      const ctrl = createShortcutsUiController(deps);
      ctrl.renderShortcutsModal();
      expect(document.getElementById('shortcuts-modal-sections')!.innerHTML).toContain(
        'Unassigned'
      );
    });

    it('disables reset button when binding matches default', () => {
      document.body.innerHTML = '<div id="shortcuts-modal-sections"></div>';
      const deps = makeDeps();
      const ctrl = createShortcutsUiController(deps);
      ctrl.renderShortcutsModal();

      const resetBtns = document.querySelectorAll('[data-shortcut-action="reset"]');
      expect(resetBtns.length).toBeGreaterThan(0);
      resetBtns.forEach((btn) => {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });
    });

    it('enables reset button when binding differs from default', () => {
      document.body.innerHTML = '<div id="shortcuts-modal-sections"></div>';
      const deps = makeDeps({
        getShortcutBindings: () => ({ 'action-a': ['Ctrl', 'Z'], 'action-b': ['Ctrl', 'B'] }),
        areBindingsEqual: (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b),
      });
      const ctrl = createShortcutsUiController(deps);
      ctrl.renderShortcutsModal();

      const items = document.querySelectorAll('[data-shortcut-id="action-a"]');
      const resetBtn = items[0]?.querySelector(
        '[data-shortcut-action="reset"]'
      ) as HTMLButtonElement;
      expect(resetBtn?.disabled).toBe(false);
    });

    it('includes Mac-specific refresh modifier', () => {
      document.body.innerHTML = '<div id="shortcuts-modal-sections"></div>';
      const deps = makeDeps({ isMacPlatform: () => true });
      const ctrl = createShortcutsUiController(deps);
      ctrl.renderShortcutsModal();
      // On Mac, refresh uses Meta key
      const container = document.getElementById('shortcuts-modal-sections')!;
      expect(container.innerHTML).toContain('Meta');
    });

    it('adds Redo category on non-Mac only', () => {
      document.body.innerHTML = '<div id="shortcuts-modal-sections"></div>';
      const deps = makeDeps({ isMacPlatform: () => false });
      const ctrl = createShortcutsUiController(deps);
      ctrl.renderShortcutsModal();
      const container = document.getElementById('shortcuts-modal-sections')!;
      expect(container.innerHTML).toContain('Undo/Redo');
    });

    it('omits Redo category on Mac', () => {
      document.body.innerHTML = '<div id="shortcuts-modal-sections"></div>';
      const deps = makeDeps({ isMacPlatform: () => true });
      const ctrl = createShortcutsUiController(deps);
      ctrl.renderShortcutsModal();
      const container = document.getElementById('shortcuts-modal-sections')!;
      expect(container.innerHTML).not.toContain('Undo/Redo');
    });
  });

  describe('initShortcutsModal', () => {
    it('does nothing without container', () => {
      const deps = makeDeps();
      const ctrl = createShortcutsUiController(deps);
      ctrl.initShortcutsModal(); // no error
    });

    it('delegates click to edit button', () => {
      document.body.innerHTML = '<div id="shortcuts-modal-sections"></div>';
      const deps = makeDeps();
      const ctrl = createShortcutsUiController(deps);
      ctrl.renderShortcutsModal();
      ctrl.initShortcutsModal();

      const editBtn = document.querySelector('[data-shortcut-action="edit"]') as HTMLButtonElement;
      expect(editBtn).toBeTruthy();
      editBtn.click();
      expect(ctrl.isShortcutCaptureActive()).toBe(true);
    });

    it('delegates click to reset button', () => {
      document.body.innerHTML = '<div id="shortcuts-modal-sections"></div>';
      const deps = makeDeps({
        getShortcutBindings: () => ({ 'action-a': ['Ctrl', 'Z'], 'action-b': ['Ctrl', 'B'] }),
        areBindingsEqual: (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b),
      });
      const ctrl = createShortcutsUiController(deps);
      ctrl.renderShortcutsModal();
      ctrl.initShortcutsModal();

      const resetBtn = document.querySelector(
        '[data-shortcut-id="action-a"] [data-shortcut-action="reset"]'
      ) as HTMLButtonElement;
      expect(resetBtn?.disabled).toBe(false);
      resetBtn.click();
      expect(deps.setShortcutBindings).toHaveBeenCalled();
      expect(deps.rebuildShortcutLookup).toHaveBeenCalled();
    });

    it('ignores click on disabled button', () => {
      document.body.innerHTML = '<div id="shortcuts-modal-sections"></div>';
      const deps = makeDeps();
      const ctrl = createShortcutsUiController(deps);
      ctrl.renderShortcutsModal();
      ctrl.initShortcutsModal();

      const resetBtn = document.querySelector(
        '[data-shortcut-action="reset"]'
      ) as HTMLButtonElement;
      expect(resetBtn.disabled).toBe(true);
      resetBtn.click();
      expect(deps.setShortcutBindings).not.toHaveBeenCalled();
    });

    it('ignores click on non-button elements', () => {
      document.body.innerHTML = '<div id="shortcuts-modal-sections"><span>text</span></div>';
      const deps = makeDeps();
      const ctrl = createShortcutsUiController(deps);
      ctrl.initShortcutsModal();

      document.querySelector('span')!.click();
      // no error
    });
  });

  describe('startShortcutCapture / stopShortcutCapture', () => {
    function setupCapture() {
      document.body.innerHTML = '<div id="shortcuts-modal-sections"></div>';
      const deps = makeDeps();
      const ctrl = createShortcutsUiController(deps);
      ctrl.renderShortcutsModal();
      ctrl.initShortcutsModal();
      return { deps, ctrl };
    }

    it('starts capture mode on edit click', () => {
      const { ctrl } = setupCapture();
      const editBtn = document.querySelector('[data-shortcut-action="edit"]') as HTMLButtonElement;
      editBtn.click();
      expect(ctrl.isShortcutCaptureActive()).toBe(true);
      expect(editBtn.textContent).toBe('Press keys...');
      const item = editBtn.closest('[data-shortcut-id]')!;
      expect(item.classList.contains('is-recording')).toBe(true);
    });

    it('stops capture on Escape', () => {
      const { ctrl } = setupCapture();
      const editBtn = document.querySelector('[data-shortcut-action="edit"]') as HTMLButtonElement;
      editBtn.click();
      expect(ctrl.isShortcutCaptureActive()).toBe(true);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(ctrl.isShortcutCaptureActive()).toBe(false);
      expect(editBtn.textContent).toBe('Change');
    });

    it('sets binding on valid shortcut key', () => {
      const { deps, ctrl } = setupCapture();
      const editBtn = document.querySelector('[data-shortcut-action="edit"]') as HTMLButtonElement;
      editBtn.click();

      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'X', ctrlKey: true, bubbles: true })
      );

      expect(ctrl.isShortcutCaptureActive()).toBe(false);
      expect(deps.setShortcutBindings).toHaveBeenCalled();
      expect(deps.rebuildShortcutLookup).toHaveBeenCalled();
      expect(deps.syncCommandShortcuts).toHaveBeenCalled();
      expect(deps.debouncedSaveSettings).toHaveBeenCalledWith(100);
    });

    it('shows warning when shortcut has no modifier', () => {
      const { deps, ctrl } = setupCapture();
      vi.mocked(deps.hasModifier).mockReturnValue(false);

      const editBtn = document.querySelector('[data-shortcut-action="edit"]') as HTMLButtonElement;
      editBtn.click();

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', bubbles: true }));

      expect(deps.showToast).toHaveBeenCalledWith(
        'Shortcuts must include a modifier key',
        'Shortcut Required',
        'warning'
      );
      expect(ctrl.isShortcutCaptureActive()).toBe(true); // still capturing
    });

    it('shows warning for reserved shortcut', () => {
      const { deps, ctrl } = setupCapture();
      deps.reservedShortcutLookup.set('Ctrl+Q', { label: 'Quit', actionId: 'quit' });
      vi.mocked(deps.serializeShortcut).mockReturnValue('Ctrl+Q');

      const editBtn = document.querySelector('[data-shortcut-action="edit"]') as HTMLButtonElement;
      editBtn.click();

      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Q', ctrlKey: true, bubbles: true })
      );

      expect(deps.showToast).toHaveBeenCalledWith(
        'Reserved for Quit',
        'Shortcut Reserved',
        'warning'
      );
    });

    it('shows warning for conflicting shortcut', () => {
      const { deps, ctrl } = setupCapture();
      deps.shortcutLookup.set('Ctrl+B', 'action-b');
      vi.mocked(deps.serializeShortcut).mockReturnValue('Ctrl+B');

      const editBtn = document.querySelector('[data-shortcut-action="edit"]') as HTMLButtonElement;
      editBtn.click();

      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'B', ctrlKey: true, bubbles: true })
      );

      expect(deps.showToast).toHaveBeenCalledWith(
        'Already used by "Action B"',
        'Shortcut In Use',
        'warning'
      );
    });

    it('allows same shortcut for same action (no conflict)', () => {
      const { deps, ctrl } = setupCapture();
      deps.shortcutLookup.set('Ctrl+A', 'action-a');
      vi.mocked(deps.serializeShortcut).mockReturnValue('Ctrl+A');

      const editBtn = document.querySelector(
        '[data-shortcut-id="action-a"] [data-shortcut-action="edit"]'
      ) as HTMLButtonElement;
      editBtn.click();

      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'A', ctrlKey: true, bubbles: true })
      );

      expect(deps.showToast).not.toHaveBeenCalled();
      expect(deps.setShortcutBindings).toHaveBeenCalled();
    });

    it('allows reserved shortcut for same action', () => {
      const { deps, ctrl } = setupCapture();
      deps.reservedShortcutLookup.set('Ctrl+A', { label: 'Select All', actionId: 'action-a' });
      vi.mocked(deps.serializeShortcut).mockReturnValue('Ctrl+A');

      const editBtn = document.querySelector(
        '[data-shortcut-id="action-a"] [data-shortcut-action="edit"]'
      ) as HTMLButtonElement;
      editBtn.click();

      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'A', ctrlKey: true, bubbles: true })
      );

      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('stopShortcutCapture is safe when not capturing', () => {
      const deps = makeDeps();
      const ctrl = createShortcutsUiController(deps);
      ctrl.stopShortcutCapture(); // no error
      expect(ctrl.isShortcutCaptureActive()).toBe(false);
    });

    it('ignores null binding from eventToBinding', () => {
      const { deps, ctrl } = setupCapture();
      vi.mocked(deps.eventToBinding).mockReturnValue(null);

      const editBtn = document.querySelector('[data-shortcut-action="edit"]') as HTMLButtonElement;
      editBtn.click();

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));

      expect(ctrl.isShortcutCaptureActive()).toBe(true); // still capturing
    });
  });

  describe('isShortcutCaptureActive', () => {
    it('returns false initially', () => {
      const deps = makeDeps();
      const ctrl = createShortcutsUiController(deps);
      expect(ctrl.isShortcutCaptureActive()).toBe(false);
    });
  });
});
