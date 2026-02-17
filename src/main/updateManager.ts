import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain, app } from 'electron';
import type { Settings, ApiResponse, UpdateCheckResponse } from '../types';
import { getMainWindow, getIsDev, setIsQuitting } from './appState';
import {
  getAutoUpdater,
  isRunningInFlatpak,
  checkMsiInstallation,
  isInstalledViaMsi,
} from './platformUtils';
import { safeSendToWindow, isTrustedIpcEvent } from './ipcUtils';
import { getErrorMessage } from './security';
import { logger } from './logger';

function parseVersion(v: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
} {
  const cleaned = v.trim().replace(/^v/i, '').split('+')[0];
  const match = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return { major: 0, minor: 0, patch: 0, prerelease: [] };
  const major = parseInt(match[1], 10);
  const minor = match[2] ? parseInt(match[2], 10) : 0;
  const patch = match[3] ? parseInt(match[3], 10) : 0;
  return {
    major: Number.isFinite(major) ? major : 0,
    minor: Number.isFinite(minor) ? minor : 0,
    patch: Number.isFinite(patch) ? patch : 0,
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const aId = a[i];
    const bId = b[i];
    if (aId === undefined) return -1;
    if (bId === undefined) return 1;

    const aNum = /^\d+$/.test(aId) ? parseInt(aId, 10) : null;
    const bNum = /^\d+$/.test(bId) ? parseInt(bId, 10) : null;

    if (aNum !== null && bNum !== null) {
      if (aNum !== bNum) return aNum > bNum ? 1 : -1;
    } else if (aNum !== null) {
      return -1;
    } else if (bNum !== null) {
      return 1;
    } else {
      const cmp = aId.localeCompare(bId);
      if (cmp !== 0) return cmp;
    }
  }

  return 0;
}

export function compareVersions(a: string, b: string): number {
  const vA = parseVersion(a);
  const vB = parseVersion(b);

  if (vA.major !== vB.major) return vA.major > vB.major ? 1 : -1;
  if (vA.minor !== vB.minor) return vA.minor > vB.minor ? 1 : -1;
  if (vA.patch !== vB.patch) return vA.patch > vB.patch ? 1 : -1;

  return comparePrerelease(vA.prerelease, vB.prerelease);
}

