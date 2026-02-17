import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const eventHandlers = new Map<string, (...args: any[]) => any>();
  const onceHandlers = new Map<string, (...args: any[]) => any>();
  const wcEventHandlers = new Map<string, (...args: any[]) => any>();

  const activeWindow = {
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    restore: vi.fn(),
    minimize: vi.fn(),
    isVisible: vi.fn().mockReturnValue(true),
    isDestroyed: vi.fn().mockReturnValue(false),
    isMinimized: vi.fn().mockReturnValue(false),
    isMaximized: vi.fn().mockReturnValue(false),
    on: vi.fn((event: string, handler: (...args: any[]) => any) => {
      eventHandlers.set(event, handler);
    }),
    once: vi.fn((event: string, handler: (...args: any[]) => any) => {
      onceHandlers.set(event, handler);
    }),
    loadFile: vi.fn(),
    setContentProtection: vi.fn(),
    webContents: {
      invalidate: vi.fn(),
      openDevTools: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => any) => {
        wcEventHandlers.set(event, handler);
      }),
    },
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
    eventHandlers,
    onceHandlers,
    wcEventHandlers,
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
    shellOpenExternal: vi.fn().mockResolvedValue(undefined),
    loggerError: vi.fn(),
    loggerWarn: vi.fn(),
    loggerInfo: vi.fn(),
    ignoreError: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: {
    quit: mocks.appQuit,
    name: 'IYERIS',
    dock: { show: vi.fn(), hide: vi.fn() },
    getVersion: vi.fn(() => '1.0.0'),
    getPath: vi.fn((name: string) => `/home/user/.config/${name}`),
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
    openExternal: mocks.shellOpenExternal,
  },
  IpcMainInvokeEvent: {},
}));

vi.mock('fs', () => ({
  existsSync: (...args: any[]) => (mocks.existsSync as any)(...args),
  default: { existsSync: (...args: any[]) => (mocks.existsSync as any)(...args) },
}));

