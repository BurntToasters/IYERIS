// @vitest-environment jsdom
/**
 * Regression tests for the operation queue.
 * M2: updateOperation must NOT revive a terminal (done / failed / cancelling)
 *     operation — a late backend progress event was flipping finished cards
 *     back to 'active', resetting the auto-remove timer and re-enabling the
 *     cancel button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../rendererDom.js', () => ({
  getById: (id: string) => document.getElementById(id),
  clearHtml: (element: Element | null) => {
    if (element) element.replaceChildren();
  },
}));
vi.mock('../shared.js', () => ({
  escapeHtml: (value: string) => value,
  devLog: vi.fn(),
}));

import { createOperationQueueController } from '../rendererOperationQueue';

describe('rendererOperationQueue — terminal-state guard (M2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
    document.body.innerHTML = `
      <div id="progress-panel" style="display:none">
        <button id="progress-panel-close"></button>
        <div id="progress-panel-content"></div>
      </div>
    `;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    window.tauriAPI = { onFileOperationProgress: vi.fn() } as never;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function createController() {
    return createOperationQueueController({
      cancelArchiveOperation: vi.fn().mockResolvedValue({ success: true }),
      cancelChecksumCalculation: vi.fn().mockResolvedValue({ success: true }),
      getOperationPanelCollapsed: () => false,
      setOperationPanelCollapsed: vi.fn(),
    });
  }

  it('ignores updateOperation after completeOperation(done) — late progress must not flip card back to active', () => {
    const ctrl = createController();
    ctrl.addOperation('op-done', 'copy', 'big-file.zip');
    ctrl.completeOperation('op-done', 'done');

    // Simulate late backend progress event arriving after completion.
    ctrl.updateOperation('op-done', { current: 1, total: 5, currentFile: 'new-file.ts' });

    // The operation must remain 'done' — not re-opened to 'active'.
    expect(ctrl.getOperation('op-done')?.status).toBe('done');
    // The file name from the late event must not appear in the card text.
    const content = document.getElementById('progress-panel-content')!;
    expect(content.textContent).not.toContain('new-file.ts');
  });

  it('ignores updateOperation after completeOperation(failed)', () => {
    const ctrl = createController();
    ctrl.addOperation('op-fail', 'move', 'folder/');
    ctrl.completeOperation('op-fail', 'failed', 'Permission denied');

    // Late progress event must not un-fail the card.
    ctrl.updateOperation('op-fail', { current: 3, total: 10, currentFile: 'late.ts' });

    expect(ctrl.getOperation('op-fail')?.status).toBe('failed');
    const content = document.getElementById('progress-panel-content')!;
    expect(content.textContent).not.toContain('late.ts');
  });

  it('ignores updateOperation while cancelling — no active-flicker during cancel', () => {
    const ctrl = createController();
    ctrl.addOperation('op-cancel', 'copy', 'archive.tar', { cancellable: true });
    // Trigger cancel via the cancel button (cancelOperation is not public).
    (document.querySelector('.operation-queue-cancel') as HTMLButtonElement)?.click();

    const statusBefore = ctrl.getOperation('op-cancel')?.status;
    // Late backend progress arrives while in 'cancelling' state.
    ctrl.updateOperation('op-cancel', { current: 2, total: 4, currentFile: 'snuck-in.ts' });

    expect(ctrl.getOperation('op-cancel')?.status).toBe(statusBefore);
    const content = document.getElementById('progress-panel-content')!;
    expect(content.textContent).not.toContain('snuck-in.ts');
  });

  it('still applies updateOperation while the operation is active', () => {
    const ctrl = createController();
    ctrl.addOperation('op-running', 'compress', 'bundle.zip', { total: 10 });
    ctrl.updateOperation('op-running', { current: 5, total: 10, currentFile: 'halfway.ts' });

    const content = document.getElementById('progress-panel-content')!;
    expect(content.textContent).toContain('halfway.ts');
  });

  it('ETA and progress bar update correctly before terminal state', () => {
    const ctrl = createController();
    ctrl.addOperation('op-progress', 'extract', 'big.tar.gz', { total: 100 });
    ctrl.updateOperation('op-progress', { current: 50, total: 100 });

    const fill = document.querySelector('.operation-queue-progress-fill') as HTMLElement | null;
    expect(fill?.style.width).toBe('50%');
  });
});
