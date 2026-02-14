// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createSettingsModalController } from '../rendererSettingsModal';

function makeDeps() {
  return {
    getCurrentSettings: vi.fn(() => ({
      useSystemTheme: true,
      sortBy: 'name',
      sortOrder: 'asc',
      showHiddenFiles: true,
      enableGitStatus: true,
      gitIncludeUntracked: false,
      minimizeToTray: true,
      startOnLogin: false,
      autoCheckUpdates: true,
      updateChannel: 'beta',
      enableSearchHistory: true,
      showDangerousOptions: false,
      startupPath: '/home/user',
      enableIndexer: true,
      showRecentFiles: true,
      showFolderTree: false,
      useLegacyTreeSpacing: true,
      enableTabs: true,
      globalContentSearch: true,
      globalClipboard: false,
      enableSyntaxHighlighting: true,
      reduceMotion: false,
      highContrast: true,
      largeText: false,
      useSystemFontSize: true,
      uiDensity: 'compact',
      boldText: true,
      visibleFocus: false,
      reduceTransparency: true,
      liquidGlassMode: false,
      themedIcons: true,
      disableHardwareAcceleration: false,
      confirmFileOperations: true,
      fileConflictBehavior: 'rename',
      maxThumbnailSizeMB: 20,
      thumbnailQuality: 'high',
      autoPlayVideos: true,
      previewPanelPosition: 'bottom',
      maxPreviewSizeMB: 100,
      gridColumns: '6',
      iconSize: 128,
      compactFileInfo: true,
      showFileExtensions: false,
      maxSearchHistoryItems: 10,
      maxDirectoryHistoryItems: 15,
      showFileHoverCard: false,
      showFileCheckboxes: true,
      theme: 'dark',
    })),
    activateModal: vi.fn(),
    deactivateModal: vi.fn(),
    setSuppressSettingsTracking: vi.fn(),
    activateSettingsTab: vi.fn(),
    updateCustomThemeUI: vi.fn(),
    updateDangerousOptionsVisibility: vi.fn(),
    updateIndexStatus: vi.fn().mockResolvedValue(undefined),
    updateThumbnailCacheSize: vi.fn().mockResolvedValue(undefined),
    syncQuickActionsFromMain: vi.fn(),
    updateSettingsCardSummaries: vi.fn(),
    applySettingsSearch: vi.fn(),
    clearSettingsChanged: vi.fn(),
    initSettingsChangeTracking: vi.fn(),
    stopIndexStatusPolling: vi.fn(),
    onSettingsModalHide: vi.fn(),
  };
}

const CHECKBOX_IDS = [
  'system-theme-toggle',
  'show-hidden-files-toggle',
  'enable-git-status-toggle',
  'git-include-untracked-toggle',
  'minimize-to-tray-toggle',
  'start-on-login-toggle',
  'auto-check-updates-toggle',
  'enable-search-history-toggle',
  'dangerous-options-toggle',
  'enable-indexer-toggle',
  'show-recent-files-toggle',
  'show-folder-tree-toggle',
  'legacy-tree-spacing-toggle',
  'enable-tabs-toggle',
  'global-content-search-toggle',
  'global-clipboard-toggle',
  'enable-syntax-highlighting-toggle',
  'reduce-motion-toggle',
  'high-contrast-toggle',
  'large-text-toggle',
  'use-system-font-size-toggle',
  'bold-text-toggle',
  'visible-focus-toggle',
  'reduce-transparency-toggle',
  'liquid-glass-toggle',
  'themed-icons-toggle',
  'disable-hw-accel-toggle',
  'confirm-file-operations-toggle',
  'auto-play-videos-toggle',
  'compact-file-info-toggle',
  'show-file-extensions-toggle',
  'show-file-hover-card-toggle',
  'show-file-checkboxes-toggle',
];

const SELECT_IDS: Record<string, string[]> = {
  'sort-by-select': ['name', 'size', 'modified', 'type'],
  'sort-order-select': ['asc', 'desc'],
  'update-channel-select': ['auto', 'stable', 'beta'],
  'ui-density-select': ['default', 'compact', 'comfortable'],
  'file-conflict-behavior-select': ['ask', 'rename', 'replace', 'skip'],
  'thumbnail-quality-select': ['low', 'medium', 'high'],
  'preview-panel-position-select': ['right', 'bottom'],
  'grid-columns-select': ['auto', '3', '4', '5', '6', '8'],
};

const INPUT_IDS = [
  'startup-path-input',
  'max-thumbnail-size-input',
  'max-preview-size-input',
  'icon-size-slider',
  'max-search-history-input',
  'max-directory-history-input',
];

