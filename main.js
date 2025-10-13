const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

let mainWindow;

const defaultSettings = {
  transparency: true,
  theme: 'default'
};

function getSettingsPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'settings.json');
}

async function loadSettings() {
  try {
    const settingsPath = getSettingsPath();
    const data = await fs.readFile(settingsPath, 'utf8');
    return { ...defaultSettings, ...JSON.parse(data) };
  } catch (error) {
    return { ...defaultSettings };
  }
}

async function saveSettings(settings) {
  try {
    const settingsPath = getSettingsPath();
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
  });

  mainWindow.loadFile('index.html');
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

ipcMain.handle('get-directory-contents', async (event, dirPath) => {
  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    const contents = await Promise.all(
      items.map(async (item) => {
        const fullPath = path.join(dirPath, item.name);
        try {
          const stats = await fs.stat(fullPath);
          return {
            name: item.name,
            path: fullPath,
            isDirectory: item.isDirectory(),
            isFile: item.isFile(),
            size: stats.size,
            modified: stats.mtime,
            created: stats.birthtime
          };
        } catch (err) {
          return {
            name: item.name,
            path: fullPath,
            isDirectory: item.isDirectory(),
            isFile: item.isFile(),
            error: 'Unable to read stats'
          };
        }
      })
    );
    return { success: true, contents };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-drives', async () => {
  if (process.platform === 'win32') {
    const drives = [];
    for (let i = 65; i <= 90; i++) {
      const drive = String.fromCharCode(i) + ':\\';
      try {
        await fs.access(drive);
        drives.push(drive);
      } catch (err) {}
    }
    return drives;
  } else if (process.platform === 'darwin' || process.platform === 'linux') {
    return ['/'];
  }
  return [];
});

ipcMain.handle('get-home-directory', () => {
  return app.getPath('home');
});

ipcMain.handle('open-file', async (event, filePath) => {
  try {
    const { shell } = require('electron');
    await shell.openPath(filePath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return { success: true, path: result.filePaths[0] };
  }
  return { success: false };
});

ipcMain.handle('minimize-window', () => {
  mainWindow.minimize();
});

ipcMain.handle('maximize-window', () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.handle('close-window', () => {
  mainWindow.close();
});

ipcMain.handle('create-folder', async (event, parentPath, folderName) => {
  try {
    const newPath = path.join(parentPath, folderName);
    await fs.mkdir(newPath);
    return { success: true, path: newPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-item', async (event, itemPath) => {
  try {
    const stats = await fs.stat(itemPath);
    if (stats.isDirectory()) {
      await fs.rmdir(itemPath, { recursive: true });
    } else {
      await fs.unlink(itemPath);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('rename-item', async (event, oldPath, newName) => {
  try {
    const newPath = path.join(path.dirname(oldPath), newName);
    await fs.rename(oldPath, newPath);
    return { success: true, newPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('create-file', async (event, parentPath, fileName) => {
  try {
    const newPath = path.join(parentPath, fileName);
    await fs.writeFile(newPath, '');
    return { success: true, path: newPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-item-properties', async (event, itemPath) => {
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
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-settings', async () => {
  try {
    const settings = await loadSettings();
    return { success: true, settings };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-settings', async (event, settings) => {
  return await saveSettings(settings);
});

ipcMain.handle('reset-settings', async () => {
  return await saveSettings(defaultSettings);
});

ipcMain.handle('get-settings-path', () => {
  return getSettingsPath();
});

