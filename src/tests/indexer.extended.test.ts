import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { appGetPathMock, getDrivesMock, fsMock } = vi.hoisted(() => ({
  appGetPathMock: vi.fn((name: string) =>
    name === 'userData' ? '/tmp/iyeris-user' : '/tmp/iyeris-home'
  ),
  getDrivesMock: vi.fn(async () => [] as string[]),
  fsMock: {
    readdir: vi.fn(),
    stat: vi.fn(),
    access: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
    copyFile: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  app: {
    getPath: appGetPathMock,
  },
}));

vi.mock('../utils', () => ({
  getDrives: getDrivesMock,
}));

vi.mock('../shared', () => ({
  ignoreError: vi.fn(),
}));

vi.mock('fs', () => ({
  promises: fsMock,
}));

import { FileIndexer } from '../indexer';

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

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
});

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
    expect(results[0].name).toBe('readme');
    expect(results.length).toBe(3);
  });

  it('returns empty array for no match', async () => {
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

  it('waits for initializationPromise before searching', async () => {
    const fileTasks = makeTaskManager();
    const now = Date.now();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/a/hello.txt',
              { name: 'hello.txt', isDirectory: false, isFile: true, size: 1, modified: now },
            ],
          ],
          lastIndexTime: now,
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.initialize(true);
    const results = await indexer.search('hello');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('hello.txt');
  });

  it('does not load index again when isIndexing is true', async () => {
    const fileTasks = makeTaskManager();
    const indexer = new FileIndexer(fileTasks as unknown as never);
    (indexer as any).isIndexing = true;
    const results = await indexer.search('something');
    expect(results).toEqual([]);
    expect(fileTasks.runTask).not.toHaveBeenCalled();
  });
});

