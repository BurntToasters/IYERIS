import { app, BrowserWindow, ipcMain, dialog, shell, IpcMainInvokeEvent, Menu, Tray, nativeImage, powerMonitor } from 'electron';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type { Settings, FileItem, ApiResponse, DirectoryResponse, PathResponse, PropertiesResponse, SettingsResponse, UpdateCheckResponse, IndexSearchResponse, UndoAction } from './types';
import { FileIndexer } from './indexer';
import { getDrives, getCachedDrives, warmupDrivesCache } from './utils';

let autoUpdaterModule: typeof import('electron-updater') | null = null;
let sevenBinModule: { path7za: string } | null = null;
let sevenZipModule: any = null;

function getAutoUpdater() {
  if (!autoUpdaterModule) {
    autoUpdaterModule = require('electron-updater');
  }
  return autoUpdaterModule!.autoUpdater;
}

function get7zipBin(): { path7za: string } {
  if (!sevenBinModule) {
    sevenBinModule = require('7zip-bin');
  }
  return sevenBinModule!;
}

function get7zipModule() {
  if (!sevenZipModule) {
    sevenZipModule = require('node-7z');
  }
  return sevenZipModule;
}

const MAX_UNDO_STACK_SIZE = 50;
const HIDDEN_FILE_CACHE_TTL = 300000;
const HIDDEN_FILE_CACHE_MAX = 5000;
const SETTINGS_CACHE_TTL_MS = 5000;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;

// Disable hardware accel via cli arg
if (process.argv.includes('--disable-hardware-acceleration')) {
  console.log('[Performance] Hardware acceleration disabled via command line flag');
  app.disableHardwareAcceleration();
}

// Enable V8 code caching via cli args
app.commandLine.appendSwitch('--enable-blink-features', 'CodeCache');
app.commandLine.appendSwitch('wm-window-animations-disabled');
app.commandLine.appendSwitch('disable-http-cache');

// Check Flatpak status at start
let isInFlatpak: boolean | null = null;
const isRunningInFlatpak = (): boolean => {
  if (isInFlatpak === null) {
    isInFlatpak = process.env.FLATPAK_ID !== undefined || 
                  fsSync.existsSync('/.flatpak-info');
  }
  return isInFlatpak;
};

// Check if installed via MSI (async to avoid blocking startup)
let msiCheckPromise: Promise<boolean> | null = null;
let msiCheckResult: boolean | null = null;

const checkMsiInstallation = (): Promise<boolean> => {
  if (process.platform !== 'win32') return Promise.resolve(false);
  if (msiCheckResult !== null) return Promise.resolve(msiCheckResult);

  if (!msiCheckPromise) {
    msiCheckPromise = new Promise((resolve) => {
      exec(
        'reg query "HKCU\\Software\\IYERIS" /v InstalledViaMsi 2>nul',
        { encoding: 'utf8', windowsHide: true },
        (error, stdout) => {
          msiCheckResult = !error && stdout.includes('InstalledViaMsi') && stdout.includes('0x1');
          resolve(msiCheckResult);
        }
      );
    });
  }
  return msiCheckPromise;
};

const isInstalledViaMsi = (): boolean => {
  return msiCheckResult === true;
};

let cached7zipPath: string | null = null;
const get7zipPath = (): string => {
  if (cached7zipPath) {
    return cached7zipPath;
  }

  const sevenBin = get7zipBin();
  let sevenZipPath = sevenBin.path7za;

  if (app.isPackaged) {
    sevenZipPath = sevenZipPath.replace('app.asar', 'app.asar.unpacked');
  }

  console.log('[7zip] Using path:', sevenZipPath);
  cached7zipPath = sevenZipPath;
  return sevenZipPath;
};

let mainWindow: BrowserWindow | null = null;
let fileIndexer: FileIndexer | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let shouldStartHidden = false;
let hiddenFileCacheCleanupInterval: NodeJS.Timeout | null = null;
import * as crypto from 'crypto';

function isPathSafe(inputPath: string): boolean {
  if (!inputPath || typeof inputPath !== 'string') {
    return false;
  }

  // Check for null bytes
  if (inputPath.includes('\0')) {
    console.warn('[Security] Path contains null byte:', inputPath);
    return false;
  }

  const suspiciousChars = /[<>"|*?]/;
  if (suspiciousChars.test(inputPath)) {
    console.warn('[Security] Path contains suspicious characters:', inputPath);
    return false;
  }

  const normalized = path.normalize(inputPath);
  const resolved = path.resolve(inputPath);

  if (normalized.includes('..')) {
    console.warn('[Security] Path contains parent directory reference after normalization:', inputPath);
    return false;
  }

  // Validate UNC paths on Windows
  if (process.platform === 'win32' && normalized.startsWith('\\\\')) {
    const parts = normalized.split('\\').filter(Boolean);
    if (parts.length < 1) {
      console.warn('[Security] Invalid UNC path:', inputPath);
      return false;
    }
  }

  if (process.platform === 'win32') {
    const lowerResolved = resolved.toLowerCase();
    const restrictedPaths = [
      'c:\\windows\\system32\\config\\sam',
      'c:\\windows\\system32\\config\\system',
      'c:\\windows\\system32\\config\\security'
    ];

    for (const restricted of restrictedPaths) {
      if (lowerResolved === restricted || lowerResolved.startsWith(restricted + '\\')) {
        console.warn('[Security] Attempt to access restricted system file:', inputPath);
        return false;
      }
    }
  }

  return true;
}

const ALLOWED_URL_SCHEMES = ['http:', 'https:', 'mailto:', 'file:'];
function isUrlSafe(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_URL_SCHEMES.includes(parsed.protocol);
  } catch {
    return false;
  }
}

function safeSendToWindow(win: BrowserWindow | null, channel: string, ...args: any[]): boolean {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, ...args);
      return true;
    }
  } catch (error) {
    console.error(`[IPC] Failed to send ${channel}:`, error);
  }
  return false;
}

function spawnWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
  options: Parameters<typeof spawn>[2]
): { child: ReturnType<typeof spawn>; timedOut: () => boolean } {
  let didTimeout = false;
  const child = spawn(command, args, options);
  const timeout = setTimeout(() => {
    didTimeout = true;
    try {
      child.kill();
    } catch {
    }
  }, timeoutMs);

  const clear = () => clearTimeout(timeout);
  child.on('close', clear);
  child.on('error', clear);

  return { child, timedOut: () => didTimeout };
}

async function assertArchiveEntriesSafe(archivePath: string, destPath: string): Promise<void> {
  const Seven = get7zipModule();
  const sevenZipPath = get7zipPath();

  const entries = await new Promise<string[]>((resolve, reject) => {
    const list = Seven.list(archivePath, { $bin: sevenZipPath });
    const names: string[] = [];

    list.on('data', (data: { file?: string }) => {
      if (data && data.file) {
        names.push(String(data.file));
      }
    });
    list.on('end', () => resolve(names));
    list.on('error', (err: Error) => reject(err));
  });

  const destRoot = path.resolve(destPath);
  const destRootWithSep = destRoot.endsWith(path.sep) ? destRoot : destRoot + path.sep;
  const invalidEntries: string[] = [];

  for (const entry of entries) {
    if (!entry) continue;

    const normalized = entry.replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!normalized) continue;
    if (normalized.startsWith('/') || normalized.startsWith('//') || /^[a-zA-Z]:/.test(normalized)) {
      invalidEntries.push(entry);
      continue;
    }
    const parts = normalized.split('/');
    if (parts.some(part => part === '..')) {
      invalidEntries.push(entry);
      continue;
    }

    const targetPath = path.resolve(destRoot, normalized);
    if (targetPath !== destRoot && !targetPath.startsWith(destRootWithSep)) {
      invalidEntries.push(entry);
    }
  }

  if (invalidEntries.length > 0) {
    const preview = invalidEntries.slice(0, 5).join(', ');
    throw new Error(`Archive contains unsafe paths: ${preview}${invalidEntries.length > 5 ? '...' : ''}`);
  }
}

function parseVersion(v: string): { major: number; minor: number; patch: number; prerelease: string } {
  const match = v.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) return { major: 0, minor: 0, patch: 0, prerelease: '' };
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || ''
  };
}

function compareVersions(a: string, b: string): number {
  const vA = parseVersion(a);
  const vB = parseVersion(b);

  if (vA.major !== vB.major) return vA.major > vB.major ? 1 : -1;
  if (vA.minor !== vB.minor) return vA.minor > vB.minor ? 1 : -1;
  if (vA.patch !== vB.patch) return vA.patch > vB.patch ? 1 : -1;
  if (!vA.prerelease && vB.prerelease) return 1;
  if (vA.prerelease && !vB.prerelease) return -1;
  if (vA.prerelease && vB.prerelease) {
    return vA.prerelease.localeCompare(vB.prerelease);
  }
  
  return 0;
}

let sharedClipboard: { operation: 'copy' | 'cut'; paths: string[] } | null = null;
let sharedDragData: { paths: string[] } | null = null;

const isDev = process.argv.includes('--dev');

function broadcastToAllWindows(channel: string, data?: any): void {
  const allWindows = BrowserWindow.getAllWindows();
  for (const win of allWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}

// inst lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('[SingleInstance] Another instance is already running, quitting...');
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    console.log('[SingleInstance] Second instance attempted to start');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

// UndoAction type is imported from './types'

const undoStack: UndoAction[] = [];
const redoStack: UndoAction[] = [];

const activeArchiveProcesses = new Map<string, any>();
const activeFolderSizeCalculations = new Map<string, { aborted: boolean }>();
const activeChecksumCalculations = new Map<string, { aborted: boolean }>();

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}

function pushUndoAction(action: UndoAction): void {
  undoStack.push(action);
  if (undoStack.length > MAX_UNDO_STACK_SIZE) {
    undoStack.shift();
  }
  redoStack.length = 0;
  console.log('[Undo] Action pushed:', action.type, 'Stack size:', undoStack.length);
}

function pushRedoAction(action: UndoAction): void {
  redoStack.push(action);
  if (redoStack.length > MAX_UNDO_STACK_SIZE) {
    redoStack.shift();
  }
  console.log('[Redo] Action pushed:', action.type, 'Stack size:', redoStack.length);
}

const defaultSettings: Settings = {
  transparency: true,
  theme: 'default',
  sortBy: 'name',
  sortOrder: 'asc',
  bookmarks: [],
  viewMode: 'grid',
  showDangerousOptions: false,
  startupPath: '',
  showHiddenFiles: false,
  enableSearchHistory: true,
  searchHistory: [],
  directoryHistory: [],
  enableIndexer: true,
  minimizeToTray: false,
  startOnLogin: false,
  autoCheckUpdates: true
};

