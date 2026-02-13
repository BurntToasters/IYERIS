import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeSettings } from '../types';

type Handler = (...args: any[]) => any;
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

describe('homeSettingsManager extended', () => {
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

  describe('reset-home-settings handler', () => {
    it('returns untrusted error when IPC event is not trusted', async () => {
      trustedIpc = false;
      const manager = await import('../main/homeSettingsManager');
      manager.setupHomeSettingsHandlers();
      const handler = handlers.get('reset-home-settings');
      expect(handler).toBeDefined();

      const result = await handler!({} as any);

      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('resets to default settings when trusted', async () => {
      trustedIpc = true;
      const manager = await import('../main/homeSettingsManager');
      manager.setupHomeSettingsHandlers();
      const handler = handlers.get('reset-home-settings');
      expect(handler).toBeDefined();

      const result = await handler!({} as any);

      expect(result).toEqual({ success: true });
      expect(createDefaultHomeSettingsMock).toHaveBeenCalled();
      expect(fsPromisesMock.writeFile).toHaveBeenCalled();
    });
  });

  describe('get-home-settings-path handler', () => {
    it('returns empty string when IPC event is not trusted', async () => {
      trustedIpc = false;
      const manager = await import('../main/homeSettingsManager');
      manager.setupHomeSettingsHandlers();
      const handler = handlers.get('get-home-settings-path');
      expect(handler).toBeDefined();

      const result = handler!({} as any);

      expect(result).toBe('');
    });

    it('returns the settings path when trusted', async () => {
      trustedIpc = true;
      const manager = await import('../main/homeSettingsManager');
      manager.setupHomeSettingsHandlers();
      const handler = handlers.get('get-home-settings-path');
      expect(handler).toBeDefined();

      const result = handler!({} as any);

      expect(result).toBe('/tmp/iyeris-user/homeSettings.json');
    });
  });

  describe('save-home-settings handler', () => {
    it('returns untrusted error when IPC event is not trusted', async () => {
      trustedIpc = false;
      const manager = await import('../main/homeSettingsManager');
      manager.setupHomeSettingsHandlers();
      const handler = handlers.get('save-home-settings');
      expect(handler).toBeDefined();

      const result = await handler!({ sender: {} } as any, { cards: [] } as any);

      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
      expect(fsPromisesMock.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('get-home-settings handler', () => {
    it('returns settings on success when trusted', async () => {
      trustedIpc = true;
      fsPromisesMock.readFile.mockResolvedValueOnce('{"cards":["a"]}');
      const manager = await import('../main/homeSettingsManager');
      manager.setupHomeSettingsHandlers();
      const handler = handlers.get('get-home-settings');
      expect(handler).toBeDefined();

      const result = await handler!({} as any);

      expect(result.success).toBe(true);
      expect(result.settings).toBeDefined();
    });

    it('returns error when loadHomeSettings throws', async () => {
      trustedIpc = true;

      sanitizeHomeSettingsMock.mockImplementation(() => {
        throw new Error('sanitize boom');
      });

      createDefaultHomeSettingsMock.mockImplementation(() => {
        throw new Error('defaults boom');
      });
      const manager = await import('../main/homeSettingsManager');
      manager.setupHomeSettingsHandlers();
      const handler = handlers.get('get-home-settings');
      expect(handler).toBeDefined();

      const result = await handler!({} as any);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('getHomeSettingsPath', () => {
    it('returns the correct path', async () => {
      const manager = await import('../main/homeSettingsManager');
      const result = manager.getHomeSettingsPath();
      expect(result).toBe('/tmp/iyeris-user/homeSettings.json');
    });
  });

  describe('saveHomeSettings edge cases', () => {
    it('returns error when writeFile fails', async () => {
      fsPromisesMock.writeFile.mockRejectedValueOnce(new Error('disk full'));
      const manager = await import('../main/homeSettingsManager');

      const result = await manager.saveHomeSettings({ cards: [] } as unknown as HomeSettings);

      expect(result).toEqual({ success: false, error: 'disk full' });
    });

    it('cleans up tmp file even when copyFile fails', async () => {
      fsPromisesMock.rename.mockRejectedValueOnce(new Error('EXDEV'));
      fsPromisesMock.copyFile.mockRejectedValueOnce(new Error('copy fail'));
      const manager = await import('../main/homeSettingsManager');

      const result = await manager.saveHomeSettings({ cards: [] } as unknown as HomeSettings);

      expect(result).toEqual({ success: false, error: 'copy fail' });
      expect(fsPromisesMock.unlink).toHaveBeenCalledWith('/tmp/iyeris-user/homeSettings.json.tmp');
    });
  });

  describe('loadHomeSettings edge cases', () => {
    it('returns defaults when settings file does not exist', async () => {
      fsPromisesMock.readFile.mockRejectedValueOnce(new Error('ENOENT'));
      const manager = await import('../main/homeSettingsManager');

      const result = await manager.loadHomeSettings();

      expect(result).toEqual(defaultHomeSettings);
      expect(createDefaultHomeSettingsMock).toHaveBeenCalled();
    });

    it('handles backup rename failure for corrupt file gracefully', async () => {
      fsPromisesMock.readFile.mockResolvedValueOnce('not-json!!!');
      fsPromisesMock.rename.mockRejectedValueOnce(new Error('rename fail'));
      const manager = await import('../main/homeSettingsManager');

      const result = await manager.loadHomeSettings();

      expect(result).toEqual(defaultHomeSettings);
    });
  });
});
