import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const mockIndexerInstance = {
    setEnabled: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
  };
  return {
    ipcMainHandle: vi.fn(),
    ipcMainOn: vi.fn(),
    appGetPath: vi.fn((name: string) => {
      if (name === 'exe') return '/usr/bin/iyeris';
      return '/tmp/test-userData';
    }),
    appIsPackaged: false,
    appSetLoginItemSettings: vi.fn(),
    appRelaunch: vi.fn(),
    appQuit: vi.fn(),
    BrowserWindowFromWebContents: vi.fn(() => null),
    BrowserWindowGetAllWindows: vi.fn((): any[] => []),
    clipboardReadBuffer: vi.fn(() => Buffer.alloc(0)),
    clipboardRead: vi.fn(() => ''),
    fsReadFile: vi.fn().mockResolvedValue('{}'),
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
    mockIndexerInstance,
    loggerDebug: vi.fn(),
    loggerError: vi.fn(),
    loggerWarn: vi.fn(),
  };
});

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
  SETTINGS_CACHE_TTL_MS: 30000,
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
  FileIndexer: vi.fn(function () {
    return mocks.mockIndexerInstance;
  }),
}));

vi.mock('../main/logger', () => ({
  logger: {
    debug: mocks.loggerDebug,
    error: mocks.loggerError,
    warn: mocks.loggerWarn,
  },
}));

vi.mock('../main/ipcUtils', () => ({
  isTrustedIpcEvent: mocks.isTrustedIpcEvent,
}));

import {
  loadSettings,
  applyLoginItemSettings,
  setupSettingsHandlers,
} from '../main/settingsManager';
import { FileIndexer } from '../main/indexer';

