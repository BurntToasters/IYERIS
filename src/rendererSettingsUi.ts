import { createDefaultSettings } from './settings.js';
import type { Settings } from './types';
import { SEARCH_JUMP_HIGHLIGHT_MS, SETTINGS_SEARCH_DEBOUNCE_MS } from './rendererLocalConstants.js';

export type SettingsFormState = Record<string, string | boolean>;
const SETTINGS_HELP_URL = 'https://help.rosie.run/iyeris/en-us/faq';

interface SettingsUiDeps {
  updateDangerousOptionsVisibility: (visible: boolean) => void;
  saveSettings: () => Promise<void>;
}

function getSettingsCardTitle(card: HTMLElement): string {
  const explicitTitle = card.querySelector('.settings-card-title')?.textContent?.trim();
  if (explicitTitle) return explicitTitle;
  const header = card.querySelector('.settings-card-header');
  const textTitle = Array.from(header?.childNodes ?? [])
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
  return textTitle || 'settings section';
}

function setSettingsCardExpanded(card: HTMLElement, expanded: boolean): void {
  card.classList.toggle('collapsed', !expanded);
  const toggle = card.querySelector<HTMLElement>('.settings-card-toggle');
  if (!toggle) return;
  const cardTitle = getSettingsCardTitle(card);
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${cardTitle}`);
  const glyph = toggle.querySelector('span');
  if (glyph) glyph.textContent = expanded ? '▾' : '▸';
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
    'show-utility-dashboard-toggle': 'showUtilityDashboard',
    'sort-by-select': 'sortBy',
    'sort-order-select': 'sortOrder',
    'enable-search-history-toggle': 'enableSearchHistory',
    'max-search-history-input': 'maxSearchHistoryItems',
    'max-directory-history-input': 'maxDirectoryHistoryItems',
    'show-recent-files-toggle': 'showRecentFiles',
    'show-folder-tree-toggle': 'showFolderTree',
    'legacy-tree-spacing-toggle': 'useLegacyTreeSpacing',
    'enable-tabs-toggle': 'enableTabs',
    'dual-pane-toggle': 'dualPaneEnabled',
    'native-menu-toggle': 'nativeMenuEnabled',
    'operation-panel-collapsed-toggle': 'operationPanelCollapsed',
    'enable-syntax-highlighting-toggle': 'enableSyntaxHighlighting',
    'auto-play-videos-toggle': 'autoPlayVideos',
    'preview-panel-position-select': 'previewPanelPosition',
    'max-preview-size-input': 'maxPreviewSizeMB',
    'grid-columns-select': 'gridColumns',
    'icon-size-slider': 'iconSize',
    'nav-transition-duration-slider': 'navTransitionDuration',
    'operation-animation-slider': 'operationAnimationDuration',
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
    'enable-auto-checksum-toggle': 'enableAutoChecksum',
    'default-checksum-algo-select': 'defaultChecksumAlgorithm',
    'folder-icon-style-select': 'folderIconStyle',
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

    const navTransitionDurationSlider = document.getElementById(
      'nav-transition-duration-slider'
    ) as HTMLInputElement | null;
    const navTransitionDurationValue = document.getElementById('nav-transition-duration-value');
    if (navTransitionDurationSlider && navTransitionDurationValue) {
      navTransitionDurationValue.textContent = navTransitionDurationSlider.value;
    }

    const operationAnimationSlider = document.getElementById(
      'operation-animation-slider'
    ) as HTMLInputElement | null;
    const operationAnimationValue = document.getElementById('operation-animation-value');
    if (operationAnimationSlider && operationAnimationValue) {
      operationAnimationValue.textContent = operationAnimationSlider.value;
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
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
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

  function isSettingsDirty(): boolean {
    if (!settingsSavedState) return false;
    const current = captureSettingsFormState();
    return !statesEqual(current, settingsSavedState);
  }

  function updateSettingsDirtyState(): void {
    if (!settingsSavedState) return;
    const current = captureSettingsFormState();

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
      const tabId = tab.getAttribute('data-tab');
      if (tabId) {
        tab.id ||= `settings-tab-${tabId}`;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', `tab-${tabId}`);
        (tab as HTMLElement).tabIndex = tab.classList.contains('active') ? 0 : -1;
        const panel = document.getElementById(`tab-${tabId}`);
        if (panel) {
          panel.setAttribute('role', 'tabpanel');
          panel.setAttribute('aria-labelledby', tab.id);
          panel.toggleAttribute('hidden', !panel.classList.contains('active'));
        }
      }

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
        count.setAttribute('aria-hidden', 'true');
        tab.appendChild(count);
      }

      if (!tab.querySelector('.settings-tab-dot')) {
        const dot = document.createElement('span');
        dot.className = 'settings-tab-dot';
        dot.setAttribute('aria-hidden', 'true');
        tab.appendChild(dot);
      }
    });
  }

  function activateSettingsTab(tabId: string, skipSearchUpdate = false): void {
    const tabs = document.querySelectorAll('.settings-tab');
    const sections = document.querySelectorAll('.settings-section');
    const tab = document.querySelector(`.settings-tab[data-tab="${tabId}"]`) as HTMLElement | null;
    const section = document.getElementById(`tab-${tabId}`);
    if (!tab || !section || tab.classList.contains('search-hidden')) return;
    const focusedTab = (document.activeElement as Element | null)?.closest('.settings-tab');

    tabs.forEach((t) => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
      (t as HTMLElement).tabIndex = -1;
    });
    sections.forEach((s) => {
      s.classList.remove('active');
      s.toggleAttribute('hidden', true);
      (s as HTMLElement).style.display = 'none';
    });

    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    tab.tabIndex = 0;
    section.classList.add('active');
    section.removeAttribute('hidden');
    section.style.display = 'block';
    if (focusedTab) tab.focus();

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
          HTMLInputElement | HTMLSelectElement | null;
        if (!input) return;
        let value: string;
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
      .forEach((card, cardIndex) => {
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
        const initiallyExpanded = !card.classList.contains('collapsed');
        toggle.setAttribute('aria-expanded', String(initiallyExpanded));
        const cardTitle = getSettingsCardTitle(card as HTMLElement);
        toggle.setAttribute(
          'aria-label',
          `${initiallyExpanded ? 'Collapse' : 'Expand'} ${cardTitle}`
        );
        const toggleGlyph = document.createElement('span');
        toggleGlyph.textContent = initiallyExpanded ? '▾' : '▸';
        toggle.appendChild(toggleGlyph);
        toggle.addEventListener('click', () => {
          setSettingsCardExpanded(card as HTMLElement, card.classList.contains('collapsed'));
        });

        const actions = document.createElement('div');
        actions.className = 'settings-card-actions';
        actions.appendChild(summary);
        actions.appendChild(toggle);
        header.appendChild(actions);

        const body = document.createElement('div');
        body.className = 'settings-card-body';
        body.id = `settings-card-body-${cardIndex}`;
        toggle.setAttribute('aria-controls', body.id);
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
            setSettingsCardExpanded(card as HTMLElement, true);
          }
        }
      });

      const sectionId = section.id.replace('tab-', '');
      tabMatchCount.set(sectionId, sectionMatches);

      const isActive = section.classList.contains('active');
      section.toggleAttribute('hidden', !isActive);
      (section as HTMLElement).style.display = isActive ? 'block' : 'none';
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
      tab.classList.toggle(
        'search-hidden',
        settingsSearchTerm.length > 0 && totalMatches > 0 && count === 0
      );
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
      setSettingsCardExpanded(card, true);
    }

    firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
    firstMatch.classList.add('search-jump');
    setTimeout(() => firstMatch.classList.remove('search-jump'), SEARCH_JUMP_HIGHLIGHT_MS);
  }

  function initSettingsSearch(): void {
    const searchInput = document.getElementById('settings-search') as HTMLInputElement | null;
    const clearBtn = document.getElementById('settings-search-clear') as HTMLButtonElement | null;
    const countBtn = document.getElementById('settings-search-count') as HTMLButtonElement | null;
    if (!searchInput) return;

    let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    searchInput.addEventListener('input', () => {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        // Skip if the input was detached (modal closed / test torn down) so a
        // pending timer can't touch a gone document.
        if (!searchInput.isConnected) return;
        applySettingsSearch(searchInput.value);
      }, SETTINGS_SEARCH_DEBOUNCE_MS);
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
        window.tauriAPI.openFile(SETTINGS_HELP_URL);
      });
    });
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
        const { isDarkMode } = await window.tauriAPI.getSystemAccentColor();
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
      tab.addEventListener('keydown', (event) => {
        if (!(event instanceof KeyboardEvent)) return;
        const visibleTabs = Array.from(
          document.querySelectorAll<HTMLElement>('.settings-tab')
        ).filter(
          (candidate) => !candidate.classList.contains('search-hidden') && !candidate.hidden
        );
        if (visibleTabs.length === 0) return;
        const currentIndex = Math.max(0, visibleTabs.indexOf(tab as HTMLElement));
        let next: HTMLElement | undefined;
        if (event.key === 'ArrowDown') {
          next = visibleTabs[(currentIndex + 1) % visibleTabs.length];
        } else if (event.key === 'ArrowUp') {
          next = visibleTabs[(currentIndex - 1 + visibleTabs.length) % visibleTabs.length];
        } else if (event.key === 'Home') {
          next = visibleTabs[0];
        } else if (event.key === 'End') {
          next = visibleTabs.at(-1);
        } else {
          return;
        }
        event.preventDefault();
        const nextId = next?.dataset.tab;
        if (next && nextId) {
          activateSettingsTab(nextId);
          next.focus();
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
    isSettingsDirty,
  };
}
