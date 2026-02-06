import { ipcMain, app, BrowserWindow, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { HomeSettings, ApiResponse, HomeSettingsResponse } from './types';
import { SETTINGS_CACHE_TTL_MS } from './appState';
import { getErrorMessage } from './security';
import { ignoreError } from './shared';
import { createDefaultHomeSettings, sanitizeHomeSettings } from './homeSettings';
import { logger } from './utils/logger';
import { isTrustedIpcEvent } from './ipcUtils';

let cachedHomeSettings: HomeSettings | null = null;
let homeSettingsCacheTime = 0;

export function getHomeSettingsPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'homeSettings.json');
}

export async function loadHomeSettings(): Promise<HomeSettings> {
  const now = Date.now();
  if (cachedHomeSettings && now - homeSettingsCacheTime < SETTINGS_CACHE_TTL_MS) {
    logger.debug('[HomeSettings] Using cached settings');
    return cachedHomeSettings;
  }

  try {
    const settingsPath = getHomeSettingsPath();
    logger.debug('[HomeSettings] Loading from:', settingsPath);
    let data: string;
    try {
      data = await fs.readFile(settingsPath, 'utf8');
    } catch {
      logger.debug('[HomeSettings] File not found, using defaults');
      const settings = createDefaultHomeSettings();
      cachedHomeSettings = settings;
      homeSettingsCacheTime = now;
      return settings;
    }

    try {
      const defaults = createDefaultHomeSettings();
      const parsed = JSON.parse(data);
      const settings = sanitizeHomeSettings(parsed, defaults);
      logger.debug('[HomeSettings] Loaded:', JSON.stringify(settings, null, 2));
      cachedHomeSettings = settings;
      homeSettingsCacheTime = now;
      return settings;
    } catch (error) {
      logger.error('[HomeSettings] Failed to parse settings file:', getErrorMessage(error));
      const backupPath = `${settingsPath}.corrupt-${Date.now()}`;
      try {
        await fs.rename(settingsPath, backupPath);
      } catch (error) {
        ignoreError(error);
      }
      const settings = createDefaultHomeSettings();
      cachedHomeSettings = settings;
      homeSettingsCacheTime = now;
      return settings;
    }
  } catch (error) {
    logger.error('[HomeSettings] Failed to load settings:', getErrorMessage(error));
    const settings = createDefaultHomeSettings();
    cachedHomeSettings = settings;
    homeSettingsCacheTime = now;
    return settings;
  }
}

export async function saveHomeSettings(settings: HomeSettings): Promise<ApiResponse> {
  try {
    const settingsPath = getHomeSettingsPath();
    logger.debug('[HomeSettings] Saving to:', settingsPath);
    const defaults = createDefaultHomeSettings();
    const sanitized = sanitizeHomeSettings(settings, defaults);
    logger.debug('[HomeSettings] Data:', JSON.stringify(sanitized, null, 2));
    const tmpPath = `${settingsPath}.tmp`;
    const data = JSON.stringify(sanitized, null, 2);
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
    logger.debug('[HomeSettings] Saved successfully');

    cachedHomeSettings = sanitized;
    homeSettingsCacheTime = Date.now();

    return { success: true };
  } catch (error) {
    logger.debug('[HomeSettings] Save failed:', getErrorMessage(error));
    return { success: false, error: getErrorMessage(error) };
  }
}

export function invalidateHomeSettingsCache(): void {
  cachedHomeSettings = null;
  homeSettingsCacheTime = 0;
}

export function setupHomeSettingsHandlers(): void {
  ipcMain.handle(
    'get-home-settings',
    async (event: IpcMainInvokeEvent): Promise<HomeSettingsResponse> => {
      try {
        if (!isTrustedIpcEvent(event, 'get-home-settings')) {
          return { success: false, error: 'Untrusted IPC sender' };
        }
        const settings = await loadHomeSettings();
        return { success: true, settings };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    'save-home-settings',
    async (event: IpcMainInvokeEvent, settings: HomeSettings): Promise<ApiResponse> => {
      if (!isTrustedIpcEvent(event, 'save-home-settings')) {
        return { success: false, error: 'Untrusted IPC sender' };
      }
      const result = await saveHomeSettings(settings);

      if (result.success) {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const allWindows = BrowserWindow.getAllWindows();
        const savedSettings = cachedHomeSettings || settings;
        for (const win of allWindows) {
          if (!win.isDestroyed() && win !== senderWindow) {
            win.webContents.send('home-settings-changed', savedSettings);
          }
        }
      }

      return result;
    }
  );

  ipcMain.handle('reset-home-settings', async (event: IpcMainInvokeEvent): Promise<ApiResponse> => {
    if (!isTrustedIpcEvent(event, 'reset-home-settings')) {
      return { success: false, error: 'Untrusted IPC sender' };
    }
    return await saveHomeSettings(createDefaultHomeSettings());
  });

  ipcMain.handle('get-home-settings-path', (event: IpcMainInvokeEvent): string => {
    if (!isTrustedIpcEvent(event, 'get-home-settings-path')) {
      return '';
    }
    return getHomeSettingsPath();
  });
}
