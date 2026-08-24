// @vitest-environment jsdom
//
// F1 (composition layer): rendererBootstrap.ts is the app's boot sequence. It had
// no automated coverage at all, so an ordering regression (navigating before
// settings load, forgetting to register an IPC cleanup, dropping a watcher guard)
// would ship silently. These tests drive the real init() against the real
// src/index.html DOM with only the Tauri IPC boundary stubbed.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Settings } from '../types';

const HOME_VIEW_PATH = 'iyeris://home';

/**
 * The shipped index.html is ~180KB; parsing it per test is far too slow under
 * coverage instrumentation. Parse it once into a detached template, then clone
 * that tree for each test, which keeps every test on the real DOM contract.
 */
let bodyTemplate: HTMLTemplateElement | null = null;

function parseRealIndexBodyOnce(): HTMLTemplateElement {
  if (bodyTemplate) return bodyTemplate;
  const html = readFileSync(resolve(process.cwd(), 'src/index.html'), 'utf8');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!body) throw new Error('src/index.html has no <body> element');
  const template = document.createElement('template');
  template.innerHTML = body[1];
  bodyTemplate = template;
  return template;
}

function mountRealIndexBody(): void {
  document.body.replaceChildren(parseRealIndexBodyOnce().content.cloneNode(true));
  document.body.className = '';
}

function installTauriApiStub() {
  const cache = new Map<string, any>();
  const stub = new Proxy({} as any, {
    get(_target, prop: string) {
      if (prop === 'getWindowLabel') return () => 'main';
      if (!cache.has(prop)) {
        cache.set(
          prop,
          prop.startsWith('on') ? vi.fn(() => () => {}) : vi.fn(async () => ({ success: true }))
        );
      }
      return cache.get(prop);
    },
    has: () => true,
  });
  (window as any).tauriAPI = stub;
  stub.getPlatform.mockResolvedValue('linux');
  stub.getAppVersion.mockResolvedValue('3.0.3');
  stub.isDevMode.mockResolvedValue(false);
  stub.isMas.mockResolvedValue(false);
  stub.isFlatpak.mockResolvedValue(false);
  stub.isMsStore.mockResolvedValue(false);
  stub.getSystemAccentColor.mockResolvedValue({ accentColor: '#3366ff', isDarkMode: false });
  stub.getZoomLevel.mockResolvedValue({ success: true, zoomLevel: 1.25 });
  stub.checkFullDiskAccess.mockResolvedValue({ success: true, hasAccess: true });
  return stub;
}

