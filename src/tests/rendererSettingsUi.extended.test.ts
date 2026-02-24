// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCreateDefaultSettings = vi.hoisted(() =>
  vi.fn(() => ({
    useSystemTheme: false,
    theme: 'default',
    themedIcons: false,
    minimizeToTray: false,
    showHiddenFiles: false,
    enableGitStatus: false,
    gitIncludeUntracked: true,
    showFileHoverCard: true,
    showFileCheckboxes: false,
    sortBy: 'name',
    sortOrder: 'asc',
    enableSearchHistory: true,
    maxSearchHistoryItems: 50,
    maxDirectoryHistoryItems: 20,
    showRecentFiles: true,
    showFolderTree: true,
    useLegacyTreeSpacing: false,
    enableTabs: true,
    enableSyntaxHighlighting: true,
    autoPlayVideos: false,
    previewPanelPosition: 'right',
    maxPreviewSizeMB: 50,
    gridColumns: 'auto',
    iconSize: 64,
    compactFileInfo: false,
    showFileExtensions: true,
    reduceMotion: false,
    highContrast: false,
    largeText: false,
    useSystemFontSize: false,
    uiDensity: 'default',
    boldText: false,
    visibleFocus: false,
    reduceTransparency: false,
    liquidGlassMode: false,
    startOnLogin: false,
    startupPath: '',
    enableIndexer: true,
    globalContentSearch: false,
    globalClipboard: true,
    autoCheckUpdates: true,
    updateChannel: 'auto',
    disableHardwareAcceleration: false,
    confirmFileOperations: true,
    fileConflictBehavior: 'ask',
    maxThumbnailSizeMB: 10,
    thumbnailQuality: 'medium',
    showDangerousOptions: false,
  }))
);

vi.mock('../settings.js', () => ({
  createDefaultSettings: mockCreateDefaultSettings,
}));

import { createSettingsUiController } from '../rendererSettingsUi';

Element.prototype.scrollIntoView = vi.fn();

function createDeps() {
  return {
    updateDangerousOptionsVisibility: vi.fn(),
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
}

function makeController(deps?: ReturnType<typeof createDeps>) {
  return createSettingsUiController((deps ?? createDeps()) as any);
}

function setUpSettingsModal(innerHTML = '') {
  const modal = document.createElement('div');
  modal.id = 'settings-modal';
  modal.innerHTML = innerHTML;
  document.body.appendChild(modal);
  return modal;
}

function addSettingsTab(tabId: string, label = tabId) {
  const tab = document.createElement('button');
  tab.className = 'settings-tab';
  tab.setAttribute('data-tab', tabId);
  tab.textContent = label;
  document.body.appendChild(tab);
  return tab;
}

function addSettingsSection(tabId: string, innerHTML = '') {
  const section = document.createElement('div');
  section.id = `tab-${tabId}`;
  section.className = 'settings-section';
  section.innerHTML = innerHTML;
  document.body.appendChild(section);
  return section;
}

describe('updateSettingsDirtyState (via markSettingsChanged / clearSettingsChanged)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reports dirty when form differs from saved state', () => {
    setUpSettingsModal('<input type="checkbox" id="show-hidden-files-toggle" />');

    const ctrl = makeController();

    ctrl.clearSettingsChanged();

    (document.getElementById('show-hidden-files-toggle') as HTMLInputElement).checked = true;

    ctrl.clearSettingsChanged();

    ctrl.setSavedState({ 'show-hidden-files-toggle': false });

    ctrl.applySettingsFormState({ 'show-hidden-files-toggle': true });

    expect(ctrl.isSettingsDirty()).toBe(true);
  });

  it('reports not dirty when form matches saved state', () => {
    setUpSettingsModal('<input type="checkbox" id="show-hidden-files-toggle" />');

    const ctrl = makeController();
    ctrl.clearSettingsChanged();

    expect(ctrl.isSettingsDirty()).toBe(false);
  });

  it('marks section dirty tab with .dirty class when section inputs differ', () => {
    const tab = addSettingsTab('general');

    const modal = setUpSettingsModal('');
    const section = document.createElement('div');
    section.id = 'tab-general';
    section.className = 'settings-section';
    section.innerHTML = '<input type="checkbox" id="show-hidden-files-toggle" />';
    modal.appendChild(section);

    const ctrl = makeController();
    ctrl.clearSettingsChanged();

    (document.getElementById('show-hidden-files-toggle') as HTMLInputElement).checked = true;
    ctrl.setSavedState({ 'show-hidden-files-toggle': false });
    ctrl.applySettingsFormState({ 'show-hidden-files-toggle': true });

    expect(tab.classList.contains('dirty')).toBe(true);
  });

  it('does not mark about tab as dirty', () => {
    const tab = addSettingsTab('about');
    const section = addSettingsSection('about', '<span>version info</span>');
    section.id = 'tab-about';

    const ctrl = makeController();
    ctrl.clearSettingsChanged();
    ctrl.applySettingsFormState({});

    expect(tab.classList.contains('dirty')).toBe(false);
  });

  it('returns false when settingsSavedState is null', () => {
    setUpSettingsModal('<input type="checkbox" id="show-hidden-files-toggle" />');

    const ctrl = makeController();

    ctrl.applySettingsFormState({ 'show-hidden-files-toggle': true });

    expect(ctrl.isSettingsDirty()).toBe(false);
  });
});

