// @vitest-environment jsdom
//
// F1 (composition layer): rendererDirectoryLoader.ts was only reachable through
// rendererControllerWiring.ts, which no suite imported, so none of its
// request-currency or stale-progress guards had direct coverage. Those guards are
// what stop a slow directory listing from overwriting a newer one.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDirectoryLoaderController } from '../rendererDirectoryLoader';

const THROTTLE_MS = 100;

describe('rendererDirectoryLoader', () => {
  let loading: HTMLElement;
  let loadingText: HTMLElement;
  let emptyState: HTMLElement;
  let cancelDirectoryContents: ReturnType<typeof vi.fn>;
  let loader: ReturnType<typeof createDirectoryLoaderController>;

  function createLoader(overrides: Record<string, unknown> = {}) {
    return createDirectoryLoaderController({
      getLoadingEl: () => loading,
      getLoadingTextEl: () => loadingText,
      getEmptyStateEl: () => emptyState,
      cancelDirectoryContents,
      throttleMs: THROTTLE_MS,
      ...overrides,
    } as any);
  }

  beforeEach(() => {
    loading = document.createElement('div');
    loadingText = document.createElement('div');
    emptyState = document.createElement('div');
    cancelDirectoryContents = vi.fn(async () => ({ success: true }));
    loader = createLoader();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('operation ids', () => {
    it('prefixes and uniquifies operation ids', () => {
      const first = loader.createOperationId('dir');
      const second = loader.createOperationId('dir');
      expect(first).toMatch(/^dir-\d+-[a-z0-9]+$/);
      expect(first).not.toBe(second);
    });
  });

  describe('request lifecycle', () => {
    it('hands out increasing request ids and a fresh operation id per request', () => {
      const first = loader.startRequest('/a');
      const second = loader.startRequest('/b');
      expect(second.requestId).toBe(first.requestId + 1);
      expect(second.operationId).not.toBe(first.operationId);
    });

    it('cancels the previous native request when a new one starts', () => {
      const first = loader.startRequest('/a');
      expect(cancelDirectoryContents).not.toHaveBeenCalled();
      loader.startRequest('/b');
      expect(cancelDirectoryContents).toHaveBeenCalledWith(first.operationId);
      expect(cancelDirectoryContents).toHaveBeenCalledTimes(1);
    });

    it('swallows a rejected cancel so the new request still proceeds', async () => {
      cancelDirectoryContents.mockRejectedValueOnce(new Error('ipc down'));
      loader.startRequest('/a');
      const second = loader.startRequest('/b');
      await vi.advanceTimersByTimeAsync(0);
      expect(loader.isCurrentRequest(second.requestId)).toBe(true);
    });

    it('treats only the newest request as current', () => {
      const stale = loader.startRequest('/a');
      const current = loader.startRequest('/b');
      expect(loader.isCurrentRequest(stale.requestId)).toBe(false);
      expect(loader.isCurrentRequest(current.requestId)).toBe(true);
      expect(loader.getCurrentRequestId()).toBe(current.requestId);
    });

    it('never treats request id 0 as current', () => {
      expect(loader.isCurrentRequest(0)).toBe(false);
      expect(loader.getCurrentRequestId()).toBe(0);
    });

    it('resets the loading label when a request starts', () => {
      loadingText.textContent = 'Loading... (500 items)';
      loader.startRequest('/a');
      expect(loadingText.textContent).toBe('Loading...');
    });
  });

  describe('finishRequest', () => {
    it('clears progress state for the current request', () => {
      const current = loader.startRequest('/a');
      loader.handleProgress({ operationId: current.operationId, dirPath: '/a', loaded: 10 });
      expect(loadingText.textContent).toBe('Loading... (10 items)');

      loader.finishRequest(current.requestId);
      expect(loadingText.textContent).toBe('Loading...');

      // Progress from the finished operation must no longer be accepted.
      loadingText.textContent = 'untouched';
      loader.handleProgress({ operationId: current.operationId, dirPath: '/a', loaded: 99 });
      expect(loadingText.textContent).toBe('untouched');
    });

    it('ignores a finish for a superseded request so it cannot clear newer state', () => {
      const stale = loader.startRequest('/a');
      const current = loader.startRequest('/b');
      loader.finishRequest(stale.requestId);

      // The newer request is untouched and still accepts its own progress.
      expect(loader.isCurrentRequest(current.requestId)).toBe(true);
      loader.handleProgress({ operationId: current.operationId, dirPath: '/b', loaded: 7 });
      expect(loadingText.textContent).toBe('Loading... (7 items)');
    });
  });

  describe('loading indicator', () => {
    it('shows the spinner with a context label and hides the empty state', () => {
      emptyState.style.display = 'flex';
      loader.showLoading('Scanning archive...');
      expect(loading.style.display).toBe('flex');
      expect(loadingText.textContent).toBe('Scanning archive...');
      expect(emptyState.style.display).toBe('none');
    });

    it('falls back to a generic label when no context is given', () => {
      loader.showLoading();
      expect(loadingText.textContent).toBe('Loading...');
      loader.showLoading('');
      expect(loadingText.textContent).toBe('Loading...');
    });

    it('hides the spinner and resets the label', () => {
      loader.showLoading('Working');
      loader.hideLoading();
      expect(loading.style.display).toBe('none');
      expect(loadingText.textContent).toBe('Loading...');
    });

    it('is a no-op when the DOM elements are absent', () => {
      const detached = createLoader({
        getLoadingEl: () => null,
        getLoadingTextEl: () => null,
        getEmptyStateEl: () => null,
      });
      expect(() => {
        detached.showLoading('x');
        detached.hideLoading();
        detached.startRequest('/a');
        detached.finishRequest(detached.getCurrentRequestId());
        detached.handleProgress({ loaded: 1 });
      }).not.toThrow();
    });
  });

  describe('cancelRequest', () => {
    it('cancels the active native request and invalidates its request id', () => {
      const active = loader.startRequest('/a');
      loader.cancelRequest();
      expect(cancelDirectoryContents).toHaveBeenCalledWith(active.operationId);
      expect(loader.isCurrentRequest(active.requestId)).toBe(false);
    });

    it('still advances the request id when nothing is in flight', () => {
      const before = loader.getCurrentRequestId();
      loader.cancelRequest();
      expect(cancelDirectoryContents).not.toHaveBeenCalled();
      expect(loader.getCurrentRequestId()).toBe(before + 1);
    });

    it('drops progress from the cancelled operation', () => {
      const active = loader.startRequest('/a');
      loader.cancelRequest();
      loadingText.textContent = 'untouched';
      loader.handleProgress({ operationId: active.operationId, dirPath: '/a', loaded: 42 });
      expect(loadingText.textContent).toBe('untouched');
    });
  });

  describe('progress handling', () => {
    it('renders a localized item count for the active operation', () => {
      const active = loader.startRequest('/a');
      loader.handleProgress({ operationId: active.operationId, dirPath: '/a', loaded: 12345 });
      expect(loadingText.textContent).toBe(`Loading... (${(12345).toLocaleString()} items)`);
    });

    it('ignores progress from a superseded operation', () => {
      const stale = loader.startRequest('/a');
      loader.startRequest('/b');
      loadingText.textContent = 'untouched';

      loader.handleProgress({ operationId: stale.operationId, dirPath: '/a', loaded: 500 });
      expect(loadingText.textContent).toBe('untouched');

      // Repeated stale events stay silent too (log throttling must not leak through).
      vi.advanceTimersByTime(2000);
      loader.handleProgress({ operationId: stale.operationId, dirPath: '/a', loaded: 600 });
      expect(loadingText.textContent).toBe('untouched');
    });

    it('ignores progress when no request is active', () => {
      loadingText.textContent = 'untouched';
      loader.handleProgress({ operationId: 'dir-unknown', dirPath: '/a', loaded: 3 });
      expect(loadingText.textContent).toBe('untouched');
    });

    it('throttles UI updates but keeps the latest count', () => {
      const active = loader.startRequest('/a');
      loader.handleProgress({ operationId: active.operationId, dirPath: '/a', loaded: 100 });
      expect(loadingText.textContent).toBe('Loading... (100 items)');

      // Within the throttle window the label must not churn.
      vi.advanceTimersByTime(THROTTLE_MS - 1);
      loader.handleProgress({ operationId: active.operationId, dirPath: '/a', loaded: 200 });
      expect(loadingText.textContent).toBe('Loading... (100 items)');

      vi.advanceTimersByTime(2);
      loader.handleProgress({ operationId: active.operationId, dirPath: '/a', loaded: 300 });
      expect(loadingText.textContent).toBe('Loading... (300 items)');
    });
  });
});
