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

export function createUpdateActionsController(deps: UpdateActionsDeps) {
  async function restartAsAdmin(): Promise<void> {
    const confirmed = await deps.showDialog(
      'Restart as Administrator',
      "Restarting the app with elevated permissions can lead to possible damage of your computer/files if you don't know what you're doing.",
      'warning',
      true
    );

    if (confirmed) {
      const result = await window.electronAPI.restartAsAdmin();
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
    const btn = document.getElementById('check-updates-btn') as HTMLButtonElement | null;
    if (!btn) return;

    const originalHTML = btn.innerHTML;
    btn.innerHTML = `${twemojiImg(String.fromCodePoint(0x1f504), 'twemoji')} Checking...`;
    btn.disabled = true;

    try {
      const result = await window.electronAPI.checkForUpdates();

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
          const updateTitle = result.isBeta ? 'Beta Update Available' : 'Update Available';
          const updateMessage = result.isBeta
            ? `[BETA CHANNEL] A new beta build is available!\n\nCurrent Version: ${result.currentVersion}\nNew Version: ${result.latestVersion}\n\nWould you like to download and install the update?`
            : `A new version is available!\n\nCurrent Version: ${result.currentVersion}\nNew Version: ${result.latestVersion}\n\nWould you like to download and install the update?`;

          const confirmed = await deps.showDialog(updateTitle, updateMessage, 'success', true);

          if (confirmed) {
            await downloadAndInstallUpdate();
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
        await deps.showDialog(
          'Update Check Failed',
          `Failed to check for updates: ${result.error}`,
          'error',
          false
        );
      }
    } catch (error) {
      await deps.showDialog(
        'Update Check Failed',
        `An error occurred while checking for updates: ${getErrorMessage(error)}`,
        'error',
        false
      );
    } finally {
      btn.innerHTML = originalHTML;
      btn.disabled = false;
    }
  }

  async function downloadAndInstallUpdate(): Promise<void> {
    const dialogModal = document.getElementById('dialog-modal') as HTMLElement | null;
    const dialogTitle = document.getElementById('dialog-title') as HTMLElement | null;
    const dialogContent = document.getElementById('dialog-content') as HTMLElement | null;
    const dialogIcon = document.getElementById('dialog-icon') as HTMLElement | null;
    const dialogOk = document.getElementById('dialog-ok') as HTMLButtonElement | null;
    const dialogCancel = document.getElementById('dialog-cancel') as HTMLButtonElement | null;

    if (
      !dialogModal ||
      !dialogTitle ||
      !dialogContent ||
      !dialogIcon ||
      !dialogOk ||
      !dialogCancel
    ) {
      await deps.showDialog(
        'Update Error',
        'Update dialog elements were not found.',
        'error',
        false
      );
      return;
    }

    dialogIcon.textContent = '⬇️';
    dialogTitle.textContent = 'Downloading Update';
    dialogContent.textContent = 'Preparing download... 0%';
    dialogOk.style.display = 'none';
    dialogCancel.style.display = 'none';
    dialogModal.style.display = 'flex';
    deps.onModalOpen(dialogModal);

    const cleanupProgress = window.electronAPI.onUpdateDownloadProgress((progress) => {
      const percent = progress.percent.toFixed(1);
      const transferred = deps.formatFileSize(progress.transferred);
      const total = deps.formatFileSize(progress.total);
      const speed = deps.formatFileSize(progress.bytesPerSecond);

      dialogContent.textContent = `Downloading update...\n\n${percent}% (${transferred} / ${total})\nSpeed: ${speed}/s`;
    });

    try {
      const downloadResult = await window.electronAPI.downloadUpdate();
      cleanupProgress();

      if (!downloadResult.success) {
        dialogModal.style.display = 'none';
        deps.onModalClose(dialogModal);
        await deps.showDialog(
          'Download Failed',
          `Failed to download update: ${downloadResult.error}`,
          'error',
          false
        );
        return;
      }

      dialogIcon.innerHTML = twemojiImg(String.fromCodePoint(0x2705), 'twemoji-large');
      dialogTitle.textContent = 'Update Downloaded';
      dialogContent.textContent =
        'The update has been downloaded successfully.\n\nThe application will restart to install the update.';
      dialogOk.style.display = 'block';
      dialogOk.textContent = 'Install & Restart';
      dialogCancel.style.display = 'block';
      dialogCancel.textContent = 'Later';

      const installPromise = new Promise<boolean>((resolve) => {
        const cleanup = () => {
          dialogOk.onclick = null;
          dialogCancel.onclick = null;
        };

        dialogOk.onclick = () => {
          cleanup();
          resolve(true);
        };

        dialogCancel.onclick = () => {
          cleanup();
          resolve(false);
        };
      });

      const shouldInstall = await installPromise;
      dialogModal.style.display = 'none';
      deps.onModalClose(dialogModal);

      if (shouldInstall) {
        await window.electronAPI.installUpdate();
      }
    } catch (error) {
      cleanupProgress();
      dialogModal.style.display = 'none';
      deps.onModalClose(dialogModal);
      await deps.showDialog(
        'Update Error',
        `An error occurred during the update process: ${getErrorMessage(error)}`,
        'error',
        false
      );
    }
  }

  return {
    restartAsAdmin,
    checkForUpdates,
  };
}
