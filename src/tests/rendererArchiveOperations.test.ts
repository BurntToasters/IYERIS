// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../rendererDom.js', () => ({
  getById: (id: string) => document.getElementById(id),
  clearHtml: (element: Element | null) => {
    if (element) element.innerHTML = '';
  },
}));

vi.mock('../shared.js', () => ({
  escapeHtml: (value: string) => value,
}));

import { createArchiveOperationsController } from '../rendererArchiveOperations';

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
    vi.advanceTimersByTime(60);

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

    vi.advanceTimersByTime(1500);
    await Promise.resolve();

    const panel = document.getElementById('archive-operations-panel') as HTMLElement;
    expect(controller.getOperation('op-1')).toBeUndefined();
    expect(list.children.length).toBe(0);
    expect(panel.style.display).toBe('none');
  });
});
