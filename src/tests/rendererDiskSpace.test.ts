import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDiskSpaceController, type DiskSpaceControllerDeps } from '../rendererDiskSpace';

vi.mock('../rendererUtils.js', () => ({
  twemojiImg: vi.fn((emoji: string) => `<img alt="${emoji}" />`),
}));

vi.mock('../shared.js', () => ({
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
  });

  describe('renderDiskSpace', () => {
    it('renders disk space HTML to element', () => {
      const deps = makeDeps();
      const ctrl = createDiskSpaceController(deps);
      const mockElement = { innerHTML: '' } as any;

      ctrl.renderDiskSpace(mockElement, 1e12, 5e11);
      expect(mockElement.innerHTML).toContain('free of');
    });

    it('uses orange color when usage > 80%', () => {
      const deps = makeDeps();
      const ctrl = createDiskSpaceController(deps);
      const mockElement = { innerHTML: '' } as any;

      ctrl.renderDiskSpace(mockElement, 1000, 150);
      expect(mockElement.innerHTML).toContain('#ff8c00');
    });

    it('uses red color when usage > 90%', () => {
      const deps = makeDeps();
      const ctrl = createDiskSpaceController(deps);
      const mockElement = { innerHTML: '' } as any;

      ctrl.renderDiskSpace(mockElement, 1000, 50);
      expect(mockElement.innerHTML).toContain('#e81123');
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
  });
});
