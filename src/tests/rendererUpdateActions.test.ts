import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUpdateActionsController } from './rendererUpdateActions';

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

  function setup() {
    const checkUpdatesBtn = createMockElement(
      '<img src="../assets/twemoji/1f503.svg" class="twemoji" alt="🔃" draggable="false" /> Check for Updates'
    );
    const toggleStatusBtn = createMockElement(
      '<img src="../assets/twemoji/1f50d.svg" class="twemoji" alt="🔍" draggable="false" /> Show Download Status'
    );
    toggleStatusBtn.hidden = true;
    toggleStatusBtn.setAttribute('aria-expanded', 'false');
    const statusEl = createMockElement();
    statusEl.hidden = true;

    const elements: Record<string, MockElement> = {
      'check-updates-btn': checkUpdatesBtn,
      'toggle-update-status-btn': toggleStatusBtn,
      'update-download-status': statusEl,
    };

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
    const onUpdateDownloadProgress = vi.fn().mockImplementation((callback) => {
      progressHandler = callback;
      return () => {
        progressHandler = null;
      };
    });

    (globalThis as { window?: unknown }).window = {
      electronAPI: {
        checkForUpdates,
        downloadUpdate,
        installUpdate,
        restartAsAdmin,
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
});
