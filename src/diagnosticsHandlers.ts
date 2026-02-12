import * as path from 'path';
import { promises as fs } from 'fs';
import * as os from 'os';
import { app, dialog, type SaveDialogOptions } from 'electron';
import type { Settings } from './types';
import { getMainWindow, MAX_TEXT_PREVIEW_BYTES } from './appState';
import { getErrorMessage } from './security';
import { isRunningInFlatpak } from './platformUtils';
import { logger } from './utils/logger';

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

export function createSettingsDiagnosticsSnapshot(settings: Settings): Record<string, unknown> {
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

export async function exportDiagnostics(
  loadSettings: () => Promise<Settings>
): Promise<{ success: boolean; path?: string; error?: string }> {
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

export async function getLogFileContent(): Promise<{
  success: boolean;
  content?: string;
  error?: string;
  isTruncated?: boolean;
}> {
  const logPath = logger.getLogPath();
  const logData = await readTailTextFile(logPath, MAX_TEXT_PREVIEW_BYTES);
  return {
    success: true,
    content: logData.content,
    isTruncated: logData.isTruncated,
  };
}
