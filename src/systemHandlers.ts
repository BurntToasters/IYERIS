import {
  ipcMain,
  app,
  dialog,
  shell,
  IpcMainInvokeEvent,
  systemPreferences,
  nativeTheme,
  BrowserWindow,
  screen,
  type SaveDialogOptions,
} from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import type { ApiResponse, LicensesData, Settings } from './types';
import { getMainWindow, MAX_TEXT_PREVIEW_BYTES, MAX_DATA_URL_BYTES } from './appState';
import { isPathSafe, getErrorMessage } from './security';
import { ignoreError } from './shared';
import { isRunningInFlatpak } from './platformUtils';
import { logger } from './utils/logger';
import { withTrustedApiHandler, withTrustedIpcEvent } from './ipcUtils';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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
    } catch (error) {
      ignoreError(error);
    }
  }, timeoutMs);

  const clear = () => clearTimeout(timeout);
  child.on('close', clear);
  child.on('error', clear);

  return { child, timedOut: () => didTimeout };
}

const MAX_GIT_STATUS_BYTES = 20 * 1024 * 1024;
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

type SpawnCaptureResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

async function captureSpawnOutput(
  command: string,
  args: string[],
  timeoutMs: number,
  options: Parameters<typeof spawn>[2]
): Promise<SpawnCaptureResult> {
  const { child, timedOut } = spawnWithTimeout(command, args, timeoutMs, options);
  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', (data: Buffer) => {
    stdout += data.toString();
  });
  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  return { code, stdout, stderr, timedOut: timedOut() };
}

