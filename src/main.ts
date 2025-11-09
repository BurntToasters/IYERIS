import { app, BrowserWindow, ipcMain, dialog, shell, IpcMainInvokeEvent, Menu } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import Seven = require('node-7z');
import sevenBin = require('7zip-bin');
import type { Settings, FileItem, ApiResponse, DirectoryResponse, PathResponse, PropertiesResponse, SettingsResponse, UpdateCheckResponse, IndexSearchResponse } from './types';
import { FileIndexer } from './indexer';

const execAsync = promisify(exec);

const isRunningInFlatpak = (): boolean => {
  return process.env.FLATPAK_ID !== undefined || 
         fsSync.existsSync('/.flatpak-info');
};

let mainWindow: BrowserWindow | null = null;
let fileIndexer: FileIndexer | null = null;

const isDev = process.argv.includes('--dev');

interface UndoAction {
  type: 'trash' | 'rename' | 'move' | 'create';
  data: any;
}

const undoStack: UndoAction[] = [];
const redoStack: UndoAction[] = [];
const MAX_UNDO_STACK = 50;

const activeArchiveProcesses = new Map<string, any>();

function pushUndoAction(action: UndoAction): void {
  undoStack.push(action);
if (undoStack.length > MAX_UNDO_STACK) {
    undoStack.shift();
  }
  redoStack.length = 0;
  console.log('[Undo] Action pushed:', action.type, 'Stack size:', undoStack.length);
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
  enableIndexer: true
};

function getSettingsPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'settings.json');
}

async function loadSettings(): Promise<Settings> {
  try {
    const settingsPath = getSettingsPath();
    console.log('[Settings] Loading from:', settingsPath);
    const data = await fs.readFile(settingsPath, 'utf8');
    const settings = { ...defaultSettings, ...JSON.parse(data) };
    console.log('[Settings] Loaded:', JSON.stringify(settings, null, 2));
    return settings;
  } catch (error) {
    console.log('[Settings] File not found, using defaults');
    return { ...defaultSettings };
  }
}

async function saveSettings(settings: Settings): Promise<ApiResponse> {
  try {
    const settingsPath = getSettingsPath();
    console.log('[Settings] Saving to:', settingsPath);
    console.log('[Settings] Data:', JSON.stringify(settings, null, 2));
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    console.log('[Settings] Saved successfully');
    return { success: true };
  } catch (error) {
    console.log('[Settings] Save failed:', (error as Error).message);
    return { success: false, error: (error as Error).message };
  }
}

