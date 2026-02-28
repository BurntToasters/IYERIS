import type { IpcMainInvokeEvent } from 'electron';
import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell } from 'electron';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as fsSync from 'fs';
import {
  getMainWindow,
  setMainWindow,
  getActiveWindow,
  getTray,
  setTray,
  getIsQuitting,
  setIsQuitting,
  setCurrentTrayState,
  setTrayAssetsPath,
  getShouldStartHidden,
  getIsDev,
} from './appState';
import { loadSettings, getCachedSettings } from './settingsManager';
import { logger } from './logger';
import { ignoreError } from '../shared';
import { isTrustedIpcEvent } from './ipcUtils';

type TrayState = 'idle' | 'active' | 'notification';
type TrayPlatform = 'darwin' | 'win32' | 'linux';

const allowCloseWindows = new WeakSet<BrowserWindow>();
const windowVisibility = new WeakMap<BrowserWindow, boolean>();
let visibleWindowCount = 0;

const TRAY_ICON_FILES: Record<TrayPlatform, Record<TrayState, string>> = {
  darwin: {
    idle: 'icon-tray-Template.png',
    active: 'icon-tray-Template.png',
    notification: 'icon-tray-Template.png',
  },
  win32: { idle: 'icon-square.ico', active: 'icon-square.ico', notification: 'icon-square.ico' },
  linux: {
    idle: 'icon_32x32@1x.png',
    active: 'icon_32x32@1x.png',
    notification: 'icon_32x32@1x.png',
  },
};

const TRAY_ICON_SIZES: Record<TrayPlatform, { width: number; height: number }> = {
  darwin: { width: 22, height: 22 },
  win32: { width: 16, height: 16 },
  linux: { width: 24, height: 24 },
};

const TRAY_ASSETS_PATH = path.join(__dirname, '..', '..', 'assets');
const INDEX_PATH = path.join(__dirname, '..', '..', 'src', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_PATH).toString();
const INDEX_URL_OBJ = new URL(INDEX_URL);
const trayIconCache = new Map<string, { path: string; icon: Electron.NativeImage }>();
let trayContextMenu: Menu | null = null;

function existingPath(paths: string[]): string | null {
  for (const candidate of paths) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveTrayAssetsPath(): string {
  const candidates = new Set<string>([TRAY_ASSETS_PATH]);

  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    candidates.add(path.join(process.resourcesPath, 'assets'));
  }

  if (typeof app.getAppPath === 'function') {
    try {
      candidates.add(path.join(app.getAppPath(), 'assets'));
    } catch {
      // Ignore app path lookup failures and continue trying other candidates.
    }
  }

  candidates.add(path.join(process.cwd(), 'assets'));

  const resolved = existingPath(Array.from(candidates));
  return resolved ?? TRAY_ASSETS_PATH;
}

function getTrayPlatform(): TrayPlatform {
  if (
    process.platform === 'darwin' ||
    process.platform === 'win32' ||
    process.platform === 'linux'
  ) {
    return process.platform;
  }
  return 'linux';
}

function resolveTrayIconPath(
  trayAssetsPath: string,
  platform: TrayPlatform,
  state: TrayState
): string {
  const iconFile = TRAY_ICON_FILES[platform][state];

  if (platform === 'darwin') {
    const iconPath = path.join(trayAssetsPath, iconFile);
    if (fsSync.existsSync(iconPath)) {
      return iconPath;
    }
    const fallbackPath = path.join(trayAssetsPath, 'iyeris.iconset', 'icon_32x32@1x.png');
    if (fsSync.existsSync(fallbackPath)) {
      return fallbackPath;
    }
    return path.join(trayAssetsPath, 'icon.png');
  }

  if (platform === 'linux') {
    const iconPath = existingPath([
      path.join(trayAssetsPath, 'iyeris.iconset', iconFile),
      path.join(trayAssetsPath, 'icon-square.png'),
      path.join(trayAssetsPath, 'icon.png'),
    ]);
    return iconPath ?? path.join(trayAssetsPath, 'icon.png');
  }

  const iconPath = path.join(trayAssetsPath, iconFile);
  if (fsSync.existsSync(iconPath)) {
    return iconPath;
  }
  return path.join(trayAssetsPath, 'icon.png');
}

