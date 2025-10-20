import { app, BrowserWindow, ipcMain, dialog, shell, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Settings, FileItem, ApiResponse, DirectoryResponse, PathResponse, PropertiesResponse, SettingsResponse } from './types';

const execAsync = promisify(exec);

let mainWindow: BrowserWindow | null = null;

const isDev = process.argv.includes('--dev');

const defaultSettings: Settings = {
  transparency: true,
  theme: 'default',
  sortBy: 'name',
  sortOrder: 'asc',
  bookmarks: [],
  viewMode: 'grid'
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      devTools: isDev
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));

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

app.whenReady().then(async () => {
  createWindow();

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
    }, 1500);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  //if (process.platform !== 'darwin') { uncomment this to keep app running in background on macOS
    app.quit();
  //}
});

ipcMain.handle('get-directory-contents', async (_event: IpcMainInvokeEvent, dirPath: string): Promise<DirectoryResponse> => {
  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    const contents: FileItem[] = await Promise.all(
      items.map(async (item): Promise<FileItem> => {
        const fullPath = path.join(dirPath, item.name);
        try {
          const stats = await fs.stat(fullPath);
          return {
            name: item.name,
            path: fullPath,
            isDirectory: item.isDirectory(),
            isFile: item.isFile(),
            size: stats.size,
            modified: stats.mtime
          };
        } catch (err) {
          return {
            name: item.name,
            path: fullPath,
            isDirectory: item.isDirectory(),
            isFile: item.isFile(),
            size: 0,
            modified: new Date()
          };
        }
      })
    );
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
    // Check if it's a URL
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

ipcMain.handle('close-window', (): void => {
  mainWindow?.close();
});

ipcMain.handle('create-folder', async (_event: IpcMainInvokeEvent, parentPath: string, folderName: string): Promise<PathResponse> => {
  try {
    const newPath = path.join(parentPath, folderName);
    await fs.mkdir(newPath);
    return { success: true, path: newPath };
  } catch (error) {
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
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('rename-item', async (_event: IpcMainInvokeEvent, oldPath: string, newName: string): Promise<PathResponse> => {
  const newPath = path.join(path.dirname(oldPath), newName);
  try {
    await fs.rename(oldPath, newPath);
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
  return await saveSettings(settings);
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
    for (const sourcePath of sourcePaths) {
      const itemName = path.basename(sourcePath);
      const destItemPath = path.join(destPath, itemName);
      await fs.rename(sourcePath, destItemPath);
    }
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
              results.push({
                name: item.name,
                path: fullPath,
                isDirectory: item.isDirectory(),
                isFile: item.isFile(),
                size: stats.size,
                modified: stats.mtime
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
  try {
    if (process.platform === 'win32') {
      const { exec } = require('child_process');
      return new Promise((resolve) => {
        exec(`wmic logicaldisk where "DeviceID='${drivePath.replace(':\\', ':')}'" get Size,FreeSpace`, (error: Error | null, stdout: string) => {
          if (error) {
            resolve({ success: false, error: error.message });
            return;
          }
          const lines = stdout.trim().split('\n').filter(line => line.trim());
          if (lines.length < 2) {
            resolve({ success: false, error: 'Could not parse disk info' });
            return;
          }
          const values = lines[1].trim().split(/\s+/);
          if (values.length >= 2) {
            const free = parseInt(values[0]);
            const total = parseInt(values[1]);
            resolve({ success: true, free, total });
          } else {
            resolve({ success: false, error: 'Invalid disk info format' });
          }
        });
      });
    } else {
      const stats = await fs.statfs ? fs.statfs(drivePath) : null;
      if (stats) {
        return {
          success: true,
          total: (stats as any).blocks * (stats as any).bsize,
          free: (stats as any).bfree * (stats as any).bsize
        };
      }
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

ipcMain.handle('check-for-updates', async (): Promise<{ success: boolean; hasUpdate?: boolean; latestVersion?: string; currentVersion?: string; releaseUrl?: string; error?: string }> => {
  try {
    const currentVersion = app.getVersion();
    const response = await fetch('https://api.github.com/repos/BurntToasters/IYERIS/releases/latest');
    
    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`);
    }
    
    const data = await response.json();
    const latestVersion = data.tag_name.replace(/^v/, '');
    const releaseUrl = data.html_url;
    
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
    
    return {
      success: true,
      hasUpdate,
      latestVersion: data.tag_name,
      currentVersion: `v${currentVersion}`,
      releaseUrl
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;
    
    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }
  
  return 0;
}

