import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const parentPort = {
    on: vi.fn(),
    postMessage: vi.fn(),
  };
  const cancelled = new Map<string, number>();

  return {
    parentPort,
    cancelled,
    pruneCancelled: vi.fn(),
    searchDirectoryFiles: vi.fn(),
    searchDirectoryContent: vi.fn(),
    searchContentList: vi.fn(),
    searchContentIndex: vi.fn(),
    searchIndexFile: vi.fn(),
    calculateFolderSize: vi.fn(),
    calculateChecksum: vi.fn(),
    buildIndex: vi.fn(),
    loadIndexFile: vi.fn(),
    saveIndexFile: vi.fn(),
    listDirectory: vi.fn(),
    exitSpy: vi.fn(),
  };
});

vi.mock('worker_threads', () => ({
  parentPort: mocks.parentPort,
}));

vi.mock('./workerUtils', () => ({
  isRecord: (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value),
  getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  cancelled: mocks.cancelled,
  pruneCancelled: mocks.pruneCancelled,
}));

vi.mock('./searchTasks', () => ({
  searchDirectoryFiles: mocks.searchDirectoryFiles,
  searchDirectoryContent: mocks.searchDirectoryContent,
  searchContentList: mocks.searchContentList,
  searchContentIndex: mocks.searchContentIndex,
  searchIndexFile: mocks.searchIndexFile,
}));

vi.mock('./computeTasks', () => ({
  calculateFolderSize: mocks.calculateFolderSize,
  calculateChecksum: mocks.calculateChecksum,
}));

vi.mock('./indexTasks', () => ({
  buildIndex: mocks.buildIndex,
  loadIndexFile: mocks.loadIndexFile,
  saveIndexFile: mocks.saveIndexFile,
}));

vi.mock('./listDirectoryTask', () => ({
  listDirectory: mocks.listDirectory,
}));