export async function initializeAutoUpdater(settings: Settings): Promise<void> {
  const isDev = getIsDev();
  const isMsiInstall = await checkMsiInstallation().catch(() => false);

  try {
    const autoUpdater = getAutoUpdater();
    autoUpdater.logger = console;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    const currentVersion = app.getVersion();
    const isBetaVersion = /-(beta|alpha|rc)/i.test(currentVersion);
    const updateChannel = settings.updateChannel || 'auto';

    let useBetaChannel = false;
    if (updateChannel === 'beta') {
      useBetaChannel = true;
    } else if (updateChannel === 'stable') {
      useBetaChannel = false;
    } else {
      useBetaChannel = process.env.IS_BETA === 'true' || isBetaVersion;
    }

    if (useBetaChannel) {
      autoUpdater.channel = 'beta';
      autoUpdater.allowPrerelease = true;
      logger.info('[AutoUpdater] Beta channel enabled');
    } else {
      autoUpdater.channel = 'latest';
      autoUpdater.allowPrerelease = false;
      logger.info('[AutoUpdater] Stable channel enabled');
    }
    logger.info(
      '[AutoUpdater] Current version:',
      currentVersion,
      '| Channel setting:',
      updateChannel
    );

    if (isRunningInFlatpak()) {
      logger.info('[AutoUpdater] Running in Flatpak - auto-updater disabled');
      logger.info(
        '[AutoUpdater] Updates should be installed via: flatpak update com.burnttoasters.iyeris'
      );
    } else if (process.mas) {
      logger.info('[AutoUpdater] Running in Mac App Store - auto-updater disabled');
    } else if (process.windowsStore) {
      logger.info('[AutoUpdater] Running in Microsoft Store - auto-updater disabled');
      logger.info('[AutoUpdater] Updates are handled by the Microsoft Store');
    } else if (isMsiInstall || isInstalledViaMsi()) {
      logger.info('[AutoUpdater] Installed via MSI (enterprise) - auto-updater disabled');
      logger.info('[AutoUpdater] Updates should be managed by your IT administrator');
    }

    autoUpdater.on('checking-for-update', () => {
      logger.info('[AutoUpdater] Checking for update...');
      safeSendToWindow(getMainWindow(), 'update-checking');
    });

    autoUpdater.on('update-available', (info: { version: string }) => {
      logger.info('[AutoUpdater] Update available:', info.version);
      const mainWindow = getMainWindow();

      const updateIsBeta = /-(beta|alpha|rc)/i.test(info.version);
      if (useBetaChannel && !updateIsBeta) {
        logger.info(`[AutoUpdater] Beta channel ignoring stable release ${info.version}`);
        safeSendToWindow(mainWindow, 'update-not-available', { version: currentVersion });
        return;
      }
      if (!useBetaChannel && updateIsBeta) {
        logger.info(`[AutoUpdater] Stable channel ignoring beta release ${info.version}`);
        safeSendToWindow(mainWindow, 'update-not-available', { version: currentVersion });
        return;
      }

      const comparison = compareVersions(info.version, currentVersion);
      if (comparison <= 0) {
        logger.info(
          `[AutoUpdater] Ignoring update ${info.version} - current version ${currentVersion} is newer or equal`
        );
        safeSendToWindow(mainWindow, 'update-not-available', { version: currentVersion });
        return;
      }

      safeSendToWindow(mainWindow, 'update-available', info);
    });

    autoUpdater.on('update-not-available', (info: { version: string }) => {
      logger.info('[AutoUpdater] Update not available. Current version:', info.version);
      safeSendToWindow(getMainWindow(), 'update-not-available', info);
    });

    autoUpdater.on('error', (err: Error) => {
      logger.error('[AutoUpdater] Error:', err);
      safeSendToWindow(getMainWindow(), 'update-error', err.message);
    });

    autoUpdater.on(
      'download-progress',
      (progressObj: {
        percent: number;
        bytesPerSecond: number;
        transferred: number;
        total: number;
      }) => {
        logger.info(`[AutoUpdater] Download progress: ${progressObj.percent.toFixed(2)}%`);
        safeSendToWindow(getMainWindow(), 'update-download-progress', {
          percent: progressObj.percent,
          bytesPerSecond: progressObj.bytesPerSecond,
          transferred: progressObj.transferred,
          total: progressObj.total,
        });
      }
    );

    autoUpdater.on('update-downloaded', (info: { version: string }) => {
      logger.info('[AutoUpdater] Update downloaded:', info.version);
      safeSendToWindow(getMainWindow(), 'update-downloaded', info);
    });

    const updaterWithBeforeQuit = autoUpdater as unknown as {
      on?: (event: string, listener: () => void) => void;
    };
    if (typeof updaterWithBeforeQuit.on === 'function') {
      updaterWithBeforeQuit.on('before-quit-for-update', () => {
        setIsQuitting(true);
      });
    }

    if (
      !isRunningInFlatpak() &&
      !process.mas &&
      !process.windowsStore &&
      !isMsiInstall &&
      !isDev &&
      settings.autoCheckUpdates !== false
    ) {
      logger.info('[AutoUpdater] Checking for updates on startup...');
      autoUpdater.checkForUpdates().catch((err: Error) => {
        logger.error('[AutoUpdater] Startup check failed:', err);
      });
    } else if (settings.autoCheckUpdates === false) {
      logger.info('[AutoUpdater] Auto-check on startup disabled by user');
    }
  } catch (error) {
    logger.error('[AutoUpdater] Setup failed:', error);
  }
}

