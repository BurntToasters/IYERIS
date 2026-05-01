// @vitest-environment jsdom
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

describe('createOperationQueueController', () => {
  let collapsed = false;

  beforeEach(() => {
    vi.useFakeTimers();
    collapsed = false;
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
    window.tauriAPI = {
      onFileOperationProgress: vi.fn(),
    } as never;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function createController() {
    return createOperationQueueController({
      cancelArchiveOperation: vi.fn().mockResolvedValue({ success: true }),
      cancelChecksumCalculation: vi.fn().mockResolvedValue({ success: true }),
      getOperationPanelCollapsed: () => collapsed,
      setOperationPanelCollapsed: (value) => {
        collapsed = value;
      },
    });
  }

  it('renders active operation cards in progress panel', () => {
    const controller = createController();

    controller.addOperation('op-1', 'compress', 'bundle.zip', { cancellable: true });
    controller.updateOperation('op-1', {
      current: 2,
      total: 4,
      currentFile: 'src/app.ts',
    });

    const panel = document.getElementById('progress-panel') as HTMLElement;
    const content = document.getElementById('progress-panel-content') as HTMLElement;
    expect(panel.style.display).toBe('flex');
    expect(content.textContent).toContain('Compressing');
    expect(content.textContent).toContain('bundle.zip');
    expect(content.textContent).toContain('src/app.ts');
    expect(
      (content.querySelector('.operation-queue-progress-fill') as HTMLElement).style.width
    ).toBe('50%');
    expect(content.querySelector('.operation-queue-cancel')).toBeTruthy();
  });

  it('marks operation done then removes it after delay', () => {
    const controller = createController();

    controller.addOperation('op-1', 'extract', 'archive.zip');
    controller.completeOperation('op-1', 'done');

    expect(document.getElementById('progress-panel-content')!.textContent).toContain('Done');
    vi.advanceTimersByTime(4000);
    expect(controller.getOperation('op-1')).toBeUndefined();
    expect((document.getElementById('progress-panel') as HTMLElement).style.display).toBe('none');
  });

  it('routes cancellable archive operations through cancel API', () => {
    const cancelArchiveOperation = vi.fn().mockResolvedValue({ success: true });
    const controller = createOperationQueueController({
      cancelArchiveOperation,
      cancelChecksumCalculation: vi.fn().mockResolvedValue({ success: true }),
      getOperationPanelCollapsed: () => collapsed,
      setOperationPanelCollapsed: (value) => {
        collapsed = value;
      },
    });

    controller.addOperation('op-1', 'extract', 'archive.zip', { cancellable: true });
    (document.querySelector('.operation-queue-cancel') as HTMLButtonElement).click();

    expect(cancelArchiveOperation).toHaveBeenCalledWith('op-1');
    expect(controller.getOperation('op-1')?.status).toBe('cancelling');
  });

  it('tracks file-operation progress by operationId when provided', () => {
    const controller = createController();
    controller.bindFileOperationProgress();
    const callback = (window.tauriAPI.onFileOperationProgress as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(callback).toBeTypeOf('function');

    callback({
      operationId: 'copy-1',
      operation: 'copy',
      current: 1,
      total: 2,
      name: 'foo.txt',
    });
    callback({
      operationId: 'copy-2',
      operation: 'copy',
      current: 1,
      total: 2,
      name: 'bar.txt',
    });

    expect(controller.getOperation('copy-1')).toBeTruthy();
    expect(controller.getOperation('copy-2')).toBeTruthy();
    expect(controller.getOperation('copy') || controller.getOperation('file-copy')).toBeFalsy();
  });
});
