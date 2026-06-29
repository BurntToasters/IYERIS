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
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));

describe('tauri-api regressions', () => {
  beforeEach(() => {
    vi.resetModules();
    mockInvoke.mockReset();
    mockListen.mockResolvedValue(() => {});
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
});
