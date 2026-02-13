import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
  appGetPath: vi.fn(() => '/tmp/test-userData'),
  fsMkdir: vi.fn().mockResolvedValue(undefined),
  fsReaddir: vi.fn().mockResolvedValue([]),
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

vi.mock('./security', () => ({
  isPathSafe: mocks.isPathSafe,
  getErrorMessage: mocks.getErrorMessage,
}));

vi.mock('./shared', () => ({
  ignoreError: mocks.ignoreError,
}));

vi.mock('./ipcUtils', () => ({
  isTrustedIpcEvent: mocks.isTrustedIpcEvent,
}));

import {
  getThumbnailFromCache,
  saveThumbnailToCache,
  clearThumbnailCache,
  getThumbnailCacheSize,
  stopThumbnailCacheCleanup,
  setupThumbnailCacheHandlers,
} from './thumbnailCache';

describe('getThumbnailFromCache', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error for unsafe path', async () => {
    mocks.isPathSafe.mockReturnValueOnce(false);
    const result = await getThumbnailFromCache('/etc/passwd');
    expect(result).toEqual({ success: false, error: 'Invalid path' });
  });

  it('returns not-in-cache when cache file missing', async () => {
    mocks.fsStat.mockResolvedValue({ mtimeMs: 12345 });
    mocks.fsMkdir.mockResolvedValue(undefined);
    mocks.fsReadFile.mockRejectedValue(new Error('ENOENT'));
    const result = await getThumbnailFromCache('/path/to/photo.jpg');
    expect(result).toEqual({ success: false, error: 'Not in cache' });
  });

  it('returns data URL on cache hit', async () => {
    mocks.fsStat.mockResolvedValue({ mtimeMs: 12345 });
    mocks.fsMkdir.mockResolvedValue(undefined);
    const fakeData = Buffer.from('fake-jpeg');
    mocks.fsReadFile.mockResolvedValue(fakeData);
    const result = await getThumbnailFromCache('/path/to/photo.jpg');
    expect(result.success).toBe(true);
    expect(result.dataUrl).toContain('data:image/jpeg;base64,');
  });

  it('handles stat error', async () => {
    mocks.fsStat.mockRejectedValue(new Error('ENOENT'));
    const result = await getThumbnailFromCache('/nonexistent.jpg');
    expect(result.success).toBe(false);
    expect(result.error).toBe('ENOENT');
  });
});

describe('saveThumbnailToCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('returns error for unsafe path', async () => {
    mocks.isPathSafe.mockReturnValueOnce(false);
    const result = await saveThumbnailToCache('/etc/passwd', 'data:image/jpeg;base64,abc');
    expect(result).toEqual({ success: false, error: 'Invalid path' });
  });

  it('returns error for invalid data URL format', async () => {
    mocks.fsStat.mockResolvedValue({ mtimeMs: 12345 });
    mocks.fsMkdir.mockResolvedValue(undefined);
    const result = await saveThumbnailToCache('/photo.jpg', 'not-a-data-url');
    expect(result).toEqual({ success: false, error: 'Invalid data URL format' });
  });

  it('saves thumbnail successfully', async () => {
    mocks.fsStat.mockResolvedValue({ mtimeMs: 12345 });
    mocks.fsMkdir.mockResolvedValue(undefined);
    mocks.fsWriteFile.mockResolvedValue(undefined);
    const smallBase64 = Buffer.from('test-image').toString('base64');
    const result = await saveThumbnailToCache(
      '/photo.jpg',
      `data:image/jpeg;base64,${smallBase64}`
    );
    expect(result).toEqual({ success: true });
    expect(mocks.fsWriteFile).toHaveBeenCalled();
  });

  it('rejects oversized thumbnails', async () => {
    mocks.fsStat.mockResolvedValue({ mtimeMs: 12345 });
    mocks.fsMkdir.mockResolvedValue(undefined);
    const largeBase64 = 'A'.repeat(7 * 1024 * 1024);
    const result = await saveThumbnailToCache(
      '/photo.jpg',
      `data:image/jpeg;base64,${largeBase64}`
    );
    expect(result).toEqual({ success: false, error: 'Thumbnail too large' });
  });

  it('handles write error', async () => {
    mocks.fsStat.mockResolvedValue({ mtimeMs: 12345 });
    mocks.fsMkdir.mockResolvedValue(undefined);
    mocks.fsWriteFile.mockRejectedValue(new Error('Disk full'));
    const smallBase64 = Buffer.from('test').toString('base64');
    const result = await saveThumbnailToCache(
      '/photo.jpg',
      `data:image/jpeg;base64,${smallBase64}`
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('Disk full');
  });
});

describe('clearThumbnailCache', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes all subdirectories', async () => {
    mocks.fsMkdir.mockResolvedValue(undefined);
    mocks.fsReaddir.mockResolvedValue([
      { name: 'ab', isDirectory: () => true },
      { name: 'cd', isDirectory: () => true },
      { name: 'readme.txt', isDirectory: () => false },
    ]);
    mocks.fsRm.mockResolvedValue(undefined);

    const result = await clearThumbnailCache();
    expect(result).toEqual({ success: true });
    expect(mocks.fsRm).toHaveBeenCalledTimes(2);
  });

  it('handles errors', async () => {
    mocks.fsMkdir.mockResolvedValue(undefined);
    mocks.fsReaddir.mockRejectedValue(new Error('Permission denied'));
    const result = await clearThumbnailCache();
    expect(result.success).toBe(false);
    expect(result.error).toBe('Permission denied');
  });
});

describe('getThumbnailCacheSize', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns zero for empty cache', async () => {
    mocks.fsMkdir.mockResolvedValue(undefined);
    mocks.fsReaddir.mockResolvedValue([]);
    const result = await getThumbnailCacheSize();
    expect(result).toEqual({ success: true, sizeBytes: 0, fileCount: 0 });
  });

  it('handles errors', async () => {
    mocks.fsMkdir.mockResolvedValue(undefined);
    mocks.fsReaddir.mockRejectedValue(new Error('Permission denied'));
    const result = await getThumbnailCacheSize();

    expect(result.success).toBe(true);
    expect(result.sizeBytes).toBe(0);
  });
});

describe('setupThumbnailCacheHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopThumbnailCacheCleanup();
    vi.useRealTimers();
  });

  it('registers four IPC handlers', () => {
    setupThumbnailCacheHandlers();
    const channels = mocks.ipcMainHandle.mock.calls.map((c: any[]) => c[0]);
    expect(channels).toContain('get-cached-thumbnail');
    expect(channels).toContain('save-cached-thumbnail');
    expect(channels).toContain('clear-thumbnail-cache');
    expect(channels).toContain('get-thumbnail-cache-size');
  });

  it('IPC handlers reject untrusted senders', async () => {
    setupThumbnailCacheHandlers();
    mocks.isTrustedIpcEvent.mockReturnValue(false);

    for (const call of mocks.ipcMainHandle.mock.calls) {
      const handler = call[1];
      const event = { sender: { id: 1 } } as any;
      const result = await handler(event);
      expect(result).toEqual(expect.objectContaining({ success: false }));
    }
  });
});

describe('stopThumbnailCacheCleanup', () => {
  it('does not throw when called', () => {
    expect(() => stopThumbnailCacheCleanup()).not.toThrow();
  });

  it('can be called multiple times', () => {
    stopThumbnailCacheCleanup();
    stopThumbnailCacheCleanup();
  });
});