export function setupUpdateHandlers(loadSettings: () => Promise<Settings>): void {
  ipcMain.handle(
    'check-for-updates',
    async (event: IpcMainInvokeEvent): Promise<UpdateCheckResponse> => {
      if (!isTrustedIpcEvent(event, 'check-for-updates')) {
        return { success: false, error: 'Untrusted IPC sender' };
      }

      const storeChecks: Array<{
        check: () => boolean | Promise<boolean>;
        flag: string;
        messageKey: string;
        message: string;
        logMsg: string;
      }> = [
        {
          check: () => isRunningInFlatpak(),
          flag: 'isFlatpak',
          messageKey: 'flatpakMessage',
          message: 'Updates are managed by Flatpak. Run: flatpak update com.burnttoasters.iyeris',
          logMsg: 'Flatpak detected - redirecting to Flatpak update mechanism',
        },
        {
          check: () => !!process.mas,
          flag: 'isMas',
          messageKey: 'masMessage',
          message: 'Updates are managed by the Mac App Store.',
          logMsg: 'MAS detected - updates managed by App Store',
        },
        {
          check: () => !!process.windowsStore,
          flag: 'isMsStore',
          messageKey: 'msStoreMessage',
          message: 'Updates are managed by the Microsoft Store.',
          logMsg: 'Microsoft Store detected - updates managed by Microsoft Store',
        },
        {
          check: () => checkMsiInstallation(),
          flag: 'isMsi',
          messageKey: 'msiMessage',
          message:
            'This is an enterprise installation. Updates are managed by your IT administrator. To enable auto-updates, uninstall the MSI version and install the regular version from the website.',
          logMsg: 'MSI installation detected - auto-updates disabled',
        },
      ];

      for (const { check, flag, messageKey, message, logMsg } of storeChecks) {
        const result = await check();
        if (result) {
          const currentVersion = app.getVersion();
          logger.info(`[AutoUpdater] ${logMsg}`);
          return {
            success: true,
            hasUpdate: false,
            currentVersion: `v${currentVersion}`,
            latestVersion: `v${currentVersion}`,
            [flag]: true,
            [messageKey]: message,
          } as UpdateCheckResponse;
        }
      }

      try {
        const autoUpdater = getAutoUpdater();
        const currentVersion = app.getVersion();
        const settings = await loadSettings();
        const updateChannel = settings.updateChannel || 'auto';
        logger.info(
          '[AutoUpdater] Manually checking for updates. Current version:',
          currentVersion,
          '| Channel:',
          updateChannel
        );

        const isBetaVersion = /-(beta|alpha|rc)/i.test(currentVersion);
        let preferBeta = false;
        if (updateChannel === 'beta') {
          preferBeta = true;
        } else if (updateChannel === 'stable') {
          preferBeta = false;
        } else {
          preferBeta = isBetaVersion;
        }

        if (preferBeta) {
          autoUpdater.channel = 'beta';
          autoUpdater.allowPrerelease = true;
        } else {
          autoUpdater.channel = 'latest';
          autoUpdater.allowPrerelease = false;
        }

        const updateCheckResult = await autoUpdater.checkForUpdates();

        if (!updateCheckResult) {
          return { success: false, error: 'Update check returned no result' };
        }

        const updateInfo = updateCheckResult.updateInfo;
        const latestVersion = updateInfo.version;
        const updateIsBeta = /-(beta|alpha|rc)/i.test(latestVersion);

        if (preferBeta && !updateIsBeta) {
          logger.info(`[AutoUpdater] Beta channel ignoring stable release ${latestVersion}`);
          return {
            success: true,
            hasUpdate: false,
            isBeta: true,
            currentVersion: `v${currentVersion}`,
            latestVersion: `v${currentVersion}`,
          };
        }

        if (!preferBeta && updateIsBeta) {
          logger.info(`[AutoUpdater] Stable channel ignoring beta release ${latestVersion}`);
          return {
            success: true,
            hasUpdate: false,
            isBeta: false,
            currentVersion: `v${currentVersion}`,
            latestVersion: `v${currentVersion}`,
          };
        }

        const comparison = compareVersions(latestVersion, currentVersion);
        const hasUpdate = comparison > 0;

        logger.info('[AutoUpdater] Update check result:', {
          hasUpdate,
          currentVersion,
          latestVersion,
          preferBeta,
          updateIsBeta,
        });

        return {
          success: true,
          hasUpdate,
          isBeta: preferBeta,
          updateInfo: {
            version: updateInfo.version,
            releaseDate: updateInfo.releaseDate,
            releaseNotes: updateInfo.releaseNotes as string | undefined,
          },
          currentVersion: `v${currentVersion}`,
          latestVersion: `v${latestVersion}`,
          releaseUrl: `https://github.com/BurntToasters/IYERIS/releases/tag/v${latestVersion}`,
        };
      } catch (error) {
        logger.error('[AutoUpdater] Check for updates failed:', error);
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle('download-update', async (event: IpcMainInvokeEvent): Promise<ApiResponse> => {
    try {
      if (!isTrustedIpcEvent(event, 'download-update')) {
        return { success: false, error: 'Untrusted IPC sender' };
      }
      const autoUpdater = getAutoUpdater();
      logger.info('[AutoUpdater] Starting update download...');
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error) {
      logger.error('[AutoUpdater] Download failed:', error);
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('install-update', async (event: IpcMainInvokeEvent): Promise<ApiResponse> => {
    try {
      if (!isTrustedIpcEvent(event, 'install-update')) {
        return { success: false, error: 'Untrusted IPC sender' };
      }
      const autoUpdater = getAutoUpdater();
      logger.info('[AutoUpdater] Installing update and restarting...');
      setIsQuitting(true);

      app.releaseSingleInstanceLock();
      logger.info('[AutoUpdater] Released single instance lock');

      setTimeout(() => {
        autoUpdater.quitAndInstall(false, true);
      }, 100);

      return { success: true };
    } catch (error) {
      setIsQuitting(false);
      logger.error('[AutoUpdater] Install failed:', error);
      return { success: false, error: getErrorMessage(error) };
    }
  });
}
