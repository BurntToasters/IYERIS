import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('util', () => ({
  promisify: vi.fn(() => execFileMock),
}));

vi.mock('../main/appState', () => ({
  HIDDEN_FILE_CACHE_TTL: 300000,
  HIDDEN_FILE_CACHE_MAX: 3,
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('hiddenFileCache (extended)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.useRealTimers();
  });

  describe('isFileHiddenCached on win32', () => {
    it('returns true for dotfiles on win32', async () => {
      setPlatform('win32');
      const mod = await import('../main/hiddenFileCache');
      const result = await mod.isFileHiddenCached('C:\\Users\\test\\.bashrc', '.bashrc');
      expect(result).toBe(true);
    });

    it('checks attrib command for non-dotfiles on win32', async () => {
      setPlatform('win32');
      execFileMock.mockResolvedValueOnce({
        stdout: '  A  H       C:\\Users\\test\\hidden.txt\r\n',
      });

      const mod = await import('../main/hiddenFileCache');
      const result = await mod.isFileHiddenCached('C:\\Users\\test\\hidden.txt', 'hidden.txt');
      expect(result).toBe(true);
    });

    it('returns false for visible files on win32', async () => {
      setPlatform('win32');
      execFileMock.mockResolvedValueOnce({
        stdout: '  A          C:\\Users\\test\\visible.txt\r\n',
      });

      const mod = await import('../main/hiddenFileCache');
      const result = await mod.isFileHiddenCached('C:\\Users\\test\\visible.txt', 'visible.txt');
      expect(result).toBe(false);
    });

    it('returns false when attrib command fails', async () => {
      setPlatform('win32');
      execFileMock.mockRejectedValueOnce(new Error('Command not found'));

      const mod = await import('../main/hiddenFileCache');
      const result = await mod.isFileHiddenCached('C:\\test\\file.txt', 'file.txt');
      expect(result).toBe(false);
    });

    it('returns false when attrib output does not match regex', async () => {
      setPlatform('win32');
      execFileMock.mockResolvedValueOnce({ stdout: '12345\r\n' });

      const mod = await import('../main/hiddenFileCache');
      const result = await mod.isFileHiddenCached('C:\\test\\odd.txt', 'odd.txt');
      expect(result).toBe(false);
    });

    it('caches results on win32', async () => {
      setPlatform('win32');
      execFileMock.mockResolvedValueOnce({
        stdout: '  A  H       C:\\test\\file.txt\r\n',
      });

      const mod = await import('../main/hiddenFileCache');
      const first = await mod.isFileHiddenCached('C:\\test\\file.txt', 'file.txt');
      expect(first).toBe(true);

      execFileMock.mockClear();
      const second = await mod.isFileHiddenCached('C:\\test\\file.txt', 'file.txt');
      expect(second).toBe(true);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('returns false for empty stdout from attrib', async () => {
      setPlatform('win32');
      execFileMock.mockResolvedValueOnce({ stdout: '' });

      const mod = await import('../main/hiddenFileCache');
      const result = await mod.isFileHiddenCached('C:\\test\\file.txt', 'file.txt');
      expect(result).toBe(false);
    });

    it('triggers cache cleanup but does not evict when size equals max', async () => {
      setPlatform('win32');
      execFileMock.mockResolvedValue({
        stdout: '  A          C:\\test\\file.txt\r\n',
      });

      const mod = await import('../main/hiddenFileCache');

      await mod.isFileHiddenCached('C:\\test\\a.txt', 'a.txt');
      await mod.isFileHiddenCached('C:\\test\\b.txt', 'b.txt');
      await mod.isFileHiddenCached('C:\\test\\c.txt', 'c.txt');

      await mod.isFileHiddenCached('C:\\test\\d.txt', 'd.txt');
    });

    it('evicts oldest entries when cache exceeds max size (lines 52-58)', async () => {
      setPlatform('win32');
      vi.useFakeTimers({ now: 1000 });
      execFileMock.mockResolvedValue({
        stdout: '  A          C:\\test\\file.txt\r\n',
      });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mod = await import('../main/hiddenFileCache');

      await mod.isFileHiddenCached('C:\\test\\a.txt', 'a.txt');
      vi.advanceTimersByTime(10);
      await mod.isFileHiddenCached('C:\\test\\b.txt', 'b.txt');
      vi.advanceTimersByTime(10);
      await mod.isFileHiddenCached('C:\\test\\c.txt', 'c.txt');
      vi.advanceTimersByTime(10);

      await mod.isFileHiddenCached('C:\\test\\d.txt', 'd.txt');
      vi.advanceTimersByTime(10);

      await mod.isFileHiddenCached('C:\\test\\e.txt', 'e.txt');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cleaned up 1 hidden file cache entries')
      );

      consoleSpy.mockRestore();
    });

    it('evicts multiple entries when cache greatly exceeds max', async () => {
      setPlatform('win32');
      vi.useFakeTimers({ now: 1000 });
      execFileMock.mockResolvedValue({
        stdout: '  A          C:\\test\\file.txt\r\n',
      });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mod = await import('../main/hiddenFileCache');

      await mod.isFileHiddenCached('C:\\test\\a.txt', 'a.txt');
      vi.advanceTimersByTime(10);
      await mod.isFileHiddenCached('C:\\test\\b.txt', 'b.txt');
      vi.advanceTimersByTime(10);
      await mod.isFileHiddenCached('C:\\test\\c.txt', 'c.txt');
      vi.advanceTimersByTime(10);

      await mod.isFileHiddenCached('C:\\test\\d.txt', 'd.txt');
      vi.advanceTimersByTime(10);

      await mod.isFileHiddenCached('C:\\test\\e.txt', 'e.txt');
      vi.advanceTimersByTime(10);

      await mod.isFileHiddenCached('C:\\test\\f.txt', 'f.txt');

      const cleanupCalls = consoleSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('Cleaned up')
      );
      expect(cleanupCalls.length).toBeGreaterThanOrEqual(2);

      consoleSpy.mockRestore();
    });
  });

  describe('cleanupHiddenFileCache TTL expiration (lines 46-47)', () => {
    it('removes expired entries during cleanup triggered by cache size', async () => {
      setPlatform('win32');
      vi.useFakeTimers({ now: 1000 });
      execFileMock.mockResolvedValue({
        stdout: '  A          C:\\test\\file.txt\r\n',
      });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mod = await import('../main/hiddenFileCache');

      await mod.isFileHiddenCached('C:\\test\\old1.txt', 'old1.txt');
      vi.advanceTimersByTime(10);
      await mod.isFileHiddenCached('C:\\test\\old2.txt', 'old2.txt');
      vi.advanceTimersByTime(10);
      await mod.isFileHiddenCached('C:\\test\\old3.txt', 'old3.txt');
      vi.advanceTimersByTime(10);

      vi.advanceTimersByTime(300001);

      await mod.isFileHiddenCached('C:\\test\\new1.txt', 'new1.txt');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cleaned up 3 hidden file cache entries')
      );

      consoleSpy.mockRestore();
    });

    it('removes only expired entries and keeps fresh ones', async () => {
      setPlatform('win32');
      vi.useFakeTimers({ now: 1000 });
      execFileMock.mockResolvedValue({
        stdout: '  A          C:\\test\\file.txt\r\n',
      });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mod = await import('../main/hiddenFileCache');

      await mod.isFileHiddenCached('C:\\test\\old1.txt', 'old1.txt');
      vi.advanceTimersByTime(10);
      await mod.isFileHiddenCached('C:\\test\\old2.txt', 'old2.txt');

      vi.advanceTimersByTime(300001);

      await mod.isFileHiddenCached('C:\\test\\fresh.txt', 'fresh.txt');
      vi.advanceTimersByTime(10);

      await mod.isFileHiddenCached('C:\\test\\newest.txt', 'newest.txt');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cleaned up 2 hidden file cache entries')
      );

      execFileMock.mockClear();
      const result = await mod.isFileHiddenCached('C:\\test\\fresh.txt', 'fresh.txt');
      expect(result).toBe(false);
      expect(execFileMock).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('expired entries removed via interval timer', async () => {
      setPlatform('win32');
      vi.useFakeTimers({ now: 1000 });
      execFileMock.mockResolvedValue({
        stdout: '  A          C:\\test\\file.txt\r\n',
      });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mod = await import('../main/hiddenFileCache');

      await mod.isFileHiddenCached('C:\\test\\a.txt', 'a.txt');
      vi.advanceTimersByTime(10);
      await mod.isFileHiddenCached('C:\\test\\b.txt', 'b.txt');

      mod.startHiddenFileCacheCleanup();

      vi.advanceTimersByTime(300001 + 5 * 60 * 1000);

      const cleanupCalls = consoleSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('Cleaned up')
      );
      expect(cleanupCalls.length).toBeGreaterThanOrEqual(1);

      mod.stopHiddenFileCacheCleanup();
      consoleSpy.mockRestore();
    });
  });

  describe('isFileHiddenCached on non-win32', () => {
    it('returns true for dotfiles', async () => {
      setPlatform('linux');
      const mod = await import('../main/hiddenFileCache');
      const result = await mod.isFileHiddenCached('/home/user/.bashrc', '.bashrc');
      expect(result).toBe(true);
    });

    it('returns false for non-dotfiles', async () => {
      setPlatform('linux');
      const mod = await import('../main/hiddenFileCache');
      const result = await mod.isFileHiddenCached('/home/user/file.txt', 'file.txt');
      expect(result).toBe(false);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  describe('cleanup interval', () => {
    it('starts and stops cleanup without errors', async () => {
      vi.useFakeTimers();
      const mod = await import('../main/hiddenFileCache');

      mod.startHiddenFileCacheCleanup();
      mod.startHiddenFileCacheCleanup();

      vi.advanceTimersByTime(5 * 60 * 1000 + 100);

      mod.stopHiddenFileCacheCleanup();
      mod.stopHiddenFileCacheCleanup();
    });

    it('cleanup is a no-op when cache is empty', async () => {
      vi.useFakeTimers();
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const mod = await import('../main/hiddenFileCache');

      mod.startHiddenFileCacheCleanup();
      vi.advanceTimersByTime(5 * 60 * 1000 + 100);

      const cleanupCalls = consoleSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('Cleaned up')
      );
      expect(cleanupCalls.length).toBe(0);

      mod.stopHiddenFileCacheCleanup();
      consoleSpy.mockRestore();
    });

    it('stopHiddenFileCacheCleanup clears the cache', async () => {
      setPlatform('win32');
      execFileMock.mockResolvedValue({
        stdout: '  A  H       C:\\test\\file.txt\r\n',
      });
      const mod = await import('../main/hiddenFileCache');

      await mod.isFileHiddenCached('C:\\test\\file.txt', 'file.txt');

      mod.stopHiddenFileCacheCleanup();
      execFileMock.mockClear();
      execFileMock.mockResolvedValueOnce({
        stdout: '  A          C:\\test\\file.txt\r\n',
      });

      const result = await mod.isFileHiddenCached('C:\\test\\file.txt', 'file.txt');
      expect(result).toBe(false);
      expect(execFileMock).toHaveBeenCalled();
    });
  });

  describe('cache staleness', () => {
    it('re-queries when cached entry expires', async () => {
      setPlatform('win32');
      vi.useFakeTimers({ now: 1000 });
      execFileMock.mockResolvedValue({
        stdout: '  A  H       C:\\test\\file.txt\r\n',
      });

      const mod = await import('../main/hiddenFileCache');

      const first = await mod.isFileHiddenCached('C:\\test\\file.txt', 'file.txt');
      expect(first).toBe(true);
      expect(execFileMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(300001);
      execFileMock.mockClear();
      execFileMock.mockResolvedValueOnce({
        stdout: '  A          C:\\test\\file.txt\r\n',
      });

      const second = await mod.isFileHiddenCached('C:\\test\\file.txt', 'file.txt');
      expect(second).toBe(false);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });
  });
});