describe('workers/fileTasks extended', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.cancelled.clear();
  });

  async function loadMessageListener() {
    await import('./fileTasks');
    const messageCall = mocks.parentPort.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'message'
    );
    if (!messageCall) throw new Error('Message listener not registered');
    return messageCall[1] as (message: unknown) => Promise<void>;
  }

  describe('task handler dispatch for all task types', () => {
    it('dispatches search-content task', async () => {
      mocks.searchDirectoryContent.mockResolvedValueOnce(['content-hit']);
      const onMessage = await loadMessageListener();

      await onMessage({
        id: 't-sc',
        type: 'search-content',
        payload: { dir: '/a', query: 'x' },
        operationId: 'op-sc',
      });

      expect(mocks.searchDirectoryContent).toHaveBeenCalledWith({ dir: '/a', query: 'x' }, 'op-sc');
      expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
        type: 'result',
        id: 't-sc',
        success: true,
        data: ['content-hit'],
      });
    });

    it('dispatches search-content-list task', async () => {
      mocks.searchContentList.mockResolvedValueOnce(['list-hit']);
      const onMessage = await loadMessageListener();

      await onMessage({
        id: 't-scl',
        type: 'search-content-list',
        payload: { files: ['/a.txt'], query: 'y' },
        operationId: 'op-scl',
      });

      expect(mocks.searchContentList).toHaveBeenCalledWith(
        { files: ['/a.txt'], query: 'y' },
        'op-scl'
      );
      expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
        type: 'result',
        id: 't-scl',
        success: true,
        data: ['list-hit'],
      });
    });

    it('dispatches search-content-index task', async () => {
      mocks.searchContentIndex.mockResolvedValueOnce(['idx-hit']);
      const onMessage = await loadMessageListener();

      await onMessage({
        id: 't-sci',
        type: 'search-content-index',
        payload: { indexPath: '/idx', query: 'z' },
        operationId: 'op-sci',
      });

      expect(mocks.searchContentIndex).toHaveBeenCalledWith(
        { indexPath: '/idx', query: 'z' },
        'op-sci'
      );
      expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
        type: 'result',
        id: 't-sci',
        success: true,
        data: ['idx-hit'],
      });
    });

    it('dispatches search-index task', async () => {
      mocks.searchIndexFile.mockResolvedValueOnce(['si-hit']);
      const onMessage = await loadMessageListener();

      await onMessage({
        id: 't-si',
        type: 'search-index',
        payload: { indexFile: '/index.json', query: 'w' },
        operationId: 'op-si',
      });

      expect(mocks.searchIndexFile).toHaveBeenCalledWith(
        { indexFile: '/index.json', query: 'w' },
        'op-si'
      );
      expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
        type: 'result',
        id: 't-si',
        success: true,
        data: ['si-hit'],
      });
    });

    it('dispatches checksum task', async () => {
      mocks.calculateChecksum.mockResolvedValueOnce('abc123');
      const onMessage = await loadMessageListener();

      await onMessage({
        id: 't-cs',
        type: 'checksum',
        payload: { filePath: '/file.bin' },
        operationId: 'op-cs',
      });

      expect(mocks.calculateChecksum).toHaveBeenCalledWith({ filePath: '/file.bin' }, 'op-cs');
      expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
        type: 'result',
        id: 't-cs',
        success: true,
        data: 'abc123',
      });
    });

    it('dispatches build-index task', async () => {
      mocks.buildIndex.mockResolvedValueOnce({ entries: 42 });
      const onMessage = await loadMessageListener();

      await onMessage({
        id: 't-bi',
        type: 'build-index',
        payload: { dir: '/data' },
        operationId: 'op-bi',
      });

      expect(mocks.buildIndex).toHaveBeenCalledWith({ dir: '/data' }, 'op-bi');
      expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
        type: 'result',
        id: 't-bi',
        success: true,
        data: { entries: 42 },
      });
    });

    it('dispatches load-index task (no operationId forwarded)', async () => {
      mocks.loadIndexFile.mockResolvedValueOnce({ loaded: true });
      const onMessage = await loadMessageListener();

      await onMessage({
        id: 't-li',
        type: 'load-index',
        payload: { indexPath: '/idx.json' },
      });

      expect(mocks.loadIndexFile).toHaveBeenCalledWith({ indexPath: '/idx.json' });
      expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
        type: 'result',
        id: 't-li',
        success: true,
        data: { loaded: true },
      });
    });

    it('dispatches save-index task (no operationId forwarded)', async () => {
      mocks.saveIndexFile.mockResolvedValueOnce(undefined);
      const onMessage = await loadMessageListener();

      await onMessage({
        id: 't-si2',
        type: 'save-index',
        payload: { indexPath: '/idx.json', data: {} },
      });

      expect(mocks.saveIndexFile).toHaveBeenCalledWith({ indexPath: '/idx.json', data: {} });
      expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
        type: 'result',
        id: 't-si2',
        success: true,
        data: undefined,
      });
    });

    it('dispatches list-directory task', async () => {
      mocks.listDirectory.mockResolvedValueOnce([{ name: 'file.txt' }]);
      const onMessage = await loadMessageListener();

      await onMessage({
        id: 't-ld',
        type: 'list-directory',
        payload: { dir: '/home' },
        operationId: 'op-ld',
      });

      expect(mocks.listDirectory).toHaveBeenCalledWith({ dir: '/home' }, 'op-ld');
      expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
        type: 'result',
        id: 't-ld',
        success: true,
        data: [{ name: 'file.txt' }],
      });
    });
  });

  describe('error handling for uncovered task types', () => {
    it('posts error when search-content-list handler throws', async () => {
      mocks.searchContentList.mockRejectedValueOnce(new Error('content-list boom'));
      const onMessage = await loadMessageListener();

      await onMessage({
        id: 't-err-scl',
        type: 'search-content-list',
        payload: {},
        operationId: 'op-err-scl',
      });

      expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
        type: 'result',
        id: 't-err-scl',
        success: false,
        error: 'content-list boom',
      });
      expect(mocks.cancelled.has('op-err-scl')).toBe(false);
    });

    it('posts error when checksum handler throws', async () => {
      mocks.calculateChecksum.mockRejectedValueOnce(new Error('checksum broke'));
      const onMessage = await loadMessageListener();

      await onMessage({
        id: 't-err-cs',
        type: 'checksum',
        payload: { filePath: '/bad' },
        operationId: 'op-err-cs',
      });

      expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
        type: 'result',
        id: 't-err-cs',
        success: false,
        error: 'checksum broke',
      });
    });

    it('posts error when build-index handler throws', async () => {
      mocks.buildIndex.mockRejectedValueOnce(new Error('build fail'));
      const onMessage = await loadMessageListener();

      await onMessage({
        id: 't-err-bi',
        type: 'build-index',
        payload: {},
        operationId: 'op-err-bi',
      });

      expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
        type: 'result',
        id: 't-err-bi',
        success: false,
        error: 'build fail',
      });
    });

    it('posts stringified error for non-Error thrown values', async () => {
      mocks.saveIndexFile.mockRejectedValueOnce('string-error');
      const onMessage = await loadMessageListener();

      await onMessage({
        id: 't-err-str',
        type: 'save-index',
        payload: {},
      });

      expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
        type: 'result',
        id: 't-err-str',
        success: false,
        error: 'string-error',
      });
    });
  });

  describe('isTaskRequest edge cases', () => {
    it('ignores null messages', async () => {
      const onMessage = await loadMessageListener();
      await onMessage(null);
      expect(mocks.parentPort.postMessage).not.toHaveBeenCalled();
    });

    it('ignores array messages', async () => {
      const onMessage = await loadMessageListener();
      await onMessage([1, 2, 3]);
      expect(mocks.parentPort.postMessage).not.toHaveBeenCalled();
    });

    it('ignores primitive messages', async () => {
      const onMessage = await loadMessageListener();
      await onMessage('just a string');
      expect(mocks.parentPort.postMessage).not.toHaveBeenCalled();
    });

    it('ignores message with missing id', async () => {
      const onMessage = await loadMessageListener();
      await onMessage({ type: 'search-files', payload: {} });
      expect(mocks.parentPort.postMessage).not.toHaveBeenCalled();
    });

    it('ignores message with non-string id', async () => {
      const onMessage = await loadMessageListener();
      await onMessage({ id: 123, type: 'search-files', payload: {} });
      expect(mocks.parentPort.postMessage).not.toHaveBeenCalled();
    });

    it('ignores message with invalid task type', async () => {
      const onMessage = await loadMessageListener();
      await onMessage({ id: 'x', type: 'unknown-type', payload: {} });
      expect(mocks.parentPort.postMessage).not.toHaveBeenCalled();
    });

    it('ignores message with non-string type', async () => {
      const onMessage = await loadMessageListener();
      await onMessage({ id: 'x', type: 42, payload: {} });
      expect(mocks.parentPort.postMessage).not.toHaveBeenCalled();
    });

    it('ignores message missing payload property', async () => {
      const onMessage = await loadMessageListener();
      await onMessage({ id: 'x', type: 'search-files' });
      expect(mocks.parentPort.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('cancel message edge cases', () => {
    it('ignores cancel message missing operationId', async () => {
      const onMessage = await loadMessageListener();
      await onMessage({ type: 'cancel' });
      expect(mocks.cancelled.size).toBe(0);
      expect(mocks.pruneCancelled).not.toHaveBeenCalled();
    });

    it('ignores cancel message with non-string operationId', async () => {
      const onMessage = await loadMessageListener();
      await onMessage({ type: 'cancel', operationId: 999 });
      expect(mocks.cancelled.size).toBe(0);
      expect(mocks.pruneCancelled).not.toHaveBeenCalled();
    });
  });

  describe('operationId cleanup in finally block', () => {
    it('does not attempt to delete cancelled entry when no operationId', async () => {
      mocks.searchDirectoryFiles.mockResolvedValueOnce([]);
      const onMessage = await loadMessageListener();

      mocks.cancelled.set('unrelated', Date.now());

      await onMessage({
        id: 'no-op-id',
        type: 'search-files',
        payload: {},
      });

      expect(mocks.cancelled.has('unrelated')).toBe(true);
      expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
        type: 'result',
        id: 'no-op-id',
        success: true,
        data: [],
      });
    });

    it('cleans up cancelled entry for operationId after error', async () => {
      mocks.searchContentIndex.mockRejectedValueOnce(new Error('fail'));
      const onMessage = await loadMessageListener();

      mocks.cancelled.set('op-cleanup', Date.now());

      await onMessage({
        id: 'cleanup-err',
        type: 'search-content-index',
        payload: {},
        operationId: 'op-cleanup',
      });

      expect(mocks.cancelled.has('op-cleanup')).toBe(false);
      expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
        type: 'result',
        id: 'cleanup-err',
        success: false,
        error: 'fail',
      });
    });
  });

  describe('parentPort null guard', () => {
    it('calls process.exit(1) when parentPort is null', async () => {
      const exitError = new Error('process.exit called');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw exitError;
      }) as any);

      vi.doMock('worker_threads', () => ({
        parentPort: null,
      }));

      await expect(import('./fileTasks')).rejects.toThrow('process.exit called');

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });
  });
});
