import { describe, expect, it, vi, beforeEach } from 'vitest';

const { appGetPathMock, getDrivesMock } = vi.hoisted(() => ({
  appGetPathMock: vi.fn((name: string) =>
    name === 'userData' ? '/tmp/iyeris-user' : '/tmp/iyeris-home'
  ),
  getDrivesMock: vi.fn(async () => []),
}));

vi.mock('electron', () => ({
  app: {
    getPath: appGetPathMock,
  },
}));

vi.mock('./utils', () => ({
  getDrives: getDrivesMock,
}));

vi.mock('./shared', () => ({
  ignoreError: vi.fn(),
}));

import { FileIndexer } from './indexer';

type MockFileTaskManager = {
  runTask: ReturnType<typeof vi.fn>;
  cancelOperation: ReturnType<typeof vi.fn>;
};

function makeTaskManager(): MockFileTaskManager {
  return {
    runTask: vi.fn(),
    cancelOperation: vi.fn(),
  };
}

describe('FileIndexer - search', () => {
  it('returns empty array when disabled', async () => {
    const fileTasks = makeTaskManager();
    const indexer = new FileIndexer(fileTasks as unknown as never);
    indexer.setEnabled(false);
    const results = await indexer.search('test');
    expect(results).toEqual([]);
  });

  it('sorts exact matches first among results', async () => {
    const fileTasks = makeTaskManager();
    const now = Date.now();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/a/readme-notes.txt',
              {
                name: 'readme-notes.txt',
                isDirectory: false,
                isFile: true,
                size: 1,
                modified: now,
              },
            ],
            [
              '/a/readme',
              { name: 'readme', isDirectory: false, isFile: true, size: 2, modified: now },
            ],
            [
              '/a/my-readme.txt',
              { name: 'my-readme.txt', isDirectory: false, isFile: true, size: 3, modified: now },
            ],
          ],
          lastIndexTime: now,
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    const results = await indexer.search('readme');
    expect(results[0].name).toBe('readme'); // exact match first
    expect(results.length).toBe(3);
  });

  it('returns empty array for empty query match', async () => {
    const fileTasks = makeTaskManager();
    const now = Date.now();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return { exists: true, index: [], lastIndexTime: now };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    const results = await indexer.search('nonexistent-file-xyz');
    expect(results).toEqual([]);
  });
});

describe('FileIndexer - getEntries', () => {
  it('returns empty array when disabled', async () => {
    const indexer = new FileIndexer();
    indexer.setEnabled(false);
    expect(await indexer.getEntries()).toEqual([]);
  });
});

describe('FileIndexer - clearIndex', () => {
  it('clears index and deletes file', async () => {
    const fileTasks = makeTaskManager();
    const now = Date.now();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/a/b.txt',
              { name: 'b.txt', isDirectory: false, isFile: true, size: 1, modified: now },
            ],
          ],
          lastIndexTime: now,
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    expect((await indexer.getEntries()).length).toBe(1);

    await indexer.clearIndex();
    expect(indexer.getStatus().indexedFiles).toBe(0);
  });
});

describe('FileIndexer - getStatus', () => {
  it('returns initial status', () => {
    const indexer = new FileIndexer();
    const status = indexer.getStatus();
    expect(status.isIndexing).toBe(false);
    expect(status.totalFiles).toBe(0);
    expect(status.indexedFiles).toBe(0);
    expect(status.lastIndexTime).toBeNull();
  });
});

describe('FileIndexer - setEnabled / isEnabled', () => {
  it('enables and disables the indexer', () => {
    const indexer = new FileIndexer();
    expect(indexer.isEnabled()).toBe(true);
    indexer.setEnabled(false);
    expect(indexer.isEnabled()).toBe(false);
    indexer.setEnabled(true);
    expect(indexer.isEnabled()).toBe(true);
  });

  it('does not abort if no abort controller when disabling', () => {
    const indexer = new FileIndexer();
    expect(() => indexer.setEnabled(false)).not.toThrow();
  });
});

