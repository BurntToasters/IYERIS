/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./rendererUtils.js', () => ({
  twemojiImg: () => '<img />',
}));

import { createIndexerController } from './rendererIndexer';

describe('createIndexerController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div id="index-status"></div>
      <button id="rebuild-index-btn">Rebuild</button>
    `;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders indexing status text', async () => {
    Object.defineProperty(window, 'electronAPI', {
      value: {
        getIndexStatus: vi.fn().mockResolvedValue({
          success: true,
          status: { isIndexing: true, indexedFiles: 1500 },
        }),
        rebuildIndex: vi.fn(),
      },
      configurable: true,
      writable: true,
    });

    const showToast = vi.fn();
    const controller = createIndexerController({
      getShowToast: () => showToast,
    });

    await controller.updateIndexStatus();

    expect(document.getElementById('index-status')!.textContent).toContain(
      'Status: Indexing... (1,500 files found)'
    );
  });

  it('starts polling and stops when indexing completes', async () => {
    const getIndexStatus = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        status: { isIndexing: true, indexedFiles: 10 },
      })
      .mockResolvedValueOnce({
        success: true,
        status: { isIndexing: false, indexedFiles: 10, lastIndexTime: Date.now() },
      })
      .mockResolvedValue({
        success: true,
        status: { isIndexing: false, indexedFiles: 10, lastIndexTime: Date.now() },
      });

    Object.defineProperty(window, 'electronAPI', {
      value: {
        getIndexStatus,
        rebuildIndex: vi.fn(),
      },
      configurable: true,
      writable: true,
    });

    const controller = createIndexerController({
      getShowToast: () => vi.fn(),
    });

    controller.startIndexStatusPolling();
    await vi.advanceTimersByTimeAsync(600);
    const callsAfterStop = getIndexStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);

    expect(getIndexStatus).toHaveBeenCalled();
    expect(getIndexStatus.mock.calls.length).toBe(callsAfterStop);
    expect(document.getElementById('index-status')!.textContent).toContain('Indexing...');
  });

  it('handles rebuild success and resets button state', async () => {
    const rebuildIndex = vi.fn().mockResolvedValue({ success: true });
    const getIndexStatus = vi.fn().mockResolvedValue({
      success: true,
      status: { isIndexing: false, indexedFiles: 0, lastIndexTime: null },
    });

    Object.defineProperty(window, 'electronAPI', {
      value: {
        getIndexStatus,
        rebuildIndex,
      },
      configurable: true,
      writable: true,
    });

    const showToast = vi.fn();
    const controller = createIndexerController({
      getShowToast: () => showToast,
    });

    await controller.rebuildIndex();
    await vi.advanceTimersByTimeAsync(350);

    const button = document.getElementById('rebuild-index-btn') as HTMLButtonElement;
    expect(rebuildIndex).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Index rebuild started', 'File Indexer', 'success');
    expect(button.disabled).toBe(false);
    expect(button.innerHTML).toBe('Rebuild');
  });

  it('handles rebuild failures', async () => {
    Object.defineProperty(window, 'electronAPI', {
      value: {
        getIndexStatus: vi.fn().mockResolvedValue({ success: false }),
        rebuildIndex: vi.fn().mockResolvedValue({ success: false, error: 'boom' }),
      },
      configurable: true,
      writable: true,
    });

    const showToast = vi.fn();
    const controller = createIndexerController({
      getShowToast: () => showToast,
    });

    await controller.rebuildIndex();

    expect(showToast).toHaveBeenCalledWith('Failed to rebuild index: boom', 'Error', 'error');
  });
});
