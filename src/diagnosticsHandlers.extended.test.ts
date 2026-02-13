import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  fsWriteFile: vi.fn(),
  fsStat: vi.fn(),
  fsOpen: vi.fn(),
  fsReadFile: vi.fn(),
  fsRename: vi.fn(),
  appGetPath: vi.fn((name: string) => {
    const paths: Record<string, string> = {
      home: '/home/testuser',
      userData: '/home/testuser/.config/iyeris',
      temp: '/tmp',
      desktop: '/home/testuser/Desktop',
      documents: '/home/testuser/Documents',
      downloads: '/home/testuser/Downloads',
    };
    return paths[name] || '/tmp';
  }),
  appGetName: vi.fn(() => 'IYERIS'),
  appGetVersion: vi.fn(() => '1.0.0-test'),
  appGetLocale: vi.fn(() => 'en-US'),
  dialogShowSaveDialog: vi.fn(),
  mainWindowMock: null as unknown,
  loggerGetLogPath: vi.fn(() => '/tmp/logs/iyeris.log'),
  loggerGetLogsDirectory: vi.fn(() => '/tmp/logs'),
}));

vi.mock('electron', () => ({
  app: {
    getPath: hoisted.appGetPath,
    getName: hoisted.appGetName,
    getVersion: hoisted.appGetVersion,
    isPackaged: false,
    getLocale: hoisted.appGetLocale,
  },
  dialog: {
    showSaveDialog: hoisted.dialogShowSaveDialog,
  },
}));

vi.mock('fs', () => ({
  promises: {
    writeFile: hoisted.fsWriteFile,
    stat: hoisted.fsStat,
    open: hoisted.fsOpen,
    readFile: hoisted.fsReadFile,
    rename: hoisted.fsRename,
  },
}));

vi.mock('./appState', () => ({
  getMainWindow: vi.fn(() => hoisted.mainWindowMock),
  MAX_TEXT_PREVIEW_BYTES: 1024,
}));

vi.mock('./security', () => ({
  getErrorMessage: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
}));

vi.mock('./platformUtils', () => ({
  isRunningInFlatpak: vi.fn(() => false),
}));

vi.mock('./utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    getLogPath: hoisted.loggerGetLogPath,
    getLogsDirectory: hoisted.loggerGetLogsDirectory,
  },
}));

import { exportDiagnostics, getLogFileContent } from './diagnosticsHandlers';
import type { Settings } from './types';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: 'dark',
    useSystemTheme: false,
    sortBy: 'name',
    sortOrder: 'asc',
    viewMode: 'grid',
    showDangerousOptions: false,
    showHiddenFiles: false,
    enableSearchHistory: true,
    enableIndexer: true,
    minimizeToTray: false,
    startOnLogin: false,
    autoCheckUpdates: true,
    showRecentFiles: true,
    showFolderTree: true,
    enableTabs: true,
    globalContentSearch: false,
    globalClipboard: false,
    enableSyntaxHighlighting: true,
    enableGitStatus: false,
    gitIncludeUntracked: false,
    showFileHoverCard: true,
    showFileCheckboxes: false,
    reduceMotion: false,
    highContrast: false,
    largeText: false,
    boldText: false,
    visibleFocus: false,
    reduceTransparency: false,
    liquidGlassMode: false,
    uiDensity: 'normal',
    updateChannel: 'stable',
    themedIcons: false,
    disableHardwareAcceleration: false,
    useSystemFontSize: false,
    confirmFileOperations: true,
    fileConflictBehavior: 'ask',
    skipElevationConfirmation: false,
    maxThumbnailSizeMB: 10,
    thumbnailQuality: 80,
    autoPlayVideos: false,
    previewPanelPosition: 'right',
    maxPreviewSizeMB: 50,
    gridColumns: 'auto',
    iconSize: 'medium',
    compactFileInfo: false,
    showFileExtensions: true,
    maxSearchHistoryItems: 50,
    maxDirectoryHistoryItems: 50,
    bookmarks: [],
    searchHistory: [],
    directoryHistory: [],
    recentFiles: [],
    startupPath: '',
    customTheme: undefined,
    folderIcons: {},
    shortcuts: {},
    tabState: undefined,
    ...overrides,
  } as unknown as Settings;
}

