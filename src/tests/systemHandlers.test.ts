import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../types';

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
    checkFullDiskAccessMock: vi.fn(async () => true),
    showFullDiskAccessDialogMock: vi.fn(async () => undefined),
    getGitStatusMock: vi.fn(async () => ({ success: true, isGitRepo: true, statuses: [] })),
    getGitBranchMock: vi.fn(async () => ({ success: true, branch: 'main' })),
    getDiskSpaceMock: vi.fn(async () => ({ success: true, total: 10, free: 5 })),
    exportDiagnosticsMock: vi.fn(async () => ({ success: true, path: '/tmp/diag.json' })),
    getLogFileContentMock: vi.fn(async () => ({ success: true, content: 'log' })),
    launchDetachedMock: vi.fn(),
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
  ignoreError: vi.fn(),
}));

vi.mock('../main/platformUtils', () => ({
  isRunningInFlatpak: vi.fn(() => false),
}));

vi.mock('../main/logger', () => ({
  logger: {
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

describe('setupSystemHandlers', () => {
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
    setPlatform(originalPlatform);

    setupSystemHandlers(
      async () => ({ skipFullDiskAccessPrompt: false }) as unknown as Settings,
      async () => ({ success: true })
    );
  });

  it('returns untrusted response via trusted API wrapper', async () => {
    hoisted.trusted.value = false;
    const handler = hoisted.handlers.get('read-file-content');
    if (!handler) throw new Error('read-file-content handler missing');

    const result = (await handler({} as unknown, '/tmp/file.txt')) as {
      success: boolean;
      error?: string;
    };

    expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
  });

  it('reads and truncates file content to requested max size', async () => {
    hoisted.trusted.value = true;
    hoisted.safePath.value = true;
    hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 20 });
    hoisted.fsPromisesMock.open.mockResolvedValue({
      read: vi.fn(async (buffer: Buffer, _offset: number, length: number) => {
        Buffer.from('abcdefghijklmnopqrstuvwxyz').copy(buffer, 0, 0, length);
      }),
      close: vi.fn(async () => undefined),
    });
    const handler = hoisted.handlers.get('read-file-content');
    if (!handler) throw new Error('read-file-content handler missing');

    const result = (await handler({} as unknown, '/tmp/file.txt', 5)) as {
      success: boolean;
      content?: string;
      isTruncated?: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.isTruncated).toBe(true);
    expect(result.content).toBe('abcde');
  });

  it('rejects invalid paths for read-file-content', async () => {
    hoisted.safePath.value = false;
    const handler = hoisted.handlers.get('read-file-content');
    if (!handler) throw new Error('read-file-content handler missing');

    const result = (await handler({} as unknown, '/bad/path')) as {
      success: boolean;
      error?: string;
    };

    expect(result).toEqual({ success: false, error: 'Invalid file path' });
  });

  it('returns data URLs with extension-based mime type mapping', async () => {
    hoisted.safePath.value = true;
    hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 3 });
    hoisted.fsPromisesMock.readFile.mockResolvedValue(Buffer.from([0xde, 0xad, 0xbe]));
    const handler = hoisted.handlers.get('get-file-data-url');
    if (!handler) throw new Error('get-file-data-url handler missing');

    const result = (await handler({} as unknown, '/tmp/image.png', 1024)) as {
      success: boolean;
      dataUrl?: string;
    };

    expect(result.success).toBe(true);
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('rejects oversized file previews', async () => {
    hoisted.safePath.value = true;
    hoisted.fsPromisesMock.stat.mockResolvedValue({ isFile: () => true, size: 5000 });
    const handler = hoisted.handlers.get('get-file-data-url');
    if (!handler) throw new Error('get-file-data-url handler missing');

    const result = (await handler({} as unknown, '/tmp/image.jpg', 10)) as {
      success: boolean;
      error?: string;
    };

    expect(result).toEqual({ success: false, error: 'File too large to preview' });
  });

  it('returns platform-gated response for request-full-disk-access', async () => {
    setPlatform('linux');
    const handler = hoisted.handlers.get('request-full-disk-access');
    if (!handler) throw new Error('request-full-disk-access handler missing');

    const result = (await handler({} as unknown)) as { success: boolean; error?: string };

    expect(result).toEqual({
      success: false,
      error: 'Full Disk Access is only applicable on macOS',
    });
    expect(hoisted.showFullDiskAccessDialogMock).not.toHaveBeenCalled();
  });

  it('broadcasts system theme changes to all windows on nativeTheme update', () => {
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
});