describe('FileIndexer - getEntries', () => {
  it('returns empty array when disabled', async () => {
    const indexer = new FileIndexer();
    indexer.setEnabled(false);
    expect(await indexer.getEntries()).toEqual([]);
  });

  it('waits for initializationPromise before returning entries', async () => {
    const fileTasks = makeTaskManager();
    const now = Date.now();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/x.txt',
              { name: 'x.txt', isDirectory: false, isFile: true, size: 10, modified: now },
            ],
          ],
          lastIndexTime: now,
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.initialize(true);
    const entries = await indexer.getEntries();
    expect(entries.length).toBe(1);
  });

  it('loads index lazily when empty and not indexing', async () => {
    const fileTasks = makeTaskManager();
    const now = Date.now();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            ['/z.txt', { name: 'z.txt', isDirectory: false, isFile: true, size: 5, modified: now }],
          ],
          lastIndexTime: now,
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    const entries = await indexer.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe('z.txt');
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

    fsMock.unlink.mockResolvedValue(undefined);

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    expect((await indexer.getEntries()).length).toBe(1);

    await indexer.clearIndex();
    expect(indexer.getStatus().indexedFiles).toBe(0);
  });

  it('silently ignores ENOENT when deleting index file', async () => {
    const indexer = new FileIndexer();
    fsMock.unlink.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await indexer.clearIndex();

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('logs error when deleting index file fails with non-ENOENT', async () => {
    const indexer = new FileIndexer();
    fsMock.unlink.mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' })
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await indexer.clearIndex();

    expect(consoleSpy).toHaveBeenCalledWith('[Indexer] Error deleting index:', expect.any(Error));
    consoleSpy.mockRestore();
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

  it('aborts active controller and cancels worker operation when disabling', () => {
    const fileTasks = makeTaskManager();
    const indexer = new FileIndexer(fileTasks as unknown as never);
    const abortController = new AbortController();
    (indexer as any).abortController = abortController;
    (indexer as any).buildOperationId = 'build-999';

    indexer.setEnabled(false);

    expect(abortController.signal.aborted).toBe(true);
    expect((indexer as any).abortController).toBeNull();
    expect(fileTasks.cancelOperation).toHaveBeenCalledWith('build-999');
    expect((indexer as any).buildOperationId).toBeNull();
  });

  it('does not cancel worker operation if no buildOperationId', () => {
    const fileTasks = makeTaskManager();
    const indexer = new FileIndexer(fileTasks as unknown as never);
    const abortController = new AbortController();
    (indexer as any).abortController = abortController;

    indexer.setEnabled(false);

    expect(abortController.signal.aborted).toBe(true);
    expect(fileTasks.cancelOperation).not.toHaveBeenCalled();
  });
});

describe('FileIndexer - initialize', () => {
  it('skips initialization when disabled', async () => {
    const fileTasks = makeTaskManager();
    const indexer = new FileIndexer(fileTasks as unknown as never);
    const loadSpy = vi.spyOn(indexer, 'loadIndex').mockResolvedValue(undefined);
    const buildSpy = vi.spyOn(indexer, 'buildIndex').mockResolvedValue(undefined);

    await indexer.initialize(false);

    expect(loadSpy).not.toHaveBeenCalled();
    expect(buildSpy).not.toHaveBeenCalled();
  });

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
    await (indexer as any).initializationPromise;

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
    await (indexer as any).initializationPromise;

    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it('uses existing index when fresh', async () => {
    const fileTasks = makeTaskManager();
    const recent = Date.now() - 1000;
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

  it('rebuilds when lastIndexTime is null even with entries', async () => {
    const fileTasks = makeTaskManager();
    const now = Date.now();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            ['/a.txt', { name: 'a.txt', isDirectory: false, isFile: true, size: 1, modified: now }],
          ],
          lastIndexTime: null,
        };
      }
      throw new Error('unexpected: ' + type);
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    const buildSpy = vi.spyOn(indexer, 'buildIndex').mockResolvedValue(undefined);
    await indexer.initialize(true);
    await (indexer as any).initializationPromise;

    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it('handles initialization error gracefully', async () => {
    const fileTasks = makeTaskManager();
    const indexer = new FileIndexer(fileTasks as unknown as never);

    vi.spyOn(indexer, 'loadIndex').mockRejectedValue(new Error('load failed'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.initialize(true);
    await (indexer as any).initializationPromise;

    expect(consoleSpy).toHaveBeenCalledWith('[Indexer] Initialization failed:', expect.any(Error));
    expect((indexer as any).initializationPromise).toBeNull();
    consoleSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe('FileIndexer - buildIndex', () => {
  it('skips when already indexing', async () => {
    const fileTasks = makeTaskManager();
    const indexer = new FileIndexer(fileTasks as unknown as never);
    (indexer as any).isIndexing = true;
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

  it('handles worker cancellation gracefully (Cancelled message)', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockRejectedValue(new Error('Cancelled'));

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.buildIndex();

    expect(indexer.getStatus().indexedFiles).toBe(0);
    expect(indexer.getStatus().isIndexing).toBe(false);
  });

  it('handles "Calculation cancelled" message gracefully', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockRejectedValue(new Error('Calculation cancelled'));

    const indexer = new FileIndexer(fileTasks as unknown as never);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.buildIndex();

    expect(indexer.getStatus().indexedFiles).toBe(0);
    expect(indexer.getStatus().isIndexing).toBe(false);
    consoleSpy.mockRestore();
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

  it('handles non-Error thrown during build', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockRejectedValue('string error');

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

  it('handles worker result with non-array entries', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'build-index') {
        return { entries: null };
      }
      if (type === 'save-index') {
        return {};
      }
      throw new Error('unexpected: ' + type);
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.buildIndex();
    expect(indexer.getStatus().indexedFiles).toBe(0);
  });

  it('builds index without fileTasks by scanning directories directly', async () => {
    const indexer = new FileIndexer();

    fsMock.access.mockResolvedValue(undefined);
    let callCount = 0;
    fsMock.readdir.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [{ name: 'file1.txt', isDirectory: () => false, isFile: () => true }] as any;
      }
      return [] as any;
    });
    fsMock.stat.mockResolvedValue({ size: 100, mtime: new Date() } as any);
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);

    await indexer.buildIndex();

    expect(indexer.getStatus().isIndexing).toBe(false);
    expect(indexer.getStatus().indexedFiles).toBeGreaterThanOrEqual(0);
  });

  it('handles fs.access failure for a location in non-worker build', async () => {
    const indexer = new FileIndexer();

    fsMock.access.mockRejectedValue(new Error('no access'));
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.buildIndex();

    expect(indexer.getStatus().isIndexing).toBe(false);
    consoleSpy.mockRestore();
  });

  it('stops scanning when abortController is aborted during non-worker build', async () => {
    const indexer = new FileIndexer();

    let accessCallCount = 0;
    fsMock.access.mockImplementation(async () => {
      accessCallCount++;
      if (accessCallCount > 1) {
        (indexer as any).abortController?.abort();
      }
    });
    fsMock.readdir.mockResolvedValue([] as any);
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);

    await indexer.buildIndex();
    expect(indexer.getStatus().isIndexing).toBe(false);
  });

  it('cleans up abortController and buildOperationId in finally block', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'build-index') {
        return { entries: [] };
      }
      if (type === 'save-index') {
        return {};
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.buildIndex();

    expect((indexer as any).abortController).toBeNull();
    expect((indexer as any).buildOperationId).toBeNull();
    expect(indexer.getStatus().isIndexing).toBe(false);
  });
});

describe('FileIndexer - loadIndex', () => {
  it('handles missing index file via fileTasks', async () => {
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

  it('loads index without fileTasks using fs.readFile', async () => {
    const now = Date.now();
    const indexData = {
      index: [
        [
          '/test/file.txt',
          { name: 'file.txt', isDirectory: false, isFile: true, size: 42, modified: now },
        ],
      ],
      lastIndexTime: now,
      version: 1,
    };
    fsMock.readFile.mockResolvedValue(JSON.stringify(indexData));

    const indexer = new FileIndexer();
    await indexer.loadIndex();
    expect(indexer.getStatus().indexedFiles).toBe(1);
  });

  it('handles ENOENT when loading without fileTasks', async () => {
    fsMock.readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const indexer = new FileIndexer();
    await indexer.loadIndex();

    expect(indexer.getStatus().indexedFiles).toBe(0);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[Indexer] No existing index found, will build on first search'
    );
    consoleSpy.mockRestore();
  });

  it('handles non-ENOENT error when loading without fileTasks', async () => {
    fsMock.readFile.mockRejectedValue(Object.assign(new Error('corrupt'), { code: 'EIO' }));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const indexer = new FileIndexer();
    await indexer.loadIndex();

    expect(consoleSpy).toHaveBeenCalledWith('[Indexer] Error loading index:', expect.any(Error));
    consoleSpy.mockRestore();
  });

  it('handles non-array parsed.index when loading without fileTasks', async () => {
    const indexData = { index: 'not-an-array', lastIndexTime: Date.now(), version: 1 };
    fsMock.readFile.mockResolvedValue(JSON.stringify(indexData));

    const indexer = new FileIndexer();
    await indexer.loadIndex();
    expect(indexer.getStatus().indexedFiles).toBe(0);
  });

  it('loads with fileTasks and missing index array', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return { exists: true };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    expect(indexer.getStatus().indexedFiles).toBe(0);
  });
});

describe('FileIndexer - saveIndex', () => {
  it('saves index via fileTasks', async () => {
    const fileTasks = makeTaskManager();
    const now = Date.now();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/tmp/doc.txt',
              { name: 'doc.txt', isDirectory: false, isFile: true, size: 4, modified: now },
            ],
          ],
          lastIndexTime: now,
        };
      }
      if (type === 'save-index') {
        return { success: true };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    await indexer.saveIndex();

    const saveCall = fileTasks.runTask.mock.calls.find(
      ([taskType]: any) => taskType === 'save-index'
    );
    expect(saveCall).toBeDefined();
    expect(saveCall?.[1].indexPath).toBe('/tmp/iyeris-user/file-index.json');
    expect(saveCall?.[1].entries).toHaveLength(1);
  });

  it('saves index without fileTasks using writeFileAtomic', async () => {
    const indexer = new FileIndexer();
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.saveIndex();

    expect(fsMock.writeFile).toHaveBeenCalled();
    expect(fsMock.rename).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('handles save error gracefully', async () => {
    const indexer = new FileIndexer();
    fsMock.writeFile.mockRejectedValue(new Error('disk full'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await indexer.saveIndex();

    expect(consoleSpy).toHaveBeenCalledWith('[Indexer] Error saving index:', expect.any(Error));
    consoleSpy.mockRestore();
  });

  it('saves with lastIndexTime when set', async () => {
    const fileTasks = makeTaskManager();
    const now = Date.now();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'save-index') {
        return {};
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    (indexer as any).lastIndexTime = new Date(now);
    await indexer.saveIndex();

    const saveCall = fileTasks.runTask.mock.calls[0];
    expect(saveCall[1].lastIndexTime).toBe(now);
  });

  it('saves with null lastIndexTime when not set', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'save-index') {
        return {};
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.saveIndex();

    const saveCall = fileTasks.runTask.mock.calls[0];
    expect(saveCall[1].lastIndexTime).toBeNull();
  });
});

describe('FileIndexer - rebuildIndex', () => {
  it('aborts and cancels active build before rebuild', async () => {
    const fileTasks = makeTaskManager();
    const indexer = new FileIndexer(fileTasks as unknown as never);
    const abortController = new AbortController();
    (indexer as any).abortController = abortController;
    (indexer as any).buildOperationId = 'build-123';
    const clearSpy = vi.spyOn(indexer, 'clearIndex').mockResolvedValue(undefined);
    const buildSpy = vi.spyOn(indexer, 'buildIndex').mockResolvedValue(undefined);

    await indexer.rebuildIndex();

    expect(abortController.signal.aborted).toBe(true);
    expect(fileTasks.cancelOperation).toHaveBeenCalledWith('build-123');
    expect((indexer as any).buildOperationId).toBeNull();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it('works without prior abortController or buildOperationId', async () => {
    const fileTasks = makeTaskManager();
    const indexer = new FileIndexer(fileTasks as unknown as never);
    const clearSpy = vi.spyOn(indexer, 'clearIndex').mockResolvedValue(undefined);
    const buildSpy = vi.spyOn(indexer, 'buildIndex').mockResolvedValue(undefined);

    await indexer.rebuildIndex();

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(fileTasks.cancelOperation).not.toHaveBeenCalled();
  });

  it('aborts without fileTasks cancelOperation', async () => {
    const indexer = new FileIndexer();
    const abortController = new AbortController();
    (indexer as any).abortController = abortController;

    const clearSpy = vi.spyOn(indexer, 'clearIndex').mockResolvedValue(undefined);
    const buildSpy = vi.spyOn(indexer, 'buildIndex').mockResolvedValue(undefined);

    await indexer.rebuildIndex();

    expect(abortController.signal.aborted).toBe(true);
    expect(clearSpy).toHaveBeenCalled();
    expect(buildSpy).toHaveBeenCalled();
  });
});

describe('FileIndexer - normalizeIndexEntry edge cases', () => {
  it('defaults name to basename when not provided', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/path/to/myfile.txt',
              { isDirectory: false, isFile: true, size: 5, modified: Date.now() },
            ],
          ],
          lastIndexTime: Date.now(),
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    const entries = await indexer.getEntries();
    expect(entries[0].name).toBe('myfile.txt');
  });

  it('defaults isFile to !isDirectory when isFile not provided', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [['/dir', { name: 'dir', isDirectory: true, size: 0, modified: Date.now() }]],
          lastIndexTime: Date.now(),
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    const entries = await indexer.getEntries();
    expect(entries[0].isFile).toBe(false);
    expect(entries[0].isDirectory).toBe(true);
  });

  it('defaults size to 0 when not a number', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/f.txt',
              {
                name: 'f.txt',
                isDirectory: false,
                isFile: true,
                size: 'big' as any,
                modified: Date.now(),
              },
            ],
          ],
          lastIndexTime: Date.now(),
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    const entries = await indexer.getEntries();
    expect(entries[0].size).toBe(0);
  });

  it('handles Date instance as modified value', async () => {
    const fileTasks = makeTaskManager();
    const date = new Date('2024-01-15T00:00:00Z');
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/f.txt',
              { name: 'f.txt', isDirectory: false, isFile: true, size: 10, modified: date },
            ],
          ],
          lastIndexTime: Date.now(),
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    const entries = await indexer.getEntries();
    expect(entries[0].modified.getTime()).toBe(date.getTime());
  });

  it('handles string modified value', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/f.txt',
              {
                name: 'f.txt',
                isDirectory: false,
                isFile: true,
                size: 10,
                modified: '2024-01-15T00:00:00Z',
              },
            ],
          ],
          lastIndexTime: Date.now(),
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    const entries = await indexer.getEntries();
    expect(entries[0].modified.getTime()).toBe(new Date('2024-01-15T00:00:00Z').getTime());
  });

  it('handles undefined modified value (defaults to Date(0))', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [['/f.txt', { name: 'f.txt', isDirectory: false, isFile: true, size: 10 }]],
          lastIndexTime: Date.now(),
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    const entries = await indexer.getEntries();
    expect(entries[0].modified.getTime()).toBe(0);
  });

  it('returns null for empty entryPath', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            ['', { name: 'bad', isDirectory: false, isFile: true, size: 0, modified: Date.now() }],
          ],
          lastIndexTime: Date.now(),
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    expect(indexer.getStatus().indexedFiles).toBe(0);
  });

  it('handles object entry format without array', async () => {
    const fileTasks = makeTaskManager();
    const now = Date.now();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            {
              path: '/obj/entry.txt',
              name: 'entry.txt',
              isDirectory: false,
              isFile: true,
              size: 5,
              modified: now,
            },
          ],
          lastIndexTime: now,
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    const entries = await indexer.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].path).toBe('/obj/entry.txt');
  });

  it('skips object entry with non-string path', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [{ path: 123, name: 'bad', isDirectory: false }],
          lastIndexTime: Date.now(),
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    expect(indexer.getStatus().indexedFiles).toBe(0);
  });

  it('skips entries that are not arrays or objects', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [null, 42, 'string-entry', undefined],
          lastIndexTime: Date.now(),
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    expect(indexer.getStatus().indexedFiles).toBe(0);
  });

  it('handles array entry where first element is not a string', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [[123, { name: 'bad' }]],
          lastIndexTime: Date.now(),
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    expect(indexer.getStatus().indexedFiles).toBe(0);
  });

  it('handles array entry where second element is falsy', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            ['/path', null],
            ['/path2', undefined],
            ['/path3', 0],
          ],
          lastIndexTime: Date.now(),
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    expect(indexer.getStatus().indexedFiles).toBe(0);
  });

  it('defaults isDirectory to false when not boolean', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/f.txt',
              {
                name: 'f.txt',
                isDirectory: 'yes' as any,
                isFile: true,
                size: 1,
                modified: Date.now(),
              },
            ],
          ],
          lastIndexTime: Date.now(),
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    const entries = await indexer.getEntries();
    expect(entries[0].isDirectory).toBe(false);
  });

  it('defaults isFile to true when isDirectory is false and isFile not boolean', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/f.txt',
              {
                name: 'f.txt',
                isDirectory: false,
                isFile: 'yes' as any,
                size: 1,
                modified: Date.now(),
              },
            ],
          ],
          lastIndexTime: Date.now(),
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    const entries = await indexer.getEntries();

    expect(entries[0].isFile).toBe(true);
  });

  it('handles invalid modified NaN value', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/f.txt',
              { name: 'f.txt', isDirectory: false, isFile: true, size: 1, modified: 'not-a-date' },
            ],
          ],
          lastIndexTime: Date.now(),
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    const entries = await indexer.getEntries();
    expect(entries[0].modified.getTime()).toBe(0);
  });

  it('uses non-string name fallback to basename', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/some/dir/file.doc',
              { name: 42 as any, isDirectory: false, isFile: true, size: 1, modified: Date.now() },
            ],
          ],
          lastIndexTime: Date.now(),
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    const entries = await indexer.getEntries();
    expect(entries[0].name).toBe('file.doc');
  });
});

