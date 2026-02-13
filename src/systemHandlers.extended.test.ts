import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from './types';

type Handler = (...args: unknown[]) => unknown;

const hoisted = vi.hoisted(() => {
  let nativeThemeUpdated: (() => void) | null = null;
  return {
    handlers: new Map<string, Handler>(),
    trusted: { value: true },
    safePath: { value: true },
    nativeThemeUpdated: {
      get: () => nativeThemeUpdated,
      set: (cb: (() => void) | null) => {
        nativeThemeUpdated = cb;
      },
    },
    appMock: {
      getPath: vi.fn((name: string) => (name === 'exe' ? '/tmp/iyeris' : '/tmp')),
      getVersion: vi.fn(() => '1.2.3'),
      quit: vi.fn(),
    },
    shellMock: {
      openPath: vi.fn(async () => ''),
    },
    systemPreferencesMock: {
      getAccentColor: vi.fn(() => '0078d4ff'),
    },
    nativeThemeMock: {
      shouldUseDarkColors: true,
      on: vi.fn((event: string, callback: () => void) => {
        if (event === 'updated') nativeThemeUpdated = callback;
      }),
    },
    browserWindowMock: {
      getAllWindows: vi.fn(() => [] as unknown[]),
    },
    screenMock: {
      getPrimaryDisplay: vi.fn(() => ({ scaleFactor: 1.5 })),
    },
    fsPromisesMock: {
      stat: vi.fn(),
      open: vi.fn(),
      readFile: vi.fn(),
    },
    checkFullDiskAccessMock: vi.fn(async () => true),
    showFullDiskAccessDialogMock: vi.fn(async () => undefined),
    getGitStatusMock: vi.fn(async () => ({ success: true, isGitRepo: true, statuses: [] })),
    getGitBranchMock: vi.fn(async () => ({ success: true, branch: 'main' })),
    getDiskSpaceMock: vi.fn(async () => ({ success: true, total: 10, free: 5 })),
    exportDiagnosticsMock: vi.fn(async () => ({ success: true, path: '/tmp/diag.json' })),
    getLogFileContentMock: vi.fn(async () => ({ success: true, content: 'log data' })),
    launchDetachedMock: vi.fn(),
    execFileAsyncMock: vi.fn(),
    isRunningInFlatpakMock: vi.fn(() => false),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      hoisted.handlers.set(channel, handler);
    }),
  },
  app: hoisted.appMock,
  shell: hoisted.shellMock,
  systemPreferences: hoisted.systemPreferencesMock,
  nativeTheme: hoisted.nativeThemeMock,
  BrowserWindow: hoisted.browserWindowMock,
  screen: hoisted.screenMock,
}));

vi.mock('fs', () => ({
  promises: hoisted.fsPromisesMock,
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn((_cmd: string, _args: string[], cb: (...args: any[]) => any) => cb(null, '', '')),
  spawn: vi.fn(() => ({
    once: vi.fn(),
    unref: vi.fn(),
  })),
}));

vi.mock('util', () => ({
  promisify: vi.fn((fn: (...args: any[]) => any) => {
    return hoisted.execFileAsyncMock;
  }),
}));

vi.mock('./appState', () => ({
  MAX_TEXT_PREVIEW_BYTES: 1024 * 1024,
  MAX_DATA_URL_BYTES: 10 * 1024 * 1024,
}));

vi.mock('./security', () => ({
  isPathSafe: vi.fn(() => hoisted.safePath.value),
  getErrorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error)
  ),
}));

vi.mock('./shared', () => ({
  ignoreError: vi.fn(),
}));

vi.mock('./platformUtils', () => ({
  isRunningInFlatpak: hoisted.isRunningInFlatpakMock,
}));

vi.mock('./utils/logger', () => ({
  logger: {
    getLogsDirectory: vi.fn(() => '/tmp/logs'),
  },
}));

vi.mock('./ipcUtils', () => ({
  withTrustedApiHandler: vi.fn(
    (
      _channel: string,
      handler: (...args: unknown[]) => unknown,
      untrustedResponse?: { success: boolean; error?: string }
    ) =>
      async (...args: unknown[]) =>
        hoisted.trusted.value
          ? await handler(...args)
          : (untrustedResponse ?? { success: false, error: 'Untrusted IPC sender' })
  ),
  withTrustedIpcEvent: vi.fn(
    (_channel: string, untrustedResponse: unknown, handler: (...args: unknown[]) => unknown) =>
      async (...args: unknown[]) =>
        hoisted.trusted.value ? await handler(...args) : untrustedResponse
  ),
}));

vi.mock('./processUtils', () => ({
  launchDetached: hoisted.launchDetachedMock,
}));

