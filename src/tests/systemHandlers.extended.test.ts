import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Settings } from '../types';

type Handler = (...args: unknown[]) => Promise<Record<string, unknown>>;

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
      getVersion: vi.fn(() => '0.0.0-test'),
      quit: vi.fn(),
    },
    shellMock: {
      openPath: vi.fn(async () => ''),
    },
    systemPreferencesMock: {
      getAccentColor: vi.fn(() => '0078d4ff'),
    },
    nativeThemeMock: {
      shouldUseDarkColors: false,
      on: vi.fn((event: string, callback: () => void) => {
        if (event === 'updated') {
          nativeThemeUpdated = callback;
        }
      }),
    },
    browserWindowMock: {
      getAllWindows: vi.fn(() => [] as unknown[]),
    },
    screenMock: {
      getPrimaryDisplay: vi.fn(() => ({ scaleFactor: 1.25 })),
    },
    fsPromisesMock: {
      stat: vi.fn(),
      open: vi.fn(),
      readFile: vi.fn(),
    },
    execMock: vi.fn(),
    execFileAsyncMock: vi.fn(),
    spawnMock: vi.fn(),
    checkFullDiskAccessMock: vi.fn(async () => true),
    showFullDiskAccessDialogMock: vi.fn(async () => undefined),
    getGitStatusMock: vi.fn(async () => ({ success: true, isGitRepo: true, statuses: [] })),
    getGitBranchMock: vi.fn(async () => ({ success: true, branch: 'main' })),
    getDiskSpaceMock: vi.fn(async () => ({ success: true, total: 10, free: 5 })),
    exportDiagnosticsMock: vi.fn(async () => ({ success: true, path: '/tmp/diag.json' })),
    getLogFileContentMock: vi.fn(async () => ({ success: true, content: 'log' })),
    launchDetachedMock: vi.fn(),
    isRunningInFlatpakMock: vi.fn(() => false),
    ignoreErrorMock: vi.fn(),
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
  exec: hoisted.execMock,
  execFile: vi.fn(),
  spawn: hoisted.spawnMock,
}));

vi.mock('util', () => ({
  promisify: vi.fn(() => hoisted.execFileAsyncMock),
}));

vi.mock('../main/appState', () => ({
  MAX_TEXT_PREVIEW_BYTES: 1024 * 1024,
  MAX_DATA_URL_BYTES: 10 * 1024 * 1024,
}));

vi.mock('../main/security', () => ({
  isPathSafe: vi.fn(() => hoisted.safePath.value),
  getErrorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error)
  ),
}));

vi.mock('../shared', () => ({
  ignoreError: hoisted.ignoreErrorMock,
}));

vi.mock('../main/platformUtils', () => ({
  isRunningInFlatpak: hoisted.isRunningInFlatpakMock,
}));

vi.mock('../main/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    getLogsDirectory: vi.fn(() => '/tmp/logs'),
  },
}));

vi.mock('../main/ipcUtils', () => ({
  withTrustedApiHandler: vi.fn(
    (
      _channel: string,
      handler: (...args: unknown[]) => unknown,
      untrustedResponse?: { success: boolean; error?: string }
    ) =>
      async (...args: any[]) =>
        hoisted.trusted.value
          ? await handler(...args)
          : (untrustedResponse ?? { success: false, error: 'Untrusted IPC sender' })
  ),
  withTrustedIpcEvent: vi.fn(
    (_channel: string, untrustedResponse: unknown, handler: (...args: unknown[]) => unknown) =>
      async (...args: any[]) =>
        hoisted.trusted.value ? await handler(...args) : untrustedResponse
  ),
}));

vi.mock('../main/processUtils', () => ({
  launchDetached: hoisted.launchDetachedMock,
}));

vi.mock('../main/fullDiskAccess', () => ({
  checkFullDiskAccess: hoisted.checkFullDiskAccessMock,
  showFullDiskAccessDialog: hoisted.showFullDiskAccessDialogMock,
}));

vi.mock('../main/gitHandlers', () => ({
  getGitStatus: hoisted.getGitStatusMock,
  getGitBranch: hoisted.getGitBranchMock,
}));

vi.mock('../main/diskSpaceHandler', () => ({
  getDiskSpace: hoisted.getDiskSpaceMock,
}));

vi.mock('../main/diagnosticsHandlers', () => ({
  exportDiagnostics: hoisted.exportDiagnosticsMock,
  getLogFileContent: hoisted.getLogFileContentMock,
}));

import { setupSystemHandlers } from '../main/systemHandlers';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

function getHandler(channel: string): Handler {
  const handler = hoisted.handlers.get(channel);
  if (!handler) throw new Error(`${channel} handler missing`);
  return handler;
}