describe('rendererBootstrap boot sequence', () => {
  let api: any;
  let settings: Settings;
  let cleanups: (() => void)[];
  let order: string[];
  let config: any;
  let createBootstrapController: typeof import('../rendererBootstrap').createBootstrapController;

  /** Records call order so boot-ordering invariants can be asserted. */
  function track(name: string, returnValue?: unknown) {
    return vi.fn(() => {
      order.push(name);
      return returnValue;
    });
  }

  let createDefaultSettings: typeof import('../settings').createDefaultSettings;

  beforeAll(async () => {
    parseRealIndexBodyOnce();
    createDefaultSettings = (await import('../settings')).createDefaultSettings;
    createBootstrapController = (await import('../rendererBootstrap')).createBootstrapController;
  }, 120_000);

  beforeEach(() => {
    mountRealIndexBody();
    api = installTauriApiStub();
    order = [];
    cleanups = [];

    settings = createDefaultSettings();
    settings.startupPath = '/startup/dir';
    settings.autoCheckUpdates = false;

    config = {
      loadSettings: track('loadSettings', Promise.resolve()),
      loadHomeSettings: track('loadHomeSettings', Promise.resolve()),
      renderSidebarQuickAccess: track('renderSidebarQuickAccess'),
      initTooltipSystem: track('initTooltipSystem'),
      initCommandPalette: track('initCommandPalette'),
      setupEventListeners: track('setupEventListeners'),
      loadDrives: track('loadDrives'),
      initializeTabs: track('initializeTabs'),
      navigateTo: vi.fn((path: string) => {
        order.push(`navigateTo:${path}`);
        return Promise.resolve();
      }),
      setupBreadcrumbListeners: track('setupBreadcrumbListeners'),
      setupThemeEditorListeners: track('setupThemeEditorListeners'),
      setupHomeSettingsListeners: track('setupHomeSettingsListeners', () => {}),
      loadBookmarks: track('loadBookmarks'),
      updateUndoRedoState: track('updateUndoRedoState', Promise.resolve()),
      handleUpdateDownloaded: track('handleUpdateDownloaded'),
      silentCheckAndDownload: track('silentCheckAndDownload', Promise.resolve()),
      refresh: vi.fn((reason?: string) => {
        order.push(`refresh:${reason ?? ''}`);
      }),
      applySettings: track('applySettings'),
      getCurrentSettings: () => settings,
      setCurrentSettings: (value: Settings) => {
        settings = value;
      },
      saveSettings: track('saveSettings'),
      setPlatformOS: track('setPlatformOS'),
      getIpcCleanupFunctions: () => cleanups,
      setZoomLevel: track('setZoomLevel'),
      clearDiskSpaceCache: track('clearDiskSpaceCache'),
      getCurrentPath: () => '/startup/dir',
      updateZoomDisplay: track('updateZoomDisplay'),
      getFolderTree: () => document.getElementById('folder-tree'),
      onHomeSettingsChanged: track('onHomeSettingsChanged', () => {}),
      homeViewPath: HOME_VIEW_PATH,
      goUp: track('goUp'),
      showToast: vi.fn((message: string, title?: string, type?: string) => {
        order.push(`showToast:${type ?? ''}`);
      }),
    };
  });

  afterEach(() => {
    cleanups.forEach((cleanup) => {
      try {
        cleanup();
      } catch {
        /* not this suite's concern */
      }
    });
    cleanups.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as any).requestIdleCallback;
  });

  /** Runs init() and flushes the deferred setTimeout(0)/microtask work it schedules. */
  async function boot(controller: { init: () => Promise<void> }) {
    vi.useFakeTimers();
    await controller.init();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }

  it('loads settings before it navigates, and wires listeners before loading drives', async () => {
    await boot(createBootstrapController(config));

    const at = (name: string) => order.indexOf(name);
    expect(at('loadSettings')).toBeGreaterThanOrEqual(0);
    expect(at('loadSettings')).toBeLessThan(at('navigateTo:/startup/dir'));
    expect(at('loadHomeSettings')).toBeLessThan(at('navigateTo:/startup/dir'));
    // Settings drive the sidebar/tooltip/palette setup, so they must come after load.
    expect(at('loadSettings')).toBeLessThan(at('renderSidebarQuickAccess'));
    expect(at('initTooltipSystem')).toBeLessThan(at('navigateTo:/startup/dir'));
    expect(at('setupEventListeners')).toBeLessThan(at('loadDrives'));
    expect(at('initializeTabs')).toBeLessThan(at('navigateTo:/startup/dir'));
    // Breadcrumb/theme/bookmark wiring is deferred until after the first render.
    expect(at('navigateTo:/startup/dir')).toBeLessThan(at('setupBreadcrumbListeners'));
    expect(at('navigateTo:/startup/dir')).toBeLessThan(at('loadBookmarks'));
  });

  it('navigates to the configured startup path', async () => {
    await boot(createBootstrapController(config));
    expect(config.navigateTo).toHaveBeenCalledWith('/startup/dir');
  });

  it('falls back to the home view when no startup path is configured', async () => {
    settings.startupPath = '   ';
    await boot(createBootstrapController(config));
    expect(config.navigateTo).toHaveBeenCalledWith(HOME_VIEW_PATH);
  });

  it('publishes the platform to the app and the document body', async () => {
    api.getPlatform.mockResolvedValue('win32');
    await boot(createBootstrapController(config));
    expect(config.setPlatformOS).toHaveBeenCalledWith('win32');
    expect(document.body.classList.contains('platform-win32')).toBe(true);
  });

  it('renders the app version into the status bar and about panel', async () => {
    api.getAppVersion.mockResolvedValue('3.1.0');
    await boot(createBootstrapController(config));
    expect(document.getElementById('status-version')?.textContent).toBe('v3.1.0');
    expect(document.getElementById('status-version')?.getAttribute('title')).toBe('Version 3.1.0');
    expect(document.getElementById('about-version-display')?.textContent).toBe('Version 3.1.0');
  });

  it('swaps the titlebar icon for prerelease builds', async () => {
    api.getAppVersion.mockResolvedValue('3.1.0-beta.2');
    await boot(createBootstrapController(config));
    const icon = document.getElementById('titlebar-icon') as HTMLImageElement;
    expect(icon.src).toContain('folder-beta.png');
  });

  it('applies the zoom level reported by the platform', async () => {
    await boot(createBootstrapController(config));
    expect(config.setZoomLevel).toHaveBeenCalledWith(1.25);
    expect(config.updateZoomDisplay).toHaveBeenCalled();
  });

  it('registers every IPC listener and collects its cleanup', async () => {
    await boot(createBootstrapController(config));
    expect(api.onUpdateAvailable).toHaveBeenCalled();
    expect(api.onUpdateDownloaded).toHaveBeenCalled();
    expect(api.onSystemResumed).toHaveBeenCalled();
    expect(api.onDirectoryChanged).toHaveBeenCalled();
    expect(api.onWatchedDirRemoved).toHaveBeenCalled();
    expect(api.onSystemThemeChanged).toHaveBeenCalled();
    expect(cleanups.length).toBeGreaterThanOrEqual(6);
    expect(cleanups.every((fn) => typeof fn === 'function')).toBe(true);
  });

  it('refreshes when the watcher reports a change to the current directory', async () => {
    await boot(createBootstrapController(config));
    const onDirectoryChanged = api.onDirectoryChanged.mock.calls[0][0];

    onDirectoryChanged({ dirPath: '/startup/dir', eventKind: 'modify', eventPaths: [] });
    expect(config.refresh).toHaveBeenCalledWith('watcher-directory-changed');
  });

  it('ignores watcher events for directories other than the current one', async () => {
    await boot(createBootstrapController(config));
    const onDirectoryChanged = api.onDirectoryChanged.mock.calls[0][0];

    onDirectoryChanged({ dirPath: '/some/other/dir', eventKind: 'modify', eventPaths: [] });
    expect(config.refresh).not.toHaveBeenCalledWith('watcher-directory-changed');
  });

  it('coalesces watcher events with a cooldown instead of refreshing per event', async () => {
    await boot(createBootstrapController(config));
    const onDirectoryChanged = api.onDirectoryChanged.mock.calls[0][0];

    onDirectoryChanged({ dirPath: '/startup/dir' });
    onDirectoryChanged({ dirPath: '/startup/dir' });
    onDirectoryChanged({ dirPath: '/startup/dir' });

    const watcherRefreshes = config.refresh.mock.calls.filter(
      (call: unknown[]) => call[0] === 'watcher-directory-changed'
    );
    expect(watcherRefreshes).toHaveLength(1);
  });

  it('leaves the current folder when the watched directory is deleted', async () => {
    await boot(createBootstrapController(config));
    const onWatchedDirRemoved = api.onWatchedDirRemoved.mock.calls[0][0];

    onWatchedDirRemoved({ dirPath: '/startup' });
    expect(config.showToast).toHaveBeenCalledWith(
      'This folder was deleted.',
      'Folder removed',
      'warning'
    );
    expect(config.goUp).toHaveBeenCalled();
  });

  it('stays put when an unrelated watched directory is deleted', async () => {
    await boot(createBootstrapController(config));
    const onWatchedDirRemoved = api.onWatchedDirRemoved.mock.calls[0][0];

    onWatchedDirRemoved({ dirPath: '/unrelated' });
    expect(config.goUp).not.toHaveBeenCalled();
    expect(config.showToast).not.toHaveBeenCalled();
  });

  it('drops cached disk space and refreshes after the system resumes', async () => {
    await boot(createBootstrapController(config));
    const onSystemResumed = api.onSystemResumed.mock.calls[0][0];

    onSystemResumed({});
    expect(config.clearDiskSpaceCache).toHaveBeenCalled();
    expect(config.refresh).toHaveBeenCalledWith('system-resumed');
  });

  it('follows the OS theme when the system theme flips', async () => {
    settings.useSystemTheme = true;
    settings.theme = 'default';
    await boot(createBootstrapController(config));
    const onSystemThemeChanged = api.onSystemThemeChanged.mock.calls[0][0];

    onSystemThemeChanged({ isDarkMode: false });
    expect(settings.theme).toBe('light');
    expect(config.applySettings).toHaveBeenCalled();
  });

  it('ignores system theme changes when the user picked a theme', async () => {
    settings.useSystemTheme = false;
    settings.theme = 'default';
    await boot(createBootstrapController(config));
    const onSystemThemeChanged = api.onSystemThemeChanged.mock.calls[0][0];

    onSystemThemeChanged({ isDarkMode: false });
    expect(settings.theme).toBe('default');
  });

  it('badges the settings button when an update becomes available', async () => {
    await boot(createBootstrapController(config));
    const onUpdateAvailable = api.onUpdateAvailable.mock.calls[0][0];

    onUpdateAvailable({ version: '9.9.9' });
    const badge = document.querySelector('#settings-btn .notification-badge');
    expect(badge?.textContent).toBe('1');
    expect(document.getElementById('check-updates-btn')?.classList.contains('primary')).toBe(true);

    // Repeat events must not stack badges.
    onUpdateAvailable({ version: '9.9.9' });
    expect(document.querySelectorAll('#settings-btn .notification-badge')).toHaveLength(1);
  });

  it('hides the in-app updater on store builds', async () => {
    api.isMsStore.mockResolvedValue(true);
    (globalThis as any).requestIdleCallback = (cb: () => void) => {
      cb();
      return 1;
    };
    await boot(createBootstrapController(config));
    expect((document.getElementById('check-updates-btn') as HTMLElement).style.display).toBe(
      'none'
    );
  });

  it('keeps the in-app updater on direct-download builds', async () => {
    (globalThis as any).requestIdleCallback = (cb: () => void) => {
      cb();
      return 1;
    };
    await boot(createBootstrapController(config));
    expect((document.getElementById('check-updates-btn') as HTMLElement).style.display).not.toBe(
      'none'
    );
  });

  it('translates shortcut hints to Mac glyphs on darwin', async () => {
    api.getPlatform.mockResolvedValue('darwin');
    await boot(createBootstrapController(config));
    expect(document.getElementById('new-tab-btn')?.title).toContain('⌘T');
    expect(document.getElementById('search-btn')?.title).toContain('⌘F');
  });

  it('prompts for Full Disk Access on darwin when access is missing', async () => {
    api.getPlatform.mockResolvedValue('darwin');
    api.checkFullDiskAccess.mockResolvedValue({ success: true, hasAccess: false });
    settings.skipFullDiskAccessPrompt = false;

    vi.useFakeTimers();
    const controller = createBootstrapController(config);
    await controller.init();
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();

    const modal = document.getElementById('fda-prompt-modal') as HTMLElement;
    expect(modal.style.display).toBe('flex');

    (document.getElementById('fda-prompt-never') as HTMLElement).click();
    expect(modal.style.display).toBe('none');
    expect(settings.skipFullDiskAccessPrompt).toBe(true);
    expect(config.saveSettings).toHaveBeenCalled();
  });

  it('does not prompt for Full Disk Access when the user opted out', async () => {
    api.getPlatform.mockResolvedValue('darwin');
    api.checkFullDiskAccess.mockResolvedValue({ success: true, hasAccess: false });
    settings.skipFullDiskAccessPrompt = true;

    vi.useFakeTimers();
    await createBootstrapController(config).init();
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();

    expect(api.checkFullDiskAccess).not.toHaveBeenCalled();
  });

  it('hands a downloaded update to the renderer', async () => {
    await boot(createBootstrapController(config));
    const onUpdateDownloaded = api.onUpdateDownloaded.mock.calls[0][0];

    onUpdateDownloaded({ version: '9.9.9' });
    expect(config.handleUpdateDownloaded).toHaveBeenCalledWith({ version: '9.9.9' });
  });

  it('adopts the system accent colour and follows the OS theme at boot', async () => {
    settings.useSystemTheme = true;
    settings.theme = 'default';
    api.getSystemAccentColor.mockResolvedValue({ accentColor: '#112233', isDarkMode: false });

    await boot(createBootstrapController(config));

    expect(document.documentElement.style.getPropertyValue('--system-accent-color')).toBe(
      '#112233'
    );
    expect(document.documentElement.style.getPropertyValue('--system-accent-rgb')).not.toBe('');
    expect(settings.theme).toBe('light');
    expect(config.applySettings).toHaveBeenCalled();
  });

  it('keeps the chosen theme when the accent probe reports a matching mode', async () => {
    settings.useSystemTheme = true;
    settings.theme = 'default';
    api.getSystemAccentColor.mockResolvedValue({ accentColor: '#112233', isDarkMode: true });

    await boot(createBootstrapController(config));

    expect(document.body.classList.contains('system-dark-mode')).toBe(true);
    expect(settings.theme).toBe('default');
  });

  it('survives an accent-colour probe failure', async () => {
    api.getSystemAccentColor.mockRejectedValue(new Error('no accent'));
    await expect(boot(createBootstrapController(config))).resolves.toBeUndefined();
    expect(config.navigateTo).toHaveBeenCalledWith('/startup/dir');
  });

  describe('Full Disk Access prompt', () => {
    beforeEach(() => {
      api.getPlatform.mockResolvedValue('darwin');
      api.checkFullDiskAccess.mockResolvedValue({ success: true, hasAccess: false });
      settings.skipFullDiskAccessPrompt = false;
    });

    async function bootAndPrompt() {
      vi.useFakeTimers();
      await createBootstrapController(config).init();
      await vi.advanceTimersByTimeAsync(3000);
      vi.useRealTimers();
      return document.getElementById('fda-prompt-modal') as HTMLElement;
    }

    it('opens system settings and dismisses when the user accepts', async () => {
      const modal = await bootAndPrompt();
      expect(modal.style.display).toBe('flex');

      (document.getElementById('fda-prompt-open') as HTMLElement).click();
      expect(modal.style.display).toBe('none');
      expect(api.requestFullDiskAccess).toHaveBeenCalled();
      expect(settings.skipFullDiskAccessPrompt).toBe(false);
    });

    it('dismisses without persisting anything when the user defers', async () => {
      const modal = await bootAndPrompt();

      (document.getElementById('fda-prompt-later') as HTMLElement).click();
      expect(modal.style.display).toBe('none');
      expect(settings.skipFullDiskAccessPrompt).toBe(false);
      expect(config.saveSettings).not.toHaveBeenCalled();
      expect(api.requestFullDiskAccess).not.toHaveBeenCalled();
    });

    it('stays quiet when the access probe itself fails', async () => {
      api.checkFullDiskAccess.mockRejectedValue(new Error('ipc down'));
      const modal = await bootAndPrompt();
      expect(modal.style.display).not.toBe('flex');
    });

    it('stays quiet when access is already granted', async () => {
      api.checkFullDiskAccess.mockResolvedValue({ success: true, hasAccess: true });
      const modal = await bootAndPrompt();
      expect(modal.style.display).not.toBe('flex');
    });
  });

  describe('foreground flush', () => {
    it('replays a coalesced background refresh when the window regains focus', async () => {
      const activity = await import('../rendererActivityState');
      await boot(createBootstrapController(config));
      config.refresh.mockClear();

      activity.markDirtyRefresh('watcher');
      window.dispatchEvent(new Event('focus'));

      expect(config.refresh).toHaveBeenCalledWith('foreground:watcher');
    });

    it('defers a drive reload requested while backgrounded until focus returns', async () => {
      await boot(createBootstrapController(config));
      const onSystemResumed = api.onSystemResumed.mock.calls[0][0];
      config.loadDrives.mockClear();

      // jsdom reports the document as unfocused, so this resume is a background one.
      onSystemResumed({});
      expect(config.loadDrives).not.toHaveBeenCalled();

      window.dispatchEvent(new Event('focus'));
      expect(config.loadDrives).toHaveBeenCalled();
    });
  });

  it('schedules a silent update check only when auto-check is enabled', async () => {
    settings.autoCheckUpdates = true;
    vi.useFakeTimers();
    await createBootstrapController(config).init();
    await vi.advanceTimersByTimeAsync(0);
    expect(config.silentCheckAndDownload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000);
    expect(config.silentCheckAndDownload).toHaveBeenCalled();
    vi.useRealTimers();
  });

  describe('sidebar section visibility helpers', () => {
    it('shows the folder tree and hides drives when enabled', async () => {
      const controller = createBootstrapController(config);
      controller.setFolderTreeVisibility(true);
      expect((document.getElementById('folder-tree-section') as HTMLElement).style.display).toBe(
        ''
      );
      expect((document.getElementById('drives-section') as HTMLElement).style.display).toBe('none');
    });

    it('clears the tree and restores drives when disabled', async () => {
      const folderTree = document.getElementById('folder-tree')!;
      folderTree.appendChild(document.createElement('div'));
      const controller = createBootstrapController(config);

      controller.setFolderTreeVisibility(false);
      expect((document.getElementById('folder-tree-section') as HTMLElement).style.display).toBe(
        'none'
      );
      expect((document.getElementById('drives-section') as HTMLElement).style.display).toBe('');
      expect(folderTree.childElementCount).toBe(0);
    });

    it('toggles the legacy tree indent mode flag', async () => {
      const controller = createBootstrapController(config);
      const folderTree = document.getElementById('folder-tree')!;

      controller.setFolderTreeSpacingMode(true);
      expect(folderTree.dataset.treeIndentMode).toBe('legacy');

      controller.setFolderTreeSpacingMode(false);
      expect(folderTree.dataset.treeIndentMode).toBeUndefined();
    });
  });
});