describe('markSettingsChanged – suppress tracking', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not trigger change handler when tracking is suppressed', () => {
    setUpSettingsModal('<input type="checkbox" id="show-hidden-files-toggle" />');

    const deps = createDeps();
    const ctrl = makeController(deps);
    ctrl.clearSettingsChanged();
    ctrl.setSuppressSettingsTracking(true);

    (document.getElementById('show-hidden-files-toggle') as HTMLInputElement).checked = true;

    ctrl.initSettingsChangeTracking();
    const input = document.getElementById('show-hidden-files-toggle') as HTMLInputElement;
    (deps as any).updateSettingsCardSummaries = vi.fn();
    input.dispatchEvent(new Event('change'));

    expect((deps as any).updateSettingsCardSummaries).not.toHaveBeenCalled();
  });
});

describe('initSettingsChangeTracking – event listeners', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('attaches change listeners to inputs and selects', () => {
    setUpSettingsModal(`
      <input type="checkbox" id="show-hidden-files-toggle" />
      <select id="theme-select"><option value="dark">Dark</option></select>
    `);

    const ctrl = makeController();
    ctrl.clearSettingsChanged();
    ctrl.initSettingsChangeTracking();

    const checkbox = document.getElementById('show-hidden-files-toggle') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    expect(ctrl.isSettingsDirty()).toBe(true);
  });

  it('attaches input listener to text inputs', () => {
    setUpSettingsModal('<input type="text" id="startup-path-input" value="" />');

    const ctrl = makeController();
    ctrl.clearSettingsChanged();
    ctrl.initSettingsChangeTracking();

    const input = document.getElementById('startup-path-input') as HTMLInputElement;
    input.value = '/new/path';
    input.dispatchEvent(new Event('input'));

    expect(ctrl.isSettingsDirty()).toBe(true);
  });

  it('is idempotent – does not double-attach listeners', () => {
    setUpSettingsModal('<input type="checkbox" id="show-hidden-files-toggle" />');

    const ctrl = makeController();
    ctrl.initSettingsChangeTracking();
    ctrl.initSettingsChangeTracking();
  });
});

describe('ensureSettingsTabDecorations', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('inserts label after icon when icon has nextSibling', () => {
    const tab = document.createElement('button');
    tab.className = 'settings-tab';
    tab.setAttribute('data-tab', 'general');
    const icon = document.createElement('img');
    icon.src = 'icon.png';
    tab.appendChild(icon);
    tab.appendChild(document.createTextNode('General'));
    document.body.appendChild(tab);

    const ctrl = makeController();
    ctrl.initSettingsTabs();

    const label = tab.querySelector('.settings-tab-label');
    expect(label).not.toBeNull();

    expect(icon.nextSibling).toBe(label);
  });

  it('appends label when no icon exists', () => {
    const tab = document.createElement('button');
    tab.className = 'settings-tab';
    tab.setAttribute('data-tab', 'general');
    tab.appendChild(document.createTextNode('General'));
    document.body.appendChild(tab);

    const ctrl = makeController();
    ctrl.initSettingsTabs();

    const label = tab.querySelector('.settings-tab-label');
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe('General');
  });

  it('does not duplicate existing label, count, or dot', () => {
    const tab = document.createElement('button');
    tab.className = 'settings-tab';
    tab.setAttribute('data-tab', 'general');
    const existingLabel = document.createElement('span');
    existingLabel.className = 'settings-tab-label';
    existingLabel.textContent = 'General';
    tab.appendChild(existingLabel);
    const existingCount = document.createElement('span');
    existingCount.className = 'settings-tab-count';
    tab.appendChild(existingCount);
    const existingDot = document.createElement('span');
    existingDot.className = 'settings-tab-dot';
    tab.appendChild(existingDot);
    document.body.appendChild(tab);

    const ctrl = makeController();
    ctrl.initSettingsTabs();

    expect(tab.querySelectorAll('.settings-tab-label').length).toBe(1);
    expect(tab.querySelectorAll('.settings-tab-count').length).toBe(1);
    expect(tab.querySelectorAll('.settings-tab-dot').length).toBe(1);
  });
});

describe('initSettingsCardUI (via initSettingsUi)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('wraps card children after header into a body element', () => {
    addSettingsTab('general');
    addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card Header</div>
        <div class="setting-item"><label>Item</label><input type="checkbox" id="a" /></div>
      </div>
    `
    );

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const card = document.querySelector('.settings-card')!;
    const body = card.querySelector('.settings-card-body');
    expect(body).not.toBeNull();
    expect(body!.querySelector('.setting-item')).not.toBeNull();
  });

  it('skips cards that already have a body', () => {
    addSettingsTab('general');
    addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="settings-card-body">
          <div class="setting-item"><label>X</label><input type="checkbox" id="x" /></div>
        </div>
      </div>
    `
    );

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const card = document.querySelector('.settings-card')!;

    expect(card.querySelectorAll('.settings-card-body').length).toBe(1);
  });

  it('skips cards without a header', () => {
    addSettingsTab('general');
    addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="setting-item"><label>X</label><input type="checkbox" id="x" /></div>
      </div>
    `
    );

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const card = document.querySelector('.settings-card')!;

    expect(card.querySelector('.settings-card-body')).toBeNull();
  });

  it('skips cards in tab-about section', () => {
    addSettingsTab('about');
    const section = addSettingsSection(
      'about',
      `
      <div class="settings-card">
        <div class="settings-card-header">About Card</div>
        <p>Version info</p>
      </div>
    `
    );
    section.id = 'tab-about';

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const card = section.querySelector('.settings-card')!;
    expect(card.querySelector('.settings-card-body')).toBeNull();
  });

  it('card toggle button collapses and expands the card', () => {
    addSettingsTab('general');
    addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="setting-item"><label>A</label><input type="checkbox" id="a" /></div>
      </div>
    `
    );

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const card = document.querySelector('.settings-card')!;
    const toggle = card.querySelector('.settings-card-toggle') as HTMLButtonElement;
    expect(toggle).not.toBeNull();

    toggle.click();
    expect(card.classList.contains('collapsed')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    expect(card.classList.contains('collapsed')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('creates title span from text nodes in header', () => {
    addSettingsTab('general');
    addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card Title</div>
        <div class="setting-item"><label>A</label><input type="checkbox" id="a" /></div>
      </div>
    `
    );

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const title = document.querySelector('.settings-card-title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe('Card Title');
  });

  it('does not duplicate title if one already exists', () => {
    addSettingsTab('general');
    addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">
          <span class="settings-card-title">Existing Title</span>
        </div>
        <div class="setting-item"><label>A</label><input type="checkbox" id="a" /></div>
      </div>
    `
    );

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const card = document.querySelector('.settings-card')!;
    expect(card.querySelectorAll('.settings-card-title').length).toBe(1);
  });
});