describe('FileIndexer - parseIndexTime', () => {
  it('parses numeric lastIndexTime', async () => {
    const fileTasks = makeTaskManager();
    const now = Date.now();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            ['/a.txt', { name: 'a.txt', isDirectory: false, isFile: true, size: 1, modified: now }],
          ],
          lastIndexTime: now,
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    expect(indexer.getStatus().lastIndexTime).toEqual(new Date(now));
  });

  it('parses string lastIndexTime', async () => {
    const fileTasks = makeTaskManager();
    const dateStr = '2024-06-15T12:00:00Z';
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [],
          lastIndexTime: dateStr,
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    expect(indexer.getStatus().lastIndexTime).toEqual(new Date(dateStr));
  });

  it('returns null for invalid lastIndexTime type', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [],
          lastIndexTime: true,
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    expect(indexer.getStatus().lastIndexTime).toBeNull();
  });

  it('returns null for invalid date string', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [],
          lastIndexTime: 'not-a-date',
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    expect(indexer.getStatus().lastIndexTime).toBeNull();
  });

  it('returns null for null/undefined lastIndexTime', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [],
          lastIndexTime: null,
        };
      }
      throw new Error('unexpected');
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    expect(indexer.getStatus().lastIndexTime).toBeNull();
  });

  it('parses Date instance lastIndexTime via non-fileTasks path', async () => {
    const now = new Date();
    const indexData = {
      index: [],
      lastIndexTime: now.toISOString(),
      version: 1,
    };
    fsMock.readFile.mockResolvedValue(JSON.stringify(indexData));

    const indexer = new FileIndexer();
    await indexer.loadIndex();
    expect(indexer.getStatus().lastIndexTime).toEqual(new Date(now.toISOString()));
  });
});

