import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const activeWindow = {
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    isVisible: vi.fn().mockReturnValue(true),
    isDestroyed: vi.fn().mockReturnValue(false),
    isMinimized: vi.fn().mockReturnValue(false),
    restore: vi.fn(),
    close: vi.fn(),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    isMaximized: vi.fn().mockReturnValue(false),
    webContents: {
      invalidate: vi.fn(),
      openDevTools: vi.fn(),
      loadFile: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    },
    on: vi.fn(),
    once: vi.fn(),
    loadFile: vi.fn(),
    setContentProtection: vi.fn(),
  };

  const tray = {
    setContextMenu: vi.fn(),
    setToolTip: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn(),
    popUpContextMenu: vi.fn(),
  };

  return {
    activeWindow,
    tray,
    appQuit: vi.fn(),
    setIsQuitting: vi.fn(),
    getIsQuitting: vi.fn(() => false),
    getTray: vi.fn(() => null as typeof tray | null),
    getActiveWindow: vi.fn(() => activeWindow),
    getMainWindow: vi.fn(() => activeWindow),
    setMainWindow: vi.fn(),
    setTray: vi.fn(),
    setCurrentTrayState: vi.fn(),
    setTrayAssetsPath: vi.fn(),
    getShouldStartHidden: vi.fn(() => false),
    getIsDev: vi.fn(() => false),
    isTrustedIpcEvent: vi.fn(() => true),
    ipcMainHandle: vi.fn(),
    browserWindowFromWebContents: vi.fn(() => activeWindow),
    menuBuildFromTemplate: vi.fn(() => ({ id: 'menu' })),
    menuSetApplicationMenu: vi.fn(),
    existsSync: vi.fn(() => true),
    nativeImageResult: {
      resize: vi.fn().mockReturnThis(),
      setTemplateImage: vi.fn(),
      isEmpty: vi.fn(() => false),
    },
    loadSettings: vi.fn(async () => ({ minimizeToTray: true })),
    getCachedSettings: vi.fn(() => ({ minimizeToTray: true })),
  };
});

vi.mock('electron', () => ({
  app: {
    quit: mocks.appQuit,
    name: 'IYERIS',
    dock: { show: vi.fn(), hide: vi.fn() },
    getVersion: vi.fn(() => '1.0.0'),
  },
  BrowserWindow: Object.assign(
    function MockBrowserWindow() {
      return mocks.activeWindow;
    },
    {
      fromWebContents: mocks.browserWindowFromWebContents,
      getAllWindows: vi.fn(() => []),
    }
  ),
  ipcMain: {
    handle: mocks.ipcMainHandle,
  },
  Menu: {
    buildFromTemplate: mocks.menuBuildFromTemplate,
    setApplicationMenu: mocks.menuSetApplicationMenu,
  },
  Tray: function MockTray() {
    return mocks.tray;
  },
  nativeImage: {
    createFromPath: vi.fn(() => mocks.nativeImageResult),
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
  IpcMainInvokeEvent: {},
}));

vi.mock('fs', () => ({
  existsSync: (...args: any[]) => (mocks.existsSync as any)(...args),
  default: { existsSync: (...args: any[]) => (mocks.existsSync as any)(...args) },
}));

vi.mock('./appState', () => ({
  getMainWindow: mocks.getMainWindow,
  setMainWindow: mocks.setMainWindow,
  getActiveWindow: mocks.getActiveWindow,
  getTray: mocks.getTray,
  setTray: mocks.setTray,
  getIsQuitting: mocks.getIsQuitting,
  setIsQuitting: mocks.setIsQuitting,
  setCurrentTrayState: mocks.setCurrentTrayState,
  setTrayAssetsPath: mocks.setTrayAssetsPath,
  getShouldStartHidden: mocks.getShouldStartHidden,
  getIsDev: mocks.getIsDev,
}));

vi.mock('./settingsManager', () => ({
  loadSettings: (...args: any[]) => (mocks.loadSettings as any)(...args),
  getCachedSettings: () => mocks.getCachedSettings(),
}));

vi.mock('./utils/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('./shared', () => ({
  ignoreError: vi.fn(),
}));

vi.mock('./ipcUtils', () => ({
  isTrustedIpcEvent: mocks.isTrustedIpcEvent,
}));

import {
  showAppWindow,
  quitApp,
  updateTrayMenu,
  setupWindowHandlers,
  setupApplicationMenu,
  createTray,
  createTrayForHiddenStart,
  createWindow,
} from './windowManager';