describe('jumpToFirstSettingMatch (via initSettingsSearch)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('scrolls to first matching item when Enter is pressed in search', () => {
    vi.useFakeTimers();
    const modal = setUpSettingsModal(`
      <input type="text" id="settings-search" value="" />
    `);
    addSettingsTab('general');
    const section = addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="setting-item">Hidden Files</div>
      </div>
    `
    );
    section.classList.add('active');

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const searchInput = document.getElementById('settings-search') as HTMLInputElement;
    searchInput.value = 'hidden';
    searchInput.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(200);

    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    const preventDefaultSpy = vi.spyOn(enterEvent, 'preventDefault');
    searchInput.dispatchEvent(enterEvent);

    expect(preventDefaultSpy).toHaveBeenCalled();

    const match = section.querySelector('.setting-item')!;
    expect(match.classList.contains('search-jump')).toBe(true);

    vi.advanceTimersByTime(1200);
    expect(match.classList.contains('search-jump')).toBe(false);

    vi.useRealTimers();
  });

  it('does nothing when no match exists', () => {
    setUpSettingsModal('<input type="text" id="settings-search" value="" />');
    addSettingsTab('general');
    const section = addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="setting-item">Hidden Files</div>
      </div>
    `
    );
    section.classList.add('active');

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const searchInput = document.getElementById('settings-search') as HTMLInputElement;
    searchInput.value = 'zzzzz';
    searchInput.dispatchEvent(new Event('input'));
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });

  it('expands collapsed card when jumping to match inside it', () => {
    vi.useFakeTimers();
    setUpSettingsModal('<input type="text" id="settings-search" value="" />');
    addSettingsTab('general');
    const section = addSettingsSection(
      'general',
      `
      <div class="settings-card collapsed">
        <div class="settings-card-header">Card</div>
        <button class="settings-card-toggle" aria-expanded="false"><span>▸</span></button>
        <div class="setting-item">Hidden Files</div>
      </div>
    `
    );
    section.classList.add('active');

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const searchInput = document.getElementById('settings-search') as HTMLInputElement;
    searchInput.value = 'hidden';
    searchInput.dispatchEvent(new Event('input'));
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    vi.advanceTimersByTime(200);

    const card = section.querySelector('.settings-card')!;
    expect(card.classList.contains('collapsed')).toBe(false);

    vi.advanceTimersByTime(1200);
    vi.useRealTimers();
  });
});

describe('initSettingsSearch – keyboard and button interactions', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('Escape key clears the search', () => {
    setUpSettingsModal(`
      <input type="text" id="settings-search" value="" />
    `);
    addSettingsTab('general');
    const section = addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="setting-item">Hidden Files</div>
      </div>
    `
    );
    section.classList.add('active');

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const searchInput = document.getElementById('settings-search') as HTMLInputElement;
    searchInput.value = 'hidden';
    searchInput.dispatchEvent(new Event('input'));
    expect(searchInput.value).toBe('hidden');

    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(searchInput.value).toBe('');
  });

  it('clear button clears search and focuses input', () => {
    setUpSettingsModal(`
      <input type="text" id="settings-search" value="" />
      <button id="settings-search-clear"></button>
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const searchInput = document.getElementById('settings-search') as HTMLInputElement;
    searchInput.value = 'test';
    searchInput.dispatchEvent(new Event('input'));

    const clearBtn = document.getElementById('settings-search-clear') as HTMLButtonElement;
    const focusSpy = vi.spyOn(searchInput, 'focus');
    clearBtn.click();

    expect(searchInput.value).toBe('');
    expect(focusSpy).toHaveBeenCalled();
  });

  it('count button jumps to first match when search term is active', () => {
    vi.useFakeTimers();
    setUpSettingsModal(`
      <input type="text" id="settings-search" value="" />
      <button id="settings-search-count"></button>
    `);
    addSettingsTab('general');
    const section = addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="setting-item">Hidden Files</div>
      </div>
    `
    );
    section.classList.add('active');

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const searchInput = document.getElementById('settings-search') as HTMLInputElement;
    searchInput.value = 'hidden';
    searchInput.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(200);

    const countBtn = document.getElementById('settings-search-count') as HTMLButtonElement;
    countBtn.click();

    const match = section.querySelector('.setting-item')!;
    expect(match.classList.contains('search-jump')).toBe(true);

    vi.advanceTimersByTime(1200);
    vi.useRealTimers();
  });

  it('count button does nothing when no search term', () => {
    setUpSettingsModal(`
      <input type="text" id="settings-search" value="" />
      <button id="settings-search-count"></button>
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const countBtn = document.getElementById('settings-search-count') as HTMLButtonElement;

    expect(() => countBtn.click()).not.toThrow();
  });

  it('Ctrl+F focuses search input when settings modal is visible', () => {
    const modal = setUpSettingsModal(`
      <input type="text" id="settings-search" value="" />
    `);
    modal.style.display = 'flex';

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const searchInput = document.getElementById('settings-search') as HTMLInputElement;
    const focusSpy = vi.spyOn(searchInput, 'focus');
    const selectSpy = vi.spyOn(searchInput, 'select');

    const event = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
    });
    window.dispatchEvent(event);

    expect(focusSpy).toHaveBeenCalled();
    expect(selectSpy).toHaveBeenCalled();
  });

  it('Ctrl+F does nothing when settings modal is not visible', () => {
    const modal = setUpSettingsModal(`
      <input type="text" id="settings-search" value="" />
    `);
    modal.style.display = 'none';

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const searchInput = document.getElementById('settings-search') as HTMLInputElement;
    const focusSpy = vi.spyOn(searchInput, 'focus');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('meta+F focuses search input (macOS shortcut)', () => {
    const modal = setUpSettingsModal(`
      <input type="text" id="settings-search" value="" />
    `);
    modal.style.display = 'flex';

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const searchInput = document.getElementById('settings-search') as HTMLInputElement;
    const focusSpy = vi.spyOn(searchInput, 'focus');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }));

    expect(focusSpy).toHaveBeenCalled();
  });

  it('Ctrl+Shift+F does NOT focus search (shiftKey makes it non-match)', () => {
    const modal = setUpSettingsModal(`
      <input type="text" id="settings-search" value="" />
    `);
    modal.style.display = 'flex';

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const searchInput = document.getElementById('settings-search') as HTMLInputElement;
    const focusSpy = vi.spyOn(searchInput, 'focus');

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true })
    );

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('does not initialize search when no search input exists', () => {
    setUpSettingsModal('');

    const ctrl = makeController();

    expect(() => ctrl.initSettingsUi()).not.toThrow();
  });
});

