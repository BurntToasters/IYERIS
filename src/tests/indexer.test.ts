import { describe, expect, it, vi } from 'vitest';

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

vi.mock('../main/utils', () => ({
  getDrives: getDrivesMock,
}));

vi.mock('../shared', () => ({
  ignoreError: vi.fn(),
}));

import { FileIndexer } from '../main/indexer';

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

describe('FileIndexer', () => {
  it('loads index lazily during search, returns exact match first, and caps to 100 results', async () => {
    const fileTasks = makeTaskManager();
    const now = Date.now();
    const entries: Array<[string, Record<string, unknown>]> = [
      [
        '/tmp/file',
        {
          name: 'file',
          path: '/tmp/file',
          isDirectory: false,
          isFile: true,
          size: 1,
          modified: now,
        },
      ],
    ];

    for (let i = 0; i < 149; i++) {
      entries.push([
        `/tmp/file-${i}.txt`,
        {
          name: `file-${i}.txt`,
          path: `/tmp/file-${i}.txt`,
          isDirectory: false,
          isFile: true,
          size: i,
          modified: now,
        },
      ]);
    }

    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return { exists: true, index: entries, lastIndexTime: now };
      }
      throw new Error(`Unexpected task: ${type}`);
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    const results = await indexer.search('file');
    const secondResults = await indexer.search('file');

    const loadCalls = fileTasks.runTask.mock.calls.filter(
      ([taskType]) => taskType === 'load-index'
    );
    expect(loadCalls).toHaveLength(1);
    expect(results).toHaveLength(100);
    expect(results[0].name).toBe('file');
    expect(secondResults).toHaveLength(100);
  });

  it('normalizes loaded entries and ignores invalid records', async () => {
    const fileTasks = makeTaskManager();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/tmp/a.txt',
              {
                name: 'a.txt',
                path: '/tmp/a.txt',
                isDirectory: false,
                isFile: true,
                size: 12,
                modified: 'not-a-date',
              },
            ],
            {
              path: '/tmp/folder',
              name: 'folder',
              isDirectory: true,
              size: 0,
              modified: 1700000000000,
            },
            ['no-item'],
            { name: 'missing-path' },
          ],
          lastIndexTime: 1700000000000,
        };
      }
      throw new Error(`Unexpected task: ${type}`);
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    const entries = await indexer.getEntries();
    entries.sort((a, b) => a.path.localeCompare(b.path));

    expect(entries).toHaveLength(2);
    expect(entries[0].path).toBe('/tmp/a.txt');
    expect(entries[0].modified.getTime()).toBe(0);
    expect(entries[1].path).toBe('/tmp/folder');
    expect(entries[1].isDirectory).toBe(true);
    expect(entries[1].isFile).toBe(false);
    expect(indexer.getStatus().indexedFiles).toBe(2);
  });

  it('delegates saveIndex to worker tasks with normalized payload', async () => {
    const fileTasks = makeTaskManager();
    const now = Date.now();
    fileTasks.runTask.mockImplementation(async (type: string) => {
      if (type === 'load-index') {
        return {
          exists: true,
          index: [
            [
              '/tmp/doc.txt',
              {
                name: 'doc.txt',
                path: '/tmp/doc.txt',
                isDirectory: false,
                isFile: true,
                size: 4,
                modified: now,
              },
            ],
          ],
          lastIndexTime: now,
        };
      }
      if (type === 'save-index') {
        return { success: true };
      }
      throw new Error(`Unexpected task: ${type}`);
    });

    const indexer = new FileIndexer(fileTasks as unknown as never);
    await indexer.loadIndex();
    await indexer.saveIndex();

    const saveCall = fileTasks.runTask.mock.calls.find(([taskType]) => taskType === 'save-index');
    expect(saveCall).toBeDefined();
    const payload = saveCall?.[1] as { indexPath: string; entries: unknown[] };
    expect(payload.indexPath).toBe('/tmp/iyeris-user/file-index.json');
    expect(payload.entries).toHaveLength(1);
  });

  it('aborts and cancels active build before rebuild', async () => {
    const fileTasks = makeTaskManager();
    const indexer = new FileIndexer(fileTasks as unknown as never);
    const abortController = new AbortController();
    (indexer as unknown as { abortController: AbortController }).abortController = abortController;
    (indexer as unknown as { buildOperationId: string }).buildOperationId = 'build-123';
    const clearSpy = vi.spyOn(indexer, 'clearIndex').mockResolvedValue(undefined);
    const buildSpy = vi.spyOn(indexer, 'buildIndex').mockResolvedValue(undefined);

    await indexer.rebuildIndex();

    expect(abortController.signal.aborted).toBe(true);
    expect(fileTasks.cancelOperation).toHaveBeenCalledWith('build-123');
    expect((indexer as unknown as { buildOperationId: string | null }).buildOperationId).toBeNull();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels active worker operation when disabled', () => {
    const fileTasks = makeTaskManager();
    const indexer = new FileIndexer(fileTasks as unknown as never);
    const abortController = new AbortController();
    (indexer as unknown as { abortController: AbortController }).abortController = abortController;
    (indexer as unknown as { buildOperationId: string }).buildOperationId = 'build-active';

    indexer.setEnabled(false);

    expect(indexer.isEnabled()).toBe(false);
    expect(abortController.signal.aborted).toBe(true);
    expect(fileTasks.cancelOperation).toHaveBeenCalledWith('build-active');
  });

  it('skips initialization work when disabled', async () => {
    const fileTasks = makeTaskManager();
    const indexer = new FileIndexer(fileTasks as unknown as never);
    const loadSpy = vi.spyOn(indexer, 'loadIndex').mockResolvedValue(undefined);
    const buildSpy = vi.spyOn(indexer, 'buildIndex').mockResolvedValue(undefined);

    await indexer.initialize(false);

    expect(loadSpy).not.toHaveBeenCalled();
    expect(buildSpy).not.toHaveBeenCalled();
  });
});
