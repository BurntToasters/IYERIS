import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();

const fileTasks = {
  runTask: vi.fn(),
  cancelOperation: vi.fn(),
};

const indexerTasks = {
  runTask: vi.fn(),
  cancelOperation: vi.fn(),
};

let hasIndexerTasks = true;
let fileIndexer: {
  isEnabled: () => boolean;
  rebuildIndex: () => Promise<void>;
  getStatus: () => {
    isIndexing: boolean;
    indexedFiles: number;
    totalFiles: number;
    lastIndexTime: Date | null;
  };
} | null = null;

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
  },
  app: {
    getPath: vi.fn(() => '/tmp/iyeris-user'),
  },
}));

vi.mock('../main/appState', () => ({
  getFileTasks: vi.fn(() => fileTasks),
  getIndexerTasks: vi.fn(() => (hasIndexerTasks ? indexerTasks : null)),
  getFileIndexer: vi.fn(() => fileIndexer),
}));

vi.mock('../main/security', () => ({
  isPathSafe: vi.fn(() => true),
  getErrorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error)
  ),
}));

vi.mock('../main/ipcUtils', () => ({
  isTrustedIpcEvent: vi.fn(() => true),
}));

import { setupSearchHandlers } from '../main/searchHandlers';
import { isPathSafe } from '../main/security';
import { isTrustedIpcEvent } from '../main/ipcUtils';

function getHandler(channel: string): Handler {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`Handler not registered for channel: ${channel}`);
  }
  return handler;
}