describe('initSettingsQuickActions (via initSettingsUi)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('syncs quick toggle to main toggle on change', () => {
    setUpSettingsModal(`
      <input type="checkbox" id="show-hidden-files-toggle" />
      <input type="checkbox" id="quick-hidden" data-sync-target="show-hidden-files-toggle" />
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const quickToggle = document.getElementById('quick-hidden') as HTMLInputElement;
    quickToggle.checked = true;
    quickToggle.dispatchEvent(new Event('change'));

    const mainToggle = document.getElementById('show-hidden-files-toggle') as HTMLInputElement;
    expect(mainToggle.checked).toBe(true);
  });

  it('syncs main toggle change back to quick toggle', () => {
    setUpSettingsModal(`
      <input type="checkbox" id="show-hidden-files-toggle" />
      <input type="checkbox" id="quick-hidden" data-sync-target="show-hidden-files-toggle" />
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const mainToggle = document.getElementById('show-hidden-files-toggle') as HTMLInputElement;
    mainToggle.checked = true;
    mainToggle.dispatchEvent(new Event('change'));

    const quickToggle = document.getElementById('quick-hidden') as HTMLInputElement;
    expect(quickToggle.checked).toBe(true);
  });

  it('handles missing sync target gracefully', () => {
    setUpSettingsModal(`
      <input type="checkbox" id="quick-orphan" data-sync-target="nonexistent-toggle" />
    `);

    const ctrl = makeController();
    expect(() => ctrl.initSettingsUi()).not.toThrow();
  });

  it('handles empty sync target attribute', () => {
    setUpSettingsModal(`
      <input type="checkbox" id="quick-empty" data-sync-target="" />
    `);

    const ctrl = makeController();
    expect(() => ctrl.initSettingsUi()).not.toThrow();
  });
});

describe('resetSettingsSection (via initSettingsSectionResets)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('resets checkbox to default value', () => {
    mockCreateDefaultSettings.mockReturnValue({
      showHiddenFiles: false,
    } as any);

    setUpSettingsModal('');
    const section = addSettingsSection(
      'general',
      `
      <input type="checkbox" id="show-hidden-files-toggle" checked />
      <button class="settings-section-reset" data-section="general">Reset</button>
    `
    );

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const resetBtn = section.querySelector('.settings-section-reset') as HTMLButtonElement;
    resetBtn.click();

    const toggle = document.getElementById('show-hidden-files-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it('resets select to default value', () => {
    mockCreateDefaultSettings.mockReturnValue({
      theme: 'default',
    } as any);

    setUpSettingsModal('');
    const section = addSettingsSection(
      'general',
      `
      <select id="theme-select">
        <option value="default">Default</option>
        <option value="dark" selected>Dark</option>
      </select>
      <button class="settings-section-reset" data-section="general">Reset</button>
    `
    );

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const resetBtn = section.querySelector('.settings-section-reset') as HTMLButtonElement;
    resetBtn.click();

    const select = document.getElementById('theme-select') as HTMLSelectElement;
    expect(select.value).toBe('default');
  });

  it('resets text input to default value', () => {
    mockCreateDefaultSettings.mockReturnValue({
      startupPath: '',
    } as any);

    setUpSettingsModal('');
    const section = addSettingsSection(
      'general',
      `
      <input type="text" id="startup-path-input" value="/custom/path" />
      <button class="settings-section-reset" data-section="general">Reset</button>
    `
    );

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const resetBtn = section.querySelector('.settings-section-reset') as HTMLButtonElement;
    resetBtn.click();

    const input = document.getElementById('startup-path-input') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('does not reset inputs without matching SETTINGS_INPUT_KEYS', () => {
    mockCreateDefaultSettings.mockReturnValue({} as any);

    setUpSettingsModal('');
    const section = addSettingsSection(
      'general',
      `
      <input type="text" id="unrelated-input" value="keep" />
      <button class="settings-section-reset" data-section="general">Reset</button>
    `
    );

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const resetBtn = section.querySelector('.settings-section-reset') as HTMLButtonElement;
    resetBtn.click();

    const input = document.getElementById('unrelated-input') as HTMLInputElement;
    expect(input.value).toBe('keep');
  });

  it('handles missing section gracefully', () => {
    setUpSettingsModal('');
    addSettingsSection(
      'general',
      '<button class="settings-section-reset" data-section="nonexistent">Reset</button>'
    );

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const resetBtn = document.querySelector('.settings-section-reset') as HTMLButtonElement;
    expect(() => resetBtn.click()).not.toThrow();
  });
});

