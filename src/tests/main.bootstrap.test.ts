import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appOn: vi.fn(),
  appQuit: vi.fn(),
  appRequestSingleInstanceLock: vi.fn(() => true),
  appDisableHardwareAcceleration: vi.fn(),
  appWhenReady: vi.fn(() => new Promise<void>(() => {})),
  appCommandLineAppendSwitch: vi.fn(),
  appGetPath: vi.fn(() => '/tmp'),
  browserWindowFromWebContents: vi.fn(),
  fileTasksShutdown: vi.fn().mockResolvedValue(undefined),
  indexerTasksShutdown: vi.fn().mockResolvedValue(undefined),
  setupFileTasksProgressHandler: vi.fn(),
  setupZoomHandlers: vi.fn(),
  setupFileAnalysisHandlers: vi.fn(),
  setupSystemHandlers: vi.fn(),
  setupSettingsHandlers: vi.fn(),
  setupHomeSettingsHandlers: vi.fn(),
  setupUndoRedoHandlers: vi.fn(),
  setupWindowHandlers: vi.fn(),
  setupFileOperationHandlers: vi.fn(),
  setupElevatedOperationHandlers: vi.fn(),
  setupSearchHandlers: vi.fn(),
  setupArchiveHandlers: vi.fn(),
  setupUpdateHandlers: vi.fn(),
  setupThumbnailCacheHandlers: vi.fn(),
  getActiveFolderSizeCalculations: vi.fn(() => 'folder-progress'),
  getActiveChecksumCalculations: vi.fn(() => 'checksum-progress'),
}));

vi.mock('electron', () => ({
  app: {
    on: mocks.appOn,
    quit: mocks.appQuit,
    requestSingleInstanceLock: mocks.appRequestSingleInstanceLock,
    disableHardwareAcceleration: mocks.appDisableHardwareAcceleration,
    whenReady: mocks.appWhenReady,
    commandLine: {
      appendSwitch: mocks.appCommandLineAppendSwitch,
    },
    getPath: mocks.appGetPath,
    dock: { show: vi.fn(), hide: vi.fn() },
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: mocks.browserWindowFromWebContents,
    getAllWindows: vi.fn(() => []),
  },
  powerMonitor: {
    on: vi.fn(),
  },
}));

vi.mock('../main/appState', () => ({
  getMainWindow: vi.fn(() => null),
  getFileIndexer: vi.fn(() => null),
  setFileIndexer: vi.fn(),
  getTray: vi.fn(() => null),
  setIsQuitting: vi.fn(),
  setShouldStartHidden: vi.fn(),
  getFileTasks: vi.fn(() => ({ shutdown: mocks.fileTasksShutdown })),
  getIndexerTasks: vi.fn(() => ({ shutdown: mocks.indexerTasksShutdown })),
}));

vi.mock('../main/platformUtils', () => ({
  checkMsiInstallation: vi.fn(),
}));

vi.mock('../main/ipcUtils', () => ({
  setupFileTasksProgressHandler: mocks.setupFileTasksProgressHandler,
}));

vi.mock('../main/utils', () => ({
  warmupDrivesCache: vi.fn(),
}));

vi.mock('../main/indexer', () => ({
  FileIndexer: class {},
}));

vi.mock('../main/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  initializeLogger: vi.fn(),
}));

vi.mock('../main/zoomHandlers', () => ({
  setupZoomHandlers: mocks.setupZoomHandlers,
}));

vi.mock('../main/fileAnalysis', () => ({
  setupFileAnalysisHandlers: mocks.setupFileAnalysisHandlers,
  cleanupFileAnalysis: vi.fn(),
  getActiveFolderSizeCalculations: mocks.getActiveFolderSizeCalculations,
  getActiveChecksumCalculations: mocks.getActiveChecksumCalculations,
}));

vi.mock('../main/systemHandlers', () => ({
  setupSystemHandlers: mocks.setupSystemHandlers,
  checkFullDiskAccess: vi.fn().mockResolvedValue(true),
  showFullDiskAccessDialog: vi.fn(),
}));