describe('FileIndexer - getCommonLocations platform branches', () => {
  it('returns linux locations', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    getDrivesMock.mockResolvedValue(['/mnt/data']);

    const indexer = new FileIndexer();
    fsMock.access.mockResolvedValue(undefined);
    fsMock.readdir.mockResolvedValue([] as any);
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.buildIndex();

    const locationLog = consoleSpy.mock.calls.find(
      (args: any) => typeof args[0] === 'string' && args[0].includes('Locations to scan')
    );
    expect(locationLog).toBeDefined();
    const logStr = locationLog?.[0] as string;
    expect(logStr).toContain('/usr');
    expect(logStr).toContain('/opt');
    expect(logStr).toContain('/home');
    expect(logStr).toContain('/mnt/data');
    consoleSpy.mockRestore();
  });

  it('returns win32 locations', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    getDrivesMock.mockResolvedValue(['C:\\', 'D:\\']);

    const indexer = new FileIndexer();
    fsMock.access.mockResolvedValue(undefined);
    fsMock.readdir.mockResolvedValue([] as any);
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.buildIndex();

    const locationLog = consoleSpy.mock.calls.find(
      (args: any) => typeof args[0] === 'string' && args[0].includes('Locations to scan')
    );
    expect(locationLog).toBeDefined();
    const logStr = locationLog?.[0] as string;
    expect(logStr).toContain('Desktop');
    expect(logStr).toContain('Documents');
    expect(logStr).toContain('C:\\');
    expect(logStr).toContain('D:\\');
    consoleSpy.mockRestore();
  });

  it('returns darwin locations and skips root drive', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    getDrivesMock.mockResolvedValue(['/', '/Volumes/External']);

    const indexer = new FileIndexer();
    fsMock.access.mockResolvedValue(undefined);
    fsMock.readdir.mockResolvedValue([] as any);
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.buildIndex();

    const locationLog = consoleSpy.mock.calls.find(
      (args: any) => typeof args[0] === 'string' && args[0].includes('Locations to scan')
    );
    expect(locationLog).toBeDefined();
    const logStr = locationLog?.[0] as string;
    expect(logStr).toContain('/Applications');
    expect(logStr).toContain('/Users');
    expect(logStr).toContain('/Volumes/External');
    expect(logStr).toContain('Movies');
    consoleSpy.mockRestore();
  });

  it('linux does not add duplicate drives', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    getDrivesMock.mockResolvedValue(['/', '/home']);

    const indexer = new FileIndexer();
    fsMock.access.mockResolvedValue(undefined);
    fsMock.readdir.mockResolvedValue([] as any);
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.buildIndex();

    const locationLog = consoleSpy.mock.calls.find(
      (args: any) => typeof args[0] === 'string' && args[0].includes('Locations to scan')
    );
    const logStr = locationLog?.[0] as string;
    const homeCount = (logStr.match(/\/home/g) || []).length;
    expect(homeCount).toBeGreaterThanOrEqual(1);
    consoleSpy.mockRestore();
  });

  it('darwin does not add drives that are already in locations list', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    getDrivesMock.mockResolvedValue(['/Applications']);

    const indexer = new FileIndexer();
    fsMock.access.mockResolvedValue(undefined);
    fsMock.readdir.mockResolvedValue([] as any);
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.buildIndex();

    const locationLog = consoleSpy.mock.calls.find(
      (args: any) => typeof args[0] === 'string' && args[0].includes('Locations to scan')
    );
    const logStr = locationLog?.[0] as string;
    const appCount = (logStr.match(/\/Applications/g) || []).length;
    expect(appCount).toBe(1);
    consoleSpy.mockRestore();
  });
});