function applyLoginItemSettings(settings: Settings): void {
  try {
    console.log('[LoginItem] Applying settings:', settings.startOnLogin);

    if (process.platform === 'win32') {
      if (process.windowsStore) {
        console.log('[LoginItem] MS Store app - using StartupTask');
        app.setLoginItemSettings({
          openAtLogin: settings.startOnLogin,
          name: 'IYERIS',
          // can't use path || args for APPX apps
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
      // macOS - open args
      app.setLoginItemSettings({
        openAtLogin: settings.startOnLogin,
        args: settings.startOnLogin ? ['--hidden'] : [],
        name: 'IYERIS'
      });
    } else {
      // Linux - basic login
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

function getSettingsPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'settings.json');
}

let cachedSettings: Settings | null = null;
let settingsCacheTime: number = 0;

async function loadSettings(): Promise<Settings> {
  const now = Date.now();
  if (cachedSettings && (now - settingsCacheTime) < SETTINGS_CACHE_TTL_MS) {
    console.log('[Settings] Using cached settings');
    return cachedSettings;
  }

  try {
    const settingsPath = getSettingsPath();
    console.log('[Settings] Loading from:', settingsPath);
    const data = await fs.readFile(settingsPath, 'utf8');
    const settings = { ...defaultSettings, ...JSON.parse(data) };
    console.log('[Settings] Loaded:', JSON.stringify(settings, null, 2));
    cachedSettings = settings;
    settingsCacheTime = now;
    return settings;
  } catch (error) {
    console.log('[Settings] File not found, using defaults');
    const settings = { ...defaultSettings };
    cachedSettings = settings;
    settingsCacheTime = now;
    return settings;
  }
}

async function saveSettings(settings: Settings): Promise<ApiResponse> {
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

async function isFileHidden(filePath: string, fileName: string): Promise<boolean> {
  if (fileName.startsWith('.')) {
    return true;
  }

  if (process.platform === 'win32') {
    try {
      const { execFile } = await import('child_process');
      const execFilePromise = promisify(execFile);

      const { stdout } = await execFilePromise('attrib', [filePath], {
        timeout: 500,
        windowsHide: true
      });

      return stdout.trim().charAt(0).toUpperCase() === 'H';
    } catch (error) {
      return false;
    }
  }

  return false;
}

async function batchCheckHiddenFiles(dirPath: string, fileNames: string[]): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();

  for (const fileName of fileNames) {
    if (fileName.startsWith('.')) {
      results.set(fileName, true);
    }
  }

  if (process.platform !== 'win32') {
    return results;
  }

  try {
    const { execFile } = await import('child_process');
    const execFilePromise = promisify(execFile);

    const nonDotFiles = fileNames.filter(f => !f.startsWith('.'));
    const batchSize = 50;

    for (let i = 0; i < nonDotFiles.length; i += batchSize) {
      const batch = nonDotFiles.slice(i, i + batchSize);
      const checks = batch.map(async (fileName) => {
        try {
          const filePath = path.join(dirPath, fileName);
          const { stdout } = await execFilePromise('attrib', [filePath], {
            timeout: 500,
            windowsHide: true
          });
          const isHidden = stdout.trim().charAt(0).toUpperCase() === 'H';
          results.set(fileName, isHidden);
        } catch {
          results.set(fileName, false);
        }
      });
      await Promise.all(checks);
    }
  } catch (error) {
    console.error('Error checking hidden files:', error);
  }

  return results;
}

const hiddenFileCache = new Map<string, { isHidden: boolean; timestamp: number }>();
let isCleaningCache = false;

// Periodic cleanup
function cleanupHiddenFileCache(): void {
  if (isCleaningCache) return;
  isCleaningCache = true;
  
  try {
    const now = Date.now();
    let entriesRemoved = 0;

    for (const [key, value] of hiddenFileCache) {
      if (now - value.timestamp > HIDDEN_FILE_CACHE_TTL) {
        hiddenFileCache.delete(key);
        entriesRemoved++;
      }
    }

    if (hiddenFileCache.size > HIDDEN_FILE_CACHE_MAX) {
      const entries = Array.from(hiddenFileCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = entries.slice(0, hiddenFileCache.size - HIDDEN_FILE_CACHE_MAX);
      for (const [key] of toRemove) {
        hiddenFileCache.delete(key);
        entriesRemoved++;
      }
    }
    
    if (entriesRemoved > 0) {
      console.log(`[Cache] Cleaned up ${entriesRemoved} hidden file cache entries, ${hiddenFileCache.size} remaining`);
    }
  } finally {
    isCleaningCache = false;
  }
}

if (!hiddenFileCacheCleanupInterval) {
  hiddenFileCacheCleanupInterval = setInterval(cleanupHiddenFileCache, 5 * 60 * 1000);
}

async function isFileHiddenCached(filePath: string, fileName: string): Promise<boolean> {
  if (fileName.startsWith('.')) {
    return true;
  }

  if (process.platform !== 'win32') {
    return false;
  }

  const cached = hiddenFileCache.get(filePath);
  if (cached && (Date.now() - cached.timestamp) < HIDDEN_FILE_CACHE_TTL) {
    return cached.isHidden;
  }

  const isHidden = await isFileHidden(filePath, fileName);

  if (hiddenFileCache.size >= HIDDEN_FILE_CACHE_MAX) {
    cleanupHiddenFileCache();
  }
  
  hiddenFileCache.set(filePath, { isHidden, timestamp: Date.now() });
  
  return isHidden;
}

function createWindow(isInitialWindow: boolean = false): BrowserWindow {
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
      plugins: false
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
    } catch {
    }
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
    if (!isQuitting) {
      const settings = await loadSettings();
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
    if (mainWindow === newWindow) {
      const allWindows = BrowserWindow.getAllWindows();
      mainWindow = allWindows.length > 0 ? allWindows[0] : null;
      console.log('[Window] mainWindow updated after close, remaining windows:', allWindows.length);
    }
  });

  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = newWindow;
  }

  return newWindow;
}

async function checkFullDiskAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    console.log('[FDA] Not on macOS, skipping check');
    return true;
  }

  console.log('[FDA] Testing Full Disk Access...');
  console.log('[FDA] App path:', app.getPath('exe'));
  console.log('[FDA] Process path:', process.execPath);

  try {
    const tccPath = path.join(app.getPath('home'), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db');
    console.log('[FDA] Testing TCC.db at:', tccPath);

    const fileHandle = await fs.open(tccPath, 'r');
    await fileHandle.close();
    
    console.log('[FDA] Can read TCC.db');
    return true;
  } catch (error) {
    const err = error as any;
    console.log('[FDA] Cannot read TCC.db:', err.code || 'ERROR', '-', err.message);
  }

  const testPaths = [
    path.join(app.getPath('home'), 'Library', 'Safari'),
    path.join(app.getPath('home'), 'Library', 'Mail'),
    path.join(app.getPath('home'), 'Library', 'Messages')
  ];

  for (const testPath of testPaths) {
    try {
      console.log('[FDA] Testing:', testPath);
      const stats = await fs.stat(testPath);
      if (stats.isDirectory()) {
        const files = await fs.readdir(testPath);
        console.log('[FDA] Full Disk Access (read', files.length, 'items from', testPath + '): OK');
        return true;
      }
    } catch (error) {
      const err = error as any;
      console.log('[FDA] Failed:', testPath, '-', err.code || err.message);
    }
  }

  console.log('[FDA] Full Disk Access: NOT granted');
  return false;
}

async function showFullDiskAccessDialog(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.log('[FDA] Cannot show dialog - no valid window');
    return;
  }
  console.log('[FDA] Showing Full Disk Access dialog');
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Full Disk Access Required',
    message: 'IYERIS needs Full Disk Access for full functionality',
    detail: 'To browse all files and folders on your Mac without repeated permission prompts, IYERIS needs Full Disk Access.\n\n' +
            'How to grant access:\n' +
            '1. Click "Open Settings" below\n' +
            '2. Click the + button to add an app\n' +
            '3. Navigate to Applications and select IYERIS\n' +
            '4. Make sure the toggle next to IYERIS is ON\n' +
            '5. Restart IYERIS\n\n' +
            'Without this, you\'ll see permission prompts for each folder.',
    buttons: ['Open Settings', 'Remind Me Later', 'Don\'t Ask Again'],
    defaultId: 0,
    cancelId: 1
  });

  console.log('[FDA] User selected option:', result.response);
  if (result.response === 0) {
    console.log('[FDA] Opening System Settings...');
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
  } else if (result.response === 2) {
    console.log('[FDA] User: "Don\'t Ask Again"');
    const settings = await loadSettings();
    settings.skipFullDiskAccessPrompt = true;
    await saveSettings(settings);
  }
}

