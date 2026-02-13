import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
  appGetPath: vi.fn(() => '/tmp/test-userData'),
  fsMkdir: vi.fn().mockResolvedValue(undefined),
  fsReaddir: vi.fn().mockResolvedValue([] as any[]),
  fsReadFile: vi.fn(),
  fsWriteFile: vi.fn().mockResolvedValue(undefined),
  fsStat: vi.fn(),
  fsUnlink: vi.fn().mockResolvedValue(undefined),
  fsRm: vi.fn().mockResolvedValue(undefined),
  fsRmdir: vi.fn().mockResolvedValue(undefined),
  isPathSafe: vi.fn(() => true),
  getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  ignoreError: vi.fn(),
  isTrustedIpcEvent: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.ipcMainHandle },
  app: { getPath: mocks.appGetPath },
}));

vi.mock('fs', () => ({
  default: {},
  promises: {
    mkdir: mocks.fsMkdir,
    readdir: mocks.fsReaddir,
    readFile: mocks.fsReadFile,
    writeFile: mocks.fsWriteFile,
    stat: mocks.fsStat,
    unlink: mocks.fsUnlink,
    rm: mocks.fsRm,
    rmdir: mocks.fsRmdir,
  },
}));

vi.mock('../security', () => ({
  isPathSafe: mocks.isPathSafe,
  getErrorMessage: mocks.getErrorMessage,
}));

vi.mock('../shared', () => ({
  ignoreError: mocks.ignoreError,
}));

vi.mock('../ipcUtils', () => ({
  isTrustedIpcEvent: mocks.isTrustedIpcEvent,
}));

async function freshImport() {
  vi.resetModules();
  return import('../thumbnailCache');
}

const CACHE_DIR = '/tmp/test-userData/thumbnail-cache';

describe('ensureCacheDir', () => {
  beforeEach(() => vi.clearAllMocks());

  it('propagates mkdir error to callers', async () => {
    const mod = await freshImport();
    mocks.fsMkdir.mockRejectedValueOnce(new Error('EACCES'));
    mocks.fsStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await mod.getThumbnailFromCache('/some/file.jpg');
    expect(result.success).toBe(false);
    expect(result.error).toBe('EACCES');
  });

  it('creates cache directory only once across multiple calls (idempotency)', async () => {
    const mod = await freshImport();
    mocks.fsStat.mockResolvedValue({ mtimeMs: 1000 });
    mocks.fsReadFile.mockRejectedValue(new Error('ENOENT'));

    await mod.getThumbnailFromCache('/file1.jpg');
    await mod.getThumbnailFromCache('/file2.jpg');
    await mod.getThumbnailFromCache('/file3.jpg');

    const cacheDirCalls = mocks.fsMkdir.mock.calls.filter((c: any[]) => c[0] === CACHE_DIR);
    expect(cacheDirCalls).toHaveLength(1);
  });
});

describe('getCachePath', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a two-character hex subdirectory for the cache key', async () => {
    const mod = await freshImport();
    mocks.fsStat.mockResolvedValue({ mtimeMs: 5000 });
    mocks.fsReadFile.mockRejectedValue(new Error('ENOENT'));

    await mod.getThumbnailFromCache('/test/photo.jpg');

    const subDirCalls = mocks.fsMkdir.mock.calls
      .map((c: any[]) => c[0] as string)
      .filter((p: string) => p !== CACHE_DIR && p.startsWith(CACHE_DIR + '/'));

    expect(subDirCalls).toHaveLength(1);
    const subDirName = subDirCalls[0].replace(CACHE_DIR + '/', '');
    expect(subDirName).toMatch(/^[0-9a-f]{2}$/);
  });

  it('handles mkdir error for subdirectory via ignoreError', async () => {
    const mod = await freshImport();
    mocks.fsStat.mockResolvedValue({ mtimeMs: 1000 });
    mocks.fsReadFile.mockRejectedValue(new Error('ENOENT'));

    mocks.fsMkdir.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('EEXIST'));

    const result = await mod.getThumbnailFromCache('/photo.jpg');

    expect(result.success).toBe(false);
    expect(mocks.ignoreError).toHaveBeenCalled();
  });
});

