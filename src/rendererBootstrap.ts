import type { Settings } from './types';
import { hexToRgb } from './rendererThemeEditor.js';
import { twemojiImg } from './rendererUtils.js';
import { getById, clearHtml } from './rendererDom.js';
import { ignoreError, setDevMode, devLog } from './shared.js';

type BootstrapConfig = {
  loadSettings: () => Promise<void>;
  loadHomeSettings: () => Promise<void>;
  renderSidebarQuickAccess: () => void;
  initTooltipSystem: () => void;
  initCommandPalette: () => void;
  setupEventListeners: () => void;
  loadDrives: () => void;
  initializeTabs: () => void;
  navigateTo: (path: string) => Promise<void>;
  setupBreadcrumbListeners: () => void;
  setupThemeEditorListeners: () => void;
  setupHomeSettingsListeners: () => () => void;
  loadBookmarks: () => void;
  updateUndoRedoState: () => Promise<void>;
  handleUpdateDownloaded: (info: { version: string }) => void;
  silentCheckAndDownload: () => Promise<void>;
  refresh: (reason?: string) => void;
  applySettings: (settings: Settings) => void;
  getCurrentSettings: () => Settings;
  setCurrentSettings: (s: Settings) => void;
  saveSettings: () => void;
  setPlatformOS: (os: string) => void;
  getIpcCleanupFunctions: () => (() => void)[];
  setZoomLevel: (level: number) => void;
  clearDiskSpaceCache: () => void;
  getCurrentPath: () => string;
  updateZoomDisplay: () => void;
  getFolderTree: () => HTMLElement | null;
  onHomeSettingsChanged: (cb: () => void) => () => void;
  homeViewPath: string;
};