function setupApplicationMenu(): void {
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

app.whenReady().then(async () => {
  setupApplicationMenu();

  checkMsiInstallation();
  warmupDrivesCache();

  const settingsPromise = loadSettings();

  shouldStartHidden = process.argv.includes('--hidden');

  const startupSettings = await settingsPromise;

  if (!shouldStartHidden && process.windowsStore) {
    try {
      const loginItemSettings = app.getLoginItemSettings();
      console.log('[Startup] MS Store login item settings:', JSON.stringify(loginItemSettings));
      if (loginItemSettings.wasOpenedAtLogin && startupSettings.startOnLogin) {
        shouldStartHidden = true;
        console.log('[Startup] MS Store: Detected wasOpenedAtLogin, will start hidden');
      }
    } catch (error) {
      console.error('[Startup] Error checking MS Store login settings:', error);
    }
  }

  if (!shouldStartHidden && process.platform === 'darwin') {
    try {
      const loginItemSettings = app.getLoginItemSettings();
      console.log('[Startup] macOS login item settings:', JSON.stringify(loginItemSettings));
      if (loginItemSettings.wasOpenedAtLogin && startupSettings.startOnLogin) {
        shouldStartHidden = true;
        console.log('[Startup] macOS: Detected wasOpenedAtLogin, will start hidden');
      }
    } catch (error) {
      console.error('[Startup] Error checking login item settings:', error);
    }
  }

  console.log('[Startup] Starting with hidden mode:', shouldStartHidden);

  if (shouldStartHidden && (startupSettings.minimizeToTray || startupSettings.startOnLogin)) {
    console.log('[Startup] Creating tray before window for hidden start');
    createTrayForHiddenStart();
  }

  createWindow(true);

  if (!tray) {
    createTray();
  }

  mainWindow?.once('ready-to-show', () => {
    setTimeout(async () => {
      try {
        applyLoginItemSettings(startupSettings);

        if (startupSettings.enableIndexer) {
          const indexerDelay = process.platform === 'win32' ? 2000 : 500;
          fileIndexer = new FileIndexer();
          const indexer = fileIndexer;
          setTimeout(() => {
            indexer.initialize(startupSettings.enableIndexer).catch(err =>
              console.error('[Indexer] Background initialization failed:', err)
            );
          }, indexerDelay);
        }

        // Defer auto-updater setup
        setTimeout(() => {
          try {
            const autoUpdater = getAutoUpdater();
            autoUpdater.logger = console;
            autoUpdater.autoDownload = false;
            autoUpdater.autoInstallOnAppQuit = true;
            
            const currentVersion = app.getVersion();
            const isBetaVersion = /-(beta|alpha|rc)/i.test(currentVersion);
            const isBetaBuild = process.env.IS_BETA === 'true' || isBetaVersion;
            
            if (isBetaBuild) {
              autoUpdater.channel = 'beta';
              autoUpdater.allowPrerelease = true;
              console.log('[AutoUpdater] Beta channel enabled - will ONLY check for beta/prerelease updates');
              console.log('[AutoUpdater] Current version:', currentVersion);
            }

            if (isRunningInFlatpak()) {
              console.log('[AutoUpdater] Running in Flatpak - auto-updater disabled');
              console.log('[AutoUpdater] Updates should be installed via: flatpak update com.burnttoasters.iyeris');
            } else if (process.mas) {
              console.log('[AutoUpdater] Running in Mac App Store - auto-updater disabled');
            } else if (process.windowsStore) {
              console.log('[AutoUpdater] Running in Microsoft Store - auto-updater disabled');
              console.log('[AutoUpdater] Updates are handled by the Microsoft Store');
            } else if (isInstalledViaMsi()) {
              console.log('[AutoUpdater] Installed via MSI (enterprise) - auto-updater disabled');
              console.log('[AutoUpdater] Updates should be managed by your IT administrator');
            }
            autoUpdater.on('checking-for-update', () => {
              console.log('[AutoUpdater] Checking for update...');
              safeSendToWindow(mainWindow, 'update-checking');
            });

            autoUpdater.on('update-available', (info: { version: string }) => {
              console.log('[AutoUpdater] Update available:', info.version);

              const updateIsBeta = /-(beta|alpha|rc)/i.test(info.version);
              if (isBetaBuild && !updateIsBeta) {
                console.log(`[AutoUpdater] Beta build ignoring stable release ${info.version} - only accepting beta/prerelease updates`);
                safeSendToWindow(mainWindow, 'update-not-available', { version: currentVersion });
                return;
              }

              const comparison = compareVersions(info.version, currentVersion);
              if (comparison <= 0) {
                console.log(`[AutoUpdater] Ignoring update ${info.version} - current version ${currentVersion} is newer or equal`);
                safeSendToWindow(mainWindow, 'update-not-available', { version: currentVersion });
                return;
              }

              safeSendToWindow(mainWindow, 'update-available', info);
            });

            autoUpdater.on('update-not-available', (info: { version: string }) => {
              console.log('[AutoUpdater] Update not available. Current version:', info.version);
              safeSendToWindow(mainWindow, 'update-not-available', info);
            });

            autoUpdater.on('error', (err: Error) => {
              console.error('[AutoUpdater] Error:', err);
              safeSendToWindow(mainWindow, 'update-error', err.message);
            });

            autoUpdater.on('download-progress', (progressObj: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => {
              console.log(`[AutoUpdater] Download progress: ${progressObj.percent.toFixed(2)}%`);
              safeSendToWindow(mainWindow, 'update-download-progress', {
                percent: progressObj.percent,
                bytesPerSecond: progressObj.bytesPerSecond,
                transferred: progressObj.transferred,
                total: progressObj.total
              });
            });

            autoUpdater.on('update-downloaded', (info: { version: string }) => {
              console.log('[AutoUpdater] Update downloaded:', info.version);
              safeSendToWindow(mainWindow, 'update-downloaded', info);
            });

            if (!isRunningInFlatpak() && !process.mas && !process.windowsStore && !isInstalledViaMsi() && !isDev && startupSettings.autoCheckUpdates !== false) {
              console.log('[AutoUpdater] Checking for updates on startup...');
              autoUpdater.checkForUpdates().catch((err: Error) => {
                console.error('[AutoUpdater] Startup check failed:', err);
              });
            } else if (startupSettings.autoCheckUpdates === false) {
              console.log('[AutoUpdater] Auto-check on startup disabled by user');
            }
          } catch (error) {
            console.error('[AutoUpdater] Setup failed:', error);
          }
        }, 1000);

        if (process.platform === 'darwin') {
          setTimeout(async () => {
            console.log('[FDA] Running Full Disk Access check');
            const hasAccess = await checkFullDiskAccess();
            
            if (hasAccess) {
              console.log('[FDA] Full Disk Access already granted');
              const settings = await loadSettings();
              if (settings.skipFullDiskAccessPrompt) {
                delete settings.skipFullDiskAccessPrompt;
                await saveSettings(settings);
              }
              return;
            }
            
            const settings = await loadSettings();
            if (!settings.skipFullDiskAccessPrompt) {
              await showFullDiskAccessDialog();
            }
          }, 5000);
        }
      } catch (error) {
        console.error('[Startup] Background initialization error:', error);
      }
    }, 100);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(false); // Not initial window
    } else {
      mainWindow?.show();
      mainWindow?.focus();
      if (process.platform === 'darwin') {
        app.dock?.show();
      }
    }
  });

  // Power management event handling
  powerMonitor.on('suspend', () => {
    console.log('[PowerMonitor] System is going to sleep');
    // Pause bg operations
    try {
      if (fileIndexer) {
        console.log('[PowerMonitor] Pausing indexer before sleep');
        fileIndexer.setEnabled(false);
      }
    } catch (error) {
      console.error('[PowerMonitor] Error pausing indexer:', error);
    }
  });

  powerMonitor.on('resume', async () => {
    console.log('[PowerMonitor] System resumed from sleep');
    setTimeout(async () => {
      console.log('[PowerMonitor] Post-resume initialization');

      try {
        const settings = await loadSettings();
        if (fileIndexer && settings.enableIndexer) {
          console.log('[PowerMonitor] Re-enabling indexer after resume');
          fileIndexer.setEnabled(true);
        }
      } catch (error) {
        console.error('[PowerMonitor] Error re-enabling indexer:', error);
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          if (mainWindow.isVisible() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('system-resumed');
          }
        } catch (error) {
          console.error('[PowerMonitor] Error after resume:', error);
        }
      }
    }, 2000);
  });

  powerMonitor.on('lock-screen', () => {
    console.log('[PowerMonitor] Screen locked');
  });

  powerMonitor.on('unlock-screen', () => {
    console.log('[PowerMonitor] Screen unlocked');
  });
});