const mockEvent = {} as any;
let loadSettingsMock: () => Promise<Settings>;
let saveSettingsMock: (settings: Settings) => Promise<{ success: true }>;

describe('systemHandlers extended coverage', () => {
  beforeEach(() => {
    hoisted.handlers.clear();
    hoisted.trusted.value = true;
    hoisted.safePath.value = true;
    hoisted.nativeThemeUpdated.set(null);
    hoisted.nativeThemeMock.shouldUseDarkColors = false;
    hoisted.nativeThemeMock.on.mockClear();
    hoisted.browserWindowMock.getAllWindows.mockReset();
    hoisted.browserWindowMock.getAllWindows.mockReturnValue([]);
    hoisted.fsPromisesMock.stat.mockReset();
    hoisted.fsPromisesMock.open.mockReset();
    hoisted.fsPromisesMock.readFile.mockReset();
    hoisted.shellMock.openPath.mockReset();
    hoisted.shellMock.openPath.mockResolvedValue('');
    hoisted.execMock.mockReset();
    hoisted.execFileAsyncMock.mockReset();
    hoisted.spawnMock.mockReset();
    hoisted.launchDetachedMock.mockReset();
    hoisted.appMock.quit.mockReset();
    hoisted.checkFullDiskAccessMock.mockReset();
    hoisted.checkFullDiskAccessMock.mockResolvedValue(true);
    hoisted.showFullDiskAccessDialogMock.mockReset();
    hoisted.getDiskSpaceMock.mockReset();
    hoisted.getDiskSpaceMock.mockResolvedValue({ success: true, total: 10, free: 5 });
    hoisted.getGitStatusMock.mockReset();
    hoisted.getGitStatusMock.mockResolvedValue({ success: true, isGitRepo: true, statuses: [] });
    hoisted.getGitBranchMock.mockReset();
    hoisted.getGitBranchMock.mockResolvedValue({ success: true, branch: 'main' });
    hoisted.exportDiagnosticsMock.mockReset();
    hoisted.exportDiagnosticsMock.mockResolvedValue({ success: true, path: '/tmp/diag.json' });
    hoisted.getLogFileContentMock.mockReset();
    hoisted.getLogFileContentMock.mockResolvedValue({ success: true, content: 'log' });
    hoisted.ignoreErrorMock.mockReset();
    hoisted.isRunningInFlatpakMock.mockReset();
    hoisted.isRunningInFlatpakMock.mockReturnValue(false);
    hoisted.systemPreferencesMock.getAccentColor.mockReset();
    hoisted.systemPreferencesMock.getAccentColor.mockReturnValue('0078d4ff');
    hoisted.screenMock.getPrimaryDisplay.mockReset();
    hoisted.screenMock.getPrimaryDisplay.mockReturnValue({ scaleFactor: 1.25 });
    setPlatform(originalPlatform);

    loadSettingsMock = vi.fn(async () => ({ skipFullDiskAccessPrompt: false }) as any);
    saveSettingsMock = vi.fn(async () => ({ success: true as const }));

    setupSystemHandlers(loadSettingsMock, saveSettingsMock);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  describe('handler registration', () => {
    it('registers all expected IPC handlers', () => {
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

      for (const channel of expectedChannels) {
        expect(hoisted.handlers.has(channel), `Missing handler: ${channel}`).toBe(true);
      }
    });
  });

  describe('restart-as-admin', () => {
    it('builds powershell command and quits on win32', async () => {
      setPlatform('win32');
      hoisted.execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('restart-as-admin');
      const result = await handler(mockEvent);

      expect(result).toEqual({ success: true });
      expect(hoisted.appMock.quit).toHaveBeenCalled();
      expect(hoisted.execFileAsyncMock).toHaveBeenCalledWith(
        'powershell',
        expect.arrayContaining(['-NoProfile', '-Command', 'Start-Process'])
      );
    });

    it('builds osascript command and quits on darwin', async () => {
      setPlatform('darwin');
      hoisted.execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('restart-as-admin');
      const result = await handler(mockEvent);

      expect(result).toEqual({ success: true });
      expect(hoisted.appMock.quit).toHaveBeenCalled();
      expect(hoisted.execFileAsyncMock).toHaveBeenCalledWith('osascript', expect.any(Array));
    });

    it('builds pkexec command and quits on linux', async () => {
      setPlatform('linux');
      hoisted.execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('restart-as-admin');
      const result = await handler(mockEvent);

      expect(result).toEqual({ success: true });
      expect(hoisted.appMock.quit).toHaveBeenCalled();
      expect(hoisted.execFileAsyncMock).toHaveBeenCalledWith('pkexec', ['/tmp/iyeris']);
    });

    it('returns error for unsupported platform', async () => {
      setPlatform('freebsd' as NodeJS.Platform);
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('restart-as-admin');
      const result = await handler(mockEvent);

      expect(result).toEqual({ success: false, error: 'Unsupported platform' });
      expect(hoisted.appMock.quit).not.toHaveBeenCalled();
    });

    it('returns error when execFileAsync rejects', async () => {
      setPlatform('win32');
      hoisted.execFileAsyncMock.mockRejectedValue(new Error('User cancelled'));
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('restart-as-admin');
      const result = await handler(mockEvent);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to restart with admin privileges');
      expect(hoisted.appMock.quit).not.toHaveBeenCalled();
    });
  });

  describe('open-terminal', () => {
    it('rejects invalid path', async () => {
      hoisted.safePath.value = false;
      const handler = getHandler('open-terminal');
      const result = await handler(mockEvent, '/bad/path');

      expect(result).toEqual({ success: false, error: 'Invalid directory path' });
    });

    it('opens Windows Terminal (wt) when available on win32', async () => {
      setPlatform('win32');
      hoisted.execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('open-terminal');
      const result = await handler(mockEvent, 'C:\\Users\\test');

      expect(result).toEqual({ success: true });
      expect(hoisted.execFileAsyncMock).toHaveBeenCalledWith('where', ['wt']);
      expect(hoisted.launchDetachedMock).toHaveBeenCalledWith('wt', ['-d', 'C:\\Users\\test']);
    });

    it('falls back to cmd when wt is not available on win32', async () => {
      setPlatform('win32');
      hoisted.execFileAsyncMock.mockRejectedValue(new Error('not found'));
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('open-terminal');
      const result = await handler(mockEvent, 'C:\\Users\\test');

      expect(result).toEqual({ success: true });
      expect(hoisted.launchDetachedMock).toHaveBeenCalledWith(
        'cmd',
        expect.arrayContaining(['/K', 'cd', '/d'])
      );
    });

    it('escapes double quotes in dirPath for cmd fallback on win32', async () => {
      setPlatform('win32');
      hoisted.execFileAsyncMock.mockRejectedValue(new Error('not found'));
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('open-terminal');
      await handler(mockEvent, 'C:\\my "dir"');

      expect(hoisted.launchDetachedMock).toHaveBeenCalledWith('cmd', [
        '/K',
        'cd',
        '/d',
        '"C:\\my ""dir"""',
      ]);
    });

    it('opens Terminal.app on darwin', async () => {
      setPlatform('darwin');
      const mockChild = {
        once: vi.fn((event: string, cb: (...args: any[]) => void) => {
          if (event === 'spawn') cb();
        }),
        unref: vi.fn(),
      };
      hoisted.spawnMock.mockReturnValue(mockChild);
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('open-terminal');
      const result = await handler(mockEvent, '/Users/test');

      expect(result).toEqual({ success: true });
      expect(hoisted.spawnMock).toHaveBeenCalledWith(
        'open',
        expect.arrayContaining(['-a', expect.any(String), '--', '/Users/test']),
        expect.objectContaining({ detached: true })
      );
    });

    it('launches first available terminal emulator on linux', async () => {
      setPlatform('linux');
      const mockChild = {
        once: vi.fn((event: string, cb: (...args: any[]) => void) => {
          if (event === 'spawn') cb();
        }),
        unref: vi.fn(),
      };
      hoisted.spawnMock.mockReturnValue(mockChild);
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('open-terminal');
      const result = await handler(mockEvent, '/home/user');

      expect(result).toEqual({ success: true });
      expect(hoisted.spawnMock).toHaveBeenCalledTimes(1);
      expect(hoisted.spawnMock).toHaveBeenCalledWith(
        'x-terminal-emulator',
        ['--working-directory', '/home/user'],
        expect.objectContaining({ detached: true, cwd: '/home/user' })
      );
      expect(mockChild.unref).toHaveBeenCalled();
    });

    it('tries gnome-terminal when x-terminal-emulator fails on linux', async () => {
      setPlatform('linux');
      let callCount = 0;
      hoisted.spawnMock.mockImplementation(() => {
        callCount++;
        const child = {
          once: vi.fn((event: string, cb: (...args: any[]) => void) => {
            if (callCount === 1 && event === 'error') cb(new Error('not found'));
            if (callCount === 2 && event === 'spawn') cb();
          }),
          unref: vi.fn(),
        };
        return child;
      });
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('open-terminal');
      const result = await handler(mockEvent, '/home/user');

      expect(result).toEqual({ success: true });
      expect(hoisted.spawnMock).toHaveBeenCalledTimes(2);
      expect(hoisted.spawnMock).toHaveBeenNthCalledWith(
        2,
        'gnome-terminal',
        ['--working-directory=/home/user'],
        expect.objectContaining({ detached: true })
      );
    });

    it('tries konsole when first two terminals fail on linux', async () => {
      setPlatform('linux');
      let callCount = 0;
      hoisted.spawnMock.mockImplementation(() => {
        callCount++;
        const child = {
          once: vi.fn((event: string, cb: (...args: any[]) => void) => {
            if (callCount <= 2 && event === 'error') cb(new Error('not found'));
            if (callCount === 3 && event === 'spawn') cb();
          }),
          unref: vi.fn(),
        };
        return child;
      });
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('open-terminal');
      const result = await handler(mockEvent, '/home/user');

      expect(result).toEqual({ success: true });
      expect(hoisted.spawnMock).toHaveBeenCalledTimes(3);
      expect(hoisted.spawnMock).toHaveBeenNthCalledWith(
        3,
        'konsole',
        ['--workdir', '/home/user'],
        expect.objectContaining({ detached: true })
      );
    });

    it('logs error when no terminal emulator found on linux', async () => {
      setPlatform('linux');
      const { logger } = await import('../main/logger');
      vi.mocked(logger.error).mockClear();
      hoisted.spawnMock.mockImplementation(() => {
        const child = {
          once: vi.fn((event: string, cb: (...args: any[]) => void) => {
            if (event === 'error') cb(new Error('not found'));
          }),
          unref: vi.fn(),
        };
        return child;
      });
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('open-terminal');
      const result = await handler(mockEvent, '/home/user');

      expect(result).toEqual({ success: false, error: 'No suitable terminal emulator found' });
      expect(hoisted.spawnMock).toHaveBeenCalledTimes(14);
      expect(logger.error).toHaveBeenCalledWith('No suitable terminal emulator found');
    });
  });

  describe('read-file-content', () => {
    it('returns error for not a regular file', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => false, size: 100 } as any);
      const handler = getHandler('read-file-content');
      const result = await handler(mockEvent, '/tmp/dir');

      expect(result).toEqual({ success: false, error: 'Not a regular file' });
    });

    it('reads entire file when size is within maxSize', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 10 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue('hello world');
      const handler = getHandler('read-file-content');
      const result = await handler(mockEvent, '/tmp/small.txt');

      expect(result).toEqual({
        success: true,
        content: 'hello world',
        isTruncated: false,
      });
    });

    it('truncates file content when size exceeds maxSize', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
      hoisted.fsPromisesMock.open.mockResolvedValue({
        read: vi.fn(async (buffer: Buffer, _offset: number, length: number) => {
          Buffer.from('abcdefghijklmnopqrstuvwxyz').copy(buffer, 0, 0, length);
        }),
        close: vi.fn(async () => undefined),
      } as any);
      const handler = getHandler('read-file-content');
      const result = await handler(mockEvent, '/tmp/big.txt', 5);

      expect(result.success).toBe(true);
      expect(result.isTruncated).toBe(true);
      expect(result.content).toBe('abcde');
    });

    it('clamps maxSize to at least 1', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 5 } as any);
      hoisted.fsPromisesMock.open.mockResolvedValue({
        read: vi.fn(async (buffer: Buffer, _offset: number, length: number) => {
          Buffer.from('x').copy(buffer, 0, 0, length);
        }),
        close: vi.fn(async () => undefined),
      } as any);
      const handler = getHandler('read-file-content');
      const result = await handler(mockEvent, '/tmp/file.txt', 0);

      expect(result.success).toBe(true);
      expect(result.isTruncated).toBe(true);
    });

    it('uses MAX_TEXT_PREVIEW_BYTES when maxSize is NaN', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 10 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue('content');
      const handler = getHandler('read-file-content');
      const result = await handler(mockEvent, '/tmp/file.txt', NaN);

      expect(result).toEqual({ success: true, content: 'content', isTruncated: false });
    });

    it('uses MAX_TEXT_PREVIEW_BYTES when maxSize is Infinity', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 10 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue('content');
      const handler = getHandler('read-file-content');
      const result = await handler(mockEvent, '/tmp/file.txt', Infinity);

      expect(result).toEqual({ success: true, content: 'content', isTruncated: false });
    });

    it('uses default maxSize when not provided', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 10 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue('abc');
      const handler = getHandler('read-file-content');
      const result = await handler(mockEvent, '/tmp/file.txt');

      expect(result).toEqual({ success: true, content: 'abc', isTruncated: false });
    });

    it('closes file handle even when read succeeds (finally block)', async () => {
      const closeMock = vi.fn(async () => undefined);
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
      hoisted.fsPromisesMock.open.mockResolvedValue({
        read: vi.fn(async (buffer: Buffer, _offset: number, length: number) => {
          Buffer.from('data').copy(buffer, 0, 0, Math.min(4, length));
        }),
        close: closeMock,
      } as any);
      const handler = getHandler('read-file-content');
      await handler(mockEvent, '/tmp/file.txt', 4);

      expect(closeMock).toHaveBeenCalled();
    });

    it('rejects invalid path', async () => {
      hoisted.safePath.value = false;
      const handler = getHandler('read-file-content');
      const result = await handler(mockEvent, '/bad/path');

      expect(result).toEqual({ success: false, error: 'Invalid file path' });
    });
  });

  describe('get-file-data-url', () => {
    it('rejects invalid path', async () => {
      hoisted.safePath.value = false;
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/bad/path');

      expect(result).toEqual({ success: false, error: 'Invalid file path' });
    });

    it('rejects non-file entries', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => false, size: 100 } as any);
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/dir');

      expect(result).toEqual({ success: false, error: 'Not a regular file' });
    });

    it('rejects file too large for preview', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 5000 } as any);
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/big.jpg', 10);

      expect(result).toEqual({ success: false, error: 'File too large to preview' });
    });

    it('returns data URL with correct base64 content', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 3 } as any);
      const buf = Buffer.from([0xde, 0xad, 0xbe]);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(buf);
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/image.png', 1024);

      expect(result.success).toBe(true);
      expect(result.dataUrl).toBe(`data:image/png;base64,${buf.toString('base64')}`);
    });

    it('uses application/octet-stream for unknown extensions', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 3 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01, 0x02, 0x03]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/file.xyz');

      expect(result.dataUrl).toMatch(/^data:application\/octet-stream;base64,/);
    });

    it('uses MAX_DATA_URL_BYTES when maxSize is NaN', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 5 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/photo.png', NaN);

      expect(result.success).toBe(true);
    });

    it('clamps maxSize to at least 1 for data url', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 5 } as any);
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/photo.png', 0);

      expect(result).toEqual({ success: false, error: 'File too large to preview' });
    });

    it('maps .jpg to image/jpeg', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/photo.jpg');
      expect(result.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    });

    it('maps .jpeg to image/jpeg', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/photo.jpeg');
      expect(result.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    });

    it('maps .jfif to image/jpeg', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/photo.jfif');
      expect(result.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    });

    it('maps .gif to image/gif', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/anim.gif');
      expect(result.dataUrl).toMatch(/^data:image\/gif;base64,/);
    });

    it('maps .webp to image/webp', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/photo.webp');
      expect(result.dataUrl).toMatch(/^data:image\/webp;base64,/);
    });

    it('maps .avif to image/avif', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/photo.avif');
      expect(result.dataUrl).toMatch(/^data:image\/avif;base64,/);
    });

    it('maps .svg to image/svg+xml', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 5 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from('<svg/>'));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/icon.svg');
      expect(result.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    });

    it('maps .bmp to image/bmp', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/img.bmp');
      expect(result.dataUrl).toMatch(/^data:image\/bmp;base64,/);
    });

    it('maps .ico to image/x-icon', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/favicon.ico');
      expect(result.dataUrl).toMatch(/^data:image\/x-icon;base64,/);
    });

    it('maps .tif to image/tiff', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/img.tif');
      expect(result.dataUrl).toMatch(/^data:image\/tiff;base64,/);
    });

    it('maps .tiff to image/tiff', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/img.tiff');
      expect(result.dataUrl).toMatch(/^data:image\/tiff;base64,/);
    });

    it('maps .heic to image/heic', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/photo.heic');
      expect(result.dataUrl).toMatch(/^data:image\/heic;base64,/);
    });

    it('maps .heif to image/heif', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/photo.heif');
      expect(result.dataUrl).toMatch(/^data:image\/heif;base64,/);
    });

    it('maps .jxl to image/jxl', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/photo.jxl');
      expect(result.dataUrl).toMatch(/^data:image\/jxl;base64,/);
    });

    it('maps .jp2 to image/jp2', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/photo.jp2');
      expect(result.dataUrl).toMatch(/^data:image\/jp2;base64,/);
    });

    it('maps .apng to image/apng', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/anim.apng');
      expect(result.dataUrl).toMatch(/^data:image\/apng;base64,/);
    });

    it('maps .png to image/png', async () => {
      hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 1 } as any);
      hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0x01]));
      const handler = getHandler('get-file-data-url');
      const result = await handler(mockEvent, '/tmp/img.png');
      expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    });
  });

  describe('get-licenses', () => {
    it('reads and parses licenses.json successfully', async () => {
      const mockLicenses = { packages: [{ name: 'test-pkg', license: 'MIT' }] };
      hoisted.fsPromisesMock.readFile.mockResolvedValue(JSON.stringify(mockLicenses));
      const handler = getHandler('get-licenses');
      const result = await handler(mockEvent);

      expect(result.success).toBe(true);
      expect(result.licenses).toEqual(mockLicenses);
    });
  });

  describe('trusted string events', () => {
    it('get-platform returns process.platform', async () => {
      const handler = getHandler('get-platform');
      const result = await handler(mockEvent);
      expect(result).toBe(process.platform);
    });

    it('get-app-version returns app version', async () => {
      const handler = getHandler('get-app-version');
      const result = await handler(mockEvent);
      expect(result).toBe('0.0.0-test');
    });

    it('get-logs-path returns logs directory', async () => {
      const handler = getHandler('get-logs-path');
      const result = await handler(mockEvent);
      expect(result).toBe('/tmp/logs');
    });

    it('returns empty string for untrusted get-platform', async () => {
      hoisted.trusted.value = false;
      const handler = getHandler('get-platform');
      const result = await handler(mockEvent);
      expect(result).toBe('');
    });

    it('returns empty string for untrusted get-app-version', async () => {
      hoisted.trusted.value = false;
      const handler = getHandler('get-app-version');
      const result = await handler(mockEvent);
      expect(result).toBe('');
    });

    it('returns empty string for untrusted get-logs-path', async () => {
      hoisted.trusted.value = false;
      const handler = getHandler('get-logs-path');
      const result = await handler(mockEvent);
      expect(result).toBe('');
    });
  });

  describe('get-system-accent-color', () => {
    it('returns accent color from systemPreferences on win32', async () => {
      setPlatform('win32');
      hoisted.nativeThemeMock.shouldUseDarkColors = true;
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('get-system-accent-color');
      const result = await handler(mockEvent);

      expect(result).toEqual({ accentColor: '#0078d4', isDarkMode: true });
    });

    it('returns accent color from systemPreferences on darwin', async () => {
      setPlatform('darwin');
      hoisted.systemPreferencesMock.getAccentColor.mockReturnValue('ff5500ee');
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('get-system-accent-color');
      const result = await handler(mockEvent);

      expect(result.accentColor).toBe('#ff5500');
    });

    it('returns default accent color on linux (skips systemPreferences)', async () => {
      setPlatform('linux');
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('get-system-accent-color');
      const result = await handler(mockEvent);

      expect(result.accentColor).toBe('#0078d4');
      expect(hoisted.systemPreferencesMock.getAccentColor).not.toHaveBeenCalled();
    });

    it('falls back to default when getAccentColor throws', async () => {
      setPlatform('win32');
      hoisted.systemPreferencesMock.getAccentColor.mockImplementation(() => {
        throw new Error('Not available');
      });
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('get-system-accent-color');
      const result = await handler(mockEvent);

      expect(result.accentColor).toBe('#0078d4');
      expect(hoisted.ignoreErrorMock).toHaveBeenCalled();
    });

    it('falls back to default when color string is shorter than 6 chars', async () => {
      setPlatform('win32');
      hoisted.systemPreferencesMock.getAccentColor.mockReturnValue('abc');
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('get-system-accent-color');
      const result = await handler(mockEvent);

      expect(result.accentColor).toBe('#0078d4');
    });

    it('falls back to default when color is empty string', async () => {
      setPlatform('darwin');
      hoisted.systemPreferencesMock.getAccentColor.mockReturnValue('');
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('get-system-accent-color');
      const result = await handler(mockEvent);

      expect(result.accentColor).toBe('#0078d4');
    });

    it('returns untrusted default when not trusted', async () => {
      hoisted.trusted.value = false;
      const handler = getHandler('get-system-accent-color');
      const result = await handler(mockEvent);

      expect(result).toEqual({ accentColor: '#0078d4', isDarkMode: false });
    });

    it('returns isDarkMode false when nativeTheme is light', async () => {
      setPlatform('win32');
      hoisted.nativeThemeMock.shouldUseDarkColors = false;
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('get-system-accent-color');
      const result = await handler(mockEvent);

      expect(result.isDarkMode).toBe(false);
    });
  });

  describe('trusted boolean events', () => {
    it('is-mas returns false by default', async () => {
      const handler = getHandler('is-mas');
      const result = await handler(mockEvent);
      expect(result).toBe(false);
    });

    it('is-mas returns true when process.mas is true', async () => {
      (process as any).mas = true;
      const handler = getHandler('is-mas');
      const result = await handler(mockEvent);
      expect(result).toBe(true);
      delete (process as any).mas;
    });

    it('is-flatpak returns false by default', async () => {
      const handler = getHandler('is-flatpak');
      const result = await handler(mockEvent);
      expect(result).toBe(false);
    });

    it('is-flatpak returns true when running in flatpak', async () => {
      hoisted.isRunningInFlatpakMock.mockReturnValue(true);
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('is-flatpak');
      const result = await handler(mockEvent);
      expect(result).toBe(true);
    });

    it('is-ms-store returns false by default', async () => {
      const handler = getHandler('is-ms-store');
      const result = await handler(mockEvent);
      expect(result).toBe(false);
    });

    it('is-ms-store returns true when process.windowsStore is true', async () => {
      (process as any).windowsStore = true;
      const handler = getHandler('is-ms-store');
      const result = await handler(mockEvent);
      expect(result).toBe(true);
      delete (process as any).windowsStore;
    });

    it('returns false for untrusted is-mas', async () => {
      hoisted.trusted.value = false;
      const handler = getHandler('is-mas');
      const result = await handler(mockEvent);
      expect(result).toBe(false);
    });

    it('returns false for untrusted is-flatpak', async () => {
      hoisted.trusted.value = false;
      const handler = getHandler('is-flatpak');
      const result = await handler(mockEvent);
      expect(result).toBe(false);
    });

    it('returns false for untrusted is-ms-store', async () => {
      hoisted.trusted.value = false;
      const handler = getHandler('is-ms-store');
      const result = await handler(mockEvent);
      expect(result).toBe(false);
    });
  });

  describe('get-system-text-scale', () => {
    it('returns primary display scale factor', async () => {
      const handler = getHandler('get-system-text-scale');
      const result = await handler(mockEvent);
      expect(result).toBe(1.25);
    });

    it('returns different scale factor value', async () => {
      hoisted.screenMock.getPrimaryDisplay.mockReturnValue({ scaleFactor: 2.0 });
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('get-system-text-scale');
      const result = await handler(mockEvent);
      expect(result).toBe(2.0);
    });

    it('returns 1 for untrusted request', async () => {
      hoisted.trusted.value = false;
      const handler = getHandler('get-system-text-scale');
      const result = await handler(mockEvent);
      expect(result).toBe(1);
    });
  });

  describe('check-full-disk-access', () => {
    it('returns hasAccess true when access is granted', async () => {
      hoisted.checkFullDiskAccessMock.mockResolvedValue(true);
      const handler = getHandler('check-full-disk-access');
      const result = await handler(mockEvent);

      expect(result).toEqual({ success: true, hasAccess: true });
    });

    it('returns hasAccess false when access is denied', async () => {
      hoisted.checkFullDiskAccessMock.mockResolvedValue(false);
      const handler = getHandler('check-full-disk-access');
      const result = await handler(mockEvent);

      expect(result).toEqual({ success: true, hasAccess: false });
    });

    it('returns untrusted default when not trusted', async () => {
      hoisted.trusted.value = false;
      const handler = getHandler('check-full-disk-access');
      const result = await handler(mockEvent);

      expect(result).toEqual({ success: false, hasAccess: false });
    });
  });

  describe('request-full-disk-access', () => {
    it('returns error on non-darwin platform', async () => {
      setPlatform('linux');
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('request-full-disk-access');
      const result = await handler(mockEvent);

      expect(result).toEqual({
        success: false,
        error: 'Full Disk Access is only applicable on macOS',
      });
      expect(hoisted.showFullDiskAccessDialogMock).not.toHaveBeenCalled();
    });

    it('calls showFullDiskAccessDialog on darwin', async () => {
      setPlatform('darwin');
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('request-full-disk-access');
      const result = await handler(mockEvent);

      expect(result).toEqual({ success: true });
      expect(hoisted.showFullDiskAccessDialogMock).toHaveBeenCalledWith(
        loadSettingsMock,
        saveSettingsMock
      );
    });

    it('returns error on win32', async () => {
      setPlatform('win32');
      hoisted.handlers.clear();
      setupSystemHandlers(loadSettingsMock, saveSettingsMock);

      const handler = getHandler('request-full-disk-access');
      const result = await handler(mockEvent);

      expect(result).toEqual({
        success: false,
        error: 'Full Disk Access is only applicable on macOS',
      });
    });
  });

  describe('get-git-status', () => {
    it('delegates to getGitStatus with includeUntracked true', async () => {
      const handler = getHandler('get-git-status');
      const result = await handler(mockEvent, '/tmp/repo', true);

      expect(result).toEqual({ success: true, isGitRepo: true, statuses: [] });
      expect(hoisted.getGitStatusMock).toHaveBeenCalledWith('/tmp/repo', true);
    });

    it('delegates to getGitStatus with includeUntracked false', async () => {
      const handler = getHandler('get-git-status');
      await handler(mockEvent, '/tmp/repo', false);

      expect(hoisted.getGitStatusMock).toHaveBeenCalledWith('/tmp/repo', false);
    });

    it('defaults includeUntracked to true when not provided', async () => {
      const handler = getHandler('get-git-status');
      await handler(mockEvent, '/tmp/repo');

      expect(hoisted.getGitStatusMock).toHaveBeenCalledWith('/tmp/repo', true);
    });
  });

  describe('get-git-branch', () => {
    it('delegates to getGitBranch', async () => {
      const handler = getHandler('get-git-branch');
      const result = await handler(mockEvent, '/tmp/repo');

      expect(result).toEqual({ success: true, branch: 'main' });
      expect(hoisted.getGitBranchMock).toHaveBeenCalledWith('/tmp/repo');
    });
  });

  describe('open-logs-folder', () => {
    it('opens logs directory with shell.openPath', async () => {
      const handler = getHandler('open-logs-folder');
      const result = await handler(mockEvent);

      expect(result).toEqual({ success: true });
      expect(hoisted.shellMock.openPath).toHaveBeenCalledWith('/tmp/logs');
    });
  });

  describe('export-diagnostics', () => {
    it('delegates to exportDiagnostics with loadSettings', async () => {
      const handler = getHandler('export-diagnostics');
      const result = await handler(mockEvent);

      expect(result).toEqual({ success: true, path: '/tmp/diag.json' });
      expect(hoisted.exportDiagnosticsMock).toHaveBeenCalledWith(loadSettingsMock);
    });
  });

  describe('get-log-file-content', () => {
    it('delegates to getLogFileContent', async () => {
      const handler = getHandler('get-log-file-content');
      const result = await handler(mockEvent);

      expect(result).toEqual({ success: true, content: 'log' });
      expect(hoisted.getLogFileContentMock).toHaveBeenCalled();
    });
  });

  describe('get-disk-space', () => {
    it('delegates to getDiskSpace with drive path', async () => {
      const handler = getHandler('get-disk-space');
      const result = await handler(mockEvent, '/');

      expect(result).toEqual({ success: true, total: 10, free: 5 });
      expect(hoisted.getDiskSpaceMock).toHaveBeenCalledWith('/');
    });
  });

  describe('nativeTheme updated callback', () => {
    it('sends isDarkMode true to all windows', () => {
      const winA = { webContents: { send: vi.fn() } };
      const winB = { webContents: { send: vi.fn() } };
      hoisted.browserWindowMock.getAllWindows.mockReturnValue([winA, winB]);
      hoisted.nativeThemeMock.shouldUseDarkColors = true;

      const onUpdated = hoisted.nativeThemeUpdated.get();
      if (!onUpdated) throw new Error('nativeTheme updated callback was not registered');
      onUpdated();

      expect(winA.webContents.send).toHaveBeenCalledWith('system-theme-changed', {
        isDarkMode: true,
      });
      expect(winB.webContents.send).toHaveBeenCalledWith('system-theme-changed', {
        isDarkMode: true,
      });
    });

    it('sends isDarkMode false when theme is light', () => {
      const win = { webContents: { send: vi.fn() } };
      hoisted.browserWindowMock.getAllWindows.mockReturnValue([win]);
      hoisted.nativeThemeMock.shouldUseDarkColors = false;

      const onUpdated = hoisted.nativeThemeUpdated.get();
      if (!onUpdated) throw new Error('nativeTheme updated callback was not registered');
      onUpdated();

      expect(win.webContents.send).toHaveBeenCalledWith('system-theme-changed', {
        isDarkMode: false,
      });
    });

    it('handles no windows without throwing', () => {
      hoisted.browserWindowMock.getAllWindows.mockReturnValue([]);
      hoisted.nativeThemeMock.shouldUseDarkColors = true;

      const onUpdated = hoisted.nativeThemeUpdated.get();
      if (!onUpdated) throw new Error('nativeTheme updated callback was not registered');

      expect(() => onUpdated()).not.toThrow();
    });
  });
});
