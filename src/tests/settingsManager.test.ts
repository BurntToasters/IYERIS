import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../types';

type Handler = (...args: unknown[]) => unknown;
const handleHandlers = new Map<string, Handler>();
const onHandlers = new Map<string, Handler>();

const appMock = {
  getPath: vi.fn((name: string) => (name === 'userData' ? '/tmp/iyeris-user' : '/tmp')),
  isPackaged: false,
  setLoginItemSettings: vi.fn(),
  relaunch: vi.fn(),
  quit: vi.fn(),
};

const clipboardMock = {
  readBuffer: vi.fn(() => Buffer.alloc(0)),
  read: vi.fn(() => ''),
};

const fsPromisesMock = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  copyFile: vi.fn(),
  unlink: vi.fn(),
};

const fsSyncMock = {
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
};

const defaultSettings = { startOnLogin: false } as Settings;
function mergeSettings(input: unknown, defaults: Settings): Settings {
  return {
    ...(defaults as unknown as Record<string, unknown>),
    ...(input as Record<string, unknown>),
  } as unknown as Settings;
}

const createDefaultSettingsMock = vi.fn(() => ({ ...defaultSettings }));
const sanitizeSettingsMock = vi.fn((input: unknown, defaults: Settings) =>
  mergeSettings(input, defaults)
);

let trustedIpcSender = true;
let trustedIpcEvent = true;
let sharedClipboard: { operation: 'copy' | 'cut'; paths: string[] } | null = null;
const dragData = new Map<object, { paths: string[] }>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      handleHandlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, handler: Handler) => {
      onHandlers.set(channel, handler);
    }),
  },
  app: appMock,
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  clipboard: clipboardMock,
}));

vi.mock('fs', () => ({
  promises: fsPromisesMock,
  ...fsSyncMock,
}));

vi.mock('../settings', () => ({
  createDefaultSettings: createDefaultSettingsMock,
  sanitizeSettings: sanitizeSettingsMock,
}));

vi.mock('../main/security', () => ({
  getErrorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error)
  ),
  isTrustedIpcSender: vi.fn(() => trustedIpcSender),
}));

vi.mock('../main/ipcUtils', () => ({
  isTrustedIpcEvent: vi.fn(() => trustedIpcEvent),
}));

vi.mock('../main/appState', () => ({
  SETTINGS_CACHE_TTL_MS: 30000,
  getSharedClipboard: vi.fn(() => sharedClipboard),
  setSharedClipboard: vi.fn((value: { operation: 'copy' | 'cut'; paths: string[] } | null) => {
    sharedClipboard = value;
  }),
  getWindowDragData: vi.fn((sender: object) => dragData.get(sender) || null),
  setWindowDragData: vi.fn((sender: object, value: { paths: string[] } | null) => {
    if (value === null) {
      dragData.delete(sender);
      return;
    }
    dragData.set(sender, value);
  }),
  clearWindowDragData: vi.fn((sender: object) => dragData.delete(sender)),
  getTray: vi.fn(() => null),
  setTray: vi.fn(),
  getFileIndexer: vi.fn(() => null),
  setFileIndexer: vi.fn(),
  getIndexerTasks: vi.fn(() => null),
}));

vi.mock('../main/indexer', () => ({
  FileIndexer: vi.fn().mockImplementation(() => ({
    setEnabled: vi.fn(),
    initialize: vi.fn(async () => undefined),
  })),
}));

vi.mock('../shared', () => ({
  ignoreError: vi.fn(),
}));

