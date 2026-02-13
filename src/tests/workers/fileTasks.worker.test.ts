import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  };
});

vi.mock('worker_threads', () => ({
  parentPort: mocks.parentPort,
}));

vi.mock('./workerUtils', () => ({
  isRecord: (value: unknown) => !!value && typeof value === 'object',
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

describe('workers/fileTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.cancelled.clear();
  });

  async function loadMessageListener() {
    await import('./fileTasks');
    const messageCall = mocks.parentPort.on.mock.calls.find((call) => call[0] === 'message');
    if (!messageCall) {
      throw new Error('Message listener not registered');
    }
    return messageCall[1] as (message: unknown) => Promise<void>;
  }

  it('handles cancel messages by tracking operation id', async () => {
    const onMessage = await loadMessageListener();

    await onMessage({ type: 'cancel', operationId: 'op-cancel' });

    expect(mocks.cancelled.has('op-cancel')).toBe(true);
    expect(mocks.pruneCancelled).toHaveBeenCalledTimes(1);
    expect(mocks.parentPort.postMessage).not.toHaveBeenCalled();
  });

  it('executes task handlers and posts successful results', async () => {
    mocks.searchDirectoryFiles.mockResolvedValueOnce(['match-a']);
    const onMessage = await loadMessageListener();

    await onMessage({
      id: 'task-1',
      type: 'search-files',
      payload: { query: 'a' },
      operationId: 'op-1',
    });

    expect(mocks.searchDirectoryFiles).toHaveBeenCalledWith({ query: 'a' }, 'op-1');
    expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
      type: 'result',
      id: 'task-1',
      success: true,
      data: ['match-a'],
    });
    expect(mocks.cancelled.has('op-1')).toBe(false);
  });

  it('posts task errors when handler throws', async () => {
    mocks.calculateFolderSize.mockRejectedValueOnce(new Error('folder-size failed'));
    const onMessage = await loadMessageListener();

    await onMessage({
      id: 'task-2',
      type: 'folder-size',
      payload: { path: '/tmp' },
      operationId: 'op-2',
    });

    expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
      type: 'result',
      id: 'task-2',
      success: false,
      error: 'folder-size failed',
    });
    expect(mocks.cancelled.has('op-2')).toBe(false);
  });

  it('ignores malformed messages', async () => {
    const onMessage = await loadMessageListener();
    await onMessage({ foo: 'bar' });

    expect(mocks.parentPort.postMessage).not.toHaveBeenCalled();
  });
});
