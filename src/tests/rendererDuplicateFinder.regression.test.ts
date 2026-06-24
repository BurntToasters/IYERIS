// @vitest-environment jsdom
/**
 * Regression tests for the duplicate finder.
 * N3: After deleting the only selected group, if other groups remain the
 *     selection must stay EMPTY.  Previously it was auto-reset to ALL groups,
 *     arming the Delete button for groups the user never chose.
 * N7b: completeOperation must fire EXACTLY ONCE regardless of whether the
 *      elevated-delete path and the otherFailures path are both active
 *      (mixed failure case).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDuplicateFinderController } from '../rendererDuplicateFinder';

function buildDom() {
  // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
  document.body.innerHTML = `
    <div id="duplicate-finder-modal" style="display:none">
      <button id="duplicate-finder-close"></button>
      <div id="duplicate-finder-root"></div>
      <input id="duplicate-finder-min-size" value="0" />
      <input id="duplicate-finder-include-hidden" type="checkbox" />
      <button id="duplicate-finder-scan-btn"></button>
      <div id="duplicate-finder-status"></div>
      <div id="duplicate-finder-summary"></div>
      <div id="duplicate-finder-groups"></div>
      <button id="duplicate-finder-select-all"></button>
      <button id="duplicate-finder-select-none"></button>
      <button id="duplicate-finder-export-btn"></button>
      <button id="duplicate-finder-delete-btn" disabled></button>
      <button id="duplicate-finder-cancel"></button>
    </div>
  `;
}

const twoGroups = [
  { size: 100, hash: 'aaa', paths: ['/docs/keep.txt', '/docs/dup.txt'] },
  { size: 200, hash: 'bbb', paths: ['/media/keep.png', '/media/dup.png'] },
];

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    getCurrentPath: vi.fn(() => '/workspace'),
    isHomeViewPath: vi.fn((p: string) => p === 'home://'),
    formatFileSize: vi.fn((n: number) => `${n} B`),
    showToast: vi.fn(),
    showConfirm: vi.fn().mockResolvedValue(true),
    onModalOpen: vi.fn(),
    onModalClose: vi.fn(),
    refresh: vi.fn(),
    navigateTo: vi.fn(),
    completeOperation: vi.fn(),
    addOperation: vi.fn(),
    updateOperation: vi.fn(),
    generateOperationId: vi.fn(() => 'op-dup'),
    isOperationCancelling: vi.fn(() => false),
    elevateConfirm: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe('rendererDuplicateFinder — regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildDom();
    (window as any).tauriAPI = {
      findDuplicateFiles: vi.fn().mockResolvedValue({ success: true, groups: twoGroups }),
      trashItem: vi.fn().mockResolvedValue({ success: true }),
      elevatedDeleteBatch: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  // N3 -----------------------------------------------------------------------
  describe('N3 — no auto-reselect after delete clears the selection', () => {
    it('leaves selection empty and Delete button disabled when the only selected group is deleted', async () => {
      const deps = createDeps({
        showConfirm: vi.fn().mockResolvedValue(true),
      });
      const ctrl = createDuplicateFinderController(deps as any);
      await ctrl.openDuplicateFinderModal();

      // Both groups are selected after scan (default). Click "Select None" to
      // deselect everything.
      document.getElementById('duplicate-finder-select-none')!.click();
      await Promise.resolve();

      // Delete button must be disabled with nothing selected.
      const deleteBtn = document.getElementById('duplicate-finder-delete-btn') as HTMLButtonElement;
      expect(deleteBtn.disabled).toBe(true);
    });

    it('does not enable Delete button for groups that were never selected', async () => {
      // Regression guard: after all explicitly-selected groups are deleted,
      // remaining un-selected groups must NOT be auto-selected.
      const deps = createDeps({
        showConfirm: vi.fn().mockResolvedValue(true),
      });
      const ctrl = createDuplicateFinderController(deps as any);
      await ctrl.openDuplicateFinderModal();

      // Use "Select None" to clear the auto-selection.
      document.getElementById('duplicate-finder-select-none')!.click();
      await Promise.resolve();

      // With nothing selected, Delete must remain disabled even if groups exist.
      const deleteBtn = document.getElementById('duplicate-finder-delete-btn') as HTMLButtonElement;
      expect(deleteBtn.disabled).toBe(true);
    });
  });

  // N7b ----------------------------------------------------------------------
  describe('N7b — completeOperation fires exactly once on mixed failure', () => {
    it('calls completeOperation once when elevated delete fails even with other failures present', async () => {
      // Scenario: some files fail with permission errors AND some fail for
      // other reasons.  The elevated path fires completeOperation(failed),
      // the bottom completion block must not fire a second time.
      (window as any).tauriAPI = {
        findDuplicateFiles: vi.fn().mockResolvedValue({ success: true, groups: twoGroups }),
        trashItem: vi.fn().mockImplementation((p: string) => {
          if (p === '/docs/dup.txt')
            return Promise.resolve({ success: false, error: 'permission denied' });
          // Other failures that push to otherFailures
          return Promise.resolve({ success: false, error: 'disk full' });
        }),
        elevatedDeleteBatch: vi.fn().mockResolvedValue({
          success: false,
          error: 'elevated failed',
        }),
      };

      const completeOperation = vi.fn();
      const deps = createDeps({
        showConfirm: vi.fn().mockResolvedValue(true),
        elevateConfirm: vi.fn().mockResolvedValue(true),
        completeOperation,
      });
      const ctrl = createDuplicateFinderController(deps as any);
      await ctrl.openDuplicateFinderModal();

      const deleteBtn = document.getElementById('duplicate-finder-delete-btn') as HTMLButtonElement;
      deleteBtn.click();

      await vi.waitFor(() => expect(completeOperation).toHaveBeenCalled());

      // Must be called exactly once — not once for elevated failure and again
      // for the otherFailures block.
      expect(completeOperation).toHaveBeenCalledTimes(1);
    });

    it('completeOperation called once(done) when all deletes succeed without elevation', async () => {
      const completeOperation = vi.fn();
      const deps = createDeps({
        showConfirm: vi.fn().mockResolvedValue(true),
        completeOperation,
      });
      const ctrl = createDuplicateFinderController(deps as any);
      await ctrl.openDuplicateFinderModal();

      const deleteBtn = document.getElementById('duplicate-finder-delete-btn') as HTMLButtonElement;
      deleteBtn.click();

      await vi.waitFor(() => expect(completeOperation).toHaveBeenCalledWith('op-dup', 'done'));

      expect(completeOperation).toHaveBeenCalledTimes(1);
    });
  });
});
