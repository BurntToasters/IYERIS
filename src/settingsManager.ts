import { ipcMain, app, BrowserWindow, IpcMainInvokeEvent, clipboard } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { Settings, ApiResponse, SettingsResponse } from './types';
import {
  SETTINGS_CACHE_TTL_MS,
  getSharedClipboard,
  setSharedClipboard,
  getWindowDragData,
  setWindowDragData,
  clearWindowDragData,
  getTray,
  setTray,
  getFileIndexer,
  setFileIndexer,
  getIndexerTasks,
} from './appState';
import { getErrorMessage } from './security';
import { createDefaultSettings, sanitizeSettings } from './settings';
import { FileIndexer } from './indexer';
import { logger } from './utils/logger';
import { isTrustedIpcEvent } from './ipcUtils';

let cachedSettings: Settings | null = null;
let settingsCacheTime: number = 0;

export function getSettingsPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'settings.json');
}

export async function loadSettings(): Promise<Settings> {
  const now = Date.now();
  // check cache
  if (cachedSettings && now - settingsCacheTime < SETTINGS_CACHE_TTL_MS) {
    logger.debug('[Settings] Using cached settings');
    return cachedSettings;
  }

  try {
    const settingsPath = getSettingsPath();
    logger.debug('[Settings] Loading from:', settingsPath);
    let data: string;
    // load from disk
    try {
      data = await fs.readFile(settingsPath, 'utf8');
    } catch {
      logger.debug('[Settings] File not found, using defaults');
      const settings = createDefaultSettings();
      cachedSettings = settings;
      settingsCacheTime = now;
      return settings;
    }

    try {
      const defaults = createDefaultSettings();
      const parsed = JSON.parse(data);
      const settings = sanitizeSettings(parsed, defaults);
      logger.debug('[Settings] Loaded:', JSON.stringify(settings, null, 2));
      cachedSettings = settings;
      settingsCacheTime = now;
      return settings;
    } catch (error) {
      logger.error('[Settings] Failed to parse settings file:', getErrorMessage(error));
      // backup corrupt file
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

    const defaults = createDefaultSettings();
    const sanitized = sanitizeSettings(settings, defaults);
    const settingsWithTimestamp = { ...sanitized, _timestamp: Date.now() };
    logger.debug('[Settings] Data:', JSON.stringify(settingsWithTimestamp, null, 2));

    const tmpPath = `${settingsPath}.tmp`;
    const data = JSON.stringify(settingsWithTimestamp, null, 2);
    await fs.writeFile(tmpPath, data, 'utf8');
    try {
      await fs.rename(tmpPath, settingsPath);
    } catch {
      try {
        await fs.copyFile(tmpPath, settingsPath);
      } finally {
        await fs.unlink(tmpPath).catch(() => {});
      }
    }
    logger.debug('[Settings] Saved successfully');

    cachedSettings = settingsWithTimestamp;
    settingsCacheTime = Date.now();

    applyLoginItemSettings(settingsWithTimestamp);

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
  ipcMain.handle('get-settings', async (event: IpcMainInvokeEvent): Promise<SettingsResponse> => {
    try {
      if (!isTrustedIpcEvent(event, 'get-settings')) {
        return { success: false, error: 'Untrusted IPC sender' };
      }
      const settings = await loadSettings();
      return { success: true, settings };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle(
    'save-settings',
    async (event: IpcMainInvokeEvent, settings: Settings): Promise<ApiResponse> => {
      if (!isTrustedIpcEvent(event, 'save-settings')) {
        return { success: false, error: 'Untrusted IPC sender' };
      }
      const result = await saveSettings(settings);
      const savedSettings = cachedSettings || settings;

      if (result.success) {
        const indexerTasks = getIndexerTasks();
        if (savedSettings.enableIndexer) {
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
        if (savedSettings.minimizeToTray && !tray) {
          await createTray();
        } else if (!savedSettings.minimizeToTray && tray) {
          tray.destroy();
          setTray(null);
          logger.debug('[Tray] Tray destroyed (setting disabled)');
        }

        // Guard against destroyed webContents during app shutdown
        if (!event.sender.isDestroyed()) {
          const senderWindow = BrowserWindow.fromWebContents(event.sender);
          const allWindows = BrowserWindow.getAllWindows();
          for (const win of allWindows) {
            if (!win.isDestroyed() && win !== senderWindow) {
              try {
                win.webContents.send('settings-changed', savedSettings);
              } catch (error) {
                logger.warn('[Settings] Failed to broadcast to window:', error);
              }
            }
          }
        }
      }

      return result;
    }
  );

  ipcMain.handle('reset-settings', async (event: IpcMainInvokeEvent): Promise<ApiResponse> => {
    if (!isTrustedIpcEvent(event, 'reset-settings')) {
      return { success: false, error: 'Untrusted IPC sender' };
    }
    return await saveSettings(createDefaultSettings());
  });

  ipcMain.handle(
    'set-clipboard',
    (
      event: IpcMainInvokeEvent,
      clipboardData: { operation: 'copy' | 'cut'; paths: string[] } | null
    ): void => {
      if (!isTrustedIpcEvent(event, 'set-clipboard')) {
        return;
      }
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

  ipcMain.handle(
    'get-clipboard',
    (event: IpcMainInvokeEvent): { operation: 'copy' | 'cut'; paths: string[] } | null => {
      if (!isTrustedIpcEvent(event, 'get-clipboard')) {
        return null;
      }
      return getSharedClipboard();
    }
  );

  ipcMain.handle('get-system-clipboard-files', (event: IpcMainInvokeEvent): string[] => {
    if (!isTrustedIpcEvent(event, 'get-system-clipboard-files')) {
      return [];
    }
    try {
      // win format (ucs-2)
      const files = clipboard.readBuffer('FileNameW');
      if (files && files.length > 0) {
        const paths: string[] = [];
        const fileList = files.toString('ucs2').split('\0').filter(Boolean);
        for (const filePath of fileList) {
          if (filePath.trim()) {
            paths.push(filePath);
          }
        }
        if (paths.length > 0) {
          logger.debug('[System Clipboard] Found files (Windows format):', paths.length, 'items');
          return paths;
        }
      }

      // macos/linux format
      const filePaths = clipboard.read('public.file-url');
      if (filePaths) {
        const paths: string[] = [];
        const lines = filePaths.split('\n').filter(Boolean);
        for (const line of lines) {
          let filePath = line.trim();
          if (filePath.startsWith('file://')) {
            filePath = decodeURIComponent(filePath.substring(7));
            if (
              process.platform === 'win32' &&
              filePath.startsWith('/') &&
              filePath.charAt(2) === ':'
            ) {
              filePath = filePath.substring(1);
            }
          }
          if (filePath) {
            paths.push(filePath);
          }
        }
        if (paths.length > 0) {
          logger.debug(
            '[System Clipboard] Found files (macOS/Linux format):',
            paths.length,
            'items'
          );
          return paths;
        }
      }

      return [];
    } catch (error) {
      logger.error('[System Clipboard] Error reading files from clipboard:', error);
      return [];
    }
  });

  ipcMain.handle('set-drag-data', (event: IpcMainInvokeEvent, paths: string[]): void => {
    if (!isTrustedIpcEvent(event, 'set-drag-data')) {
      return;
    }
    const data = paths.length > 0 ? { paths } : null;
    setWindowDragData(event.sender, data);
    logger.debug('[Drag] Set drag data:', data ? `${paths.length} items` : 'cleared');
  });

  ipcMain.handle('get-drag-data', (event: IpcMainInvokeEvent): { paths: string[] } | null => {
    if (!isTrustedIpcEvent(event, 'get-drag-data')) {
      return null;
    }
    return getWindowDragData(event.sender);
  });

  ipcMain.handle('clear-drag-data', (event: IpcMainInvokeEvent): void => {
    if (!isTrustedIpcEvent(event, 'clear-drag-data')) {
      return;
    }
    clearWindowDragData(event.sender);
  });

  ipcMain.handle('relaunch-app', (event: IpcMainInvokeEvent): void => {
    if (!isTrustedIpcEvent(event, 'relaunch-app')) {
      return;
    }
    app.relaunch();
    app.quit();
  });

  ipcMain.handle('get-settings-path', (event: IpcMainInvokeEvent): string => {
    if (!isTrustedIpcEvent(event, 'get-settings-path')) {
      return '';
    }
    return getSettingsPath();
  });
}