app.on('before-quit', () => {
  isQuitting = true;

  if (hiddenFileCacheCleanupInterval) {
    clearInterval(hiddenFileCacheCleanupInterval);
    hiddenFileCacheCleanupInterval = null;
  }
  hiddenFileCache.clear();

  for (const [operationId, process] of activeArchiveProcesses) {
    console.log('[Cleanup] Aborting archive operation:', operationId);
    try {
      if (process._childProcess) {
        process._childProcess.kill('SIGTERM');
      } else if (typeof process.cancel === 'function') {
        process.cancel();
      }
    } catch (error) {
      console.error('[Cleanup] Error aborting archive operation:', error);
    }
  }
  activeArchiveProcesses.clear();

  for (const [operationId, operation] of activeFolderSizeCalculations) {
    console.log('[Cleanup] Aborting folder size calculation:', operationId);
    operation.aborted = true;
  }
  activeFolderSizeCalculations.clear();

  for (const [operationId, operation] of activeChecksumCalculations) {
    console.log('[Cleanup] Aborting checksum calculation:', operationId);
    operation.aborted = true;
  }
  activeChecksumCalculations.clear();
  
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

ipcMain.handle('get-directory-contents', async (_event: IpcMainInvokeEvent, dirPath: string): Promise<DirectoryResponse> => {
  try {
    if (!isPathSafe(dirPath)) {
      console.warn('[Security] Invalid path rejected:', dirPath);
      return { success: false, error: 'Invalid path' };
    }

    const items = await fs.readdir(dirPath, { withFileTypes: true });

    const hiddenMap = await batchCheckHiddenFiles(dirPath, items.map(item => item.name));

    const batchSize = 100;
    const contents: FileItem[] = [];

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (item): Promise<FileItem> => {
          const fullPath = path.join(dirPath, item.name);
          const isHidden = hiddenMap.get(item.name) || item.name.startsWith('.');

          try {
            const stats = await fs.stat(fullPath);
            return {
              name: item.name,
              path: fullPath,
              isDirectory: item.isDirectory(),
              isFile: item.isFile(),
              size: stats.size,
              modified: stats.mtime,
              isHidden
            };
          } catch (err) {
            return {
              name: item.name,
              path: fullPath,
              isDirectory: item.isDirectory(),
              isFile: item.isFile(),
              size: 0,
              modified: new Date(),
              isHidden
            };
          }
        })
      );
      contents.push(...batchResults);
    }

    return { success: true, contents };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('get-drives', async (): Promise<string[]> => {
  return getDrives();
});

ipcMain.handle('get-home-directory', (): string => {
  return app.getPath('home');
});

ipcMain.handle('open-file', async (_event: IpcMainInvokeEvent, filePath: string): Promise<ApiResponse> => {
  try {
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      if (!isUrlSafe(filePath)) {
        console.warn('[Security] Unsafe URL rejected:', filePath);
        return { success: false, error: 'Invalid or unsafe URL' };
      }
      await shell.openExternal(filePath);
    } else {
      if (!isPathSafe(filePath)) {
        console.warn('[Security] Invalid path rejected:', filePath);
        return { success: false, error: 'Invalid path' };
      }
      await shell.openPath(filePath);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('select-folder', async (): Promise<PathResponse> => {
  if (!mainWindow) {
    return { success: false, error: 'No main window available' };
  }
  
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    return { success: true, path: result.filePaths[0] };
  }
  return { success: false };
});

ipcMain.handle('minimize-window', (): void => {
  mainWindow?.minimize();
});

ipcMain.handle('maximize-window', (): void => {
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
  createWindow(false); // User-triggered window
});

ipcMain.handle('create-folder', async (_event: IpcMainInvokeEvent, parentPath: string, folderName: string): Promise<PathResponse> => {
  try {
    if (!isPathSafe(parentPath)) {
      console.warn('[Security] Invalid parent path rejected:', parentPath);
      return { success: false, error: 'Invalid path' };
    }
    if (folderName.includes('..') || folderName.includes('/') || folderName.includes('\\')) {
      console.warn('[Security] Invalid folder name rejected:', folderName);
      return { success: false, error: 'Invalid folder name' };
    }
    
    const newPath = path.join(parentPath, folderName);

    await fs.mkdir(newPath);
    
    pushUndoAction({
      type: 'create',
      data: {
        path: newPath,
        isDirectory: true
      }
    });
    
    console.log('[Create] Folder created:', newPath);
    return { success: true, path: newPath };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('trash-item', async (_event: IpcMainInvokeEvent, itemPath: string): Promise<ApiResponse> => {
  try {
    if (!isPathSafe(itemPath)) {
      console.warn('[Security] Invalid path rejected:', itemPath);
      return { success: false, error: 'Invalid path' };
    }
    
    await shell.trashItem(itemPath);
    
    const pathsToRemove = [itemPath];
    
    for (let i = undoStack.length - 1; i >= 0; i--) {
      const action = undoStack[i];
      if (action.type === 'rename' && action.data.newPath === itemPath) {
        pathsToRemove.push(action.data.oldPath);
      }
    }
    
    for (let i = undoStack.length - 1; i >= 0; i--) {
      const action = undoStack[i];
      let shouldRemove = false;
      
      if (action.type === 'rename') {
        if (pathsToRemove.includes(action.data.oldPath) || pathsToRemove.includes(action.data.newPath)) {
          shouldRemove = true;
        }
      } else if (action.type === 'create') {
        if (pathsToRemove.includes(action.data.path)) {
          shouldRemove = true;
        }
      } else if (action.type === 'move') {
        if (action.data.sourcePaths.some((p: string) => pathsToRemove.includes(p))) {
          shouldRemove = true;
        }
      }
      
      if (shouldRemove) {
        undoStack.splice(i, 1);
        console.log('[Trash] Removed related undo action:', action.type);
      }
    }
    
    console.log('[Trash] Item moved to trash:', itemPath, '- Undo stack size:', undoStack.length);
    return { success: true };
  } catch (error) {
    console.error('[Trash] Error:', error);
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('open-trash', async (): Promise<ApiResponse> => {
  try {
    const platform = process.platform;
    
    if (platform === 'darwin') {
      const trashPath = path.join(app.getPath('home'), '.Trash');
      await shell.openPath(trashPath);
    } else if (platform === 'win32') {
      await shell.openExternal('shell:RecycleBinFolder');
    } else if (platform === 'linux') {
      const trashPath = path.join(app.getPath('home'), '.local/share/Trash/files');
      await shell.openPath(trashPath);
    }
    
    console.log('[Trash] Opened system trash folder');
    return { success: true };
  } catch (error) {
    console.error('[Trash] Error opening trash:', error);
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('delete-item', async (_event: IpcMainInvokeEvent, itemPath: string): Promise<ApiResponse> => {
  try {
    if (!isPathSafe(itemPath)) {
      console.warn('[Security] Invalid path rejected:', itemPath);
      return { success: false, error: 'Invalid path' };
    }
    
    const stats = await fs.stat(itemPath);
    if (stats.isDirectory()) {
      await fs.rm(itemPath, { recursive: true, force: true });
    } else {
      await fs.unlink(itemPath);
    }
    console.log('[Delete] Item permanently deleted:', itemPath);
    return { success: true };
  } catch (error) {
    console.error('[Delete] Error:', error);
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('rename-item', async (_event: IpcMainInvokeEvent, oldPath: string, newName: string): Promise<PathResponse> => {
  if (!isPathSafe(oldPath)) {
    console.warn('[Security] Invalid path rejected:', oldPath);
    return { success: false, error: 'Invalid path' };
  }
  if (newName.includes('..') || newName.includes('/') || newName.includes('\\')) {
    console.warn('[Security] Invalid new name rejected:', newName);
    return { success: false, error: 'Invalid file name' };
  }
  
  const oldName = path.basename(oldPath);
  const newPath = path.join(path.dirname(oldPath), newName);
  try {
    await fs.rename(oldPath, newPath);
    
    pushUndoAction({
      type: 'rename',
      data: {
        oldPath: oldPath,
        newPath: newPath,
        oldName: oldName,
        newName: newName
      }
    });
    
    console.log('[Rename] Item renamed:', oldPath, '->', newPath);
    return { success: true, path: newPath };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      const newExists = await fs.stat(newPath).then(() => true).catch(() => false);
      if (newExists) {
        return { success: true, path: newPath };
      }
    }
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('create-file', async (_event: IpcMainInvokeEvent, parentPath: string, fileName: string): Promise<PathResponse> => {
  try {
    if (!isPathSafe(parentPath)) {
      console.warn('[Security] Invalid parent path rejected:', parentPath);
      return { success: false, error: 'Invalid path' };
    }
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      console.warn('[Security] Invalid file name rejected:', fileName);
      return { success: false, error: 'Invalid file name' };
    }
    
    const newPath = path.join(parentPath, fileName);
    await fs.writeFile(newPath, '');
    
    pushUndoAction({
      type: 'create',
      data: {
        path: newPath,
        isDirectory: false
      }
    });
    
    console.log('[Create] File created:', newPath);
    return { success: true, path: newPath };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('get-item-properties', async (_event: IpcMainInvokeEvent, itemPath: string): Promise<PropertiesResponse> => {
  if (!isPathSafe(itemPath)) {
    return { success: false, error: 'Invalid path' };
  }
  try {
    const stats = await fs.stat(itemPath);
    return {
      success: true,
      properties: {
        path: itemPath,
        name: path.basename(itemPath),
        size: stats.size,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime
      }
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
});

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

  if (result.success && fileIndexer) {
    fileIndexer.setEnabled(settings.enableIndexer);

    if (settings.enableIndexer) {
      fileIndexer.initialize(true).catch(err => {
        console.error('[Settings] Failed to initialize indexer:', err);
      });
    }
  }

  if (result.success) {
    if (settings.minimizeToTray && !tray) {
      await createTray();
    } else if (!settings.minimizeToTray && tray) {
      tray.destroy();
      tray = null;
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
  return await saveSettings(defaultSettings);
});

ipcMain.handle('set-clipboard', (event: IpcMainInvokeEvent, clipboardData: { operation: 'copy' | 'cut'; paths: string[] } | null): void => {
  sharedClipboard = clipboardData;
  console.log('[Clipboard] Updated:', clipboardData ? `${clipboardData.operation} ${clipboardData.paths.length} items` : 'cleared');

  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const allWindows = BrowserWindow.getAllWindows();
  for (const win of allWindows) {
    if (!win.isDestroyed() && win !== senderWindow) {
      win.webContents.send('clipboard-changed', sharedClipboard);
    }
  }
});

ipcMain.handle('get-clipboard', (): { operation: 'copy' | 'cut'; paths: string[] } | null => {
  return sharedClipboard;
});

ipcMain.handle('set-drag-data', (_event: IpcMainInvokeEvent, paths: string[]): void => {
  sharedDragData = paths.length > 0 ? { paths } : null;
  console.log('[Drag] Set drag data:', sharedDragData ? `${paths.length} items` : 'cleared');
});

ipcMain.handle('get-drag-data', (): { paths: string[] } | null => {
  return sharedDragData;
});

ipcMain.handle('clear-drag-data', (): void => {
  sharedDragData = null;
});

ipcMain.handle('relaunch-app', (): void => {
  app.relaunch();
  app.quit();
});

ipcMain.handle('get-settings-path', (): string => {
  return getSettingsPath();
});

ipcMain.handle('copy-items', async (_event: IpcMainInvokeEvent, sourcePaths: string[], destPath: string): Promise<ApiResponse> => {
  try {
    if (!isPathSafe(destPath)) {
      console.warn('[Security] Invalid destination path rejected:', destPath);
      return { success: false, error: 'Invalid destination path' };
    }
    
    for (const sourcePath of sourcePaths) {
      if (!isPathSafe(sourcePath)) {
        console.warn('[Security] Invalid source path rejected:', sourcePath);
        return { success: false, error: 'Invalid source path' };
      }
      
      const itemName = path.basename(sourcePath);
      const destItemPath = path.join(destPath, itemName);

      const sourceExists = await fs.stat(sourcePath).then(() => true).catch(() => false);
      if (!sourceExists) {
        console.log('[Copy] Source file not found:', sourcePath);
        return { success: false, error: `Source file not found: ${itemName}` };
      }

      const destExists = await fs.stat(destItemPath).then(() => true).catch(() => false);
      if (destExists) {
        console.log('[Copy] Destination already exists:', destItemPath);
        return { success: false, error: `A file named "${itemName}" already exists in the destination` };
      }
      
      const stats = await fs.stat(sourcePath);
      if (stats.isDirectory()) {
        await fs.cp(sourcePath, destItemPath, { recursive: true });
      } else {
        await fs.copyFile(sourcePath, destItemPath);
      }
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('move-items', async (_event: IpcMainInvokeEvent, sourcePaths: string[], destPath: string): Promise<ApiResponse> => {
  try {
    if (!isPathSafe(destPath)) {
      console.warn('[Security] Invalid destination path rejected:', destPath);
      return { success: false, error: 'Invalid destination path' };
    }

    for (const sourcePath of sourcePaths) {
      if (!isPathSafe(sourcePath)) {
        console.warn('[Security] Invalid source path rejected:', sourcePath);
        return { success: false, error: 'Invalid source path' };
      }
    }
    
    const originalParent = path.dirname(sourcePaths[0]);
    const movedPaths: string[] = [];
    const originalPaths: string[] = [];
    
    for (const sourcePath of sourcePaths) {
      const fileName = path.basename(sourcePath);
      const newPath = path.join(destPath, fileName);

      const sourceExists = await fs.stat(sourcePath).then(() => true).catch(() => false);
      if (!sourceExists) {
        console.log('[Move] Source file not found:', sourcePath);
        return { success: false, error: `Source file not found: ${fileName}` };
      }

      const destExists = await fs.stat(newPath).then(() => true).catch(() => false);
      if (destExists) {
        console.log('[Move] Destination already exists:', newPath);
        return { success: false, error: `A file named "${fileName}" already exists in the destination` };
      }
      
      try {
        await fs.rename(sourcePath, newPath);
      } catch (renameError) {
        const err = renameError as NodeJS.ErrnoException;
        // If rename fails (e.g., cross-drive), fall back to copy+delete
        if (err.code === 'EXDEV') {
          console.log('[Move] Cross-device move, using copy+delete:', sourcePath);
          const stats = await fs.stat(sourcePath);
          if (stats.isDirectory()) {
            await fs.cp(sourcePath, newPath, { recursive: true });
          } else {
            await fs.copyFile(sourcePath, newPath);
          }
          await fs.rm(sourcePath, { recursive: true, force: true });
        } else {
          throw renameError;
        }
      }
      
      originalPaths.push(sourcePath);
      movedPaths.push(newPath);
    }
    
    pushUndoAction({
      type: 'move',
      data: {
        sourcePaths: movedPaths,
        originalPaths: originalPaths,
        destPath: destPath,
        originalParent: originalParent
      }
    });
    
    console.log('[Move] Items moved:', sourcePaths.length);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
});

interface SearchFilters {
  fileType?: string;
  minSize?: number;
  maxSize?: number;
  dateFrom?: string;
  dateTo?: string;
}

ipcMain.handle('search-files', async (_event: IpcMainInvokeEvent, dirPath: string, query: string, filters?: SearchFilters): Promise<{ success: boolean; results?: FileItem[]; error?: string }> => {
  try {
    if (!isPathSafe(dirPath)) {
      return { success: false, error: 'Invalid directory path' };
    }
    const results: FileItem[] = [];
    const searchQuery = query.toLowerCase();
    const MAX_SEARCH_DEPTH = 10;
    const MAX_RESULTS = 100;

    const dateFrom = filters?.dateFrom ? new Date(filters.dateFrom) : null;
    const dateTo = filters?.dateTo ? new Date(filters.dateTo) : null;
    if (dateTo) dateTo.setHours(23, 59, 59, 999);

    const fileTypeFilter = filters?.fileType?.toLowerCase();
    const minSize = filters?.minSize;
    const maxSize = filters?.maxSize;

    function matchesFilters(itemName: string, isDir: boolean, stats: { size: number; mtime: Date }): boolean {
      if (fileTypeFilter && fileTypeFilter !== 'all') {
        if (fileTypeFilter === 'folder') {
          if (!isDir) return false;
        } else {
          if (isDir) return false;
          const ext = path.extname(itemName).toLowerCase().slice(1);
          if (fileTypeFilter === 'image' && !['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext)) return false;
          if (fileTypeFilter === 'video' && !['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv'].includes(ext)) return false;
          if (fileTypeFilter === 'audio' && !['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'].includes(ext)) return false;
          if (fileTypeFilter === 'document' && !['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return false;
          if (fileTypeFilter === 'archive' && !['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return false;
        }
      }

      if (!isDir) {
        if (minSize !== undefined && stats.size < minSize) return false;
        if (maxSize !== undefined && stats.size > maxSize) return false;
      }

      if (dateFrom && stats.mtime < dateFrom) return false;
      if (dateTo && stats.mtime > dateTo) return false;

      return true;
    }

    async function searchDirectory(currentPath: string, depth: number = 0): Promise<void> {
      if (depth >= MAX_SEARCH_DEPTH || results.length >= MAX_RESULTS) {
        return;
      }

      try {
        const items = await fs.readdir(currentPath, { withFileTypes: true });

        for (const item of items) {
          if (results.length >= MAX_RESULTS) {
            return;
          }

          const fullPath = path.join(currentPath, item.name);

          if (item.name.toLowerCase().includes(searchQuery)) {
            try {
              const stats = await fs.stat(fullPath);
              const isDir = item.isDirectory();

              if (matchesFilters(item.name, isDir, stats)) {
                const isHidden = await isFileHiddenCached(fullPath, item.name);
                results.push({
                  name: item.name,
                  path: fullPath,
                  isDirectory: isDir,
                  isFile: item.isFile(),
                  size: stats.size,
                  modified: stats.mtime,
                  isHidden
                });
              }
            } catch {
            }
          }

          if (item.isDirectory() && results.length < MAX_RESULTS) {
            try {
              await searchDirectory(fullPath, depth + 1);
            } catch {
            }
          }
        }
      } catch {
      }
    }

    await searchDirectory(dirPath, 0);
    return { success: true, results };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
});

ipcMain.handle('get-disk-space', async (_event: IpcMainInvokeEvent, drivePath: string): Promise<{ success: boolean; total?: number; free?: number; error?: string }> => {
  console.log('[Main] get-disk-space called with path:', drivePath, 'Platform:', process.platform);
  try {
    if (process.platform === 'win32') {
      return new Promise((resolve) => {
        const driveLetter = drivePath.substring(0, 2);
        const driveChar = driveLetter.charAt(0).toUpperCase();

        // Validate A-Z
        if (!/^[A-Z]$/.test(driveChar)) {
          console.error('[Main] Invalid drive letter:', driveChar);
          resolve({ success: false, error: 'Invalid drive letter' });
          return;
        }

        console.log('[Main] Getting disk space for drive:', driveChar);
        const psCommand = `Get-PSDrive -Name ${driveChar} | Select-Object @{Name='Free';Expression={$_.Free}}, @{Name='Used';Expression={$_.Used}} | ConvertTo-Json`;

        const { child: psProcess, timedOut } = spawnWithTimeout(
          'powershell',
          ['-Command', psCommand],
          5000,
          { shell: false }
        );
        let stdout = '';
        let stderr = '';

        if (psProcess.stdout) {
          psProcess.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
          });
        }

        if (psProcess.stderr) {
          psProcess.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
          });
        }

        psProcess.on('close', (code) => {
          if (timedOut()) {
            resolve({ success: false, error: 'Disk space query timed out' });
            return;
          }
          if (code !== 0) {
            console.error('[Main] PowerShell error:', stderr);
            resolve({ success: false, error: 'PowerShell command failed' });
            return;
          }
          console.log('[Main] PowerShell output:', stdout);
          try {
            const data = JSON.parse(stdout.trim());
            const free = parseInt(data.Free);
            const used = parseInt(data.Used);
            const total = free + used;
            console.log('[Main] Success - Free:', free, 'Used:', used, 'Total:', total);
            resolve({ success: true, free, total });
          } catch (parseError) {
            console.error('[Main] JSON parse error:', parseError);
            resolve({ success: false, error: 'Could not parse disk info' });
          }
        });
      });
    } else if (process.platform === 'darwin' || process.platform === 'linux') {
      return new Promise((resolve) => {
        const { child: dfProcess, timedOut } = spawnWithTimeout(
          'df',
          ['-k', drivePath],
          5000,
          { shell: false }
        );
        let stdout = '';
        let stderr = '';

        if (dfProcess.stdout) {
          dfProcess.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
          });
        }

        if (dfProcess.stderr) {
          dfProcess.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
          });
        }

        dfProcess.on('close', (code) => {
          if (timedOut()) {
            resolve({ success: false, error: 'Disk space query timed out' });
            return;
          }
          if (code !== 0) {
            console.error('[Main] df error:', stderr);
            resolve({ success: false, error: 'df command failed' });
            return;
          }
          const lines = stdout.trim().split('\n');
          if (lines.length < 2) {
            resolve({ success: false, error: 'Could not parse disk info' });
            return;
          }

          const parts = lines[1].trim().split(/\s+/);
          if (parts.length >= 4) {
            const total = parseInt(parts[1]) * 1024;
            const available = parseInt(parts[3]) * 1024;
            resolve({ success: true, total, free: available });
          } else {
            resolve({ success: false, error: 'Invalid disk info format' });
          }
        });
      });
    } else {
      return { success: false, error: 'Disk space info not available on this platform' };
    }
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('restart-as-admin', async (): Promise<ApiResponse> => {
  try {
    const platform = process.platform;
    const appPath = app.getPath('exe');
    const execFilePromise = promisify(execFile);

    if (platform === 'win32') {
      try {
        await execFilePromise('powershell', [
          '-NoProfile',
          '-Command',
          'Start-Process',
          '-FilePath', appPath,
          '-Verb', 'RunAs'
        ]);
        app.quit();
        return { success: true };
      } catch (error) {
        console.log('[Admin] Failed to restart as admin:', getErrorMessage(error));
        return { success: false, error: 'Failed to restart with admin privileges. The request may have been cancelled.' };
      }
    } else if (platform === 'darwin') {
      try {
        await execFilePromise('osascript', [
          '-e', `do shell script quoted form of "${appPath}" with administrator privileges`
        ]);
        app.quit();
        return { success: true };
      } catch (error) {
        console.log('[Admin] Failed to restart as admin:', getErrorMessage(error));
        return { success: false, error: 'Failed to restart with admin privileges. The request may have been cancelled.' };
      }
    } else if (platform === 'linux') {
      try {
        await execFilePromise('pkexec', [appPath]);
        app.quit();
        return { success: true };
      } catch (error) {
        console.log('[Admin] Failed to restart as admin:', getErrorMessage(error));
        return { success: false, error: 'Failed to restart with admin privileges. The request may have been cancelled.' };
      }
    } else {
      return { success: false, error: 'Unsupported platform' };
    }
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('open-terminal', async (_event: IpcMainInvokeEvent, dirPath: string): Promise<ApiResponse> => {
  try {
    if (!isPathSafe(dirPath)) {
      return { success: false, error: 'Invalid directory path' };
    }
    const platform = process.platform;

    if (platform === 'win32') {
      // wt -> cmd.exe fallback
      const hasWT = await new Promise<boolean>((resolve) => {
        exec('where wt', (error) => resolve(!error));
      });

      if (hasWT) {
        spawn('wt', ['-d', dirPath], { shell: false, detached: true });
      } else {
        spawn('cmd', ['/K', 'cd', '/d', dirPath], { shell: false, detached: true });
      }
    } else if (platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', dirPath], { shell: false, detached: true });
    } else {
      const terminals = [
        { cmd: 'x-terminal-emulator', args: ['--working-directory', dirPath] },
        { cmd: 'gnome-terminal', args: ['--working-directory=' + dirPath] },
        { cmd: 'xterm', args: ['-e', 'bash'] }
      ];

      let launched = false;
      for (const term of terminals) {
        try {
          spawn(term.cmd, term.args, { shell: false, detached: true, cwd: dirPath });
          launched = true;
          break;
        } catch (e) {
          continue;
        }
      }

      if (!launched) {
        console.error('No suitable terminal emulator found');
      }
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('read-file-content', async (_event: IpcMainInvokeEvent, filePath: string, maxSize: number = 1024 * 1024): Promise<{ success: boolean; content?: string; error?: string; isTruncated?: boolean }> => {
  try {
    if (!isPathSafe(filePath)) {
      return { success: false, error: 'Invalid file path' };
    }
    const stats = await fs.stat(filePath);
    
    if (stats.size > maxSize) {
      const buffer = Buffer.alloc(maxSize);
      const fileHandle = await fs.open(filePath, 'r');
      try {
        await fileHandle.read(buffer, 0, maxSize, 0);
        return {
          success: true,
          content: buffer.toString('utf8'),
          isTruncated: true
        };
      } finally {
        await fileHandle.close();
      }
    }
    
    const content = await fs.readFile(filePath, 'utf8');
    return { success: true, content, isTruncated: false };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('get-file-data-url', async (_event: IpcMainInvokeEvent, filePath: string, maxSize: number = 10 * 1024 * 1024): Promise<{ success: boolean; dataUrl?: string; error?: string }> => {
  try {
    if (!isPathSafe(filePath)) {
      return { success: false, error: 'Invalid file path' };
    }
    const stats = await fs.stat(filePath);

    if (stats.size > maxSize) {
      return { success: false, error: 'File too large to preview' };
    }
    
    const buffer = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon'
    };
    
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    const base64 = buffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;
    
    return { success: true, dataUrl };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('get-licenses', async (): Promise<{ success: boolean; licenses?: any; error?: string }> => {
  try {
    const licensesPath = path.join(__dirname, '..', 'licenses.json');
    const data = await fs.readFile(licensesPath, 'utf-8');
    const licenses = JSON.parse(data);
    return { success: true, licenses };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('get-platform', (): string => {
  return process.platform;
});

ipcMain.handle('is-mas', (): boolean => {
  return process.mas === true;
});

ipcMain.handle('is-flatpak', (): boolean => {
  return isRunningInFlatpak();
});

ipcMain.handle('is-ms-store', (): boolean => {
  return process.windowsStore === true;
});

ipcMain.handle('check-full-disk-access', async (): Promise<{ success: boolean; hasAccess: boolean }> => {
  const hasAccess = await checkFullDiskAccess();
  return { success: true, hasAccess };
});

ipcMain.handle('request-full-disk-access', async (): Promise<ApiResponse> => {
  try {
    if (process.platform !== 'darwin') {
      return { success: false, error: 'Full Disk Access is only applicable on macOS' };
    }
    
    await showFullDiskAccessDialog();
    return { success: true };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('check-for-updates', async (): Promise<UpdateCheckResponse> => {
  if (isRunningInFlatpak()) {
    const currentVersion = app.getVersion();
    console.log('[AutoUpdater] Flatpak detected - redirecting to Flatpak update mechanism');
    return {
      success: true,
      hasUpdate: false,
      currentVersion: `v${currentVersion}`,
      latestVersion: `v${currentVersion}`,
      isFlatpak: true,
      flatpakMessage: 'Updates are managed by Flatpak. Run: flatpak update com.burnttoasters.iyeris'
    };
  }

  if (process.mas) {
    const currentVersion = app.getVersion();
    console.log('[AutoUpdater] MAS detected - updates managed by App Store');
    return {
      success: true,
      hasUpdate: false,
      currentVersion: `v${currentVersion}`,
      latestVersion: `v${currentVersion}`,
      isMas: true,
      masMessage: 'Updates are managed by the Mac App Store.'
    };
  }

  if (process.windowsStore) {
    const currentVersion = app.getVersion();
    console.log('[AutoUpdater] Microsoft Store detected - updates managed by Microsoft Store');
    return {
      success: true,
      hasUpdate: false,
      currentVersion: `v${currentVersion}`,
      latestVersion: `v${currentVersion}`,
      isMsStore: true,
      msStoreMessage: 'Updates are managed by the Microsoft Store.'
    };
  }

  if (await checkMsiInstallation()) {
    const currentVersion = app.getVersion();
    console.log('[AutoUpdater] MSI installation detected - auto-updates disabled');
    return {
      success: true,
      hasUpdate: false,
      currentVersion: `v${currentVersion}`,
      latestVersion: `v${currentVersion}`,
      isMsi: true,
      msiMessage: 'This is an enterprise installation. Updates are managed by your IT administrator. To enable auto-updates, uninstall the MSI version and install the regular version from the website.'
    };
  }

  try {
    const autoUpdater = getAutoUpdater();
    const currentVersion = app.getVersion();
    console.log('[AutoUpdater] Manually checking for updates. Current version:', currentVersion);
    
    const updateCheckResult = await autoUpdater.checkForUpdates();
    
    if (!updateCheckResult) {
      return { success: false, error: 'Update check returned no result' };
    }

    const updateInfo = updateCheckResult.updateInfo;
    const latestVersion = updateInfo.version;
    
    // Check if this is a beta build
    const isBetaVersion = /-(beta|alpha|rc)/i.test(currentVersion);
    const updateIsBeta = /-(beta|alpha|rc)/i.test(latestVersion);
    
    // Beta builds should only update to other beta versions
    if (isBetaVersion && !updateIsBeta) {
      console.log(`[AutoUpdater] Beta build ignoring stable release ${latestVersion} - only accepting beta/prerelease updates`);
      return {
        success: true,
        hasUpdate: false,
        isBeta: true,
        currentVersion: `v${currentVersion}`,
        latestVersion: `v${currentVersion}`
      };
    }
    
    // Compare versions to check for actual update (not downgrade)
    const comparison = compareVersions(latestVersion, currentVersion);
    const hasUpdate = comparison > 0;

    console.log('[AutoUpdater] Update check result:', {
      hasUpdate,
      currentVersion,
      latestVersion,
      isBetaVersion,
      updateIsBeta
    });

    return {
      success: true,
      hasUpdate,
      isBeta: isBetaVersion,
      updateInfo: {
        version: updateInfo.version,
        releaseDate: updateInfo.releaseDate,
        releaseNotes: updateInfo.releaseNotes as string | undefined
      },
      currentVersion: `v${currentVersion}`,
      latestVersion: `v${latestVersion}`,
      releaseUrl: `https://github.com/BurntToasters/IYERIS/releases/tag/v${latestVersion}`
    };
  } catch (error) {
    console.error('[AutoUpdater] Check for updates failed:', error);
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('download-update', async (): Promise<ApiResponse> => {
  try {
    const autoUpdater = getAutoUpdater();
    console.log('[AutoUpdater] Starting update download...');
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (error) {
    console.error('[AutoUpdater] Download failed:', error);
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('install-update', async (): Promise<ApiResponse> => {
  try {
    const autoUpdater = getAutoUpdater();
    console.log('[AutoUpdater] Installing update and restarting...');
    autoUpdater.quitAndInstall(false, true);
    return { success: true };
  } catch (error) {
    console.error('[AutoUpdater] Install failed:', error);
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('undo-action', async (_event: IpcMainInvokeEvent): Promise<ApiResponse> => {
  if (undoStack.length === 0) {
    return { success: false, error: 'Nothing to undo' };
  }
  
  const action = undoStack.pop()!;
  console.log('[Undo] Undoing action:', action.type);
  
  try {
    switch (action.type) {
      case 'rename':
        try {
          await fs.access(action.data.newPath);
        } catch {
          console.log('[Undo] File no longer exists:', action.data.newPath);
          return { success: false, error: 'Cannot undo: File no longer exists (may have been moved or deleted)' };
        }
        
        try {
          await fs.access(action.data.oldPath);
          console.log('[Undo] Old path already exists:', action.data.oldPath);
          return { success: false, error: 'Cannot undo: A file already exists at the original location' };
        } catch {
        }
        
        await fs.rename(action.data.newPath, action.data.oldPath);
        pushRedoAction(action);
        console.log('[Undo] Renamed back:', action.data.newPath, '->', action.data.oldPath);
        return { success: true };
      
      case 'move':
        const moveSourcePaths = action.data.sourcePaths;
        const originalParent = action.data.originalParent;

        if (!originalParent) {
          return { success: false, error: 'Cannot undo: Original parent path not available' };
        }

        for (const source of moveSourcePaths) {
          try {
            await fs.access(source);
          } catch {
            console.log('[Undo] File no longer exists:', source);
            return { success: false, error: 'Cannot undo: One or more files no longer exist' };
          }
        }

        for (const source of moveSourcePaths) {
          const fileName = path.basename(source);
          const originalPath = path.join(originalParent, fileName);
          await fs.rename(source, originalPath);
        }
        pushRedoAction(action);
        console.log('[Undo] Moved back to original location');
        return { success: true };
      
      case 'create':
        const itemPath = action.data.path;
        
        try {
          await fs.access(itemPath);
        } catch {
          console.log('[Undo] Created item no longer exists:', itemPath);
          return { success: false, error: 'Cannot undo: File no longer exists' };
        }
        
        const stats = await fs.stat(itemPath);
        if (stats.isDirectory()) {
          await fs.rm(itemPath, { recursive: true, force: true });
        } else {
          await fs.unlink(itemPath);
        }
        pushRedoAction(action);
        console.log('[Undo] Deleted created item:', itemPath);
        return { success: true };
      
      default:
        return { success: false, error: 'Unknown action type' };
    }
  } catch (error) {
    console.error('[Undo] Error:', error);
    undoStack.push(action);
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
});

ipcMain.handle('redo-action', async (_event: IpcMainInvokeEvent): Promise<ApiResponse> => {
  if (redoStack.length === 0) {
    return { success: false, error: 'Nothing to redo' };
  }
  
  const action = redoStack.pop()!;
  console.log('[Redo] Redoing action:', action.type);
  
  try {
    switch (action.type) {
      case 'rename':
        await fs.rename(action.data.oldPath, action.data.newPath);
        undoStack.push(action);
        console.log('[Redo] Renamed:', action.data.oldPath, '->', action.data.newPath);
        return { success: true };
      
      case 'move':
        const redoOriginalParent = action.data.originalParent;
        const redoDestPath = action.data.destPath;
        const newMovedPaths: string[] = [];
        const filesToMove = action.data.originalPaths || action.data.sourcePaths;

        if (!redoOriginalParent) {
          return { success: false, error: 'Cannot redo: Original parent path not available' };
        }

        for (const originalPath of filesToMove) {
          const fileName = path.basename(originalPath);
          const currentPath = path.join(redoOriginalParent, fileName);
          const newPath = path.join(redoDestPath, fileName);
          try {
            await fs.access(currentPath);
          } catch {
            console.log('[Redo] File not found at expected location:', currentPath);
            return { success: false, error: 'Cannot redo: File not found at original location' };
          }
          
          await fs.rename(currentPath, newPath);
          newMovedPaths.push(newPath);
        }
        action.data.sourcePaths = newMovedPaths;
        undoStack.push(action);
        console.log('[Redo] Moved to destination');
        return { success: true };
      
      case 'create':
        const itemPath = action.data.path;
        if (action.data.isDirectory) {
          await fs.mkdir(itemPath);
        } else {
          await fs.writeFile(itemPath, '');
        }
        undoStack.push(action);
        console.log('[Redo] Recreated item:', itemPath);
        return { success: true };
      
      default:
        return { success: false, error: 'Unknown action type' };
    }
  } catch (error) {
    console.error('[Redo] Error:', error);
    redoStack.push(action);
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
});

ipcMain.handle('get-undo-redo-state', async (): Promise<{canUndo: boolean; canRedo: boolean}> => {
  return {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0
  };
});

ipcMain.handle('search-index', async (_event: IpcMainInvokeEvent, query: string): Promise<IndexSearchResponse> => {
  try {
    if (!fileIndexer) {
      return { success: false, error: 'Indexer not initialized' };
    }

    if (!fileIndexer.isEnabled()) {
      return { success: false, error: 'Indexer is disabled' };
    }

    const results = await fileIndexer.search(query);
    return { success: true, results };
  } catch (error) {
    console.error('[Indexer] Search error:', error);
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('rebuild-index', async (): Promise<ApiResponse> => {
  try {
    if (!fileIndexer) {
      return { success: false, error: 'Indexer not initialized' };
    }

    console.log('[Indexer] Rebuild requested');
    fileIndexer.rebuildIndex();
    return { success: true };
  } catch (error) {
    console.error('[Indexer] Rebuild error:', error);
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('get-index-status', async (): Promise<{success: boolean; status?: any; error?: string}> => {
  try {
    if (!fileIndexer) {
      return { success: false, error: 'Indexer not initialized' };
    }

    const status = fileIndexer.getStatus();
    return { success: true, status };
  } catch (error) {
    console.error('[Indexer] Status error:', error);
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('compress-files', async (_event: IpcMainInvokeEvent, sourcePaths: string[], outputPath: string, format: string = 'zip', operationId?: string): Promise<ApiResponse> => {
  try {
    if (!isPathSafe(outputPath)) {
      console.warn('[Security] Invalid output path rejected:', outputPath);
      return { success: false, error: 'Invalid output path' };
    }

    for (const sourcePath of sourcePaths) {
      if (!isPathSafe(sourcePath)) {
        console.warn('[Security] Invalid source path rejected:', sourcePath);
        return { success: false, error: 'Invalid source path' };
      }
    }

    const allowedFormats = ['zip', '7z', 'tar', 'tar.gz', 'gz'];
    if (!allowedFormats.includes(format)) {
      console.warn('[Security] Invalid archive format rejected:', format);
      return { success: false, error: 'Invalid archive format' };
    }
    
    console.log('[Compress] Starting compression:', sourcePaths, 'to', outputPath, 'format:', format);

    try {
      await fs.access(outputPath);
      console.log('[Compress] Removing existing file:', outputPath);
      await fs.unlink(outputPath);
    } catch (err) {
    }

    if (format === 'tar.gz') {
      return new Promise(async (resolve, reject) => {
        const Seven = get7zipModule();
        const sevenZipPath = get7zipPath();
        console.log('[Compress] Using 7zip at:', sevenZipPath);
        const tarPath = outputPath.replace(/\.gz$/, '');
        console.log('[Compress] Creating tar file:', tarPath);

        const tarOptions: any = {
          $bin: sevenZipPath,
          recursive: true,
          $raw: ['-xr!My Music', '-xr!My Pictures', '-xr!My Videos']
        };
        
        const tarProcess = Seven.add(tarPath, sourcePaths, tarOptions);

        if (operationId) {
          activeArchiveProcesses.set(operationId, tarProcess);
        }

        let fileCount = 0;
        
        tarProcess.on('progress', (progress: { file?: string }) => {
          fileCount++;
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('compress-progress', {
              operationId,
              current: fileCount,
              total: fileCount + 20,
              name: progress.file || 'Creating tar...'
            });
          }
        });

        tarProcess.on('end', async () => {
          console.log('[Compress] Tar created, now compressing with gzip...');
          const gzipProcess = Seven.add(outputPath, [tarPath], {
            $bin: sevenZipPath
          });

          if (operationId) {
            activeArchiveProcesses.set(operationId, gzipProcess);
          }

          gzipProcess.on('progress', () => {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
              mainWindow.webContents.send('compress-progress', {
                operationId,
                current: fileCount + 10,
                total: fileCount + 20,
                name: 'Compressing with gzip...'
              });
            }
          });

          gzipProcess.on('end', async () => {
            console.log('[Compress] tar.gz compression completed');

            try {
              await fs.unlink(tarPath);
            } catch (err) {
              console.error('[Compress] Failed to delete intermediate tar:', err);
            }
            
            if (operationId) {
              activeArchiveProcesses.delete(operationId);
            }
            resolve({ success: true });
          });

          gzipProcess.on('error', async (error: { message?: string; level?: string }) => {
            console.error('[Compress] Gzip error:', error);

            try {
              await fs.unlink(tarPath);
            } catch {
            }
            try {
              await fs.unlink(outputPath);
            } catch {
            }

            if (operationId) {
              activeArchiveProcesses.delete(operationId);
            }

            const errorMsg = error.message || '';
            if (error.level === 'WARNING' && errorMsg.includes('Access is denied')) {
              console.log('[Compress] Warning about access denied, but gzip compression may have succeeded');
              resolve({ success: true });
            } else {
              reject({ success: false, error: errorMsg || 'Gzip compression failed' });
            }
          });
        });

        tarProcess.on('error', async (error: { message?: string; level?: string }) => {
          console.error('[Compress] Tar error:', error);

          try {
            await fs.unlink(tarPath);
          } catch {
          }

          if (operationId) {
            activeArchiveProcesses.delete(operationId);
          }

          const errorMsg = error.message || '';
          if (error.level === 'WARNING' && errorMsg.includes('Access is denied')) {
            console.log('[Compress] Warning about access denied, but tar creation may have succeeded');
            const gzipProcess = Seven.add(outputPath, [tarPath], {
              $bin: sevenZipPath
            });

            if (operationId) {
              activeArchiveProcesses.set(operationId, gzipProcess);
            }

            gzipProcess.on('end', async () => {
              try {
                await fs.unlink(tarPath);
              } catch {
              }
              if (operationId) {
                activeArchiveProcesses.delete(operationId);
              }
              resolve({ success: true });
            });

            gzipProcess.on('error', async (gzipError: { message?: string }) => {
              try {
                await fs.unlink(tarPath);
                await fs.unlink(outputPath);
              } catch {
              }
              if (operationId) {
                activeArchiveProcesses.delete(operationId);
              }
              reject({ success: false, error: gzipError.message || 'Gzip compression failed' });
            });
          } else {
            reject({ success: false, error: errorMsg || 'Tar creation failed' });
          }
        });
      });
    }

    return new Promise((resolve, reject) => {
      const Seven = get7zipModule();
      const sevenZipPath = get7zipPath();
      console.log('[Compress] Using 7zip at:', sevenZipPath);

      const options: any = {
        $bin: sevenZipPath,
        recursive: true,
        $raw: ['-xr!My Music', '-xr!My Pictures', '-xr!My Videos']
      };
      
      const seven = Seven.add(outputPath, sourcePaths, options);

      if (operationId) {
        activeArchiveProcesses.set(operationId, seven);
      }

      let fileCount = 0;
      
      seven.on('progress', (progress: { file?: string }) => {
        fileCount++;
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('compress-progress', {
            operationId,
            current: fileCount,
            total: fileCount + 10,
            name: progress.file || 'Compressing...'
          });
        }
      });

      seven.on('end', () => {
        console.log('[Compress] 7zip compression completed for format:', format);
        if (operationId) {
          activeArchiveProcesses.delete(operationId);
        }
        resolve({ success: true });
      });

      seven.on('error', (error: { message?: string; level?: string }) => {
        console.error('[Compress] 7zip error:', error);
        if (operationId) {
          activeArchiveProcesses.delete(operationId);
        }
        fs.unlink(outputPath).catch(() => {});

        const errorMsg = error.message || '';
        if (error.level === 'WARNING' && errorMsg.includes('Access is denied')) {
          console.log('[Compress] Warning about access denied, but compression may have succeeded');
          resolve({ success: true });
        } else {
          reject({ success: false, error: errorMsg || 'Compression failed' });
        }
      });
    });
  } catch (error) {
    console.error('[Compress] Error:', error);
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('extract-archive', async (_event: IpcMainInvokeEvent, archivePath: string, destPath: string, operationId?: string): Promise<ApiResponse> => {
  try {
    if (!isPathSafe(archivePath)) {
      console.warn('[Security] Invalid archive path rejected:', archivePath);
      return { success: false, error: 'Invalid archive path' };
    }
    if (!isPathSafe(destPath)) {
      console.warn('[Security] Invalid destination path rejected:', destPath);
      return { success: false, error: 'Invalid destination path' };
    }

    console.log('[Extract] Starting extraction:', archivePath, 'to', destPath);

    await fs.mkdir(destPath, { recursive: true });
    try {
      await assertArchiveEntriesSafe(archivePath, destPath);
    } catch (error) {
      console.error('[Extract] Unsafe archive:', error);
      return { success: false, error: 'Archive contains unsafe paths' };
    }
    return new Promise((resolve, reject) => {
      const Seven = get7zipModule();
      const sevenZipPath = get7zipPath();
      console.log('[Extract] Using 7zip at:', sevenZipPath);
      
      const seven = Seven.extractFull(archivePath, destPath, {
        $bin: sevenZipPath,
        recursive: true
      });

      if (operationId) {
        activeArchiveProcesses.set(operationId, seven);
      }

      let fileCount = 0;
      
      seven.on('progress', (progress: { file?: string }) => {
        fileCount++;
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('extract-progress', {
            operationId,
            current: fileCount,
            total: fileCount + 10,
            name: progress.file || 'Extracting...'
          });
        }
      });

      seven.on('end', () => {
        console.log('[Extract] 7zip extraction completed for:', archivePath);
        if (operationId) {
          activeArchiveProcesses.delete(operationId);
        }
        resolve({ success: true });
      });

      seven.on('error', (error: { message?: string }) => {
        console.error('[Extract] 7zip error:', error);
        if (operationId) {
          activeArchiveProcesses.delete(operationId);
        }
        reject({ success: false, error: error.message || 'Extraction failed' });
      });
    });
  } catch (error) {
    console.error('[Extract] Error:', error);
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('cancel-archive-operation', async (_event: IpcMainInvokeEvent, operationId: string): Promise<ApiResponse> => {
  try {
    const process = activeArchiveProcesses.get(operationId);
    if (!process) {
      console.log('[Archive] Operation not found for cancellation:', operationId);
      return { success: false, error: 'Operation not found' };
    }
    
    console.log('[Archive] Cancelling operation:', operationId);
    if (process._childProcess) {
      try {
        process._childProcess.kill('SIGTERM');
      } catch (killError) {
        console.log('[Archive] Process already terminated:', killError);
      }
    } else if (typeof process.cancel === 'function') {
      process.cancel();
    }
    
    activeArchiveProcesses.delete(operationId);
    return { success: true };
  } catch (error) {
    console.error('[Archive] Cancel error:', error);
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('set-zoom-level', async (event: IpcMainInvokeEvent, zoomLevel: number): Promise<ApiResponse> => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return { success: false, error: 'Window not available' };
    }

    const clampedZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomLevel));
    win.webContents.setZoomFactor(clampedZoom);
    
    console.log('[Zoom] Set zoom level to:', clampedZoom);
    return { success: true };
  } catch (error) {
    console.error('[Zoom] Error:', error);
    return { success: false, error: getErrorMessage(error) };
  }
});

ipcMain.handle('get-zoom-level', async (event: IpcMainInvokeEvent): Promise<{success: boolean; zoomLevel?: number; error?: string}> => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return { success: false, error: 'Window not available' };
    }
    
    const zoomLevel = win.webContents.getZoomFactor();
    return { success: true, zoomLevel };
  } catch (error) {
    console.error('[Zoom] Error:', error);
    return { success: false, error: getErrorMessage(error) };
  }
});

async function createTray(forHiddenStart: boolean = false): Promise<void> {
  const logPrefix = forHiddenStart ? '[Tray] (hidden start)' : '[Tray]';
  
  if (forHiddenStart) {
    if (tray) {
      console.log(`${logPrefix} Tray already exists`);
      return;
    }
  } else {
    const settings = await loadSettings();
    if (!settings.minimizeToTray) {
      console.log(`${logPrefix} Tray disabled in settings`);
      return;
    }
    
    if (tray) {
      tray.destroy();
      tray = null;
    }
  }

  let iconPath: string;
  let trayIcon: Electron.NativeImage;

  const assetsPath = path.join(__dirname, '..', 'assets');

  if (process.platform === 'darwin') {
    const icon32Path = path.join(assetsPath, 'iyeris.iconset', 'icon_32x32@1x.png');
    const iconFallback = path.join(assetsPath, 'icon.png');
    
    if (fsSync.existsSync(icon32Path)) {
      iconPath = icon32Path;
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
    } else {
      iconPath = iconFallback;
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
    }
    console.log(`${logPrefix} macOS: Using color icon from:`, iconPath);
  } else if (process.platform === 'win32') {
    const icoPath = path.join(assetsPath, 'icon-square.ico');
    const pngPath = path.join(assetsPath, 'icon.png');
    
    if (fsSync.existsSync(icoPath)) {
      iconPath = icoPath;
      trayIcon = nativeImage.createFromPath(iconPath);
    } else {
      iconPath = pngPath;
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    }
    console.log(`${logPrefix} Windows: Using icon from:`, iconPath);
  } else {
    const icon32Path = path.join(assetsPath, 'iyeris.iconset', 'icon_32x32@1x.png');
    const iconFallback = path.join(assetsPath, 'icon.png');
    
    if (fsSync.existsSync(icon32Path)) {
      iconPath = icon32Path;
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 24, height: 24 });
    } else {
      iconPath = iconFallback;
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 24, height: 24 });
    }
    console.log(`${logPrefix} Linux: Using icon from:`, iconPath);
  }

  if (trayIcon.isEmpty()) {
    console.error(`${logPrefix} Failed to load tray icon from:`, iconPath);
    return;
  }
  
  try {
    tray = new Tray(trayIcon);
  } catch (error) {
    console.error(`${logPrefix} Failed to create tray icon:`, error);
    if (!forHiddenStart) {
      console.log(`${logPrefix} Minimize to tray feature will be disabled`);
    }
    tray = null;
    return;
  }

  tray.setToolTip('IYERIS');
  
  const contextMenu = Menu.buildFromTemplate([
    { 
      label: 'Show IYERIS', 
      click: () => {
        let targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
        if (!targetWindow) {
          const allWindows = BrowserWindow.getAllWindows();
          targetWindow = allWindows.length > 0 ? allWindows[0] : null;
        }
        
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
    },
    { type: 'separator' },
    { 
      label: 'Quit', 
      click: () => {
        isQuitting = true;
        app.quit();
      } 
    }
  ]);
  
  tray.setContextMenu(contextMenu);

  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      let targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      if (!targetWindow) {
        const allWindows = BrowserWindow.getAllWindows();
        targetWindow = allWindows.length > 0 ? allWindows[0] : null;
      }
      
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
    tray.on('double-click', () => {
      let targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      if (!targetWindow) {
        const allWindows = BrowserWindow.getAllWindows();
        targetWindow = allWindows.length > 0 ? allWindows[0] : null;
      }
      
      if (targetWindow) {
        targetWindow.show();
        targetWindow.focus();
      } else {
        createWindow(false);
      }
      
      app.dock?.show();
    });
  }

  console.log(`${logPrefix} Tray created successfully`);
}

// Legacy wrapper for hidden start calls
async function createTrayForHiddenStart(): Promise<void> {
  return createTray(true);
}

// Folder Size Calc
ipcMain.handle('calculate-folder-size', async (_event: IpcMainInvokeEvent, folderPath: string, operationId: string): Promise<{success: boolean; result?: {totalSize: number; fileCount: number; folderCount: number; fileTypes?: {extension: string; count: number; size: number}[]}; error?: string}> => {
  try {
    if (!isPathSafe(folderPath)) {
      return { success: false, error: 'Invalid folder path' };
    }
    console.log('[FolderSize] Starting calculation for:', folderPath, 'operationId:', operationId);

    const operation = { aborted: false };
    activeFolderSizeCalculations.set(operationId, operation);

    let totalSize = 0;
    let fileCount = 0;
    let folderCount = 0;
    let lastProgressUpdate = Date.now();
    const fileTypeMap = new Map<string, { count: number; size: number }>();

    async function calculateSize(dirPath: string): Promise<void> {
      if (operation.aborted) {
        throw new Error('Calculation cancelled');
      }

      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          if (operation.aborted) {
            throw new Error('Calculation cancelled');
          }

          const fullPath = path.join(dirPath, entry.name);

          try {
            if (entry.isDirectory()) {
              folderCount++;
              await calculateSize(fullPath);
            } else if (entry.isFile()) {
              const stats = await fs.stat(fullPath);
              totalSize += stats.size;
              fileCount++;

              const ext = path.extname(entry.name).toLowerCase() || '(no extension)';
              const existing = fileTypeMap.get(ext) || { count: 0, size: 0 };
              fileTypeMap.set(ext, { count: existing.count + 1, size: existing.size + stats.size });
            }

            const now = Date.now();
            if (now - lastProgressUpdate > 100) {
              lastProgressUpdate = now;
              safeSendToWindow(mainWindow, 'folder-size-progress', {
                operationId,
                calculatedSize: totalSize,
                fileCount,
                folderCount,
                currentPath: fullPath
              });
            }
          } catch (err) {
            console.log(`[FolderSize] Skipping ${fullPath}:`, (err as Error).message);
          }
        }
      } catch (err) {
        console.log(`[FolderSize] Cannot read ${dirPath}:`, (err as Error).message);
      }
    }

    await calculateSize(folderPath);

    activeFolderSizeCalculations.delete(operationId);

    const fileTypes = Array.from(fileTypeMap.entries())
      .map(([extension, data]) => ({ extension, count: data.count, size: data.size }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 10);

    console.log('[FolderSize] Completed:', { totalSize, fileCount, folderCount, fileTypes: fileTypes.length });
    return {
      success: true,
      result: { totalSize, fileCount, folderCount, fileTypes }
    };
  } catch (error) {
    activeFolderSizeCalculations.delete(operationId);
    const errorMessage = getErrorMessage(error);
    if (errorMessage === 'Calculation cancelled') {
      console.log('[FolderSize] Calculation cancelled for operationId:', operationId);
      return { success: false, error: 'Calculation cancelled' };
    }
    console.error('[FolderSize] Error:', error);
    return { success: false, error: errorMessage };
  }
});

ipcMain.handle('cancel-folder-size-calculation', async (_event: IpcMainInvokeEvent, operationId: string): Promise<{success: boolean; error?: string}> => {
  const operation = activeFolderSizeCalculations.get(operationId);
  if (operation) {
    operation.aborted = true;
    activeFolderSizeCalculations.delete(operationId);
    console.log('[FolderSize] Cancellation requested for operationId:', operationId);
    return { success: true };
  }
  return { success: false, error: 'Operation not found' };
});

// Checksum Calc
ipcMain.handle('calculate-checksum', async (_event: IpcMainInvokeEvent, filePath: string, operationId: string, algorithms: string[]): Promise<{success: boolean; result?: {md5?: string; sha256?: string}; error?: string}> => {
  try {
    if (!isPathSafe(filePath)) {
      return { success: false, error: 'Invalid file path' };
    }
    console.log('[Checksum] Starting calculation for:', filePath, 'algorithms:', algorithms, 'operationId:', operationId);

    const operation = { aborted: false };
    activeChecksumCalculations.set(operationId, operation);
    
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;
    
    const result: {md5?: string; sha256?: string} = {};
    
    for (const algorithm of algorithms) {
      if (operation.aborted) {
        throw new Error('Calculation cancelled');
      }
      
      const hash = crypto.createHash(algorithm);
      const stream = fsSync.createReadStream(filePath);
      
      let bytesRead = 0;
      let lastProgressUpdate = Date.now();
      
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          if (operation.aborted) {
            stream.destroy();
            reject(new Error('Calculation cancelled'));
            return;
          }
          
          hash.update(chunk);
          bytesRead += chunk.length;
          const now = Date.now();
          if (now - lastProgressUpdate > 100) {
            lastProgressUpdate = now;
            const percent = fileSize > 0 ? (bytesRead / fileSize) * 100 : 0;
            safeSendToWindow(mainWindow, 'checksum-progress', {
              operationId,
              percent,
              algorithm
            });
          }
        });
        
        stream.on('end', () => {
          if (!operation.aborted) {
            const hashValue = hash.digest('hex');
            if (algorithm === 'md5') {
              result.md5 = hashValue;
            } else if (algorithm === 'sha256') {
              result.sha256 = hashValue;
            }
          }
          resolve();
        });
        
        stream.on('error', (err) => {
          reject(err);
        });
      });
    }
    
    activeChecksumCalculations.delete(operationId);
    
    console.log('[Checksum] Completed:', result);
    return { success: true, result };
  } catch (error) {
    activeChecksumCalculations.delete(operationId);
    const errorMessage = getErrorMessage(error);
    if (errorMessage === 'Calculation cancelled') {
      console.log('[Checksum] Calculation cancelled for operationId:', operationId);
      return { success: false, error: 'Calculation cancelled' };
    }
    console.error('[Checksum] Error:', error);
    return { success: false, error: errorMessage };
  }
});

ipcMain.handle('cancel-checksum-calculation', async (_event: IpcMainInvokeEvent, operationId: string): Promise<{success: boolean; error?: string}> => {
  const operation = activeChecksumCalculations.get(operationId);
  if (operation) {
    operation.aborted = true;
    activeChecksumCalculations.delete(operationId);
    console.log('[Checksum] Cancellation requested for operationId:', operationId);
    return { success: true };
  }
  return { success: false, error: 'Operation not found' };
});