vi.mock('../main/appState', () => ({
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

vi.mock('../main/settingsManager', () => ({
  loadSettings: (...args: any[]) => (mocks.loadSettings as any)(...args),
  getCachedSettings: () => mocks.getCachedSettings(),
}));

vi.mock('../main/logger', () => ({
  logger: {
    error: mocks.loggerError,
    warn: mocks.loggerWarn,
    info: mocks.loggerInfo,
  },
}));

vi.mock('../shared', () => ({
  ignoreError: mocks.ignoreError,
}));

vi.mock('../main/ipcUtils', () => ({
  isTrustedIpcEvent: mocks.isTrustedIpcEvent,
}));

import { createWindow, quitApp, showAppWindow, createTray } from '../main/windowManager';

describe('windowManager extended2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventHandlers.clear();
    mocks.onceHandlers.clear();
    mocks.wcEventHandlers.clear();
    mocks.getTray.mockReturnValue(null);
    mocks.existsSync.mockReturnValue(true);
    mocks.nativeImageResult.isEmpty.mockReturnValue(false);
    mocks.getIsQuitting.mockReturnValue(false);
    mocks.getShouldStartHidden.mockReturnValue(false);
    mocks.getIsDev.mockReturnValue(false);
    mocks.getMainWindow.mockReturnValue(mocks.activeWindow);
    mocks.getActiveWindow.mockReturnValue(mocks.activeWindow);
  });

  describe('createWindow event handlers', () => {
    it('registers ready-to-show handler that shows window', async () => {
      createWindow(false);
      const readyHandler = mocks.onceHandlers.get('ready-to-show');
      expect(readyHandler).toBeDefined();
      await readyHandler!();
      expect(mocks.activeWindow.show).toHaveBeenCalled();
    });

    it('ready-to-show hides window when startHidden is true', async () => {
      mocks.getShouldStartHidden.mockReturnValue(true);
      createWindow(true);
      const readyHandler = mocks.onceHandlers.get('ready-to-show');
      expect(readyHandler).toBeDefined();
      await readyHandler!();
      expect(mocks.activeWindow.hide).toHaveBeenCalled();
    });

    it('registers close handler', () => {
      createWindow(false);
      const closeHandler = mocks.eventHandlers.get('close');
      expect(closeHandler).toBeDefined();
    });

    it('close handler allows close when isQuitting', () => {
      createWindow(false);
      const closeHandler = mocks.eventHandlers.get('close');
      mocks.getIsQuitting.mockReturnValue(true);
      const event = { preventDefault: vi.fn() };
      closeHandler!(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('close handler minimizes to tray when enabled', async () => {
      mocks.getTray.mockReturnValue(mocks.tray);
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });
      createWindow(false);
      const closeHandler = mocks.eventHandlers.get('close');
      const event = { preventDefault: vi.fn() };
      closeHandler!(event);
      expect(event.preventDefault).toHaveBeenCalled();

      await vi.waitFor(() => {
        expect(mocks.activeWindow.hide).toHaveBeenCalled();
      });
    });

    it('close handler force-closes when minimizeToTray disabled', async () => {
      mocks.getTray.mockReturnValue(null);
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: false });
      createWindow(false);
      const closeHandler = mocks.eventHandlers.get('close');
      const event = { preventDefault: vi.fn() };
      closeHandler!(event);
      expect(event.preventDefault).toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(mocks.activeWindow.close).toHaveBeenCalled();
      });
    });

    it('registers minimize handler', () => {
      createWindow(false);
      const minimizeHandler = mocks.eventHandlers.get('minimize');
      expect(minimizeHandler).toBeDefined();
    });

    it('disables minimize-to-tray for window after tray creation fails once', async () => {
      mocks.getTray.mockReturnValue(null);
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });
      mocks.nativeImageResult.isEmpty.mockReturnValue(true);
      createWindow(false);
      const minimizeHandler = mocks.eventHandlers.get('minimize');
      expect(minimizeHandler).toBeDefined();

      await minimizeHandler!();
      await minimizeHandler!();

      const trayIconErrors = mocks.loggerError.mock.calls.filter((args: unknown[]) =>
        String(args[0]).includes('Failed to load tray icon from:')
      );
      expect(trayIconErrors).toHaveLength(1);
      expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
      expect(mocks.loggerWarn).toHaveBeenCalledWith(
        '[Tray] Tray unavailable; minimize-to-tray disabled for this window session'
      );
    });

    it('registers closed handler that updates mainWindow', () => {
      createWindow(false);
      const closedHandler = mocks.eventHandlers.get('closed');
      expect(closedHandler).toBeDefined();
      mocks.getMainWindow.mockReturnValue(mocks.activeWindow);
      closedHandler!();
      expect(mocks.setMainWindow).toHaveBeenCalled();
    });

    it('closed handler does not update if not main window', () => {
      createWindow(false);
      const closedHandler = mocks.eventHandlers.get('closed');
      mocks.getMainWindow.mockReturnValue({ notSameWindow: true } as any);
      closedHandler!();
      expect(mocks.setMainWindow).not.toHaveBeenCalled();
    });

    it('registers will-navigate handler', () => {
      createWindow(false);
      const navigateHandler = mocks.wcEventHandlers.get('will-navigate');
      expect(navigateHandler).toBeDefined();
    });

    it('will-navigate blocks non-main-page URLs', () => {
      createWindow(false);
      const navigateHandler = mocks.wcEventHandlers.get('will-navigate');
      const event = { preventDefault: vi.fn() };
      navigateHandler!(event, 'https://evil.com');
      expect(mocks.shellOpenExternal).toHaveBeenCalledWith('https://evil.com');
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('will-navigate blocks non-http URLs', () => {
      createWindow(false);
      const navigateHandler = mocks.wcEventHandlers.get('will-navigate');
      const event = { preventDefault: vi.fn() };
      navigateHandler!(event, 'ftp://evil.com/file');
      expect(event.preventDefault).toHaveBeenCalled();
      expect(mocks.shellOpenExternal).not.toHaveBeenCalled();
    });

    it('registers will-redirect handler', () => {
      createWindow(false);
      const redirectHandler = mocks.wcEventHandlers.get('will-redirect');
      expect(redirectHandler).toBeDefined();
    });

    it('will-redirect blocks non-main-page URLs', () => {
      createWindow(false);
      const redirectHandler = mocks.wcEventHandlers.get('will-redirect');
      const event = { preventDefault: vi.fn() };
      redirectHandler!(event, 'https://example.com');
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('setWindowOpenHandler blocks and opens external URLs', () => {
      createWindow(false);
      expect(mocks.activeWindow.webContents.setWindowOpenHandler).toHaveBeenCalled();
      const handler = mocks.activeWindow.webContents.setWindowOpenHandler.mock.calls[0][0];
      const result = handler({ url: 'https://example.com' });
      expect(result).toEqual({ action: 'deny' });
      expect(mocks.shellOpenExternal).toHaveBeenCalledWith('https://example.com');
    });

    it('setWindowOpenHandler blocks non-http URLs without opening', () => {
      createWindow(false);
      const handler = mocks.activeWindow.webContents.setWindowOpenHandler.mock.calls[0][0];
      const result = handler({ url: 'file:///etc/passwd' });
      expect(result).toEqual({ action: 'deny' });
      expect(mocks.shellOpenExternal).not.toHaveBeenCalled();
    });

    it('opens devtools in dev mode', () => {
      mocks.getIsDev.mockReturnValue(true);
      createWindow(false);
      expect(mocks.activeWindow.webContents.openDevTools).toHaveBeenCalled();
    });

    it('does not open devtools in production', () => {
      mocks.getIsDev.mockReturnValue(false);
      createWindow(false);
      expect(mocks.activeWindow.webContents.openDevTools).not.toHaveBeenCalled();
    });
  });

  describe('quitApp', () => {
    it('sets isQuitting and calls app.quit', () => {
      quitApp();
      expect(mocks.setIsQuitting).toHaveBeenCalledWith(true);
      expect(mocks.appQuit).toHaveBeenCalled();
    });
  });

  describe('showAppWindow', () => {
    it('shows and focuses existing window', () => {
      mocks.getActiveWindow.mockReturnValue(mocks.activeWindow);
      showAppWindow();
      expect(mocks.activeWindow.show).toHaveBeenCalled();
      expect(mocks.activeWindow.focus).toHaveBeenCalled();
    });

    it('invalidates on win32', () => {
      mocks.getActiveWindow.mockReturnValue(mocks.activeWindow);
      Object.defineProperty(process, 'platform', { value: 'win32' });
      showAppWindow();
      expect(mocks.activeWindow.webContents.invalidate).toHaveBeenCalled();
      Object.defineProperty(process, 'platform', { value: 'linux' });
    });
  });

  describe('tray click handlers', () => {
    it('darwin click toggles window visibility - hide', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });
      mocks.getTray.mockReturnValue(null);
      mocks.getActiveWindow.mockReturnValue(mocks.activeWindow);
      mocks.activeWindow.isVisible.mockReturnValue(true);

      await createTray();

      const clickHandler = mocks.tray.on.mock.calls.find((c: any[]) => c[0] === 'click')?.[1] as (
        ...args: any[]
      ) => void;
      expect(clickHandler).toBeDefined();

      clickHandler({ altKey: false, shiftKey: false, ctrlKey: false, metaKey: false });
      expect(mocks.activeWindow.hide).toHaveBeenCalled();
      Object.defineProperty(process, 'platform', { value: 'linux' });
    });

    it('darwin click toggles window visibility - show', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });
      mocks.getTray.mockReturnValue(null);
      mocks.getActiveWindow.mockReturnValue(mocks.activeWindow);
      mocks.activeWindow.isVisible.mockReturnValue(false);

      await createTray();

      const clickHandler = mocks.tray.on.mock.calls.find((c: any[]) => c[0] === 'click')?.[1] as (
        ...args: any[]
      ) => void;
      clickHandler({ altKey: false, shiftKey: false, ctrlKey: false, metaKey: false });
      expect(mocks.activeWindow.show).toHaveBeenCalled();
      expect(mocks.activeWindow.focus).toHaveBeenCalled();
      Object.defineProperty(process, 'platform', { value: 'linux' });
    });

    it('darwin click with modifier key does nothing', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });
      mocks.getTray.mockReturnValue(null);

      await createTray();

      const clickHandler = mocks.tray.on.mock.calls.find((c: any[]) => c[0] === 'click')?.[1] as (
        ...args: any[]
      ) => void;
      clickHandler({ altKey: true, shiftKey: false, ctrlKey: false, metaKey: false });
      expect(mocks.activeWindow.show).not.toHaveBeenCalled();
      expect(mocks.activeWindow.hide).not.toHaveBeenCalled();
      Object.defineProperty(process, 'platform', { value: 'linux' });
    });

    it('darwin right-click pops up context menu', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });
      mocks.getTray.mockReturnValue(null);

      await createTray();

      const rightClickHandler = mocks.tray.on.mock.calls.find(
        (c: any[]) => c[0] === 'right-click'
      )?.[1] as (...args: any[]) => void;
      expect(rightClickHandler).toBeDefined();
      rightClickHandler();
      expect(mocks.tray.popUpContextMenu).toHaveBeenCalled();
      Object.defineProperty(process, 'platform', { value: 'linux' });
    });

    it('non-darwin click toggles window - hide', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });
      mocks.getTray.mockReturnValue(null);
      mocks.getActiveWindow.mockReturnValue(mocks.activeWindow);
      mocks.activeWindow.isVisible.mockReturnValue(true);

      await createTray();

      const clickHandler = mocks.tray.on.mock.calls.find((c: any[]) => c[0] === 'click')?.[1] as (
        ...args: any[]
      ) => void;
      expect(clickHandler).toBeDefined();
      clickHandler();
      expect(mocks.activeWindow.hide).toHaveBeenCalled();
    });

    it('non-darwin click toggles window - show', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });
      mocks.getTray.mockReturnValue(null);
      mocks.getActiveWindow.mockReturnValue(mocks.activeWindow);
      mocks.activeWindow.isVisible.mockReturnValue(false);

      await createTray();

      const clickHandler = mocks.tray.on.mock.calls.find((c: any[]) => c[0] === 'click')?.[1] as (
        ...args: any[]
      ) => void;
      clickHandler();
      expect(mocks.activeWindow.show).toHaveBeenCalled();
      expect(mocks.activeWindow.focus).toHaveBeenCalled();
    });

    it('tray click creates window when no active window', async () => {
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });
      mocks.getTray.mockReturnValue(null);
      mocks.getActiveWindow.mockReturnValue(null as any);

      await createTray();

      const clickHandler = mocks.tray.on.mock.calls.find((c: any[]) => c[0] === 'click')?.[1] as (
        ...args: any[]
      ) => void;
      clickHandler();
    });

    it('tray creation failure sets tray to null', async () => {
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });
      mocks.getTray.mockReturnValue(null);

      const origTray = vi.mocked(await import('electron')).Tray;

      mocks.nativeImageResult.isEmpty.mockReturnValue(true);
      await createTray();
      expect(mocks.tray.setToolTip).not.toHaveBeenCalled();
    });
  });

  describe('resolveTrayIconPath fallbacks', () => {
    it('falls back to icon.png on darwin when primary and iconset missing', async () => {
      mocks.existsSync.mockReturnValue(false);
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });
      mocks.getTray.mockReturnValue(null);
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      await createTray();

      Object.defineProperty(process, 'platform', { value: 'linux' });
    });

    it('falls back to icon.png on linux when iconset missing', async () => {
      mocks.existsSync.mockReturnValue(false);
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });
      mocks.getTray.mockReturnValue(null);
      Object.defineProperty(process, 'platform', { value: 'linux' });

      await createTray();
    });

    it('falls back to icon.png on win32 when primary missing', async () => {
      mocks.existsSync.mockReturnValue(false);
      mocks.getCachedSettings.mockReturnValue({ minimizeToTray: true });
      mocks.getTray.mockReturnValue(null);
      Object.defineProperty(process, 'platform', { value: 'win32' });

      await createTray();
      Object.defineProperty(process, 'platform', { value: 'linux' });
    });
  });
});