describe('walkCacheDir', () => {
  beforeEach(() => vi.clearAllMocks());

  it('recursively visits files in nested subdirectories', async () => {
    const mod = await freshImport();

    mocks.fsReaddir.mockImplementation(async (dirPath: string, opts?: any) => {
      if (dirPath === CACHE_DIR && opts?.withFileTypes) {
        return [
          { name: 'ab', isDirectory: () => true },
          { name: 'cd', isDirectory: () => true },
        ];
      }
      if (dirPath === `${CACHE_DIR}/ab` && opts?.withFileTypes) {
        return [{ name: 'f1.jpg', isDirectory: () => false }];
      }
      if (dirPath === `${CACHE_DIR}/cd` && opts?.withFileTypes) {
        return [{ name: 'f2.jpg', isDirectory: () => false }];
      }
      return [];
    });

    mocks.fsStat.mockImplementation(async (p: string) => {
      if (p.includes('f1.jpg')) return { size: 100, atimeMs: 1000 };
      if (p.includes('f2.jpg')) return { size: 250, atimeMs: 2000 };
      throw new Error('unexpected stat');
    });

    const result = await mod.getThumbnailCacheSize();
    expect(result).toEqual({ success: true, sizeBytes: 350, fileCount: 2 });
  });

  it('skips files whose stat call rejects (Promise.allSettled)', async () => {
    const mod = await freshImport();

    mocks.fsReaddir.mockImplementation(async (dirPath: string, opts?: any) => {
      if (dirPath === CACHE_DIR && opts?.withFileTypes) {
        return [
          { name: 'good.jpg', isDirectory: () => false },
          { name: 'bad.jpg', isDirectory: () => false },
        ];
      }
      return [];
    });

    mocks.fsStat.mockImplementation(async (p: string) => {
      if (p.includes('good.jpg')) return { size: 512, atimeMs: 1000 };
      throw new Error('ENOENT');
    });

    const result = await mod.getThumbnailCacheSize();
    expect(result).toEqual({ success: true, sizeBytes: 512, fileCount: 1 });
  });

  it('silently returns when readdir fails for a nested directory', async () => {
    const mod = await freshImport();

    mocks.fsReaddir.mockImplementation(async (dirPath: string, opts?: any) => {
      if (dirPath === CACHE_DIR && opts?.withFileTypes) {
        return [{ name: 'broken', isDirectory: () => true }];
      }

      if (dirPath === `${CACHE_DIR}/broken`) throw new Error('EPERM');
      return [];
    });

    const result = await mod.getThumbnailCacheSize();
    expect(result).toEqual({ success: true, sizeBytes: 0, fileCount: 0 });
  });
});

describe('cleanupOldThumbnails', () => {
  beforeEach(() => vi.clearAllMocks());

  it('unlinks files older than MAX_CACHE_AGE_DAYS', async () => {
    const mod = await freshImport();
    const now = Date.now();
    const oldTime = now - 31 * 24 * 60 * 60 * 1000;
    const recentTime = now - 60_000;

    mocks.fsReaddir.mockImplementation(async (_d: string, opts?: any) => {
      if (opts?.withFileTypes) {
        return [
          { name: 'old.jpg', isDirectory: () => false },
          { name: 'recent.jpg', isDirectory: () => false },
        ];
      }
      return [];
    });

    mocks.fsStat.mockImplementation(async (p: string) => {
      if (p.includes('old.jpg')) return { size: 100, atimeMs: oldTime };
      return { size: 100, atimeMs: recentTime };
    });

    await mod.cleanupOldThumbnails();

    const unlinkPaths = mocks.fsUnlink.mock.calls.map((c: any[]) => c[0]);
    expect(unlinkPaths).toContain(`${CACHE_DIR}/old.jpg`);
  });

  it('removes empty subdirectories after deleting old files', async () => {
    const mod = await freshImport();
    const now = Date.now();
    const oldTime = now - 31 * 24 * 60 * 60 * 1000;

    mocks.fsReaddir.mockImplementation(async (dirPath: string, opts?: any) => {
      if (dirPath === CACHE_DIR && opts?.withFileTypes) {
        return [{ name: 'ab', isDirectory: () => true }];
      }
      if (dirPath === `${CACHE_DIR}/ab` && opts?.withFileTypes) {
        return [{ name: 'expired.jpg', isDirectory: () => false }];
      }

      if (dirPath === `${CACHE_DIR}/ab` && !opts?.withFileTypes) {
        return [];
      }
      return [];
    });

    mocks.fsStat.mockResolvedValue({ size: 50, atimeMs: oldTime });

    await mod.cleanupOldThumbnails();

    expect(mocks.fsRmdir).toHaveBeenCalledWith(`${CACHE_DIR}/ab`);
  });

  it('keeps non-empty subdirectories', async () => {
    const mod = await freshImport();
    const now = Date.now();
    const recentTime = now - 60_000;

    mocks.fsReaddir.mockImplementation(async (dirPath: string, opts?: any) => {
      if (dirPath === CACHE_DIR && opts?.withFileTypes) {
        return [{ name: 'ab', isDirectory: () => true }];
      }
      if (dirPath === `${CACHE_DIR}/ab` && opts?.withFileTypes) {
        return [{ name: 'keep.jpg', isDirectory: () => false }];
      }
      if (dirPath === `${CACHE_DIR}/ab` && !opts?.withFileTypes) {
        return ['keep.jpg'];
      }
      return [];
    });

    mocks.fsStat.mockResolvedValue({ size: 50, atimeMs: recentTime });

    await mod.cleanupOldThumbnails();

    expect(mocks.fsRmdir).not.toHaveBeenCalled();
  });

  it('gracefully handles unlink errors via ignoreError', async () => {
    const mod = await freshImport();
    const now = Date.now();
    const oldTime = now - 31 * 24 * 60 * 60 * 1000;

    mocks.fsReaddir.mockImplementation(async (_d: string, opts?: any) => {
      if (opts?.withFileTypes) {
        return [{ name: 'failing.jpg', isDirectory: () => false }];
      }
      return [];
    });

    mocks.fsStat.mockResolvedValue({ size: 100, atimeMs: oldTime });
    mocks.fsUnlink.mockRejectedValueOnce(new Error('EPERM'));

    await expect(mod.cleanupOldThumbnails()).resolves.toBeUndefined();
    expect(mocks.ignoreError).toHaveBeenCalled();
  });

  it('catches and logs top-level errors (e.g. ensureCacheDir failure)', async () => {
    const mod = await freshImport();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mocks.fsMkdir.mockRejectedValueOnce(new Error('ENOSPC'));

    await mod.cleanupOldThumbnails();

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('[ThumbnailCache]'),
      expect.any(Error)
    );
    spy.mockRestore();
  });
});

