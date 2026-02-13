import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('./appState', () => ({
  getFileTasks: vi.fn(() => fileTasks),
  getIndexerTasks: vi.fn(() => (hasIndexerTasks ? indexerTasks : null)),
  getFileIndexer: vi.fn(() => fileIndexer),
}));

vi.mock('./security', () => ({
  isPathSafe: vi.fn(() => true),
  getErrorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error)
  ),
}));

vi.mock('./ipcUtils', () => ({
  isTrustedIpcEvent: vi.fn(() => true),
}));

import { setupSearchHandlers } from './searchHandlers';
import { isPathSafe } from './security';
import { isTrustedIpcEvent } from './ipcUtils';

function getHandler(channel: string): Handler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler;
}

const trustedEvent = { sender: { id: 1 } };
const untrustedEvent = { sender: { id: 999 } };

describe('searchHandlers — extended coverage', () => {
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

  describe('search-files-content', () => {
    it('rejects untrusted sender', async () => {
      vi.mocked(isTrustedIpcEvent).mockReturnValue(false);
      const handler = getHandler('search-files-content');
      const result = await handler(untrustedEvent, '/dir', 'query');
      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('rejects unsafe path', async () => {
      vi.mocked(isPathSafe).mockReturnValue(false);
      const handler = getHandler('search-files-content');
      const result = await handler(trustedEvent, '../bad', 'query');
      expect(result).toEqual({ success: false, error: 'Invalid directory path' });
    });

    it('dispatches search-content task with filters', async () => {
      const mockResults = [{ name: 'result.txt', path: '/dir/result.txt' }];
      fileTasks.runTask.mockResolvedValue(mockResults);
      const handler = getHandler('search-files-content');
      const filters = { fileType: 'text' };
      const result = await handler(trustedEvent, '/dir', 'query', filters, 'op-1');
      expect(fileTasks.runTask).toHaveBeenCalledWith(
        'search-content',
        expect.objectContaining({ dirPath: '/dir', query: 'query', filters }),
        'op-1'
      );
      expect(result).toEqual({ success: true, results: mockResults });
    });

    it('returns error when task throws', async () => {
      fileTasks.runTask.mockRejectedValue(new Error('content search failed'));
      const handler = getHandler('search-files-content');
      const result = await handler(trustedEvent, '/dir', 'query');
      expect(result).toEqual({ success: false, error: 'content search failed' });
    });
  });

  describe('search-index — error path', () => {
    it('returns error when task throws', async () => {
      indexerTasks.runTask.mockRejectedValue(new Error('index search boom'));
      const handler = getHandler('search-index');
      const result = await handler(trustedEvent, 'query', 'op-1');
      expect(result).toEqual({ success: false, error: 'index search boom' });
    });

    it('rejects untrusted sender', async () => {
      vi.mocked(isTrustedIpcEvent).mockReturnValue(false);
      const handler = getHandler('search-index');
      const result = await handler(untrustedEvent, 'query');
      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('returns error when indexer is null', async () => {
      fileIndexer = null;
      const handler = getHandler('search-index');
      const result = await handler(trustedEvent, 'query');
      expect(result).toEqual({ success: false, error: 'Indexer not initialized' });
    });

    it('returns error when indexer is disabled', async () => {
      fileIndexer = { ...fileIndexer!, isEnabled: () => false };
      const handler = getHandler('search-index');
      const result = await handler(trustedEvent, 'query');
      expect(result).toEqual({ success: false, error: 'Indexer is disabled' });
    });
  });

  describe('rebuild-index', () => {
    it('rejects untrusted sender', async () => {
      vi.mocked(isTrustedIpcEvent).mockReturnValue(false);
      const handler = getHandler('rebuild-index');
      const result = await handler(untrustedEvent);
      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('returns error when indexer is null', async () => {
      fileIndexer = null;
      const handler = getHandler('rebuild-index');
      const result = await handler(trustedEvent);
      expect(result).toEqual({ success: false, error: 'Indexer not initialized' });
    });

    it('returns error when rebuild throws', async () => {
      fileIndexer = {
        ...fileIndexer!,
        rebuildIndex: vi.fn().mockRejectedValue(new Error('rebuild failed')),
      };
      const handler = getHandler('rebuild-index');
      const result = await handler(trustedEvent);
      expect(result).toEqual({ success: false, error: 'rebuild failed' });
    });
  });

  describe('get-index-status', () => {
    it('rejects untrusted sender', async () => {
      vi.mocked(isTrustedIpcEvent).mockReturnValue(false);
      const handler = getHandler('get-index-status');
      const result = await handler(untrustedEvent);
      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('returns error when indexer is null', async () => {
      fileIndexer = null;
      const handler = getHandler('get-index-status');
      const result = await handler(trustedEvent);
      expect(result).toEqual({ success: false, error: 'Indexer not initialized' });
    });

    it('returns error when getStatus throws', async () => {
      fileIndexer = {
        ...fileIndexer!,
        getStatus: () => {
          throw new Error('status boom');
        },
      };
      const handler = getHandler('get-index-status');
      const result = await handler(trustedEvent);
      expect(result).toEqual({ success: false, error: 'status boom' });
    });
  });

  describe('cancel-search — error path', () => {
    it('returns error when cancelOperation throws', async () => {
      fileTasks.cancelOperation.mockImplementation(() => {
        throw new Error('cancel failed');
      });
      const handler = getHandler('cancel-search');
      const result = await handler(trustedEvent, 'op-1');
      expect(result).toEqual({ success: false, error: 'cancel failed' });
    });
  });

  describe('search-files-content-global', () => {
    it('rejects untrusted sender', async () => {
      vi.mocked(isTrustedIpcEvent).mockReturnValue(false);
      const handler = getHandler('search-files-content-global');
      const result = await handler(untrustedEvent, 'query');
      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('returns error when indexer is null', async () => {
      fileIndexer = null;
      const handler = getHandler('search-files-content-global');
      const result = await handler(trustedEvent, 'query');
      expect(result).toEqual({ success: false, error: 'Indexer not initialized' });
    });

    it('returns error when indexer is disabled', async () => {
      fileIndexer = { ...fileIndexer!, isEnabled: () => false };
      const handler = getHandler('search-files-content-global');
      const result = await handler(trustedEvent, 'query');
      expect(result).toEqual({ success: false, error: 'Indexer is disabled' });
    });

    it('uses indexer tasks when available', async () => {
      indexerTasks.runTask.mockResolvedValue([]);
      const handler = getHandler('search-files-content-global');
      const result = await handler(trustedEvent, 'query', undefined, 'op-1');
      expect(indexerTasks.runTask).toHaveBeenCalledWith(
        'search-content-index',
        expect.objectContaining({ query: 'query' }),
        'op-1'
      );
      expect(result).toEqual({ success: true, results: [] });
    });

    it('falls back to file tasks when indexer tasks unavailable', async () => {
      hasIndexerTasks = false;
      handlers.clear();
      setupSearchHandlers();
      fileTasks.runTask.mockResolvedValue([]);
      const handler = getHandler('search-files-content-global');
      const result = await handler(trustedEvent, 'query');
      expect(fileTasks.runTask).toHaveBeenCalledWith(
        'search-content-index',
        expect.objectContaining({ query: 'query' }),
        undefined
      );
      expect(result).toEqual({ success: true, results: [] });
    });

    it('returns error when task throws', async () => {
      indexerTasks.runTask.mockRejectedValue(new Error('global search error'));
      const handler = getHandler('search-files-content-global');
      const result = await handler(trustedEvent, 'query');
      expect(result).toEqual({ success: false, error: 'global search error' });
    });
  });
});