async function isFileHidden(filePath: string, fileName: string): Promise<boolean> {
  if (process.platform !== 'win32') {
    return fileName.startsWith('.');
  }
  
  try {
    const { stdout } = await execAsync(`attrib "${filePath}"`, { windowsHide: true });
    return stdout.trim().startsWith('H') || stdout.includes(' H ');
  } catch (error) {
    return fileName.startsWith('.');
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
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
      preload: path.join(__dirname, 'preload.js'),
      devTools: isDev,
      backgroundThrottling: false,
      spellcheck: false,
      v8CacheOptions: 'code'
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 100);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }
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
  console.log('[FDA] Showing Full Disk Access dialog');
  const result = await dialog.showMessageBox(mainWindow!, {
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
    (settings as any).skipFullDiskAccessPrompt = true;
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

  createWindow();

  setTimeout(() => {
    Promise.all([
      (async () => {
        try {
          const settings = await loadSettings();
          fileIndexer = new FileIndexer();
          setTimeout(() => {
            fileIndexer!.initialize(settings.enableIndexer).catch(err => 
              console.error('[Indexer] Background initialization failed:', err)
            );
          }, 2000);
        } catch (error) {
          console.error('[Settings] Failed to load:', error);
        }
      })(),

      (async () => {
        try {
          autoUpdater.logger = console;
          autoUpdater.autoDownload = false;
          autoUpdater.autoInstallOnAppQuit = true;

        if (isRunningInFlatpak()) {
          console.log('[AutoUpdater] Running in Flatpak - auto-updater disabled');
          console.log('[AutoUpdater] Updates should be installed via: flatpak update com.burnttoasters.iyeris');
        }

        autoUpdater.on('checking-for-update', () => {
          console.log('[AutoUpdater] Checking for update...');
          mainWindow?.webContents.send('update-checking');
        });

        autoUpdater.on('update-available', (info) => {
          console.log('[AutoUpdater] Update available:', info.version);
          mainWindow?.webContents.send('update-available', info);
        });

        autoUpdater.on('update-not-available', (info) => {
          console.log('[AutoUpdater] Update not available. Current version:', info.version);
          mainWindow?.webContents.send('update-not-available', info);
        });

        autoUpdater.on('error', (err) => {
          console.error('[AutoUpdater] Error:', err);
          mainWindow?.webContents.send('update-error', err.message);
        });

        autoUpdater.on('download-progress', (progressObj) => {
          console.log(`[AutoUpdater] Download progress: ${progressObj.percent.toFixed(2)}%`);
          mainWindow?.webContents.send('update-download-progress', {
            percent: progressObj.percent,
            bytesPerSecond: progressObj.bytesPerSecond,
            transferred: progressObj.transferred,
            total: progressObj.total
          });
        });

        autoUpdater.on('update-downloaded', (info) => {
          console.log('[AutoUpdater] Update downloaded:', info.version);
          mainWindow?.webContents.send('update-downloaded', info);
        });
      } catch (error) {
        console.error('[AutoUpdater] Setup failed:', error);
      }
    })(),

    (async () => {
      if (process.platform === 'darwin') {
        console.log('[FDA] Scheduling Full Disk Access check...');
        console.log('[FDA] App version:', app.getVersion());
        console.log('[FDA] Is packaged:', app.isPackaged);
        console.log('[FDA] User data path:', app.getPath('userData'));
        
        setTimeout(async () => {
          console.log('[FDA] Running Full Disk Access check');
          console.log('[FDA] Running from:', process.execPath);
          
          const hasAccess = await checkFullDiskAccess();
          
          if (hasAccess) {
            console.log('[FDA] Full Disk Access already granted');
            const settings = await loadSettings();
            console.log('[FDA] Current settings:', JSON.stringify(settings, null, 2));
            if ((settings as any).skipFullDiskAccessPrompt) {
              console.log('[FDA] Clearing "Don\'t Ask Again" flag');
              delete (settings as any).skipFullDiskAccessPrompt;
              const saveResult = await saveSettings(settings);
              console.log('[FDA] Save result:', saveResult);
            }
            return;
          }
          
          console.log('[FDA] Full Disk Access NOT granted');
          const settings = await loadSettings();
          console.log('[FDA] Current settings:', JSON.stringify(settings, null, 2));
          if ((settings as any).skipFullDiskAccessPrompt) {
            console.log('[FDA] User has opted out of prompts');
            return;
          }
          
          console.log('[FDA] No Full Disk Access detected');
          await showFullDiskAccessDialog();
        }, 3000);
      }
    })()
  ]).catch(err => console.error('[Startup] Background initialization error:', err));
  }, 500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

ipcMain.handle('get-directory-contents', async (_event: IpcMainInvokeEvent, dirPath: string): Promise<DirectoryResponse> => {
  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });

    const batchSize = 100;
    const contents: FileItem[] = [];
    
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (item): Promise<FileItem> => {
          const fullPath = path.join(dirPath, item.name);

          let isHidden = item.name.startsWith('.');
          if (process.platform === 'win32' && !isHidden) {
            isHidden = false;
          }
          
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
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('get-drives', async (): Promise<string[]> => {
  if (process.platform === 'win32') {
    const drives: string[] = [];
    for (let i = 65; i <= 90; i++) {
      const drive = String.fromCharCode(i) + ':\\';
      try {
        await fs.access(drive);
        drives.push(drive);
      } catch (err) {
      }
    }
    return drives;
  } else if (process.platform === 'darwin' || process.platform === 'linux') {
    return ['/'];
  }
  return [];
});

ipcMain.handle('get-home-directory', (): string => {
  return app.getPath('home');
});

ipcMain.handle('open-file', async (_event: IpcMainInvokeEvent, filePath: string): Promise<ApiResponse> => {
  try {
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      await shell.openExternal(filePath);
    } else {
      await shell.openPath(filePath);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
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
  createWindow();
});

ipcMain.handle('create-folder', async (_event: IpcMainInvokeEvent, parentPath: string, folderName: string): Promise<PathResponse> => {
  try {
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
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('trash-item', async (_event: IpcMainInvokeEvent, itemPath: string): Promise<ApiResponse> => {
  try {
    const stats = await fs.stat(itemPath);
    const itemName = path.basename(itemPath);
    const parentPath = path.dirname(itemPath);
    
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
    return { success: false, error: (error as Error).message };
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
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('delete-item', async (_event: IpcMainInvokeEvent, itemPath: string): Promise<ApiResponse> => {
  try {
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
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('rename-item', async (_event: IpcMainInvokeEvent, oldPath: string, newName: string): Promise<PathResponse> => {
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
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('create-file', async (_event: IpcMainInvokeEvent, parentPath: string, fileName: string): Promise<PathResponse> => {
  try {
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
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('get-item-properties', async (_event: IpcMainInvokeEvent, itemPath: string): Promise<PropertiesResponse> => {
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
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('get-settings', async (): Promise<SettingsResponse> => {
  try {
    const settings = await loadSettings();
    return { success: true, settings };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('save-settings', async (_event: IpcMainInvokeEvent, settings: Settings): Promise<ApiResponse> => {
  const result = await saveSettings(settings);

  if (result.success && fileIndexer) {
    fileIndexer.setEnabled(settings.enableIndexer);

    if (settings.enableIndexer) {
      fileIndexer.initialize(true);
    }
  }
  
  return result;
});

ipcMain.handle('reset-settings', async (): Promise<ApiResponse> => {
  return await saveSettings(defaultSettings);
});

ipcMain.handle('get-settings-path', (): string => {
  return getSettingsPath();
});

ipcMain.handle('copy-items', async (_event: IpcMainInvokeEvent, sourcePaths: string[], destPath: string): Promise<ApiResponse> => {
  try {
    for (const sourcePath of sourcePaths) {
      const itemName = path.basename(sourcePath);
      const destItemPath = path.join(destPath, itemName);
      
      const stats = await fs.stat(sourcePath);
      if (stats.isDirectory()) {
        await fs.cp(sourcePath, destItemPath, { recursive: true });
      } else {
        await fs.copyFile(sourcePath, destItemPath);
      }
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('move-items', async (_event: IpcMainInvokeEvent, sourcePaths: string[], destPath: string): Promise<ApiResponse> => {
  try {
    const originalParent = path.dirname(sourcePaths[0]);
    const movedPaths: string[] = [];
    
    for (const sourcePath of sourcePaths) {
      const fileName = path.basename(sourcePath);
      const newPath = path.join(destPath, fileName);
      await fs.rename(sourcePath, newPath);
      movedPaths.push(newPath);
    }
    
    pushUndoAction({
      type: 'move',
      data: {
        sourcePaths: movedPaths,
        destPath: destPath,
        originalParent: originalParent
      }
    });
    
    console.log('[Move] Items moved:', sourcePaths.length);
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('search-files', async (_event: IpcMainInvokeEvent, dirPath: string, query: string): Promise<{ success: boolean; results?: FileItem[]; error?: string }> => {
  try {
    const results: FileItem[] = [];
    const searchQuery = query.toLowerCase();
    
    async function searchDirectory(currentPath: string): Promise<void> {
      try {
        const items = await fs.readdir(currentPath, { withFileTypes: true });
        
        for (const item of items) {
          const fullPath = path.join(currentPath, item.name);
          
          if (item.name.toLowerCase().includes(searchQuery)) {
            try {
              const stats = await fs.stat(fullPath);
              const isHidden = await isFileHidden(fullPath, item.name);
              results.push({
                name: item.name,
                path: fullPath,
                isDirectory: item.isDirectory(),
                isFile: item.isFile(),
                size: stats.size,
                modified: stats.mtime,
                isHidden
              });
            } catch (err) {
            }
          }
          
          if (item.isDirectory() && results.length < 100) {
            try {
              await searchDirectory(fullPath);
            } catch (err) {
            }
          }
        }
      } catch (err) {
      }
    }
    
    await searchDirectory(dirPath);
    return { success: true, results };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('get-disk-space', async (_event: IpcMainInvokeEvent, drivePath: string): Promise<{ success: boolean; total?: number; free?: number; error?: string }> => {
  console.log('[Main] get-disk-space called with path:', drivePath, 'Platform:', process.platform);
  try {
    if (process.platform === 'win32') {
      const { exec } = require('child_process');
      return new Promise((resolve) => {
        const driveLetter = drivePath.substring(0, 2);
        console.log('[Main] Getting disk space for drive:', driveLetter);
        const psCommand = `powershell -Command "Get-PSDrive -Name ${driveLetter.charAt(0)} | Select-Object @{Name='Free';Expression={$_.Free}}, @{Name='Used';Expression={$_.Used}} | ConvertTo-Json"`;
        
        exec(psCommand, (error: Error | null, stdout: string) => {
          if (error) {
            console.error('[Main] PowerShell error:', error);
            resolve({ success: false, error: error.message });
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
      const { exec } = require('child_process');
      return new Promise((resolve) => {
        exec(`df -k "${drivePath}"`, (error: Error | null, stdout: string) => {
          if (error) {
            resolve({ success: false, error: error.message });
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
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('restart-as-admin', async (): Promise<ApiResponse> => {
  try {
    const { exec } = require('child_process');
    const platform = process.platform;
    const appPath = app.getPath('exe');
    
    if (platform === 'win32') {
      const command = `Start-Process -FilePath "${appPath}" -Verb RunAs`;
      exec(`powershell -Command "${command}"`, (error: any) => {
        if (!error) {
          app.quit();
        }
      });
      return { success: true };
    } else if (platform === 'darwin' || platform === 'linux') {
      let command: string;
      
      if (platform === 'darwin') {
        command = `osascript -e 'do shell script "${appPath}" with administrator privileges'`;
      } else {
        command = `pkexec "${appPath}" || gksudo "${appPath}"`;
      }
      
      exec(command, (error: any) => {
        if (!error) {
          app.quit();
        }
      });
      return { success: true };
    } else {
      return { success: false, error: 'Unsupported platform' };
    }
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('open-terminal', async (_event: IpcMainInvokeEvent, dirPath: string): Promise<ApiResponse> => {
  try {
    const { exec } = require('child_process');
    const platform = process.platform;
    
    let command: string;
    
    if (platform === 'win32') {
      command = `start cmd /K "cd /d "${dirPath}""`;
    } else if (platform === 'darwin') {
      command = `open -a Terminal "${dirPath}"`;
    } else {
      command = `x-terminal-emulator -e "cd '${dirPath}' && bash" || gnome-terminal --working-directory="${dirPath}" || xterm -e "cd '${dirPath}' && bash"`;
    }
    
    exec(command, (error: any) => {
      if (error) {
        console.error('Error opening terminal:', error);
      }
    });
    
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('read-file-content', async (_event: IpcMainInvokeEvent, filePath: string, maxSize: number = 1024 * 1024): Promise<{ success: boolean; content?: string; error?: string; isTruncated?: boolean }> => {
  try {
    const stats = await fs.stat(filePath);
    
    if (stats.size > maxSize) {
      const buffer = Buffer.alloc(maxSize);
      const fileHandle = await fs.open(filePath, 'r');
      await fileHandle.read(buffer, 0, maxSize, 0);
      await fileHandle.close();
      return { 
        success: true, 
        content: buffer.toString('utf8'),
        isTruncated: true
      };
    }
    
    const content = await fs.readFile(filePath, 'utf8');
    return { success: true, content, isTruncated: false };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('get-file-data-url', async (_event: IpcMainInvokeEvent, filePath: string, maxSize: number = 10 * 1024 * 1024): Promise<{ success: boolean; dataUrl?: string; error?: string }> => {
  try {
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
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('get-licenses', async (): Promise<{ success: boolean; licenses?: any; error?: string }> => {
  try {
    const licensesPath = path.join(__dirname, '..', 'licenses.json');
    const data = await fs.readFile(licensesPath, 'utf-8');
    const licenses = JSON.parse(data);
    return { success: true, licenses };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('get-platform', (): string => {
  return process.platform;
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
    return { success: false, error: (error as Error).message };
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

  try {
    const currentVersion = app.getVersion();
    console.log('[AutoUpdater] Manually checking for updates. Current version:', currentVersion);
    
    const updateCheckResult = await autoUpdater.checkForUpdates();
    
    if (!updateCheckResult) {
      return { success: false, error: 'Update check returned no result' };
    }

    const updateInfo = updateCheckResult.updateInfo;
    const hasUpdate = updateCheckResult.updateInfo.version !== currentVersion;

    console.log('[AutoUpdater] Update check result:', {
      hasUpdate,
      currentVersion,
      latestVersion: updateInfo.version
    });

    return {
      success: true,
      hasUpdate,
      updateInfo: {
        version: updateInfo.version,
        releaseDate: updateInfo.releaseDate,
        releaseNotes: updateInfo.releaseNotes as string | undefined
      },
      currentVersion: `v${currentVersion}`,
      latestVersion: `v${updateInfo.version}`,
      releaseUrl: `https://github.com/BurntToasters/IYERIS/releases/tag/v${updateInfo.version}`
    };
  } catch (error) {
    console.error('[AutoUpdater] Check for updates failed:', error);
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('download-update', async (): Promise<ApiResponse> => {
  try {
    console.log('[AutoUpdater] Starting update download...');
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (error) {
    console.error('[AutoUpdater] Download failed:', error);
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('install-update', async (): Promise<ApiResponse> => {
  try {
    console.log('[AutoUpdater] Installing update and restarting...');
    autoUpdater.quitAndInstall(false, true);
    return { success: true };
  } catch (error) {
    console.error('[AutoUpdater] Install failed:', error);
    return { success: false, error: (error as Error).message };
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
        redoStack.push(action);
        console.log('[Undo] Renamed back:', action.data.newPath, '->', action.data.oldPath);
        return { success: true };
      
      case 'move':
        const moveSourcePaths = action.data.sourcePaths;
        const originalParent = action.data.originalParent;
        
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
        redoStack.push(action);
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
        redoStack.push(action);
        console.log('[Undo] Deleted created item:', itemPath);
        return { success: true };
      
      default:
        return { success: false, error: 'Unknown action type' };
    }
  } catch (error) {
    console.error('[Undo] Error:', error);
    undoStack.push(action);
    return { success: false, error: (error as Error).message };
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
        const redoSourcePaths = action.data.sourcePaths;
        const destPath = action.data.destPath;
        for (const source of redoSourcePaths) {
          const fileName = path.basename(source);
          const newPath = path.join(destPath, fileName);
          await fs.rename(source, newPath);
        }
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
    return { success: false, error: (error as Error).message };
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
    return { success: false, error: (error as Error).message };
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
    return { success: false, error: (error as Error).message };
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
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('compress-files', async (_event: IpcMainInvokeEvent, sourcePaths: string[], outputPath: string, format: string = 'zip', operationId?: string): Promise<ApiResponse> => {
  try {
    console.log('[Compress] Starting compression:', sourcePaths, 'to', outputPath, 'format:', format);

    try {
      await fs.access(outputPath);
      console.log('[Compress] Removing existing file:', outputPath);
      await fs.unlink(outputPath);
    } catch (err) {
    }

    if (format === 'tar.gz') {
      return new Promise(async (resolve, reject) => {
        const sevenZipPath = sevenBin.path7za;
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
        
        tarProcess.on('progress', (progress) => {
          fileCount++;
          if (mainWindow) {
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
            if (mainWindow) {
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

          gzipProcess.on('error', async (error) => {
            console.error('[Compress] Gzip error:', error);

            try {
              await fs.unlink(tarPath);
            } catch (err) {}
            try {
              await fs.unlink(outputPath);
            } catch (err) {}
            
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

        tarProcess.on('error', async (error) => {
          console.error('[Compress] Tar error:', error);

          try {
            await fs.unlink(tarPath);
          } catch (err) {}
          
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
              } catch (err) {}
              if (operationId) {
                activeArchiveProcesses.delete(operationId);
              }
              resolve({ success: true });
            });

            gzipProcess.on('error', async (gzipError) => {
              try {
                await fs.unlink(tarPath);
                await fs.unlink(outputPath);
              } catch (err) {}
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
      const sevenZipPath = sevenBin.path7za;
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
      
      seven.on('progress', (progress) => {
        fileCount++;
        if (mainWindow) {
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

      seven.on('error', (error) => {
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
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('extract-archive', async (_event: IpcMainInvokeEvent, archivePath: string, destPath: string, operationId?: string): Promise<ApiResponse> => {
  try {
    console.log('[Extract] Starting extraction:', archivePath, 'to', destPath);
    const ext = path.extname(archivePath).toLowerCase();
    const fileName = path.basename(archivePath, ext);

    await fs.mkdir(destPath, { recursive: true });
    return new Promise((resolve, reject) => {
      const sevenZipPath = sevenBin.path7za;
      console.log('[Extract] Using 7zip at:', sevenZipPath);
      
      const seven = Seven.extractFull(archivePath, destPath, {
        $bin: sevenZipPath,
        recursive: true
      });

      if (operationId) {
        activeArchiveProcesses.set(operationId, seven);
      }

      let fileCount = 0;
      
      seven.on('progress', (progress) => {
        fileCount++;
        if (mainWindow) {
          mainWindow.webContents.send('extract-progress', {
            operationId,
            current: fileCount,
            total: fileCount + 10,
            name: progress.file || 'Extracting...'
          });
        }
      });

      seven.on('end', () => {
        console.log('[Extract] 7zip extraction completed for:', ext);
        if (operationId) {
          activeArchiveProcesses.delete(operationId);
        }
        resolve({ success: true });
      });

      seven.on('error', (error) => {
        console.error('[Extract] 7zip error:', error);
        if (operationId) {
          activeArchiveProcesses.delete(operationId);
        }
        reject({ success: false, error: error.message });
      });
    });
  } catch (error) {
    console.error('[Extract] Error:', error);
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('cancel-archive-operation', async (_event: IpcMainInvokeEvent, operationId: string): Promise<ApiResponse> => {
  try {
    const process = activeArchiveProcesses.get(operationId);
    if (process && process._childProcess) {
      console.log('[Archive] Cancelling operation:', operationId);
      process._childProcess.kill('SIGTERM');
      activeArchiveProcesses.delete(operationId);
      return { success: true };
    }
    return { success: false, error: 'Operation not found' };
  } catch (error) {
    console.error('[Archive] Cancel error:', error);
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('set-zoom-level', async (_event: IpcMainInvokeEvent, zoomLevel: number): Promise<ApiResponse> => {
  try {
    if (!mainWindow) {
      return { success: false, error: 'Window not available' };
    }

    const clampedZoom = Math.max(0.5, Math.min(2.0, zoomLevel));
    mainWindow.webContents.setZoomFactor(clampedZoom);
    
    console.log('[Zoom] Set zoom level to:', clampedZoom);
    return { success: true };
  } catch (error) {
    console.error('[Zoom] Error:', error);
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('get-zoom-level', async (): Promise<{success: boolean; zoomLevel?: number; error?: string}> => {
  try {
    if (!mainWindow) {
      return { success: false, error: 'Window not available' };
    }
    
    const zoomLevel = mainWindow.webContents.getZoomFactor();
    return { success: true, zoomLevel };
  } catch (error) {
    console.error('[Zoom] Error:', error);
    return { success: false, error: (error as Error).message };
  }
});