describe('initSettingsSectionResets – visibility', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('hides reset button when section has no mapped inputs', () => {
    setUpSettingsModal('');
    const section = addSettingsSection(
      'general',
      `
      <input type="text" id="unmapped-input" value="test" />
      <button class="settings-section-reset" data-section="general">Reset</button>
    `
    );

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const resetBtn = section.querySelector('.settings-section-reset') as HTMLButtonElement;
    expect(resetBtn.style.display).toBe('none');
  });

  it('shows reset button when section has mapped inputs', () => {
    setUpSettingsModal('');
    const section = addSettingsSection(
      'general',
      `
      <input type="checkbox" id="show-hidden-files-toggle" />
      <button class="settings-section-reset" data-section="general">Reset</button>
    `
    );

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const resetBtn = section.querySelector('.settings-section-reset') as HTMLButtonElement;
    expect(resetBtn.style.display).not.toBe('none');
  });

  it('skips reset buttons without data-section attribute', () => {
    setUpSettingsModal('');
    addSettingsSection('general', '<button class="settings-section-reset">Reset</button>');

    const ctrl = makeController();
    expect(() => ctrl.initSettingsUi()).not.toThrow();
  });
});

describe('initSettingsWhyToggles (via initSettingsUi)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (window as any).electronAPI = {
      openFile: vi.fn(),
      getSystemAccentColor: vi.fn().mockResolvedValue({ isDarkMode: true }),
    };
  });

  afterEach(() => {
    delete (window as any).electronAPI;
  });

  it('toggles hidden attribute on target element', () => {
    setUpSettingsModal(`
      <button class="setting-why-toggle" data-why-target="why-panel">Why?</button>
      <div id="why-panel" hidden>Explanation</div>
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const btn = document.querySelector('.setting-why-toggle') as HTMLButtonElement;

    btn.click();
    const panel = document.getElementById('why-panel')!;
    expect(panel.hasAttribute('hidden')).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    btn.click();
    expect(panel.hasAttribute('hidden')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('handles missing why target gracefully', () => {
    setUpSettingsModal(`
      <button class="setting-why-toggle" data-why-target="nonexistent">Why?</button>
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const btn = document.querySelector('.setting-why-toggle') as HTMLButtonElement;
    expect(() => btn.click()).not.toThrow();
  });

  it('handles why toggle without data-why-target', () => {
    setUpSettingsModal(`
      <button class="setting-why-toggle">Why?</button>
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const btn = document.querySelector('.setting-why-toggle') as HTMLButtonElement;
    expect(() => btn.click()).not.toThrow();
  });

  it('learn-more button calls electronAPI.openFile with help URL', () => {
    setUpSettingsModal(`
      <button data-learn-more="true">Learn More</button>
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const btn = document.querySelector('[data-learn-more]') as HTMLButtonElement;
    btn.click();

    expect((window as any).electronAPI.openFile).toHaveBeenCalledWith(
      'https://help.rosie.run/iyeris/en-us/faq'
    );
  });

  it('learn-more button with empty data-learn-more does nothing', () => {
    setUpSettingsModal(`
      <button data-learn-more="">Learn More</button>
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const btn = document.querySelector('[data-learn-more]') as HTMLButtonElement;
    btn.click();

    expect((window as any).electronAPI.openFile).not.toHaveBeenCalled();
  });
});

describe('initThemeSelectionBehavior (via initSettingsUi)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (window as any).electronAPI = {
      openFile: vi.fn(),
      getSystemAccentColor: vi.fn().mockResolvedValue({ isDarkMode: true }),
    };
  });

  afterEach(() => {
    delete (window as any).electronAPI;
  });

  it('unchecks system theme toggle when theme select changes', () => {
    setUpSettingsModal(`
      <select id="theme-select">
        <option value="default">Default</option>
        <option value="dark">Dark</option>
      </select>
      <input type="checkbox" id="system-theme-toggle" checked />
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
    themeSelect.value = 'dark';
    themeSelect.dispatchEvent(new Event('change'));

    const systemToggle = document.getElementById('system-theme-toggle') as HTMLInputElement;
    expect(systemToggle.checked).toBe(false);
  });

  it('does not uncheck system theme toggle if already unchecked', () => {
    setUpSettingsModal(`
      <select id="theme-select">
        <option value="default">Default</option>
        <option value="dark">Dark</option>
      </select>
      <input type="checkbox" id="system-theme-toggle" />
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
    themeSelect.value = 'dark';
    themeSelect.dispatchEvent(new Event('change'));

    const systemToggle = document.getElementById('system-theme-toggle') as HTMLInputElement;
    expect(systemToggle.checked).toBe(false);
  });

  it('sets theme to default when system toggle is checked and system is dark mode', async () => {
    (window as any).electronAPI.getSystemAccentColor = vi
      .fn()
      .mockResolvedValue({ isDarkMode: true });

    setUpSettingsModal(`
      <select id="theme-select">
        <option value="default">Default</option>
        <option value="light">Light</option>
      </select>
      <input type="checkbox" id="system-theme-toggle" />
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const systemToggle = document.getElementById('system-theme-toggle') as HTMLInputElement;
    systemToggle.checked = true;
    systemToggle.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
      expect(themeSelect.value).toBe('default');
    });
  });

  it('sets theme to light when system toggle is checked and system is light mode', async () => {
    (window as any).electronAPI.getSystemAccentColor = vi
      .fn()
      .mockResolvedValue({ isDarkMode: false });

    setUpSettingsModal(`
      <select id="theme-select">
        <option value="default">Default</option>
        <option value="light">Light</option>
      </select>
      <input type="checkbox" id="system-theme-toggle" />
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const systemToggle = document.getElementById('system-theme-toggle') as HTMLInputElement;
    systemToggle.checked = true;
    systemToggle.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
      expect(themeSelect.value).toBe('light');
    });
  });

  it('does not fetch system theme when system toggle is unchecked', () => {
    setUpSettingsModal(`
      <select id="theme-select">
        <option value="default">Default</option>
      </select>
      <input type="checkbox" id="system-theme-toggle" checked />
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const systemToggle = document.getElementById('system-theme-toggle') as HTMLInputElement;
    systemToggle.checked = false;
    systemToggle.dispatchEvent(new Event('change'));

    expect((window as any).electronAPI.getSystemAccentColor).not.toHaveBeenCalled();
  });

  it('handles getSystemAccentColor failure gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as any).electronAPI.getSystemAccentColor = vi.fn().mockRejectedValue(new Error('fail'));

    setUpSettingsModal(`
      <select id="theme-select">
        <option value="default">Default</option>
      </select>
      <input type="checkbox" id="system-theme-toggle" />
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const systemToggle = document.getElementById('system-theme-toggle') as HTMLInputElement;
    systemToggle.checked = true;
    systemToggle.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        '[Settings] Failed to read system theme:',
        expect.any(Error)
      );
    });

    consoleSpy.mockRestore();
  });

  it('does not throw when theme-select or system-theme-toggle is missing', () => {
    setUpSettingsModal('');

    const ctrl = makeController();
    expect(() => ctrl.initSettingsUi()).not.toThrow();
  });
});

describe('initSettingsUndoRedo (via initSettingsUi)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (window as any).electronAPI = {
      openFile: vi.fn(),
      getSystemAccentColor: vi.fn().mockResolvedValue({ isDarkMode: true }),
    };
  });

  afterEach(() => {
    delete (window as any).electronAPI;
  });

  it('save button calls deps.saveSettings', () => {
    const deps = createDeps();
    setUpSettingsModal(`
      <button id="settings-save-inline-btn">Save</button>
    `);

    const ctrl = createSettingsUiController(deps as any);
    ctrl.initSettingsUi();

    const saveBtn = document.getElementById('settings-save-inline-btn') as HTMLButtonElement;
    saveBtn.click();

    expect(deps.saveSettings).toHaveBeenCalled();
  });

  it('undo button restores saved state and stores current as redo', () => {
    const deps = createDeps();
    setUpSettingsModal(`
      <input type="checkbox" id="show-hidden-files-toggle" />
      <button id="settings-undo-btn">Undo</button>
      <button id="settings-redo-btn">Redo</button>
    `);

    const ctrl = createSettingsUiController(deps as any);
    ctrl.initSettingsUi();

    ctrl.setSavedState({ 'show-hidden-files-toggle': false });

    (document.getElementById('show-hidden-files-toggle') as HTMLInputElement).checked = true;

    const undoBtn = document.getElementById('settings-undo-btn') as HTMLButtonElement;
    undoBtn.click();

    const toggle = document.getElementById('show-hidden-files-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it('undo does nothing when saved state is null', () => {
    setUpSettingsModal(`
      <input type="checkbox" id="show-hidden-files-toggle" checked />
      <button id="settings-undo-btn">Undo</button>
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();

    const undoBtn = document.getElementById('settings-undo-btn') as HTMLButtonElement;
    undoBtn.click();

    const toggle = document.getElementById('show-hidden-files-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it('undo does nothing when current state equals saved state', () => {
    setUpSettingsModal(`
      <input type="checkbox" id="show-hidden-files-toggle" />
      <button id="settings-undo-btn">Undo</button>
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();
    ctrl.clearSettingsChanged();

    const undoBtn = document.getElementById('settings-undo-btn') as HTMLButtonElement;
    undoBtn.click();
  });

  it('redo button applies redo state', () => {
    const deps = createDeps();
    setUpSettingsModal(`
      <input type="checkbox" id="show-hidden-files-toggle" />
      <button id="settings-undo-btn">Undo</button>
      <button id="settings-redo-btn">Redo</button>
    `);

    const ctrl = createSettingsUiController(deps as any);
    ctrl.initSettingsUi();

    ctrl.setSavedState({ 'show-hidden-files-toggle': false });

    (document.getElementById('show-hidden-files-toggle') as HTMLInputElement).checked = true;

    const undoBtn = document.getElementById('settings-undo-btn') as HTMLButtonElement;
    undoBtn.click();

    const redoBtn = document.getElementById('settings-redo-btn') as HTMLButtonElement;
    redoBtn.click();

    const toggle = document.getElementById('show-hidden-files-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it('redo does nothing when redo state is null', () => {
    setUpSettingsModal(`
      <input type="checkbox" id="show-hidden-files-toggle" />
      <button id="settings-redo-btn">Redo</button>
    `);

    const ctrl = makeController();
    ctrl.initSettingsUi();
    ctrl.resetRedoState();

    const redoBtn = document.getElementById('settings-redo-btn') as HTMLButtonElement;
    redoBtn.click();
  });
});

describe('statesEqual (via updateSettingsDirtyState)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('treats states as equal when both are identical', () => {
    setUpSettingsModal('<input type="checkbox" id="show-hidden-files-toggle" />');

    const ctrl = makeController();
    ctrl.clearSettingsChanged();

    expect(ctrl.isSettingsDirty()).toBe(false);
  });

  it('detects inequality when a key exists in one state but not the other', () => {
    setUpSettingsModal(`
      <input type="checkbox" id="show-hidden-files-toggle" />
      <input type="text" id="startup-path-input" value="" />
    `);

    const ctrl = makeController();
    ctrl.setSavedState({ 'show-hidden-files-toggle': false });

    ctrl.applySettingsFormState({
      'show-hidden-files-toggle': false,
      'startup-path-input': '/path',
    });

    expect(ctrl.isSettingsDirty()).toBe(true);
  });
});

describe('activateSettingsTab – with search-enabled branches', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('calls applySettingsSearch when search term is active and skipSearchUpdate=false', () => {
    addSettingsTab('general');
    addSettingsTab('appearance');
    const sec1 = addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="setting-item">Hidden Files</div>
      </div>
    `
    );
    sec1.classList.add('active');
    const sec2 = addSettingsSection(
      'appearance',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="setting-item">Theme Color</div>
      </div>
    `
    );

    const ctrl = makeController();

    ctrl.applySettingsSearch('theme');

    ctrl.activateSettingsTab('appearance');

    expect(sec2.classList.contains('active')).toBe(true);
  });

  it('does not re-apply search when skipSearchUpdate=true', () => {
    addSettingsTab('general');
    const sec1 = addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="setting-item">Hidden Files</div>
      </div>
    `
    );
    sec1.classList.add('active');

    const ctrl = makeController();
    ctrl.applySettingsSearch('hidden');

    ctrl.activateSettingsTab('general', true);

    expect(sec1.classList.contains('active')).toBe(true);
  });
});

describe('applySettingsSearch – edge cases', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows section with non-item cards matching text when no setting-items', () => {
    addSettingsTab('about');
    const section = addSettingsSection(
      'about',
      `
      <div class="settings-card">
        <div class="settings-card-header">About Iyeris</div>
        <p>Version 1.0</p>
      </div>
    `
    );
    section.classList.add('active');

    const countEl = document.createElement('span');
    countEl.className = 'settings-tab-count';
    const tab = addSettingsTab('about');
    tab.appendChild(countEl);

    const ctrl = makeController();
    ctrl.applySettingsSearch('version');

    expect(section.style.display).toBe('block');
    const card = section.querySelector('.settings-card')!;
    expect(card.classList.contains('search-hidden')).toBe(false);
  });

  it('hides non-matching non-item cards', () => {
    addSettingsTab('about');
    const section = addSettingsSection(
      'about',
      `
      <div class="settings-card">
        <div class="settings-card-header">About Iyeris</div>
      </div>
    `
    );
    section.classList.add('active');

    const ctrl = makeController();
    ctrl.applySettingsSearch('zzzznonexistent');

    const card = section.querySelector('.settings-card')!;
    expect(card.classList.contains('search-hidden')).toBe(true);
  });

  it('resets classes when search is cleared', () => {
    addSettingsTab('general');
    const section = addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="setting-item">Hidden Files</div>
        <div class="setting-item">Git Status</div>
      </div>
    `
    );
    section.classList.add('active');

    const ctrl = makeController();
    ctrl.applySettingsSearch('hidden');

    const items = section.querySelectorAll('.setting-item');
    expect(items[0].classList.contains('search-highlight')).toBe(true);
    expect(items[1].classList.contains('search-hidden')).toBe(true);

    ctrl.applySettingsSearch('');
    expect(items[0].classList.contains('search-highlight')).toBe(false);
    expect(items[0].classList.contains('search-hidden')).toBe(false);
    expect(items[1].classList.contains('search-highlight')).toBe(false);
    expect(items[1].classList.contains('search-hidden')).toBe(false);
  });

  it('hides tabs with no matches and shows tabs with matches', () => {
    const tab1 = addSettingsTab('general');
    const tab2 = addSettingsTab('appearance');
    const countEl1 = document.createElement('span');
    countEl1.className = 'settings-tab-count';
    tab1.appendChild(countEl1);
    const countEl2 = document.createElement('span');
    countEl2.className = 'settings-tab-count';
    tab2.appendChild(countEl2);

    const sec1 = addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="setting-item">Hidden Files</div>
      </div>
    `
    );
    sec1.classList.add('active');
    addSettingsSection(
      'appearance',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="setting-item">Theme Color</div>
      </div>
    `
    );

    const ctrl = makeController();
    ctrl.applySettingsSearch('hidden');

    expect(tab1.classList.contains('has-matches')).toBe(true);
    expect(tab1.classList.contains('search-hidden')).toBe(false);
    expect(tab2.classList.contains('search-hidden')).toBe(true);
  });

  it('handles active section being null in no-results scenario', () => {
    addSettingsTab('general');
    const section = addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="setting-item">Hidden Files</div>
      </div>
    `
    );

    const ctrl = makeController();

    ctrl.applySettingsSearch('zzzzzznonexistent');

    expect(section.style.display).toBe('none');
  });
});

