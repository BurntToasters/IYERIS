// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../rendererDom.js', () => ({
  getById: (id: string) => document.getElementById(id),
  clearHtml: (element: Element | null) => {
    if (element) element.innerHTML = '';
  },
}));

const { devLogMock } = vi.hoisted(() => ({
  devLogMock: vi.fn(),
}));

vi.mock('../shared.js', () => ({
  devLog: devLogMock,
  escapeHtml: (value: string) => value,
}));

import { createArchiveOperationsController } from '../rendererArchiveOperations';
import { ARCHIVE_RENDER_THROTTLE_MS, ARCHIVE_COMPLETION_DELAY_MS } from '../rendererLocalConstants';

describe('createArchiveOperationsController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div id="archive-operations-panel" style="display:none">
        <div id="archive-operations-list"></div>
      </div>
    `;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('adds and renders an operation and shows panel', () => {
    const deps = {
      cancelArchiveOperation: vi.fn().mockResolvedValue({ success: true }),
    };

    const controller = createArchiveOperationsController(deps);
    controller.addOperation('op-1', 'compress', 'Project');

    const panel = document.getElementById('archive-operations-panel') as HTMLElement;
    const list = document.getElementById('archive-operations-list') as HTMLElement;

    expect(panel.style.display).toBe('block');
    expect(list.textContent).toContain('Compressing: Project');
    expect(list.textContent).toContain('Preparing...');
    expect(list.querySelector('.archive-operation-cancel')).toBeTruthy();
  });

  it('updates progress after debounce', () => {
    const deps = {
      cancelArchiveOperation: vi.fn().mockResolvedValue({ success: true }),
    };

    const controller = createArchiveOperationsController(deps);
    controller.addOperation('op-1', 'extract', 'archive.zip');

    controller.updateOperation('op-1', 2, 4, 'a.txt');
    vi.advanceTimersByTime(ARCHIVE_RENDER_THROTTLE_MS + 10);

    const list = document.getElementById('archive-operations-list') as HTMLElement;
    const progressBar = list.querySelector('.archive-progress-bar') as HTMLElement;
    expect(list.textContent).toContain('Extracting: archive.zip');
    expect(list.textContent).toContain('2 / 4 files');
    expect(list.textContent).toContain('a.txt');
    expect(progressBar.style.width).toBe('50%');
  });

  it('aborts operation, calls cancel API, and removes operation after delay', async () => {
    const deps = {
      cancelArchiveOperation: vi.fn().mockResolvedValue({ success: true }),
    };

    const controller = createArchiveOperationsController(deps);
    controller.addOperation('op-1', 'compress', 'Project');
    controller.abortOperation('op-1');

    const list = document.getElementById('archive-operations-list') as HTMLElement;
    expect(list.textContent).toContain('Cancelling...');
    expect(deps.cancelArchiveOperation).toHaveBeenCalledWith('op-1');

    vi.advanceTimersByTime(ARCHIVE_COMPLETION_DELAY_MS);
    await Promise.resolve();

    const panel = document.getElementById('archive-operations-panel') as HTMLElement;
    expect(controller.getOperation('op-1')).toBeUndefined();
    expect(list.children.length).toBe(0);
    expect(panel.style.display).toBe('none');
  });

  it('logs when cancel API resolves with failure', async () => {
    const deps = {
      cancelArchiveOperation: vi.fn().mockResolvedValue({ success: false, error: 'cannot-cancel' }),
    };

    const controller = createArchiveOperationsController(deps);
    controller.addOperation('op-1', 'compress', 'Project');
    controller.abortOperation('op-1');

    await Promise.resolve();

    expect(deps.cancelArchiveOperation).toHaveBeenCalledWith('op-1');
    expect(devLogMock).toHaveBeenCalledWith('Archive', 'Failed to cancel', 'cannot-cancel');
  });

  it('logs when cancel API rejects', async () => {
    const cancelError = new Error('network');
    const deps = {
      cancelArchiveOperation: vi.fn().mockRejectedValue(cancelError),
    };

    const controller = createArchiveOperationsController(deps);
    controller.addOperation('op-1', 'extract', 'archive.zip');
    controller.abortOperation('op-1');

    await Promise.resolve();
    await Promise.resolve();

    expect(deps.cancelArchiveOperation).toHaveBeenCalledWith('op-1');
    expect(devLogMock).toHaveBeenCalledWith('Archive', 'Error cancelling operation', cancelError);
  });

  it('handles missing list element and nonexistent operation ids as no-ops', () => {
    document.body.innerHTML = `
      <div id="archive-operations-panel" style="display:none"></div>
    `;

    const deps = {
      cancelArchiveOperation: vi.fn().mockResolvedValue({ success: true }),
    };

    const controller = createArchiveOperationsController(deps);
    controller.addOperation('op-1', 'compress', 'Project');
    controller.updateOperation('missing-op', 1, 2, 'a.txt');
    controller.abortOperation('missing-op');
    controller.removeOperation('missing-op');

    const panel = document.getElementById('archive-operations-panel') as HTMLElement;
    expect(controller.getOperation('op-1')).toBeTruthy();
    expect(deps.cancelArchiveOperation).not.toHaveBeenCalled();
    expect(panel.style.display).toBe('block');
  });

  it('supports rendering when panel element is missing', () => {
    document.body.innerHTML = `
      <div id="archive-operations-list"></div>
    `;

    const deps = {
      cancelArchiveOperation: vi.fn().mockResolvedValue({ success: true }),
    };

    const controller = createArchiveOperationsController(deps);
    controller.addOperation('op-1', 'extract', 'archive.zip');
    controller.removeOperation('op-1');

    const list = document.getElementById('archive-operations-list') as HTMLElement;
    expect(list.children.length).toBe(0);
  });

  it('attaches click cancel listener once and only cancels when data-id exists', () => {
    const deps = {
      cancelArchiveOperation: vi.fn().mockResolvedValue({ success: true }),
    };

    const controller = createArchiveOperationsController(deps);
    controller.addOperation('op-1', 'compress', 'Project 1');
    controller.addOperation('op-2', 'extract', 'Project 2');

    const list = document.getElementById('archive-operations-list') as HTMLElement;
    const cancelButton = list.querySelector(
      '.archive-operation-cancel[data-id="op-1"]'
    ) as HTMLButtonElement;
    cancelButton.click();

    const orphanCancelButton = document.createElement('button');
    orphanCancelButton.className = 'archive-operation-cancel';
    list.appendChild(orphanCancelButton);
    orphanCancelButton.click();

    expect(deps.cancelArchiveOperation).toHaveBeenCalledTimes(1);
    expect(deps.cancelArchiveOperation).toHaveBeenCalledWith('op-1');
    expect(controller.getOperation('op-1')?.aborted).toBe(true);
  });

  it('keeps panel visible while at least one operation remains', () => {
    const deps = {
      cancelArchiveOperation: vi.fn().mockResolvedValue({ success: true }),
    };

    const controller = createArchiveOperationsController(deps);
    controller.addOperation('op-1', 'compress', 'Project 1');
    controller.addOperation('op-2', 'extract', 'Project 2');
    controller.removeOperation('op-1');

    const panel = document.getElementById('archive-operations-panel') as HTMLElement;
    expect(panel.style.display).toBe('block');
    expect(controller.getOperation('op-2')).toBeTruthy();

    controller.removeOperation('op-2');
    expect(panel.style.display).toBe('none');
  });

  it('does not render pending debounced update after cleanup', () => {
    const deps = {
      cancelArchiveOperation: vi.fn().mockResolvedValue({ success: true }),
    };

    const controller = createArchiveOperationsController(deps);
    controller.addOperation('op-1', 'extract', 'archive.zip');
    controller.updateOperation('op-1', 1, 2, 'a.txt');
    controller.cleanup();
    vi.advanceTimersByTime(ARCHIVE_RENDER_THROTTLE_MS + 10);

    const list = document.getElementById('archive-operations-list') as HTMLElement;
    expect(list.textContent).toContain('Preparing...');
    expect(list.textContent).not.toContain('1 / 2 files');
  });
});
