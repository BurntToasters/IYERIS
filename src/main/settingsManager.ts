import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain, app, BrowserWindow, clipboard } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import type { Settings, ApiResponse, SettingsResponse } from '../types';
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
import { getErrorMessage, isTrustedIpcSender } from './security';
import { ignoreError } from '../shared';
import { createDefaultSettings, sanitizeSettings } from '../settings';
import { FileIndexer } from './indexer';
import { logger } from './logger';
import { isTrustedIpcEvent } from './ipcUtils';

let cachedSettings: Settings | null = null;
let settingsCacheTime: number = 0;
let saveLock: Promise<void> = Promise.resolve();

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
      } catch (error) {
        ignoreError(error);
      }
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

    if (process.platform === 'win32' && process.windowsStore) {
      logger.debug('[LoginItem] MS Store app - using StartupTask');
      app.setLoginItemSettings({ openAtLogin: settings.startOnLogin, name: 'IYERIS' });
    } else {
      const opts: Electron.Settings = {
        openAtLogin: settings.startOnLogin,
        args: settings.startOnLogin ? ['--hidden'] : [],
        name: 'IYERIS',
      };
      if (process.platform === 'win32') {
        (opts as Record<string, unknown>).path = app.getPath('exe');
      }
      app.setLoginItemSettings(opts);
    }

    logger.debug('[LoginItem] Login item settings applied successfully');
  } catch (error) {
    logger.warn('[LoginItem] Failed to set login item:', error);
  }
}

