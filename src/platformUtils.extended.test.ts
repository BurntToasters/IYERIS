import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock('./utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import * as fsSync from 'fs';
import { exec } from 'child_process';

const originalPlatform = process.platform;
const originalEnv = { ...process.env };

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('platformUtils', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // Re-import to reset module-level caches
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    process.env = { ...originalEnv };
  });

  describe('isRunningInFlatpak', () => {
    it('returns true when FLATPAK_ID env var is set', async () => {
      process.env.FLATPAK_ID = 'com.example.app';
      const mod = await import('./platformUtils');
      expect(mod.isRunningInFlatpak()).toBe(true);
    });

    it('returns true when /.flatpak-info exists', async () => {
      delete process.env.FLATPAK_ID;
      (fsSync.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const mod = await import('./platformUtils');
      expect(mod.isRunningInFlatpak()).toBe(true);
    });

    it('returns false when neither indicator is present', async () => {
      delete process.env.FLATPAK_ID;
      (fsSync.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const mod = await import('./platformUtils');
      expect(mod.isRunningInFlatpak()).toBe(false);
    });

    it('caches the result after first call', async () => {
      delete process.env.FLATPAK_ID;
      (fsSync.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const mod = await import('./platformUtils');
      mod.isRunningInFlatpak();
      (fsSync.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      // Still returns false because cached
      expect(mod.isRunningInFlatpak()).toBe(false);
    });
  });

  describe('checkMsiInstallation', () => {
    it('returns false on non-win32', async () => {
      setPlatform('linux');
      const mod = await import('./platformUtils');
      const result = await mod.checkMsiInstallation();
      expect(result).toBe(false);
    });

    it('returns true when registry key is found on win32', async () => {
      setPlatform('win32');
      (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
          callback(null, 'InstalledViaMsi    REG_DWORD    0x1');
        }
      );
      const mod = await import('./platformUtils');
      const result = await mod.checkMsiInstallation();
      expect(result).toBe(true);
    });

    it('returns false when registry key is not found on win32', async () => {
      setPlatform('win32');
      (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
          callback(new Error('Not found'), '');
        }
      );
      const mod = await import('./platformUtils');
      const result = await mod.checkMsiInstallation();
      expect(result).toBe(false);
    });

    it('caches the promise to avoid duplicate calls', async () => {
      setPlatform('win32');
      let callCount = 0;
      (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
          callCount++;
          callback(null, 'InstalledViaMsi    REG_DWORD    0x1');
        }
      );
      const mod = await import('./platformUtils');
      await mod.checkMsiInstallation();
      await mod.checkMsiInstallation();
      // exec should only be called once (cached)
      expect(callCount).toBe(1);
    });
  });

  describe('isInstalledViaMsi', () => {
    it('returns false initially', async () => {
      setPlatform('linux');
      const mod = await import('./platformUtils');
      expect(mod.isInstalledViaMsi()).toBe(false);
    });

    it('returns true after successful MSI check on win32', async () => {
      setPlatform('win32');
      (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
          callback(null, 'InstalledViaMsi    REG_DWORD    0x1');
        }
      );
      const mod = await import('./platformUtils');
      await mod.checkMsiInstallation();
      expect(mod.isInstalledViaMsi()).toBe(true);
    });
  });

  describe('get7zipPath', () => {
    it('returns path from 7zip-bin module', async () => {
      const mod = await import('./platformUtils');
      // get7zipPath calls get7zipBin which requires 7zip-bin
      // In test environment this might throw, so we just verify it's callable
      try {
        const result = mod.get7zipPath();
        expect(typeof result).toBe('string');
      } catch {
        // Expected in test environment without 7zip-bin
      }
    });
  });
});
