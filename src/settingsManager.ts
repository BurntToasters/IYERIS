import { ipcMain, app, BrowserWindow, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { Settings, ApiResponse, SettingsResponse } from './types';
import {
  SETTINGS_CACHE_TTL_MS,
  getSharedClipboard,
  setSharedClipboard,
  getSharedDragData,
  setSharedDragData,
  getTray,
  setTray,
  getFileIndexer,
  setFileIndexer,
  getIndexerTasks,
} from './appState';
import { getErrorMessage } from './security';
import { createDefaultSettings } from './settings';
import { FileIndexer } from './indexer';
import { logger } from './utils/logger';

let cachedSettings: Settings | null = null;
let settingsCacheTime: number = 0;

export function getSettingsPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'settings.json');
}

export async function loadSettings(): Promise<Settings> {
  const now = Date.now();
  if (cachedSettings && now - settingsCacheTime < SETTINGS_CACHE_TTL_MS) {
    logger.debug('[Settings] Using cached settings');
    return cachedSettings;
  }

  try {
    const settingsPath = getSettingsPath();
    logger.debug('[Settings] Loading from:', settingsPath);
    let data: string;
    try {
      data = await fs.readFile(settingsPath, 'utf8');
    } catch (error) {
      logger.debug('[Settings] File not found, using defaults');
      const settings = createDefaultSettings();
      cachedSettings = settings;
      settingsCacheTime = now;
      return settings;
    }

    try {
      const settings = { ...createDefaultSettings(), ...JSON.parse(data) };
      logger.debug('[Settings] Loaded:', JSON.stringify(settings, null, 2));
      cachedSettings = settings;
      settingsCacheTime = now;
      return settings;
    } catch (error) {
      logger.error('[Settings] Failed to parse settings file:', getErrorMessage(error));
      const backupPath = `${settingsPath}.corrupt-${Date.now()}`;
      try {
        await fs.rename(settingsPath, backupPath);
      } catch {}
      const settings = createDefaultSettings();
      cachedSettings = settings;
      settingsCacheTime = now;
      return settings;
    }
  } catch (error) {
    logger.error('[Settings] Failed to load settings:', getErrorMessage(error));
    const settings = createDefaultSettings();
    cachedSettings = settings;
    settingsCacheTime = now;
    return settings;
  }
}

export function getCachedSettings(): Settings | null {
  return cachedSettings;
}

export function applyLoginItemSettings(settings: Settings): void {
  try {
    logger.debug('[LoginItem] Applying settings:', settings.startOnLogin);

    if (!app.isPackaged) {
      logger.debug('[LoginItem] Skipping login item setup (app is not packaged)');
      return;
    }

    if (process.platform === 'win32') {
      if (process.windowsStore) {
        logger.debug('[LoginItem] MS Store app - using StartupTask');
        app.setLoginItemSettings({
          openAtLogin: settings.startOnLogin,
          name: 'IYERIS',
        });
      } else {
        const exePath = app.getPath('exe');
        app.setLoginItemSettings({
          openAtLogin: settings.startOnLogin,
          path: exePath,
          args: settings.startOnLogin ? ['--hidden'] : [],
          name: 'IYERIS',
        });
      }
    } else if (process.platform === 'darwin') {
      app.setLoginItemSettings({
        openAtLogin: settings.startOnLogin,
        args: settings.startOnLogin ? ['--hidden'] : [],
        name: 'IYERIS',
      });
    } else {
      app.setLoginItemSettings({
        openAtLogin: settings.startOnLogin,
        args: settings.startOnLogin ? ['--hidden'] : [],
        name: 'IYERIS',
      });
    }

    logger.debug('[LoginItem] Login item settings applied successfully');
  } catch (error) {
    console.error('[LoginItem] Failed to set login item:', error);
  }
}

