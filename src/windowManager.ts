import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as fsSync from 'fs';
import {
  getMainWindow, setMainWindow, getActiveWindow,
  getTray, setTray, getIsQuitting, setIsQuitting,
  getCurrentTrayState, setCurrentTrayState,
  getTrayAssetsPath, setTrayAssetsPath,
  getShouldStartHidden, getIsDev
} from './appState';
import { loadSettings } from './settingsManager';

export function showAppWindow(): void {
  const targetWindow = getActiveWindow();
  if (targetWindow) {
    targetWindow.show();
    targetWindow.focus();
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

  tray.setContextMenu(Menu.buildFromTemplate(menuItems));
}

export function setTrayState(state: 'idle' | 'active' | 'notification'): void {
  const tray = getTray();
  const trayAssetsPath = getTrayAssetsPath();
  if (!tray || !trayAssetsPath || getCurrentTrayState() === state) return;
  setCurrentTrayState(state);

  const iconFiles: Record<string, Record<string, string>> = {
    darwin: { idle: 'icon-tray-Template.png', active: 'icon-tray-Template.png', notification: 'icon-tray-Template.png' },
    win32: { idle: 'icon-square.ico', active: 'icon-square.ico', notification: 'icon-square.ico' },
    linux: { idle: 'icon_32x32@1x.png', active: 'icon_32x32@1x.png', notification: 'icon_32x32@1x.png' }
  };

  const platform = process.platform as 'darwin' | 'win32' | 'linux';
  const iconFile = iconFiles[platform]?.[state] || iconFiles[platform]?.idle;

  let iconPath: string;
  if (platform === 'darwin') {
    iconPath = path.join(trayAssetsPath, iconFile);
    if (!fsSync.existsSync(iconPath)) {
      const fallbackPath = path.join(trayAssetsPath, 'iyeris.iconset', 'icon_32x32@1x.png');
      iconPath = fsSync.existsSync(fallbackPath) ? fallbackPath : path.join(trayAssetsPath, 'icon.png');
    }
  } else if (platform === 'linux') {
    iconPath = path.join(trayAssetsPath, 'iyeris.iconset', iconFile);
    if (!fsSync.existsSync(iconPath)) {
      iconPath = path.join(trayAssetsPath, 'icon.png');
    }
  } else {
    iconPath = path.join(trayAssetsPath, iconFile);
    if (!fsSync.existsSync(iconPath)) {
      iconPath = path.join(trayAssetsPath, 'icon.png');
    }
  }

  const sizes: Record<string, { width: number; height: number }> = {
    darwin: { width: 22, height: 22 },
    win32: { width: 16, height: 16 },
    linux: { width: 24, height: 24 }
  };

  let newIcon = nativeImage.createFromPath(iconPath);
  if (platform !== 'win32' || !iconPath.endsWith('.ico')) {
    newIcon = newIcon.resize(sizes[platform] || sizes.linux);
  }

  if (platform === 'darwin') {
    newIcon.setTemplateImage(true);
  }

  tray.setImage(newIcon);
}

export function createWindow(isInitialWindow: boolean = false): BrowserWindow {
  const isDev = getIsDev();
  const shouldStartHidden = getShouldStartHidden();

  const newWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    frame: false,
    resizable: true,
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      devTools: isDev,
      backgroundThrottling: false,
      spellcheck: false,
      v8CacheOptions: 'code',
      enableWebSQL: false,
      plugins: false,
      webgl: false,
      images: true,
      autoplayPolicy: 'user-gesture-required',
      defaultEncoding: 'UTF-8'
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png')
  });

  newWindow.loadFile(path.join(__dirname, '..', 'index.html'));
  const indexUrl = pathToFileURL(path.join(__dirname, '..', 'index.html')).toString();

  const openExternalIfAllowed = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
        shell.openExternal(url).catch(error => {
          console.error('[Security] Failed to open external URL:', error);
        });
        return true;
      }
    } catch {}
    return false;
  };

  newWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (openExternalIfAllowed(url)) {
      return { action: 'deny' };
    }
    console.warn('[Security] Blocked window.open to:', url);
    return { action: 'deny' };
  });

  newWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== indexUrl) {
      if (openExternalIfAllowed(url)) {
        event.preventDefault();
        return;
      }
      console.warn('[Security] Blocked navigation to:', url);
      event.preventDefault();
    }
  });

  newWindow.webContents.on('will-redirect', (event, url) => {
    if (url !== indexUrl) {
      if (openExternalIfAllowed(url)) {
        event.preventDefault();
        return;
      }
      console.warn('[Security] Blocked redirect to:', url);
      event.preventDefault();
    }
  });

  const startHidden = isInitialWindow && shouldStartHidden;
  console.log('[Window] Creating window, isInitial:', isInitialWindow, 'startHidden:', startHidden, 'shouldStartHidden:', shouldStartHidden);

  newWindow.once('ready-to-show', async () => {
    if (startHidden) {
      console.log('[Window] Starting minimized to tray');
      const tray = getTray();
      if (!tray) {
        await createTray();
      }
      newWindow.hide();
      if (process.platform === 'darwin') {
        app.dock?.hide();
      }
    } else {
      newWindow.show();
    }
  });

  newWindow.on('close', async (event) => {
    if (!getIsQuitting()) {
      const settings = await loadSettings();
      const tray = getTray();
      if (settings.minimizeToTray && tray) {
        event.preventDefault();
        newWindow.hide();
        if (process.platform === 'darwin') {
          const allWindows = BrowserWindow.getAllWindows();
          const visibleWindows = allWindows.filter(w => w.isVisible());
          if (visibleWindows.length === 0) {
            app.dock?.hide();
          }
        }
        return;
      }
    }
    return;
  });

  newWindow.on('minimize', async () => {
    const settings = await loadSettings();
    const tray = getTray();
    if (settings.minimizeToTray && tray) {
      if (process.platform === 'darwin') {
        setImmediate(() => {
          newWindow.hide();
          const allWindows = BrowserWindow.getAllWindows();
          const visibleWindows = allWindows.filter(w => w.isVisible());
          if (visibleWindows.length === 0) {
            app.dock?.hide();
          }
        });
      } else {
        newWindow.restore();
        newWindow.hide();
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
      console.log('[Window] mainWindow updated after close, remaining windows:', allWindows.length);
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
      console.log(`${logPrefix} Tray already exists`);
      return;
    }
  } else {
    const settings = await loadSettings();
    if (!settings.minimizeToTray) {
      console.log(`${logPrefix} Tray disabled in settings`);
      return;
    }

    const existingTray = getTray();
    if (existingTray) {
      existingTray.destroy();
      setTray(null);
    }
  }

  let iconPath: string;
  let trayIcon: Electron.NativeImage;

  const trayAssetsPath = path.join(__dirname, '..', 'assets');
  setTrayAssetsPath(trayAssetsPath);

  if (process.platform === 'darwin') {
    const templatePath = path.join(trayAssetsPath, 'icon-tray-Template.png');
    const icon32Path = path.join(trayAssetsPath, 'iyeris.iconset', 'icon_32x32@1x.png');
    const iconFallback = path.join(trayAssetsPath, 'icon.png');

    if (fsSync.existsSync(templatePath)) {
      iconPath = templatePath;
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
    } else if (fsSync.existsSync(icon32Path)) {
      iconPath = icon32Path;
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
    } else {
      iconPath = iconFallback;
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
    }
    trayIcon.setTemplateImage(true);
    console.log(`${logPrefix} macOS: Using template icon from:`, iconPath);
  } else if (process.platform === 'win32') {
    const icoPath = path.join(trayAssetsPath, 'icon-square.ico');
    const pngPath = path.join(trayAssetsPath, 'icon.png');

    if (fsSync.existsSync(icoPath)) {
      iconPath = icoPath;
      trayIcon = nativeImage.createFromPath(iconPath);
    } else {
      iconPath = pngPath;
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    }
    console.log(`${logPrefix} Windows: Using icon from:`, iconPath);
  } else {
    const icon32Path = path.join(trayAssetsPath, 'iyeris.iconset', 'icon_32x32@1x.png');
    const iconFallback = path.join(trayAssetsPath, 'icon.png');

    if (fsSync.existsSync(icon32Path)) {
      iconPath = icon32Path;
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 24, height: 24 });
    } else {
      iconPath = iconFallback;
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 24, height: 24 });
    }
    console.log(`${logPrefix} Linux: Using icon from:`, iconPath);
  }

  if (trayIcon!.isEmpty()) {
    console.error(`${logPrefix} Failed to load tray icon from:`, iconPath!);
    return;
  }

  try {
    const newTray = new Tray(trayIcon!);
    setTray(newTray);

    newTray.setToolTip('IYERIS');
    setCurrentTrayState('idle');
    updateTrayMenu();

    if (process.platform !== 'darwin') {
      newTray.on('click', () => {
        const targetWindow = getActiveWindow();
        if (targetWindow) {
          if (targetWindow.isVisible()) {
            targetWindow.hide();
          } else {
            targetWindow.show();
            targetWindow.focus();
          }
        } else {
          createWindow(false);
        }
      });
    }

    if (process.platform === 'darwin') {
      newTray.on('double-click', () => {
        showAppWindow();
      });
    }

    console.log(`${logPrefix} Tray created successfully`);
  } catch (error) {
    console.error(`${logPrefix} Failed to create tray icon:`, error);
    if (!forHiddenStart) {
      console.log(`${logPrefix} Minimize to tray feature will be disabled`);
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
          { role: 'quit' }
        ]
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
          { role: 'selectAll' }
        ]
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
          { role: 'togglefullscreen' }
        ]
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'front' }
        ]
      }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }
}

export function setupWindowHandlers(): void {
  const mainWindow = getMainWindow();

  ipcMain.handle('minimize-window', (): void => {
    mainWindow?.minimize();
  });

  ipcMain.handle('maximize-window', (): void => {
    const mainWindow = getMainWindow();
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.handle('close-window', (event: IpcMainInvokeEvent): void => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });

  ipcMain.handle('open-new-window', (): void => {
    createWindow(false);
  });
}