vi.mock('./fullDiskAccess', () => ({
  checkFullDiskAccess: hoisted.checkFullDiskAccessMock,
  showFullDiskAccessDialog: hoisted.showFullDiskAccessDialogMock,
}));

vi.mock('./gitHandlers', () => ({
  getGitStatus: hoisted.getGitStatusMock,
  getGitBranch: hoisted.getGitBranchMock,
}));

vi.mock('./diskSpaceHandler', () => ({
  getDiskSpace: hoisted.getDiskSpaceMock,
}));

vi.mock('./diagnosticsHandlers', () => ({
  exportDiagnostics: hoisted.exportDiagnosticsMock,
  getLogFileContent: hoisted.getLogFileContentMock,
}));

import { setupSystemHandlers } from './systemHandlers';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

describe('setupSystemHandlers extended', () => {
  const loadSettings = async () => ({}) as Settings;
  const saveSettings = async () => ({ success: true }) as any;

  beforeEach(() => {
    hoisted.handlers.clear();
    hoisted.trusted.value = true;
    hoisted.safePath.value = true;
    hoisted.nativeThemeUpdated.set(null);
    setPlatform(originalPlatform);
    vi.clearAllMocks();
    setupSystemHandlers(loadSettings, saveSettings);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('registers all expected handlers', () => {
    const expectedChannels = [
      'get-disk-space',
      'restart-as-admin',
      'open-terminal',
      'read-file-content',
      'get-file-data-url',
      'get-licenses',
      'get-platform',
      'get-app-version',
      'get-logs-path',
      'get-system-accent-color',
      'is-mas',
      'is-flatpak',
      'is-ms-store',
      'get-system-text-scale',
      'check-full-disk-access',
      'request-full-disk-access',
      'get-git-status',
      'get-git-branch',
      'open-logs-folder',
      'export-diagnostics',
      'get-log-file-content',
    ];
    for (const ch of expectedChannels) {
      expect(hoisted.handlers.has(ch), `Missing handler: ${ch}`).toBe(true);
    }
  });

  describe('get-platform', () => {
    it('returns current platform', async () => {
      const handler = hoisted.handlers.get('get-platform')!;
      const result = await handler({});
      expect(result).toBe(process.platform);
    });

    it('returns empty string for untrusted', async () => {
      hoisted.trusted.value = false;
      const handler = hoisted.handlers.get('get-platform')!;
      const result = await handler({});
      expect(result).toBe('');
    });
  });

  describe('get-app-version', () => {
    it('returns app version', async () => {
      const handler = hoisted.handlers.get('get-app-version')!;
      const result = await handler({});
      expect(result).toBe('1.2.3');
    });
  });

  describe('get-logs-path', () => {
    it('returns logs directory path', async () => {
      const handler = hoisted.handlers.get('get-logs-path')!;
      const result = await handler({});
      expect(result).toBe('/tmp/logs');
    });
  });

  describe('get-system-accent-color', () => {
    it('returns accent color and dark mode status', async () => {
      setPlatform('win32');
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettings, saveSettings);
      const handler = hoisted.handlers.get('get-system-accent-color')!;
      const result = (await handler({})) as any;
      expect(result.accentColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(typeof result.isDarkMode).toBe('boolean');
    });
  });

  describe('is-mas', () => {
    it('returns false by default', async () => {
      const handler = hoisted.handlers.get('is-mas')!;
      const result = await handler({});
      expect(result).toBe(false);
    });
  });

  describe('is-flatpak', () => {
    it('returns false when not in flatpak', async () => {
      hoisted.isRunningInFlatpakMock.mockReturnValue(false);
      const handler = hoisted.handlers.get('is-flatpak')!;
      const result = await handler({});
      expect(result).toBe(false);
    });

    it('returns true when in flatpak', async () => {
      hoisted.isRunningInFlatpakMock.mockReturnValue(true);
      const handler = hoisted.handlers.get('is-flatpak')!;
      const result = await handler({});
      expect(result).toBe(true);
    });
  });

  describe('get-system-text-scale', () => {
    it('returns display scale factor', async () => {
      const handler = hoisted.handlers.get('get-system-text-scale')!;
      const result = await handler({});
      expect(result).toBe(1.5);
    });
  });

  describe('check-full-disk-access', () => {
    it('returns access status', async () => {
      hoisted.checkFullDiskAccessMock.mockResolvedValue(true);
      const handler = hoisted.handlers.get('check-full-disk-access')!;
      const result = (await handler({})) as any;
      expect(result).toEqual({ success: true, hasAccess: true });
    });
  });

  describe('get-disk-space', () => {
    it('delegates to getDiskSpace handler', async () => {
      const handler = hoisted.handlers.get('get-disk-space')!;
      const result = (await handler({}, '/')) as any;
      expect(result).toEqual({ success: true, total: 10, free: 5 });
      expect(hoisted.getDiskSpaceMock).toHaveBeenCalledWith('/');
    });
  });

  describe('get-git-status', () => {
    it('delegates to getGitStatus', async () => {
      const handler = hoisted.handlers.get('get-git-status')!;
      const result = (await handler({}, '/repo', true)) as any;
      expect(result.success).toBe(true);
      expect(hoisted.getGitStatusMock).toHaveBeenCalledWith('/repo', true);
    });
  });

  describe('get-git-branch', () => {
    it('delegates to getGitBranch', async () => {
      const handler = hoisted.handlers.get('get-git-branch')!;
      const result = (await handler({}, '/repo')) as any;
      expect(result).toEqual({ success: true, branch: 'main' });
    });
  });

  describe('open-logs-folder', () => {
    it('opens logs directory', async () => {
      const handler = hoisted.handlers.get('open-logs-folder')!;
      const result = (await handler({})) as any;
      expect(result).toEqual({ success: true });
      expect(hoisted.shellMock.openPath).toHaveBeenCalledWith('/tmp/logs');
    });
  });

  describe('export-diagnostics', () => {
    it('delegates to exportDiagnostics', async () => {
      const handler = hoisted.handlers.get('export-diagnostics')!;
      const result = (await handler({})) as any;
      expect(result).toEqual({ success: true, path: '/tmp/diag.json' });
    });
  });

  describe('get-log-file-content', () => {
    it('delegates to getLogFileContent', async () => {
      const handler = hoisted.handlers.get('get-log-file-content')!;
      const result = (await handler({})) as any;
      expect(result).toEqual({ success: true, content: 'log data' });
    });
  });

  describe('restart-as-admin', () => {
    it('returns error for unsupported platform', async () => {
      setPlatform('freebsd' as NodeJS.Platform);
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettings, saveSettings);
      const handler = hoisted.handlers.get('restart-as-admin')!;
      const result = (await handler({})) as any;
      expect(result).toEqual({ success: false, error: 'Unsupported platform' });
    });

    it('restarts as admin on win32', async () => {
      setPlatform('win32');
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettings, saveSettings);
      hoisted.execFileAsyncMock.mockResolvedValue('');
      const handler = hoisted.handlers.get('restart-as-admin')!;
      const result = (await handler({})) as any;
      expect(result).toEqual({ success: true });
      expect(hoisted.appMock.quit).toHaveBeenCalled();
    });

    it('handles admin restart failure', async () => {
      setPlatform('darwin');
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettings, saveSettings);
      hoisted.execFileAsyncMock.mockRejectedValue(new Error('Cancelled'));
      const handler = hoisted.handlers.get('restart-as-admin')!;
      const result = (await handler({})) as any;
      expect(result.success).toBe(false);
    });
  });

  describe('read-file-content', () => {
    it('reads full file when under max size', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 100 });
      hoisted.fsPromisesMock.readFile.mockResolvedValue('file content');
      const handler = hoisted.handlers.get('read-file-content')!;
      const result = (await handler({}, '/tmp/file.txt')) as any;
      expect(result.success).toBe(true);
      expect(result.content).toBe('file content');
      expect(result.isTruncated).toBe(false);
    });

    it('rejects non-regular files', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => false, size: 100 });
      const handler = hoisted.handlers.get('read-file-content')!;
      const result = (await handler({}, '/tmp/dir')) as any;
      expect(result).toEqual({ success: false, error: 'Not a regular file' });
    });
  });

  describe('get-file-data-url', () => {
    it('rejects non-files', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => false, size: 100 });
      const handler = hoisted.handlers.get('get-file-data-url')!;
      const result = (await handler({}, '/tmp/dir')) as any;
      expect(result).toEqual({ success: false, error: 'Not a regular file' });
    });

    it('rejects invalid paths', async () => {
      hoisted.safePath.value = false;
      const handler = hoisted.handlers.get('get-file-data-url')!;
      const result = (await handler({}, '/bad')) as any;
      expect(result).toEqual({ success: false, error: 'Invalid file path' });
    });
  });

  describe('get-licenses', () => {
    it('reads and parses licenses.json', async () => {
      hoisted.fsPromisesMock.readFile.mockResolvedValue(JSON.stringify({ MIT: [] }));
      const handler = hoisted.handlers.get('get-licenses')!;
      const result = (await handler({})) as any;
      expect(result.success).toBe(true);
      expect(result.licenses).toEqual({ MIT: [] });
    });
  });

  describe('open-terminal', () => {
    it('rejects unsafe paths', async () => {
      hoisted.safePath.value = false;
      const handler = hoisted.handlers.get('open-terminal')!;
      const result = (await handler({}, '/bad/path')) as any;
      expect(result).toEqual({ success: false, error: 'Invalid directory path' });
    });
  });
});
