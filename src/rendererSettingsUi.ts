import { createDefaultSettings } from './settings.js';
import type { Settings } from './types';

export type SettingsFormState = Record<string, string | boolean>;
const SETTINGS_HELP_URL = 'https://help.rosie.run/iyeris/en-us/faq';

interface SettingsUiDeps {
  updateDangerousOptionsVisibility: (visible: boolean) => void;
  saveSettings: () => Promise<void>;
}

export function createSettingsUiController(deps: SettingsUiDeps) {
  let settingsSavedState: SettingsFormState | null = null;
  let settingsRedoState: SettingsFormState | null = null;
  let suppressSettingsTracking = false;
  let settingsSearchTerm = '';
  let settingsUiInitialized = false;
  let settingsChangeTrackingInitialized = false;

  const SETTINGS_INPUT_KEYS: Record<string, keyof Settings> = {
    'system-theme-toggle': 'useSystemTheme',
    'theme-select': 'theme',
    'themed-icons-toggle': 'themedIcons',
    'minimize-to-tray-toggle': 'minimizeToTray',
    'show-hidden-files-toggle': 'showHiddenFiles',
    'enable-git-status-toggle': 'enableGitStatus',
    'git-include-untracked-toggle': 'gitIncludeUntracked',
    'show-file-hover-card-toggle': 'showFileHoverCard',
    'show-file-checkboxes-toggle': 'showFileCheckboxes',
    'sort-by-select': 'sortBy',
    'sort-order-select': 'sortOrder',
    'enable-search-history-toggle': 'enableSearchHistory',
    'max-search-history-input': 'maxSearchHistoryItems',
    'max-directory-history-input': 'maxDirectoryHistoryItems',
    'show-recent-files-toggle': 'showRecentFiles',
    'show-folder-tree-toggle': 'showFolderTree',
    'legacy-tree-spacing-toggle': 'useLegacyTreeSpacing',
    'enable-tabs-toggle': 'enableTabs',
    'enable-syntax-highlighting-toggle': 'enableSyntaxHighlighting',
    'auto-play-videos-toggle': 'autoPlayVideos',
    'preview-panel-position-select': 'previewPanelPosition',
    'max-preview-size-input': 'maxPreviewSizeMB',
    'grid-columns-select': 'gridColumns',
    'icon-size-slider': 'iconSize',
    'compact-file-info-toggle': 'compactFileInfo',
    'show-file-extensions-toggle': 'showFileExtensions',
    'reduce-motion-toggle': 'reduceMotion',
    'high-contrast-toggle': 'highContrast',
    'large-text-toggle': 'largeText',
    'use-system-font-size-toggle': 'useSystemFontSize',
    'ui-density-select': 'uiDensity',
    'bold-text-toggle': 'boldText',
    'visible-focus-toggle': 'visibleFocus',
    'reduce-transparency-toggle': 'reduceTransparency',
    'liquid-glass-toggle': 'liquidGlassMode',
    'start-on-login-toggle': 'startOnLogin',
    'startup-path-input': 'startupPath',
    'enable-indexer-toggle': 'enableIndexer',
    'global-content-search-toggle': 'globalContentSearch',
    'global-clipboard-toggle': 'globalClipboard',
    'auto-check-updates-toggle': 'autoCheckUpdates',
    'update-channel-select': 'updateChannel',
    'disable-hw-accel-toggle': 'disableHardwareAcceleration',
    'confirm-file-operations-toggle': 'confirmFileOperations',
    'file-conflict-behavior-select': 'fileConflictBehavior',
    'max-thumbnail-size-input': 'maxThumbnailSizeMB',
    'thumbnail-quality-select': 'thumbnailQuality',
    'dangerous-options-toggle': 'showDangerousOptions',
  };

  function setSuppressSettingsTracking(value: boolean) {
    suppressSettingsTracking = value;
  }

  function getSavedState() {
    return settingsSavedState;
  }

  function setSavedState(value: SettingsFormState | null) {
    settingsSavedState = value;
  }

  function resetRedoState() {
    settingsRedoState = null;
  }

  function syncSettingsDependentControls(): void {
    const iconSizeSlider = document.getElementById('icon-size-slider') as HTMLInputElement | null;
    const iconSizeValue = document.getElementById('icon-size-value');
    if (iconSizeSlider && iconSizeValue) {
      iconSizeValue.textContent = iconSizeSlider.value;
    }

    const dangerousOptionsToggle = document.getElementById(
      'dangerous-options-toggle'
    ) as HTMLInputElement | null;
    if (dangerousOptionsToggle) {
      deps.updateDangerousOptionsVisibility(dangerousOptionsToggle.checked);
    }

    syncQuickActionsFromMain();
  }

  function captureSettingsFormState(): SettingsFormState {
    const state: SettingsFormState = {};
    const settingsModal = document.getElementById('settings-modal');
    if (!settingsModal) return state;

    settingsModal.querySelectorAll('input, select, textarea').forEach((element) => {
      const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (!input.id) return;
      if (input.id === 'settings-search') return;
      if (input.id.startsWith('quick-') || input.dataset.syncTarget) return;
      if (input.closest('.settings-quick-actions')) return;
      if (input instanceof HTMLInputElement && input.type === 'checkbox') {
        state[input.id] = input.checked;
      } else {
        state[input.id] = input.value;
      }
    });

    return state;
  }

  function applySettingsFormState(state: SettingsFormState): void {
    const settingsModal = document.getElementById('settings-modal');
    if (!settingsModal) return;

    suppressSettingsTracking = true;
    settingsModal.querySelectorAll('input, select, textarea').forEach((element) => {
      const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (!input.id || !(input.id in state)) return;
      if (input.id === 'settings-search') return;
      if (input.id.startsWith('quick-') || input.dataset.syncTarget) return;
      if (input.closest('.settings-quick-actions')) return;
      const value = state[input.id];
      if (input instanceof HTMLInputElement && input.type === 'checkbox') {
        input.checked = Boolean(value);
      } else {
        input.value = String(value ?? '');
      }
    });

    syncSettingsDependentControls();
    updateSettingsCardSummaries();
    suppressSettingsTracking = false;
    updateSettingsDirtyState();
  }

  function buildSettingsFormStateFromSettings(settings: Settings): SettingsFormState {
    const state: SettingsFormState = {};
    Object.entries(SETTINGS_INPUT_KEYS).forEach(([inputId, key]) => {
      const input = document.getElementById(inputId) as
        | HTMLInputElement
        | HTMLSelectElement
        | HTMLTextAreaElement
        | null;
      if (!input) return;
      const value = settings[key];
      if (input instanceof HTMLInputElement && input.type === 'checkbox') {
        state[inputId] = Boolean(value);
      } else {
        state[inputId] = String(value ?? '');
      }
    });
    return state;
  }

  function statesEqual(a: SettingsFormState, b: SettingsFormState): boolean {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (a[key] !== b[key]) return false;
    }
    return true;
  }

  function updateSettingsDirtyState(): void {
    if (!settingsSavedState) return;
    const current = captureSettingsFormState();
    const isDirty = !statesEqual(current, settingsSavedState);

    const unsavedBar = document.getElementById('settings-unsaved-bar') as HTMLElement | null;
    if (unsavedBar) {
      unsavedBar.hidden = !isDirty;
    }

    const undoBtn = document.getElementById('settings-undo-btn') as HTMLButtonElement | null;
    const redoBtn = document.getElementById('settings-redo-btn') as HTMLButtonElement | null;
    if (undoBtn) undoBtn.disabled = !isDirty;
    if (redoBtn) redoBtn.disabled = !settingsRedoState;

    document.querySelectorAll('.settings-section').forEach((section) => {
      if (section.id === 'tab-about') return;
      const inputs = section.querySelectorAll('input, select, textarea');
      let sectionDirty = false;
      inputs.forEach((element) => {
        const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        if (!input.id) return;
        if (current[input.id] !== settingsSavedState?.[input.id]) {
          sectionDirty = true;
        }
      });
      const tabId = section.id.replace('tab-', '');
      const tab = document.querySelector(`.settings-tab[data-tab="${tabId}"]`);
      tab?.classList.toggle('dirty', sectionDirty);
    });
  }

  function markSettingsChanged() {
    if (suppressSettingsTracking) return;
    settingsRedoState = null;
    updateSettingsDirtyState();
    updateSettingsCardSummaries();
  }

  function clearSettingsChanged() {
    settingsSavedState = captureSettingsFormState();
    settingsRedoState = null;
    updateSettingsDirtyState();
  }

  function initSettingsChangeTracking() {
    if (settingsChangeTrackingInitialized) return;

    const settingsModal = document.getElementById('settings-modal');
    if (!settingsModal) return;

    settingsModal.querySelectorAll('input, select').forEach((input) => {
      input.addEventListener('change', markSettingsChanged);
      if (input.tagName === 'INPUT' && (input as HTMLInputElement).type === 'text') {
        input.addEventListener('input', markSettingsChanged);
      }
    });

    settingsChangeTrackingInitialized = true;
  }

  function ensureSettingsTabDecorations(): void {
    document.querySelectorAll('.settings-tab').forEach((tab) => {
      if (!tab.querySelector('.settings-tab-label')) {
        const label = document.createElement('span');
        label.className = 'settings-tab-label';
        const textNodes = Array.from(tab.childNodes).filter(
          (node) => node.nodeType === Node.TEXT_NODE
        );
        textNodes.forEach((node) => label.appendChild(node));
        label.textContent = label.textContent?.trim() || '';
        const icon = tab.querySelector('img, svg');
        if (icon && icon.nextSibling) {
          tab.insertBefore(label, icon.nextSibling);
        } else {
          tab.appendChild(label);
        }
      }

      if (!tab.querySelector('.settings-tab-count')) {
        const count = document.createElement('span');
        count.className = 'settings-tab-count';
        count.textContent = '0';
        tab.appendChild(count);
      }

      if (!tab.querySelector('.settings-tab-dot')) {
        const dot = document.createElement('span');
        dot.className = 'settings-tab-dot';
        tab.appendChild(dot);
      }
    });
  }

  function activateSettingsTab(tabId: string, skipSearchUpdate = false): void {
    const tabs = document.querySelectorAll('.settings-tab');
    const sections = document.querySelectorAll('.settings-section');

    tabs.forEach((t) => t.classList.remove('active'));
    sections.forEach((s) => s.classList.remove('active'));

    const tab = document.querySelector(`.settings-tab[data-tab="${tabId}"]`);
    const section = document.getElementById(`tab-${tabId}`);
    tab?.classList.add('active');
    section?.classList.add('active');

    if (!settingsSearchTerm) {
      sections.forEach((s) => {
        (s as HTMLElement).style.display = s === section ? 'block' : 'none';
      });
    }

    if (!skipSearchUpdate && settingsSearchTerm) {
      applySettingsSearch(settingsSearchTerm);
    }
  }

  function updateSettingsCardSummaries(): void {
    document.querySelectorAll('.settings-card').forEach((card) => {
      const summary = card.querySelector('.settings-card-summary') as HTMLElement | null;
      if (!summary) return;

      const parts: string[] = [];
      const items = card.querySelectorAll('.setting-item, .setting-item-toggle');
      items.forEach((item) => {
        if (parts.length >= 2) return;
        const label = item.querySelector('label')?.textContent?.trim();
        if (!label) return;
        const input = item.querySelector('input, select') as
          | HTMLInputElement
          | HTMLSelectElement
          | null;
        if (!input) return;
        let value = '';
        if (input instanceof HTMLInputElement && input.type === 'checkbox') {
          value = input.checked ? 'On' : 'Off';
        } else if (input instanceof HTMLSelectElement) {
          value = input.selectedOptions[0]?.textContent?.trim() || input.value;
        } else {
          value = input.value ? input.value : 'Not set';
        }
        parts.push(`${label}: ${value}`);
      });

      summary.textContent = parts.join(' • ');
      if (parts.length === 0) {
        summary.textContent = '';
      }
    });
  }

  function initSettingsCardUI(): void {
    document
      .querySelectorAll('.settings-section:not(#tab-about) .settings-card')
      .forEach((card) => {
        if (card.querySelector('.settings-card-body')) return;

        const header = card.querySelector('.settings-card-header') as HTMLElement | null;
        if (!header) return;

        if (!header.querySelector('.settings-card-title')) {
          const title = document.createElement('span');
          title.className = 'settings-card-title';
          const textNodes = Array.from(header.childNodes).filter(
            (node) => node.nodeType === Node.TEXT_NODE
          );
          textNodes.forEach((node) => title.appendChild(node));
          title.textContent = title.textContent?.trim() || '';
          if (title.textContent) {
            header.insertBefore(title, header.firstChild);
          }
        }

        const summary = document.createElement('span');
        summary.className = 'settings-card-summary';

        const toggle = document.createElement('button');
        toggle.className = 'settings-card-toggle';
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', 'true');
        toggle.innerHTML = '<span>▾</span>';
        toggle.addEventListener('click', () => {
          card.classList.toggle('collapsed');
          toggle.setAttribute('aria-expanded', String(!card.classList.contains('collapsed')));
        });

        const actions = document.createElement('div');
        actions.className = 'settings-card-actions';
        actions.appendChild(summary);
        actions.appendChild(toggle);
        header.appendChild(actions);

        const body = document.createElement('div');
        body.className = 'settings-card-body';
        let node = header.nextSibling;
        while (node) {
          const next = node.nextSibling;
          body.appendChild(node);
          node = next;
        }
        card.appendChild(body);
      });

    updateSettingsCardSummaries();
  }

  function applySettingsSearch(term: string): void {
    settingsSearchTerm = term.toLowerCase().trim();
    const wrapper = document.querySelector('.settings-search-wrapper') as HTMLElement | null;
    wrapper?.classList.toggle('has-value', settingsSearchTerm.length > 0);

    const sections = document.querySelectorAll('.settings-section');
    const tabMatchCount = new Map<string, number>();
    let totalMatches = 0;

    sections.forEach((section) => {
      section.classList.remove('search-no-results');
      const cards = section.querySelectorAll('.settings-card');
      let sectionMatches = 0;

      cards.forEach((card) => {
        const items = card.querySelectorAll('.setting-item, .setting-item-toggle');
        const cardHeaderText = (
          card.querySelector('.settings-card-header')?.textContent || ''
        ).toLowerCase();
        let cardHasMatch = false;

        if (!settingsSearchTerm) {
          items.forEach((item) => {
            item.classList.remove('search-hidden', 'search-highlight');
          });
          card.classList.remove('search-hidden');
          return;
        }

        if (items.length === 0) {
          const cardText = (card.textContent || '').toLowerCase();
          cardHasMatch = cardText.includes(settingsSearchTerm);
          if (cardHasMatch) {
            sectionMatches += 1;
            totalMatches += 1;
          }
        } else {
          items.forEach((item) => {
            const searchable = item.getAttribute('data-searchable') || '';
            const text = item.textContent || '';
            const haystack = `${searchable} ${text} ${cardHeaderText}`.toLowerCase();
            const matches = haystack.includes(settingsSearchTerm);
            item.classList.toggle('search-hidden', !matches);
            item.classList.toggle('search-highlight', matches);
            if (matches) {
              cardHasMatch = true;
              sectionMatches += 1;
              totalMatches += 1;
            }
          });
        }

        card.classList.toggle('search-hidden', !cardHasMatch);
        if (settingsSearchTerm && cardHasMatch) {
          if (card.classList.contains('collapsed')) {
            card.classList.remove('collapsed');
            const toggle = card.querySelector('.settings-card-toggle');
            toggle?.setAttribute('aria-expanded', 'true');
          }
        }
      });

      const sectionId = section.id.replace('tab-', '');
      tabMatchCount.set(sectionId, sectionMatches);

      if (!settingsSearchTerm) {
        const isActive = section.classList.contains('active');
        (section as HTMLElement).style.display = isActive ? 'block' : 'none';
      } else {
        (section as HTMLElement).style.display = sectionMatches > 0 ? 'block' : 'none';
      }
    });

    const countButton = document.getElementById(
      'settings-search-count'
    ) as HTMLButtonElement | null;
    if (countButton) {
      countButton.textContent = String(totalMatches);
      countButton.disabled = totalMatches === 0;
    }

    document.querySelectorAll('.settings-tab').forEach((tab) => {
      const tabId = tab.getAttribute('data-tab') || '';
      const count = tabMatchCount.get(tabId) || 0;
      const countEl = tab.querySelector('.settings-tab-count');
      if (countEl) countEl.textContent = String(count);
      tab.classList.toggle('has-matches', settingsSearchTerm.length > 0 && count > 0);
      tab.classList.toggle('search-hidden', settingsSearchTerm.length > 0 && count === 0);
    });

    if (settingsSearchTerm && totalMatches === 0) {
      const activeSection = document.querySelector(
        '.settings-section.active'
      ) as HTMLElement | null;
      sections.forEach((section) => {
        const isActive = section === activeSection;
        (section as HTMLElement).style.display = isActive ? 'block' : 'none';
        section.classList.toggle('search-no-results', isActive);
      });
    }

    if (settingsSearchTerm && totalMatches > 0) {
      const activeTab = document.querySelector('.settings-tab.active');
      if (activeTab?.classList.contains('search-hidden')) {
        const firstTab = document.querySelector('.settings-tab:not(.search-hidden)');
        const firstId = firstTab?.getAttribute('data-tab');
        if (firstId) activateSettingsTab(firstId, true);
      }
    }
  }

  function jumpToFirstSettingMatch(): void {
    const firstMatch = document.querySelector(
      '.setting-item.search-highlight:not(.search-hidden)'
    ) as HTMLElement | null;
    if (!firstMatch) return;

    const section = firstMatch.closest('.settings-section') as HTMLElement | null;
    if (section) {
      const sectionId = section.id.replace('tab-', '');
      activateSettingsTab(sectionId, true);
    }

    const card = firstMatch.closest('.settings-card') as HTMLElement | null;
    if (card && card.classList.contains('collapsed')) {
      card.classList.remove('collapsed');
      const toggle = card.querySelector('.settings-card-toggle');
      toggle?.setAttribute('aria-expanded', 'true');
    }

    firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
    firstMatch.classList.add('search-jump');
    setTimeout(() => firstMatch.classList.remove('search-jump'), 1200);
  }

  function initSettingsSearch(): void {
    const searchInput = document.getElementById('settings-search') as HTMLInputElement | null;
    const clearBtn = document.getElementById('settings-search-clear') as HTMLButtonElement | null;
    const countBtn = document.getElementById('settings-search-count') as HTMLButtonElement | null;
    if (!searchInput) return;

    searchInput.addEventListener('input', () => {
      applySettingsSearch(searchInput.value);
    });

    const clearSearch = () => {
      searchInput.value = '';
      applySettingsSearch('');
    };

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        jumpToFirstSettingMatch();
      } else if (e.key === 'Escape') {
        clearSearch();
      }
    });

    clearBtn?.addEventListener('click', () => {
      clearSearch();
      searchInput.focus();
    });

    countBtn?.addEventListener('click', () => {
      if (settingsSearchTerm) {
        jumpToFirstSettingMatch();
      }
    });

    window.addEventListener('keydown', (e) => {
      const isSearchShortcut =
        (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.shiftKey;
      if (!isSearchShortcut) return;
      const settingsModal = document.getElementById('settings-modal') as HTMLElement | null;
      if (settingsModal?.style.display === 'flex') {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    });
  }

  function syncQuickActionsFromMain(): void {
    forEachQuickTogglePair((quickToggle, target) => {
      if (target.type === 'checkbox') {
        quickToggle.checked = target.checked;
      }
    });
  }

  function forEachQuickTogglePair(
    callback: (quickToggle: HTMLInputElement, target: HTMLInputElement) => void
  ): void {
    document.querySelectorAll<HTMLInputElement>('[data-sync-target]').forEach((quickToggle) => {
      const targetId = quickToggle.dataset.syncTarget;
      if (!targetId) return;
      const target = document.getElementById(targetId) as HTMLInputElement | null;
      if (!target) return;
      callback(quickToggle, target);
    });
  }

  function initSettingsQuickActions(): void {
    forEachQuickTogglePair((quickToggle, target) => {
      quickToggle.addEventListener('change', () => {
        if (target.type === 'checkbox') {
          target.checked = quickToggle.checked;
          target.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });

      target.addEventListener('change', () => {
        if (target.type === 'checkbox') {
          quickToggle.checked = target.checked;
        }
      });
    });

    syncQuickActionsFromMain();
  }

  function resetSettingsSection(sectionId: string): void {
    const section = document.getElementById(`tab-${sectionId}`);
    if (!section) return;
    const defaults = createDefaultSettings();

    section.querySelectorAll('input, select, textarea').forEach((element) => {
      const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (!input.id) return;
      const key = SETTINGS_INPUT_KEYS[input.id];
      if (!key) return;
      const value = defaults[key];
      if (input instanceof HTMLInputElement && input.type === 'checkbox') {
        input.checked = Boolean(value);
      } else {
        input.value = String(value ?? '');
      }
    });

    syncSettingsDependentControls();
    markSettingsChanged();
  }

  function initSettingsSectionResets(): void {
    document.querySelectorAll<HTMLButtonElement>('.settings-section-reset').forEach((button) => {
      const sectionId = button.dataset.section;
      if (!sectionId) return;

      button.addEventListener('click', () => {
        resetSettingsSection(sectionId);
      });

      const section = document.getElementById(`tab-${sectionId}`);
      const hasInputs = Array.from(section?.querySelectorAll('input, select, textarea') || []).some(
        (element) => {
          const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
          return Boolean(SETTINGS_INPUT_KEYS[input.id]);
        }
      );
      if (!hasInputs) {
        button.style.display = 'none';
      }
    });
  }

  function initSettingsWhyToggles(): void {
    document.querySelectorAll<HTMLButtonElement>('.setting-why-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        const targetId = button.dataset.whyTarget;
        if (!targetId) return;
        const target = document.getElementById(targetId);
        if (!target) return;
        const willShow = target.hasAttribute('hidden');
        if (willShow) {
          target.removeAttribute('hidden');
        } else {
          target.setAttribute('hidden', 'true');
        }
        button.setAttribute('aria-expanded', String(willShow));
      });
    });

    document.querySelectorAll<HTMLButtonElement>('[data-learn-more]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!button.dataset.learnMore) return;
        window.electronAPI.openFile(SETTINGS_HELP_URL);
      });
    });
  }

  function initSettingsPreview(): void {
    const previewToggle = document.getElementById('theme-preview-toggle');
    const previewPanel = document.getElementById('settings-preview-panel');
    const previewClose = document.getElementById('settings-preview-close');
    if (!previewPanel) return;

    const togglePreview = () => {
      if (previewPanel.hasAttribute('hidden')) {
        previewPanel.removeAttribute('hidden');
      } else {
        previewPanel.setAttribute('hidden', 'true');
      }
    };

    previewToggle?.addEventListener('click', togglePreview);
    previewClose?.addEventListener('click', () => previewPanel.setAttribute('hidden', 'true'));
  }

  function initThemeSelectionBehavior(): void {
    const themeSelect = document.getElementById('theme-select') as HTMLSelectElement | null;
    const systemThemeToggle = document.getElementById(
      'system-theme-toggle'
    ) as HTMLInputElement | null;
    if (!themeSelect || !systemThemeToggle) return;

    themeSelect.addEventListener('change', () => {
      if (systemThemeToggle.checked) {
        systemThemeToggle.checked = false;
        systemThemeToggle.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    systemThemeToggle.addEventListener('change', async () => {
      if (!systemThemeToggle.checked) return;
      try {
        const { isDarkMode } = await window.electronAPI.getSystemAccentColor();
        const systemTheme = isDarkMode ? 'default' : 'light';
        themeSelect.value = systemTheme;
      } catch (error) {
        console.error('[Settings] Failed to read system theme:', error);
      }
    });
  }

  function initSettingsUndoRedo(): void {
    const bindClickById = (id: string, handler: () => void): void => {
      document.getElementById(id)?.addEventListener('click', handler);
    };
    bindClickById('settings-save-inline-btn', () => {
      void deps.saveSettings();
    });
    bindClickById('settings-undo-btn', () => {
      if (!settingsSavedState) return;
      const current = captureSettingsFormState();
      if (statesEqual(current, settingsSavedState)) return;
      settingsRedoState = current;
      applySettingsFormState(settingsSavedState);
    });
    bindClickById('settings-redo-btn', () => {
      if (!settingsRedoState) return;
      const redoState = settingsRedoState;
      settingsRedoState = null;
      applySettingsFormState(redoState);
    });
  }

  function initSettingsUi(): void {
    if (settingsUiInitialized) return;
    settingsUiInitialized = true;
    ensureSettingsTabDecorations();
    initSettingsCardUI();
    initSettingsSearch();
    initSettingsQuickActions();
    initSettingsSectionResets();
    initSettingsWhyToggles();
    initSettingsPreview();
    initThemeSelectionBehavior();
    initSettingsUndoRedo();
  }

  function initSettingsTabs() {
    const tabs = document.querySelectorAll('.settings-tab');
    ensureSettingsTabDecorations();
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const tabId = tab.getAttribute('data-tab');
        if (tabId) {
          activateSettingsTab(tabId);
        }
      });
    });
  }

  return {
    initSettingsTabs,
    initSettingsUi,
    activateSettingsTab,
    applySettingsSearch,
    updateSettingsCardSummaries,
    syncQuickActionsFromMain,
    captureSettingsFormState,
    applySettingsFormState,
    buildSettingsFormStateFromSettings,
    clearSettingsChanged,
    initSettingsChangeTracking,
    setSuppressSettingsTracking,
    getSavedState,
    setSavedState,
    resetRedoState,
  };
}
