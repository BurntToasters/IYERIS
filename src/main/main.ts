import { app, BrowserWindow, powerMonitor } from 'electron';
import * as os from 'os';
import * as path from 'path';
import { readFileSync } from 'fs';

import {
  getMainWindow,
  getFileIndexer,
  setFileIndexer,
  getTray,
  setIsQuitting,
  setShouldStartHidden,
  getFileTasks,
  getIndexerTasks,
} from './appState';
import { checkMsiInstallation } from './platformUtils';
import { setupFileTasksProgressHandler } from './ipcUtils';
import { warmupDrivesCache } from './utils';
import { FileIndexer } from './indexer';
import { logger, initializeLogger } from './utils/logger';

import { setupZoomHandlers } from './zoomHandlers';
import {
  setupFileAnalysisHandlers,
  cleanupFileAnalysis,
  getActiveFolderSizeCalculations,
  getActiveChecksumCalculations,
} from './fileAnalysis';
import {
  setupSystemHandlers,
  checkFullDiskAccess,
  showFullDiskAccessDialog,
} from './systemHandlers';
import {
  setupSettingsHandlers,
  loadSettings,
  saveSettings,
  applyLoginItemSettings,
} from './settingsManager';
import { setupHomeSettingsHandlers } from './homeSettingsManager';
import { setupUndoRedoHandlers, clearUndoRedoStacks } from './undoRedoManager';
import {
  createWindow,
  createTray,
  createTrayForHiddenStart,
  setupApplicationMenu,
  setupWindowHandlers,
} from './windowManager';
import { setupFileOperationHandlers, stopHiddenFileCacheCleanup } from './fileOperations';
import { setupSearchHandlers } from './searchHandlers';
import { setupArchiveHandlers, cleanupArchiveOperations } from './archiveManager';
import { setupUpdateHandlers, initializeAutoUpdater } from './updateManager';
import { setupThumbnailCacheHandlers, stopThumbnailCacheCleanup } from './thumbnailCache';
import { setupElevatedOperationHandlers } from './elevatedOperations';

const TOTAL_MEM_GB = os.totalmem() / 1024 ** 3;
const rendererRecoveryAttempts = new Map<number, number>();
const RENDERER_RELAUNCH_ARG_PREFIX = '--renderer-relaunch-count=';
const rendererRelaunchCountArg = process.argv.find((arg) =>
  arg.startsWith(RENDERER_RELAUNCH_ARG_PREFIX)
);
const parsedRendererRelaunchCount = rendererRelaunchCountArg
  ? Number.parseInt(rendererRelaunchCountArg.slice(RENDERER_RELAUNCH_ARG_PREFIX.length), 10)
  : 0;
const rendererRelaunchCount =
  Number.isFinite(parsedRendererRelaunchCount) && parsedRendererRelaunchCount > 0
    ? parsedRendererRelaunchCount
    : 0;

// hw accel override
if (process.argv.includes('--disable-hardware-acceleration')) {
  logger.info('[Performance] Hardware acceleration disabled via command line flag');
  app.disableHardwareAcceleration();
} else {
  try {
    const userDataPath = app.getPath('userData');
    const settingsFilePath = path.join(userDataPath, 'settings.json');
    const raw = readFileSync(settingsFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.disableHardwareAcceleration === true) {
      logger.info('[Performance] Hardware acceleration disabled via settings');
      app.disableHardwareAcceleration();
    }
  } catch (error) {
    logger.warn('[Performance] Could not check hardware acceleration setting:', error);
  }
}

// mem limits by system ram
const MAX_OLD_SPACE_MB =
  TOTAL_MEM_GB < 6 ? 512 : TOTAL_MEM_GB < 12 ? 1024 : TOTAL_MEM_GB < 24 ? 2048 : 3072;
const jsFlags: string[] = [`--max-old-space-size=${MAX_OLD_SPACE_MB}`];
if (TOTAL_MEM_GB < 12) {
  jsFlags.push('--optimize-for-size', '--gc-interval=100');
}
app.commandLine.appendSwitch('js-flags', jsFlags.join(' '));
app.commandLine.appendSwitch('enable-features', 'ReducedReferrerGranularity,V8VmFuture');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,MediaRouter');
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}
app.commandLine.appendSwitch('wm-window-animations-disabled');
app.commandLine.appendSwitch('force-color-profile', 'srgb');

