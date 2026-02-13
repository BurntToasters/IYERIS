import type { Settings } from './types';

interface SettingsModalDeps {
  getCurrentSettings: () => Settings;
  activateModal: (modal: HTMLElement) => void;
  deactivateModal: (modal: HTMLElement) => void;
  setSuppressSettingsTracking: (value: boolean) => void;
  activateSettingsTab: (tabId: string, skipSearchUpdate?: boolean) => void;
  updateCustomThemeUI: (options?: { syncSelect?: boolean; selectedTheme?: string }) => void;
  updateDangerousOptionsVisibility: (show: boolean) => void;
  updateIndexStatus: () => Promise<void>;
  updateThumbnailCacheSize: () => Promise<void>;
  syncQuickActionsFromMain: () => void;
  updateSettingsCardSummaries: () => void;
  applySettingsSearch: (term: string) => void;
  clearSettingsChanged: () => void;
  initSettingsChangeTracking: () => void;
  stopIndexStatusPolling: () => void;
  onSettingsModalHide?: () => void;
}

export function createSettingsModalController(deps: SettingsModalDeps) {
  async function showSettingsModal() {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    const settingsModal = document.getElementById('settings-modal');
    deps.setSuppressSettingsTracking(true);

    const tabs = document.querySelectorAll('.settings-tab');
    const sections = document.querySelectorAll('.settings-section');

    tabs.forEach((t) => t.classList.remove('active'));
    sections.forEach((s) => s.classList.remove('active'));

    if (tabs.length > 0) {
      const firstId = tabs[0].getAttribute('data-tab');
      if (firstId) {
        deps.activateSettingsTab(firstId, true);
      } else {
        tabs[0].classList.add('active');
        if (sections.length > 0) sections[0].classList.add('active');
      }
    } else if (sections.length > 0) {
      sections[0].classList.add('active');
    }

    const settings = deps.getCurrentSettings();

    const systemThemeToggle = document.getElementById('system-theme-toggle') as HTMLInputElement;
    const sortBySelect = document.getElementById('sort-by-select') as HTMLSelectElement;
    const sortOrderSelect = document.getElementById('sort-order-select') as HTMLSelectElement;
    const showHiddenFilesToggle = document.getElementById(
      'show-hidden-files-toggle'
    ) as HTMLInputElement;
    const enableGitStatusToggle = document.getElementById(
      'enable-git-status-toggle'
    ) as HTMLInputElement;
    const gitIncludeUntrackedToggle = document.getElementById(
      'git-include-untracked-toggle'
    ) as HTMLInputElement;
    const minimizeToTrayToggle = document.getElementById(
      'minimize-to-tray-toggle'
    ) as HTMLInputElement;
    const startOnLoginToggle = document.getElementById('start-on-login-toggle') as HTMLInputElement;
    const autoCheckUpdatesToggle = document.getElementById(
      'auto-check-updates-toggle'
    ) as HTMLInputElement;
    const updateChannelSelect = document.getElementById(
      'update-channel-select'
    ) as HTMLSelectElement;
    const enableSearchHistoryToggle = document.getElementById(
      'enable-search-history-toggle'
    ) as HTMLInputElement;
    const dangerousOptionsToggle = document.getElementById(
      'dangerous-options-toggle'
    ) as HTMLInputElement;
    const startupPathInput = document.getElementById('startup-path-input') as HTMLInputElement;
    const enableIndexerToggle = document.getElementById(
      'enable-indexer-toggle'
    ) as HTMLInputElement;
    const showRecentFilesToggle = document.getElementById(
      'show-recent-files-toggle'
    ) as HTMLInputElement;
    const showFolderTreeToggle = document.getElementById(
      'show-folder-tree-toggle'
    ) as HTMLInputElement;
    const enableTabsToggle = document.getElementById('enable-tabs-toggle') as HTMLInputElement;
    const globalContentSearchToggle = document.getElementById(
      'global-content-search-toggle'
    ) as HTMLInputElement;
    const globalClipboardToggle = document.getElementById(
      'global-clipboard-toggle'
    ) as HTMLInputElement;
    const enableSyntaxHighlightingToggle = document.getElementById(
      'enable-syntax-highlighting-toggle'
    ) as HTMLInputElement;
    const reduceMotionToggle = document.getElementById('reduce-motion-toggle') as HTMLInputElement;
    const highContrastToggle = document.getElementById('high-contrast-toggle') as HTMLInputElement;
    const largeTextToggle = document.getElementById('large-text-toggle') as HTMLInputElement;
    const useSystemFontSizeToggle = document.getElementById(
      'use-system-font-size-toggle'
    ) as HTMLInputElement;
    const uiDensitySelect = document.getElementById('ui-density-select') as HTMLSelectElement;
    const boldTextToggle = document.getElementById('bold-text-toggle') as HTMLInputElement;
    const visibleFocusToggle = document.getElementById('visible-focus-toggle') as HTMLInputElement;
    const reduceTransparencyToggle = document.getElementById(
      'reduce-transparency-toggle'
    ) as HTMLInputElement;
    const liquidGlassToggle = document.getElementById('liquid-glass-toggle') as HTMLInputElement;
    const themedIconsToggle = document.getElementById('themed-icons-toggle') as HTMLInputElement;
    const disableHwAccelToggle = document.getElementById(
      'disable-hw-accel-toggle'
    ) as HTMLInputElement;
    const confirmFileOperationsToggle = document.getElementById(
      'confirm-file-operations-toggle'
    ) as HTMLInputElement;
    const fileConflictBehaviorSelect = document.getElementById(
      'file-conflict-behavior-select'
    ) as HTMLSelectElement;
    const maxThumbnailSizeInput = document.getElementById(
      'max-thumbnail-size-input'
    ) as HTMLInputElement;
    const thumbnailQualitySelect = document.getElementById(
      'thumbnail-quality-select'
    ) as HTMLSelectElement;
    const autoPlayVideosToggle = document.getElementById(
      'auto-play-videos-toggle'
    ) as HTMLInputElement;
    const previewPanelPositionSelect = document.getElementById(
      'preview-panel-position-select'
    ) as HTMLSelectElement;
    const maxPreviewSizeInput = document.getElementById(
      'max-preview-size-input'
    ) as HTMLInputElement;
    const gridColumnsSelect = document.getElementById('grid-columns-select') as HTMLSelectElement;
    const iconSizeSlider = document.getElementById('icon-size-slider') as HTMLInputElement;
    const iconSizeValue = document.getElementById('icon-size-value');
    const compactFileInfoToggle = document.getElementById(
      'compact-file-info-toggle'
    ) as HTMLInputElement;
    const showFileExtensionsToggle = document.getElementById(
      'show-file-extensions-toggle'
    ) as HTMLInputElement;
    const maxSearchHistoryInput = document.getElementById(
      'max-search-history-input'
    ) as HTMLInputElement;
    const maxDirectoryHistoryInput = document.getElementById(
      'max-directory-history-input'
    ) as HTMLInputElement;
    const settingsPath = document.getElementById('settings-path');

    if (systemThemeToggle) {
      systemThemeToggle.checked = settings.useSystemTheme || false;
    }
    if (enableSyntaxHighlightingToggle) {
      enableSyntaxHighlightingToggle.checked = settings.enableSyntaxHighlighting !== false;
    }
    if (enableGitStatusToggle) {
      enableGitStatusToggle.checked = settings.enableGitStatus === true;
    }
    if (gitIncludeUntrackedToggle) {
      gitIncludeUntrackedToggle.checked = settings.gitIncludeUntracked !== false;
    }

    const showFileHoverCardToggle = document.getElementById(
      'show-file-hover-card-toggle'
    ) as HTMLInputElement;
    const showFileCheckboxesToggle = document.getElementById(
      'show-file-checkboxes-toggle'
    ) as HTMLInputElement;

    if (showFileHoverCardToggle) {
      showFileHoverCardToggle.checked = settings.showFileHoverCard !== false;
    }

    if (showFileCheckboxesToggle) {
      showFileCheckboxesToggle.checked = settings.showFileCheckboxes === true;
    }

    deps.updateCustomThemeUI();

    if (sortBySelect) {
      sortBySelect.value = settings.sortBy || 'name';
    }

    if (sortOrderSelect) {
      sortOrderSelect.value = settings.sortOrder || 'asc';
    }

    if (showHiddenFilesToggle) {
      showHiddenFilesToggle.checked = settings.showHiddenFiles || false;
    }

    if (minimizeToTrayToggle) {
      minimizeToTrayToggle.checked = settings.minimizeToTray || false;
    }

    if (startOnLoginToggle) {
      startOnLoginToggle.checked = settings.startOnLogin || false;
    }

    if (autoCheckUpdatesToggle) {
      autoCheckUpdatesToggle.checked = settings.autoCheckUpdates !== false;
    }

    if (updateChannelSelect) {
      updateChannelSelect.value = settings.updateChannel || 'auto';
    }

    if (enableSearchHistoryToggle) {
      enableSearchHistoryToggle.checked = settings.enableSearchHistory !== false;
    }

    if (dangerousOptionsToggle) {
      dangerousOptionsToggle.checked = settings.showDangerousOptions || false;
      deps.updateDangerousOptionsVisibility(dangerousOptionsToggle.checked);
    }

    if (startupPathInput) {
      startupPathInput.value = settings.startupPath || '';
    }

    if (enableIndexerToggle) {
      enableIndexerToggle.checked = settings.enableIndexer !== false;
    }

    if (showRecentFilesToggle) {
      showRecentFilesToggle.checked = settings.showRecentFiles !== false;
    }

    if (showFolderTreeToggle) {
      showFolderTreeToggle.checked = settings.showFolderTree !== false;
    }

    if (enableTabsToggle) {
      enableTabsToggle.checked = settings.enableTabs !== false;
    }

    if (globalContentSearchToggle) {
      globalContentSearchToggle.checked = settings.globalContentSearch || false;
    }

    if (globalClipboardToggle) {
      globalClipboardToggle.checked = settings.globalClipboard !== false;
    }

    if (reduceMotionToggle) {
      reduceMotionToggle.checked = settings.reduceMotion || false;
    }

    if (highContrastToggle) {
      highContrastToggle.checked = settings.highContrast || false;
    }

    if (largeTextToggle) {
      largeTextToggle.checked = settings.largeText || false;
    }

    if (useSystemFontSizeToggle) {
      useSystemFontSizeToggle.checked = settings.useSystemFontSize || false;
    }

    if (uiDensitySelect) {
      uiDensitySelect.value = settings.uiDensity || 'default';
    }

    if (boldTextToggle) {
      boldTextToggle.checked = settings.boldText || false;
    }

    if (visibleFocusToggle) {
      visibleFocusToggle.checked = settings.visibleFocus || false;
    }

    if (reduceTransparencyToggle) {
      reduceTransparencyToggle.checked = settings.reduceTransparency || false;
    }

    if (liquidGlassToggle) {
      liquidGlassToggle.checked = settings.liquidGlassMode || false;
    }

    if (themedIconsToggle) {
      themedIconsToggle.checked = settings.themedIcons || false;
    }

    if (disableHwAccelToggle) {
      disableHwAccelToggle.checked = settings.disableHardwareAcceleration || false;
    }

    if (confirmFileOperationsToggle) {
      confirmFileOperationsToggle.checked = settings.confirmFileOperations || false;
    }

    if (fileConflictBehaviorSelect) {
      fileConflictBehaviorSelect.value = settings.fileConflictBehavior || 'ask';
    }

    if (maxThumbnailSizeInput) {
      maxThumbnailSizeInput.value = String(settings.maxThumbnailSizeMB || 10);
    }

    if (thumbnailQualitySelect) {
      thumbnailQualitySelect.value = settings.thumbnailQuality || 'medium';
    }

    if (autoPlayVideosToggle) {
      autoPlayVideosToggle.checked = settings.autoPlayVideos || false;
    }

    if (previewPanelPositionSelect) {
      previewPanelPositionSelect.value = settings.previewPanelPosition || 'right';
    }

    if (maxPreviewSizeInput) {
      maxPreviewSizeInput.value = String(settings.maxPreviewSizeMB || 50);
    }

    if (gridColumnsSelect) {
      gridColumnsSelect.value = settings.gridColumns || 'auto';
    }

    if (iconSizeSlider) {
      iconSizeSlider.value = String(settings.iconSize || 64);
      if (iconSizeValue) {
        iconSizeValue.textContent = String(settings.iconSize || 64);
      }
    }

    if (compactFileInfoToggle) {
      compactFileInfoToggle.checked = settings.compactFileInfo || false;
    }

    if (showFileExtensionsToggle) {
      showFileExtensionsToggle.checked = settings.showFileExtensions !== false;
    }

    if (maxSearchHistoryInput) {
      maxSearchHistoryInput.value = String(settings.maxSearchHistoryItems || 5);
    }
    if (maxDirectoryHistoryInput) {
      maxDirectoryHistoryInput.value = String(settings.maxDirectoryHistoryItems || 5);
    }

    await deps.updateIndexStatus();
    void deps.updateThumbnailCacheSize();

    const path = await window.electronAPI.getSettingsPath();
    if (settingsPath) {
      settingsPath.textContent = path;
    }

    if (settingsModal) {
      const searchInput = document.getElementById('settings-search') as HTMLInputElement | null;
      if (searchInput) {
        searchInput.value = '';
      }
      deps.syncQuickActionsFromMain();
      deps.updateSettingsCardSummaries();
      deps.applySettingsSearch('');
      settingsModal.style.display = 'flex';
      deps.activateModal(settingsModal);
      deps.setSuppressSettingsTracking(false);
      deps.clearSettingsChanged();
      deps.initSettingsChangeTracking();
    }
  }

  function hideSettingsModal() {
    const settingsModal = document.getElementById('settings-modal');
    if (settingsModal) {
      settingsModal.style.display = 'none';
      deps.deactivateModal(settingsModal);
    }
    deps.stopIndexStatusPolling();
    deps.onSettingsModalHide?.();
  }

  return { showSettingsModal, hideSettingsModal };
}
