// @vitest-environment jsdom
/**
 * Regression tests for tauri-api.ts.
 * M6: getClipboard() must resolve to null on IPC failure instead of
 *     rejecting — a rejection was crashing the entire startup Promise.all,
 *     preventing the app from loading.
 * N11: getCachedThumbnail and saveCachedThumbnail must pass mtime_ms +
 *      file_size so the cache key is content-sensitive and both sides derive
 *      byte-identical keys.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.hoisted(() => vi.fn());
const mockListen = vi.hoisted(() => vi.fn());
const mockUpdaterCheck = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mockListen }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: vi.fn(),
}));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(false),
  requestPermission: vi.fn().mockResolvedValue('denied'),
  sendNotification: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn(), exit: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mockUpdaterCheck }));

describe('tauri-api regressions', () => {
  beforeEach(() => {
    vi.resetModules();
    mockInvoke.mockReset();
    mockListen.mockResolvedValue(() => {});
    mockUpdaterCheck.mockReset();
    mockUpdaterCheck.mockResolvedValue(null);
  });

  // M6 -----------------------------------------------------------------------
  describe('M6 — getClipboard resolves null instead of rejecting', () => {
    it('returns null when get_clipboard IPC call rejects', async () => {
      mockInvoke.mockRejectedValue(new Error('clipboard IPC error'));
      await import('../tauri-api');
      // Must not throw — must resolve to null.
      await expect(window.tauriAPI.getClipboard()).resolves.toBeNull();
    });

    it('returns clipboard data when get_clipboard succeeds', async () => {
      const data = { operation: 'copy', paths: ['/a'] };
      mockInvoke.mockResolvedValue(data);
      await import('../tauri-api');
      await expect(window.tauriAPI.getClipboard()).resolves.toEqual(data);
    });
  });

  // N11 ----------------------------------------------------------------------
  describe('N11 — getCachedThumbnail passes mtime_ms + file_size to backend', () => {
    it('forwards filePath, mtimeMs, and fileSize to get_cached_thumbnail', async () => {
      mockInvoke.mockResolvedValue(null);
      await import('../tauri-api');

      await window.tauriAPI.getCachedThumbnail('/tmp/photo.png', 1700000000000, 2048);

      const getCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'get_cached_thumbnail');
      expect(getCalls).toHaveLength(1);
      expect(getCalls[0]![1]).toEqual({
        filePath: '/tmp/photo.png',
        mtimeMs: 1700000000000,
        fileSize: 2048,
      });
    });

    it('works without optional mtime/size (undefined is forwarded)', async () => {
      mockInvoke.mockResolvedValue(null);
      await import('../tauri-api');

      await window.tauriAPI.getCachedThumbnail('/tmp/photo.png');

      const getCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'get_cached_thumbnail');
      expect(getCalls[0]![1]).toMatchObject({ filePath: '/tmp/photo.png' });
    });
  });

  describe('N11 — saveCachedThumbnail passes mtime_ms + file_size to backend', () => {
    it('forwards filePath, dataUrl, mtimeMs, and fileSize to save_cached_thumbnail', async () => {
      mockInvoke.mockResolvedValue({ success: true });
      await import('../tauri-api');

      await window.tauriAPI.saveCachedThumbnail(
        '/tmp/photo.png',
        'data:image/png;base64,abc',
        1700000000000,
        2048
      );

      const saveCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'save_cached_thumbnail');
      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0]![1]).toEqual({
        filePath: '/tmp/photo.png',
        dataUrl: 'data:image/png;base64,abc',
        mtimeMs: 1700000000000,
        fileSize: 2048,
      });
    });

    it('getCachedThumbnail and saveCachedThumbnail use the same key arguments — key agreement', async () => {
      // Both callers must supply the same (filePath, mtimeMs, fileSize) tuple so
      // the Rust cache_key() hash is identical for a read immediately after a write.
      mockInvoke.mockResolvedValue(null);
      await import('../tauri-api');

      const filePath = '/images/banner.jpg';
      const mtimeMs = 1699999999123;
      const fileSize = 512000;

      await window.tauriAPI.getCachedThumbnail(filePath, mtimeMs, fileSize);
      mockInvoke.mockResolvedValue({ success: true });
      await window.tauriAPI.saveCachedThumbnail(
        filePath,
        'data:image/jpeg;base64,xyz',
        mtimeMs,
        fileSize
      );

      const getArgs = mockInvoke.mock.calls.find(([cmd]) => cmd === 'get_cached_thumbnail')?.[1];
      const saveArgs = mockInvoke.mock.calls.find(([cmd]) => cmd === 'save_cached_thumbnail')?.[1];

      // Key-determining arguments must be identical.
      expect(getArgs?.filePath).toBe(saveArgs?.filePath);
      expect(getArgs?.mtimeMs).toBe(saveArgs?.mtimeMs);
      expect(getArgs?.fileSize).toBe(saveArgs?.fileSize);
    });
  });

  describe('update check reports the selected channel', () => {
    function mockInstalledVersion(version: string) {
      mockInvoke.mockImplementation(async (command: string) => {
        switch (command) {
          case 'get_app_version':
            return version;
          case 'is_flatpak':
          case 'is_mas':
          case 'is_ms_store':
          case 'is_msi':
            return false;
          case 'get_platform':
            return 'darwin';
          default:
            return null;
        }
      });
    }

    it('returns isBeta when a stable install checks the beta channel', async () => {
      mockInstalledVersion('3.0.4');
      await import('../tauri-api');
      window.tauriAPI.setUpdateChannel('beta');

      const result = await window.tauriAPI.checkForUpdates();

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          hasUpdate: false,
          isBeta: true,
          currentVersion: '3.0.4',
        })
      );
      expect(mockUpdaterCheck).toHaveBeenCalledWith({ target: 'darwin-beta' });
    });

    it('returns stable messaging when a beta install checks the stable channel', async () => {
      mockInstalledVersion('3.0.5-beta.1');
      await import('../tauri-api');
      window.tauriAPI.setUpdateChannel('stable');

      const result = await window.tauriAPI.checkForUpdates();

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          hasUpdate: false,
          isBeta: false,
          currentVersion: '3.0.5-beta.1',
        })
      );
      expect(mockUpdaterCheck).toHaveBeenCalledWith();
    });

    it('keeps a newer update when an older check rejects', async () => {
      mockInstalledVersion('3.0.4');
      let rejectOld!: (error: Error) => void;
      mockUpdaterCheck.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectOld = reject;
          })
      );
      const update = {
        version: '3.0.5',
        body: '',
        close: vi.fn().mockResolvedValue(undefined),
        download: vi.fn().mockResolvedValue(undefined),
      };
      mockUpdaterCheck.mockResolvedValueOnce(update);
      await import('../tauri-api');
      const old = window.tauriAPI.checkForUpdates();
      await vi.waitFor(() => expect(mockUpdaterCheck).toHaveBeenCalledTimes(1));
      await window.tauriAPI.checkForUpdates();
      rejectOld(new Error('old network request failed'));
      await old;
      await expect(window.tauriAPI.downloadUpdate()).resolves.toEqual({ success: true });
      expect(update.download).toHaveBeenCalledTimes(1);
      expect(update.close).not.toHaveBeenCalled();
    });

    it('does not announce readiness at Finished before verification resolves', async () => {
      mockInstalledVersion('3.0.4');
      let resolveDownload!: () => void;
      const verified = new Promise<void>((resolve) => {
        resolveDownload = resolve;
      });
      const update = {
        version: '3.0.5',
        body: '',
        close: vi.fn().mockResolvedValue(undefined),
        download: vi.fn(async (callback: (event: unknown) => void) => {
          callback({ event: 'Finished' });
          await verified;
        }),
        install: vi.fn().mockResolvedValue(undefined),
      };
      mockUpdaterCheck.mockResolvedValue(update);
      await import('../tauri-api');
      const downloaded = vi.fn();
      window.tauriAPI.onUpdateDownloaded(downloaded);
      await window.tauriAPI.checkForUpdates();
      const downloading = window.tauriAPI.downloadUpdate();
      await Promise.resolve();
      expect(downloaded).not.toHaveBeenCalled();
      expect((await window.tauriAPI.installUpdate()).success).toBe(false);
      expect(update.install).not.toHaveBeenCalled();
      resolveDownload();
      await downloading;
      expect(downloaded).toHaveBeenCalledTimes(1);
    });

    it('does not invalidate an in-flight download when a second check arrives', async () => {
      mockInstalledVersion('3.0.4');
      let releaseDownload!: () => void;
      const downloadRelease = new Promise<void>((resolve) => {
        releaseDownload = resolve;
      });
      const update = {
        version: '3.0.5',
        body: '',
        download: vi.fn(async (callback: (event: unknown) => void) => {
          callback({ event: 'Started', data: { contentLength: 10 } });
          await downloadRelease;
          callback({ event: 'Finished', data: {} });
        }),
        install: vi.fn().mockResolvedValue(undefined),
      };
      mockUpdaterCheck.mockResolvedValue(update);
      await import('../tauri-api');

      await expect(window.tauriAPI.checkForUpdates()).resolves.toEqual(
        expect.objectContaining({ hasUpdate: true })
      );
      const downloading = window.tauriAPI.downloadUpdate();
      await Promise.resolve();
      await expect(window.tauriAPI.checkForUpdates()).resolves.toEqual(
        expect.objectContaining({ hasUpdate: true, latestVersion: '3.0.5' })
      );
      releaseDownload();
      await expect(downloading).resolves.toEqual({ success: true });
    });
  });

  describe('search hidden policy', () => {
    it('forwards includeHidden to search_files', async () => {
      mockInvoke.mockResolvedValue([]);
      await import('../tauri-api');
      await window.tauriAPI.searchFiles('/tmp', 'q', undefined, 'op-1', true);
      expect(mockInvoke).toHaveBeenCalledWith(
        'search_files',
        expect.objectContaining({ includeHidden: true, dirPath: '/tmp', query: 'q' })
      );
    });

    it('maps backend isHidden onto search results', async () => {
      mockInvoke.mockResolvedValue([
        {
          name: 'config',
          path: '/repo/.git/config',
          isDirectory: false,
          size: 10,
          modified: 1,
          extension: '',
          isHidden: false,
        },
        {
          name: '.env',
          path: '/repo/.env',
          isDirectory: false,
          size: 4,
          modified: 1,
          extension: 'env',
          isHidden: true,
        },
      ]);
      await import('../tauri-api');
      const result = await window.tauriAPI.searchFiles('/repo', 'e');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.results[0]?.isHidden).toBe(false);
      expect(result.results[1]?.isHidden).toBe(true);
    });
  });
});