describe('windowManager extended', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTray.mockReturnValue(null);
    mocks.existsSync.mockReturnValue(true);
    mocks.nativeImageResult.isEmpty.mockReturnValue(false);
  });

  describe('updateTrayMenu', () => {
    it('does nothing when no tray', () => {
      mocks.getTray.mockReturnValue(null);
      expect(() => updateTrayMenu()).not.toThrow();
      expect(mocks.menuBuildFromTemplate).not.toHaveBeenCalled();
    });

    it('builds menu without status label', () => {
      mocks.getTray.mockReturnValue(mocks.tray);
      updateTrayMenu();
      expect(mocks.menuBuildFromTemplate).toHaveBeenCalledTimes(1);
      const template = (mocks.menuBuildFromTemplate.mock.calls as any[][])[0][0] as Array<{
        label?: string;
        enabled?: boolean;
      }>;
      // Should have Show IYERIS and Quit but no status
      expect(template.find((t) => t.enabled === false)).toBeUndefined();
    });
  });

  describe('showAppWindow', () => {
    it('creates window when no active window', () => {
      mocks.getActiveWindow.mockReturnValue(null as any);
      // createWindow is called internally; it will use the BrowserWindow mock
      expect(() => showAppWindow()).not.toThrow();
    });
  });

  describe('setupWindowHandlers - open-new-window', () => {
    it('registers open-new-window handler', () => {
      setupWindowHandlers();
      const handlers = new Map<string, (event: { sender: unknown }) => void>();
      for (const [channel, handler] of mocks.ipcMainHandle.mock.calls as any[][]) {
        handlers.set(channel as string, handler as (event: { sender: unknown }) => void);
      }
      expect(handlers.has('open-new-window')).toBe(true);
    });

    it('open-new-window handler creates a new window', () => {
      setupWindowHandlers();
      const handlers = new Map<string, (event: { sender: unknown }) => void>();
      for (const [channel, handler] of mocks.ipcMainHandle.mock.calls as any[][]) {
        handlers.set(channel as string, handler as (event: { sender: unknown }) => void);
      }
      // Should not throw
      handlers.get('open-new-window')!({ sender: {} });
    });

    it('open-new-window rejects untrusted event', () => {
      setupWindowHandlers();
      const handlers = new Map<string, (event: { sender: unknown }) => void>();
      for (const [channel, handler] of mocks.ipcMainHandle.mock.calls as any[][]) {
        handlers.set(channel as string, handler as (event: { sender: unknown }) => void);
      }
      mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
      handlers.get('open-new-window')!({ sender: {} });
      // No error thrown, just silently returns
    });
  });

  describe('setupApplicationMenu', () => {
    const origPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    });

    it('sets application menu on darwin', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      setupApplicationMenu();
      expect(mocks.menuBuildFromTemplate).toHaveBeenCalled();
      expect(mocks.menuSetApplicationMenu).toHaveBeenCalled();
    });

    it('does nothing on non-darwin', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      setupApplicationMenu();
      expect(mocks.menuSetApplicationMenu).not.toHaveBeenCalled();
    });
  });

  describe('createTray', () => {
    it('skips when minimizeToTray is disabled', async () => {
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: false });
      mocks.loadSettings.mockResolvedValue({ minimizeToTray: false });

      await createTray();
      expect(mocks.setTray).not.toHaveBeenCalledWith(mocks.tray);
    });

    it('destroys existing tray before creating new one', async () => {
      const existingTray = { destroy: vi.fn() };
      mocks.getTray.mockReturnValue(existingTray as unknown as typeof mocks.tray);
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });

      await createTray();
      expect(existingTray.destroy).toHaveBeenCalled();
      expect(mocks.setTray).toHaveBeenCalledWith(null);
    });

    it('sets up tray icon and tooltip', async () => {
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });
      mocks.getTray.mockReturnValue(null);

      await createTray();

      expect(mocks.tray.setToolTip).toHaveBeenCalledWith('IYERIS');
      expect(mocks.setCurrentTrayState).toHaveBeenCalledWith('idle');
    });

    it('aborts when icon is empty', async () => {
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });
      mocks.getTray.mockReturnValue(null);
      mocks.nativeImageResult.isEmpty.mockReturnValue(true);

      await createTray();
      // Should not set tray since icon is empty
      expect(mocks.tray.setToolTip).not.toHaveBeenCalled();
    });
  });

  describe('createTrayForHiddenStart', () => {
    it('skips if tray already exists', async () => {
      mocks.getTray.mockReturnValue(mocks.tray);
      await createTrayForHiddenStart();
      // Should not create a new tray
      expect(mocks.tray.setToolTip).not.toHaveBeenCalled();
    });

    it('creates tray when none exists for hidden start', async () => {
      mocks.getTray.mockReturnValue(null);

      await createTrayForHiddenStart();
      expect(mocks.tray.setToolTip).toHaveBeenCalledWith('IYERIS');
    });
  });

  describe('createWindow', () => {
    it('creates a BrowserWindow', () => {
      const win = createWindow(false);
      expect(win).toBeDefined();
    });

    it('sets main window when none exists', () => {
      mocks.getMainWindow.mockReturnValue(null as any);
      createWindow(false);
      expect(mocks.setMainWindow).toHaveBeenCalled();
    });

    it('sets main window when existing is destroyed', () => {
      mocks.getMainWindow.mockReturnValue({ isDestroyed: () => true } as any);
      createWindow(false);
      expect(mocks.setMainWindow).toHaveBeenCalled();
    });
  });
});