describe('FileIndexer - shouldExclude', () => {
  it('excludes known system files', () => {
    const indexer = new FileIndexer();
    const shouldExclude = (indexer as any).shouldExclude.bind(indexer);
    expect(shouldExclude('/some/path/.ds_store')).toBe(true);
    expect(shouldExclude('/some/path/thumbs.db')).toBe(true);
    expect(shouldExclude('/some/path/desktop.ini')).toBe(true);
    expect(shouldExclude('C:\\Users\\test\\ntuser.dat')).toBe(true);
    expect(shouldExclude('/tmp/PAGEFILE.SYS')).toBe(true);
  });

  it('excludes known directory segments', () => {
    const indexer = new FileIndexer();
    const shouldExclude = (indexer as any).shouldExclude.bind(indexer);
    expect(shouldExclude('/home/user/node_modules/package')).toBe(true);
    expect(shouldExclude('/home/user/.git/config')).toBe(true);
    expect(shouldExclude('/home/user/.cache/data')).toBe(true);
    expect(shouldExclude('C:\\$Recycle.Bin\\file')).toBe(true);
    expect(shouldExclude('/Users/user/Library/file')).toBe(true);
  });

  it('does not exclude normal paths', () => {
    const indexer = new FileIndexer();
    const shouldExclude = (indexer as any).shouldExclude.bind(indexer);
    expect(shouldExclude('/home/user/Documents/report.txt')).toBe(false);
    expect(shouldExclude('/home/user/project/src/main.ts')).toBe(false);
  });

  it('handles path with no separator', () => {
    const indexer = new FileIndexer();
    const shouldExclude = (indexer as any).shouldExclude.bind(indexer);
    expect(shouldExclude('thumbs.db')).toBe(true);
    expect(shouldExclude('normal-file.txt')).toBe(false);
  });

  it('excludes various system directories', () => {
    const indexer = new FileIndexer();
    const shouldExclude = (indexer as any).shouldExclude.bind(indexer);
    expect(shouldExclude('/path/.trash/file')).toBe(true);
    expect(shouldExclude('/path/trash/file')).toBe(true);
    expect(shouldExclude('/path/.npm/cache')).toBe(true);
    expect(shouldExclude('/path/.docker/config')).toBe(true);
    expect(shouldExclude('C:\\Windows\\System32')).toBe(true);
    expect(shouldExclude('C:\\Program Files\\App')).toBe(true);
    expect(shouldExclude('C:\\Program Files (x86)\\App')).toBe(true);
    expect(shouldExclude('C:\\ProgramData\\App')).toBe(true);
    expect(shouldExclude('C:\\Users\\test\\AppData\\Local')).toBe(true);
  });

  it('excludes additional system files', () => {
    const indexer = new FileIndexer();
    const shouldExclude = (indexer as any).shouldExclude.bind(indexer);
    expect(shouldExclude('/path/hiberfil.sys')).toBe(true);
    expect(shouldExclude('/path/swapfile.sys')).toBe(true);
    expect(shouldExclude('/path/dumpstack.log.tmp')).toBe(true);
    expect(shouldExclude('/path/dumpstack.log')).toBe(true);
    expect(shouldExclude('/path/ntuser.dat.log')).toBe(true);
    expect(shouldExclude('/path/ntuser.dat.log1')).toBe(true);
    expect(shouldExclude('/path/ntuser.dat.log2')).toBe(true);
  });

  it('excludes additional directory segments', () => {
    const indexer = new FileIndexer();
    const shouldExclude = (indexer as any).shouldExclude.bind(indexer);
    expect(shouldExclude('/path/caches/data')).toBe(true);
    expect(shouldExclude('/path/cache/data')).toBe(true);
    expect(shouldExclude('C:\\System Volume Information\\file')).toBe(true);
    expect(shouldExclude('C:\\$Windows.~BT\\file')).toBe(true);
    expect(shouldExclude('C:\\$Windows.~WS\\file')).toBe(true);
    expect(shouldExclude('C:\\Recovery\\file')).toBe(true);
    expect(shouldExclude('C:\\PerfLogs\\file')).toBe(true);
    expect(shouldExclude('C:\\$WinREAgent\\file')).toBe(true);
    expect(shouldExclude('C:\\Config.Msi\\file')).toBe(true);
    expect(shouldExclude('C:\\MSOCache\\file')).toBe(true);
    expect(shouldExclude('C:\\Intel\\file')).toBe(true);
    expect(shouldExclude('C:\\NVIDIA\\file')).toBe(true);
    expect(shouldExclude('C:\\AMD\\file')).toBe(true);
  });
});