vi.mock('../main/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('settingsManager', () => {
  beforeEach(() => {
    vi.resetModules();
    handleHandlers.clear();
    onHandlers.clear();
    trustedIpcSender = true;
    trustedIpcEvent = true;
    sharedClipboard = null;
    dragData.clear();

    appMock.getPath.mockReset();
    appMock.getPath.mockImplementation((name: string) =>
      name === 'userData' ? '/tmp/iyeris-user' : '/tmp'
    );
    appMock.isPackaged = false;
    appMock.setLoginItemSettings.mockReset();
    appMock.relaunch.mockReset();
    appMock.quit.mockReset();

    clipboardMock.readBuffer.mockReset();
    clipboardMock.readBuffer.mockReturnValue(Buffer.alloc(0));
    clipboardMock.read.mockReset();
    clipboardMock.read.mockReturnValue('');

    createDefaultSettingsMock.mockReset();
    createDefaultSettingsMock.mockReturnValue({ ...defaultSettings });
    sanitizeSettingsMock.mockReset();
    sanitizeSettingsMock.mockImplementation((input: unknown, defaults: Settings) =>
      mergeSettings(input, defaults)
    );

    fsPromisesMock.readFile.mockReset();
    fsPromisesMock.readFile.mockResolvedValue('{"startOnLogin": false}');
    fsPromisesMock.writeFile.mockReset();
    fsPromisesMock.writeFile.mockResolvedValue(undefined);
    fsPromisesMock.rename.mockReset();
    fsPromisesMock.rename.mockResolvedValue(undefined);
    fsPromisesMock.copyFile.mockReset();
    fsPromisesMock.copyFile.mockResolvedValue(undefined);
    fsPromisesMock.unlink.mockReset();
    fsPromisesMock.unlink.mockResolvedValue(undefined);

    fsSyncMock.writeFileSync.mockReset();
    fsSyncMock.renameSync.mockReset();
    fsSyncMock.copyFileSync.mockReset();
    fsSyncMock.unlinkSync.mockReset();
  });

  it('caches loaded settings within TTL', async () => {
    fsPromisesMock.readFile.mockResolvedValueOnce('{"startOnLogin": true}');
    const settingsManager = await import('../main/settingsManager');

    const first = await settingsManager.loadSettings();
    const second = await settingsManager.loadSettings();

    expect(fsPromisesMock.readFile).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.startOnLogin).toBe(true);
  });

  it('backs up corrupt settings file and falls back to defaults', async () => {
    fsPromisesMock.readFile.mockResolvedValueOnce('{not-valid-json');
    const settingsManager = await import('../main/settingsManager');

    const loaded = await settingsManager.loadSettings();

    expect(fsPromisesMock.rename).toHaveBeenCalledTimes(1);
    expect(fsPromisesMock.rename).toHaveBeenCalledWith(
      '/tmp/iyeris-user/settings.json',
      expect.stringContaining('/tmp/iyeris-user/settings.json.corrupt-')
    );
    expect(loaded.startOnLogin).toBe(false);
  });

  it('falls back to copy+unlink when atomic rename fails during save', async () => {
    fsPromisesMock.rename.mockRejectedValueOnce(new Error('EXDEV'));
    const settingsManager = await import('../main/settingsManager');

    const result = await settingsManager.saveSettings({ startOnLogin: true } as Settings);

    expect(result).toEqual({ success: true });
    expect(fsPromisesMock.copyFile).toHaveBeenCalledWith(
      '/tmp/iyeris-user/settings.json.tmp',
      '/tmp/iyeris-user/settings.json'
    );
    expect(fsPromisesMock.unlink).toHaveBeenCalledWith('/tmp/iyeris-user/settings.json.tmp');
  });

  it('skips login item setup when app is not packaged', async () => {
    appMock.isPackaged = false;
    const settingsManager = await import('../main/settingsManager');

    settingsManager.applyLoginItemSettings({ startOnLogin: true } as Settings);

    expect(appMock.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('applies login item settings when packaged', async () => {
    appMock.isPackaged = true;
    const settingsManager = await import('../main/settingsManager');

    settingsManager.applyLoginItemSettings({ startOnLogin: true } as Settings);

    expect(appMock.setLoginItemSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        openAtLogin: true,
        name: 'IYERIS',
      })
    );
  });

  it('rejects untrusted save-settings-sync sender', async () => {
    trustedIpcSender = false;
    const settingsManager = await import('../main/settingsManager');
    settingsManager.setupSettingsHandlers(async () => undefined);
    const syncHandler = onHandlers.get('save-settings-sync');
    if (!syncHandler) {
      throw new Error('save-settings-sync handler not registered');
    }

    const event = { returnValue: null, sender: {} } as { returnValue: unknown; sender: object };
    syncHandler(event, { startOnLogin: true });

    expect(event.returnValue).toEqual({ success: false, error: 'Untrusted IPC sender' });
  });

  it('uses sync copy fallback when renameSync fails', async () => {
    trustedIpcSender = true;
    fsSyncMock.renameSync.mockImplementationOnce(() => {
      throw new Error('EXDEV');
    });
    const settingsManager = await import('../main/settingsManager');
    settingsManager.setupSettingsHandlers(async () => undefined);
    const syncHandler = onHandlers.get('save-settings-sync');
    if (!syncHandler) {
      throw new Error('save-settings-sync handler not registered');
    }

    const event = { returnValue: null, sender: {} } as { returnValue: unknown; sender: object };
    syncHandler(event, { startOnLogin: true });

    expect(fsSyncMock.copyFileSync).toHaveBeenCalledWith(
      '/tmp/iyeris-user/settings.json.sync-tmp',
      '/tmp/iyeris-user/settings.json'
    );
    expect(event.returnValue).toEqual({ success: true });
  });

  it('parses windows clipboard file list from FileNameW', async () => {
    const encoded = Buffer.from('C:\\a.txt\0D:\\b.txt\0\0', 'ucs2');
    clipboardMock.readBuffer.mockReturnValue(encoded);
    const settingsManager = await import('../main/settingsManager');
    settingsManager.setupSettingsHandlers(async () => undefined);
    const clipboardHandler = handleHandlers.get('get-system-clipboard-files');
    if (!clipboardHandler) {
      throw new Error('get-system-clipboard-files handler not registered');
    }

    const result = clipboardHandler({} as unknown) as string[];

    expect(result).toEqual(['C:\\a.txt', 'D:\\b.txt']);
  });
});
