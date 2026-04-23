import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUpdateActionsController } from '../rendererUpdateActions';

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

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type SetupOptions = {
  omitCheckUpdatesBtn?: boolean;
  omitToggleStatusBtn?: boolean;
  omitStatusEl?: boolean;
};

describe('createUpdateActionsController', () => {
  let originalWindow: unknown;
  let originalDocument: unknown;

  beforeEach(() => {
    originalWindow = (globalThis as { window?: unknown }).window;
    originalDocument = (globalThis as { document?: unknown }).document;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }

    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
  });

  function setup(options: SetupOptions = {}) {
    const checkUpdatesBtn = createMockElement(
      '<img src="/twemoji/1f503.svg" class="twemoji" alt="🔃" draggable="false" /> Check for Updates'
    );
    const toggleStatusBtn = createMockElement(
      '<img src="/twemoji/1f50d.svg" class="twemoji" alt="🔍" draggable="false" /> Show Download Status'
    );
    toggleStatusBtn.hidden = true;
    toggleStatusBtn.setAttribute('aria-expanded', 'false');
    const statusEl = createMockElement();
    statusEl.hidden = true;

    const elements: Record<string, MockElement> = {};
    if (!options.omitCheckUpdatesBtn) {
      elements['check-updates-btn'] = checkUpdatesBtn;
    }
    if (!options.omitToggleStatusBtn) {
      elements['toggle-update-status-btn'] = toggleStatusBtn;
    }
    if (!options.omitStatusEl) {
      elements['update-download-status'] = statusEl;
    }

    (globalThis as { document?: unknown }).document = {
      getElementById: (id: string) => (elements[id] as unknown as HTMLElement | null) ?? null,
    } as Document;

    let progressHandler:
      | ((progress: {
          percent: number;
          bytesPerSecond: number;
          transferred: number;
          total: number;
        }) => void)
      | null = null;

    const checkForUpdates = vi.fn().mockResolvedValue({
      success: true,
      hasUpdate: true,
      isBeta: false,
      currentVersion: 'v1.0.0',
      latestVersion: 'v1.1.0',
    });
    const downloadUpdate = vi.fn().mockResolvedValue({ success: true });
    const installUpdate = vi.fn().mockResolvedValue({ success: true });
    const restartAsAdmin = vi.fn().mockResolvedValue({ success: true });
    const openFile = vi.fn().mockResolvedValue({ success: true });
    const getAppVersion = vi.fn().mockResolvedValue('v2.1.1-beta.2');
    const getSettings = vi.fn().mockResolvedValue({
      success: true,
      settings: { updateChannel: 'beta' },
    });
    const onUpdateDownloadProgress = vi.fn().mockImplementation((callback) => {
      progressHandler = callback;
      return () => {
        progressHandler = null;
      };
    });

    (globalThis as { window?: unknown }).window = {
      tauriAPI: {
        checkForUpdates,
        downloadUpdate,
        installUpdate,
        restartAsAdmin,
        openFile,
        getAppVersion,
        getSettings,
        onUpdateDownloadProgress,
      },
    } as unknown as Window & typeof globalThis;

    const showDialog = vi.fn().mockResolvedValue(true);
    const showToast = vi.fn();
    const formatFileSize = vi.fn((bytes: number) => `${bytes} B`);

    const controller = createUpdateActionsController({
      showDialog,
      showToast,
      formatFileSize,
      onModalOpen: () => {},
      onModalClose: () => {},
    });

    return {
      controller,
      checkForUpdates,
      downloadUpdate,
      installUpdate,
      restartAsAdmin,
      openFile,
      getAppVersion,
      getSettings,
      onUpdateDownloadProgress,
      showDialog,
      showToast,
      checkUpdatesBtn,
      toggleStatusBtn,
      statusEl,
      getProgressHandler: () => progressHandler,
    };
  }

  it('keeps download state on the button after starting background download', async () => {
    const ctx = setup();
    const deferred = createDeferred<{ success: boolean }>();
    ctx.downloadUpdate.mockReturnValueOnce(deferred.promise);

    await ctx.controller.checkForUpdates();

    expect(ctx.checkUpdatesBtn.innerHTML).toContain('Downloading');
    expect(ctx.checkUpdatesBtn.disabled).toBe(false);
    expect(ctx.toggleStatusBtn.hidden).toBe(false);
  });

  it('returns early while already downloading and skips another update check', async () => {
    const ctx = setup();
    const deferred = createDeferred<{ success: boolean }>();
    ctx.downloadUpdate.mockReturnValueOnce(deferred.promise);

    await ctx.controller.checkForUpdates();
    await ctx.controller.checkForUpdates();

    expect(ctx.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(ctx.showToast).toHaveBeenCalledWith(
      'An update is already being downloaded in the background.',
      'Download in Progress',
      'info'
    );
    expect(ctx.statusEl.hidden).toBe(false);
    expect(ctx.toggleStatusBtn.getAttribute('aria-expanded')).toBe('true');
  });

  it('supports show/hide download status with live progress details', async () => {
    const ctx = setup();
    const deferred = createDeferred<{ success: boolean }>();
    ctx.downloadUpdate.mockReturnValueOnce(deferred.promise);

    await ctx.controller.checkForUpdates();

    const progressHandler = ctx.getProgressHandler();
    if (!progressHandler) {
      throw new Error('Missing progress handler');
    }

    progressHandler({
      percent: 42.4,
      bytesPerSecond: 1200,
      transferred: 420,
      total: 1000,
    });

    expect(ctx.statusEl.hidden).toBe(true);
    expect(ctx.toggleStatusBtn.innerHTML).toContain('Show Download Status');

    ctx.toggleStatusBtn.click();
    expect(ctx.statusEl.hidden).toBe(false);
    expect(ctx.statusEl.textContent).toContain('42%');
    expect(ctx.statusEl.textContent).toContain('420 B / 1000 B');
    expect(ctx.statusEl.textContent).toContain('1200 B/s');
    expect(ctx.toggleStatusBtn.getAttribute('aria-expanded')).toBe('true');

    ctx.toggleStatusBtn.click();
    expect(ctx.statusEl.hidden).toBe(true);
    expect(ctx.toggleStatusBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('prompts install when update is downloaded and installs on confirmation', async () => {
    const ctx = setup();

    await ctx.controller.handleUpdateDownloaded({ version: '1.2.3' });

    expect(ctx.checkUpdatesBtn.innerHTML).toContain('Update Ready');
    expect(ctx.checkUpdatesBtn.classList.contains('primary')).toBe(true);
    expect(ctx.showDialog).toHaveBeenCalledWith(
      'Update Ready',
      expect.stringContaining('Update v1.2.3 has been downloaded'),
      'success',
      true
    );
    expect(ctx.installUpdate).toHaveBeenCalledTimes(1);
    expect(ctx.toggleStatusBtn.hidden).toBe(false);
  });

  it('clears terminal download status when settings modal closes', async () => {
    const ctx = setup();

    await ctx.controller.handleUpdateDownloaded({ version: '1.2.3' });
    ctx.toggleStatusBtn.click();
    expect(ctx.statusEl.hidden).toBe(false);

    ctx.controller.handleSettingsModalClosed();

    expect(ctx.statusEl.hidden).toBe(true);
    expect(ctx.statusEl.textContent).toBe('');
    expect(ctx.toggleStatusBtn.hidden).toBe(true);
    expect(ctx.toggleStatusBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('does not clear status while a download is still in progress', async () => {
    const ctx = setup();
    const deferred = createDeferred<{ success: boolean }>();
    ctx.downloadUpdate.mockReturnValueOnce(deferred.promise);

    await ctx.controller.checkForUpdates();
    ctx.toggleStatusBtn.click();
    expect(ctx.statusEl.hidden).toBe(false);

    ctx.controller.handleSettingsModalClosed();

    expect(ctx.toggleStatusBtn.hidden).toBe(false);
    expect(ctx.statusEl.hidden).toBe(false);
  });

  it('returns early if check-updates button is unavailable', async () => {
    const ctx = setup({ omitCheckUpdatesBtn: true });

    await ctx.controller.checkForUpdates();

    expect(ctx.checkForUpdates).not.toHaveBeenCalled();
  });

  it('supports missing status UI controls without throwing', async () => {
    const ctx = setup({ omitToggleStatusBtn: true, omitStatusEl: true });
    const deferred = createDeferred<{ success: boolean }>();
    ctx.downloadUpdate.mockReturnValueOnce(deferred.promise);

    await ctx.controller.checkForUpdates();
    await ctx.controller.checkForUpdates();

    expect(ctx.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(ctx.showToast).toHaveBeenCalledWith(
      'An update is already being downloaded in the background.',
      'Download in Progress',
      'info'
    );
  });

  it('handles restart-as-admin cancellation and failed elevated restart', async () => {
    const ctx = setup();

    ctx.showDialog.mockResolvedValueOnce(false);
    await ctx.controller.restartAsAdmin();
    expect(ctx.restartAsAdmin).not.toHaveBeenCalled();

    ctx.showDialog.mockResolvedValueOnce(true);
    ctx.restartAsAdmin.mockResolvedValueOnce({ success: false });
    await ctx.controller.restartAsAdmin();
    expect(ctx.restartAsAdmin).toHaveBeenCalledTimes(1);
    expect(ctx.showToast).toHaveBeenCalledWith(
      'Failed to restart with admin privileges',
      'Restart Failed',
      'error'
    );
  });

  it('shows store-managed update dialog for flatpak installations', async () => {
    const ctx = setup();
    ctx.checkForUpdates.mockResolvedValueOnce({
      success: true,
      hasUpdate: true,
      isBeta: false,
      currentVersion: 'v1.0.0',
      latestVersion: 'v1.1.0',
      isFlatpak: true,
      flatpakMessage: 'Use flatpak update',
    });

    await ctx.controller.checkForUpdates();

    expect(ctx.showDialog).toHaveBeenCalledWith(
      'Updates via Flatpak',
      expect.stringContaining('Use flatpak update'),
      'info',
      false
    );
    expect(ctx.downloadUpdate).not.toHaveBeenCalled();
  });

  it('handles manual update flow and reports release-page open failures', async () => {
    const ctx = setup();
    ctx.checkForUpdates.mockResolvedValueOnce({
      success: true,
      hasUpdate: true,
      requiresManualInstall: true,
      currentVersion: 'v1.0.0',
      latestVersion: 'v2.0.0',
      releaseUrl: '',
    });
    ctx.showDialog.mockResolvedValueOnce(true);
    ctx.openFile.mockResolvedValueOnce({ success: false, error: 'browser blocked' });

    await ctx.controller.checkForUpdates();

    expect(ctx.showDialog).toHaveBeenCalledWith(
      'Manual Update Required',
      expect.stringContaining('requires a manual install'),
      'warning',
      true
    );
    expect(ctx.openFile).toHaveBeenCalledWith(
      'https://github.com/BurntToasters/IYERIS/releases/latest'
    );
    expect(ctx.showToast).toHaveBeenCalledWith('browser blocked', 'Update Error', 'error');
  });

  it('does not open release page when manual update prompt is declined', async () => {
    const ctx = setup();
    ctx.checkForUpdates.mockResolvedValueOnce({
      success: true,
      hasUpdate: true,
      requiresManualInstall: true,
      manualUpdateMessage: 'Manual install only.',
      currentVersion: 'v1.0.0',
      latestVersion: 'v2.0.0',
      releaseUrl: 'https://example.com/release',
    });
    ctx.showDialog.mockResolvedValueOnce(false);

    await ctx.controller.checkForUpdates();

    expect(ctx.showDialog).toHaveBeenCalledWith(
      'Manual Update Required',
      'Manual install only.',
      'warning',
      true
    );
    expect(ctx.openFile).not.toHaveBeenCalled();
  });

  it('shows no-update dialogs for beta and stable channels', async () => {
    const ctx = setup();
    ctx.checkForUpdates.mockResolvedValueOnce({
      success: true,
      hasUpdate: false,
      isBeta: true,
      currentVersion: 'v2.0.0-beta.1',
    });
    await ctx.controller.checkForUpdates();

    ctx.checkForUpdates.mockResolvedValueOnce({
      success: true,
      hasUpdate: false,
      isBeta: false,
      currentVersion: 'v2.0.0',
    });
    await ctx.controller.checkForUpdates();

    expect(ctx.showDialog).toHaveBeenNthCalledWith(
      1,
      'No Updates Available',
      "You're on the latest beta channel build (v2.0.0-beta.1)!",
      'info',
      false
    );
    expect(ctx.showDialog).toHaveBeenNthCalledWith(
      2,
      'No Updates Available',
      "You're running the latest version (v2.0.0)!",
      'info',
      false
    );
  });

  it('adds beta-manifest hint for likely missing beta manifest errors', async () => {
    const ctx = setup();
    ctx.checkForUpdates.mockResolvedValueOnce({
      success: false,
      error: '404 not found for beta.json',
    });
    ctx.getAppVersion.mockResolvedValueOnce('v3.0.0-beta.4');
    ctx.getSettings.mockResolvedValueOnce({
      success: true,
      settings: { updateChannel: 'auto' },
    });

    await ctx.controller.checkForUpdates();

    expect(ctx.showDialog).toHaveBeenCalledWith(
      'Update Check Failed',
      expect.stringContaining('latest STABLE released was just pushed'),
      'error',
      false
    );
  });

  it('does not add beta-manifest hint when beta metadata lookup fails', async () => {
    const ctx = setup();
    ctx.checkForUpdates.mockResolvedValueOnce({
      success: false,
      error: 'could not fetch a valid release json for beta.json',
    });
    ctx.getSettings.mockRejectedValueOnce(new Error('settings unavailable'));

    await ctx.controller.checkForUpdates();

    const [, dialogMessage] = ctx.showDialog.mock.calls[0];
    expect(dialogMessage).not.toContain('latest STABLE released was just pushed');
  });

  it('handles thrown update-check errors and still appends beta hint when applicable', async () => {
    const ctx = setup();
    ctx.checkForUpdates.mockRejectedValueOnce(
      new Error('Could not fetch a valid release json for beta.json')
    );
    ctx.getAppVersion.mockResolvedValueOnce('v3.0.0-beta.4');
    ctx.getSettings.mockResolvedValueOnce({
      success: true,
      settings: { updateChannel: 'beta' },
    });

    await ctx.controller.checkForUpdates();

    expect(ctx.showDialog).toHaveBeenCalledWith(
      'Update Check Failed',
      expect.stringContaining('An error occurred while checking for updates'),
      'error',
      false
    );
    expect(ctx.showDialog).toHaveBeenCalledWith(
      'Update Check Failed',
      expect.stringContaining('latest STABLE released was just pushed'),
      'error',
      false
    );
  });

  it('handles background download failure result and resets button state', async () => {
    const ctx = setup();
    ctx.downloadUpdate.mockResolvedValueOnce({ success: false });

    await ctx.controller.checkForUpdates();
    await flushPromises();

    expect(ctx.showToast).toHaveBeenCalledWith(
      'Failed to download update.',
      'Download Failed',
      'error'
    );
    expect(ctx.checkUpdatesBtn.innerHTML).toContain('Check for Updates');
    expect(ctx.checkUpdatesBtn.classList.contains('primary')).toBe(false);
    expect(ctx.statusEl.hidden).toBe(false);
    expect(ctx.statusEl.textContent).toContain('Download failed');
  });

  it('handles background download thrown errors and resets button state', async () => {
    const ctx = setup();
    ctx.downloadUpdate.mockRejectedValueOnce(new Error('network down'));

    await ctx.controller.checkForUpdates();
    await flushPromises();

    expect(ctx.showToast).toHaveBeenCalledWith('network down', 'Download Failed', 'error');
    expect(ctx.checkUpdatesBtn.innerHTML).toContain('Check for Updates');
    expect(ctx.statusEl.hidden).toBe(false);
    expect(ctx.statusEl.textContent).toContain('network down');
  });

  it('surfaces install-update failure after download completes', async () => {
    const ctx = setup();
    ctx.installUpdate.mockResolvedValueOnce({ success: false });

    await ctx.controller.handleUpdateDownloaded({ version: '9.9.9' });

    expect(ctx.showToast).toHaveBeenCalledWith(
      'Failed to install update. Please try again.',
      'Update Install Failed',
      'error'
    );
    expect(ctx.checkUpdatesBtn.innerHTML).toContain('Check for Updates');
  });

  it('silent check respects guards and starts background download only when eligible', async () => {
    const ctx = setup();
    const deferred = createDeferred<{ success: boolean }>();
    ctx.downloadUpdate.mockReturnValueOnce(deferred.promise);

    await ctx.controller.checkForUpdates();
    await ctx.controller.silentCheckAndDownload();
    expect(ctx.checkForUpdates).toHaveBeenCalledTimes(1);

    deferred.resolve({ success: true });
    await flushPromises();

    ctx.checkForUpdates.mockResolvedValueOnce({ success: false });
    await ctx.controller.silentCheckAndDownload();
    expect(ctx.downloadUpdate).toHaveBeenCalledTimes(1);

    ctx.checkForUpdates.mockResolvedValueOnce({
      success: true,
      hasUpdate: true,
      isFlatpak: true,
    });
    await ctx.controller.silentCheckAndDownload();
    expect(ctx.downloadUpdate).toHaveBeenCalledTimes(1);

    ctx.checkForUpdates.mockResolvedValueOnce({
      success: true,
      hasUpdate: false,
      isFlatpak: false,
      isMas: false,
      isMsStore: false,
      isMsi: false,
    });
    await ctx.controller.silentCheckAndDownload();
    expect(ctx.downloadUpdate).toHaveBeenCalledTimes(1);

    ctx.checkForUpdates.mockResolvedValueOnce({
      success: true,
      hasUpdate: true,
      latestVersion: 'v5.0.0',
      isFlatpak: false,
      isMas: false,
      isMsStore: false,
      isMsi: false,
    });
    await ctx.controller.silentCheckAndDownload();
    expect(ctx.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(ctx.showToast).toHaveBeenCalledWith(
      'Update v5.0.0 available — downloading in the background...',
      'Update',
      'info'
    );
  });

  it('swallows silent-check exceptions without showing user-facing errors', async () => {
    const ctx = setup();
    ctx.checkForUpdates.mockRejectedValueOnce(new Error('startup check failed'));

    await expect(ctx.controller.silentCheckAndDownload()).resolves.toBeUndefined();
    expect(ctx.showDialog).not.toHaveBeenCalled();
  });
});