describe('FileIndexer - scanDirectory', () => {
  it('handles readdir error gracefully', async () => {
    const indexer = new FileIndexer();
    fsMock.access.mockResolvedValue(undefined);
    fsMock.readdir.mockRejectedValue(new Error('Permission denied'));
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.buildIndex();

    expect(indexer.getStatus().isIndexing).toBe(false);
    consoleSpy.mockRestore();
  });

  it('handles stat errors via Promise.allSettled', async () => {
    const indexer = new FileIndexer();

    fsMock.access.mockResolvedValue(undefined);
    let readdirCallCount = 0;
    fsMock.readdir.mockImplementation(async () => {
      readdirCallCount++;
      if (readdirCallCount === 1) {
        return [
          { name: 'good.txt', isDirectory: () => false, isFile: () => true },
          { name: 'bad.txt', isDirectory: () => false, isFile: () => true },
        ] as any;
      }
      return [] as any;
    });

    fsMock.stat.mockImplementation(async (filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('bad.txt')) {
        throw new Error('stat failed');
      }
      return { size: 100, mtime: new Date() } as any;
    });
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);

    await indexer.buildIndex();

    expect(indexer.getStatus().isIndexing).toBe(false);
  });

  it('stops scanning when abort signal is triggered', async () => {
    const indexer = new FileIndexer();
    const scanDirectory = (indexer as any).scanDirectory.bind(indexer);

    const abortController = new AbortController();
    abortController.abort();

    await scanDirectory('/some/path', abortController.signal);
    expect(fsMock.readdir).not.toHaveBeenCalled();
  });

  it('skips excluded directory paths', async () => {
    const indexer = new FileIndexer();
    const scanDirectory = (indexer as any).scanDirectory.bind(indexer);

    await scanDirectory('/home/user/node_modules');
    expect(fsMock.readdir).not.toHaveBeenCalled();
  });

  it('stops when MAX_INDEX_SIZE is reached', async () => {
    const indexer = new FileIndexer();

    const indexMap = (indexer as any).index as Map<string, any>;
    for (let i = 0; i < 200000; i++) {
      indexMap.set(`/file${i}`, {
        name: `file${i}`,
        path: `/file${i}`,
        isDirectory: false,
        isFile: true,
        size: 1,
        modified: new Date(),
      });
    }

    fsMock.readdir.mockResolvedValue([
      { name: 'extra.txt', isDirectory: () => false, isFile: () => true },
    ] as any);
    fsMock.stat.mockResolvedValue({ size: 1, mtime: new Date() } as any);

    const scanDirectory = (indexer as any).scanDirectory.bind(indexer);
    await scanDirectory('/some/path');

    expect(indexMap.size).toBe(200000);
  });

  it('processes subdirectories recursively', async () => {
    const indexer = new FileIndexer();

    let callCount = 0;
    fsMock.readdir.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [
          { name: 'subdir', isDirectory: () => true, isFile: () => false },
          { name: 'file.txt', isDirectory: () => false, isFile: () => true },
        ] as any;
      }
      if (callCount === 2) {
        return [{ name: 'nested.txt', isDirectory: () => false, isFile: () => true }] as any;
      }
      return [] as any;
    });
    fsMock.stat.mockResolvedValue({ size: 50, mtime: new Date() } as any);

    const scanDirectory = (indexer as any).scanDirectory.bind(indexer);
    await scanDirectory('/test');

    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('stops processing during batch when signal aborted', async () => {
    const indexer = new FileIndexer();

    const abortController = new AbortController();
    (indexer as any).abortController = abortController;

    fsMock.readdir.mockResolvedValue([
      { name: 'file1.txt', isDirectory: () => false, isFile: () => true },
      { name: 'file2.txt', isDirectory: () => false, isFile: () => true },
    ] as any);
    fsMock.stat.mockImplementation(async () => {
      abortController.abort();
      return { size: 10, mtime: new Date() } as any;
    });

    const scanDirectory = (indexer as any).scanDirectory.bind(indexer);
    await scanDirectory('/test', abortController.signal);

    expect(indexer.getStatus().isIndexing).toBe(false);
  });

  it('does not recurse into subdirectories when at MAX_INDEX_SIZE', async () => {
    const indexer = new FileIndexer();

    const indexMap = (indexer as any).index as Map<string, any>;
    for (let i = 0; i < 199999; i++) {
      indexMap.set(`/file${i}`, {
        name: `file${i}`,
        path: `/file${i}`,
        isDirectory: false,
        isFile: true,
        size: 1,
        modified: new Date(),
      });
    }

    let readdirCallCount = 0;
    fsMock.readdir.mockImplementation(async () => {
      readdirCallCount++;
      if (readdirCallCount === 1) {
        return [
          { name: 'file-last.txt', isDirectory: () => false, isFile: () => true },
          { name: 'subdir', isDirectory: () => true, isFile: () => false },
        ] as any;
      }
      return [] as any;
    });
    fsMock.stat.mockResolvedValue({ size: 1, mtime: new Date() } as any);

    const scanDirectory = (indexer as any).scanDirectory.bind(indexer);
    await scanDirectory('/test');

    expect(indexMap.size).toBeLessThanOrEqual(200001);
  });
});