export async function saveSettings(settings: Settings): Promise<ApiResponse> {
  try {
    const settingsPath = getSettingsPath();
    logger.debug('[Settings] Saving to:', settingsPath);
    logger.debug('[Settings] Data:', JSON.stringify(settings, null, 2));
    const tmpPath = `${settingsPath}.tmp`;
    const data = JSON.stringify(settings, null, 2);
    await fs.writeFile(tmpPath, data, 'utf8');
    try {
      await fs.rename(tmpPath, settingsPath);
    } catch (error) {
      try {
        await fs.copyFile(tmpPath, settingsPath);
      } finally {
        await fs.unlink(tmpPath).catch(() => {});
      }
    }
    logger.debug('[Settings] Saved successfully');

    cachedSettings = settings;
    settingsCacheTime = Date.now();

    applyLoginItemSettings(settings);

    return { success: true };
  } catch (error) {
    logger.debug('[Settings] Save failed:', getErrorMessage(error));
    return { success: false, error: getErrorMessage(error) };
  }
}

export function invalidateSettingsCache(): void {
  cachedSettings = null;
  settingsCacheTime = 0;
}

export function setupSettingsHandlers(createTray: () => Promise<void>): void {
  ipcMain.handle('get-settings', async (): Promise<SettingsResponse> => {
    try {
      const settings = await loadSettings();
      return { success: true, settings };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle(
    'save-settings',
    async (event: IpcMainInvokeEvent, settings: Settings): Promise<ApiResponse> => {
      const result = await saveSettings(settings);

      if (result.success) {
        const indexerTasks = getIndexerTasks();
        if (settings.enableIndexer) {
          let fileIndexer = getFileIndexer();
          if (!fileIndexer) {
            fileIndexer = new FileIndexer(indexerTasks ?? undefined);
            setFileIndexer(fileIndexer);
          }
          fileIndexer.setEnabled(true);
          fileIndexer.initialize(true).catch((err) => {
            console.error('[Settings] Failed to initialize indexer:', err);
          });
        } else {
          const fileIndexer = getFileIndexer();
          if (fileIndexer) {
            fileIndexer.setEnabled(false);
          }
        }
      }

      if (result.success) {
        const tray = getTray();
        if (settings.minimizeToTray && !tray) {
          await createTray();
        } else if (!settings.minimizeToTray && tray) {
          tray.destroy();
          setTray(null);
          logger.debug('[Tray] Tray destroyed (setting disabled)');
        }

        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const allWindows = BrowserWindow.getAllWindows();
        for (const win of allWindows) {
          if (!win.isDestroyed() && win !== senderWindow) {
            win.webContents.send('settings-changed', settings);
          }
        }
      }

      return result;
    }
  );

  ipcMain.handle('reset-settings', async (): Promise<ApiResponse> => {
    return await saveSettings(createDefaultSettings());
  });

  ipcMain.handle(
    'set-clipboard',
    (
      event: IpcMainInvokeEvent,
      clipboardData: { operation: 'copy' | 'cut'; paths: string[] } | null
    ): void => {
      setSharedClipboard(clipboardData);
      logger.debug(
        '[Clipboard] Updated:',
        clipboardData ? `${clipboardData.operation} ${clipboardData.paths.length} items` : 'cleared'
      );

      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      const allWindows = BrowserWindow.getAllWindows();
      for (const win of allWindows) {
        if (!win.isDestroyed() && win !== senderWindow) {
          win.webContents.send('clipboard-changed', getSharedClipboard());
        }
      }
    }
  );

  ipcMain.handle('get-clipboard', (): { operation: 'copy' | 'cut'; paths: string[] } | null => {
    return getSharedClipboard();
  });

  ipcMain.handle('set-drag-data', (_event: IpcMainInvokeEvent, paths: string[]): void => {
    setSharedDragData(paths.length > 0 ? { paths } : null);
    logger.debug(
      '[Drag] Set drag data:',
      getSharedDragData() ? `${paths.length} items` : 'cleared'
    );
  });

  ipcMain.handle('get-drag-data', (): { paths: string[] } | null => {
    return getSharedDragData();
  });

  ipcMain.handle('clear-drag-data', (): void => {
    setSharedDragData(null);
  });

  ipcMain.handle('relaunch-app', (): void => {
    app.relaunch();
    app.quit();
  });

  ipcMain.handle('get-settings-path', (): string => {
    return getSettingsPath();
  });
}