function launchDetached(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2] = {}
): void {
  const child = spawn(command, args, {
    ...options,
    shell: options.shell ?? false,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

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
    return {
      command: 'osascript',
      args: ['-e', `do shell script quoted form of "${appPath}" with administrator privileges`],
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

function mapGitStatusCode(statusCode: string): string {
  if (statusCode === '??') return 'untracked';
  if (statusCode === '!!') return 'ignored';
  if (statusCode.includes('U') || statusCode === 'AA' || statusCode === 'DD') return 'conflict';
  if (statusCode.includes('A') || statusCode.includes('C')) return 'added';
  if (statusCode.includes('D')) return 'deleted';
  if (statusCode.includes('R')) return 'renamed';
  return 'modified';
}

async function isGitRepository(dirPath: string): Promise<boolean> {
  try {
    await execAsync('git rev-parse --git-dir', {
      cwd: dirPath,
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

async function readTailTextFile(
  filePath: string,
  maxBytes: number
): Promise<{ content: string; sizeBytes: number; isTruncated: boolean }> {
  const stats = await fs.stat(filePath);
  if (stats.size > maxBytes) {
    const fileHandle = await fs.open(filePath, 'r');
    try {
      const start = Math.max(0, stats.size - maxBytes);
      const length = Math.min(maxBytes, stats.size);
      const buffer = Buffer.alloc(length);
      await fileHandle.read(buffer, 0, length, start);
      const content = buffer.toString('utf8');
      return {
        content: `... (truncated, showing last ${length} bytes)\n${content}`,
        sizeBytes: stats.size,
        isTruncated: true,
      };
    } finally {
      await fileHandle.close();
    }
  }

  const content = await fs.readFile(filePath, 'utf-8');
  return {
    content,
    sizeBytes: stats.size,
    isTruncated: false,
  };
}

type DiagnosticsRedaction = { token: string; value: string };
type AppPathName = Parameters<typeof app.getPath>[0];

function getAppPathSafe(name: AppPathName): string | null {
  try {
    const value = app.getPath(name);
    return typeof value === 'string' && value.trim() ? value : null;
  } catch {
    return null;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createDiagnosticsRedactions(): DiagnosticsRedaction[] {
  const sourceEntries: Array<{ token: string; value: string | null }> = [
    { token: '<HOME>', value: getAppPathSafe('home') },
    { token: '<USER_DATA>', value: getAppPathSafe('userData') },
    { token: '<TEMP>', value: getAppPathSafe('temp') },
    { token: '<DESKTOP>', value: getAppPathSafe('desktop') },
    { token: '<DOCUMENTS>', value: getAppPathSafe('documents') },
    { token: '<DOWNLOADS>', value: getAppPathSafe('downloads') },
  ];
  const redactions: DiagnosticsRedaction[] = [];
  const seen = new Set<string>();

  for (const entry of sourceEntries) {
    if (!entry.value) continue;
    const variants = new Set([
      entry.value,
      entry.value.replace(/\\/g, '/'),
      entry.value.replace(/\//g, '\\'),
    ]);
    for (const variant of variants) {
      const normalized = variant.trim();
      if (!normalized || normalized.length <= 1 || seen.has(normalized)) continue;
      seen.add(normalized);
      redactions.push({ token: entry.token, value: normalized });
    }
  }

  redactions.sort((a, b) => b.value.length - a.value.length);
  return redactions;
}

function redactDiagnosticsText(input: string, redactions: DiagnosticsRedaction[]): string {
  let output = input;
  for (const redaction of redactions) {
    output = output.replace(new RegExp(escapeRegex(redaction.value), 'gi'), redaction.token);
  }
  return output;
}

function createSettingsDiagnosticsSnapshot(settings: Settings): Record<string, unknown> {
  const SCALAR_KEYS = [
    'theme',
    'useSystemTheme',
    'sortBy',
    'sortOrder',
    'viewMode',
    'showDangerousOptions',
    'showHiddenFiles',
    'enableSearchHistory',
    'enableIndexer',
    'minimizeToTray',
    'startOnLogin',
    'autoCheckUpdates',
    'showRecentFiles',
    'showFolderTree',
    'enableTabs',
    'globalContentSearch',
    'globalClipboard',
    'enableSyntaxHighlighting',
    'enableGitStatus',
    'gitIncludeUntracked',
    'showFileHoverCard',
    'showFileCheckboxes',
    'reduceMotion',
    'highContrast',
    'largeText',
    'boldText',
    'visibleFocus',
    'reduceTransparency',
    'liquidGlassMode',
    'uiDensity',
    'updateChannel',
    'themedIcons',
    'disableHardwareAcceleration',
    'useSystemFontSize',
    'confirmFileOperations',
    'fileConflictBehavior',
    'skipElevationConfirmation',
    'maxThumbnailSizeMB',
    'thumbnailQuality',
    'autoPlayVideos',
    'previewPanelPosition',
    'maxPreviewSizeMB',
    'gridColumns',
    'iconSize',
    'compactFileInfo',
    'showFileExtensions',
    'maxSearchHistoryItems',
    'maxDirectoryHistoryItems',
  ] as const;
  const snapshot: Record<string, unknown> = {};
  for (const key of SCALAR_KEYS) snapshot[key] = settings[key];
  snapshot.startupPathConfigured = Boolean(settings.startupPath?.trim());
  snapshot.customThemeName = settings.customTheme?.name ?? null;
  snapshot.counts = {
    bookmarks: settings.bookmarks.length,
    searchHistory: settings.searchHistory.length,
    directoryHistory: settings.directoryHistory.length,
    recentFiles: settings.recentFiles?.length ?? 0,
    folderIcons: settings.folderIcons ? Object.keys(settings.folderIcons).length : 0,
    shortcuts: settings.shortcuts ? Object.keys(settings.shortcuts).length : 0,
    tabs: settings.tabState?.tabs.length ?? 0,
  };
  return snapshot;
}

export async function checkFullDiskAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    console.log('[FDA] Not on macOS, skipping check');
    return true;
  }

  console.log('[FDA] Testing Full Disk Access...');
  console.log('[FDA] App path:', app.getPath('exe'));
  console.log('[FDA] Process path:', process.execPath);

  try {
    const tccPath = path.join(
      app.getPath('home'),
      'Library',
      'Application Support',
      'com.apple.TCC',
      'TCC.db'
    );
    console.log('[FDA] Testing TCC.db at:', tccPath);

    const fileHandle = await fs.open(tccPath, 'r');
    await fileHandle.close();

    console.log('[FDA] Can read TCC.db');
    return true;
  } catch (error) {
    const err = error as { code?: string; message?: string };
    console.log('[FDA] Cannot read TCC.db:', err.code || 'ERROR', '-', err.message);
  }

  const testPaths = [
    path.join(app.getPath('home'), 'Library', 'Safari'),
    path.join(app.getPath('home'), 'Library', 'Mail'),
    path.join(app.getPath('home'), 'Library', 'Messages'),
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
      const err = error as { code?: string; message?: string };
      console.log('[FDA] Failed:', testPath, '-', err.code || err.message);
    }
  }

  console.log('[FDA] Full Disk Access: NOT granted');
  return false;
}

export async function showFullDiskAccessDialog(
  loadSettings: () => Promise<Settings>,
  saveSettings: (settings: Settings) => Promise<ApiResponse>
): Promise<void> {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.log('[FDA] Cannot show dialog - no valid window');
    return;
  }
  console.log('[FDA] Showing Full Disk Access dialog');
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Full Disk Access Required',
    message: 'IYERIS needs Full Disk Access for full functionality',
    detail:
      'To browse all files and folders on your Mac without repeated permission prompts, IYERIS needs Full Disk Access.\n\n' +
      'How to grant access:\n' +
      '1. Click "Open Settings" below\n' +
      '2. Click the + button to add an app\n' +
      '3. Navigate to Applications and select IYERIS\n' +
      '4. Make sure the toggle next to IYERIS is ON\n' +
      '5. Restart IYERIS\n\n' +
      "Without this, you'll see permission prompts for each folder.",
    buttons: ['Open Settings', 'Remind Me Later', "Don't Ask Again"],
    defaultId: 0,
    cancelId: 1,
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

  handleTrustedApi(
    'get-disk-space',
    async (
      _event: IpcMainInvokeEvent,
      drivePath: string
    ): Promise<{ success: boolean; total?: number; free?: number; error?: string }> => {
      console.log(
        '[Main] get-disk-space called with path:',
        drivePath,
        'Platform:',
        process.platform
      );
      try {
        if (process.platform === 'win32') {
          const normalized = drivePath.replace(/\//g, '\\');
          const isUnc = normalized.startsWith('\\\\');

          let psCommand = '';
          if (isUnc) {
            const uncRoot = normalized.endsWith('\\') ? normalized : normalized + '\\';
            const escapedRoot = uncRoot.replace(/'/g, "''");
            console.log('[Main] Getting disk space for UNC path:', uncRoot);
            psCommand = `Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -eq '${escapedRoot}' } | Select-Object @{Name='Free';Expression={$_.Free}}, @{Name='Used';Expression={$_.Used}} | ConvertTo-Json`;
          } else {
            const driveLetter = normalized.substring(0, 2);
            const driveChar = driveLetter.charAt(0).toUpperCase();
            if (!/^[A-Z]$/.test(driveChar)) {
              console.error('[Main] Invalid drive letter:', driveChar);
              return { success: false, error: 'Invalid drive letter' };
            }
            console.log('[Main] Getting disk space for drive:', driveChar);
            psCommand = `Get-PSDrive -Name ${driveChar} | Select-Object @{Name='Free';Expression={$_.Free}}, @{Name='Used';Expression={$_.Used}} | ConvertTo-Json`;
          }

          const { code, stdout, stderr, timedOut } = await captureSpawnOutput(
            'powershell',
            ['-Command', psCommand],
            5000,
            { shell: false }
          );
          if (timedOut) {
            return { success: false, error: 'Disk space query timed out' };
          }
          if (code !== 0) {
            console.error('[Main] PowerShell error:', stderr);
            return { success: false, error: 'PowerShell command failed' };
          }
          console.log('[Main] PowerShell output:', stdout);
          try {
            const trimmed = stdout.trim();
            if (!trimmed) {
              return { success: false, error: 'Disk space not available for path' };
            }
            const data = JSON.parse(trimmed);
            const entry = Array.isArray(data) ? data[0] : data;
            if (!entry) {
              return { success: false, error: 'Disk space not available for path' };
            }
            const free = parseInt(entry.Free);
            const used = parseInt(entry.Used);
            const total = free + used;
            console.log('[Main] Success - Free:', free, 'Used:', used, 'Total:', total);
            return { success: true, free, total };
          } catch (parseError) {
            console.error('[Main] JSON parse error:', parseError);
            return { success: false, error: 'Could not parse disk info' };
          }
        } else if (process.platform === 'darwin' || process.platform === 'linux') {
          const { code, stdout, stderr, timedOut } = await captureSpawnOutput(
            'df',
            ['-k', '--', drivePath],
            5000,
            { shell: false }
          );
          if (timedOut) {
            return { success: false, error: 'Disk space query timed out' };
          }
          if (code !== 0) {
            console.error('[Main] df error:', stderr);
            return { success: false, error: 'df command failed' };
          }
          const lines = stdout.trim().split('\n');
          if (lines.length < 2) {
            return { success: false, error: 'Could not parse disk info' };
          }

          const parts = lines[1].trim().split(/\s+/);
          if (parts.length >= 4) {
            const total = parseInt(parts[1]) * 1024;
            const available = parseInt(parts[3]) * 1024;
            return { success: true, total, free: available };
          }
          return { success: false, error: 'Invalid disk info format' };
        } else {
          return { success: false, error: 'Disk space info not available on this platform' };
        }
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    }
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
      const licensesPath = path.join(__dirname, '..', 'licenses.json');
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
    async (
      _event: IpcMainInvokeEvent,
      dirPath: string,
      includeUntracked: boolean = true
    ): Promise<{
      success: boolean;
      isGitRepo?: boolean;
      statuses?: { path: string; status: string }[];
      error?: string;
    }> => {
      try {
        if (!isPathSafe(dirPath)) {
          return { success: false, error: 'Invalid directory path' };
        }

        if (!(await isGitRepository(dirPath))) {
          return { success: true, isGitRepo: false, statuses: [] };
        }

        const statusArgs = includeUntracked ? ['-uall'] : ['-uno'];
        const { child: gitProcess, timedOut } = spawnWithTimeout(
          'git',
          ['status', '--porcelain', '-z', ...statusArgs],
          30000,
          { cwd: dirPath, windowsHide: true, shell: false }
        );

        const stdoutChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderr = '';
        let truncated = false;

        if (gitProcess.stdout) {
          gitProcess.stdout.on('data', (data: Buffer) => {
            if (stdoutBytes + data.length > MAX_GIT_STATUS_BYTES) {
              truncated = true;
              try {
                gitProcess.kill();
              } catch (error) {
                ignoreError(error);
              }
              return;
            }
            stdoutBytes += data.length;
            stdoutChunks.push(data);
          });
        }

        if (gitProcess.stderr) {
          gitProcess.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
          });
        }

        const stdout = await new Promise<string>((resolve, reject) => {
          gitProcess.on('error', reject);
          gitProcess.on('close', (code) => {
            if (timedOut()) {
              reject(new Error('Git status timed out'));
              return;
            }
            if (truncated) {
              reject(new Error('Git status output too large'));
              return;
            }
            if (code !== 0) {
              reject(new Error(stderr || 'Git status failed'));
              return;
            }
            resolve(Buffer.concat(stdoutChunks).toString('utf8'));
          });
        });

        const statuses: { path: string; status: string }[] = [];
        const entries = stdout.split('\0').filter((entry) => entry);

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (entry.length < 3) continue;
          const statusCode = entry.substring(0, 2);
          let filePath = entry.substring(3);

          if (statusCode.includes('R') || statusCode.includes('C')) {
            const nextPath = entries[i + 1];
            if (nextPath) {
              filePath = nextPath;
              i += 1;
            }
          }

          const fullPath = path.join(dirPath, filePath);
          statuses.push({ path: fullPath, status: mapGitStatusCode(statusCode) });
        }

        return { success: true, isGitRepo: true, statuses };
      } catch (error) {
        console.error('[Git Status] Error:', error);
        return { success: true, isGitRepo: true, statuses: [] };
      }
    }
  );

  handleTrustedApi(
    'get-git-branch',
    async (
      _event: IpcMainInvokeEvent,
      dirPath: string
    ): Promise<{
      success: boolean;
      branch?: string;
      error?: string;
    }> => {
      try {
        if (!isPathSafe(dirPath)) {
          return { success: false, error: 'Invalid directory path' };
        }

        if (!(await isGitRepository(dirPath))) {
          return { success: true, branch: undefined };
        }

        const { stdout } = await execAsync('git branch --show-current', {
          cwd: dirPath,
          timeout: 10000,
        });

        const branch = stdout.trim();

        if (!branch) {
          const { stdout: refStdout } = await execAsync('git rev-parse --short HEAD', {
            cwd: dirPath,
            timeout: 10000,
          });
          return { success: true, branch: `HEAD:${refStdout.trim()}` };
        }

        return { success: true, branch };
      } catch (error) {
        console.error('[Git Branch] Error:', error);
        return { success: true, branch: undefined };
      }
    }
  );

  handleTrustedApi('open-logs-folder', async (): Promise<ApiResponse> => {
    const logsDir = logger.getLogsDirectory();
    await shell.openPath(logsDir);
    return { success: true };
  });

  handleTrustedApi(
    'export-diagnostics',
    async (): Promise<{ success: boolean; path?: string; error?: string }> => {
      const mainWindow = getMainWindow();
      const defaultPath = path.join(
        app.getPath('desktop'),
        `iyeris-diagnostics-${new Date().toISOString().replace(/[:]/g, '-')}.json`
      );
      const dialogOptions: SaveDialogOptions = {
        title: 'Export Diagnostics',
        defaultPath,
        buttonLabel: 'Export',
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
        properties: ['showOverwriteConfirmation'],
      };
      const saveDialogResult =
        mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showSaveDialog(mainWindow, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions);

      if (saveDialogResult.canceled || !saveDialogResult.filePath) {
        return { success: false, error: 'Export cancelled' };
      }

      const settings = await loadSettings();
      const settingsSnapshot = createSettingsDiagnosticsSnapshot(settings);
      const redactions = createDiagnosticsRedactions();
      const redact = (value: string) => redactDiagnosticsText(value, redactions);
      const logPath = logger.getLogPath();
      let logContent = '';
      let logError: string | undefined;
      let logSizeBytes = 0;
      let logIsTruncated = false;
      try {
        const logData = await readTailTextFile(logPath, MAX_TEXT_PREVIEW_BYTES);
        logContent = redact(logData.content);
        logSizeBytes = logData.sizeBytes;
        logIsTruncated = logData.isTruncated;
      } catch (error) {
        logError = redact(getErrorMessage(error));
      }

      const diagnostics = {
        generatedAt: new Date().toISOString(),
        app: {
          name: app.getName(),
          version: app.getVersion(),
          isPackaged: app.isPackaged,
          platform: process.platform,
          arch: process.arch,
          versions: {
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node,
            v8: process.versions.v8,
          },
          distribution: {
            isMas: process.mas === true,
            isFlatpak: isRunningInFlatpak(),
            isMsStore: process.windowsStore === true,
          },
        },
        system: {
          osType: os.type(),
          osRelease: os.release(),
          osArch: os.arch(),
          cpuCount: os.cpus().length,
          totalMemoryBytes: os.totalmem(),
          freeMemoryBytes: os.freemem(),
          uptimeSeconds: os.uptime(),
          locale: app.getLocale(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        window:
          mainWindow && !mainWindow.isDestroyed()
            ? {
                bounds: mainWindow.getBounds(),
                isVisible: mainWindow.isVisible(),
                isMaximized: mainWindow.isMaximized(),
                isMinimized: mainWindow.isMinimized(),
                isFullScreen: mainWindow.isFullScreen(),
              }
            : null,
        privacy: {
          diagnosticsRedactionsApplied: true,
          fullSettingsIncluded: false,
          fullLogPathIncluded: false,
        },
        settings: settingsSnapshot,
        logs: {
          path: redact(logPath),
          sizeBytes: logSizeBytes,
          isTruncated: logIsTruncated,
          error: logError,
          content: logContent,
        },
      };

      await fs.writeFile(saveDialogResult.filePath, JSON.stringify(diagnostics, null, 2), 'utf8');
      return { success: true, path: saveDialogResult.filePath };
    }
  );

  handleTrustedApi(
    'get-log-file-content',
    async (): Promise<{
      success: boolean;
      content?: string;
      error?: string;
      isTruncated?: boolean;
    }> => {
      const logPath = logger.getLogPath();
      const logData = await readTailTextFile(logPath, MAX_TEXT_PREVIEW_BYTES);
      return {
        success: true,
        content: logData.content,
        isTruncated: logData.isTruncated,
      };
    }
  );

  nativeTheme.on('updated', () => {
    const isDarkMode = nativeTheme.shouldUseDarkColors;
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('system-theme-changed', { isDarkMode });
    });
  });
}
