import { getErrorMessage } from './shared.js';
import { twemojiImg } from './rendererUtils.js';

type DialogVariant = 'warning' | 'info' | 'success' | 'error';
type ShowDialog = (
  title: string,
  message: string,
  variant: DialogVariant,
  confirm?: boolean
) => Promise<boolean>;
type ShowToast = (
  message: string,
  title: string,
  type: 'success' | 'error' | 'info' | 'warning'
) => void;

type UpdateActionsDeps = {
  showDialog: ShowDialog;
  showToast: ShowToast;
  formatFileSize: (bytes: number) => string;
  onModalOpen: (modal: HTMLElement) => void;
  onModalClose: (modal: HTMLElement) => void;
};

const RELEASES_LATEST_URL = 'https://github.com/BurntToasters/IYERIS/releases/latest';
const BETA_CHANNEL_NO_MANIFEST_HINT =
  "This is most likely due to the latest STABLE release being fairly new and the next beta hasn't been released yet.";
const BETA_VERSION_REGEX = /-(beta|alpha|rc)/i;
const NOT_FOUND_REGEX = /\b404\b|not\s+found/i;

export function createUpdateActionsController(deps: UpdateActionsDeps) {
  let isDownloading = false;
  let progressCleanup: (() => void) | null = null;
  let downloadStatusVisible = false;
  let latestDownloadStatus = '';

  function getCheckUpdatesButton(): HTMLButtonElement | null {
    return document.getElementById('check-updates-btn') as HTMLButtonElement | null;
  }

  function getStatusToggleButton(): HTMLButtonElement | null {
    return document.getElementById('toggle-update-status-btn') as HTMLButtonElement | null;
  }

  function getDownloadStatusElement(): HTMLElement | null {
    return document.getElementById('update-download-status');
  }

  function stopProgressListener(): void {
    if (!progressCleanup) return;
    progressCleanup();
    progressCleanup = null;
  }

  function setDownloadStatus(message: string): void {
    latestDownloadStatus = message;
    const statusEl = getDownloadStatusElement();
    if (statusEl && downloadStatusVisible) {
      statusEl.textContent = message;
    }
  }

  function updateStatusToggleButtonLabel(): void {
    const toggleBtn = getStatusToggleButton();
    if (!toggleBtn) return;

    const icon = downloadStatusVisible ? 0x1f441 : 0x1f50d;
    const label = downloadStatusVisible ? 'Hide Download Status' : 'Show Download Status';
    toggleBtn.innerHTML = `${twemojiImg(String.fromCodePoint(icon), 'twemoji')} ${label}`;
    toggleBtn.setAttribute('aria-expanded', String(downloadStatusVisible));
  }

  function setDownloadStatusVisibility(visible: boolean): void {
    downloadStatusVisible = visible;
    const statusEl = getDownloadStatusElement();
    if (statusEl) {
      statusEl.hidden = !visible;
      statusEl.textContent = visible ? latestDownloadStatus : '';
    }
    updateStatusToggleButtonLabel();
  }

  function ensureStatusToggleBound(): void {
    const toggleBtn = getStatusToggleButton();
    if (!toggleBtn || toggleBtn.dataset.bound === 'true') return;

    toggleBtn.dataset.bound = 'true';
    toggleBtn.addEventListener('click', () => {
      setDownloadStatusVisibility(!downloadStatusVisible);
    });
  }

  function showDownloadStatusControls(): void {
    ensureStatusToggleBound();
    const toggleBtn = getStatusToggleButton();
    if (!toggleBtn) return;
    toggleBtn.hidden = false;
    updateStatusToggleButtonLabel();
  }

  function setCheckUpdatesButtonDefault(): void {
    const checkUpdatesBtn = getCheckUpdatesButton();
    if (!checkUpdatesBtn) return;
    checkUpdatesBtn.innerHTML = `${twemojiImg(String.fromCodePoint(0x1f504), 'twemoji')} Check for Updates`;
    checkUpdatesBtn.classList.remove('primary');
    checkUpdatesBtn.disabled = false;
  }

  function clearDownloadStatusUi(): void {
    latestDownloadStatus = '';
    setDownloadStatusVisibility(false);
    const toggleBtn = getStatusToggleButton();
    if (toggleBtn) {
      toggleBtn.hidden = true;
    }
  }

  function isLikelyMissingBetaManifest(errorMessage: string): boolean {
    const normalized = errorMessage.toLowerCase();
    const mentionsBetaTarget =
      normalized.includes('beta.json') ||
      normalized.includes('-beta') ||
      normalized.includes('/beta') ||
      normalized.includes('\\beta');
    return mentionsBetaTarget && NOT_FOUND_REGEX.test(normalized);
  }

  async function shouldShowMissingBetaManifestHint(errorMessage: string): Promise<boolean> {
    if (!isLikelyMissingBetaManifest(errorMessage)) return false;
    try {
      const [appVersion, settingsResult] = await Promise.all([
        window.tauriAPI.getAppVersion(),
        window.tauriAPI.getSettings(),
      ]);
      if (!settingsResult.success) return false;
      const isBetaBuild = BETA_VERSION_REGEX.test(appVersion);
      if (!isBetaBuild) return false;
      const selectedChannel = settingsResult.settings.updateChannel;
      return selectedChannel === 'beta' || (selectedChannel === 'auto' && isBetaBuild);
    } catch {
      return false;
    }
  }

  async function restartAsAdmin(): Promise<void> {
    const confirmed = await deps.showDialog(
      'Restart as Administrator',
      "Restarting the app with elevated permissions can lead to possible damage of your computer/files if you don't know what you're doing.",
      'warning',
      true
    );

    if (confirmed) {
      const result = await window.tauriAPI.restartAsAdmin();
      if (!result.success) {
        deps.showToast(
          result.error || 'Failed to restart with admin privileges',
          'Restart Failed',
          'error'
        );
      }
    }
  }

  async function checkForUpdates(): Promise<void> {
    const btn = getCheckUpdatesButton();
    if (!btn) return;

    if (isDownloading) {
      showDownloadStatusControls();
      setDownloadStatusVisibility(true);
      deps.showToast(
        'An update is already being downloaded in the background.',
        'Download in Progress',
        'info'
      );
      return;
    }

    let startedBackgroundDownload = false;
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `${twemojiImg(String.fromCodePoint(0x1f504), 'twemoji')} Checking...`;
    btn.disabled = true;

    try {
      const result = await window.tauriAPI.checkForUpdates();

      if (result.success) {
        const storeChecks: { flag?: boolean; title: string; msg?: string }[] = [
          {
            flag: result.isFlatpak,
            title: 'Updates via Flatpak',
            msg: `${result.flatpakMessage}\n\nOr use your system's software center to check for updates.`,
          },
          { flag: result.isMas, title: 'Updates via App Store', msg: result.masMessage },
          {
            flag: result.isMsStore,
            title: 'Updates via Microsoft Store',
            msg: result.msStoreMessage,
          },
          { flag: result.isMsi, title: 'Enterprise Installation', msg: result.msiMessage },
        ];
        const storeMatch = storeChecks.find((s) => s.flag);
        if (storeMatch) {
          await deps.showDialog(
            storeMatch.title,
            `You're running IYERIS (${result.currentVersion}).\n\n${storeMatch.msg}`,
            'info',
            false
          );
          return;
        }

        if (result.hasUpdate) {
          if (result.requiresManualInstall) {
            const message =
              result.manualUpdateMessage ||
              `A new version is available, but this upgrade requires a manual install.\n\nCurrent Version: ${result.currentVersion}\nNew Version: ${result.latestVersion}\n\nDownload and install the latest release from GitHub.`;

            const openReleasePage = await deps.showDialog(
              'Manual Update Required',
              message,
              'warning',
              true
            );

            if (openReleasePage) {
              const releaseUrl = result.releaseUrl || RELEASES_LATEST_URL;
              const openResult = await window.tauriAPI.openFile(releaseUrl);
              if (!openResult.success) {
                deps.showToast(
                  openResult.error || 'Failed to open the release page.',
                  'Update Error',
                  'error'
                );
              }
            }
            return;
          }

          const updateTitle = result.isBeta ? 'Beta Update Available' : 'Update Available';
          const updateMessage = result.isBeta
            ? `[BETA CHANNEL] A new beta build is available!\n\nCurrent Version: ${result.currentVersion}\nNew Version: ${result.latestVersion}\n\nWould you like to download the update in the background?`
            : `A new version is available!\n\nCurrent Version: ${result.currentVersion}\nNew Version: ${result.latestVersion}\n\nWould you like to download the update in the background?`;

          const confirmed = await deps.showDialog(updateTitle, updateMessage, 'success', true);

          if (confirmed) {
            startedBackgroundDownload = startBackgroundDownload();
          }
        } else if (result.isBeta) {
          await deps.showDialog(
            'No Updates Available',
            `You're on the latest beta channel build (${result.currentVersion})!`,
            'info',
            false
          );
        } else {
          await deps.showDialog(
            'No Updates Available',
            `You're running the latest version (${result.currentVersion})!`,
            'info',
            false
          );
        }
      } else {
        const showBetaManifestHint = await shouldShowMissingBetaManifestHint(result.error);
        const errorMessage = showBetaManifestHint
          ? `Failed to check for updates: ${result.error}\n\n${BETA_CHANNEL_NO_MANIFEST_HINT}`
          : `Failed to check for updates: ${result.error}`;
        await deps.showDialog('Update Check Failed', errorMessage, 'error', false);
      }
    } catch (error) {
      const message = getErrorMessage(error);
      const showBetaManifestHint = await shouldShowMissingBetaManifestHint(message);
      const dialogMessage = showBetaManifestHint
        ? `An error occurred while checking for updates: ${message}\n\n${BETA_CHANNEL_NO_MANIFEST_HINT}`
        : `An error occurred while checking for updates: ${message}`;
      await deps.showDialog('Update Check Failed', dialogMessage, 'error', false);
    } finally {
      btn.disabled = false;
      if (!startedBackgroundDownload) {
        btn.innerHTML = originalHTML;
      }
    }
  }

  function startBackgroundDownload(): boolean {
    if (isDownloading) return false;
    isDownloading = true;
    showDownloadStatusControls();
    setDownloadStatusVisibility(false);
    setDownloadStatus('Preparing download...');

    deps.showToast('Downloading update in the background...', 'Update', 'info');

    const checkUpdatesBtn = getCheckUpdatesButton();
    if (checkUpdatesBtn) {
      checkUpdatesBtn.classList.remove('primary');
      checkUpdatesBtn.disabled = false;
      checkUpdatesBtn.innerHTML = `${twemojiImg(String.fromCodePoint(0x2b07), 'twemoji')} Downloading...`;
    }

    progressCleanup = window.tauriAPI.onUpdateDownloadProgress((progress) => {
      const percent = Math.round(progress.percent);
      const transferred = deps.formatFileSize(progress.transferred);
      const total = deps.formatFileSize(progress.total);
      const speed = deps.formatFileSize(progress.bytesPerSecond);
      setDownloadStatus(
        `Downloading update: ${percent}% (${transferred} / ${total}) at ${speed}/s`
      );
      if (checkUpdatesBtn) {
        checkUpdatesBtn.innerHTML = `${twemojiImg(String.fromCodePoint(0x2b07), 'twemoji')} Downloading ${percent}%`;
      }
    });

    window.tauriAPI
      .downloadUpdate()
      .then((result) => {
        stopProgressListener();
        isDownloading = false;

        if (!result.success) {
          const errorMessage = result.error || 'Failed to download update.';
          setDownloadStatus(`Download failed: ${errorMessage}`);
          setDownloadStatusVisibility(true);
          deps.showToast(errorMessage, 'Download Failed', 'error');
          setCheckUpdatesButtonDefault();
          return;
        }

        setDownloadStatus('Finalizing update package...');
      })
      .catch((error) => {
        stopProgressListener();
        isDownloading = false;
        const errorMessage = getErrorMessage(error);
        setDownloadStatus(`Download failed: ${errorMessage}`);
        setDownloadStatusVisibility(true);
        deps.showToast(errorMessage, 'Download Failed', 'error');
        setCheckUpdatesButtonDefault();
      });
    return true;
  }

  async function handleUpdateDownloaded(info: { version: string }): Promise<void> {
    stopProgressListener();
    isDownloading = false;
    showDownloadStatusControls();
    setDownloadStatus(`Update v${info.version} is downloaded and ready to install.`);

    const checkUpdatesBtn = getCheckUpdatesButton();
    if (checkUpdatesBtn) {
      checkUpdatesBtn.innerHTML = `${twemojiImg(String.fromCodePoint(0x2705), 'twemoji')} Update Ready`;
      checkUpdatesBtn.classList.add('primary');
    }

    const shouldRestart = await deps.showDialog(
      'Update Ready',
      `Update v${info.version} has been downloaded and is ready to install.\n\nWould you like to restart now to apply the update?`,
      'success',
      true
    );

    if (shouldRestart) {
      const installResult = await window.tauriAPI.installUpdate();
      if (!installResult.success) {
        deps.showToast(
          installResult.error || 'Failed to install update. Please try again.',
          'Update Install Failed',
          'error'
        );
        setCheckUpdatesButtonDefault();
      }
    }
  }

  async function silentCheckAndDownload(): Promise<void> {
    if (isDownloading) return;
    try {
      const result = await window.tauriAPI.checkForUpdates();
      if (!result.success) return;
      if (result.isFlatpak || result.isMas || result.isMsStore || result.isMsi) return;
      if (!result.hasUpdate) return;
      deps.showToast(
        `Update ${result.latestVersion} available — downloading in the background...`,
        'Update',
        'info'
      );
      startBackgroundDownload();
    } catch {
      /* silent — don't surface startup update errors to the user */
    }
  }

  function handleSettingsModalClosed(): void {
    if (isDownloading) return;
    clearDownloadStatusUi();
  }

  return {
    restartAsAdmin,
    checkForUpdates,
    silentCheckAndDownload,
    handleUpdateDownloaded,
    handleSettingsModalClosed,
  };
}
