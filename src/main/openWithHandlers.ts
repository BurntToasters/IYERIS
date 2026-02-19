import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain, shell } from 'electron';
import { execFile } from 'child_process';
import * as path from 'path';
import { promises as fs } from 'fs';
import { isPathSafe, getErrorMessage } from './security';
import { logger } from './logger';
import { withTrustedApiHandler } from './ipcUtils';

export interface OpenWithApp {
  id: string;
  name: string;
}

interface OpenWithResponse {
  success: boolean;
  apps?: OpenWithApp[];
  error?: string;
}

function execFilePromise(command: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function getAppsForFileWindows(filePath: string): Promise<OpenWithApp[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return [];

  const apps: OpenWithApp[] = [];

  try {
    const assocOutput = await execFilePromise('cmd', ['/c', 'assoc', ext]);
    const fileType = assocOutput.split('=')[1]?.trim();
    if (fileType) {
      try {
        const ftypeOutput = await execFilePromise('cmd', ['/c', 'ftype', fileType]);
        const exePath =
          ftypeOutput.split('=')[1]?.split('"')[1] || ftypeOutput.split('=')[1]?.trim();
        if (exePath) {
          const name = path.basename(exePath, '.exe');
          apps.push({ id: exePath, name });
        }
      } catch {}
    }
  } catch {}

  const commonApps = [
    { id: 'notepad.exe', name: 'Notepad' },
    { id: 'mspaint.exe', name: 'Paint' },
    { id: 'wordpad.exe', name: 'WordPad' },
  ];

  for (const app of commonApps) {
    if (!apps.some((a) => a.name.toLowerCase() === app.name.toLowerCase())) {
      apps.push(app);
    }
  }

  return apps;
}

async function getAppsForFileMac(_filePath: string): Promise<OpenWithApp[]> {
  const apps: OpenWithApp[] = [];

  try {
    const output = await execFilePromise('mdfind', [
      'kMDItemContentType == "com.apple.application-bundle"',
    ]);
    const appPaths = output.trim().split('\n').filter(Boolean).slice(0, 50);

    for (const appPath of appPaths) {
      const name = path.basename(appPath, '.app');
      apps.push({ id: appPath, name });
    }
  } catch {
    const commonApps = [
      { id: '/System/Applications/TextEdit.app', name: 'TextEdit' },
      { id: '/System/Applications/Preview.app', name: 'Preview' },
      { id: '/Applications/Safari.app', name: 'Safari' },
    ];

    for (const app of commonApps) {
      try {
        await fs.access(app.id);
        apps.push(app);
      } catch {}
    }
  }

  return apps.slice(0, 20);
}

async function getAppsForFileLinux(filePath: string): Promise<OpenWithApp[]> {
  const apps: OpenWithApp[] = [];

  try {
    const mimeOutput = await execFilePromise('xdg-mime', ['query', 'filetype', filePath]);
    const mimeType = mimeOutput.trim();

    if (mimeType) {
      try {
        const defaultApp = await execFilePromise('xdg-mime', ['query', 'default', mimeType]);
        const desktopFile = defaultApp.trim();
        if (desktopFile) {
          const appInfo = await parseDesktopFile(desktopFile);
          if (appInfo) apps.push(appInfo);
        }
      } catch {}

      try {
        const mimeCacheLocations = [
          '/usr/share/applications/mimeinfo.cache',
          '/usr/local/share/applications/mimeinfo.cache',
          path.join(process.env.HOME || '', '.local/share/applications/mimeinfo.cache'),
        ];

        for (const cachePath of mimeCacheLocations) {
          try {
            const content = await fs.readFile(cachePath, 'utf-8');
            const regex = new RegExp(
              `^${mimeType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=(.+)$`,
              'm'
            );
            const match = content.match(regex);
            if (match) {
              const desktopFiles = match[1].split(';').filter(Boolean);
              for (const df of desktopFiles.slice(0, 15)) {
                if (!apps.some((a) => a.id === df)) {
                  const appInfo = await parseDesktopFile(df);
                  if (appInfo) apps.push(appInfo);
                }
              }
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}

  if (apps.length === 0) {
    const fallbackApps = [
      { desktop: 'org.gnome.TextEditor.desktop', name: 'Text Editor' },
      { desktop: 'org.gnome.Nautilus.desktop', name: 'Files' },
      { desktop: 'xed.desktop', name: 'Text Editor' },
      { desktop: 'mousepad.desktop', name: 'Mousepad' },
    ];

    for (const fb of fallbackApps) {
      const appInfo = await parseDesktopFile(fb.desktop);
      if (appInfo) apps.push(appInfo);
    }
  }

  return apps.slice(0, 20);
}

async function parseDesktopFile(desktopFileName: string): Promise<OpenWithApp | null> {
  const searchPaths = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    path.join(process.env.HOME || '', '.local/share/applications'),
    '/var/lib/flatpak/exports/share/applications',
    path.join(process.env.HOME || '', '.local/share/flatpak/exports/share/applications'),
  ];

  for (const dir of searchPaths) {
    const fullPath = path.join(dir, desktopFileName);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const nameMatch = content.match(/^Name=(.+)$/m);
      const execMatch = content.match(/^Exec=(.+)$/m);
      const noDisplay = content.match(/^NoDisplay=true$/m);

      if (noDisplay) return null;

      const name = nameMatch?.[1]?.trim() || desktopFileName.replace('.desktop', '');
      const execPath = execMatch?.[1]?.trim() || '';

      if (name && execPath) {
        return { id: desktopFileName, name };
      }
    } catch {}
  }

  return null;
}

async function openFileWithAppPlatform(filePath: string, appId: string): Promise<void> {
  const platform = process.platform;

  if (platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      execFile('cmd', ['/c', 'start', '', appId, filePath], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } else if (platform === 'darwin') {
    await new Promise<void>((resolve, reject) => {
      execFile('open', ['-a', appId, filePath], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } else {
    const searchPaths = [
      '/usr/share/applications',
      '/usr/local/share/applications',
      path.join(process.env.HOME || '', '.local/share/applications'),
      '/var/lib/flatpak/exports/share/applications',
      path.join(process.env.HOME || '', '.local/share/flatpak/exports/share/applications'),
    ];

    let execCmd: string | null = null;

    for (const dir of searchPaths) {
      const fullPath = path.join(dir, appId);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const execMatch = content.match(/^Exec=(.+)$/m);
        if (execMatch) {
          execCmd = execMatch[1]
            .trim()
            .replace(/%[fFuUdDnNickvm]/g, '')
            .trim();
          break;
        }
      } catch {}
    }

    if (execCmd) {
      const cmdParts = execCmd.split(/\s+/);
      const binary = cmdParts[0];
      const args = [...cmdParts.slice(1), filePath];
      await new Promise<void>((resolve, reject) => {
        execFile(binary, args, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    } else {
      const result = await shell.openPath(filePath);
      if (result) throw new Error(result);
    }
  }
}

export function setupOpenWithHandlers(): void {
  ipcMain.handle(
    'get-open-with-apps',
    withTrustedApiHandler(
      'get-open-with-apps',
      async (_event: IpcMainInvokeEvent, filePath: string): Promise<OpenWithResponse> => {
        if (!isPathSafe(filePath)) {
          return { success: false, error: 'Invalid path' };
        }

        try {
          let apps: OpenWithApp[];
          const platform = process.platform;

          if (platform === 'win32') {
            apps = await getAppsForFileWindows(filePath);
          } else if (platform === 'darwin') {
            apps = await getAppsForFileMac(filePath);
          } else {
            apps = await getAppsForFileLinux(filePath);
          }

          return { success: true, apps };
        } catch (error) {
          logger.warn('[OpenWith] Failed to get apps:', getErrorMessage(error));
          return { success: false, error: getErrorMessage(error) };
        }
      }
    )
  );

  ipcMain.handle(
    'open-file-with-app',
    withTrustedApiHandler(
      'open-file-with-app',
      async (
        _event: IpcMainInvokeEvent,
        filePath: string,
        appId: string
      ): Promise<{ success: boolean; error?: string }> => {
        if (!isPathSafe(filePath)) {
          return { success: false, error: 'Invalid path' };
        }

        try {
          await openFileWithAppPlatform(filePath, appId);
          return { success: true };
        } catch (error) {
          logger.warn('[OpenWith] Failed to open file with app:', getErrorMessage(error));
          return { success: false, error: getErrorMessage(error) };
        }
      }
    )
  );
}