describe('settingsManager.extended2', () => {
  let handlers: Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>>;
  let syncHandlers: Record<string, (...args: unknown[]) => unknown>;
  const createTray = vi.fn().mockResolvedValue(undefined);
  let origDateNow: typeof Date.now;
  let fakeNow = 2e12;

  beforeEach(() => {
    vi.clearAllMocks();
    origDateNow = Date.now;
    fakeNow += 100000;
    Date.now = () => fakeNow;

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

    mocks.appGetPath.mockImplementation((name: string) => {
      if (name === 'exe') return '/usr/bin/iyeris';
      return '/tmp/test-userData';
    });
    mocks.appIsPackaged = false;
    mocks.fsReadFile.mockResolvedValue('{}');
    mocks.fsWriteFile.mockResolvedValue(undefined);
    mocks.fsRename.mockResolvedValue(undefined);
    mocks.fsCopyFile.mockResolvedValue(undefined);
    mocks.fsUnlink.mockResolvedValue(undefined);
    mocks.sanitizeSettings.mockImplementation((s: any) => ({ ...s }));
    mocks.createDefaultSettings.mockReturnValue({
      showHiddenFiles: false,
      theme: 'system',
      sortBy: 'name',
      sortOrder: 'asc',
      viewMode: 'grid',
      startOnLogin: false,
      minimizeToTray: false,
      enableIndexer: false,
      autoCheckUpdates: true,
    });
    mocks.isTrustedIpcEvent.mockReturnValue(true);
    mocks.isTrustedIpcSender.mockReturnValue(true);
    mocks.getFileIndexer.mockReturnValue(null);
    mocks.getTray.mockReturnValue(null);
    mocks.getIndexerTasks.mockReturnValue(null);
    mocks.clipboardReadBuffer.mockReturnValue(Buffer.alloc(0));
    mocks.clipboardRead.mockReturnValue('');
    mocks.mockIndexerInstance.initialize.mockResolvedValue(undefined);

    createTray.mockClear();
    createTray.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Date.now = origDateNow;
  });

  describe('save-settings handler', () => {
    const makeEvent = (isDestroyed = false) => ({
      sender: {
        isDestroyed: vi.fn(() => isDestroyed),
      },
    });

    beforeEach(() => {
      setupSettingsHandlers(createTray);
    });

    it('rejects untrusted sender', async () => {
      mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
      const result = await handlers['save-settings'](makeEvent(), { enableIndexer: false } as any);
      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('skips indexer and tray logic when save fails', async () => {
      mocks.fsWriteFile.mockRejectedValue(new Error('disk full'));

      const result = await handlers['save-settings'](makeEvent(), {
        enableIndexer: true,
        minimizeToTray: true,
      } as any);

      expect(result.success).toBe(false);
      expect(FileIndexer).not.toHaveBeenCalled();
      expect(createTray).not.toHaveBeenCalled();
    });

    describe('indexer enable/disable', () => {
      it('creates FileIndexer and enables when enableIndexer is true and no existing indexer', async () => {
        mocks.getFileIndexer.mockReturnValue(null);
        mocks.getIndexerTasks.mockReturnValue(null);

        const result = await handlers['save-settings'](makeEvent(), { enableIndexer: true } as any);

        expect(result.success).toBe(true);
        expect(FileIndexer).toHaveBeenCalledWith(undefined);
        expect(mocks.setFileIndexer).toHaveBeenCalled();
        expect(mocks.mockIndexerInstance.setEnabled).toHaveBeenCalledWith(true);
        expect(mocks.mockIndexerInstance.initialize).toHaveBeenCalledWith(true);
      });

      it('passes indexerTasks to FileIndexer constructor when available', async () => {
        const tasks = { someTask: true };
        mocks.getFileIndexer.mockReturnValue(null);
        mocks.getIndexerTasks.mockReturnValue(tasks as any);

        await handlers['save-settings'](makeEvent(), { enableIndexer: true } as any);

        expect(FileIndexer).toHaveBeenCalledWith(tasks);
      });

      it('uses existing FileIndexer when one already exists', async () => {
        const existingIndexer = {
          setEnabled: vi.fn(),
          initialize: vi.fn().mockResolvedValue(undefined),
        };
        mocks.getFileIndexer.mockReturnValue(existingIndexer as any);

        await handlers['save-settings'](makeEvent(), { enableIndexer: true } as any);

        expect(FileIndexer).not.toHaveBeenCalled();
        expect(mocks.setFileIndexer).not.toHaveBeenCalled();
        expect(existingIndexer.setEnabled).toHaveBeenCalledWith(true);
        expect(existingIndexer.initialize).toHaveBeenCalledWith(true);
      });

      it('disables existing FileIndexer when enableIndexer is false', async () => {
        const existingIndexer = { setEnabled: vi.fn(), initialize: vi.fn() };
        mocks.getFileIndexer.mockReturnValue(existingIndexer as any);

        await handlers['save-settings'](makeEvent(), { enableIndexer: false } as any);

        expect(existingIndexer.setEnabled).toHaveBeenCalledWith(false);
        expect(existingIndexer.initialize).not.toHaveBeenCalled();
      });

      it('does nothing to indexer when enableIndexer is false and no indexer exists', async () => {
        mocks.getFileIndexer.mockReturnValue(null);

        await handlers['save-settings'](makeEvent(), { enableIndexer: false } as any);

        expect(FileIndexer).not.toHaveBeenCalled();
        expect(mocks.mockIndexerInstance.setEnabled).not.toHaveBeenCalled();
      });

      it('catches indexer initialize rejection', async () => {
        mocks.getFileIndexer.mockReturnValue(null);
        const error = new Error('indexer init failed');
        mocks.mockIndexerInstance.initialize.mockRejectedValue(error);

        await handlers['save-settings'](makeEvent(), { enableIndexer: true } as any);

        expect(mocks.loggerWarn).toHaveBeenCalledWith(
          '[Settings] Failed to initialize indexer:',
          error
        );
      });
    });

    describe('tray management', () => {
      it('creates tray when minimizeToTray is true and no tray exists', async () => {
        mocks.getTray.mockReturnValue(null);

        await handlers['save-settings'](makeEvent(), { minimizeToTray: true } as any);

        expect(createTray).toHaveBeenCalled();
      });

      it('destroys tray when minimizeToTray is false and tray exists', async () => {
        const mockTray = { destroy: vi.fn() };
        mocks.getTray.mockReturnValue(mockTray as any);

        await handlers['save-settings'](makeEvent(), { minimizeToTray: false } as any);

        expect(mockTray.destroy).toHaveBeenCalled();
        expect(mocks.setTray).toHaveBeenCalledWith(null);
      });

      it('does not recreate tray when minimizeToTray is true and tray already exists', async () => {
        const mockTray = { destroy: vi.fn() };
        mocks.getTray.mockReturnValue(mockTray as any);

        await handlers['save-settings'](makeEvent(), { minimizeToTray: true } as any);

        expect(createTray).not.toHaveBeenCalled();
        expect(mockTray.destroy).not.toHaveBeenCalled();
      });

      it('does nothing when minimizeToTray is false and no tray', async () => {
        mocks.getTray.mockReturnValue(null);

        await handlers['save-settings'](makeEvent(), { minimizeToTray: false } as any);

        expect(createTray).not.toHaveBeenCalled();
        expect(mocks.setTray).not.toHaveBeenCalled();
      });
    });

    describe('broadcasting settings-changed', () => {
      it('sends settings-changed to other windows after successful save', async () => {
        const senderWin = {
          isDestroyed: () => false,
          webContents: { send: vi.fn() },
        };
        const otherWin = {
          isDestroyed: () => false,
          webContents: { send: vi.fn() },
        };
        mocks.BrowserWindowFromWebContents.mockReturnValue(senderWin as any);
        mocks.BrowserWindowGetAllWindows.mockReturnValue([senderWin, otherWin]);

        await handlers['save-settings'](makeEvent(), { theme: 'dark' } as any);

        expect(otherWin.webContents.send).toHaveBeenCalledWith(
          'settings-changed',
          expect.any(Object)
        );
        expect(senderWin.webContents.send).not.toHaveBeenCalled();
      });

      it('skips destroyed windows during broadcast', async () => {
        const destroyedWin = {
          isDestroyed: () => true,
          webContents: { send: vi.fn() },
        };
        mocks.BrowserWindowFromWebContents.mockReturnValue(null);
        mocks.BrowserWindowGetAllWindows.mockReturnValue([destroyedWin]);

        await handlers['save-settings'](makeEvent(), {} as any);

        expect(destroyedWin.webContents.send).not.toHaveBeenCalled();
      });

      it('skips broadcasting entirely when sender is destroyed', async () => {
        const otherWin = {
          isDestroyed: () => false,
          webContents: { send: vi.fn() },
        };
        mocks.BrowserWindowGetAllWindows.mockReturnValue([otherWin]);

        await handlers['save-settings'](makeEvent(true), {} as any);

        expect(otherWin.webContents.send).not.toHaveBeenCalled();
      });

      it('catches broadcast errors and logs a warning', async () => {
        const otherWin = {
          isDestroyed: () => false,
          webContents: {
            send: vi.fn(() => {
              throw new Error('window gone');
            }),
          },
        };
        mocks.BrowserWindowFromWebContents.mockReturnValue(null);
        mocks.BrowserWindowGetAllWindows.mockReturnValue([otherWin]);

        const result = await handlers['save-settings'](makeEvent(), {} as any);

        expect(result.success).toBe(true);
        expect(mocks.loggerWarn).toHaveBeenCalledWith(
          '[Settings] Failed to broadcast to window:',
          expect.any(Error)
        );
      });
    });
  });

  describe('get-system-clipboard-files handler', () => {
    beforeEach(() => {
      setupSettingsHandlers(createTray);
    });

    it('returns empty array for untrusted sender', () => {
      mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
      const result = handlers['get-system-clipboard-files']({ sender: {} } as any);
      expect(result).toEqual([]);
    });

    it('parses macOS/Linux file:// URLs', () => {
      mocks.clipboardReadBuffer.mockReturnValue(Buffer.alloc(0));
      mocks.clipboardRead.mockReturnValue(
        'file:///home/user/Documents/file.txt\nfile:///home/user/Downloads/image.png'
      );

      const result = handlers['get-system-clipboard-files']({ sender: {} } as any);

      expect(result).toEqual(['/home/user/Documents/file.txt', '/home/user/Downloads/image.png']);
    });

    it('decodes percent-encoded characters in file:// URLs', () => {
      mocks.clipboardReadBuffer.mockReturnValue(Buffer.alloc(0));
      mocks.clipboardRead.mockReturnValue('file:///home/user/My%20Documents/file%20name.txt');

      const result = handlers['get-system-clipboard-files']({ sender: {} } as any);

      expect(result).toEqual(['/home/user/My Documents/file name.txt']);
    });

    it('returns empty array when clipboard has no file data', () => {
      mocks.clipboardReadBuffer.mockReturnValue(Buffer.alloc(0));
      mocks.clipboardRead.mockReturnValue('');

      const result = handlers['get-system-clipboard-files']({ sender: {} } as any);

      expect(result).toEqual([]);
    });

    it('handles clipboard errors gracefully and returns empty array', () => {
      mocks.clipboardReadBuffer.mockImplementation(() => {
        throw new Error('clipboard access denied');
      });

      const result = handlers['get-system-clipboard-files']({ sender: {} } as any);

      expect(result).toEqual([]);
      expect(mocks.loggerError).toHaveBeenCalled();
    });

    it('strips leading slash for win32 drive paths in file:// URLs', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        mocks.clipboardReadBuffer.mockReturnValue(Buffer.alloc(0));
        mocks.clipboardRead.mockReturnValue('file:///C:/Users/test/file.txt');

        const result = handlers['get-system-clipboard-files']({ sender: {} } as any);

        expect(result).toEqual(['C:/Users/test/file.txt']);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('handles plain paths (non-file:// scheme) in public.file-url', () => {
      mocks.clipboardReadBuffer.mockReturnValue(Buffer.alloc(0));
      mocks.clipboardRead.mockReturnValue('/some/plain/path');

      const result = handlers['get-system-clipboard-files']({ sender: {} } as any);

      expect(result).toEqual(['/some/plain/path']);
    });

    it('skips blank lines and whitespace-only entries', () => {
      mocks.clipboardReadBuffer.mockReturnValue(Buffer.alloc(0));
      mocks.clipboardRead.mockReturnValue('file:///a.txt\n\n  \nfile:///b.txt');

      const result = handlers['get-system-clipboard-files']({ sender: {} } as any);

      expect(result).toEqual(['/a.txt', '/b.txt']);
    });
  });

  describe('applyLoginItemSettings platform branches', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      delete (process as any).windowsStore;
    });

    it('uses StartupTask settings for Windows Store app', () => {
      mocks.appIsPackaged = true;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      (process as any).windowsStore = true;

      applyLoginItemSettings({ startOnLogin: true } as any);

      expect(mocks.appSetLoginItemSettings).toHaveBeenCalledWith({
        openAtLogin: true,
        name: 'IYERIS',
      });
    });

    it('includes exe path for non-store Windows with startOnLogin true', () => {
      mocks.appIsPackaged = true;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      (process as any).windowsStore = false;
      mocks.appGetPath.mockImplementation(((name: string) => {
        if (name === 'exe') return 'C:\\Program Files\\IYERIS\\iyeris.exe';
        return '/tmp/test-userData';
      }) as any);

      applyLoginItemSettings({ startOnLogin: true } as any);

      expect(mocks.appSetLoginItemSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          openAtLogin: true,
          name: 'IYERIS',
          args: ['--hidden'],
          path: 'C:\\Program Files\\IYERIS\\iyeris.exe',
        })
      );
    });

    it('passes empty args when startOnLogin is false on non-store Windows', () => {
      mocks.appIsPackaged = true;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      (process as any).windowsStore = false;

      applyLoginItemSettings({ startOnLogin: false } as any);

      expect(mocks.appSetLoginItemSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          openAtLogin: false,
          args: [],
        })
      );
    });
  });

  describe('loadSettings outer catch & backup rename failure', () => {
    it('returns defaults when getSettingsPath throws (outer catch)', async () => {
      mocks.appGetPath.mockImplementation(() => {
        throw new Error('path unavailable');
      });

      const settings = await loadSettings();

      expect(settings).toEqual(mocks.createDefaultSettings());
      expect(mocks.loggerError).toHaveBeenCalledWith(
        '[Settings] Failed to load settings:',
        'path unavailable'
      );
    });

    it('calls ignoreError when backup rename fails for corrupt settings', async () => {
      mocks.fsReadFile.mockResolvedValue('{corrupt json!!!');
      mocks.fsRename.mockRejectedValue(new Error('rename failed'));

      const settings = await loadSettings();

      expect(settings).toEqual(mocks.createDefaultSettings());
      expect(mocks.ignoreError).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('save-settings-sync additional branches', () => {
    beforeEach(() => {
      setupSettingsHandlers(createTray);
    });

    it('returns error when writeFileSync throws', () => {
      mocks.fsWriteFileSync.mockImplementationOnce(() => {
        throw new Error('disk full');
      });
      const event = { returnValue: null as any, sender: {} };

      syncHandlers['save-settings-sync'](event, { theme: 'dark' });

      expect(event.returnValue).toEqual({ success: false, error: 'disk full' });
    });

    it('ignores unlinkSync failure in rename fallback path', () => {
      mocks.fsRenameSync.mockImplementation(() => {
        throw new Error('EXDEV');
      });
      mocks.fsUnlinkSync.mockImplementation(() => {
        throw new Error('unlink failed');
      });
      const event = { returnValue: null as any, sender: {} };

      syncHandlers['save-settings-sync'](event, { theme: 'dark' });

      expect(event.returnValue).toEqual({ success: true });
      expect(mocks.fsCopyFileSync).toHaveBeenCalled();
    });
  });

  describe('get-settings error path', () => {
    beforeEach(() => {
      setupSettingsHandlers(createTray);
    });

    it('returns error response when handler throws unexpectedly', async () => {
      mocks.isTrustedIpcEvent.mockImplementation(() => {
        throw new Error('unexpected error');
      });

      const result = await handlers['get-settings']({ sender: {} } as any);

      expect(result).toEqual({ success: false, error: 'unexpected error' });
    });
  });

  describe('set-clipboard broadcasting', () => {
    beforeEach(() => {
      setupSettingsHandlers(createTray);
    });

    it('broadcasts clipboard-changed to other windows', () => {
      const senderWin = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() },
      };
      const otherWin = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() },
      };
      mocks.BrowserWindowFromWebContents.mockReturnValue(senderWin as any);
      mocks.BrowserWindowGetAllWindows.mockReturnValue([senderWin, otherWin]);
      mocks.getSharedClipboard.mockReturnValue({
        operation: 'copy' as const,
        paths: ['/a.txt'],
      } as any);

      handlers['set-clipboard']({ sender: { id: 1 } } as any, {
        operation: 'copy' as const,
        paths: ['/a.txt'],
      });

      expect(otherWin.webContents.send).toHaveBeenCalledWith('clipboard-changed', {
        operation: 'copy',
        paths: ['/a.txt'],
      });
      expect(senderWin.webContents.send).not.toHaveBeenCalled();
    });

    it('skips destroyed windows during clipboard broadcast', () => {
      const destroyedWin = {
        isDestroyed: () => true,
        webContents: { send: vi.fn() },
      };
      mocks.BrowserWindowFromWebContents.mockReturnValue(null);
      mocks.BrowserWindowGetAllWindows.mockReturnValue([destroyedWin]);

      handlers['set-clipboard']({ sender: { id: 1 } } as any, {
        operation: 'copy' as const,
        paths: ['/a.txt'],
      });

      expect(destroyedWin.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('miscellaneous uncovered branches', () => {
    beforeEach(() => {
      setupSettingsHandlers(createTray);
    });

    it('set-drag-data sets null when paths array is empty', () => {
      const event = { sender: { id: 1 } } as any;
      handlers['set-drag-data'](event, []);
      expect(mocks.setWindowDragData).toHaveBeenCalledWith(event.sender, null);
    });

    it('get-drag-data returns null for untrusted sender', () => {
      mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
      const result = handlers['get-drag-data']({ sender: {} } as any);
      expect(result).toBeNull();
    });

    it('clear-drag-data is no-op for untrusted sender', () => {
      mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
      handlers['clear-drag-data']({ sender: {} } as any);
      expect(mocks.clearWindowDragData).not.toHaveBeenCalled();
    });

    it('relaunch-app is no-op for untrusted sender', () => {
      mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
      handlers['relaunch-app']({ sender: {} } as any);
      expect(mocks.appRelaunch).not.toHaveBeenCalled();
      expect(mocks.appQuit).not.toHaveBeenCalled();
    });

    it('get-clipboard returns null for untrusted sender', () => {
      mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
      const result = handlers['get-clipboard']({ sender: {} } as any);
      expect(result).toBeNull();
    });

    it('set-clipboard clears clipboard when null is passed', () => {
      handlers['set-clipboard']({ sender: { id: 1 } } as any, null);
      expect(mocks.setSharedClipboard).toHaveBeenCalledWith(null);
    });
  });
});