describe('diagnosticsHandlers (extended)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.mainWindowMock = null;
  });

  describe('exportDiagnostics', () => {
    const mockLoadSettings = vi.fn(async () => makeSettings());

    it('returns cancelled when user cancels save dialog', async () => {
      hoisted.dialogShowSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });

      const result = await exportDiagnostics(mockLoadSettings);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Export cancelled');
    });

    it('exports diagnostics file successfully', async () => {
      hoisted.dialogShowSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: '/tmp/diag.json',
      });

      hoisted.fsStat.mockResolvedValue({ size: 100 });
      hoisted.fsReadFile.mockResolvedValue('Some log content here');
      hoisted.fsWriteFile.mockResolvedValue(undefined);

      const result = await exportDiagnostics(mockLoadSettings);
      expect(result.success).toBe(true);
      expect(result.path).toBe('/tmp/diag.json');
      expect(hoisted.fsWriteFile).toHaveBeenCalledWith(
        '/tmp/diag.json',
        expect.any(String),
        'utf8'
      );

      const writtenData = JSON.parse(hoisted.fsWriteFile.mock.calls[0][1]);
      expect(writtenData.generatedAt).toBeDefined();
      expect(writtenData.app.name).toBe('IYERIS');
      expect(writtenData.app.version).toBe('1.0.0-test');
      expect(writtenData.app.platform).toBe(process.platform);
      expect(writtenData.system).toBeDefined();
      expect(writtenData.settings).toBeDefined();
      expect(writtenData.privacy.diagnosticsRedactionsApplied).toBe(true);
    });

    it('redacts user paths in exported diagnostics', async () => {
      hoisted.dialogShowSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: '/tmp/diag.json',
      });

      hoisted.fsStat.mockResolvedValue({ size: 50 });
      hoisted.fsReadFile.mockResolvedValue('Error at /home/testuser/secret/path');
      hoisted.fsWriteFile.mockResolvedValue(undefined);

      const result = await exportDiagnostics(mockLoadSettings);
      expect(result.success).toBe(true);

      const writtenData = JSON.parse(hoisted.fsWriteFile.mock.calls[0][1]);
      expect(writtenData.logs.content).not.toContain('/home/testuser');
    });

    it('handles log file read errors gracefully', async () => {
      hoisted.dialogShowSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: '/tmp/diag.json',
      });

      hoisted.fsStat.mockRejectedValue(new Error('Log file not found'));
      hoisted.fsWriteFile.mockResolvedValue(undefined);

      const result = await exportDiagnostics(mockLoadSettings);
      expect(result.success).toBe(true);

      const writtenData = JSON.parse(hoisted.fsWriteFile.mock.calls[0][1]);
      expect(writtenData.logs.error).toBeDefined();
    });

    it('truncates large log files', async () => {
      hoisted.dialogShowSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: '/tmp/diag.json',
      });

      const fileHandle = {
        read: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      hoisted.fsStat.mockResolvedValue({ size: 2048 });
      hoisted.fsOpen.mockResolvedValue(fileHandle);
      hoisted.fsWriteFile.mockResolvedValue(undefined);

      const result = await exportDiagnostics(mockLoadSettings);
      expect(result.success).toBe(true);

      const writtenData = JSON.parse(hoisted.fsWriteFile.mock.calls[0][1]);
      expect(writtenData.logs.isTruncated).toBe(true);
    });

    it('uses modal dialog when mainWindow is available', async () => {
      hoisted.mainWindowMock = {
        isDestroyed: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        isVisible: () => true,
        isMaximized: () => false,
        isMinimized: () => false,
        isFullScreen: () => false,
      };

      hoisted.dialogShowSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: '/tmp/diag.json',
      });
      hoisted.fsStat.mockResolvedValue({ size: 10 });
      hoisted.fsReadFile.mockResolvedValue('log');
      hoisted.fsWriteFile.mockResolvedValue(undefined);

      const result = await exportDiagnostics(mockLoadSettings);
      expect(result.success).toBe(true);

      expect(hoisted.dialogShowSaveDialog).toHaveBeenCalledWith(
        hoisted.mainWindowMock,
        expect.any(Object)
      );
    });
  });

  describe('getLogFileContent', () => {
    it('returns log file content', async () => {
      hoisted.fsStat.mockResolvedValue({ size: 50 });
      hoisted.fsReadFile.mockResolvedValue('Log line 1\nLog line 2');

      const result = await getLogFileContent();
      expect(result.success).toBe(true);
      expect(result.content).toBe('Log line 1\nLog line 2');
      expect(result.isTruncated).toBe(false);
    });

    it('truncates large log files', async () => {
      const fileHandle = {
        read: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      hoisted.fsStat.mockResolvedValue({ size: 2048 });
      hoisted.fsOpen.mockResolvedValue(fileHandle);

      const result = await getLogFileContent();
      expect(result.success).toBe(true);
      expect(result.isTruncated).toBe(true);
    });
  });
});
