import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
  appGetVersion: vi.fn(() => '1.0.0'),
  appRelaunch: vi.fn(),
  appQuit: vi.fn(),
  appReleaseSingleInstanceLock: vi.fn(),
  getMainWindow: vi.fn(),
  getIsDev: vi.fn(() => false),
  setIsQuitting: vi.fn(),
  getAutoUpdater: vi.fn(),
  isRunningInFlatpak: vi.fn(() => false),
  checkMsiInstallation: vi.fn(() => Promise.resolve(false)),
  isInstalledViaMsi: vi.fn(() => false),
  safeSendToWindow: vi.fn(),
  isTrustedIpcEvent: vi.fn(() => true),
  getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.ipcMainHandle },
  app: {
    getVersion: mocks.appGetVersion,
    relaunch: mocks.appRelaunch,
    quit: mocks.appQuit,
    releaseSingleInstanceLock: mocks.appReleaseSingleInstanceLock,
  },
}));

vi.mock('./appState', () => ({
  getMainWindow: mocks.getMainWindow,
  getIsDev: mocks.getIsDev,
  setIsQuitting: mocks.setIsQuitting,
}));

vi.mock('./platformUtils', () => ({
  getAutoUpdater: mocks.getAutoUpdater,
  isRunningInFlatpak: mocks.isRunningInFlatpak,
  checkMsiInstallation: mocks.checkMsiInstallation,
  isInstalledViaMsi: mocks.isInstalledViaMsi,
}));

vi.mock('./ipcUtils', () => ({
  safeSendToWindow: mocks.safeSendToWindow,
  isTrustedIpcEvent: mocks.isTrustedIpcEvent,
}));

vi.mock('./security', () => ({
  getErrorMessage: mocks.getErrorMessage,
}));

import { compareVersions, setupUpdateHandlers, initializeAutoUpdater } from './updateManager';

describe('compareVersions extended', () => {
  it('handles v prefix', () => {
    expect(compareVersions('v2.0.0', 'v1.0.0')).toBe(1);
    expect(compareVersions('v1.0.0', 'v1.0.0')).toBe(0);
  });

  it('handles build metadata (ignored)', () => {
    expect(compareVersions('1.0.0+build123', '1.0.0+build456')).toBe(0);
  });

  it('numeric prerelease < string prerelease', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-beta')).toBe(-1);
    expect(compareVersions('1.0.0-beta', '1.0.0-1')).toBe(1);
  });

  it('shorter prerelease < longer if prefix matches', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBe(-1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0-beta')).toBe(1);
  });

  it('handles missing minor/patch', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });

  it('handles invalid version strings', () => {
    expect(compareVersions('invalid', 'invalid')).toBe(0);
    expect(compareVersions('invalid', '1.0.0')).toBe(-1);
  });

  it('handles whitespace', () => {
    expect(compareVersions('  1.0.0  ', '1.0.0')).toBe(0);
  });

  it('compares multiple prerelease identifiers', () => {
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.2.1', '1.0.0-alpha.2.0')).toBe(1);
  });
});

