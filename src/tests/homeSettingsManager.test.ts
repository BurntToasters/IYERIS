import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import type { HomeSettings } from '../types';

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();

const appMock = {
  getPath: vi.fn((name: string) => (name === 'userData' ? '/tmp/iyeris-user' : '/tmp')),
};

const browserWindowMock = {
  fromWebContents: vi.fn(),
  getAllWindows: vi.fn(() => [] as unknown[]),
};

const fsPromisesMock = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  copyFile: vi.fn(),
  unlink: vi.fn(),
};

let trustedIpc = true;
function mergeHomeSettings(input: unknown, defaults: HomeSettings): HomeSettings {
  return {
    ...(defaults as unknown as Record<string, unknown>),
    ...(input as Record<string, unknown>),
  } as unknown as HomeSettings;
}

const defaultHomeSettings = { cards: [] } as unknown as HomeSettings;
const createDefaultHomeSettingsMock = vi.fn(() => ({ ...defaultHomeSettings }));
const sanitizeHomeSettingsMock = vi.fn((input: unknown, defaults: HomeSettings) =>
  mergeHomeSettings(input, defaults)
);

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
  },
  app: appMock,
  BrowserWindow: browserWindowMock,
}));

vi.mock('fs', () => ({
  promises: fsPromisesMock,
}));

vi.mock('../main/appState', () => ({
  SETTINGS_CACHE_TTL_MS: 30000,
}));

vi.mock('../homeSettings', () => ({
  createDefaultHomeSettings: createDefaultHomeSettingsMock,
  sanitizeHomeSettings: sanitizeHomeSettingsMock,
}));

vi.mock('../main/security', () => ({
  getErrorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error)
  ),
}));

vi.mock('../shared', () => ({
  ignoreError: vi.fn(),
}));

vi.mock('../main/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../main/ipcUtils', () => ({
  isTrustedIpcEvent: vi.fn(() => trustedIpc),
}));

describe('homeSettingsManager', () => {
  beforeEach(() => {
    vi.resetModules();
    handlers.clear();
    trustedIpc = true;

    appMock.getPath.mockReset();
    appMock.getPath.mockImplementation((name: string) =>
      name === 'userData' ? '/tmp/iyeris-user' : '/tmp'
    );

    browserWindowMock.fromWebContents.mockReset();
    browserWindowMock.getAllWindows.mockReset();
    browserWindowMock.getAllWindows.mockReturnValue([]);

    fsPromisesMock.readFile.mockReset();
    fsPromisesMock.readFile.mockResolvedValue('{"cards":[],"showWelcome":true}');
    fsPromisesMock.writeFile.mockReset();
    fsPromisesMock.writeFile.mockResolvedValue(undefined);
    fsPromisesMock.rename.mockReset();
    fsPromisesMock.rename.mockResolvedValue(undefined);
    fsPromisesMock.copyFile.mockReset();
    fsPromisesMock.copyFile.mockResolvedValue(undefined);
    fsPromisesMock.unlink.mockReset();
    fsPromisesMock.unlink.mockResolvedValue(undefined);

    createDefaultHomeSettingsMock.mockReset();
    createDefaultHomeSettingsMock.mockReturnValue({ ...defaultHomeSettings });
    sanitizeHomeSettingsMock.mockReset();
    sanitizeHomeSettingsMock.mockImplementation((input: unknown, defaults: HomeSettings) =>
      mergeHomeSettings(input, defaults)
    );
  });

  it('caches home settings within TTL', async () => {
    fsPromisesMock.readFile.mockResolvedValueOnce('{"showWelcome":false}');
    const manager = await import('../main/homeSettingsManager');

    const first = await manager.loadHomeSettings();
    const second = await manager.loadHomeSettings();

    expect(fsPromisesMock.readFile).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect((first as unknown as { showWelcome: boolean }).showWelcome).toBe(false);
  });

  it('backs up corrupt home settings and falls back to defaults', async () => {
    fsPromisesMock.readFile.mockResolvedValueOnce('{broken-json');
    const manager = await import('../main/homeSettingsManager');

    const loaded = await manager.loadHomeSettings();

    expect(fsPromisesMock.rename).toHaveBeenCalledWith(
      path.join('/tmp/iyeris-user', 'homeSettings.json'),
      expect.stringContaining(path.join('/tmp/iyeris-user', 'homeSettings.json.corrupt-'))
    );
    expect(loaded).toEqual(defaultHomeSettings);
  });

  it('falls back to copy+unlink when save rename fails', async () => {
    fsPromisesMock.rename.mockRejectedValueOnce(new Error('EXDEV'));
    const manager = await import('../main/homeSettingsManager');

    const result = await manager.saveHomeSettings({ cards: ['a'] } as unknown as HomeSettings);

    expect(result).toEqual({ success: true });
    expect(fsPromisesMock.copyFile).toHaveBeenCalledWith(
      path.join('/tmp/iyeris-user', 'homeSettings.json.tmp'),
      path.join('/tmp/iyeris-user', 'homeSettings.json')
    );
    expect(fsPromisesMock.unlink).toHaveBeenCalledWith(
      path.join('/tmp/iyeris-user', 'homeSettings.json.tmp')
    );
  });

  it('returns untrusted response for get-home-settings handler', async () => {
    trustedIpc = false;
    const manager = await import('../main/homeSettingsManager');
    manager.setupHomeSettingsHandlers();
    const handler = handlers.get('get-home-settings');
    if (!handler) throw new Error('get-home-settings handler missing');

    const result = (await handler({} as unknown)) as { success: boolean; error?: string };

    expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
  });

  it('broadcasts save-home-settings updates to other windows', async () => {
    trustedIpc = true;
    const senderWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };
    const otherWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };
    const destroyedWindow = {
      isDestroyed: () => true,
      webContents: { send: vi.fn() },
    };
    browserWindowMock.fromWebContents.mockReturnValue(senderWindow);
    browserWindowMock.getAllWindows.mockReturnValue([senderWindow, otherWindow, destroyedWindow]);

    const manager = await import('../main/homeSettingsManager');
    manager.setupHomeSettingsHandlers();
    const handler = handlers.get('save-home-settings');
    if (!handler) throw new Error('save-home-settings handler missing');

    const result = (await handler(
      { sender: {} } as unknown,
      { cards: ['x'] } as unknown as HomeSettings
    )) as { success: boolean };

    expect(result.success).toBe(true);
    expect(otherWindow.webContents.send).toHaveBeenCalledWith(
      'home-settings-changed',
      expect.objectContaining({ cards: ['x'] })
    );
    expect(senderWindow.webContents.send).not.toHaveBeenCalled();
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  });
});