describe('enforceCacheSize', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes oldest files first when total exceeds MAX_CACHE_SIZE_MB', async () => {
    const mod = await freshImport();
    const now = Date.now();
    const MB = 1024 * 1024;
    const sizePerFile = 200 * MB;

    mocks.fsReaddir.mockImplementation(async (_d: string, opts?: any) => {
      if (opts?.withFileTypes) {
        return [
          { name: 'oldest.jpg', isDirectory: () => false },
          { name: 'middle.jpg', isDirectory: () => false },
          { name: 'newest.jpg', isDirectory: () => false },
        ];
      }
      return [];
    });

    mocks.fsStat.mockImplementation(async (p: string) => {
      if (p.includes('oldest')) return { size: sizePerFile, atimeMs: now - 3 * 86_400_000 };
      if (p.includes('middle')) return { size: sizePerFile, atimeMs: now - 2 * 86_400_000 };
      return { size: sizePerFile, atimeMs: now - 86_400_000 };
    });

    await mod.cleanupOldThumbnails();

    const unlinkPaths = mocks.fsUnlink.mock.calls.map((c: any[]) => c[0]);

    expect(unlinkPaths).toContain(`${CACHE_DIR}/oldest.jpg`);
    expect(unlinkPaths.filter((p: string) => p.includes('middle'))).toHaveLength(0);
    expect(unlinkPaths.filter((p: string) => p.includes('newest'))).toHaveLength(0);
  });

  it('does not delete files when total is under the size limit', async () => {
    const mod = await freshImport();
    const now = Date.now();

    mocks.fsReaddir.mockImplementation(async (_d: string, opts?: any) => {
      if (opts?.withFileTypes) {
        return [
          { name: 'a.jpg', isDirectory: () => false },
          { name: 'b.jpg', isDirectory: () => false },
        ];
      }
      return [];
    });

    mocks.fsStat.mockResolvedValue({ size: 1024, atimeMs: now - 60_000 });

    await mod.cleanupOldThumbnails();

    expect(mocks.fsUnlink).not.toHaveBeenCalled();
  });

  it('continues to next file when unlink fails during size enforcement', async () => {
    const mod = await freshImport();
    const now = Date.now();
    const MB = 1024 * 1024;
    const sizePerFile = 200 * MB;

    mocks.fsReaddir.mockImplementation(async (_d: string, opts?: any) => {
      if (opts?.withFileTypes) {
        return [
          { name: 'oldest.jpg', isDirectory: () => false },
          { name: 'middle.jpg', isDirectory: () => false },
          { name: 'newest.jpg', isDirectory: () => false },
        ];
      }
      return [];
    });

    mocks.fsStat.mockImplementation(async (p: string) => {
      if (p.includes('oldest')) return { size: sizePerFile, atimeMs: now - 3 * 86_400_000 };
      if (p.includes('middle')) return { size: sizePerFile, atimeMs: now - 2 * 86_400_000 };
      return { size: sizePerFile, atimeMs: now - 86_400_000 };
    });

    mocks.fsUnlink.mockImplementation(async (p: string) => {
      if ((p as string).includes('oldest')) throw new Error('EPERM');
    });

    await mod.cleanupOldThumbnails();

    const unlinkPaths = mocks.fsUnlink.mock.calls.map((c: any[]) => c[0]);

    expect(unlinkPaths.filter((p: string) => p.includes('oldest')).length).toBeGreaterThanOrEqual(
      1
    );
    expect(unlinkPaths.filter((p: string) => p.includes('middle')).length).toBeGreaterThanOrEqual(
      1
    );
    expect(mocks.ignoreError).toHaveBeenCalled();
  });
});

