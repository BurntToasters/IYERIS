import { app, BrowserWindow, ipcMain, dialog, shell, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { Settings, FileItem, ApiResponse, DirectoryResponse, PathResponse, PropertiesResponse, SettingsResponse } from './types';

let mainWindow: BrowserWindow | null = null;

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
    const data = await fs.readFile(settingsPath, 'utf8');
    return { ...defaultSettings, ...JSON.parse(data) };
  } catch (error) {
    return { ...defaultSettings };
  }
}

async function saveSettings(settings: Settings): Promise<ApiResponse> {
  try {
    const settingsPath = getSettingsPath();
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return { success: true };
  } catch (error) {
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
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
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
    await shell.openPath(filePath);
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

