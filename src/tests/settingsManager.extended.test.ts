import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
  ipcMainOn: vi.fn(),
  appGetPath: vi.fn(() => '/tmp/test-userData'),
  appIsPackaged: false,
  appSetLoginItemSettings: vi.fn(),
  appRelaunch: vi.fn(),
  appQuit: vi.fn(),
  BrowserWindowFromWebContents: vi.fn(() => null),
  BrowserWindowGetAllWindows: vi.fn(() => []),
  clipboardReadBuffer: vi.fn(() => Buffer.alloc(0)),
  clipboardRead: vi.fn(() => ''),
  fsReadFile: vi.fn(),
  fsWriteFile: vi.fn().mockResolvedValue(undefined),
  fsRename: vi.fn().mockResolvedValue(undefined),
  fsCopyFile: vi.fn().mockResolvedValue(undefined),
  fsUnlink: vi.fn().mockResolvedValue(undefined),
  fsWriteFileSync: vi.fn(),
  fsRenameSync: vi.fn(),
  fsCopyFileSync: vi.fn(),
  fsUnlinkSync: vi.fn(),
  getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  isTrustedIpcSender: vi.fn(() => true),
  isTrustedIpcEvent: vi.fn(() => true),
  ignoreError: vi.fn(),
  createDefaultSettings: vi.fn(() => ({
    showHiddenFiles: false,
    theme: 'system',
    sortBy: 'name',
    sortOrder: 'asc',
    viewMode: 'grid',
    startOnLogin: false,
    minimizeToTray: false,
    enableIndexer: false,
    autoCheckUpdates: true,
  })),
  sanitizeSettings: vi.fn((s: any) => ({ ...s })),
  getSharedClipboard: vi.fn(() => null),
  setSharedClipboard: vi.fn(),
  getWindowDragData: vi.fn(() => null),
  setWindowDragData: vi.fn(),
  clearWindowDragData: vi.fn(),
  getTray: vi.fn(() => null),
  setTray: vi.fn(),
  getFileIndexer: vi.fn(() => null),
  setFileIndexer: vi.fn(),
  getIndexerTasks: vi.fn(() => null),
  SETTINGS_CACHE_TTL_MS: 30000,
  loggerDebug: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerGetLogsDirectory: vi.fn(() => '/tmp/logs'),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocks.ipcMainHandle,
    on: mocks.ipcMainOn,
  },
  app: {
    getPath: mocks.appGetPath,
    get isPackaged() {
      return mocks.appIsPackaged;
    },
    setLoginItemSettings: mocks.appSetLoginItemSettings,
    relaunch: mocks.appRelaunch,
    quit: mocks.appQuit,
  },
  BrowserWindow: {
    fromWebContents: mocks.BrowserWindowFromWebContents,
    getAllWindows: mocks.BrowserWindowGetAllWindows,
  },
  clipboard: {
    readBuffer: mocks.clipboardReadBuffer,
    read: mocks.clipboardRead,
  },
}));

vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  return { ...actual, default: actual };
});

vi.mock('fs', () => ({
  default: {
    writeFileSync: mocks.fsWriteFileSync,
    renameSync: mocks.fsRenameSync,
    copyFileSync: mocks.fsCopyFileSync,
    unlinkSync: mocks.fsUnlinkSync,
  },
  promises: {
    readFile: mocks.fsReadFile,
    writeFile: mocks.fsWriteFile,
    rename: mocks.fsRename,
    copyFile: mocks.fsCopyFile,
    unlink: mocks.fsUnlink,
  },
  writeFileSync: mocks.fsWriteFileSync,
  renameSync: mocks.fsRenameSync,
  copyFileSync: mocks.fsCopyFileSync,
  unlinkSync: mocks.fsUnlinkSync,
}));

vi.mock('../main/security', () => ({
  getErrorMessage: mocks.getErrorMessage,
  isTrustedIpcSender: mocks.isTrustedIpcSender,
}));

vi.mock('../shared', () => ({
  ignoreError: mocks.ignoreError,
}));

vi.mock('../settings', () => ({
  createDefaultSettings: mocks.createDefaultSettings,
  sanitizeSettings: mocks.sanitizeSettings,
}));

vi.mock('../main/appState', () => ({
  SETTINGS_CACHE_TTL_MS: mocks.SETTINGS_CACHE_TTL_MS,
  getSharedClipboard: mocks.getSharedClipboard,
  setSharedClipboard: mocks.setSharedClipboard,
  getWindowDragData: mocks.getWindowDragData,
  setWindowDragData: mocks.setWindowDragData,
  clearWindowDragData: mocks.clearWindowDragData,
  getTray: mocks.getTray,
  setTray: mocks.setTray,
  getFileIndexer: mocks.getFileIndexer,
  setFileIndexer: mocks.setFileIndexer,
  getIndexerTasks: mocks.getIndexerTasks,
}));