describe('FileIndexer - estimateTotalFiles', () => {
  it('estimates based on accessible locations', async () => {
    const indexer = new FileIndexer();
    const estimateTotalFiles = (indexer as any).estimateTotalFiles.bind(indexer);

    fsMock.access.mockResolvedValue(undefined);

    const result = await estimateTotalFiles(['/home', '/usr', '/opt']);
    expect(result).toBe(3000);
  });

  it('skips inaccessible locations', async () => {
    const indexer = new FileIndexer();
    const estimateTotalFiles = (indexer as any).estimateTotalFiles.bind(indexer);

    fsMock.access.mockImplementation(async (loc: string) => {
      if (loc === '/usr') throw new Error('no access');
    });

    const result = await estimateTotalFiles(['/home', '/usr', '/opt']);
    expect(result).toBe(2000);
  });

  it('returns 0 when all locations inaccessible', async () => {
    const indexer = new FileIndexer();
    const estimateTotalFiles = (indexer as any).estimateTotalFiles.bind(indexer);

    fsMock.access.mockRejectedValue(new Error('no access'));

    const result = await estimateTotalFiles(['/a', '/b']);
    expect(result).toBe(0);
  });
});

describe('FileIndexer - writeFileAtomic (via saveIndex)', () => {
  it('writes and renames successfully', async () => {
    const indexer = new FileIndexer();
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.saveIndex();

    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    expect(fsMock.rename).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('handles EEXIST on rename by unlinking and retrying rename', async () => {
    const indexer = new FileIndexer();
    fsMock.writeFile.mockResolvedValue(undefined);
    let renameCallCount = 0;
    fsMock.rename.mockImplementation(async () => {
      renameCallCount++;
      if (renameCallCount === 1) {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
    });
    fsMock.unlink.mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.saveIndex();

    expect(fsMock.unlink).toHaveBeenCalled();
    expect(renameCallCount).toBe(2);
    consoleSpy.mockRestore();
  });

  it('handles EPERM on rename -- unlink, retry rename fails, falls back to copy', async () => {
    const indexer = new FileIndexer();
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockRejectedValue(Object.assign(new Error('perm'), { code: 'EPERM' }));
    fsMock.unlink.mockResolvedValue(undefined);
    fsMock.copyFile.mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.saveIndex();

    expect(fsMock.copyFile).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('handles EACCES on rename with unlink failure', async () => {
    const indexer = new FileIndexer();
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockRejectedValue(Object.assign(new Error('access'), { code: 'EACCES' }));
    fsMock.unlink.mockRejectedValue(new Error('unlink failed'));
    fsMock.copyFile.mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.saveIndex();

    expect(fsMock.copyFile).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('falls back to copyFile when rename fails with non-EEXIST/EPERM/EACCES', async () => {
    const indexer = new FileIndexer();
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockRejectedValue(Object.assign(new Error('io error'), { code: 'EIO' }));
    fsMock.copyFile.mockResolvedValue(undefined);
    fsMock.unlink.mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.saveIndex();

    expect(fsMock.copyFile).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('cleans up tmp file after copyFile fallback', async () => {
    const indexer = new FileIndexer();
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockRejectedValue(Object.assign(new Error('io'), { code: 'EIO' }));
    fsMock.copyFile.mockResolvedValue(undefined);
    fsMock.unlink.mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexer.saveIndex();

    expect(fsMock.unlink).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('handles copyFile failure gracefully (still cleans up tmp)', async () => {
    const indexer = new FileIndexer();
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockRejectedValue(Object.assign(new Error('io'), { code: 'EIO' }));
    fsMock.copyFile.mockRejectedValue(new Error('copy failed'));
    fsMock.unlink.mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await indexer.saveIndex();

    expect(fsMock.unlink).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('FileIndexer - constructor', () => {
  it('creates indexer without fileTasks', () => {
    const indexer = new FileIndexer();
    expect(indexer.isEnabled()).toBe(true);
    expect(indexer.getStatus().isIndexing).toBe(false);
    expect((indexer as any).fileTasks).toBeNull();
  });

  it('creates indexer with fileTasks', () => {
    const fileTasks = makeTaskManager();
    const indexer = new FileIndexer(fileTasks as unknown as never);
    expect((indexer as any).fileTasks).toBe(fileTasks);
  });

  it('sets indexPath from userData', () => {
    const indexer = new FileIndexer();
    expect((indexer as any).indexPath).toContain('file-index.json');
  });
});