process.on('uncaughtException', (error) => {
  logger.error('[CrashGuard] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  logger.error('[CrashGuard] Unhandled rejection:', reason);
});

app.on('web-contents-created', (_event, webContents) => {
  webContents.on('did-finish-load', () => {
    rendererRecoveryAttempts.delete(webContents.id);
  });
  webContents.on('destroyed', () => {
    rendererRecoveryAttempts.delete(webContents.id);
  });
});

app.on('render-process-gone', (_event, webContents, details) => {
  logger.error('[CrashGuard] Renderer process gone:', details);

  if (details.reason === 'clean-exit') {
    return;
  }

  const mainWindow = BrowserWindow.fromWebContents(webContents);
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const attempts = rendererRecoveryAttempts.get(webContents.id) ?? 0;
  if (attempts >= 1) {
    if (rendererRelaunchCount >= 1) {
      logger.error('[CrashGuard] Renderer crashed repeatedly, relaunch skipped to avoid loop');
      return;
    }
    const relaunchArgs = process.argv
      .slice(1)
      .filter((arg) => !arg.startsWith(RENDERER_RELAUNCH_ARG_PREFIX));
    relaunchArgs.push(`${RENDERER_RELAUNCH_ARG_PREFIX}${rendererRelaunchCount + 1}`);
    logger.error('[CrashGuard] Renderer crashed repeatedly, relaunching app once');
    app.relaunch({ args: relaunchArgs });
    app.exit(1);
    return;
  }

  rendererRecoveryAttempts.set(webContents.id, attempts + 1);
  try {
    mainWindow.webContents.reloadIgnoringCache();
  } catch (error) {
    logger.error('[CrashGuard] Failed to reload crashed renderer:', error);
  }
});

app.on('child-process-gone', (_event, details) => {
  logger.error('[CrashGuard] Child process gone:', details);
});

// single instance enforcement
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  logger.info('[SingleInstance] Another instance is already running, quitting...');
  app.quit();
} else {
  // restore on second launch attempt
  app.on('second-instance', () => {
    logger.info('[SingleInstance] Second instance attempted to start');
    const mainWindow = getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

setupFileTasksProgressHandler(getActiveFolderSizeCalculations(), getActiveChecksumCalculations());

setupZoomHandlers();
setupFileAnalysisHandlers();
setupSystemHandlers(loadSettings, saveSettings);
setupSettingsHandlers(createTray);
setupHomeSettingsHandlers();
setupUndoRedoHandlers();
setupWindowHandlers();
setupFileOperationHandlers();
setupElevatedOperationHandlers();
setupSearchHandlers();
setupArchiveHandlers();
setupUpdateHandlers(loadSettings);
setupThumbnailCacheHandlers();

app.whenReady().then(async () => {
  initializeLogger();
  setupApplicationMenu();

  checkMsiInstallation();
  warmupDrivesCache();

  const settingsPromise = loadSettings();

  // detect startup mode
  let shouldStartHidden = process.argv.includes('--hidden');
  setShouldStartHidden(shouldStartHidden);

  const startupSettings = await settingsPromise;

  // ms store auto-start detection
  if (!shouldStartHidden && process.windowsStore) {
    try {
      const loginItemSettings = app.getLoginItemSettings();
      logger.info('[Startup] MS Store login item settings:', JSON.stringify(loginItemSettings));
      if (loginItemSettings.wasOpenedAtLogin && startupSettings.startOnLogin) {
        shouldStartHidden = true;
        setShouldStartHidden(shouldStartHidden);
        logger.info('[Startup] MS Store: Detected wasOpenedAtLogin, will start hidden');
      }
    } catch (error) {
      logger.error('[Startup] Error checking MS Store login settings:', error);
    }
  }

  if (!shouldStartHidden && process.platform === 'darwin') {
    try {
      const loginItemSettings = app.getLoginItemSettings();
      logger.info('[Startup] macOS login item settings:', JSON.stringify(loginItemSettings));
      if (loginItemSettings.wasOpenedAtLogin && startupSettings.startOnLogin) {
        shouldStartHidden = true;
        setShouldStartHidden(shouldStartHidden);
        logger.info('[Startup] macOS: Detected wasOpenedAtLogin, will start hidden');
      }
    } catch (error) {
      logger.error('[Startup] Error checking login item settings:', error);
    }
  }

  if (shouldStartHidden && !(startupSettings.minimizeToTray || startupSettings.startOnLogin)) {
    logger.info('[Startup] --hidden ignored (tray/login startup disabled)');
    shouldStartHidden = false;
    setShouldStartHidden(false);
  }

  logger.info('[Startup] Starting with hidden mode:', shouldStartHidden);

  if (shouldStartHidden && (startupSettings.minimizeToTray || startupSettings.startOnLogin)) {
    logger.info('[Startup] Creating tray before window for hidden start');
    createTrayForHiddenStart();
  }

  createWindow(true);

  if (!getTray()) {
    createTray();
  }

  const mainWindow = getMainWindow();
  mainWindow?.once('ready-to-show', () => {
    setTimeout(async () => {
      try {
        applyLoginItemSettings(startupSettings);

        // indexer delayed start
        if (startupSettings.enableIndexer) {
          const indexerTasks = getIndexerTasks();
          const baseIndexerDelay = process.platform === 'win32' ? 5000 : 1500;
          const indexerDelay = shouldStartHidden ? baseIndexerDelay + 1000 : baseIndexerDelay;
          const fileIndexer = new FileIndexer(indexerTasks ?? undefined);
          setFileIndexer(fileIndexer);
          setTimeout(() => {
            fileIndexer
              .initialize(startupSettings.enableIndexer)
              .catch((err) => logger.error('[Indexer] Background initialization failed:', err));
          }, indexerDelay);
        }

        setTimeout(() => {
          void initializeAutoUpdater(startupSettings);
        }, 1000);

        if (process.platform === 'darwin') {
          setTimeout(async () => {
            logger.info('[FDA] Running Full Disk Access check');
            const hasAccess = await checkFullDiskAccess();

            if (hasAccess) {
              logger.info('[FDA] Full Disk Access already granted');
              const settings = await loadSettings();
              if (settings.skipFullDiskAccessPrompt) {
                delete settings.skipFullDiskAccessPrompt;
                await saveSettings(settings);
              }
              return;
            }

            const settings = await loadSettings();
            if (!settings.skipFullDiskAccessPrompt) {
              await showFullDiskAccessDialog(loadSettings, saveSettings);
            }
          }, 5000);
        }
      } catch (error) {
        logger.error('[Startup] Background initialization error:', error);
      }
    }, 100);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(false);
    } else {
      const mainWindow = getMainWindow();
      mainWindow?.show();
      mainWindow?.focus();
      if (process.platform === 'darwin') {
        app.dock?.show();
      }
    }
  });

  powerMonitor.on('suspend', () => {
    logger.info('[PowerMonitor] System is going to sleep');
    try {
      const fileIndexer = getFileIndexer();
      if (fileIndexer) {
        logger.info('[PowerMonitor] Pausing indexer before sleep');
        fileIndexer.setEnabled(false);
      }
    } catch (error) {
      logger.error('[PowerMonitor] Error pausing indexer:', error);
    }
  });

  powerMonitor.on('resume', async () => {
    logger.info('[PowerMonitor] System resumed from sleep');
    setTimeout(async () => {
      logger.info('[PowerMonitor] Post-resume initialization');

      try {
        const settings = await loadSettings();
        const fileIndexer = getFileIndexer();
        if (fileIndexer && settings.enableIndexer) {
          logger.info('[PowerMonitor] Re-enabling indexer after resume');
          fileIndexer.setEnabled(true);
        }
      } catch (error) {
        logger.error('[PowerMonitor] Error re-enabling indexer:', error);
      }

      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          if (
            mainWindow.isVisible() &&
            mainWindow.webContents &&
            !mainWindow.webContents.isDestroyed()
          ) {
            mainWindow.webContents.send('system-resumed');
          }
        } catch (error) {
          console.error('[PowerMonitor] Error after resume:', error);
        }
      }
    }, 2000);
  });

  powerMonitor.on('lock-screen', () => {
    logger.info('[PowerMonitor] Screen locked');
  });

  powerMonitor.on('unlock-screen', () => {
    logger.info('[PowerMonitor] Screen unlocked');
  });
});

app.on('before-quit', () => {
  setIsQuitting(true);

  clearUndoRedoStacks();
  stopHiddenFileCacheCleanup();
  stopThumbnailCacheCleanup();
  cleanupArchiveOperations();
  cleanupFileAnalysis();

  const fileTasks = getFileTasks();
  const indexerTasks = getIndexerTasks();
  fileTasks.shutdown().catch((error) => {
    logger.error('[Main] Failed to shutdown file tasks:', error);
  });
  indexerTasks?.shutdown().catch((error) => {
    logger.error('[Main] Failed to shutdown indexer tasks:', error);
  });

  const tray = getTray();
  if (tray) {
    tray.destroy();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
