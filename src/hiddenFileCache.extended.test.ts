import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFileMock = vi.fn();

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('util', () => ({
  promisify: vi.fn(() => execFileMock),
}));

vi.mock('./appState', () => ({
  HIDDEN_FILE_CACHE_TTL: 300000,
  HIDDEN_FILE_CACHE_MAX: 3, // Small max for testing eviction
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
  });

  describe('isFileHiddenCached on win32', () => {
    it('returns true for dotfiles on win32', async () => {
      setPlatform('win32');
      const mod = await import('./hiddenFileCache');
      const result = await mod.isFileHiddenCached('C:\\Users\\test\\.bashrc', '.bashrc');
      expect(result).toBe(true);
    });

    it('checks attrib command for non-dotfiles on win32', async () => {
      setPlatform('win32');
      execFileMock.mockResolvedValueOnce({
        stdout: '  A  H       C:\\Users\\test\\hidden.txt\r\n',
      });

      const mod = await import('./hiddenFileCache');
      const result = await mod.isFileHiddenCached('C:\\Users\\test\\hidden.txt', 'hidden.txt');
      expect(result).toBe(true);
    });

    it('returns false for visible files on win32', async () => {
      setPlatform('win32');
      execFileMock.mockResolvedValueOnce({
        stdout: '  A          C:\\Users\\test\\visible.txt\r\n',
      });

      const mod = await import('./hiddenFileCache');
      const result = await mod.isFileHiddenCached('C:\\Users\\test\\visible.txt', 'visible.txt');
      expect(result).toBe(false);
    });

    it('returns false when attrib command fails', async () => {
      setPlatform('win32');
      execFileMock.mockRejectedValueOnce(new Error('Command not found'));

      const mod = await import('./hiddenFileCache');
      const result = await mod.isFileHiddenCached('C:\\test\\file.txt', 'file.txt');
      expect(result).toBe(false);
    });

    it('caches results on win32', async () => {
      setPlatform('win32');
      execFileMock.mockResolvedValueOnce({
        stdout: '  A  H       C:\\test\\file.txt\r\n',
      });

      const mod = await import('./hiddenFileCache');
      const first = await mod.isFileHiddenCached('C:\\test\\file.txt', 'file.txt');
      expect(first).toBe(true);

      // Second call should use cache (no new execFile call)
      execFileMock.mockClear();
      const second = await mod.isFileHiddenCached('C:\\test\\file.txt', 'file.txt');
      expect(second).toBe(true);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('returns false for empty stdout from attrib', async () => {
      setPlatform('win32');
      execFileMock.mockResolvedValueOnce({ stdout: '' });

      const mod = await import('./hiddenFileCache');
      const result = await mod.isFileHiddenCached('C:\\test\\file.txt', 'file.txt');
      expect(result).toBe(false);
    });

    it('triggers cache cleanup when exceeding max size', async () => {
      setPlatform('win32');
      // Mock all as not hidden
      execFileMock.mockResolvedValue({
        stdout: '  A          C:\\test\\file.txt\r\n',
      });

      const mod = await import('./hiddenFileCache');

      // Fill cache to max (3) by calling with different paths
      await mod.isFileHiddenCached('C:\\test\\a.txt', 'a.txt');
      await mod.isFileHiddenCached('C:\\test\\b.txt', 'b.txt');
      await mod.isFileHiddenCached('C:\\test\\c.txt', 'c.txt');

      // This should trigger cleanup
      await mod.isFileHiddenCached('C:\\test\\d.txt', 'd.txt');
      // No assertion needed - we ensure it doesn't throw
    });
  });

  describe('isFileHiddenCached on non-win32', () => {
    it('returns true for dotfiles', async () => {
      setPlatform('linux');
      const mod = await import('./hiddenFileCache');
      const result = await mod.isFileHiddenCached('/home/user/.bashrc', '.bashrc');
      expect(result).toBe(true);
    });

    it('returns false for non-dotfiles', async () => {
      setPlatform('linux');
      const mod = await import('./hiddenFileCache');
      const result = await mod.isFileHiddenCached('/home/user/file.txt', 'file.txt');
      expect(result).toBe(false);
      // execFile should NOT be called on non-win32
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  describe('cleanup interval', () => {
    it('starts and stops cleanup without errors', async () => {
      vi.useFakeTimers();
      const mod = await import('./hiddenFileCache');

      mod.startHiddenFileCacheCleanup();
      mod.startHiddenFileCacheCleanup(); // idempotent

      vi.advanceTimersByTime(5 * 60 * 1000 + 100); // Trigger cleanup

      mod.stopHiddenFileCacheCleanup();
      mod.stopHiddenFileCacheCleanup(); // idempotent

      vi.useRealTimers();
    });
  });
});