export function createBootstrapController(config: BootstrapConfig) {
  const DIRECTORY_CHANGE_REFRESH_COOLDOWN_MS = 1800;
  let lastDirectoryRefreshAt = 0;

  function normalizePathForWatcher(pathValue: string): string {
    const trimmed = pathValue.trim();
    if (!trimmed) return '';
    const isWindowsPath = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\');
    if (isWindowsPath) {
      const normalized = trimmed.replace(/\//g, '\\');
      return normalized.replace(/\\+$/, '').toLowerCase();
    }
    const normalized = trimmed.replace(/\/+$/, '');
    return normalized || '/';
  }

  function updateVersionDisplays(appVersion: string): void {
    const rawVersion = appVersion.trim();
    const versionTag = rawVersion.startsWith('v') ? rawVersion : `v${rawVersion}`;
    const statusVersion = getById('status-version');
    if (statusVersion) {
      statusVersion.textContent = versionTag;
      statusVersion.setAttribute('title', `Version ${rawVersion}`);
    }
    const aboutVersion = getById('about-version-display');
    if (aboutVersion) {
      aboutVersion.textContent = `Version ${rawVersion}`;
    }
  }

  function setFolderTreeVisibility(enabled: boolean): void {
    const section = getById('folder-tree-section');
    if (section) {
      section.style.display = enabled ? '' : 'none';
    }
    if (!enabled) {
      const folderTree = config.getFolderTree();
      if (folderTree) {
        clearHtml(folderTree);
      }
    }

    const drivesSection = getById('drives-section');
    if (drivesSection) {
      drivesSection.style.display = enabled ? 'none' : '';
    }
  }

  function setFolderTreeSpacingMode(useLegacyTreeSpacing: boolean): void {
    const folderTree = config.getFolderTree();
    if (!folderTree) return;
    if (useLegacyTreeSpacing) {
      folderTree.dataset.treeIndentMode = 'legacy';
    } else {
      delete folderTree.dataset.treeIndentMode;
    }
  }

  async function init() {
    const [platform, mas, flatpak, msStore, appVersion, devMode] = await Promise.all([
      window.tauriAPI.getPlatform().catch(() => 'unknown'),
      window.tauriAPI.isMas().catch(() => false),
      window.tauriAPI.isFlatpak().catch(() => false),
      window.tauriAPI.isMsStore().catch(() => false),
      window.tauriAPI.getAppVersion().catch(() => '0.0.0'),
      window.tauriAPI.isDevMode().catch(() => false),
    ]);

    if (devMode) {
      setDevMode(true);
      devLog('Bootstrap', 'Platform:', platform, 'Version:', appVersion);
    }

    await config.loadSettings();
    devLog('Bootstrap', 'Settings loaded');
    await config.loadHomeSettings();
    devLog('Bootstrap', 'Home settings loaded');
    config.renderSidebarQuickAccess();

    config.initTooltipSystem();
    config.initCommandPalette();

    config.setPlatformOS(platform);
    document.body.classList.add(`platform-${platform}`);
    updateVersionDisplays(appVersion);

    const titlebarIcon = document.getElementById('titlebar-icon') as HTMLImageElement;
    if (titlebarIcon) {
      const isBeta = /-(beta|alpha|rc)/i.test(appVersion);
      const iconSrc = isBeta ? '/folder-beta.png' : '/folder.png';
      titlebarIcon.src = iconSrc;
    }

    window.tauriAPI
      .getSystemAccentColor()
      .then(({ accentColor, isDarkMode }) => {
        const rgb = hexToRgb(accentColor);
        document.documentElement.style.setProperty('--system-accent-color', accentColor);
        document.documentElement.style.setProperty('--system-accent-rgb', rgb);
        if (isDarkMode) {
          document.body.classList.add('system-dark-mode');
        }
        const currentSettings = config.getCurrentSettings();
        if (currentSettings.useSystemTheme) {
          const systemTheme = isDarkMode ? 'default' : 'light';
          if (currentSettings.theme !== systemTheme) {
            currentSettings.theme = systemTheme;
            config.applySettings(currentSettings);
          }
        }
      })
      .catch(ignoreError);

    const currentSettings = config.getCurrentSettings();
    const startupPath =
      currentSettings.startupPath && currentSettings.startupPath.trim() !== ''
        ? currentSettings.startupPath
        : config.homeViewPath;

    config.setupEventListeners();
    config.loadDrives();
    config.initializeTabs();

    await config.navigateTo(startupPath);

    queueMicrotask(() => {
      config.setupBreadcrumbListeners();
      config.setupThemeEditorListeners();
      const cleanupHomeSettingsInternal = config.setupHomeSettingsListeners();
      config.getIpcCleanupFunctions().push(cleanupHomeSettingsInternal);
      config.loadBookmarks();

      const cleanupHomeSettings = config.onHomeSettingsChanged(() => {
        config.renderSidebarQuickAccess();
      });
      config.getIpcCleanupFunctions().push(cleanupHomeSettings);
    });

    const isStoreVersion = mas || flatpak || msStore;

    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => {
        if (isStoreVersion) {
          const updateBtn = document.getElementById('check-updates-btn');
          if (updateBtn) {
            updateBtn.style.display = 'none';
          }

          const autoCheckToggle = document.getElementById('auto-check-updates-toggle');
          if (autoCheckToggle) {
            const settingItem = autoCheckToggle.closest('.setting-item') as HTMLElement;
            if (settingItem) {
              settingItem.style.display = 'none';
            }
          }

          const updatesCards = document.querySelectorAll('.settings-card-header');
          updatesCards.forEach((header) => {
            if (header.textContent === 'Updates') {
              const card = header.closest('.settings-card') as HTMLElement;
              if (card) {
                card.style.display = 'none';
              }
            }
          });
        }

        if (mas || msStore) {
          const settingsCards = document.querySelectorAll('.settings-card-header');
          settingsCards.forEach((header) => {
            if (header.textContent === 'Developer Options') {
              const card = header.closest('.settings-card') as HTMLElement;
              if (card) {
                card.style.display = 'none';
              }
            }
          });
        }
      });
    }

    setTimeout(() => {
      void config.updateUndoRedoState();

      window.tauriAPI
        .getZoomLevel()
        .then((zoomResult) => {
          if (!zoomResult.success) return;
          config.setZoomLevel(zoomResult.zoomLevel);
          config.updateZoomDisplay();
        })
        .catch(ignoreError);

      const cleanupUpdateAvailable = window.tauriAPI.onUpdateAvailable((_info) => {
        const settingsBtn = document.getElementById('settings-btn');
        if (settingsBtn) {
          if (!settingsBtn.querySelector('.notification-badge')) {
            const badge = document.createElement('span');
            badge.className = 'notification-badge';
            badge.textContent = '1';
            settingsBtn.style.position = 'relative';
            settingsBtn.appendChild(badge);
          }
        }

        const checkUpdatesBtn = document.getElementById('check-updates-btn');
        if (checkUpdatesBtn) {
          checkUpdatesBtn.innerHTML = `${twemojiImg(String.fromCodePoint(0x1f389), 'twemoji')} Update Available!`;
          checkUpdatesBtn.classList.add('primary');
        }
      });
      config.getIpcCleanupFunctions().push(cleanupUpdateAvailable);

      const cleanupUpdateDownloaded = window.tauriAPI.onUpdateDownloaded((info) => {
        config.handleUpdateDownloaded(info);
      });
      config.getIpcCleanupFunctions().push(cleanupUpdateDownloaded);

      if (!isStoreVersion && config.getCurrentSettings().autoCheckUpdates) {
        setTimeout(() => void config.silentCheckAndDownload(), 10000);
      }

      const cleanupSystemResumed = window.tauriAPI.onSystemResumed(() => {
        devLog('System', 'system-resumed event received');
        config.clearDiskSpaceCache();
        if (config.getCurrentPath()) {
          config.refresh('system-resumed');
        }
        config.loadDrives();
      });
      config.getIpcCleanupFunctions().push(cleanupSystemResumed);

      const cleanupDirectoryChanged = window.tauriAPI.onDirectoryChanged(
        ({ dirPath, eventKind, eventPaths, eventId }) => {
          devLog('Watcher', 'directory-changed event received', {
            eventId: eventId ?? null,
            eventKind: eventKind ?? 'unknown',
            dirPath,
            eventPaths: Array.isArray(eventPaths) ? eventPaths : [],
          });
          const currentPath = config.getCurrentPath();
          const currentPathKey = currentPath ? normalizePathForWatcher(currentPath) : '';
          const dirPathKey = normalizePathForWatcher(dirPath || '');
          if (!currentPathKey || currentPathKey !== dirPathKey) {
            devLog('Watcher', 'Ignored directory-changed event (path mismatch)', {
              currentPath: currentPath || '',
              eventPath: dirPath || '',
              currentPathKey,
              eventPathKey: dirPathKey,
            });
            return;
          }
          const now = Date.now();
          if (now - lastDirectoryRefreshAt < DIRECTORY_CHANGE_REFRESH_COOLDOWN_MS) {
            devLog('Watcher', 'Ignored directory-changed event (cooldown)', {
              elapsedMs: now - lastDirectoryRefreshAt,
              cooldownMs: DIRECTORY_CHANGE_REFRESH_COOLDOWN_MS,
            });
            return;
          }
          lastDirectoryRefreshAt = now;
          if (currentPath) {
            devLog('Watcher', 'Triggering refresh from directory-changed event', {
              path: currentPath,
            });
            config.refresh('watcher-directory-changed');
          }
        }
      );
      config.getIpcCleanupFunctions().push(cleanupDirectoryChanged);

      const cleanupSystemThemeChanged = window.tauriAPI.onSystemThemeChanged(({ isDarkMode }) => {
        const settings = config.getCurrentSettings();
        if (settings.useSystemTheme) {
          const newTheme = isDarkMode ? 'default' : 'light';
          settings.theme = newTheme;
          config.applySettings(settings);
        }
      });
      config.getIpcCleanupFunctions().push(cleanupSystemThemeChanged);
    }, 0);

    if (platform === 'darwin' && !config.getCurrentSettings().skipFullDiskAccessPrompt) {
      setTimeout(() => {
        void checkFullDiskAccess();
      }, 3000);
    }
  }

  async function checkFullDiskAccess(): Promise<void> {
    try {
      const result = await window.tauriAPI.checkFullDiskAccess();
      if (result.success && result.hasAccess) return;
    } catch {
      return;
    }

    const modal = getById('fda-prompt-modal');
    if (!modal) return;
    modal.style.display = 'flex';

    const openBtn = getById('fda-prompt-open');
    const laterBtn = getById('fda-prompt-later');
    const neverBtn = getById('fda-prompt-never');

    const close = () => {
      modal.style.display = 'none';
    };

    openBtn?.addEventListener(
      'click',
      () => {
        close();
        void window.tauriAPI.requestFullDiskAccess();
      },
      { once: true }
    );

    laterBtn?.addEventListener('click', close, { once: true });

    neverBtn?.addEventListener(
      'click',
      () => {
        close();
        const settings = config.getCurrentSettings();
        settings.skipFullDiskAccessPrompt = true;
        config.setCurrentSettings(settings);
        void config.saveSettings();
      },
      { once: true }
    );
  }

  return {
    init,
    updateVersionDisplays,
    setFolderTreeVisibility,
    setFolderTreeSpacingMode,
  };
}
