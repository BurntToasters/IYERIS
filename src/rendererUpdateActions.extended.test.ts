import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUpdateActionsController } from './rendererUpdateActions';

const mockCheckForUpdates = vi.hoisted(() => vi.fn());
const mockDownloadUpdate = vi.hoisted(() => vi.fn());
const mockInstallUpdate = vi.hoisted(() => vi.fn());
const mockRestartAsAdmin = vi.hoisted(() => vi.fn());
const mockOnUpdateDownloadProgress = vi.hoisted(() => vi.fn());

type MockElement = {
  innerHTML: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  dataset: Record<string, string>;
  classList: {
    add: (...tokens: string[]) => void;
    remove: (...tokens: string[]) => void;
    contains: (token: string) => boolean;
  };
  addEventListener: (type: string, listener: () => void) => void;
  click: () => void;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
};

function createMockElement(initialInnerHTML = ''): MockElement {
  const classNames = new Set<string>();
  const listeners = new Map<string, Array<() => void>>();
  const attributes = new Map<string, string>();

  return {
    innerHTML: initialInnerHTML,
    textContent: '',
    hidden: false,
    disabled: false,
    dataset: {},
    classList: {
      add: (...tokens: string[]) => {
        tokens.forEach((token) => classNames.add(token));
      },
      remove: (...tokens: string[]) => {
        tokens.forEach((token) => classNames.delete(token));
      },
      contains: (token: string) => classNames.has(token),
    },
    addEventListener: (type: string, listener: () => void) => {
      const typeListeners = listeners.get(type) ?? [];
      typeListeners.push(listener);
      listeners.set(type, typeListeners);
    },
    click: () => {
      const clickListeners = listeners.get('click') ?? [];
      clickListeners.forEach((listener) => listener());
    },
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
    getAttribute: (name: string) => attributes.get(name) ?? null,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('rendererUpdateActions extended coverage', () => {
  let showDialog: ReturnType<typeof vi.fn>;
  let showToast: ReturnType<typeof vi.fn>;
  let formatFileSize: ReturnType<typeof vi.fn>;
  let checkUpdatesBtn: MockElement;
  let toggleStatusBtn: MockElement;
  let statusEl: MockElement;
  let progressHandler:
    | ((progress: {
        percent: number;
        bytesPerSecond: number;
        transferred: number;
        total: number;
      }) => void)
    | null;

  function setup(overrides?: { showDialogReturn?: boolean | Promise<boolean> }) {
    checkUpdatesBtn = createMockElement('Check for Updates');
    toggleStatusBtn = createMockElement('Show Download Status');
    toggleStatusBtn.hidden = true;
    toggleStatusBtn.setAttribute('aria-expanded', 'false');
    statusEl = createMockElement();
    statusEl.hidden = true;

    const elements: Record<string, MockElement> = {
      'check-updates-btn': checkUpdatesBtn,
      'toggle-update-status-btn': toggleStatusBtn,
      'update-download-status': statusEl,
    };

    Object.defineProperty(document, 'getElementById', {
      value: (id: string) => (elements[id] as unknown as HTMLElement | null) ?? null,
      writable: true,
      configurable: true,
    });

    progressHandler = null;
    mockCheckForUpdates.mockReset();
    mockDownloadUpdate.mockReset();
    mockInstallUpdate.mockReset();
    mockRestartAsAdmin.mockReset();
    mockOnUpdateDownloadProgress.mockReset();
    mockOnUpdateDownloadProgress.mockImplementation((cb: typeof progressHandler) => {
      progressHandler = cb;
      return () => {
        progressHandler = null;
      };
    });

    (window as any).electronAPI = {
      checkForUpdates: mockCheckForUpdates,
      downloadUpdate: mockDownloadUpdate,
      installUpdate: mockInstallUpdate,
      restartAsAdmin: mockRestartAsAdmin,
      onUpdateDownloadProgress: mockOnUpdateDownloadProgress,
    };

    showDialog = vi.fn().mockResolvedValue(overrides?.showDialogReturn ?? true);
    showToast = vi.fn();
    formatFileSize = vi.fn((bytes: number) => `${bytes} B`);

    const controller = createUpdateActionsController({
      showDialog,
      showToast,
      formatFileSize,
      onModalOpen: () => {},
      onModalClose: () => {},
    } as any);

    return controller;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('restartAsAdmin', () => {
    it('calls electronAPI.restartAsAdmin when user confirms the dialog', async () => {
      const controller = setup();
      mockRestartAsAdmin.mockResolvedValue({ success: true });

      await controller.restartAsAdmin();

      expect(showDialog).toHaveBeenCalledWith(
        'Restart as Administrator',
        expect.stringContaining('elevated permissions'),
        'warning',
        true
      );
      expect(mockRestartAsAdmin).toHaveBeenCalledTimes(1);
      expect(showToast).not.toHaveBeenCalled();
    });

    it('shows error toast when restartAsAdmin returns failure', async () => {
      const controller = setup();
      mockRestartAsAdmin.mockResolvedValue({ success: false, error: 'Permission denied' });

      await controller.restartAsAdmin();

      expect(mockRestartAsAdmin).toHaveBeenCalledTimes(1);
      expect(showToast).toHaveBeenCalledWith('Permission denied', 'Restart Failed', 'error');
    });

    it('shows fallback error message when restartAsAdmin error is undefined', async () => {
      const controller = setup();
      mockRestartAsAdmin.mockResolvedValue({ success: false });

      await controller.restartAsAdmin();

      expect(showToast).toHaveBeenCalledWith(
        'Failed to restart with admin privileges',
        'Restart Failed',
        'error'
      );
    });

    it('does not call restartAsAdmin when user cancels the dialog', async () => {
      const controller = setup({ showDialogReturn: false });

      await controller.restartAsAdmin();

      expect(showDialog).toHaveBeenCalledTimes(1);
      expect(mockRestartAsAdmin).not.toHaveBeenCalled();
    });
  });

  describe('checkForUpdates store-specific branches', () => {
    it('shows Flatpak dialog when isFlatpak is true', async () => {
      const controller = setup();
      mockCheckForUpdates.mockResolvedValue({
        success: true,
        isFlatpak: true,
        flatpakMessage: 'Run flatpak update',
        currentVersion: 'v2.0.0',
      });

      await controller.checkForUpdates();

      expect(showDialog).toHaveBeenCalledWith(
        'Updates via Flatpak',
        expect.stringContaining('Run flatpak update'),
        'info',
        false
      );

      expect(showToast).not.toHaveBeenCalled();
    });

    it('shows MAS dialog when isMas is true', async () => {
      const controller = setup();
      mockCheckForUpdates.mockResolvedValue({
        success: true,
        isMas: true,
        masMessage: 'Check the Mac App Store',
        currentVersion: 'v2.0.0',
      });

      await controller.checkForUpdates();

      expect(showDialog).toHaveBeenCalledWith(
        'Updates via App Store',
        expect.stringContaining('Check the Mac App Store'),
        'info',
        false
      );
    });

    it('shows MS Store dialog when isMsStore is true', async () => {
      const controller = setup();
      mockCheckForUpdates.mockResolvedValue({
        success: true,
        isMsStore: true,
        msStoreMessage: 'Check the Microsoft Store',
        currentVersion: 'v2.0.0',
      });

      await controller.checkForUpdates();

      expect(showDialog).toHaveBeenCalledWith(
        'Updates via Microsoft Store',
        expect.stringContaining('Check the Microsoft Store'),
        'info',
        false
      );
    });

    it('shows MSI dialog when isMsi is true', async () => {
      const controller = setup();
      mockCheckForUpdates.mockResolvedValue({
        success: true,
        isMsi: true,
        msiMessage: 'Contact your administrator',
        currentVersion: 'v2.0.0',
      });

      await controller.checkForUpdates();

      expect(showDialog).toHaveBeenCalledWith(
        'Enterprise Installation',
        expect.stringContaining('Contact your administrator'),
        'info',
        false
      );
    });

    it('button is re-enabled and innerHTML restored after store dialog', async () => {
      const controller = setup();
      mockCheckForUpdates.mockResolvedValue({
        success: true,
        isFlatpak: true,
        flatpakMessage: 'Run flatpak update',
        currentVersion: 'v2.0.0',
      });

      const originalHTML = checkUpdatesBtn.innerHTML;
      await controller.checkForUpdates();

      expect(checkUpdatesBtn.disabled).toBe(false);

      expect(checkUpdatesBtn.innerHTML).toBe(originalHTML);
    });
  });

  describe('checkForUpdates when result.success is false', () => {
    it('shows error dialog with the returned error message', async () => {
      const controller = setup();
      mockCheckForUpdates.mockResolvedValue({
        success: false,
        error: 'Network timeout',
      });

      await controller.checkForUpdates();

      expect(showDialog).toHaveBeenCalledWith(
        'Update Check Failed',
        'Failed to check for updates: Network timeout',
        'error',
        false
      );
      expect(checkUpdatesBtn.disabled).toBe(false);
    });
  });

  describe('checkForUpdates exception catch', () => {
    it('shows error dialog when checkForUpdates throws', async () => {
      const controller = setup();
      mockCheckForUpdates.mockRejectedValue(new Error('Connection refused'));

      await controller.checkForUpdates();

      expect(showDialog).toHaveBeenCalledWith(
        'Update Check Failed',
        expect.stringContaining('Connection refused'),
        'error',
        false
      );
      expect(checkUpdatesBtn.disabled).toBe(false);
    });

    it('handles non-Error exceptions in the catch block', async () => {
      const controller = setup();
      mockCheckForUpdates.mockRejectedValue('string error');

      await controller.checkForUpdates();

      expect(showDialog).toHaveBeenCalledWith(
        'Update Check Failed',
        expect.stringContaining('string error'),
        'error',
        false
      );
    });
  });

  describe('startBackgroundDownload download failure (.then path)', () => {
    it('shows error toast and resets button when downloadUpdate resolves with failure', async () => {
      const controller = setup();
      mockCheckForUpdates.mockResolvedValue({
        success: true,
        hasUpdate: true,
        isBeta: false,
        currentVersion: 'v1.0.0',
        latestVersion: 'v1.1.0',
      });
      mockDownloadUpdate.mockResolvedValue({
        success: false,
        error: 'Hash mismatch',
      });

      await controller.checkForUpdates();

      await vi.waitFor(() => {
        expect(showToast).toHaveBeenCalledWith('Hash mismatch', 'Download Failed', 'error');
      });

      expect(checkUpdatesBtn.innerHTML).toContain('Check for Updates');
      expect(checkUpdatesBtn.classList.contains('primary')).toBe(false);
      expect(statusEl.textContent).toContain('Download failed: Hash mismatch');
    });

    it('uses fallback error message when downloadUpdate error is undefined', async () => {
      const controller = setup();
      mockCheckForUpdates.mockResolvedValue({
        success: true,
        hasUpdate: true,
        isBeta: false,
        currentVersion: 'v1.0.0',
        latestVersion: 'v1.1.0',
      });
      mockDownloadUpdate.mockResolvedValue({ success: false });

      await controller.checkForUpdates();
      await vi.waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(
          'Failed to download update.',
          'Download Failed',
          'error'
        );
      });
    });
  });

  describe('startBackgroundDownload download failure (.catch path)', () => {
    it('shows error toast and resets button when downloadUpdate rejects', async () => {
      const controller = setup();
      mockCheckForUpdates.mockResolvedValue({
        success: true,
        hasUpdate: true,
        isBeta: false,
        currentVersion: 'v1.0.0',
        latestVersion: 'v1.1.0',
      });
      mockDownloadUpdate.mockRejectedValue(new Error('Network failure'));

      await controller.checkForUpdates();
      await vi.waitFor(() => {
        expect(showToast).toHaveBeenCalledWith('Network failure', 'Download Failed', 'error');
      });

      expect(checkUpdatesBtn.innerHTML).toContain('Check for Updates');
      expect(checkUpdatesBtn.classList.contains('primary')).toBe(false);
    });
  });

  describe('handleUpdateDownloaded when user declines restart', () => {
    it('does not call installUpdate when user cancels', async () => {
      const controller = setup({ showDialogReturn: false });

      await controller.handleUpdateDownloaded({ version: '2.0.0' });

      expect(showDialog).toHaveBeenCalledWith(
        'Update Ready',
        expect.stringContaining('Update v2.0.0 has been downloaded'),
        'success',
        true
      );
      expect(mockInstallUpdate).not.toHaveBeenCalled();

      expect(checkUpdatesBtn.innerHTML).toContain('Update Ready');
      expect(checkUpdatesBtn.classList.contains('primary')).toBe(true);
    });
  });

  describe('setCheckUpdatesButtonDefault', () => {
    it('resets button text, removes primary class, and enables button after download failure', async () => {
      const controller = setup();
      mockCheckForUpdates.mockResolvedValue({
        success: true,
        hasUpdate: true,
        isBeta: false,
        currentVersion: 'v1.0.0',
        latestVersion: 'v1.1.0',
      });
      mockDownloadUpdate.mockRejectedValue(new Error('Disk full'));

      await controller.checkForUpdates();
      await vi.waitFor(() => {
        expect(showToast).toHaveBeenCalled();
      });

      expect(checkUpdatesBtn.innerHTML).toContain('Check for Updates');
      expect(checkUpdatesBtn.classList.contains('primary')).toBe(false);
      expect(checkUpdatesBtn.disabled).toBe(false);
    });
  });

  describe('beta-specific no-update messages', () => {
    it('shows beta-specific no-update dialog when isBeta and no update available', async () => {
      const controller = setup();
      mockCheckForUpdates.mockResolvedValue({
        success: true,
        hasUpdate: false,
        isBeta: true,
        currentVersion: 'v3.0.0-beta.1',
      });

      await controller.checkForUpdates();

      expect(showDialog).toHaveBeenCalledWith(
        'No Updates Available',
        expect.stringContaining('latest beta channel build'),
        'info',
        false
      );
    });

    it('shows standard no-update dialog when not beta and no update available', async () => {
      const controller = setup();
      mockCheckForUpdates.mockResolvedValue({
        success: true,
        hasUpdate: false,
        isBeta: false,
        currentVersion: 'v3.0.0',
      });

      await controller.checkForUpdates();

      expect(showDialog).toHaveBeenCalledWith(
        'No Updates Available',
        expect.stringContaining('latest version (v3.0.0)'),
        'info',
        false
      );
    });

    it('shows beta update title and message when isBeta and hasUpdate', async () => {
      const controller = setup();
      const deferred = createDeferred<{ success: boolean }>();
      mockDownloadUpdate.mockReturnValue(deferred.promise);
      mockCheckForUpdates.mockResolvedValue({
        success: true,
        hasUpdate: true,
        isBeta: true,
        currentVersion: 'v3.0.0-beta.1',
        latestVersion: 'v3.0.0-beta.2',
      });

      await controller.checkForUpdates();

      expect(showDialog).toHaveBeenCalledWith(
        'Beta Update Available',
        expect.stringContaining('[BETA CHANNEL]'),
        'success',
        true
      );
    });
  });

  describe('checkForUpdates when button is missing from DOM', () => {
    it('returns early when check-updates-btn does not exist', async () => {
      const controller = setup();

      Object.defineProperty(document, 'getElementById', {
        value: () => null,
        writable: true,
        configurable: true,
      });

      await controller.checkForUpdates();

      expect(mockCheckForUpdates).not.toHaveBeenCalled();
      expect(showDialog).not.toHaveBeenCalled();
    });
  });

  describe('checkForUpdates when user declines the download', () => {
    it('restores original button HTML when user cancels the download prompt', async () => {
      const controller = setup({ showDialogReturn: false });
      mockCheckForUpdates.mockResolvedValue({
        success: true,
        hasUpdate: true,
        isBeta: false,
        currentVersion: 'v1.0.0',
        latestVersion: 'v1.1.0',
      });

      const originalHTML = checkUpdatesBtn.innerHTML;
      await controller.checkForUpdates();

      expect(showDialog).toHaveBeenCalledTimes(1);
      expect(mockDownloadUpdate).not.toHaveBeenCalled();
      expect(checkUpdatesBtn.disabled).toBe(false);
      expect(checkUpdatesBtn.innerHTML).toBe(originalHTML);
    });
  });
});