describe('debouncedEnforceCacheSize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('triggers enforceCacheSize 30 s after saving a thumbnail', async () => {
    const mod = await freshImport();

    mocks.fsStat.mockResolvedValue({ mtimeMs: 1000 });
    mocks.fsWriteFile.mockResolvedValue(undefined);
    mocks.fsMkdir.mockResolvedValue(undefined);
    mocks.fsReaddir.mockResolvedValue([]);

    const b64 = Buffer.from('px').toString('base64');
    await mod.saveThumbnailToCache('/img.jpg', `data:image/jpeg;base64,${b64}`);

    const callsBefore = mocks.fsReaddir.mock.calls.length;

    await vi.advanceTimersByTimeAsync(29_000);
    expect(mocks.fsReaddir.mock.calls.length).toBe(callsBefore);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.fsReaddir.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('resets debounce timer on each subsequent save', async () => {
    const mod = await freshImport();

    mocks.fsStat.mockResolvedValue({ mtimeMs: 2000 });
    mocks.fsWriteFile.mockResolvedValue(undefined);
    mocks.fsMkdir.mockResolvedValue(undefined);
    mocks.fsReaddir.mockResolvedValue([]);

    const b64 = Buffer.from('px').toString('base64');
    const url = `data:image/jpeg;base64,${b64}`;

    await mod.saveThumbnailToCache('/a.jpg', url);
    await vi.advanceTimersByTimeAsync(20_000);

    await mod.saveThumbnailToCache('/b.jpg', url);
    const callsBefore = mocks.fsReaddir.mock.calls.length;

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.fsReaddir.mock.calls.length).toBe(callsBefore);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.fsReaddir.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

describe('setupThumbnailCacheHandlers – timer scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('runs initial cleanupOldThumbnails via setTimeout after 30 s', async () => {
    const mod = await freshImport();
    mocks.fsReaddir.mockResolvedValue([]);

    mod.setupThumbnailCacheHandlers();
    const callsBefore = mocks.fsReaddir.mock.calls.length;

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.fsReaddir.mock.calls.length).toBeGreaterThan(callsBefore);

    mod.stopThumbnailCacheCleanup();
  });

  it('runs recurring cleanup via setInterval every hour', async () => {
    const mod = await freshImport();
    mocks.fsReaddir.mockResolvedValue([]);

    mod.setupThumbnailCacheHandlers();

    await vi.advanceTimersByTimeAsync(30_000);
    const callsAfterInit = mocks.fsReaddir.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mocks.fsReaddir.mock.calls.length).toBeGreaterThan(callsAfterInit);

    mod.stopThumbnailCacheCleanup();
  });
});

describe('stopThumbnailCacheCleanup – clearing active timers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('prevents further interval-based cleanups', async () => {
    const mod = await freshImport();
    mocks.fsReaddir.mockResolvedValue([]);

    mod.setupThumbnailCacheHandlers();

    await vi.advanceTimersByTimeAsync(30_000);
    const callsAfterInit = mocks.fsReaddir.mock.calls.length;

    mod.stopThumbnailCacheCleanup();

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(mocks.fsReaddir.mock.calls.length).toBe(callsAfterInit);
  });

  it('clears the debounced enforce-size timer set by saves', async () => {
    const mod = await freshImport();

    mocks.fsStat.mockResolvedValue({ mtimeMs: 1000 });
    mocks.fsWriteFile.mockResolvedValue(undefined);
    mocks.fsMkdir.mockResolvedValue(undefined);
    mocks.fsReaddir.mockResolvedValue([]);

    const b64 = Buffer.from('d').toString('base64');
    await mod.saveThumbnailToCache('/x.jpg', `data:image/jpeg;base64,${b64}`);

    const callsBefore = mocks.fsReaddir.mock.calls.length;

    mod.stopThumbnailCacheCleanup();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.fsReaddir.mock.calls.length).toBe(callsBefore);
  });
});