function getTrayIcon(
  trayAssetsPath: string,
  platform: TrayPlatform,
  state: TrayState
): { path: string; icon: Electron.NativeImage } {
  const cacheKey = `${trayAssetsPath}:${platform}:${state}`;
  const cached = trayIconCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const iconPath = resolveTrayIconPath(trayAssetsPath, platform, state);
  let icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty() && (platform !== 'win32' || !iconPath.endsWith('.ico'))) {
    const resizedIcon = icon.resize(TRAY_ICON_SIZES[platform] || TRAY_ICON_SIZES.linux);
    if (!resizedIcon.isEmpty()) {
      icon = resizedIcon;
    }
  }
  if (platform === 'darwin') {
    icon.setTemplateImage(true);
  }

  const result = { path: iconPath, icon };
  if (!icon.isEmpty()) {
    trayIconCache.set(cacheKey, result);
  }
  return result;
}

function setWindowVisibility(win: BrowserWindow, isVisible: boolean): void {
  const prevVisible = windowVisibility.get(win) ?? false;
  if (prevVisible === isVisible) {
    return;
  }
  windowVisibility.set(win, isVisible);
  visibleWindowCount += isVisible ? 1 : -1;
  if (visibleWindowCount < 0) {
    visibleWindowCount = 0;
  }
}

function trackWindowVisibility(win: BrowserWindow): void {
  setWindowVisibility(win, win.isVisible());
  win.on('show', () => setWindowVisibility(win, true));
  win.on('hide', () => setWindowVisibility(win, false));
  win.on('closed', () => setWindowVisibility(win, false));
}

function getVisibleWindowCount(): number {
  return visibleWindowCount;
}

export function showAppWindow(): void {
  const targetWindow = getActiveWindow();
  if (targetWindow) {
    targetWindow.show();
    setWindowVisibility(targetWindow, true);
    targetWindow.focus();
    if (process.platform === 'win32') {
      targetWindow.webContents.invalidate();
    }
  } else {
    createWindow(false);
  }
  if (process.platform === 'darwin') {
    app.dock?.show();
  }
}

export function quitApp(): void {
  setIsQuitting(true);
  app.quit();
}

export function updateTrayMenu(status?: string): void {
  const tray = getTray();
  if (!tray) return;
  const menuItems: Electron.MenuItemConstructorOptions[] = [];

  if (status) {
    menuItems.push({ label: status, enabled: false });
    menuItems.push({ type: 'separator' });
  }

  menuItems.push({ label: 'Show IYERIS', click: showAppWindow });
  menuItems.push({ type: 'separator' });
  menuItems.push({ label: 'Quit', click: quitApp });

  const menu = Menu.buildFromTemplate(menuItems);
  trayContextMenu = menu;
  if (process.platform === 'darwin') {
    tray.setContextMenu(null);
  } else {
    tray.setContextMenu(menu);
  }
}

