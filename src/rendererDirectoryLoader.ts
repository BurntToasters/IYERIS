import { ignoreError } from './shared.js';

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

  function createOperationId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function startRequest(dirPath: string): { requestId: number; operationId: string } {
    const requestId = ++directoryRequestId;
    if (activeDirectoryOperationId) {
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
    return { requestId, operationId };
  }

  function finishRequest(requestId: number): void {
    if (requestId !== directoryRequestId) return;
    activeDirectoryOperationId = null;
    activeDirectoryProgressOperationId = null;
    activeDirectoryProgressPath = null;
    directoryProgressCount = 0;
    lastDirectoryProgressUpdate = 0;
    const loadingText = config.getLoadingTextEl();
    if (loadingText) loadingText.textContent = 'Loading...';
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
    if (activeDirectoryProgressOperationId) {
      if (progress.operationId !== activeDirectoryProgressOperationId) return;
    } else if (!activeDirectoryProgressPath || progress.dirPath !== activeDirectoryProgressPath) {
      return;
    }
    directoryProgressCount = progress.loaded;
    const now = Date.now();
    if (now - lastDirectoryProgressUpdate < config.throttleMs) return;
    lastDirectoryProgressUpdate = now;
    const loadingText = config.getLoadingTextEl();
    if (loadingText) {
      loadingText.textContent = `Loading... (${directoryProgressCount.toLocaleString()} items)`;
    }
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
