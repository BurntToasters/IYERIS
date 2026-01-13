import { ipcMain, app, BrowserWindow, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { Settings, ApiResponse, SettingsResponse } from './types';
import { SETTINGS_CACHE_TTL_MS, getSharedClipboard, setSharedClipboard, getSharedDragData, setSharedDragData, getTray, setTray, getFileIndexer, setFileIndexer, getIndexerTasks } from './appState';
import { getErrorMessage } from './security';
import { createDefaultSettings } from './settings';
import { FileIndexer } from './indexer';

let cachedSettings: Settings | null = null;
let settingsCacheTime: number = 0;

export function getSettingsPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'settings.json');
}

export async function loadSettings(): Promise<Settings> {
  const now = Date.now();
  if (cachedSettings && (now - settingsCacheTime) < SETTINGS_CACHE_TTL_MS) {
    console.log('[Settings] Using cached settings');
    return cachedSettings;
  }

  try {
    const settingsPath = getSettingsPath();
    console.log('[Settings] Loading from:', settingsPath);
    const data = await fs.readFile(settingsPath, 'utf8');
    const settings = { ...createDefaultSettings(), ...JSON.parse(data) };
    console.log('[Settings] Loaded:', JSON.stringify(settings, null, 2));
    cachedSettings = settings;
    settingsCacheTime = now;
    return settings;
  } catch (error) {
    console.log('[Settings] File not found, using defaults');
    const settings = createDefaultSettings();
    cachedSettings = settings;
    settingsCacheTime = now;
    return settings;
  }
}

export function applyLoginItemSettings(settings: Settings): void {
  try {
    console.log('[LoginItem] Applying settings:', settings.startOnLogin);

    if (process.platform === 'win32') {
      if (process.windowsStore) {
        console.log('[LoginItem] MS Store app - using StartupTask');
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
          name: 'IYERIS'
        });
      }
    } else if (process.platform === 'darwin') {
      app.setLoginItemSettings({
        openAtLogin: settings.startOnLogin,
        args: settings.startOnLogin ? ['--hidden'] : [],
        name: 'IYERIS'
      });
    } else {
      app.setLoginItemSettings({
        openAtLogin: settings.startOnLogin,
        args: settings.startOnLogin ? ['--hidden'] : [],
        name: 'IYERIS'
      });
    }

    console.log('[LoginItem] Login item settings applied successfully');
  } catch (error) {
    console.error('[LoginItem] Failed to set login item:', error);
  }
}

export async function saveSettings(settings: Settings): Promise<ApiResponse> {
  try {
    const settingsPath = getSettingsPath();
    console.log('[Settings] Saving to:', settingsPath);
    console.log('[Settings] Data:', JSON.stringify(settings, null, 2));
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    console.log('[Settings] Saved successfully');

    cachedSettings = settings;
    settingsCacheTime = Date.now();

    applyLoginItemSettings(settings);

    return { success: true };
  } catch (error) {
    console.log('[Settings] Save failed:', getErrorMessage(error));
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

  ipcMain.handle('save-settings', async (event: IpcMainInvokeEvent, settings: Settings): Promise<ApiResponse> => {
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
        fileIndexer.initialize(true).catch(err => {
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
        console.log('[Tray] Tray destroyed (setting disabled)');
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
  });

  ipcMain.handle('reset-settings', async (): Promise<ApiResponse> => {
    return await saveSettings(createDefaultSettings());
  });

  ipcMain.handle('set-clipboard', (event: IpcMainInvokeEvent, clipboardData: { operation: 'copy' | 'cut'; paths: string[] } | null): void => {
    setSharedClipboard(clipboardData);
    console.log('[Clipboard] Updated:', clipboardData ? `${clipboardData.operation} ${clipboardData.paths.length} items` : 'cleared');

    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const allWindows = BrowserWindow.getAllWindows();
    for (const win of allWindows) {
      if (!win.isDestroyed() && win !== senderWindow) {
        win.webContents.send('clipboard-changed', getSharedClipboard());
      }
    }
  });

  ipcMain.handle('get-clipboard', (): { operation: 'copy' | 'cut'; paths: string[] } | null => {
    return getSharedClipboard();
  });

  ipcMain.handle('set-drag-data', (_event: IpcMainInvokeEvent, paths: string[]): void => {
    setSharedDragData(paths.length > 0 ? { paths } : null);
    console.log('[Drag] Set drag data:', getSharedDragData() ? `${paths.length} items` : 'cleared');
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
