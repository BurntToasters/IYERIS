import {
  ipcMain,
  app,
  shell,
  IpcMainInvokeEvent,
  systemPreferences,
  nativeTheme,
  BrowserWindow,
  screen,
} from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type { ApiResponse, LicensesData, Settings } from '../types';
import { MAX_TEXT_PREVIEW_BYTES, MAX_DATA_URL_BYTES } from './appState';
import { isPathSafe, getErrorMessage } from './security';
import { ignoreError } from '../shared';
import { isRunningInFlatpak } from './platformUtils';
import { logger } from './logger';
import { withTrustedApiHandler, withTrustedIpcEvent } from './ipcUtils';
import { launchDetached } from './processUtils';
import { checkFullDiskAccess, showFullDiskAccessDialog } from './fullDiskAccess';
import { getGitStatus, getGitBranch } from './gitHandlers';
import { getDiskSpace } from './diskSpaceHandler';
import { exportDiagnostics, getLogFileContent } from './diagnosticsHandlers';

export { checkFullDiskAccess, showFullDiskAccessDialog } from './fullDiskAccess';

const execFileAsync = promisify(execFile);

const FILE_DATA_URL_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jxl': 'image/jxl',
  '.jp2': 'image/jp2',
};

function getRestartAsAdminCommand(
  platform: NodeJS.Platform,
  appPath: string
): { command: string; args: string[] } | null {
  if (platform === 'win32') {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-Command', 'Start-Process', '-FilePath', appPath, '-Verb', 'RunAs'],
    };
  }
  if (platform === 'darwin') {
    const escapedPath = appPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return {
      command: 'osascript',
      args: ['-e', `do shell script quoted form of "${escapedPath}" with administrator privileges`],
    };
  }
  if (platform === 'linux') {
    return {
      command: 'pkexec',
      args: [appPath],
    };
  }
  return null;
}