describe('setupSearchHandlers', () => {
  beforeEach(() => {
    handlers.clear();
    fileTasks.runTask.mockReset();
    fileTasks.cancelOperation.mockReset();
    indexerTasks.runTask.mockReset();
    indexerTasks.cancelOperation.mockReset();
    hasIndexerTasks = true;
    fileIndexer = {
      isEnabled: () => true,
      rebuildIndex: vi.fn(async () => undefined),
      getStatus: () => ({
        isIndexing: false,
        indexedFiles: 5,
        totalFiles: 10,
        lastIndexTime: null,
      }),
    };
    vi.mocked(isTrustedIpcEvent).mockReturnValue(true);
    vi.mocked(isPathSafe).mockReturnValue(true);
    setupSearchHandlers();
  });

  it('rejects untrusted search sender', async () => {
    vi.mocked(isTrustedIpcEvent).mockReturnValue(false);
    const searchFiles = getHandler('search-files');

    const result = (await searchFiles({} as unknown, '/tmp', 'query')) as {
      success: boolean;
      error?: string;
    };

    expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    expect(fileTasks.runTask).not.toHaveBeenCalled();
  });

  it('rejects invalid search path', async () => {
    vi.mocked(isPathSafe).mockReturnValue(false);
    const searchFiles = getHandler('search-files');

    const result = (await searchFiles({} as unknown, '/bad', 'query')) as {
      success: boolean;
      error?: string;
    };

    expect(result).toEqual({ success: false, error: 'Invalid directory path' });
    expect(fileTasks.runTask).not.toHaveBeenCalled();
  });

  it('dispatches search-files task with expected payload', async () => {
    const expected = [{ name: 'match', path: '/tmp/match.txt' }];
    fileTasks.runTask.mockResolvedValue(expected);
    const searchFiles = getHandler('search-files');

    const result = (await searchFiles(
      {} as unknown,
      '/tmp/project',
      'match',
      { fileType: 'text' },
      'op-1'
    )) as { success: boolean; results?: unknown[] };

    expect(fileTasks.runTask).toHaveBeenCalledWith(
      'search-files',
      {
        dirPath: '/tmp/project',
        query: 'match',
        filters: { fileType: 'text' },
        maxDepth: 10,
        maxResults: 100,
      },
      'op-1'
    );
    expect(result).toEqual({ success: true, results: expected });
  });

  it('returns error when search task throws', async () => {
    fileTasks.runTask.mockRejectedValue(new Error('search failed'));
    const searchFiles = getHandler('search-files');

    const result = (await searchFiles({} as unknown, '/tmp/project', 'match')) as {
      success: boolean;
      error?: string;
    };

    expect(result).toEqual({ success: false, error: 'search failed' });
  });

  it('returns indexer not initialized for global content search', async () => {
    fileIndexer = null;
    const handler = getHandler('search-files-content-global');

    const result = (await handler({} as unknown, 'needle')) as { success: boolean; error?: string };

    expect(result).toEqual({ success: false, error: 'Indexer not initialized' });
  });

  it('returns indexer disabled for global content search', async () => {
    fileIndexer = {
      isEnabled: () => false,
      rebuildIndex: vi.fn(async () => undefined),
      getStatus: () => ({ isIndexing: false, indexedFiles: 0, totalFiles: 0, lastIndexTime: null }),
    };
    const handler = getHandler('search-files-content-global');

    const result = (await handler({} as unknown, 'needle')) as { success: boolean; error?: string };

    expect(result).toEqual({ success: false, error: 'Indexer is disabled' });
  });

  it('uses indexer tasks for global content search when available', async () => {
    const expected = [{ path: '/tmp/hit.txt' }];
    indexerTasks.runTask.mockResolvedValue(expected);
    const handler = getHandler('search-files-content-global');

    const result = (await handler({} as unknown, 'needle', { minSize: 10 }, 'op-index')) as {
      success: boolean;
      results?: unknown[];
    };

    expect(indexerTasks.runTask).toHaveBeenCalledWith(
      'search-content-index',
      {
        indexPath: path.join('/tmp/iyeris-user', 'file-index.json'),
        query: 'needle',
        filters: { minSize: 10 },
        maxResults: 100,
      },
      'op-index'
    );
    expect(fileTasks.runTask).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, results: expected });
  });

  it('falls back to file tasks for global content search when indexer tasks are unavailable', async () => {
    handlers.clear();
    hasIndexerTasks = false;
    setupSearchHandlers();
    const expected = [{ path: '/tmp/hit.txt' }];
    fileTasks.runTask.mockResolvedValue(expected);
    const handler = getHandler('search-files-content-global');

    const result = (await handler({} as unknown, 'needle')) as {
      success: boolean;
      results?: unknown[];
    };

    expect(fileTasks.runTask).toHaveBeenCalledWith(
      'search-content-index',
      {
        indexPath: path.join('/tmp/iyeris-user', 'file-index.json'),
        query: 'needle',
        filters: undefined,
        maxResults: 100,
      },
      undefined
    );
    expect(result).toEqual({ success: true, results: expected });
  });

  it('cancels search for both file and indexer workers', async () => {
    const handler = getHandler('cancel-search');

    const result = (await handler({} as unknown, 'op-cancel')) as { success: boolean };

    expect(fileTasks.cancelOperation).toHaveBeenCalledWith('op-cancel');
    expect(indexerTasks.cancelOperation).toHaveBeenCalledWith('op-cancel');
    expect(result).toEqual({ success: true });
  });

  it('requires operationId for cancel-search', async () => {
    const handler = getHandler('cancel-search');

    const result = (await handler({} as unknown, '')) as { success: boolean; error?: string };

    expect(result).toEqual({ success: false, error: 'Missing operationId' });
  });

  it('rebuilds index through current file indexer', async () => {
    const rebuildIndex = vi.fn(async () => undefined);
    fileIndexer = {
      isEnabled: () => true,
      rebuildIndex,
      getStatus: () => ({ isIndexing: false, indexedFiles: 0, totalFiles: 0, lastIndexTime: null }),
    };
    const handler = getHandler('rebuild-index');

    const result = (await handler({} as unknown)) as { success: boolean };

    expect(rebuildIndex).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true });
  });

  it('returns current index status', async () => {
    const status = {
      isIndexing: true,
      indexedFiles: 42,
      totalFiles: 100,
      lastIndexTime: new Date('2026-01-01T00:00:00Z'),
    };
    fileIndexer = {
      isEnabled: () => true,
      rebuildIndex: vi.fn(async () => undefined),
      getStatus: () => status,
    };
    const handler = getHandler('get-index-status');

    const result = (await handler({} as unknown)) as {
      success: boolean;
      status?: typeof status;
    };

    expect(result).toEqual({ success: true, status });
  });
});
