import { ipcMain, app } from 'electron';
import type { Settings, ApiResponse, UpdateCheckResponse } from './types';
import { getMainWindow, getIsDev } from './appState';
import { getAutoUpdater, isRunningInFlatpak, checkMsiInstallation, isInstalledViaMsi } from './platformUtils';
import { safeSendToWindow } from './ipcUtils';
import { getErrorMessage } from './security';

function parseVersion(v: string): { major: number; minor: number; patch: number; prerelease: string[] } {
  const cleaned = v.split('+')[0];
  const match = cleaned.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return { major: 0, minor: 0, patch: 0, prerelease: [] };
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] ? match[4].split('.') : []
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

export function initializeAutoUpdater(settings: Settings): void {
  const isDev = getIsDev();

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
      console.log('[AutoUpdater] Beta channel enabled');
    } else {
      autoUpdater.channel = 'latest';
      autoUpdater.allowPrerelease = false;
      console.log('[AutoUpdater] Stable channel enabled');
    }
    console.log('[AutoUpdater] Current version:', currentVersion, '| Channel setting:', updateChannel);

    if (isRunningInFlatpak()) {
      console.log('[AutoUpdater] Running in Flatpak - auto-updater disabled');
      console.log('[AutoUpdater] Updates should be installed via: flatpak update com.burnttoasters.iyeris');
    } else if (process.mas) {
      console.log('[AutoUpdater] Running in Mac App Store - auto-updater disabled');
    } else if (process.windowsStore) {
      console.log('[AutoUpdater] Running in Microsoft Store - auto-updater disabled');
      console.log('[AutoUpdater] Updates are handled by the Microsoft Store');
    } else if (isInstalledViaMsi()) {
      console.log('[AutoUpdater] Installed via MSI (enterprise) - auto-updater disabled');
      console.log('[AutoUpdater] Updates should be managed by your IT administrator');
    }

    autoUpdater.on('checking-for-update', () => {
      console.log('[AutoUpdater] Checking for update...');
      safeSendToWindow(getMainWindow(), 'update-checking');
    });

    autoUpdater.on('update-available', (info: { version: string }) => {
      console.log('[AutoUpdater] Update available:', info.version);
      const mainWindow = getMainWindow();

      const updateIsBeta = /-(beta|alpha|rc)/i.test(info.version);
      if (useBetaChannel && !updateIsBeta) {
        console.log(`[AutoUpdater] Beta channel ignoring stable release ${info.version}`);
        safeSendToWindow(mainWindow, 'update-not-available', { version: currentVersion });
        return;
      }
      if (!useBetaChannel && updateIsBeta) {
        console.log(`[AutoUpdater] Stable channel ignoring beta release ${info.version}`);
        safeSendToWindow(mainWindow, 'update-not-available', { version: currentVersion });
        return;
      }

      const comparison = compareVersions(info.version, currentVersion);
      if (comparison <= 0) {
        console.log(`[AutoUpdater] Ignoring update ${info.version} - current version ${currentVersion} is newer or equal`);
        safeSendToWindow(mainWindow, 'update-not-available', { version: currentVersion });
        return;
      }

      safeSendToWindow(mainWindow, 'update-available', info);
    });

    autoUpdater.on('update-not-available', (info: { version: string }) => {
      console.log('[AutoUpdater] Update not available. Current version:', info.version);
      safeSendToWindow(getMainWindow(), 'update-not-available', info);
    });

    autoUpdater.on('error', (err: Error) => {
      console.error('[AutoUpdater] Error:', err);
      safeSendToWindow(getMainWindow(), 'update-error', err.message);
    });

    autoUpdater.on('download-progress', (progressObj: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => {
      console.log(`[AutoUpdater] Download progress: ${progressObj.percent.toFixed(2)}%`);
      safeSendToWindow(getMainWindow(), 'update-download-progress', {
        percent: progressObj.percent,
        bytesPerSecond: progressObj.bytesPerSecond,
        transferred: progressObj.transferred,
        total: progressObj.total
      });
    });

    autoUpdater.on('update-downloaded', (info: { version: string }) => {
      console.log('[AutoUpdater] Update downloaded:', info.version);
      safeSendToWindow(getMainWindow(), 'update-downloaded', info);
    });

    if (!isRunningInFlatpak() && !process.mas && !process.windowsStore && !isInstalledViaMsi() && !isDev && settings.autoCheckUpdates !== false) {
      console.log('[AutoUpdater] Checking for updates on startup...');
      autoUpdater.checkForUpdates().catch((err: Error) => {
        console.error('[AutoUpdater] Startup check failed:', err);
      });
    } else if (settings.autoCheckUpdates === false) {
      console.log('[AutoUpdater] Auto-check on startup disabled by user');
    }
  } catch (error) {
    console.error('[AutoUpdater] Setup failed:', error);
  }
}

