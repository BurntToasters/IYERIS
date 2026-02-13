import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    },
  };

  const tray = {
    setContextMenu: vi.fn(),
  };

  return {
    activeWindow,
    tray,
    appQuit: vi.fn(),
    setIsQuitting: vi.fn(),
    getTray: vi.fn(() => tray),
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
  };
});

vi.mock('electron', () => ({
  app: {
    quit: mocks.appQuit,
    name: 'IYERIS',
    dock: { show: vi.fn(), hide: vi.fn() },
    getVersion: vi.fn(() => '1.0.0'),
  },
  BrowserWindow: Object.assign(class MockBrowserWindow {}, {
    fromWebContents: mocks.browserWindowFromWebContents,
    getAllWindows: vi.fn(() => []),
  }),
  ipcMain: {
    handle: mocks.ipcMainHandle,
  },
  Menu: {
    buildFromTemplate: mocks.menuBuildFromTemplate,
    setApplicationMenu: mocks.menuSetApplicationMenu,
  },
  Tray: class MockTray {},
  nativeImage: {
    createFromPath: vi.fn(() => ({
      resize: vi.fn().mockReturnThis(),
      setTemplateImage: vi.fn(),
      isEmpty: vi.fn(() => false),
    })),
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../main/appState', () => ({
  getMainWindow: mocks.getMainWindow,
  setMainWindow: mocks.setMainWindow,
  getActiveWindow: mocks.getActiveWindow,
  getTray: mocks.getTray,
  setTray: mocks.setTray,
  getIsQuitting: vi.fn(() => false),
  setIsQuitting: mocks.setIsQuitting,
  setCurrentTrayState: mocks.setCurrentTrayState,
  setTrayAssetsPath: mocks.setTrayAssetsPath,
  getShouldStartHidden: mocks.getShouldStartHidden,
  getIsDev: mocks.getIsDev,
}));

vi.mock('../main/settingsManager', () => ({
  loadSettings: vi.fn().mockResolvedValue({ minimizeToTray: true }),
  getCachedSettings: vi.fn(() => ({ minimizeToTray: true })),
}));

vi.mock('../main/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../shared', () => ({
  ignoreError: vi.fn(),
}));

vi.mock('../main/ipcUtils', () => ({
  isTrustedIpcEvent: mocks.isTrustedIpcEvent,
}));

import { quitApp, setupWindowHandlers, showAppWindow, updateTrayMenu } from '../main/windowManager';

describe('windowManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates tray context menu with status and actions', () => {
    updateTrayMenu('Busy');

    expect(mocks.menuBuildFromTemplate).toHaveBeenCalledTimes(1);
    const firstCall = (mocks.menuBuildFromTemplate.mock.calls as unknown as Array<[unknown]>)[0];
    const template = (firstCall?.[0] ?? []) as Array<{
      label?: string;
      enabled?: boolean;
    }>;
    expect(template.some((item) => item.label === 'Busy' && item.enabled === false)).toBe(true);
    expect(template.some((item) => item.label === 'Show IYERIS')).toBe(true);
    expect(template.some((item) => item.label === 'Quit')).toBe(true);
    expect(mocks.tray.setContextMenu).toHaveBeenCalledWith({ id: 'menu' });
  });

  it('shows and focuses active window', () => {
    showAppWindow();

    expect(mocks.activeWindow.show).toHaveBeenCalledTimes(1);
    expect(mocks.activeWindow.focus).toHaveBeenCalledTimes(1);
  });

  it('marks app as quitting and quits', () => {
    quitApp();
    expect(mocks.setIsQuitting).toHaveBeenCalledWith(true);
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
  });

  it('registers trusted IPC handlers and executes them against sender window', () => {
    setupWindowHandlers();

    const handlers = new Map<string, (event: { sender: unknown }) => void>();
    for (const [channel, handler] of mocks.ipcMainHandle.mock.calls) {
      handlers.set(channel as string, handler as (event: { sender: unknown }) => void);
    }

    const event = { sender: {} };

    handlers.get('minimize-window')!(event);
    expect(mocks.activeWindow.minimize).toHaveBeenCalledTimes(1);

    mocks.activeWindow.isMaximized.mockReturnValueOnce(true);
    handlers.get('maximize-window')!(event);
    expect(mocks.activeWindow.unmaximize).toHaveBeenCalledTimes(1);

    mocks.activeWindow.isMaximized.mockReturnValueOnce(false);
    handlers.get('maximize-window')!(event);
    expect(mocks.activeWindow.maximize).toHaveBeenCalledTimes(1);

    handlers.get('close-window')!(event);
    expect(mocks.activeWindow.close).toHaveBeenCalledTimes(1);
  });

  it('rejects untrusted IPC events', () => {
    setupWindowHandlers();
    const handlers = new Map<string, (event: { sender: unknown }) => void>();
    for (const [channel, handler] of mocks.ipcMainHandle.mock.calls) {
      handlers.set(channel as string, handler as (event: { sender: unknown }) => void);
    }

    mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
    handlers.get('minimize-window')!({ sender: {} });

    expect(mocks.activeWindow.minimize).not.toHaveBeenCalled();
  });
});