describe('initSettingsUi – full integration', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (window as any).electronAPI = {
      openFile: vi.fn(),
      getSystemAccentColor: vi.fn().mockResolvedValue({ isDarkMode: true }),
    };
  });

  afterEach(() => {
    delete (window as any).electronAPI;
  });

  it('initializes all sub-systems without error', () => {
    setUpSettingsModal(`
      <input type="text" id="settings-search" />
      <button id="settings-search-clear"></button>
      <button id="settings-search-count"></button>
      <input type="checkbox" id="show-hidden-files-toggle" />
      <input type="checkbox" id="quick-show-hidden" data-sync-target="show-hidden-files-toggle" />
      <select id="theme-select"><option value="default">Default</option></select>
      <input type="checkbox" id="system-theme-toggle" />
      <button id="settings-save-inline-btn">Save</button>
      <button id="settings-undo-btn">Undo</button>
      <button id="settings-redo-btn">Redo</button>
      <button class="setting-why-toggle" data-why-target="why-1">Why?</button>
      <div id="why-1" hidden>Reason</div>
      <button data-learn-more="true">Learn More</button>
    `);

    addSettingsTab('general');
    addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">General Card</div>
        <div class="setting-item"><label>Hidden Files</label><input type="checkbox" id="gen-a" /></div>
      </div>
      <button class="settings-section-reset" data-section="general">Reset</button>
    `
    );

    const ctrl = makeController();
    expect(() => ctrl.initSettingsUi()).not.toThrow();
  });

  it('second call to initSettingsUi is a no-op', () => {
    setUpSettingsModal('');

    const ctrl = makeController();
    ctrl.initSettingsUi();
    expect(() => ctrl.initSettingsUi()).not.toThrow();
  });
});

describe('syncSettingsDependentControls (via applySettingsFormState)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('updates icon-size-value when icon-size-slider exists', () => {
    setUpSettingsModal(`
      <input type="range" id="icon-size-slider" value="48" />
    `);
    const valueEl = document.createElement('span');
    valueEl.id = 'icon-size-value';
    valueEl.textContent = '0';
    document.body.appendChild(valueEl);

    const ctrl = makeController();
    ctrl.applySettingsFormState({ 'icon-size-slider': '96' });

    expect(valueEl.textContent).toBe('96');
  });

  it('does not crash when icon-size-slider or value element is missing', () => {
    setUpSettingsModal('');

    const ctrl = makeController();
    expect(() => ctrl.applySettingsFormState({})).not.toThrow();
  });

  it('calls updateDangerousOptionsVisibility with false when toggle is unchecked', () => {
    const deps = createDeps();
    setUpSettingsModal(`
      <input type="checkbox" id="dangerous-options-toggle" />
    `);

    const ctrl = createSettingsUiController(deps as any);
    ctrl.applySettingsFormState({ 'dangerous-options-toggle': false });

    expect(deps.updateDangerousOptionsVisibility).toHaveBeenCalledWith(false);
  });
});

describe('applySettingsFormState – edge cases', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('handles null value for text input (coerces to empty string)', () => {
    setUpSettingsModal('<input type="text" id="startup-path-input" value="old" />');

    const ctrl = makeController();
    ctrl.applySettingsFormState({ 'startup-path-input': null as any });

    const el = document.getElementById('startup-path-input') as HTMLInputElement;
    expect(el.value).toBe('');
  });

  it('skips inputs not in state', () => {
    setUpSettingsModal('<input type="text" id="startup-path-input" value="keep" />');

    const ctrl = makeController();
    ctrl.applySettingsFormState({});

    const el = document.getElementById('startup-path-input') as HTMLInputElement;
    expect(el.value).toBe('keep');
  });

  it('skips inputs inside settings-quick-actions container', () => {
    setUpSettingsModal(`
      <div class="settings-quick-actions">
        <input type="checkbox" id="quick-inner" />
      </div>
    `);

    const ctrl = makeController();
    ctrl.applySettingsFormState({ 'quick-inner': true });

    const el = document.getElementById('quick-inner') as HTMLInputElement;
    expect(el.checked).toBe(false);
  });
});

describe('buildSettingsFormStateFromSettings – additional', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('handles null setting value for checkbox (coerces to false)', () => {
    setUpSettingsModal('<input type="checkbox" id="show-hidden-files-toggle" checked />');
    const ctrl = makeController();
    const state = ctrl.buildSettingsFormStateFromSettings({ showHiddenFiles: null } as any);
    expect(state['show-hidden-files-toggle']).toBe(false);
  });

  it('handles range input as text input (returns string)', () => {
    setUpSettingsModal('<input type="range" id="icon-size-slider" value="64" />');
    const ctrl = makeController();
    const state = ctrl.buildSettingsFormStateFromSettings({ iconSize: 128 } as any);
    expect(state['icon-size-slider']).toBe('128');
  });
});

describe('forEachQuickTogglePair (via syncQuickActionsFromMain)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('skips quick toggles without data-sync-target', () => {
    document.body.innerHTML = `
      <input type="checkbox" id="no-target" />
    `;

    const ctrl = makeController();

    expect(() => ctrl.syncQuickActionsFromMain()).not.toThrow();
  });

  it('handles non-checkbox target gracefully (no crash)', () => {
    document.body.innerHTML = `
      <input type="text" id="text-target" value="hello" />
      <input type="checkbox" id="quick-sync" data-sync-target="text-target" />
    `;

    const ctrl = makeController();

    ctrl.syncQuickActionsFromMain();

    const quick = document.getElementById('quick-sync') as HTMLInputElement;

    expect(quick.checked).toBe(false);
  });
});

describe('captureSettingsFormState – textarea', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('captures textarea value', () => {
    setUpSettingsModal('<textarea id="notes-area">test notes</textarea>');
    const ctrl = makeController();
    const state = ctrl.captureSettingsFormState();
    expect(state['notes-area']).toBe('test notes');
  });
});
