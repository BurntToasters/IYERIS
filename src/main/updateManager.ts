import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain, app } from 'electron';
import type { Settings, ApiResponse, UpdateCheckResponse, UpdateInfo } from '../types';
import { getMainWindow, getIsDev } from './appState';
import { isRunningInFlatpak, checkMsiInstallation, isInstalledViaMsi } from './platformUtils';
import { safeSendToWindow, isTrustedIpcEvent } from './ipcUtils';
import { getErrorMessage } from './security';
import { logger } from './logger';

const RELEASES_LATEST_URL = 'https://github.com/BurntToasters/IYERIS/releases/latest';
const GITHUB_RELEASE_API_URL = 'https://api.github.com/repos/BurntToasters/IYERIS/releases/latest';
const GITHUB_API_ACCEPT = 'application/vnd.github+json';
const GITHUB_USER_AGENT = 'IYERIS-Update-Checker';
const UPDATE_CHECK_TIMEOUT_MS = 10000;
const MANUAL_UPDATE_BASE_MESSAGE =
  'IYERIS v2 uses a new Tauri backend and bundle identifier. You must manually download and install the next release.';

type LatestGithubRelease = {
  tag_name?: unknown;
  html_url?: unknown;
  body?: unknown;
  published_at?: unknown;
};

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

function createManualUpdateMessage(currentVersionTag: string, latestVersionTag: string): string {
  return `${MANUAL_UPDATE_BASE_MESSAGE}\n\nCurrent Version: ${currentVersionTag}\nNew Version: ${latestVersionTag}\n\nDownload: ${RELEASES_LATEST_URL}`;
}

function toVersionTag(version: string): string {
  const trimmed = version.trim();
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

async function fetchLatestReleaseFromGithub(): Promise<{
  latestVersion: string;
  releaseUrl: string;
  updateInfo: UpdateInfo;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(GITHUB_RELEASE_API_URL, {
      method: 'GET',
      headers: {
        Accept: GITHUB_API_ACCEPT,
        'User-Agent': GITHUB_USER_AGENT,
      },
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `GitHub latest release lookup failed with status ${response.status} ${response.statusText}`
      );
    }

    const payload = (await response.json()) as LatestGithubRelease;
    const tagName = typeof payload.tag_name === 'string' ? payload.tag_name.trim() : '';
    if (!tagName) {
      throw new Error('GitHub latest release response did not include a tag_name');
    }

    const latestVersion = tagName.replace(/^v/i, '');
    const releaseUrl =
      typeof payload.html_url === 'string' && payload.html_url.trim()
        ? payload.html_url
        : RELEASES_LATEST_URL;

    return {
      latestVersion,
      releaseUrl,
      updateInfo: {
        version: latestVersion,
        releaseDate: typeof payload.published_at === 'string' ? payload.published_at : '',
        releaseNotes: typeof payload.body === 'string' ? payload.body : undefined,
      },
    };
  } catch (error) {
    throw new Error(getErrorMessage(error), { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkReleaseUpdate(currentVersion: string): Promise<{
  hasUpdate: boolean;
  latestVersion: string;
  releaseUrl: string;
  updateInfo: UpdateInfo;
}> {
  const latest = await fetchLatestReleaseFromGithub();
  const hasUpdate = compareVersions(latest.latestVersion, currentVersion) > 0;
  return {
    hasUpdate,
    latestVersion: latest.latestVersion,
    releaseUrl: latest.releaseUrl,
    updateInfo: latest.updateInfo,
  };
}

export async function initializeAutoUpdater(settings: Settings): Promise<void> {
  const isDev = getIsDev();
  const currentVersion = app.getVersion();
  const isMsiInstall = await checkMsiInstallation().catch(() => false);

  if (isRunningInFlatpak()) {
    logger.info('[AutoUpdater] Running in Flatpak - startup update checks disabled');
    return;
  }
  if (process.mas) {
    logger.info('[AutoUpdater] Running in Mac App Store - startup update checks disabled');
    return;
  }
  if (process.windowsStore) {
    logger.info('[AutoUpdater] Running in Microsoft Store - startup update checks disabled');
    return;
  }
  if (isMsiInstall || isInstalledViaMsi()) {
    logger.info('[AutoUpdater] Installed via MSI (enterprise) - startup update checks disabled');
    return;
  }
  if (isDev) {
    logger.info('[AutoUpdater] Development mode - startup update checks disabled');
    return;
  }
  if (settings.autoCheckUpdates === false) {
    logger.info('[AutoUpdater] Auto-check on startup disabled by user');
    return;
  }

  logger.info('[AutoUpdater] Checking latest GitHub release on startup...', currentVersion);
  try {
    const result = await checkReleaseUpdate(currentVersion);
    if (result.hasUpdate) {
      logger.info('[AutoUpdater] New release available:', result.latestVersion);
      safeSendToWindow(getMainWindow(), 'update-available', result.updateInfo);
    } else {
      logger.info('[AutoUpdater] No newer release found');
      safeSendToWindow(getMainWindow(), 'update-not-available', { version: currentVersion });
    }
  } catch (error) {
    logger.error('[AutoUpdater] Startup check failed:', error);
    safeSendToWindow(getMainWindow(), 'update-error', getErrorMessage(error));
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
            currentVersion: toVersionTag(currentVersion),
            latestVersion: toVersionTag(currentVersion),
            [flag]: true,
            [messageKey]: message,
          } as UpdateCheckResponse;
        }
      }

      try {
        const currentVersion = app.getVersion();
        await loadSettings();

        logger.info(
          '[AutoUpdater] Manually checking latest release. Current version:',
          currentVersion
        );

        const result = await checkReleaseUpdate(currentVersion);
        const currentVersionTag = toVersionTag(currentVersion);
        const latestVersionTag = toVersionTag(result.latestVersion);

        logger.info('[AutoUpdater] Update check result:', {
          hasUpdate: result.hasUpdate,
          currentVersion,
          latestVersion: result.latestVersion,
          releaseUrl: result.releaseUrl,
        });

        return {
          success: true,
          hasUpdate: result.hasUpdate,
          updateInfo: result.updateInfo,
          currentVersion: currentVersionTag,
          latestVersion: latestVersionTag,
          releaseUrl: result.releaseUrl,
          requiresManualInstall: result.hasUpdate,
          manualUpdateMessage: result.hasUpdate
            ? createManualUpdateMessage(currentVersionTag, latestVersionTag)
            : undefined,
          isBeta: false,
        };
      } catch (error) {
        logger.error('[AutoUpdater] Check for updates failed:', error);
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  const manualInstallError = `${MANUAL_UPDATE_BASE_MESSAGE} Download it here: ${RELEASES_LATEST_URL}`;

  ipcMain.handle('download-update', async (event: IpcMainInvokeEvent): Promise<ApiResponse> => {
    if (!isTrustedIpcEvent(event, 'download-update')) {
      return { success: false, error: 'Untrusted IPC sender' };
    }
    logger.info('[AutoUpdater] download-update requested but manual install is required');
    return { success: false, error: manualInstallError };
  });

  ipcMain.handle('install-update', async (event: IpcMainInvokeEvent): Promise<ApiResponse> => {
    if (!isTrustedIpcEvent(event, 'install-update')) {
      return { success: false, error: 'Untrusted IPC sender' };
    }
    logger.info('[AutoUpdater] install-update requested but manual install is required');
    return { success: false, error: manualInstallError };
  });
}