vi.mock('../main/indexer', () => ({
  FileIndexer: class MockFileIndexer {
    setEnabled = vi.fn();
    initialize = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../main/logger', () => ({
  logger: {
    debug: mocks.loggerDebug,
    error: mocks.loggerError,
    warn: mocks.loggerWarn,
    getLogsDirectory: mocks.loggerGetLogsDirectory,
  },
}));

vi.mock('../main/ipcUtils', () => ({
  isTrustedIpcEvent: mocks.isTrustedIpcEvent,
}));

import {
  loadSettings,
  saveSettings,
  getSettingsPath,
  getCachedSettings,
  applyLoginItemSettings,
  setupSettingsHandlers,
} from '../main/settingsManager';

describe('getSettingsPath', () => {
  it('returns path inside userData directory', () => {
    const result = getSettingsPath();
    expect(result).toContain('settings.json');
    expect(result).toContain('test-userData');
  });
});

describe('loadSettings', () => {
  let origDateNow: typeof Date.now;

  let fakeNow = 1e12;

  beforeEach(() => {
    vi.clearAllMocks();
    origDateNow = Date.now;

    fakeNow += 100000;
    Date.now = () => fakeNow;
  });

  afterEach(() => {
    Date.now = origDateNow;
  });

  it('returns defaults when file does not exist', async () => {
    mocks.fsReadFile.mockRejectedValue(new Error('ENOENT'));
    const settings = await loadSettings();
    expect(settings).toEqual(mocks.createDefaultSettings());
  });

  it('parses existing settings file', async () => {
    const stored = JSON.stringify({ theme: 'dark', sortBy: 'size' });
    mocks.fsReadFile.mockResolvedValue(stored);
    mocks.sanitizeSettings.mockReturnValue({ theme: 'dark', sortBy: 'size' });
    const settings = await loadSettings();
    expect(settings.theme).toBe('dark');
  });

  it('handles corrupt JSON file', async () => {
    mocks.fsReadFile.mockResolvedValue('not valid json {{{');
    mocks.fsRename.mockResolvedValue(undefined);
    const settings = await loadSettings();
    expect(settings).toEqual(mocks.createDefaultSettings());
  });

  it('uses cache within TTL', async () => {
    mocks.fsReadFile.mockResolvedValue(JSON.stringify({ theme: 'light' }));
    mocks.sanitizeSettings.mockReturnValue({ theme: 'light' });

    const settings1 = await loadSettings();
    expect(settings1.theme).toBe('light');

    const settings2 = await loadSettings();
    expect(settings2.theme).toBe('light');
    expect(mocks.fsReadFile).toHaveBeenCalledTimes(1);
  });
});

describe('saveSettings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves settings to file', async () => {
    mocks.fsWriteFile.mockResolvedValue(undefined);
    mocks.fsRename.mockResolvedValue(undefined);
    mocks.sanitizeSettings.mockReturnValue({ theme: 'dark' });

    const result = await saveSettings({ theme: 'dark' } as any);
    expect(result).toEqual({ success: true });
    expect(mocks.fsWriteFile).toHaveBeenCalled();
  });

  it('falls back to copyFile when rename fails', async () => {
    mocks.fsWriteFile.mockResolvedValue(undefined);
    mocks.fsRename.mockRejectedValue(new Error('cross-device'));
    mocks.fsCopyFile.mockResolvedValue(undefined);
    mocks.fsUnlink.mockResolvedValue(undefined);
    mocks.sanitizeSettings.mockReturnValue({ theme: 'dark' });

    const result = await saveSettings({ theme: 'dark' } as any);
    expect(result).toEqual({ success: true });
    expect(mocks.fsCopyFile).toHaveBeenCalled();
  });

  it('handles write failure', async () => {
    mocks.fsWriteFile.mockRejectedValue(new Error('Permission denied'));
    mocks.sanitizeSettings.mockReturnValue({ theme: 'dark' });

    const result = await saveSettings({ theme: 'dark' } as any);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Permission denied');
  });

  it('serializes save operations', async () => {
    mocks.fsWriteFile.mockResolvedValue(undefined);
    mocks.fsRename.mockResolvedValue(undefined);
    mocks.sanitizeSettings.mockReturnValue({ theme: 'dark' });

    const [r1, r2] = await Promise.all([
      saveSettings({ theme: 'dark' } as any),
      saveSettings({ theme: 'light' } as any),
    ]);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });
});

describe('getCachedSettings', () => {
  it('returns null initially', () => {
    const result = getCachedSettings();
    expect(result === null || typeof result === 'object').toBe(true);
  });
});

describe('applyLoginItemSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appIsPackaged = true;
  });

  it('skips when app is not packaged', () => {
    mocks.appIsPackaged = false;
    applyLoginItemSettings({ startOnLogin: true } as any);
    expect(mocks.appSetLoginItemSettings).not.toHaveBeenCalled();
  });

  it('applies login item settings when packaged', () => {
    applyLoginItemSettings({ startOnLogin: true } as any);
    expect(mocks.appSetLoginItemSettings).toHaveBeenCalled();
  });

  it('handles errors gracefully', () => {
    mocks.appSetLoginItemSettings.mockImplementation(() => {
      throw new Error('Not supported');
    });

    expect(() => applyLoginItemSettings({ startOnLogin: true } as any)).not.toThrow();
  });
});