export function setupSystemHandlers(
  loadSettings: () => Promise<Settings>,
  saveSettings: (settings: Settings) => Promise<ApiResponse>
): void {
  const handleTrustedApi = <
    TArgs extends unknown[],
    TResult extends { success: boolean; error?: string },
  >(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult,
    untrustedResponse?: TResult
  ): void => {
    ipcMain.handle(channel, withTrustedApiHandler(channel, handler, untrustedResponse));
  };

  const handleTrustedEvent = <TArgs extends unknown[], TResult>(
    channel: string,
    untrustedResponse: TResult,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult
  ): void => {
    ipcMain.handle(channel, withTrustedIpcEvent(channel, untrustedResponse, handler));
  };

  handleTrustedApi('get-disk-space', async (_event: IpcMainInvokeEvent, drivePath: string) =>
    getDiskSpace(drivePath)
  );

  handleTrustedApi('restart-as-admin', async (): Promise<ApiResponse> => {
    const appPath = app.getPath('exe');
    const command = getRestartAsAdminCommand(process.platform, appPath);
    if (!command) {
      return { success: false, error: 'Unsupported platform' };
    }
    try {
      await execFileAsync(command.command, command.args);
      app.quit();
      return { success: true };
    } catch (error) {
      console.log('[Admin] Failed to restart as admin:', getErrorMessage(error));
      return {
        success: false,
        error: 'Failed to restart with admin privileges. The request may have been cancelled.',
      };
    }
  });

  handleTrustedApi(
    'open-terminal',
    async (_event: IpcMainInvokeEvent, dirPath: string): Promise<ApiResponse> => {
      if (!isPathSafe(dirPath)) {
        return { success: false, error: 'Invalid directory path' };
      }
      const platform = process.platform;

      if (platform === 'win32') {
        const hasWT = await new Promise<boolean>((resolve) => {
          exec('where wt', (error) => resolve(!error));
        });

        if (hasWT) {
          launchDetached('wt', ['-d', dirPath]);
        } else {
          const quotedPath = `"${dirPath.replace(/"/g, '""')}"`;
          launchDetached('cmd', ['/K', 'cd', '/d', quotedPath]);
        }
      } else if (platform === 'darwin') {
        launchDetached('open', ['-a', 'Terminal', '--', dirPath]);
      } else {
        const terminals = [
          { cmd: 'x-terminal-emulator', args: ['--working-directory', dirPath] },
          { cmd: 'gnome-terminal', args: ['--working-directory=' + dirPath] },
          { cmd: 'xterm', args: ['-e', 'bash'] },
        ];

        let launched = false;
        for (const term of terminals) {
          const success = await new Promise<boolean>((resolve) => {
            const child = spawn(term.cmd, term.args, {
              shell: false,
              detached: true,
              cwd: dirPath,
            });
            child.once('spawn', () => {
              child.unref();
              resolve(true);
            });
            child.once('error', () => resolve(false));
          });
          if (success) {
            launched = true;
            break;
          }
        }

        if (!launched) {
          console.error('No suitable terminal emulator found');
          return { success: false, error: 'No suitable terminal emulator found' };
        }
      }

      return { success: true };
    }
  );

  handleTrustedApi(
    'read-file-content',
    async (
      _event: IpcMainInvokeEvent,
      filePath: string,
      maxSize: number = 1024 * 1024
    ): Promise<{ success: boolean; content?: string; error?: string; isTruncated?: boolean }> => {
      if (!isPathSafe(filePath)) {
        return { success: false, error: 'Invalid file path' };
      }
      const requestedMaxSize = Number.isFinite(maxSize) ? maxSize : MAX_TEXT_PREVIEW_BYTES;
      const safeMaxSize = Math.min(Math.max(1, requestedMaxSize), MAX_TEXT_PREVIEW_BYTES);
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        return { success: false, error: 'Not a regular file' };
      }

      if (stats.size > safeMaxSize) {
        const buffer = Buffer.alloc(safeMaxSize);
        const fileHandle = await fs.open(filePath, 'r');
        try {
          await fileHandle.read(buffer, 0, safeMaxSize, 0);
          return {
            success: true,
            content: buffer.toString('utf8'),
            isTruncated: true,
          };
        } finally {
          await fileHandle.close();
        }
      }

      const content = await fs.readFile(filePath, 'utf8');
      return { success: true, content, isTruncated: false };
    }
  );

  handleTrustedApi(
    'get-file-data-url',
    async (
      _event: IpcMainInvokeEvent,
      filePath: string,
      maxSize: number = 10 * 1024 * 1024
    ): Promise<{ success: boolean; dataUrl?: string; error?: string }> => {
      if (!isPathSafe(filePath)) {
        return { success: false, error: 'Invalid file path' };
      }
      const requestedMaxSize = Number.isFinite(maxSize) ? maxSize : MAX_DATA_URL_BYTES;
      const safeMaxSize = Math.min(Math.max(1, requestedMaxSize), MAX_DATA_URL_BYTES);
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        return { success: false, error: 'Not a regular file' };
      }

      if (stats.size > safeMaxSize) {
        return { success: false, error: 'File too large to preview' };
      }

      const buffer = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = FILE_DATA_URL_MIME_TYPES[ext] || 'application/octet-stream';
      const base64 = buffer.toString('base64');
      const dataUrl = `data:${mimeType};base64,${base64}`;

      return { success: true, dataUrl };
    }
  );

  handleTrustedApi(
    'get-licenses',
    async (): Promise<{ success: boolean; licenses?: LicensesData; error?: string }> => {
      const licensesPath = path.join(__dirname, '..', '..', 'licenses.json');
      const data = await fs.readFile(licensesPath, 'utf-8');
      const licenses = JSON.parse(data);
      return { success: true, licenses };
    }
  );

  const trustedStringEvents: Array<[string, () => string]> = [
    ['get-platform', () => process.platform],
    ['get-app-version', () => app.getVersion()],
    ['get-logs-path', () => logger.getLogsDirectory()],
  ];
  trustedStringEvents.forEach(([channel, handler]) => handleTrustedEvent(channel, '', handler));

  handleTrustedEvent(
    'get-system-accent-color',
    { accentColor: '#0078d4', isDarkMode: false },
    (): { accentColor: string; isDarkMode: boolean } => {
      let accentColor = '#0078d4';
      if (process.platform === 'win32' || process.platform === 'darwin') {
        try {
          const color = systemPreferences.getAccentColor();
          if (color && color.length >= 6) accentColor = `#${color.substring(0, 6)}`;
        } catch (error) {
          ignoreError(error);
        }
      }
      return {
        accentColor,
        isDarkMode: nativeTheme.shouldUseDarkColors,
      };
    }
  );

  const trustedBooleanEvents: Array<[string, () => boolean]> = [
    ['is-mas', () => process.mas === true],
    ['is-flatpak', () => isRunningInFlatpak()],
    ['is-ms-store', () => process.windowsStore === true],
  ];
  trustedBooleanEvents.forEach(([channel, handler]) => handleTrustedEvent(channel, false, handler));

  handleTrustedEvent(
    'get-system-text-scale',
    1,
    (): number => screen.getPrimaryDisplay().scaleFactor
  );

  handleTrustedEvent(
    'check-full-disk-access',
    { success: false, hasAccess: false },
    async (): Promise<{ success: boolean; hasAccess: boolean }> => {
      const hasAccess = await checkFullDiskAccess();
      return { success: true, hasAccess };
    }
  );

  handleTrustedApi('request-full-disk-access', async (): Promise<ApiResponse> => {
    if (process.platform !== 'darwin') {
      return { success: false, error: 'Full Disk Access is only applicable on macOS' };
    }

    await showFullDiskAccessDialog(loadSettings, saveSettings);
    return { success: true };
  });

  handleTrustedApi(
    'get-git-status',
    async (_event: IpcMainInvokeEvent, dirPath: string, includeUntracked: boolean = true) =>
      getGitStatus(dirPath, includeUntracked)
  );

  handleTrustedApi('get-git-branch', async (_event: IpcMainInvokeEvent, dirPath: string) =>
    getGitBranch(dirPath)
  );

  handleTrustedApi('open-logs-folder', async (): Promise<ApiResponse> => {
    const logsDir = logger.getLogsDirectory();
    await shell.openPath(logsDir);
    return { success: true };
  });

  handleTrustedApi('export-diagnostics', async () => exportDiagnostics(loadSettings));

  handleTrustedApi('get-log-file-content', async () => getLogFileContent());

  nativeTheme.on('updated', () => {
    const isDarkMode = nativeTheme.shouldUseDarkColors;
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('system-theme-changed', { isDarkMode });
    });
  });
}