export async function saveSettings(settings: Settings): Promise<ApiResponse> {
  const doSave = async (): Promise<ApiResponse> => {
    try {
      const settingsPath = getSettingsPath();
      logger.debug('[Settings] Saving to:', settingsPath);

      const defaults = createDefaultSettings();
      const sanitized = sanitizeSettings(settings, defaults);
      const settingsWithTimestamp = { ...sanitized };
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
          await fs.unlink(tmpPath).catch(ignoreError);
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
  };

  const result = saveLock.then(doSave, doSave);
  saveLock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
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
          try {
            await fileIndexer.initialize(true);
          } catch (err) {
            logger.warn('[Settings] Failed to initialize indexer:', err);
          }
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

  ipcMain.on('save-settings-sync', (event, settings: Settings) => {
    if (!isTrustedIpcSender(event)) {
      event.returnValue = { success: false, error: 'Untrusted IPC sender' };
      return;
    }
    try {
      const settingsPath = getSettingsPath();
      const defaults = createDefaultSettings();
      const sanitized = sanitizeSettings(settings, defaults);
      const data = JSON.stringify(sanitized, null, 2);
      const tmpPath = `${settingsPath}.sync-tmp`;
      fsSync.writeFileSync(tmpPath, data, 'utf8');
      try {
        fsSync.renameSync(tmpPath, settingsPath);
      } catch {
        fsSync.copyFileSync(tmpPath, settingsPath);
        try {
          fsSync.unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }
      }
      cachedSettings = sanitized;
      settingsCacheTime = Date.now();

      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && win !== senderWindow) {
          try {
            win.webContents.send('settings-changed', sanitized);
          } catch {
            /* window may be closing */
          }
        }
      }

      event.returnValue = { success: true };
    } catch (error) {
      event.returnValue = { success: false, error: getErrorMessage(error) };
    }
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
          try {
            win.webContents.send('clipboard-changed', getSharedClipboard());
          } catch (sendError) {
            ignoreError(sendError);
          }
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

  const readSystemClipboardData = (): { operation: 'copy' | 'cut'; paths: string[] } => {
    try {
      const isMacTransientFileRef = (filePath: string): boolean =>
        process.platform === 'darwin' && filePath.startsWith('/.file/id=');

      const readWindowsDropEffect = (): 'copy' | 'cut' => {
        if (process.platform !== 'win32') return 'copy';
        try {
          const dropEffect = clipboard.readBuffer('Preferred DropEffect');
          if (dropEffect && dropEffect.length >= 4) {
            const effect = dropEffect.readUInt32LE(0);
            if ((effect & 2) === 2) {
              return 'cut';
            }
          }
        } catch (error) {
          ignoreError(error);
        }
        return 'copy';
      };

      const parseClipboardPath = (line: string): string => {
        let filePath = line.trim();
        if (!filePath) return '';
        if (filePath.startsWith('file://')) {
          try {
            const parsed = new URL(filePath);
            let decodedPath = '';
            try {
              decodedPath = decodeURIComponent(parsed.pathname || '');
            } catch {
              decodedPath = parsed.pathname || '';
            }
            if (
              process.platform === 'win32' &&
              parsed.hostname &&
              /^[A-Za-z]$/.test(parsed.hostname) &&
              decodedPath.startsWith('/')
            ) {
              filePath = `${parsed.hostname.toUpperCase()}:${decodedPath.replace(/\//g, '\\')}`;
            } else if (parsed.hostname && parsed.hostname !== 'localhost') {
              if (process.platform === 'win32') {
                decodedPath = `\\\\${parsed.hostname}${decodedPath.replace(/\//g, '\\')}`;
              } else {
                decodedPath = `//${parsed.hostname}${decodedPath}`;
              }
              filePath = decodedPath;
            } else if (
              process.platform === 'win32' &&
              decodedPath.startsWith('/') &&
              decodedPath.charAt(2) === ':'
            ) {
              filePath = decodedPath.substring(1);
            } else {
              filePath = decodedPath;
            }
          } catch {
            const rawPath = filePath.substring(7);
            try {
              filePath = decodeURIComponent(rawPath);
            } catch {
              filePath = rawPath;
            }
          }
        }
        if (isMacTransientFileRef(filePath)) {
          return '';
        }
        return filePath;
      };

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
          const operation = readWindowsDropEffect();
          logger.debug(
            '[System Clipboard] Found files (Windows format):',
            paths.length,
            'items',
            `(${operation})`
          );
          return { operation, paths };
        }
      }

      if (process.platform === 'linux') {
        const gnomeCopied = clipboard.readBuffer('x-special/gnome-copied-files');
        if (gnomeCopied && gnomeCopied.length > 0) {
          const content = gnomeCopied.toString('utf8');
          const lines = content.split('\n').filter(Boolean);
          const paths: string[] = [];
          let operation: 'copy' | 'cut' = 'copy';
          const firstLine = lines[0]?.trim().toLowerCase();
          const dataLines =
            firstLine === 'copy' || firstLine === 'cut'
              ? ((operation = firstLine), lines.slice(1))
              : lines;

          for (const line of dataLines) {
            const trimmed = line.trim();
            const filePath = parseClipboardPath(trimmed);
            if (filePath) paths.push(filePath);
          }
          if (paths.length > 0) {
            logger.debug(
              '[System Clipboard] Found files (GNOME format):',
              paths.length,
              'items',
              `(${operation})`
            );
            return { operation, paths };
          }
        }
      }

      // macos/linux format
      const filePaths = clipboard.read('public.file-url');
      if (filePaths) {
        const paths: string[] = [];
        const lines = filePaths.split('\n').filter(Boolean);
        for (const line of lines) {
          const filePath = parseClipboardPath(line);
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
          return { operation: 'copy', paths };
        }
      }

      if (process.platform === 'linux') {
        const uriList = clipboard.readBuffer('text/uri-list');
        if (uriList && uriList.length > 0) {
          const content = uriList.toString('utf8');
          const lines = content.split('\n').filter(Boolean);
          const paths: string[] = [];
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#')) continue;
            const filePath = parseClipboardPath(trimmed);
            if (filePath) paths.push(filePath);
          }
          if (paths.length > 0) {
            logger.debug(
              '[System Clipboard] Found files (URI list format):',
              paths.length,
              'items'
            );
            return { operation: 'copy', paths };
          }
        }
      }

      if (process.platform === 'darwin') {
        const nsFilenames = clipboard.readBuffer('NSFilenamesPboardType');
        if (nsFilenames && nsFilenames.length > 0) {
          const content = nsFilenames.toString('utf8');
          const pathMatches = content.match(/<string>([^<]+)<\/string>/g);
          if (pathMatches) {
            const paths = pathMatches
              .map((m) => m.replace(/<\/?string>/g, '').trim())
              .filter(Boolean);
            if (paths.length > 0) {
              logger.debug(
                '[System Clipboard] Found files (Finder plist format):',
                paths.length,
                'items'
              );
              return { operation: 'copy', paths };
            }
          }
        }
      }

      return { operation: 'copy', paths: [] };
    } catch (error) {
      logger.error('[System Clipboard] Error reading files from clipboard:', error);
      return { operation: 'copy', paths: [] };
    }
  };

  ipcMain.handle(
    'get-system-clipboard-data',
    (event: IpcMainInvokeEvent): { operation: 'copy' | 'cut'; paths: string[] } => {
      if (!isTrustedIpcEvent(event, 'get-system-clipboard-data')) {
        return { operation: 'copy', paths: [] };
      }
      return readSystemClipboardData();
    }
  );

  ipcMain.handle('get-system-clipboard-files', (event: IpcMainInvokeEvent): string[] => {
    if (!isTrustedIpcEvent(event, 'get-system-clipboard-files')) {
      return [];
    }
    return readSystemClipboardData().paths;
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
