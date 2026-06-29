// @vitest-environment jsdom
/**
 * Regression tests for batch rename.
 * N1: showBatchRenameModal must set style.display='flex' before calling
 *     activateModal — it was the only modal that skipped this, leaving the
 *     modal permanently hidden (style="display:none" from HTML wins over the
 *     .modal-overlay CSS rule without !important).
 * N9: The Apply button must have an in-flight guard: a second click while the
 *     first batchRename IPC call is pending must be a no-op.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createBatchRenameController } from '../rendererBatchRename';

function buildDom() {
  // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
  document.body.innerHTML = `
    <div id="batch-rename-modal" style="display:none">
      <button id="batch-rename-close"></button>
      <select id="batch-rename-mode">
        <option value="find-replace">Find &amp; Replace</option>
        <option value="sequential">Sequential</option>
        <option value="extension">Extension</option>
      </select>
      <div id="batch-rename-fields-find-replace">
        <input id="batch-rename-find" value="" />
        <input id="batch-rename-replace" value="" />
        <input id="batch-rename-use-regex" type="checkbox" />
      </div>
      <div id="batch-rename-fields-sequential" style="display:none">
        <input id="batch-rename-prefix" value="" />
        <input id="batch-rename-start" value="1" />
      </div>
      <div id="batch-rename-fields-extension" style="display:none">
        <input id="batch-rename-new-ext" value="" />
      </div>
      <div id="batch-rename-preview-list"></div>
      <button id="batch-rename-cancel"></button>
      <button id="batch-rename-apply"></button>
    </div>
  `;
}

const twoFiles = [
  { name: 'alpha.txt', path: '/ws/alpha.txt', isDirectory: false },
  { name: 'beta.txt', path: '/ws/beta.txt', isDirectory: false },
];

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    getSelectedItems: vi.fn(() => new Set(twoFiles.map((f) => f.path))),
    getAllFiles: vi.fn(() => [...twoFiles]),
    showToast: vi.fn(),
    activateModal: vi.fn(),
    deactivateModal: vi.fn(),
    refresh: vi.fn(),
    updateUndoRedoState: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('rendererBatchRename — regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildDom();
    (window as any).tauriAPI = {
      batchRename: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  // N1 -----------------------------------------------------------------------
  describe('N1 — modal must be visible when showBatchRenameModal is called', () => {
    it('sets modal display to flex', () => {
      const deps = createDeps();
      const ctrl = createBatchRenameController(deps as any);
      const modal = document.getElementById('batch-rename-modal')!;

      expect(modal.style.display).toBe('none');
      ctrl.showBatchRenameModal();
      expect(modal.style.display).toBe('flex');
    });

    it('calls activateModal with the modal element', () => {
      const deps = createDeps();
      const activateModal = vi.fn();
      const ctrl = createBatchRenameController({ ...deps, activateModal } as any);
      const modal = document.getElementById('batch-rename-modal')!;

      ctrl.showBatchRenameModal();

      // activateModal must be called AFTER display is set so the focus-trap
      // can find focusable elements inside the now-visible modal.
      expect(activateModal).toHaveBeenCalledWith(modal);
      expect(modal.style.display).toBe('flex'); // still flex, not reverted
    });

    it('hides modal on hideBatchRenameModal', () => {
      const deps = createDeps();
      const ctrl = createBatchRenameController(deps as any);
      const modal = document.getElementById('batch-rename-modal')!;

      ctrl.showBatchRenameModal();
      expect(modal.style.display).toBe('flex');

      ctrl.hideBatchRenameModal();
      expect(modal.style.display).toBe('none');
    });

    it('calls deactivateModal on hide', () => {
      const deps = createDeps();
      const deactivateModal = vi.fn();
      const ctrl = createBatchRenameController({ ...deps, deactivateModal } as any);

      ctrl.showBatchRenameModal();
      ctrl.hideBatchRenameModal();

      expect(deactivateModal).toHaveBeenCalled();
    });
  });

  // N9 -----------------------------------------------------------------------
  describe('N9 — Apply button must have an in-flight guard', () => {
    it('does not call batchRename twice on rapid double-click', async () => {
      const deps = createDeps();
      let resolveRename!: (v: { success: boolean }) => void;
      const batchRename = vi.fn(
        () =>
          new Promise<{ success: boolean }>((res) => {
            resolveRename = res;
          })
      );
      (window as any).tauriAPI = { batchRename };

      const ctrl = createBatchRenameController(deps as any);
      ctrl.initListeners();
      ctrl.showBatchRenameModal();

      // Produce at least one rename candidate.
      const findInput = document.getElementById('batch-rename-find') as HTMLInputElement;
      findInput.value = 'alpha';
      findInput.dispatchEvent(new Event('input'));

      const applyBtn = document.getElementById('batch-rename-apply')!;
      applyBtn.click(); // first click — IPC pending, guard armed
      applyBtn.click(); // second click — must be ignored

      resolveRename({ success: true });
      await new Promise((r) => setTimeout(r, 0));

      expect(batchRename).toHaveBeenCalledTimes(1);
    });

    it('re-enables after the first rename finishes — next click fires a new IPC call', async () => {
      const deps = createDeps();
      const batchRename = vi.fn().mockResolvedValue({ success: true });
      (window as any).tauriAPI = { batchRename };

      const ctrl = createBatchRenameController(deps as any);
      ctrl.initListeners();
      ctrl.showBatchRenameModal();

      const findInput = document.getElementById('batch-rename-find') as HTMLInputElement;
      findInput.value = 'alpha';
      findInput.dispatchEvent(new Event('input'));

      const applyBtn = document.getElementById('batch-rename-apply')!;
      applyBtn.click();
      await new Promise((r) => setTimeout(r, 0)); // first rename done

      // Re-open and try again (guard should be released after completion).
      ctrl.showBatchRenameModal();
      findInput.value = 'beta';
      findInput.dispatchEvent(new Event('input'));
      applyBtn.click();
      await new Promise((r) => setTimeout(r, 0));

      expect(batchRename).toHaveBeenCalledTimes(2);
    });
  });
});