describe('FileIndexer - initialize', () => {
  it('builds index when loaded index is empty', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return { exists: true, index: [], lastIndexTime: Date.now() };
      }
      throw new Error('unexpected: ' + type);
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    const buildSpy = vi.spyOn(indexer, 'buildIndex').mockResolvedValue(undefined);
    await indexer.initialize(true);
    // initialize stores work in initializationPromise without awaiting it
    await (indexer as unknown as { initializationPromise: Promise<void> | null })
      .initializationPromise;

    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when lastIndexTime is older than 7 days', async () => {
    const fileTasks = makeTaskManager();
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/a.txt',
              { name: 'a.txt', isDirectory: false, isFile: true, size: 1, modified: eightDaysAgo },
            ],
          ],
          lastIndexTime: eightDaysAgo,
        };
      }
      throw new Error('unexpected: ' + type);
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    const buildSpy = vi.spyOn(indexer, 'buildIndex').mockResolvedValue(undefined);
    await indexer.initialize(true);
    await (indexer as unknown as { initializationPromise: Promise<void> | null })
      .initializationPromise;

    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it('uses existing index when fresh', async () => {
    const fileTasks = makeTaskManager();
    const recent = Date.now() - 1000; // 1 second ago
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/a.txt',
              { name: 'a.txt', isDirectory: false, isFile: true, size: 1, modified: recent },
            ],
          ],
          lastIndexTime: recent,
        };
      }
      throw new Error('unexpected: ' + type);
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.initialize(true);

    const buildCalls = fileTasks.runTask.mock.calls.filter(([t]: any) => t === 'build-index');
    expect(buildCalls.length).toBe(0);
  });
});

describe('FileIndexer - buildIndex', () => {
  it('skips when already indexing', async () => {
    const fileTasks = makeTaskManager();
    const indexer = new FileIndexer(fileTasks as unknown as never);
    // set isIndexing to true
    (indexer as unknown as { isIndexing: boolean }).isIndexing = true;
    await indexer.buildIndex();
    expect(fileTasks.runTask).not.toHaveBeenCalled();
  });

  it('skips when disabled', async () => {
    const fileTasks = makeTaskManager();
    const indexer = new FileIndexer(fileTasks as unknown as never);
    indexer.setEnabled(false);
    await indexer.buildIndex();
    expect(fileTasks.runTask).not.toHaveBeenCalled();
  });

  it('handles worker cancellation gracefully', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockRejectedValue(new Error('Cancelled'));

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.buildIndex();

    expect(indexer.getStatus().indexedFiles).toBe(0);
    expect(indexer.getStatus().isIndexing).toBe(false);
  });

  it('handles unexpected errors during build', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockRejectedValue(new Error('unexpected failure'));

    const indexer = new FileIndexer(fileTasks as unknown as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await indexer.buildIndex();

    expect(consoleSpy).toHaveBeenCalled();
    expect(indexer.getStatus().isIndexing).toBe(false);
    consoleSpy.mockRestore();
  });

  it('loads entries from worker result', async () => {
    const fileTasks = makeTaskManager();
    const now = Date.now();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'build-index') {
        return {
          entries: [
            [
              '/a.txt',
              { name: 'a.txt', isDirectory: false, isFile: true, size: 10, modified: now },
            ],
            [
              '/b.txt',
              { name: 'b.txt', isDirectory: false, isFile: true, size: 20, modified: now },
            ],
          ],
        };
      }
      if (type === 'save-index') {
        return {};
      }
      throw new Error('unexpected: ' + type);
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.buildIndex();

    expect(indexer.getStatus().indexedFiles).toBe(2);
    const entries = await indexer.getEntries();
    expect(entries.length).toBe(2);
  });
});

describe('FileIndexer - loadIndex handling', () => {
  it('handles missing index file on load', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return { exists: false };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    expect(indexer.getStatus().indexedFiles).toBe(0);
  });
});
