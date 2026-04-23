import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDiskSpaceController, type DiskSpaceControllerDeps } from '../rendererDiskSpace';
import { devLog, escapeHtml } from '../shared.js';

vi.mock('../rendererUtils.js', () => ({
  twemojiImg: vi.fn((emoji: string) => `<img alt="${emoji}" />`),
}));

vi.mock('../shared.js', () => ({
  devLog: vi.fn(),
  escapeHtml: vi.fn((s: string) => s),
}));

function makeDeps(overrides: Partial<DiskSpaceControllerDeps> = {}): DiskSpaceControllerDeps {
  return {
    getCurrentPath: vi.fn(() => '/home/user'),
    getPlatformOS: vi.fn(() => 'linux'),
    formatFileSize: vi.fn((b: number) => `${(b / 1e9).toFixed(1)} GB`),
    isHomeViewPath: vi.fn(() => false),
    getDiskSpace: vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 }),
    ...overrides,
  };
}

describe('createDiskSpaceController', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('getUnixDrivePath (via getCachedDiskSpace & clearCache)', () => {
    let deps: DiskSpaceControllerDeps;
    let ctrl: ReturnType<typeof createDiskSpaceController>;

    beforeEach(() => {
      vi.clearAllMocks();
      deps = makeDeps();
      ctrl = createDiskSpaceController(deps);
    });

    it('creates controller with expected methods', () => {
      expect(ctrl.updateDiskSpace).toBeTypeOf('function');
      expect(ctrl.getCachedDiskSpace).toBeTypeOf('function');
      expect(ctrl.clearCache).toBeTypeOf('function');
    });

    it('getCachedDiskSpace returns null for uncached path', () => {
      expect(ctrl.getCachedDiskSpace('/')).toBeNull();
    });

    it('clearCache resets state', () => {
      ctrl.clearCache();
      expect(ctrl.getCachedDiskSpace('/')).toBeNull();
    });
  });

  describe('getUnixDrivePath logic', () => {
    it('resolves / for regular unix paths', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => '/home/user/Documents',
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();

      await vi.advanceTimersByTimeAsync(400);

      expect(getDiskSpace).toHaveBeenCalledWith('/');
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('resolves /Volumes/DiskName for macOS volumes', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => '/Volumes/MyDrive/folder/subfolder',
        getPlatformOS: () => 'darwin',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      expect(getDiskSpace).toHaveBeenCalledWith('/Volumes/MyDrive');
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('resolves /media/user/drive for linux mounted drives', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => '/media/user/USB/Documents',
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      expect(getDiskSpace).toHaveBeenCalledWith('/media/user');
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('resolves /mnt/data for /mnt paths', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => '/mnt/data/files',
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      expect(getDiskSpace).toHaveBeenCalledWith('/mnt/data');
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('resolves /run/media/user/drive for /run/media paths', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => '/run/media/user/USB/stuff',
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      expect(getDiskSpace).toHaveBeenCalledWith('/run/media/user/USB');
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('uses root mount path when path is exactly /Volumes', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => '/Volumes',
        getPlatformOS: () => 'darwin',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      expect(getDiskSpace).toHaveBeenCalledWith('/Volumes');
    });
  });

  describe('getWindowsDrivePath logic', () => {
    it('resolves C:\\ for regular windows paths', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => 'C:\\Users\\admin\\Documents',
        getPlatformOS: () => 'win32',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      expect(getDiskSpace).toHaveBeenCalledWith('C:\\');
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('resolves UNC path for network shares', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => '\\\\server\\share\\folder',
        getPlatformOS: () => 'win32',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      expect(getDiskSpace).toHaveBeenCalledWith('\\\\server\\share\\');
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('keeps short UNC path when server/share are incomplete', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => '\\\\server',
        getPlatformOS: () => 'win32',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      expect(getDiskSpace).toHaveBeenCalledWith('\\\\server');
    });
  });

  describe('caching', () => {
    it('caches disk space and returns from cache', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => '/home/user',
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);
      expect(getDiskSpace).toHaveBeenCalledTimes(1);

      const cached = ctrl.getCachedDiskSpace('/');
      expect(cached).toEqual({ total: 1e12, free: 5e11 });

      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('uses cached value on second update without another disk call', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1000, free: 750 });
      const deps = makeDeps({
        getCurrentPath: () => '/home/user',
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);
      expect(getDiskSpace).toHaveBeenCalledTimes(1);

      await ctrl.updateDiskSpace();
      expect(getDiskSpace).toHaveBeenCalledTimes(1);
      expect(mockElement.innerHTML).toContain('free of');
    });

    it('expires cached entries after TTL', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => '/home/user',
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);
      expect(ctrl.getCachedDiskSpace('/')).toEqual({ total: 1e12, free: 5e11 });

      vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
      expect(ctrl.getCachedDiskSpace('/')).toBeNull();
    });

    it('evicts oldest cache entry when cache reaches max size', async () => {
      vi.useFakeTimers();
      let currentPath = '\\\\srv0\\share\\folder';
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => currentPath,
        getPlatformOS: () => 'win32',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      for (let i = 0; i < 51; i++) {
        currentPath = `\\\\srv${i}\\share\\folder`;
        await ctrl.updateDiskSpace();
        await vi.advanceTimersByTimeAsync(400);
      }

      expect(ctrl.getCachedDiskSpace('\\\\srv0\\share\\')).toBeNull();
      expect(ctrl.getCachedDiskSpace('\\\\srv50\\share\\')).toEqual({ total: 1e12, free: 5e11 });
    });

    it('clears cache on clearCache()', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => '/home/user',
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      ctrl.clearCache();
      expect(ctrl.getCachedDiskSpace('/')).toBeNull();

      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('clearCache cancels pending debounce timer', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => '/home/user',
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      ctrl.clearCache();
      await vi.advanceTimersByTimeAsync(400);

      expect(getDiskSpace).not.toHaveBeenCalled();
    });
  });

  describe('skips update', () => {
    it('does nothing when isHomeViewPath returns true', async () => {
      const getDiskSpace = vi.fn();
      const deps = makeDeps({
        isHomeViewPath: vi.fn(() => true),
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      vi.stubGlobal('document', {
        getElementById: vi.fn(() => ({ innerHTML: '' })),
      });

      await ctrl.updateDiskSpace();
      expect(getDiskSpace).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it('does nothing when no statusDiskSpace element', async () => {
      const getDiskSpace = vi.fn();
      const deps = makeDeps({ getDiskSpace });
      const ctrl = createDiskSpaceController(deps);

      vi.stubGlobal('document', {
        getElementById: vi.fn(() => null),
      });

      await ctrl.updateDiskSpace();
      expect(getDiskSpace).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it('does nothing when current path is empty', async () => {
      const getDiskSpace = vi.fn();
      const deps = makeDeps({
        getCurrentPath: () => '',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      vi.stubGlobal('document', {
        getElementById: vi.fn(() => ({ innerHTML: '' })),
      });

      await ctrl.updateDiskSpace();
      expect(getDiskSpace).not.toHaveBeenCalled();
    });
  });

  describe('updateDiskSpace debounce and async behavior', () => {
    it('skips duplicate pending request for the same drive path', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => '/home/user/Documents',
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);
      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      expect(getDiskSpace).toHaveBeenCalledTimes(1);
    });

    it('cancels previous debounce when drive path changes', async () => {
      vi.useFakeTimers();
      let currentPath = '/home/user/Documents';
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => currentPath,
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);
      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      currentPath = '/mnt/data/files';
      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      expect(getDiskSpace).toHaveBeenCalledTimes(1);
      expect(getDiskSpace).toHaveBeenCalledWith('/mnt/data');
    });

    it('ignores stale async result when current drive has changed', async () => {
      vi.useFakeTimers();
      let currentPath = '/home/user/Documents';
      let resolveFirst:
        | ((value: { success: boolean; total: number; free: number }) => void)
        | null = null;
      const firstResult = new Promise<{ success: boolean; total: number; free: number }>(
        (resolve) => {
          resolveFirst = resolve;
        }
      );
      const getDiskSpace = vi
        .fn()
        .mockImplementationOnce(() => firstResult)
        .mockResolvedValueOnce({ success: true, total: 2e12, free: 1e12 });
      const deps = makeDeps({
        getCurrentPath: () => currentPath,
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);
      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(300);

      currentPath = '/mnt/data/files';
      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(300);
      const htmlAfterFreshResult = mockElement.innerHTML;

      resolveFirst?.({ success: true, total: 1e12, free: 5e11 });
      await Promise.resolve();
      await Promise.resolve();

      expect(mockElement.innerHTML).toBe(htmlAfterFreshResult);
    });

    it('handles missing status element in async callback without throwing', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 1e12, free: 5e11 });
      const deps = makeDeps({
        getCurrentPath: () => '/home/user/Documents',
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);
      const mockElement = { innerHTML: '' } as any;
      const getElementById = vi
        .fn()
        .mockReturnValueOnce(mockElement)
        .mockReturnValueOnce(null as unknown as HTMLElement);
      vi.stubGlobal('document', { getElementById });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      expect(getDiskSpace).toHaveBeenCalledTimes(1);
      expect(mockElement.innerHTML).toBe('');
    });
  });

  describe('unavailable and error states', () => {
    it('renders generic unavailable message when disk query fails', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: false });
      const deps = makeDeps({
        getCurrentPath: () => '/home/user/Documents',
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      expect(mockElement.innerHTML).toContain('Disk space unavailable');
    });

    it('renders network-share unavailable message for UNC paths', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: false });
      const deps = makeDeps({
        getCurrentPath: () => '\\\\server\\share\\folder',
        getPlatformOS: () => 'win32',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      expect(mockElement.innerHTML).toContain('Disk space unavailable for network share');
    });

    it('treats zero-total response as unavailable', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockResolvedValue({ success: true, total: 0, free: 0 });
      const deps = makeDeps({
        getCurrentPath: () => '/home/user/Documents',
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      expect(mockElement.innerHTML).toContain('Disk space unavailable');
    });

    it('logs when getDiskSpace throws', async () => {
      vi.useFakeTimers();
      const getDiskSpace = vi.fn().mockRejectedValue(new Error('disk failure'));
      const deps = makeDeps({
        getCurrentPath: () => '/home/user/Documents',
        getPlatformOS: () => 'linux',
        getDiskSpace,
      });
      const ctrl = createDiskSpaceController(deps);

      const mockElement = { innerHTML: '' } as any;
      vi.stubGlobal('document', {
        getElementById: vi.fn(() => mockElement),
      });

      await ctrl.updateDiskSpace();
      await vi.advanceTimersByTimeAsync(400);

      expect(devLog).toHaveBeenCalledWith('DiskSpace', 'updateDiskSpace failed', expect.any(Error));
    });
  });

  describe('renderDiskSpace', () => {
    it('renders disk space HTML to element', () => {
      const deps = makeDeps();
      const ctrl = createDiskSpaceController(deps);
      const mockElement = { innerHTML: '' } as any;

      ctrl.renderDiskSpace(mockElement, 1e12, 5e11);
      expect(mockElement.innerHTML).toContain('free of');
      expect(mockElement.innerHTML).toContain('status-disk-meter-fill');
    });

    it('uses warning state when usage > 80%', () => {
      const deps = makeDeps();
      const ctrl = createDiskSpaceController(deps);
      const mockElement = { innerHTML: '' } as any;

      ctrl.renderDiskSpace(mockElement, 1000, 150);
      expect(mockElement.innerHTML).toContain('status-disk-meter-fill warning');
    });

    it('uses critical state when usage > 90%', () => {
      const deps = makeDeps();
      const ctrl = createDiskSpaceController(deps);
      const mockElement = { innerHTML: '' } as any;

      ctrl.renderDiskSpace(mockElement, 1000, 50);
      expect(mockElement.innerHTML).toContain('status-disk-meter-fill critical');
    });

    it('uses healthy state when usage <= 80%', () => {
      const deps = makeDeps();
      const ctrl = createDiskSpaceController(deps);
      const mockElement = { innerHTML: '' } as any;

      ctrl.renderDiskSpace(mockElement, 1000, 250);
      expect(mockElement.innerHTML).toContain('status-disk-meter-fill healthy');
    });
  });

  describe('renderDiskSpaceUnavailable', () => {
    it('renders unavailable message', () => {
      const deps = makeDeps();
      const ctrl = createDiskSpaceController(deps);
      const mockElement = { innerHTML: '' } as any;

      ctrl.renderDiskSpaceUnavailable(mockElement, 'Disk space unavailable');
      expect(mockElement.innerHTML).toContain('Disk space unavailable');
    });

    it('escapes unavailable message content', () => {
      const deps = makeDeps();
      const ctrl = createDiskSpaceController(deps);
      const mockElement = { innerHTML: '' } as any;

      ctrl.renderDiskSpaceUnavailable(mockElement, '<bad>');

      expect(escapeHtml).toHaveBeenCalledWith('<bad>');
    });
  });
});