export function createWindow(isInitialWindow: boolean = false): BrowserWindow {
  const isDev = getIsDev();
  const shouldStartHidden = getShouldStartHidden();

  const isMac = process.platform === 'darwin';
  const backgroundThrottling = process.platform !== 'win32';

  const newWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    frame: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 12, y: 10 } : undefined,
    resizable: true,
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      devTools: isDev,
      backgroundThrottling,
      spellcheck: false,
      v8CacheOptions: 'code',
      enableWebSQL: false,
      plugins: false,
      webgl: false,
      images: true,
      autoplayPolicy: 'user-gesture-required',
      defaultEncoding: 'UTF-8',
    },
    icon: (() => {
      const version = app.getVersion();
      const isBeta = /-(beta|alpha|rc)/i.test(version);
      const iconName = isBeta ? 'icon-beta.png' : 'icon.png';
      const iconPath = path.join(__dirname, '..', '..', 'assets', iconName);
      logger.info(`[Window] Version: ${version}, isBeta: ${isBeta}, icon: ${iconName}`);
      logger.info(`[Window] Icon path: ${iconPath}`);
      return iconPath;
    })(),
  });

  trackWindowVisibility(newWindow);
  let minimizeToTrayUnavailable = false;

  newWindow.loadFile(INDEX_PATH);

  const isMainPageUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      return parsed.origin === INDEX_URL_OBJ.origin && parsed.pathname === INDEX_URL_OBJ.pathname;
    } catch {
      return false;
    }
  };

  const openExternalIfAllowed = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol === 'http:' ||
        parsed.protocol === 'https:' ||
        parsed.protocol === 'mailto:'
      ) {
        shell.openExternal(url).catch((error) => {
          logger.error('[Security] Failed to open external URL:', error);
        });
        return true;
      }
    } catch (error) {
      ignoreError(error);
    }
    return false;
  };

  newWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (openExternalIfAllowed(url)) {
      return { action: 'deny' };
    }
    logger.warn('[Security] Blocked window.open to:', url);
    return { action: 'deny' };
  });

  newWindow.webContents.on('will-navigate', (event, url) => {
    if (!isMainPageUrl(url)) {
      if (openExternalIfAllowed(url)) {
        event.preventDefault();
        return;
      }
      logger.warn('[Security] Blocked navigation to:', url);
      event.preventDefault();
    }
  });

  newWindow.webContents.on('will-redirect', (event, url) => {
    if (!isMainPageUrl(url)) {
      if (openExternalIfAllowed(url)) {
        event.preventDefault();
        return;
      }
      logger.warn('[Security] Blocked redirect to:', url);
      event.preventDefault();
    }
  });

  const startHidden = isInitialWindow && shouldStartHidden;
  logger.info(
    '[Window] Creating window, isInitial:',
    isInitialWindow,
    'startHidden:',
    startHidden,
    'shouldStartHidden:',
    shouldStartHidden
  );

  newWindow.once('ready-to-show', async () => {
    if (startHidden) {
      logger.info('[Window] Starting minimized to tray');
      const tray = getTray();
      if (!tray) {
        await createTray();
      }
      newWindow.hide();
      setWindowVisibility(newWindow, false);
      if (process.platform === 'darwin') {
        app.dock?.hide();
      }
    } else {
      newWindow.show();
      setWindowVisibility(newWindow, true);
    }
  });

  newWindow.on('close', (event) => {
    if (getIsQuitting() || allowCloseWindows.has(newWindow)) {
      return;
    }

    event.preventDefault();

    void (async () => {
      const settings = getCachedSettings() ?? (await loadSettings());
      let tray = getTray();
      if (settings.minimizeToTray && !tray && !minimizeToTrayUnavailable) {
        await createTray();
        tray = getTray();
        if (!tray) {
          minimizeToTrayUnavailable = true;
          logger.warn('[Tray] Tray unavailable; minimize-to-tray disabled for this window session');
        }
      }
      if (settings.minimizeToTray && tray) {
        newWindow.hide();
        setWindowVisibility(newWindow, false);
        if (process.platform === 'darwin') {
          if (getVisibleWindowCount() === 0) {
            app.dock?.hide();
          }
        }
        return;
      }

      allowCloseWindows.add(newWindow);
      newWindow.close();
    })();
  });

  newWindow.on('minimize', async () => {
    const settings = getCachedSettings() ?? (await loadSettings());
    let tray = getTray();
    if (settings.minimizeToTray && !tray && !minimizeToTrayUnavailable) {
      await createTray();
      tray = getTray();
      if (!tray) {
        minimizeToTrayUnavailable = true;
        logger.warn('[Tray] Tray unavailable; minimize-to-tray disabled for this window session');
      }
    }
    if (settings.minimizeToTray && tray) {
      if (process.platform === 'darwin') {
        setImmediate(() => {
          newWindow.hide();
          setWindowVisibility(newWindow, false);
          if (getVisibleWindowCount() === 0) {
            app.dock?.hide();
          }
        });
      } else {
        setImmediate(() => {
          if (!newWindow.isDestroyed()) {
            newWindow.restore();
            setImmediate(() => {
              if (!newWindow.isDestroyed()) {
                newWindow.hide();
                setWindowVisibility(newWindow, false);
              }
            });
          }
        });
      }
    }
  });

  if (isDev) {
    newWindow.webContents.openDevTools();
  }

  newWindow.on('closed', () => {
    const mainWindow = getMainWindow();
    if (mainWindow === newWindow) {
      const allWindows = BrowserWindow.getAllWindows();
      setMainWindow(allWindows.length > 0 ? allWindows[0] : null);
      logger.info('[Window] mainWindow updated after close, remaining windows:', allWindows.length);
    }
  });

  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    setMainWindow(newWindow);
  }

  return newWindow;
}

