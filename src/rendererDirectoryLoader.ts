import { devLog, ignoreError } from './shared.js';

interface DirectoryLoaderConfig {
  getLoadingEl: () => HTMLElement | null;
  getLoadingTextEl: () => HTMLElement | null;
  getEmptyStateEl: () => HTMLElement | null;
  cancelDirectoryContents: (operationId: string) => Promise<unknown>;
  throttleMs: number;
}

export function createDirectoryLoaderController(config: DirectoryLoaderConfig) {
  let activeDirectoryProgressPath: string | null = null;
  let activeDirectoryProgressOperationId: string | null = null;
  let activeDirectoryOperationId: string | null = null;
  let directoryRequestId = 0;
  let directoryProgressCount = 0;
  let lastDirectoryProgressUpdate = 0;
  let lastStaleProgressLogAt = 0;

  function createOperationId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function startRequest(dirPath: string): { requestId: number; operationId: string } {
    const requestId = ++directoryRequestId;
    if (activeDirectoryOperationId) {
      devLog('DirectoryLoader', 'Cancelling previous request', {
        previousOperationId: activeDirectoryOperationId,
        nextPath: dirPath,
      });
      config.cancelDirectoryContents(activeDirectoryOperationId).catch(ignoreError);
    }
    const operationId = createOperationId('dir');
    activeDirectoryOperationId = operationId;
    activeDirectoryProgressOperationId = operationId;
    activeDirectoryProgressPath = dirPath;
    directoryProgressCount = 0;
    lastDirectoryProgressUpdate = 0;
    const loadingText = config.getLoadingTextEl();
    if (loadingText) loadingText.textContent = 'Loading...';
    devLog('DirectoryLoader', 'Request started', { requestId, operationId, dirPath });
    return { requestId, operationId };
  }

  function finishRequest(requestId: number): void {
    if (requestId !== directoryRequestId) {
      devLog('DirectoryLoader', 'Ignored finishRequest for stale request', {
        requestId,
        activeRequestId: directoryRequestId,
      });
      return;
    }
    activeDirectoryOperationId = null;
    activeDirectoryProgressOperationId = null;
    activeDirectoryProgressPath = null;
    directoryProgressCount = 0;
    lastDirectoryProgressUpdate = 0;
    const loadingText = config.getLoadingTextEl();
    if (loadingText) loadingText.textContent = 'Loading...';
    devLog('DirectoryLoader', 'Request finished', { requestId });
  }

  function showLoading(context?: string): void {
    const loading = config.getLoadingEl();
    const loadingText = config.getLoadingTextEl();
    const emptyState = config.getEmptyStateEl();
    if (loading) loading.style.display = 'flex';
    if (loadingText) loadingText.textContent = context || 'Loading...';
    if (emptyState) emptyState.style.display = 'none';
  }

  function hideLoading(): void {
    const loading = config.getLoadingEl();
    const loadingText = config.getLoadingTextEl();
    if (loading) loading.style.display = 'none';
    if (loadingText) loadingText.textContent = 'Loading...';
  }

  function cancelRequest(): void {
    if (activeDirectoryOperationId) {
      devLog('DirectoryLoader', 'Cancelling active request', {
        operationId: activeDirectoryOperationId,
        requestId: directoryRequestId,
      });
      config.cancelDirectoryContents(activeDirectoryOperationId).catch(ignoreError);
    }
    directoryRequestId += 1;
    finishRequest(directoryRequestId);
  }

  function handleProgress(progress: {
    operationId?: string;
    dirPath?: string;
    loaded: number;
  }): void {
    const now = Date.now();
    if (activeDirectoryProgressOperationId) {
      if (progress.operationId !== activeDirectoryProgressOperationId) {
        if (now - lastStaleProgressLogAt > 1000) {
          lastStaleProgressLogAt = now;
          devLog('DirectoryLoader', 'Ignored stale progress (operation mismatch)', {
            expectedOperationId: activeDirectoryProgressOperationId,
            receivedOperationId: progress.operationId ?? '',
            loaded: progress.loaded,
          });
        }
        return;
      }
    } else if (!activeDirectoryProgressPath || progress.dirPath !== activeDirectoryProgressPath) {
      if (now - lastStaleProgressLogAt > 1000) {
        lastStaleProgressLogAt = now;
        devLog('DirectoryLoader', 'Ignored stale progress (path mismatch)', {
          expectedPath: activeDirectoryProgressPath ?? '',
          receivedPath: progress.dirPath ?? '',
          loaded: progress.loaded,
        });
      }
      return;
    }
    directoryProgressCount = progress.loaded;
    if (now - lastDirectoryProgressUpdate < config.throttleMs) return;
    lastDirectoryProgressUpdate = now;
    const loadingText = config.getLoadingTextEl();
    if (loadingText) {
      loadingText.textContent = `Loading... (${directoryProgressCount.toLocaleString()} items)`;
    }
    devLog('DirectoryLoader', 'Progress', {
      operationId: progress.operationId ?? '',
      dirPath: progress.dirPath ?? '',
      loaded: directoryProgressCount,
    });
  }

  function getCurrentRequestId(): number {
    return directoryRequestId;
  }

  function isCurrentRequest(requestId: number): boolean {
    return requestId !== 0 && requestId === directoryRequestId;
  }

  return {
    createOperationId,
    startRequest,
    finishRequest,
    showLoading,
    hideLoading,
    cancelRequest,
    handleProgress,
    getCurrentRequestId,
    isCurrentRequest,
  };
}