export function setupUpdateHandlers(loadSettings: () => Promise<Settings>): void {
  ipcMain.handle('check-for-updates', async (): Promise<UpdateCheckResponse> => {
    if (isRunningInFlatpak()) {
      const currentVersion = app.getVersion();
      console.log('[AutoUpdater] Flatpak detected - redirecting to Flatpak update mechanism');
      return {
        success: true,
        hasUpdate: false,
        currentVersion: `v${currentVersion}`,
        latestVersion: `v${currentVersion}`,
        isFlatpak: true,
        flatpakMessage: 'Updates are managed by Flatpak. Run: flatpak update com.burnttoasters.iyeris'
      };
    }

    if (process.mas) {
      const currentVersion = app.getVersion();
      console.log('[AutoUpdater] MAS detected - updates managed by App Store');
      return {
        success: true,
        hasUpdate: false,
        currentVersion: `v${currentVersion}`,
        latestVersion: `v${currentVersion}`,
        isMas: true,
        masMessage: 'Updates are managed by the Mac App Store.'
      };
    }

    if (process.windowsStore) {
      const currentVersion = app.getVersion();
      console.log('[AutoUpdater] Microsoft Store detected - updates managed by Microsoft Store');
      return {
        success: true,
        hasUpdate: false,
        currentVersion: `v${currentVersion}`,
        latestVersion: `v${currentVersion}`,
        isMsStore: true,
        msStoreMessage: 'Updates are managed by the Microsoft Store.'
      };
    }

    if (await checkMsiInstallation()) {
      const currentVersion = app.getVersion();
      console.log('[AutoUpdater] MSI installation detected - auto-updates disabled');
      return {
        success: true,
        hasUpdate: false,
        currentVersion: `v${currentVersion}`,
        latestVersion: `v${currentVersion}`,
        isMsi: true,
        msiMessage: 'This is an enterprise installation. Updates are managed by your IT administrator. To enable auto-updates, uninstall the MSI version and install the regular version from the website.'
      };
    }

    try {
      const autoUpdater = getAutoUpdater();
      const currentVersion = app.getVersion();
      const settings = await loadSettings();
      const updateChannel = settings.updateChannel || 'auto';
      console.log('[AutoUpdater] Manually checking for updates. Current version:', currentVersion, '| Channel:', updateChannel);

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
        console.log(`[AutoUpdater] Beta channel ignoring stable release ${latestVersion}`);
        return {
          success: true,
          hasUpdate: false,
          isBeta: true,
          currentVersion: `v${currentVersion}`,
          latestVersion: `v${currentVersion}`
        };
      }

      if (!preferBeta && updateIsBeta) {
        console.log(`[AutoUpdater] Stable channel ignoring beta release ${latestVersion}`);
        return {
          success: true,
          hasUpdate: false,
          isBeta: false,
          currentVersion: `v${currentVersion}`,
          latestVersion: `v${currentVersion}`
        };
      }

      const comparison = compareVersions(latestVersion, currentVersion);
      const hasUpdate = comparison > 0;

      console.log('[AutoUpdater] Update check result:', {
        hasUpdate,
        currentVersion,
        latestVersion,
        preferBeta,
        updateIsBeta
      });

      return {
        success: true,
        hasUpdate,
        isBeta: preferBeta,
        updateInfo: {
          version: updateInfo.version,
          releaseDate: updateInfo.releaseDate,
          releaseNotes: updateInfo.releaseNotes as string | undefined
        },
        currentVersion: `v${currentVersion}`,
        latestVersion: `v${latestVersion}`,
        releaseUrl: `https://github.com/BurntToasters/IYERIS/releases/tag/v${latestVersion}`
      };
    } catch (error) {
      console.error('[AutoUpdater] Check for updates failed:', error);
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('download-update', async (): Promise<ApiResponse> => {
    try {
      const autoUpdater = getAutoUpdater();
      console.log('[AutoUpdater] Starting update download...');
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error) {
      console.error('[AutoUpdater] Download failed:', error);
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('install-update', async (): Promise<ApiResponse> => {
    try {
      const autoUpdater = getAutoUpdater();
      console.log('[AutoUpdater] Installing update and restarting...');
      autoUpdater.quitAndInstall(false, true);
      return { success: true };
    } catch (error) {
      console.error('[AutoUpdater] Install failed:', error);
      return { success: false, error: getErrorMessage(error) };
    }
  });
}