vi.mock('../main/settingsManager', () => ({
  setupSettingsHandlers: mocks.setupSettingsHandlers,
  loadSettings: vi.fn().mockResolvedValue({
    enableIndexer: false,
    minimizeToTray: false,
    startOnLogin: false,
  }),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  applyLoginItemSettings: vi.fn(),
}));

vi.mock('../main/homeSettingsManager', () => ({
  setupHomeSettingsHandlers: mocks.setupHomeSettingsHandlers,
}));

vi.mock('../main/undoRedoManager', () => ({
  setupUndoRedoHandlers: mocks.setupUndoRedoHandlers,
  clearUndoRedoStacks: vi.fn(),
}));

vi.mock('../main/windowManager', () => ({
  createWindow: vi.fn(),
  createTray: vi.fn(),
  createTrayForHiddenStart: vi.fn(),
  setupApplicationMenu: vi.fn(),
  setupWindowHandlers: mocks.setupWindowHandlers,
}));

vi.mock('../main/fileOperations', () => ({
  setupFileOperationHandlers: mocks.setupFileOperationHandlers,
  stopHiddenFileCacheCleanup: vi.fn(),
}));

vi.mock('../main/searchHandlers', () => ({
  setupSearchHandlers: mocks.setupSearchHandlers,
}));

vi.mock('../main/archiveManager', () => ({
  setupArchiveHandlers: mocks.setupArchiveHandlers,
  cleanupArchiveOperations: vi.fn(),
}));

vi.mock('../main/updateManager', () => ({
  setupUpdateHandlers: mocks.setupUpdateHandlers,
  initializeAutoUpdater: vi.fn(),
}));

vi.mock('../main/thumbnailCache', () => ({
  setupThumbnailCacheHandlers: mocks.setupThumbnailCacheHandlers,
  stopThumbnailCacheCleanup: vi.fn(),
}));

vi.mock('../main/elevatedOperations', () => ({
  setupElevatedOperationHandlers: mocks.setupElevatedOperationHandlers,
}));

vi.mock('../main/openWithHandlers', () => ({
  setupOpenWithHandlers: vi.fn(),
}));

vi.mock('../main/fileWatcher', () => ({
  setupFileWatcherHandlers: vi.fn(),
  cleanupAllWatchers: vi.fn(),
}));

describe('main bootstrap wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('registers core handlers and bootstrap setup on module import', async () => {
    await import('../main/main');

    expect(mocks.appRequestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(mocks.setupFileTasksProgressHandler).toHaveBeenCalledWith(
      'folder-progress',
      'checksum-progress'
    );

    expect(mocks.setupZoomHandlers).toHaveBeenCalledTimes(1);
    expect(mocks.setupFileAnalysisHandlers).toHaveBeenCalledTimes(1);
    expect(mocks.setupSystemHandlers).toHaveBeenCalledTimes(1);
    expect(mocks.setupSettingsHandlers).toHaveBeenCalledTimes(1);
    expect(mocks.setupHomeSettingsHandlers).toHaveBeenCalledTimes(1);
    expect(mocks.setupUndoRedoHandlers).toHaveBeenCalledTimes(1);
    expect(mocks.setupWindowHandlers).toHaveBeenCalledTimes(1);
    expect(mocks.setupFileOperationHandlers).toHaveBeenCalledTimes(1);
    expect(mocks.setupElevatedOperationHandlers).toHaveBeenCalledTimes(1);
    expect(mocks.setupSearchHandlers).toHaveBeenCalledTimes(1);
    expect(mocks.setupArchiveHandlers).toHaveBeenCalledTimes(1);
    expect(mocks.setupUpdateHandlers).toHaveBeenCalledTimes(1);
    expect(mocks.setupThumbnailCacheHandlers).toHaveBeenCalledTimes(1);

    const registeredEvents = mocks.appOn.mock.calls.map((call) => call[0]);
    expect(registeredEvents).toContain('before-quit');
    expect(registeredEvents).toContain('window-all-closed');
  });
});
