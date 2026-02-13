import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockApp = vi.hoisted(() => ({
  isPackaged: false,
  getVersion: () => '1.0.0',
  getName: () => 'test-app',
  getPath: (_name: string) => '/tmp/test',
  getAppPath: () => '/tmp/test',
  isReady: () => true,
  on: vi.fn(),
  once: vi.fn(),
  whenReady: () => Promise.resolve(),
}));

const mockExec = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn(() => false));
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('electron', () => ({
  app: mockApp,
}));

vi.mock('child_process', () => ({
  exec: mockExec,
}));

vi.mock('fs', () => ({
  default: { existsSync: mockExistsSync },
  existsSync: mockExistsSync,
}));

vi.mock('../utils/logger', () => ({
  logger: mockLogger,
}));

const originalPlatform = process.platform;
const originalEnv = { ...process.env };

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('platformUtils extended', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockApp.isPackaged = false;
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    process.env = { ...originalEnv };
  });

  describe('getAutoUpdater', () => {
    it('loads electron-updater module (throws in test env without real Electron)', async () => {
      const { getAutoUpdater } = await import('../platformUtils');

      expect(() => getAutoUpdater()).toThrow();
    });
  });

  describe('get7zipBin', () => {
    it('lazy-loads 7zip-bin and returns module with path7za', async () => {
      const { get7zipBin } = await import('../platformUtils');
      const result = get7zipBin();
      expect(result).toBeDefined();
      expect(typeof result.path7za).toBe('string');
    });

    it('returns same module on subsequent calls (cached)', async () => {
      const { get7zipBin } = await import('../platformUtils');
      const first = get7zipBin();
      const second = get7zipBin();
      expect(first).toBe(second);
    });
  });

  describe('get7zipModule', () => {
    it('lazy-loads node-7z and returns the module with expected methods', async () => {
      const { get7zipModule } = await import('../platformUtils');
      const result = get7zipModule();
      expect(result).toBeDefined();
      expect(typeof result.list).toBe('function');
      expect(typeof result.add).toBe('function');
      expect(typeof result.extractFull).toBe('function');
    });

    it('returns same module on subsequent calls (cached)', async () => {
      const { get7zipModule } = await import('../platformUtils');
      const first = get7zipModule();
      const second = get7zipModule();
      expect(first).toBe(second);
    });
  });

  describe('isRunningInFlatpak', () => {
    it('returns true when FLATPAK_ID env var is set', async () => {
      process.env.FLATPAK_ID = 'com.example.app';
      const mod = await import('../platformUtils');
      expect(mod.isRunningInFlatpak()).toBe(true);
    });

    it('returns true when /.flatpak-info exists', async () => {
      delete process.env.FLATPAK_ID;
      mockExistsSync.mockReturnValue(true);
      const mod = await import('../platformUtils');
      expect(mod.isRunningInFlatpak()).toBe(true);
    });

    it('returns false when neither indicator is present', async () => {
      delete process.env.FLATPAK_ID;
      mockExistsSync.mockReturnValue(false);
      const mod = await import('../platformUtils');
      expect(mod.isRunningInFlatpak()).toBe(false);
    });

    it('caches the result after first call', async () => {
      delete process.env.FLATPAK_ID;
      mockExistsSync.mockReturnValue(false);
      const mod = await import('../platformUtils');
      mod.isRunningInFlatpak();
      mockExistsSync.mockReturnValue(true);

      expect(mod.isRunningInFlatpak()).toBe(false);
    });
  });

  describe('checkMsiInstallation', () => {
    it('returns false on non-win32', async () => {
      setPlatform('linux');
      const mod = await import('../platformUtils');
      const result = await mod.checkMsiInstallation();
      expect(result).toBe(false);
    });

    it('returns true when registry key is found on win32', async () => {
      setPlatform('win32');
      mockExec.mockImplementation(
        (_cmd: string, _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
          callback(null, 'InstalledViaMsi    REG_DWORD    0x1');
        }
      );
      const mod = await import('../platformUtils');
      const result = await mod.checkMsiInstallation();
      expect(result).toBe(true);
    });

    it('returns false when registry key is not found on win32', async () => {
      setPlatform('win32');
      mockExec.mockImplementation(
        (_cmd: string, _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
          callback(new Error('Not found'), '');
        }
      );
      const mod = await import('../platformUtils');
      const result = await mod.checkMsiInstallation();
      expect(result).toBe(false);
    });

    it('returns false when stdout has InstalledViaMsi but not 0x1', async () => {
      setPlatform('win32');
      mockExec.mockImplementation(
        (_cmd: string, _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
          callback(null, 'InstalledViaMsi    REG_DWORD    0x0');
        }
      );
      const mod = await import('../platformUtils');
      const result = await mod.checkMsiInstallation();
      expect(result).toBe(false);
    });

    it('caches the promise to avoid duplicate exec calls', async () => {
      setPlatform('win32');
      let callCount = 0;
      mockExec.mockImplementation(
        (_cmd: string, _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
          callCount++;
          callback(null, 'InstalledViaMsi    REG_DWORD    0x1');
        }
      );
      const mod = await import('../platformUtils');
      await mod.checkMsiInstallation();
      await mod.checkMsiInstallation();
      expect(callCount).toBe(1);
    });

    it('returns cached result when msiCheckResult is already set', async () => {
      setPlatform('win32');
      mockExec.mockImplementation(
        (_cmd: string, _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
          callback(null, 'InstalledViaMsi    REG_DWORD    0x1');
        }
      );
      const mod = await import('../platformUtils');
      await mod.checkMsiInstallation();
      mockExec.mockClear();

      const result = await mod.checkMsiInstallation();
      expect(result).toBe(true);
      expect(mockExec).not.toHaveBeenCalled();
    });
  });

  describe('isInstalledViaMsi', () => {
    it('returns false when msiCheckResult is null (never checked)', async () => {
      const mod = await import('../platformUtils');
      expect(mod.isInstalledViaMsi()).toBe(false);
    });

    it('returns true after successful MSI check on win32', async () => {
      setPlatform('win32');
      mockExec.mockImplementation(
        (_cmd: string, _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
          callback(null, 'InstalledViaMsi    REG_DWORD    0x1');
        }
      );
      const mod = await import('../platformUtils');
      await mod.checkMsiInstallation();
      expect(mod.isInstalledViaMsi()).toBe(true);
    });

    it('returns false after failed MSI check on win32', async () => {
      setPlatform('win32');
      mockExec.mockImplementation(
        (_cmd: string, _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
          callback(new Error('fail'), '');
        }
      );
      const mod = await import('../platformUtils');
      await mod.checkMsiInstallation();
      expect(mod.isInstalledViaMsi()).toBe(false);
    });
  });

  describe('get7zipPath', () => {
    it('returns a string path when not packaged', async () => {
      mockApp.isPackaged = false;

      const { get7zipPath } = await import('../platformUtils');
      const result = get7zipPath();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(mockLogger.debug).toHaveBeenCalledWith('[7zip] Using path:', result);
    });

    it('executes app.asar replacement logic when packaged', async () => {
      mockApp.isPackaged = true;

      const { get7zipPath } = await import('../platformUtils');
      const result = get7zipPath();
      expect(typeof result).toBe('string');

      expect(result).not.toContain('app.asar');
      expect(mockLogger.debug).toHaveBeenCalledWith('[7zip] Using path:', result);
    });

    it('returns cached path on subsequent calls without recomputing', async () => {
      mockApp.isPackaged = false;

      const { get7zipPath } = await import('../platformUtils');
      const first = get7zipPath();
      mockLogger.debug.mockClear();
      const second = get7zipPath();
      expect(second).toBe(first);

      expect(mockLogger.debug).not.toHaveBeenCalled();
    });
  });
});