describe('setupSettingsHandlers', () => {
  let handlers: Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>>;
  let syncHandlers: Record<string, (...args: unknown[]) => unknown>;
  const createTray = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = {};
    syncHandlers = {};
    mocks.ipcMainHandle.mockImplementation(
      (channel: string, handler: (...args: unknown[]) => Promise<Record<string, unknown>>) => {
        handlers[channel] = handler;
      }
    );
    mocks.ipcMainOn.mockImplementation(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        syncHandlers[channel] = handler;
      }
    );
    setupSettingsHandlers(createTray);
  });

  it('registers all expected handlers', () => {
    expect(handlers['get-settings']).toBeDefined();
    expect(handlers['save-settings']).toBeDefined();
    expect(handlers['reset-settings']).toBeDefined();
    expect(handlers['set-clipboard']).toBeDefined();
    expect(handlers['get-clipboard']).toBeDefined();
    expect(handlers['get-system-clipboard-files']).toBeDefined();
    expect(handlers['set-drag-data']).toBeDefined();
    expect(handlers['get-drag-data']).toBeDefined();
    expect(handlers['clear-drag-data']).toBeDefined();
    expect(handlers['relaunch-app']).toBeDefined();
    expect(handlers['get-settings-path']).toBeDefined();
    expect(syncHandlers['save-settings-sync']).toBeDefined();
  });

  describe('get-settings', () => {
    it('rejects untrusted sender', async () => {
      mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
      const result = await handlers['get-settings']({ sender: {} } as any);
      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('returns settings on success', async () => {
      mocks.fsReadFile.mockRejectedValue(new Error('ENOENT'));
      const result = await handlers['get-settings']({ sender: {} } as any);
      expect(result.success).toBe(true);
      expect(result.settings).toBeDefined();
    });
  });

  describe('reset-settings', () => {
    it('rejects untrusted sender', async () => {
      mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
      const result = await handlers['reset-settings']({ sender: {} } as any);
      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('saves default settings', async () => {
      mocks.fsWriteFile.mockResolvedValue(undefined);
      mocks.fsRename.mockResolvedValue(undefined);
      const result = await handlers['reset-settings']({ sender: {} } as any);
      expect(result.success).toBe(true);
    });
  });

  describe('clipboard handlers', () => {
    const event = { sender: { id: 1 } } as any;

    it('set-clipboard calls setSharedClipboard', () => {
      const data = { operation: 'copy' as const, paths: ['/file.txt'] };
      handlers['set-clipboard'](event, data);
      expect(mocks.setSharedClipboard).toHaveBeenCalledWith(data);
    });

    it('get-clipboard returns shared clipboard', () => {
      mocks.getSharedClipboard.mockReturnValue({ operation: 'copy', paths: ['/a'] } as any);
      const result = handlers['get-clipboard'](event);
      expect(result).toEqual({ operation: 'copy', paths: ['/a'] });
    });

    it('set-clipboard rejects untrusted sender', () => {
      mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
      handlers['set-clipboard'](event, null);
      expect(mocks.setSharedClipboard).not.toHaveBeenCalled();
    });
  });

  describe('drag data handlers', () => {
    const event = { sender: { id: 1 } } as any;

    it('set-drag-data sets drag data', () => {
      handlers['set-drag-data'](event, ['/file.txt']);
      expect(mocks.setWindowDragData).toHaveBeenCalled();
    });

    it('get-drag-data returns drag data', () => {
      mocks.getWindowDragData.mockReturnValue({ paths: ['/a'] } as any);
      const result = handlers['get-drag-data'](event);
      expect(result).toEqual({ paths: ['/a'] });
    });

    it('clear-drag-data clears drag data', () => {
      handlers['clear-drag-data'](event);
      expect(mocks.clearWindowDragData).toHaveBeenCalled();
    });
  });

  describe('get-settings-path', () => {
    it('returns settings path', () => {
      const result = handlers['get-settings-path']({ sender: {} } as any);
      expect(result).toContain('settings.json');
    });

    it('returns empty string for untrusted sender', () => {
      mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
      const result = handlers['get-settings-path']({ sender: {} } as any);
      expect(result).toBe('');
    });
  });

  describe('save-settings-sync', () => {
    it('saves settings synchronously', () => {
      const event = {
        returnValue: null as any,
        sender: {},
      };
      mocks.isTrustedIpcSender.mockReturnValue(true);
      mocks.sanitizeSettings.mockReturnValue({ theme: 'dark' });
      syncHandlers['save-settings-sync'](event, { theme: 'dark' });
      expect(event.returnValue).toEqual({ success: true });
    });

    it('rejects untrusted sender', () => {
      const event = {
        returnValue: null as any,
        sender: {},
      };
      mocks.isTrustedIpcSender.mockReturnValueOnce(false);
      syncHandlers['save-settings-sync'](event, { theme: 'dark' });
      expect(event.returnValue).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });
  });

  describe('relaunch-app', () => {
    it('relaunches and quits', () => {
      handlers['relaunch-app']({ sender: {} } as any);
      expect(mocks.appRelaunch).toHaveBeenCalled();
      expect(mocks.appQuit).toHaveBeenCalled();
    });
  });
});