describe('setupUpdateHandlers', () => {
  let handlers: Record<string, (...args: any[]) => any>;
  const loadSettings = vi.fn(() => Promise.resolve({ updateChannel: 'auto' } as any));

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = {};
    mocks.ipcMainHandle.mockImplementation((channel: string, handler: (...args: any[]) => any) => {
      handlers[channel] = handler;
    });
    setupUpdateHandlers(loadSettings);
  });

  it('registers all three handlers', () => {
    expect(handlers['check-for-updates']).toBeDefined();
    expect(handlers['download-update']).toBeDefined();
    expect(handlers['install-update']).toBeDefined();
  });

  describe('check-for-updates', () => {
    const event = { sender: { id: 1 } } as any;

    it('rejects untrusted sender', async () => {
      mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
      const result = await handlers['check-for-updates'](event);
      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('detects flatpak environment', async () => {
      mocks.isRunningInFlatpak.mockReturnValueOnce(true);
      mocks.appGetVersion.mockReturnValueOnce('1.0.0');
      const result = await handlers['check-for-updates'](event);
      expect(result.success).toBe(true);
      expect(result.isFlatpak).toBe(true);
    });

    it('detects MAS environment', async () => {
      mocks.isRunningInFlatpak.mockReturnValue(false);
      const origMas = process.mas;
      (process as any).mas = true;
      try {
        const result = await handlers['check-for-updates'](event);
        expect(result.success).toBe(true);
        expect(result.isMas).toBe(true);
      } finally {
        (process as any).mas = origMas;
      }
    });

    it('detects MS Store environment', async () => {
      mocks.isRunningInFlatpak.mockReturnValue(false);
      const origMas = process.mas;
      const origStore = process.windowsStore;
      (process as any).mas = false;
      (process as any).windowsStore = true;
      try {
        const result = await handlers['check-for-updates'](event);
        expect(result.success).toBe(true);
        expect(result.isMsStore).toBe(true);
      } finally {
        (process as any).mas = origMas;
        (process as any).windowsStore = origStore;
      }
    });

    it('detects MSI installation', async () => {
      mocks.isRunningInFlatpak.mockReturnValue(false);
      (process as any).mas = false;
      (process as any).windowsStore = false;
      mocks.checkMsiInstallation.mockResolvedValue(true);
      const result = await handlers['check-for-updates'](event);
      expect(result.success).toBe(true);
      expect(result.isMsi).toBe(true);
    });

    it('checks for updates successfully with newer version', async () => {
      mocks.isRunningInFlatpak.mockReturnValue(false);
      mocks.checkMsiInstallation.mockResolvedValue(false);
      mocks.appGetVersion.mockReturnValue('1.0.0');
      (process as any).mas = false;
      (process as any).windowsStore = false;
      const mockAutoUpdater = {
        channel: '',
        allowPrerelease: false,
        checkForUpdates: vi.fn().mockResolvedValue({
          updateInfo: {
            version: '2.0.0',
            releaseDate: '2025-01-01',
            releaseNotes: 'New features',
          },
        }),
      };
      mocks.getAutoUpdater.mockReturnValue(mockAutoUpdater);
      const result = await handlers['check-for-updates'](event);
      expect(result.success).toBe(true);
      expect(result.hasUpdate).toBe(true);
      expect(result.latestVersion).toBe('v2.0.0');
      expect(result.releaseUrl).toContain('v2.0.0');
    });

    it('returns no update for same version', async () => {
      mocks.isRunningInFlatpak.mockReturnValue(false);
      mocks.checkMsiInstallation.mockResolvedValue(false);
      mocks.appGetVersion.mockReturnValue('1.0.0');
      (process as any).mas = false;
      (process as any).windowsStore = false;
      const mockAutoUpdater = {
        channel: '',
        allowPrerelease: false,
        checkForUpdates: vi.fn().mockResolvedValue({
          updateInfo: { version: '1.0.0', releaseDate: '2025-01-01' },
        }),
      };
      mocks.getAutoUpdater.mockReturnValue(mockAutoUpdater);
      const result = await handlers['check-for-updates'](event);
      expect(result.success).toBe(true);
      expect(result.hasUpdate).toBe(false);
    });

    it('handles null checkForUpdates result', async () => {
      mocks.isRunningInFlatpak.mockReturnValue(false);
      mocks.checkMsiInstallation.mockResolvedValue(false);
      (process as any).mas = false;
      (process as any).windowsStore = false;
      mocks.getAutoUpdater.mockReturnValue({
        channel: '',
        allowPrerelease: false,
        checkForUpdates: vi.fn().mockResolvedValue(null),
      });
      const result = await handlers['check-for-updates'](event);
      expect(result).toEqual({ success: false, error: 'Update check returned no result' });
    });

    it('handles check failure', async () => {
      mocks.isRunningInFlatpak.mockReturnValue(false);
      mocks.checkMsiInstallation.mockResolvedValue(false);
      (process as any).mas = false;
      (process as any).windowsStore = false;
      mocks.getAutoUpdater.mockReturnValue({
        channel: '',
        allowPrerelease: false,
        checkForUpdates: vi.fn().mockRejectedValue(new Error('Network error')),
      });
      const result = await handlers['check-for-updates'](event);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('ignores beta release on stable channel', async () => {
      mocks.isRunningInFlatpak.mockReturnValue(false);
      mocks.checkMsiInstallation.mockResolvedValue(false);
      mocks.appGetVersion.mockReturnValue('1.0.0');
      (process as any).mas = false;
      (process as any).windowsStore = false;
      loadSettings.mockResolvedValue({ updateChannel: 'stable' } as any);
      mocks.getAutoUpdater.mockReturnValue({
        channel: '',
        allowPrerelease: false,
        checkForUpdates: vi.fn().mockResolvedValue({
          updateInfo: { version: '2.0.0-beta.1', releaseDate: '2025-01-01' },
        }),
      });
      const result = await handlers['check-for-updates'](event);
      expect(result.success).toBe(true);
      expect(result.hasUpdate).toBe(false);
    });

    it('ignores stable release on beta channel', async () => {
      mocks.isRunningInFlatpak.mockReturnValue(false);
      mocks.checkMsiInstallation.mockResolvedValue(false);
      mocks.appGetVersion.mockReturnValue('2.0.0-beta.1');
      (process as any).mas = false;
      (process as any).windowsStore = false;
      loadSettings.mockResolvedValue({ updateChannel: 'beta' } as any);
      mocks.getAutoUpdater.mockReturnValue({
        channel: '',
        allowPrerelease: true,
        checkForUpdates: vi.fn().mockResolvedValue({
          updateInfo: { version: '1.5.0', releaseDate: '2025-01-01' },
        }),
      });
      const result = await handlers['check-for-updates'](event);
      expect(result.success).toBe(true);
      expect(result.hasUpdate).toBe(false);
    });
  });

  describe('download-update', () => {
    const event = { sender: { id: 1 } } as any;

    it('rejects untrusted sender', async () => {
      mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
      const result = await handlers['download-update'](event);
      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('downloads update successfully', async () => {
      mocks.getAutoUpdater.mockReturnValue({
        downloadUpdate: vi.fn().mockResolvedValue(undefined),
      });
      const result = await handlers['download-update'](event);
      expect(result).toEqual({ success: true });
    });

    it('handles download failure', async () => {
      mocks.getAutoUpdater.mockReturnValue({
        downloadUpdate: vi.fn().mockRejectedValue(new Error('Download failed')),
      });
      const result = await handlers['download-update'](event);
      expect(result).toEqual({ success: false, error: 'Download failed' });
    });
  });

  describe('install-update', () => {
    const event = { sender: { id: 1 } } as any;

    it('rejects untrusted sender', async () => {
      mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
      const result = await handlers['install-update'](event);
      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('installs update and schedules quitAndInstall', async () => {
      vi.useFakeTimers();
      const quitAndInstall = vi.fn();
      mocks.getAutoUpdater.mockReturnValue({ quitAndInstall });
      const result = await handlers['install-update'](event);
      expect(result).toEqual({ success: true });
      expect(mocks.setIsQuitting).toHaveBeenCalledWith(true);
      expect(mocks.appReleaseSingleInstanceLock).toHaveBeenCalled();
      vi.advanceTimersByTime(200);
      expect(quitAndInstall).toHaveBeenCalledWith(false, true);
      vi.useRealTimers();
    });
  });
});

describe('initializeAutoUpdater', () => {
  it('sets up auto updater with stable channel by default', async () => {
    const mockAutoUpdater = {
      logger: null as any,
      autoDownload: true,
      autoInstallOnAppQuit: false,
      channel: '',
      allowPrerelease: true,
      on: vi.fn(),
      checkForUpdates: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getAutoUpdater.mockReturnValue(mockAutoUpdater);
    mocks.appGetVersion.mockReturnValue('1.0.0');
    mocks.getIsDev.mockReturnValue(false);
    mocks.isRunningInFlatpak.mockReturnValue(false);
    mocks.checkMsiInstallation.mockResolvedValue(false);
    mocks.isInstalledViaMsi.mockReturnValue(false);
    (process as any).mas = false;
    (process as any).windowsStore = false;

    await initializeAutoUpdater({ autoCheckUpdates: true } as any);

    expect(mockAutoUpdater.autoDownload).toBe(false);
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(mockAutoUpdater.channel).toBe('latest');
    expect(mockAutoUpdater.allowPrerelease).toBe(false);
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled();
  });

  it('uses beta channel when updateChannel is beta', async () => {
    const mockAutoUpdater = {
      logger: null as any,
      autoDownload: true,
      autoInstallOnAppQuit: false,
      channel: '',
      allowPrerelease: false,
      on: vi.fn(),
      checkForUpdates: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getAutoUpdater.mockReturnValue(mockAutoUpdater);
    mocks.appGetVersion.mockReturnValue('1.0.0');
    mocks.getIsDev.mockReturnValue(false);
    mocks.isRunningInFlatpak.mockReturnValue(false);
    mocks.checkMsiInstallation.mockResolvedValue(false);
    mocks.isInstalledViaMsi.mockReturnValue(false);
    (process as any).mas = false;
    (process as any).windowsStore = false;

    await initializeAutoUpdater({ updateChannel: 'beta', autoCheckUpdates: true } as any);

    expect(mockAutoUpdater.channel).toBe('beta');
    expect(mockAutoUpdater.allowPrerelease).toBe(true);
  });

  it('auto-detects beta channel from version string', async () => {
    const mockAutoUpdater = {
      logger: null as any,
      autoDownload: true,
      autoInstallOnAppQuit: false,
      channel: '',
      allowPrerelease: false,
      on: vi.fn(),
      checkForUpdates: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getAutoUpdater.mockReturnValue(mockAutoUpdater);
    mocks.appGetVersion.mockReturnValue('1.0.0-beta.1');
    mocks.getIsDev.mockReturnValue(false);
    mocks.isRunningInFlatpak.mockReturnValue(false);
    mocks.checkMsiInstallation.mockResolvedValue(false);
    mocks.isInstalledViaMsi.mockReturnValue(false);
    (process as any).mas = false;
    (process as any).windowsStore = false;

    await initializeAutoUpdater({ autoCheckUpdates: true } as any);

    expect(mockAutoUpdater.channel).toBe('beta');
    expect(mockAutoUpdater.allowPrerelease).toBe(true);
  });

  it('skips auto-check in flatpak', async () => {
    const mockAutoUpdater = {
      logger: null as any,
      autoDownload: true,
      autoInstallOnAppQuit: false,
      channel: '',
      allowPrerelease: false,
      on: vi.fn(),
      checkForUpdates: vi.fn(),
    };
    mocks.getAutoUpdater.mockReturnValue(mockAutoUpdater);
    mocks.appGetVersion.mockReturnValue('1.0.0');
    mocks.getIsDev.mockReturnValue(false);
    mocks.isRunningInFlatpak.mockReturnValue(true);
    mocks.checkMsiInstallation.mockResolvedValue(false);

    await initializeAutoUpdater({ autoCheckUpdates: true } as any);

    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('skips auto-check when autoCheckUpdates is false', async () => {
    const mockAutoUpdater = {
      logger: null as any,
      autoDownload: true,
      autoInstallOnAppQuit: false,
      channel: '',
      allowPrerelease: false,
      on: vi.fn(),
      checkForUpdates: vi.fn(),
    };
    mocks.getAutoUpdater.mockReturnValue(mockAutoUpdater);
    mocks.appGetVersion.mockReturnValue('1.0.0');
    mocks.getIsDev.mockReturnValue(false);
    mocks.isRunningInFlatpak.mockReturnValue(false);
    mocks.checkMsiInstallation.mockResolvedValue(false);
    mocks.isInstalledViaMsi.mockReturnValue(false);
    (process as any).mas = false;
    (process as any).windowsStore = false;

    await initializeAutoUpdater({ autoCheckUpdates: false } as any);

    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('skips auto-check in dev mode', async () => {
    const mockAutoUpdater = {
      logger: null as any,
      autoDownload: true,
      autoInstallOnAppQuit: false,
      channel: '',
      allowPrerelease: false,
      on: vi.fn(),
      checkForUpdates: vi.fn(),
    };
    mocks.getAutoUpdater.mockReturnValue(mockAutoUpdater);
    mocks.appGetVersion.mockReturnValue('1.0.0');
    mocks.getIsDev.mockReturnValue(true);
    mocks.isRunningInFlatpak.mockReturnValue(false);
    mocks.checkMsiInstallation.mockResolvedValue(false);
    mocks.isInstalledViaMsi.mockReturnValue(false);
    (process as any).mas = false;
    (process as any).windowsStore = false;

    await initializeAutoUpdater({ autoCheckUpdates: true } as any);

    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('handles getAutoUpdater throwing an error', async () => {
    mocks.getAutoUpdater.mockImplementation(() => {
      throw new Error('No updater available');
    });
    mocks.getIsDev.mockReturnValue(false);
    mocks.checkMsiInstallation.mockResolvedValue(false);

    await expect(initializeAutoUpdater({ autoCheckUpdates: true } as any)).resolves.toBeUndefined();
  });
});