export async function createTray(forHiddenStart: boolean = false): Promise<void> {
  const logPrefix = forHiddenStart ? '[Tray] (hidden start)' : '[Tray]';

  if (forHiddenStart) {
    if (getTray()) {
      logger.info(`${logPrefix} Tray already exists`);
      return;
    }
  } else {
    const settings = getCachedSettings() ?? (await loadSettings());
    if (!settings.minimizeToTray) {
      logger.info(`${logPrefix} Tray disabled in settings`);
      return;
    }

    const existingTray = getTray();
    if (existingTray) {
      existingTray.destroy();
      setTray(null);
    }
  }

  const trayAssetsPath = resolveTrayAssetsPath();
  setTrayAssetsPath(trayAssetsPath);

  const platform = getTrayPlatform();
  const trayIconData = getTrayIcon(trayAssetsPath, platform, 'idle');
  const iconPath = trayIconData.path;
  const trayIcon = trayIconData.icon;
  if (platform === 'darwin') {
    logger.info(`${logPrefix} macOS: Using template icon from:`, iconPath);
  } else if (platform === 'win32') {
    logger.info(`${logPrefix} Windows: Using icon from:`, iconPath);
  } else {
    logger.info(`${logPrefix} Linux: Using icon from:`, iconPath);
  }

  if (trayIcon!.isEmpty()) {
    logger.error(`${logPrefix} Failed to load tray icon from:`, iconPath!);
    return;
  }

  try {
    const newTray = new Tray(trayIcon!);
    setTray(newTray);

    newTray.setToolTip('IYERIS');
    setCurrentTrayState('idle');
    updateTrayMenu();

    if (process.platform === 'darwin') {
      newTray.on('click', (event) => {
        if (event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) {
          return;
        }
        const targetWindow = getActiveWindow();
        if (targetWindow) {
          if (targetWindow.isVisible()) {
            targetWindow.hide();
            setWindowVisibility(targetWindow, false);
          } else {
            targetWindow.show();
            setWindowVisibility(targetWindow, true);
            targetWindow.focus();
          }
        } else {
          createWindow(false);
        }
      });

      newTray.on('right-click', () => {
        newTray.popUpContextMenu(trayContextMenu ?? undefined);
      });
    } else {
      newTray.on('click', () => {
        const targetWindow = getActiveWindow();
        if (targetWindow) {
          if (targetWindow.isVisible()) {
            targetWindow.hide();
            setWindowVisibility(targetWindow, false);
          } else {
            targetWindow.show();
            setWindowVisibility(targetWindow, true);
            targetWindow.focus();
            if (process.platform === 'win32') {
              targetWindow.webContents.invalidate();
            }
          }
        } else {
          createWindow(false);
        }
      });
    }

    logger.info(`${logPrefix} Tray created successfully`);
  } catch (error) {
    logger.error(`${logPrefix} Failed to create tray icon:`, error);
    if (!forHiddenStart) {
      logger.info(`${logPrefix} Minimize to tray feature will be disabled`);
    }
    setTray(null);
    return;
  }
}

export async function createTrayForHiddenStart(): Promise<void> {
  return createTray(true);
}

export function setupApplicationMenu(): void {
  if (process.platform === 'darwin') {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: 'about', label: 'About IYERIS' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'File',
        submenu: [
          {
            label: 'Close Window',
            accelerator: 'CmdOrCtrl+W',
            click: () => {
              BrowserWindow.getFocusedWindow()?.close();
            },
          },
        ],
      },
      {
        label: 'Window',
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
      },
      {
        role: 'help',
        submenu: [
          {
            label: 'IYERIS Website',
            click: () => {
              shell.openExternal('https://iyeris.app');
            },
          },
        ],
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }
}

export function setupWindowHandlers(): void {
  ipcMain.handle('minimize-window', (event: IpcMainInvokeEvent): void => {
    if (!isTrustedIpcEvent(event, 'minimize-window')) return;
    const win = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
    win?.minimize();
  });

  ipcMain.handle('maximize-window', (event: IpcMainInvokeEvent): void => {
    if (!isTrustedIpcEvent(event, 'maximize-window')) return;
    const win = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });

  ipcMain.handle('close-window', (event: IpcMainInvokeEvent): void => {
    if (!isTrustedIpcEvent(event, 'close-window')) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });

  ipcMain.handle('open-new-window', (event: IpcMainInvokeEvent): void => {
    if (!isTrustedIpcEvent(event, 'open-new-window')) return;
    createWindow(false);
  });
}