function buildFormDOM(): void {
  let html = '';
  for (const id of CHECKBOX_IDS) {
    html += `<input type="checkbox" id="${id}" />`;
  }
  for (const [id, options] of Object.entries(SELECT_IDS)) {
    html += `<select id="${id}">${options.map((o) => `<option value="${o}">${o}</option>`).join('')}</select>`;
  }
  for (const id of INPUT_IDS) {
    html += `<input type="text" id="${id}" />`;
  }
  html += '<div id="settings-modal" style="display:none"></div>';
  html += '<div id="icon-size-value"></div>';
  html += '<div id="settings-path"></div>';
  html += '<input type="text" id="settings-search" />';
  html += '<div class="settings-tab active" data-tab="general"></div>';
  html += '<div class="settings-tab" data-tab="appearance"></div>';
  html += '<div class="settings-section active" id="general"></div>';
  html += '<div class="settings-section" id="appearance"></div>';
  document.body.innerHTML = html;
}

const mockElectronAPI = {
  getSettingsPath: vi.fn().mockResolvedValue('/home/.config/iyeris/settings.json'),
};

describe('rendererSettingsModal', () => {
  beforeEach(() => {
    buildFormDOM();
    (window as any).electronAPI = mockElectronAPI;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete (window as any).electronAPI;
  });

  describe('showSettingsModal', () => {
    it('populates checkboxes from settings', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      await ctrl.showSettingsModal();

      expect((document.getElementById('system-theme-toggle') as HTMLInputElement).checked).toBe(
        true
      );
      expect(
        (document.getElementById('show-hidden-files-toggle') as HTMLInputElement).checked
      ).toBe(true);
      expect(
        (document.getElementById('enable-git-status-toggle') as HTMLInputElement).checked
      ).toBe(true);
      expect(
        (document.getElementById('git-include-untracked-toggle') as HTMLInputElement).checked
      ).toBe(false);
      expect((document.getElementById('minimize-to-tray-toggle') as HTMLInputElement).checked).toBe(
        true
      );
      expect((document.getElementById('start-on-login-toggle') as HTMLInputElement).checked).toBe(
        false
      );
      expect(
        (document.getElementById('auto-check-updates-toggle') as HTMLInputElement).checked
      ).toBe(true);
      expect(
        (document.getElementById('enable-search-history-toggle') as HTMLInputElement).checked
      ).toBe(true);
      expect(
        (document.getElementById('dangerous-options-toggle') as HTMLInputElement).checked
      ).toBe(false);
      expect((document.getElementById('enable-indexer-toggle') as HTMLInputElement).checked).toBe(
        true
      );
      expect(
        (document.getElementById('legacy-tree-spacing-toggle') as HTMLInputElement).checked
      ).toBe(true);
      expect((document.getElementById('reduce-motion-toggle') as HTMLInputElement).checked).toBe(
        false
      );
      expect((document.getElementById('high-contrast-toggle') as HTMLInputElement).checked).toBe(
        true
      );
      expect(
        (document.getElementById('show-file-hover-card-toggle') as HTMLInputElement).checked
      ).toBe(false);
      expect(
        (document.getElementById('show-file-checkboxes-toggle') as HTMLInputElement).checked
      ).toBe(true);
    });

    it('populates selects from settings', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      await ctrl.showSettingsModal();

      expect((document.getElementById('sort-by-select') as HTMLSelectElement).value).toBe('name');
      expect((document.getElementById('sort-order-select') as HTMLSelectElement).value).toBe('asc');
      expect((document.getElementById('update-channel-select') as HTMLSelectElement).value).toBe(
        'beta'
      );
      expect((document.getElementById('ui-density-select') as HTMLSelectElement).value).toBe(
        'compact'
      );
      expect(
        (document.getElementById('file-conflict-behavior-select') as HTMLSelectElement).value
      ).toBe('rename');
      expect((document.getElementById('thumbnail-quality-select') as HTMLSelectElement).value).toBe(
        'high'
      );
      expect(
        (document.getElementById('preview-panel-position-select') as HTMLSelectElement).value
      ).toBe('bottom');
      expect((document.getElementById('grid-columns-select') as HTMLSelectElement).value).toBe('6');
    });

    it('populates input values from settings', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      await ctrl.showSettingsModal();

      expect((document.getElementById('startup-path-input') as HTMLInputElement).value).toBe(
        '/home/user'
      );
      expect((document.getElementById('max-thumbnail-size-input') as HTMLInputElement).value).toBe(
        '20'
      );
      expect((document.getElementById('max-preview-size-input') as HTMLInputElement).value).toBe(
        '100'
      );
      expect((document.getElementById('icon-size-slider') as HTMLInputElement).value).toBe('128');
      expect(document.getElementById('icon-size-value')!.textContent).toBe('128');
      expect((document.getElementById('max-search-history-input') as HTMLInputElement).value).toBe(
        '10'
      );
      expect(
        (document.getElementById('max-directory-history-input') as HTMLInputElement).value
      ).toBe('15');
    });

    it('activates first settings tab', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      await ctrl.showSettingsModal();
      expect(deps.activateSettingsTab).toHaveBeenCalledWith('general', true);
    });

    it('falls back to classList when tab has no data-tab', async () => {
      document.querySelectorAll('.settings-tab').forEach((t) => t.removeAttribute('data-tab'));
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      await ctrl.showSettingsModal();
      expect(deps.activateSettingsTab).not.toHaveBeenCalled();
      expect(document.querySelector('.settings-tab')!.classList.contains('active')).toBe(true);
    });

    it('activates first section when no tabs exist', async () => {
      document.querySelectorAll('.settings-tab').forEach((t) => t.remove());
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      await ctrl.showSettingsModal();
      expect(document.querySelector('.settings-section')!.classList.contains('active')).toBe(true);
    });

    it('blurs active element before showing', async () => {
      const btn = document.createElement('button');
      document.body.appendChild(btn);
      btn.focus();
      const blurSpy = vi.spyOn(btn, 'blur');
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      await ctrl.showSettingsModal();
      expect(blurSpy).toHaveBeenCalled();
    });

    it('displays modal and calls lifecycle deps', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      await ctrl.showSettingsModal();

      const modal = document.getElementById('settings-modal')!;
      expect(modal.style.display).toBe('flex');
      expect(deps.activateModal).toHaveBeenCalledWith(modal);
      expect(deps.setSuppressSettingsTracking).toHaveBeenCalledWith(true);
      expect(deps.setSuppressSettingsTracking).toHaveBeenCalledWith(false);
      expect(deps.clearSettingsChanged).toHaveBeenCalled();
      expect(deps.initSettingsChangeTracking).toHaveBeenCalled();
      expect(deps.syncQuickActionsFromMain).toHaveBeenCalled();
      expect(deps.updateSettingsCardSummaries).toHaveBeenCalled();
      expect(deps.applySettingsSearch).toHaveBeenCalledWith('');
    });

    it('fetches and displays settings path', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      await ctrl.showSettingsModal();
      expect(mockElectronAPI.getSettingsPath).toHaveBeenCalled();
      expect(document.getElementById('settings-path')!.textContent).toBe(
        '/home/.config/iyeris/settings.json'
      );
    });

    it('calls updateIndexStatus and updateThumbnailCacheSize', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      await ctrl.showSettingsModal();
      expect(deps.updateIndexStatus).toHaveBeenCalled();
      expect(deps.updateThumbnailCacheSize).toHaveBeenCalled();
    });

    it('calls updateCustomThemeUI', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      await ctrl.showSettingsModal();
      expect(deps.updateCustomThemeUI).toHaveBeenCalled();
    });

    it('calls updateDangerousOptionsVisibility with toggle state', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      await ctrl.showSettingsModal();
      expect(deps.updateDangerousOptionsVisibility).toHaveBeenCalledWith(false);
    });

    it('clears settings search input', async () => {
      (document.getElementById('settings-search') as HTMLInputElement).value = 'old search';
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      await ctrl.showSettingsModal();
      expect((document.getElementById('settings-search') as HTMLInputElement).value).toBe('');
    });

    it('handles missing settings-modal element', async () => {
      document.getElementById('settings-modal')!.remove();
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);

      await ctrl.showSettingsModal();
      expect(deps.activateModal).not.toHaveBeenCalled();
    });

    it('uses defaults for missing settings values', async () => {
      const deps = makeDeps();
      deps.getCurrentSettings.mockReturnValue({} as any);
      const ctrl = createSettingsModalController(deps as any);
      await ctrl.showSettingsModal();

      expect(
        (document.getElementById('enable-syntax-highlighting-toggle') as HTMLInputElement).checked
      ).toBe(true);
      expect(
        (document.getElementById('auto-check-updates-toggle') as HTMLInputElement).checked
      ).toBe(true);

      expect(
        (document.getElementById('show-hidden-files-toggle') as HTMLInputElement).checked
      ).toBe(false);

      expect((document.getElementById('sort-by-select') as HTMLSelectElement).value).toBe('name');

      expect((document.getElementById('icon-size-slider') as HTMLInputElement).value).toBe('64');
      expect(document.getElementById('icon-size-value')!.textContent).toBe('64');
    });
  });

  describe('hideSettingsModal', () => {
    it('hides the modal and deactivates it', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      await ctrl.showSettingsModal();
      ctrl.hideSettingsModal();
      const modal = document.getElementById('settings-modal')!;
      expect(modal.style.display).toBe('none');
      expect(deps.deactivateModal).toHaveBeenCalledWith(modal);
    });

    it('stops index status polling', () => {
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      ctrl.hideSettingsModal();
      expect(deps.stopIndexStatusPolling).toHaveBeenCalled();
    });

    it('calls onSettingsModalHide callback', () => {
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      ctrl.hideSettingsModal();
      expect(deps.onSettingsModalHide).toHaveBeenCalled();
    });

    it('works when modal element is missing', () => {
      document.getElementById('settings-modal')!.remove();
      const deps = makeDeps();
      const ctrl = createSettingsModalController(deps as any);
      ctrl.hideSettingsModal();
      expect(deps.deactivateModal).not.toHaveBeenCalled();
      expect(deps.stopIndexStatusPolling).toHaveBeenCalled();
    });

    it('works when onSettingsModalHide is not provided', () => {
      const deps = makeDeps();
      delete (deps as any).onSettingsModalHide;
      const ctrl = createSettingsModalController(deps as any);
      ctrl.hideSettingsModal();
      expect(deps.stopIndexStatusPolling).toHaveBeenCalled();
    });
  });
});
