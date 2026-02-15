import type { Settings } from './types';
import { hexToRgb } from './rendererThemeEditor.js';
import { twemojiImg } from './rendererUtils.js';
import { getById, clearHtml } from './rendererDom.js';

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
  setupHomeSettingsListeners: () => void;
  loadBookmarks: () => void;
  updateUndoRedoState: () => Promise<void>;
  handleUpdateDownloaded: (info: { version: string }) => void;
  refresh: () => void;
  applySettings: (settings: Settings) => void;
  getCurrentSettings: () => Settings;
  setCurrentSettings: (s: Settings) => void;
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
    console.log('Init: Getting platform, store info, and settings...');

    const [platform, mas, flatpak, msStore, appVersion] = await Promise.all([
      window.electronAPI.getPlatform(),
      window.electronAPI.isMas(),
      window.electronAPI.isFlatpak(),
      window.electronAPI.isMsStore(),
      window.electronAPI.getAppVersion(),
    ]);

    await config.loadSettings();
    await config.loadHomeSettings();
    config.renderSidebarQuickAccess();

    config.initTooltipSystem();
    config.initCommandPalette();

    config.setPlatformOS(platform);
    document.body.classList.add(`platform-${platform}`);
    updateVersionDisplays(appVersion);

    const titlebarIcon = document.getElementById('titlebar-icon') as HTMLImageElement;
    if (titlebarIcon) {
      const isBeta = /-(beta|alpha|rc)/i.test(appVersion);
      const iconSrc = isBeta ? '../assets/folder-beta.png' : '../assets/folder.png';
      titlebarIcon.src = iconSrc;
      console.log(`[Init] Version: ${appVersion}, isBeta: ${isBeta}, titlebar icon: ${iconSrc}`);
    }

    window.electronAPI.getSystemAccentColor().then(({ accentColor, isDarkMode }) => {
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
    });

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
      config.setupHomeSettingsListeners();
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
      config.updateUndoRedoState();

      window.electronAPI.getZoomLevel().then((zoomResult) => {
        if (zoomResult.success && zoomResult.zoomLevel) {
          config.setZoomLevel(zoomResult.zoomLevel);
          config.updateZoomDisplay();
        }
      });

      const cleanupUpdateAvailable = window.electronAPI.onUpdateAvailable((info) => {
        console.log('Update available:', info);

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

      const cleanupUpdateDownloaded = window.electronAPI.onUpdateDownloaded((info) => {
        console.log('Update downloaded:', info);
        config.handleUpdateDownloaded(info);
      });
      config.getIpcCleanupFunctions().push(cleanupUpdateDownloaded);

      const cleanupSystemResumed = window.electronAPI.onSystemResumed(() => {
        console.log('[Renderer] System resumed from sleep, refreshing view...');
        config.clearDiskSpaceCache();
        if (config.getCurrentPath()) {
          config.refresh();
        }
        config.loadDrives();
      });
      config.getIpcCleanupFunctions().push(cleanupSystemResumed);

      const cleanupSystemThemeChanged = window.electronAPI.onSystemThemeChanged(
        ({ isDarkMode }) => {
          const settings = config.getCurrentSettings();
          if (settings.useSystemTheme) {
            console.log('[Renderer] System theme changed, isDarkMode:', isDarkMode);
            const newTheme = isDarkMode ? 'default' : 'light';
            settings.theme = newTheme;
            config.applySettings(settings);
          }
        }
      );
      config.getIpcCleanupFunctions().push(cleanupSystemThemeChanged);
    }, 0);

    console.log('Init: Complete');
  }

  return {
    init,
    updateVersionDisplays,
    setFolderTreeVisibility,
    setFolderTreeSpacingMode,
  };
}
