// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSettingsUiController } from '../rendererSettingsUi';

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

describe('rendererSettingsUi – state management', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('getSavedState returns null initially', () => {
    const ctrl = makeController();
    expect(ctrl.getSavedState()).toBeNull();
  });

  it('setSavedState / getSavedState round-trips', () => {
    const ctrl = makeController();
    const state = { 'theme-select': 'dark', 'show-hidden-files-toggle': true };
    ctrl.setSavedState(state);
    expect(ctrl.getSavedState()).toBe(state);
  });

  it('setSavedState(null) clears saved state', () => {
    const ctrl = makeController();
    ctrl.setSavedState({ foo: 'bar' });
    ctrl.setSavedState(null);
    expect(ctrl.getSavedState()).toBeNull();
  });

  it('resetRedoState does not throw', () => {
    const ctrl = makeController();
    expect(() => ctrl.resetRedoState()).not.toThrow();
  });

  it('setSuppressSettingsTracking does not throw', () => {
    const ctrl = makeController();
    expect(() => ctrl.setSuppressSettingsTracking(true)).not.toThrow();
    expect(() => ctrl.setSuppressSettingsTracking(false)).not.toThrow();
  });
});

describe('captureSettingsFormState', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns empty object when no settings-modal exists', () => {
    const ctrl = makeController();
    expect(ctrl.captureSettingsFormState()).toEqual({});
  });

  it('captures checkbox state', () => {
    setUpSettingsModal(`
      <input type="checkbox" id="show-hidden-files-toggle" checked />
      <input type="checkbox" id="enable-git-status-toggle" />
    `);
    const ctrl = makeController();
    const state = ctrl.captureSettingsFormState();
    expect(state['show-hidden-files-toggle']).toBe(true);
    expect(state['enable-git-status-toggle']).toBe(false);
  });

  it('captures select value', () => {
    setUpSettingsModal(`
      <select id="theme-select"><option value="dark" selected>Dark</option></select>
    `);
    const ctrl = makeController();
    const state = ctrl.captureSettingsFormState();
    expect(state['theme-select']).toBe('dark');
  });

  it('captures text input value', () => {
    setUpSettingsModal(`
      <input type="text" id="startup-path-input" value="/home/user" />
    `);
    const ctrl = makeController();
    const state = ctrl.captureSettingsFormState();
    expect(state['startup-path-input']).toBe('/home/user');
  });

  it('skips inputs without id', () => {
    setUpSettingsModal('<input type="text" value="noid" />');
    const ctrl = makeController();
    const state = ctrl.captureSettingsFormState();
    expect(Object.keys(state)).toHaveLength(0);
  });

  it('skips settings-search input', () => {
    setUpSettingsModal('<input type="text" id="settings-search" value="query" />');
    const ctrl = makeController();
    const state = ctrl.captureSettingsFormState();
    expect(state['settings-search']).toBeUndefined();
  });

  it('skips quick-action inputs', () => {
    setUpSettingsModal('<input type="checkbox" id="quick-toggle" />');
    const ctrl = makeController();
    const state = ctrl.captureSettingsFormState();
    expect(state['quick-toggle']).toBeUndefined();
  });

  it('skips inputs with data-syncTarget', () => {
    setUpSettingsModal(
      '<input type="checkbox" id="my-sync" data-sync-target="show-hidden-files-toggle" />'
    );
    const ctrl = makeController();
    const state = ctrl.captureSettingsFormState();
    expect(state['my-sync']).toBeUndefined();
  });

  it('skips inputs inside .settings-quick-actions container', () => {
    setUpSettingsModal(`
      <div class="settings-quick-actions">
        <input type="checkbox" id="inner-quick" />
      </div>
    `);
    const ctrl = makeController();
    const state = ctrl.captureSettingsFormState();
    expect(state['inner-quick']).toBeUndefined();
  });
});

describe('applySettingsFormState', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does nothing when no settings-modal exists', () => {
    const ctrl = makeController();
    expect(() => ctrl.applySettingsFormState({ foo: 'bar' })).not.toThrow();
  });

  it('applies checkbox state', () => {
    setUpSettingsModal(`
      <input type="checkbox" id="show-hidden-files-toggle" />
    `);
    const ctrl = makeController();
    ctrl.applySettingsFormState({ 'show-hidden-files-toggle': true });
    const el = document.getElementById('show-hidden-files-toggle') as HTMLInputElement;
    expect(el.checked).toBe(true);
  });

  it('applies select value', () => {
    setUpSettingsModal(`
      <select id="theme-select">
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    `);
    const ctrl = makeController();
    ctrl.applySettingsFormState({ 'theme-select': 'light' });
    const el = document.getElementById('theme-select') as HTMLSelectElement;
    expect(el.value).toBe('light');
  });

  it('applies text input value', () => {
    setUpSettingsModal('<input type="text" id="startup-path-input" value="" />');
    const ctrl = makeController();
    ctrl.applySettingsFormState({ 'startup-path-input': '/new/path' });
    const el = document.getElementById('startup-path-input') as HTMLInputElement;
    expect(el.value).toBe('/new/path');
  });

  it('skips settings-search', () => {
    setUpSettingsModal('<input type="text" id="settings-search" value="" />');
    const ctrl = makeController();
    ctrl.applySettingsFormState({ 'settings-search': 'test' });
    const el = document.getElementById('settings-search') as HTMLInputElement;
    expect(el.value).toBe('');
  });

  it('skips quick- prefixed inputs', () => {
    setUpSettingsModal('<input type="checkbox" id="quick-hidden" />');
    const ctrl = makeController();
    ctrl.applySettingsFormState({ 'quick-hidden': true });
    const el = document.getElementById('quick-hidden') as HTMLInputElement;
    expect(el.checked).toBe(false);
  });

  it('skips inputs with data-sync-target', () => {
    setUpSettingsModal(
      '<input type="checkbox" id="synced" data-sync-target="show-hidden-files-toggle" />'
    );
    const ctrl = makeController();
    ctrl.applySettingsFormState({ synced: true });
    const el = document.getElementById('synced') as HTMLInputElement;
    expect(el.checked).toBe(false);
  });

  it('sets unchecked checkbox to false when value is false', () => {
    setUpSettingsModal('<input type="checkbox" id="enable-git-status-toggle" checked />');
    const ctrl = makeController();
    ctrl.applySettingsFormState({ 'enable-git-status-toggle': false });
    const el = document.getElementById('enable-git-status-toggle') as HTMLInputElement;
    expect(el.checked).toBe(false);
  });
});

describe('buildSettingsFormStateFromSettings', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns empty object when no matching DOM elements exist', () => {
    const ctrl = makeController();
    const state = ctrl.buildSettingsFormStateFromSettings({
      showHiddenFiles: true,
      theme: 'dark',
    } as any);
    expect(state).toEqual({});
  });

  it('maps checkbox settings to boolean values', () => {
    setUpSettingsModal('<input type="checkbox" id="show-hidden-files-toggle" />');
    const ctrl = makeController();
    const state = ctrl.buildSettingsFormStateFromSettings({ showHiddenFiles: true } as any);
    expect(state['show-hidden-files-toggle']).toBe(true);
  });

  it('maps false checkbox settings', () => {
    setUpSettingsModal('<input type="checkbox" id="show-hidden-files-toggle" />');
    const ctrl = makeController();
    const state = ctrl.buildSettingsFormStateFromSettings({ showHiddenFiles: false } as any);
    expect(state['show-hidden-files-toggle']).toBe(false);
  });

  it('maps select settings to string values', () => {
    setUpSettingsModal(`
      <select id="theme-select">
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    `);
    const ctrl = makeController();
    const state = ctrl.buildSettingsFormStateFromSettings({ theme: 'light' } as any);
    expect(state['theme-select']).toBe('light');
  });

  it('maps text input settings to string values', () => {
    setUpSettingsModal('<input type="text" id="startup-path-input" />');
    const ctrl = makeController();
    const state = ctrl.buildSettingsFormStateFromSettings({ startupPath: '/my/path' } as any);
    expect(state['startup-path-input']).toBe('/my/path');
  });

  it('maps numeric input settings to string values', () => {
    setUpSettingsModal('<input type="number" id="max-preview-size-input" />');
    const ctrl = makeController();
    const state = ctrl.buildSettingsFormStateFromSettings({ maxPreviewSizeMB: 100 } as any);
    expect(state['max-preview-size-input']).toBe('100');
  });

  it('maps multiple settings at once', () => {
    setUpSettingsModal(`
      <input type="checkbox" id="show-hidden-files-toggle" />
      <select id="sort-by-select"><option value="name">Name</option></select>
      <input type="text" id="startup-path-input" />
    `);
    const ctrl = makeController();
    const state = ctrl.buildSettingsFormStateFromSettings({
      showHiddenFiles: true,
      sortBy: 'name',
      startupPath: '/a/b',
    } as any);
    expect(state['show-hidden-files-toggle']).toBe(true);
    expect(state['sort-by-select']).toBe('name');
    expect(state['startup-path-input']).toBe('/a/b');
  });

  it('handles undefined setting value gracefully', () => {
    setUpSettingsModal('<input type="text" id="startup-path-input" />');
    const ctrl = makeController();
    const state = ctrl.buildSettingsFormStateFromSettings({ startupPath: undefined } as any);
    expect(state['startup-path-input']).toBe('');
  });
});

describe('clearSettingsChanged', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('captures current form state as saved state', () => {
    setUpSettingsModal('<input type="checkbox" id="show-hidden-files-toggle" checked />');
    const ctrl = makeController();
    ctrl.clearSettingsChanged();
    const saved = ctrl.getSavedState();
    expect(saved).not.toBeNull();
    expect(saved!['show-hidden-files-toggle']).toBe(true);
  });

  it('updates unsaved bar to hidden when state is clean', () => {
    setUpSettingsModal('<input type="checkbox" id="show-hidden-files-toggle" checked />');
    const bar = document.createElement('div');
    bar.id = 'settings-unsaved-bar';
    bar.hidden = false;
    document.body.appendChild(bar);

    const ctrl = makeController();
    ctrl.clearSettingsChanged();
    expect(bar.hidden).toBe(true);
  });
});

describe('activateSettingsTab', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('activates the correct tab and section', () => {
    const tab1 = addSettingsTab('general', 'General');
    const tab2 = addSettingsTab('appearance', 'Appearance');
    const section1 = addSettingsSection('general');
    const section2 = addSettingsSection('appearance');

    const ctrl = makeController();
    ctrl.activateSettingsTab('appearance');

    expect(tab1.classList.contains('active')).toBe(false);
    expect(tab2.classList.contains('active')).toBe(true);
    expect(section1.classList.contains('active')).toBe(false);
    expect(section2.classList.contains('active')).toBe(true);
  });

  it('hides non-active sections when no search term is active', () => {
    addSettingsTab('general');
    addSettingsTab('appearance');
    const section1 = addSettingsSection('general');
    const section2 = addSettingsSection('appearance');

    const ctrl = makeController();
    ctrl.activateSettingsTab('general');

    expect(section1.style.display).toBe('block');
    expect(section2.style.display).toBe('none');
  });

  it('removes active from all other tabs', () => {
    const tab1 = addSettingsTab('general');
    const tab2 = addSettingsTab('appearance');
    addSettingsSection('general');
    addSettingsSection('appearance');

    tab1.classList.add('active');

    const ctrl = makeController();
    ctrl.activateSettingsTab('appearance');

    expect(tab1.classList.contains('active')).toBe(false);
    expect(tab2.classList.contains('active')).toBe(true);
  });

  it('does not throw for missing tab/section', () => {
    const ctrl = makeController();
    expect(() => ctrl.activateSettingsTab('nonexistent')).not.toThrow();
  });
});

describe('applySettingsSearch', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not throw with empty DOM', () => {
    const ctrl = makeController();
    expect(() => ctrl.applySettingsSearch('')).not.toThrow();
  });

  it('shows all items when search term is empty', () => {
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
    ctrl.applySettingsSearch('');

    const item = section.querySelector('.setting-item')!;
    expect(item.classList.contains('search-hidden')).toBe(false);
    expect(item.classList.contains('search-highlight')).toBe(false);
  });

  it('highlights matching items and hides non-matching', () => {
    addSettingsTab('general');
    const section = addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">General</div>
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
    expect(items[0].classList.contains('search-hidden')).toBe(false);
    expect(items[1].classList.contains('search-hidden')).toBe(true);
    expect(items[1].classList.contains('search-highlight')).toBe(false);
  });

  it('is case-insensitive', () => {
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
    ctrl.applySettingsSearch('HIDDEN');

    const item = section.querySelector('.setting-item')!;
    expect(item.classList.contains('search-highlight')).toBe(true);
  });

  it('hides cards with no matching items', () => {
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
    ctrl.applySettingsSearch('zzzzz');

    const card = section.querySelector('.settings-card')!;
    expect(card.classList.contains('search-hidden')).toBe(true);
  });

  it('shows sections with matches and hides sections without', () => {
    addSettingsTab('general');
    addSettingsTab('appearance');
    const sec1 = addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card1</div>
        <div class="setting-item">Hidden Files</div>
      </div>
    `
    );
    const sec2 = addSettingsSection(
      'appearance',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card2</div>
        <div class="setting-item">Git Status</div>
      </div>
    `
    );
    sec1.classList.add('active');

    const ctrl = makeController();
    ctrl.applySettingsSearch('hidden');

    expect(sec1.style.display).toBe('block');
    expect(sec2.style.display).toBe('none');
  });

  it('updates tab match counts', () => {
    const tab = addSettingsTab('general');
    const section = addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="setting-item">Hidden Files</div>
        <div class="setting-item">Hidden Folders</div>
      </div>
    `
    );
    section.classList.add('active');

    const countEl = document.createElement('span');
    countEl.className = 'settings-tab-count';
    countEl.textContent = '0';
    tab.appendChild(countEl);

    const ctrl = makeController();
    ctrl.applySettingsSearch('hidden');

    expect(countEl.textContent).toBe('2');
    expect(tab.classList.contains('has-matches')).toBe(true);
  });

  it('updates search count button', () => {
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

    const countBtn = document.createElement('button');
    countBtn.id = 'settings-search-count';
    document.body.appendChild(countBtn);

    const ctrl = makeController();
    ctrl.applySettingsSearch('hidden');

    expect(countBtn.textContent).toBe('1');
    expect(countBtn.disabled).toBe(false);
  });

  it('disables count button when no matches', () => {
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

    const countBtn = document.createElement('button');
    countBtn.id = 'settings-search-count';
    document.body.appendChild(countBtn);

    const ctrl = makeController();
    ctrl.applySettingsSearch('zzzzz');

    expect(countBtn.textContent).toBe('0');
    expect(countBtn.disabled).toBe(true);
  });

  it('toggles has-value class on search wrapper', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'settings-search-wrapper';
    document.body.appendChild(wrapper);

    const ctrl = makeController();
    ctrl.applySettingsSearch('query');
    expect(wrapper.classList.contains('has-value')).toBe(true);

    ctrl.applySettingsSearch('');
    expect(wrapper.classList.contains('has-value')).toBe(false);
  });

  it('uses data-searchable attribute in search', () => {
    addSettingsTab('general');
    const section = addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="setting-item" data-searchable="privacy security">Opaque Label</div>
      </div>
    `
    );
    section.classList.add('active');

    const ctrl = makeController();
    ctrl.applySettingsSearch('privacy');

    const item = section.querySelector('.setting-item')!;
    expect(item.classList.contains('search-highlight')).toBe(true);
  });

  it('expands collapsed cards when they have matches', () => {
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
    ctrl.applySettingsSearch('hidden');

    const card = section.querySelector('.settings-card')!;
    expect(card.classList.contains('collapsed')).toBe(false);
    const toggle = card.querySelector('.settings-card-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('marks active section as search-no-results when no matches and search is active', () => {
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
    ctrl.applySettingsSearch('zzzzzznonexistent');

    expect(section.classList.contains('search-no-results')).toBe(true);
  });

  it('matches cards with no setting-items using card text', () => {
    addSettingsTab('general');
    const section = addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">About this application</div>
      </div>
    `
    );
    section.classList.add('active');

    const ctrl = makeController();
    ctrl.applySettingsSearch('about');

    const card = section.querySelector('.settings-card')!;
    expect(card.classList.contains('search-hidden')).toBe(false);
  });

  it('switches to first visible tab when active tab becomes hidden', () => {
    const tab1 = addSettingsTab('general');
    const tab2 = addSettingsTab('appearance');
    tab1.classList.add('active');
    const sec1 = addSettingsSection(
      'general',
      `
      <div class="settings-card">
        <div class="settings-card-header">Card</div>
        <div class="setting-item">Git Status</div>
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

    [tab1, tab2].forEach((t) => {
      const c = document.createElement('span');
      c.className = 'settings-tab-count';
      c.textContent = '0';
      t.appendChild(c);
    });

    const ctrl = makeController();

    ctrl.applySettingsSearch('theme color');

    expect(tab2.classList.contains('active')).toBe(true);
  });
});

describe('updateSettingsCardSummaries', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not throw on empty DOM', () => {
    const ctrl = makeController();
    expect(() => ctrl.updateSettingsCardSummaries()).not.toThrow();
  });

  it('builds summary from checkbox setting items', () => {
    document.body.innerHTML = `
      <div class="settings-card">
        <span class="settings-card-summary"></span>
        <div class="setting-item-toggle">
          <label>Hidden Files</label>
          <input type="checkbox" id="show-hidden-files-toggle" checked />
        </div>
      </div>
    `;

    const ctrl = makeController();
    ctrl.updateSettingsCardSummaries();

    const summary = document.querySelector('.settings-card-summary') as HTMLElement;
    expect(summary.textContent).toContain('Hidden Files');
    expect(summary.textContent).toContain('On');
  });

  it('builds summary from unchecked checkbox', () => {
    document.body.innerHTML = `
      <div class="settings-card">
        <span class="settings-card-summary"></span>
        <div class="setting-item-toggle">
          <label>Git Status</label>
          <input type="checkbox" id="enable-git-status-toggle" />
        </div>
      </div>
    `;

    const ctrl = makeController();
    ctrl.updateSettingsCardSummaries();

    const summary = document.querySelector('.settings-card-summary') as HTMLElement;
    expect(summary.textContent).toContain('Git Status');
    expect(summary.textContent).toContain('Off');
  });

  it('builds summary from select element using selected option text', () => {
    document.body.innerHTML = `
      <div class="settings-card">
        <span class="settings-card-summary"></span>
        <div class="setting-item">
          <label>Theme</label>
          <select id="theme-select">
            <option value="dark" selected>Dark Mode</option>
            <option value="light">Light Mode</option>
          </select>
        </div>
      </div>
    `;

    const ctrl = makeController();
    ctrl.updateSettingsCardSummaries();

    const summary = document.querySelector('.settings-card-summary') as HTMLElement;
    expect(summary.textContent).toContain('Theme');
    expect(summary.textContent).toContain('Dark Mode');
  });

  it('shows "Not set" for empty text input', () => {
    document.body.innerHTML = `
      <div class="settings-card">
        <span class="settings-card-summary"></span>
        <div class="setting-item">
          <label>Startup Path</label>
          <input type="text" id="startup-path-input" value="" />
        </div>
      </div>
    `;

    const ctrl = makeController();
    ctrl.updateSettingsCardSummaries();

    const summary = document.querySelector('.settings-card-summary') as HTMLElement;
    expect(summary.textContent).toContain('Not set');
  });

  it('limits to 2 items per card summary', () => {
    document.body.innerHTML = `
      <div class="settings-card">
        <span class="settings-card-summary"></span>
        <div class="setting-item-toggle"><label>A</label><input type="checkbox" id="a" checked /></div>
        <div class="setting-item-toggle"><label>B</label><input type="checkbox" id="b" checked /></div>
        <div class="setting-item-toggle"><label>C</label><input type="checkbox" id="c" checked /></div>
      </div>
    `;

    const ctrl = makeController();
    ctrl.updateSettingsCardSummaries();

    const summary = document.querySelector('.settings-card-summary') as HTMLElement;
    const parts = summary.textContent!.split('•');
    expect(parts.length).toBe(2);
  });

  it('uses bullet separator between items', () => {
    document.body.innerHTML = `
      <div class="settings-card">
        <span class="settings-card-summary"></span>
        <div class="setting-item-toggle"><label>A</label><input type="checkbox" id="a" checked /></div>
        <div class="setting-item-toggle"><label>B</label><input type="checkbox" id="b" /></div>
      </div>
    `;

    const ctrl = makeController();
    ctrl.updateSettingsCardSummaries();

    const summary = document.querySelector('.settings-card-summary') as HTMLElement;
    expect(summary.textContent).toContain('•');
  });

  it('sets empty text when card has no items', () => {
    document.body.innerHTML = `
      <div class="settings-card">
        <span class="settings-card-summary"></span>
      </div>
    `;

    const ctrl = makeController();
    ctrl.updateSettingsCardSummaries();

    const summary = document.querySelector('.settings-card-summary') as HTMLElement;
    expect(summary.textContent).toBe('');
  });

  it('skips items without a label', () => {
    document.body.innerHTML = `
      <div class="settings-card">
        <span class="settings-card-summary"></span>
        <div class="setting-item"><input type="checkbox" id="x" checked /></div>
      </div>
    `;

    const ctrl = makeController();
    ctrl.updateSettingsCardSummaries();

    const summary = document.querySelector('.settings-card-summary') as HTMLElement;
    expect(summary.textContent).toBe('');
  });

  it('skips items without an input', () => {
    document.body.innerHTML = `
      <div class="settings-card">
        <span class="settings-card-summary"></span>
        <div class="setting-item"><label>Label Only</label></div>
      </div>
    `;

    const ctrl = makeController();
    ctrl.updateSettingsCardSummaries();

    const summary = document.querySelector('.settings-card-summary') as HTMLElement;
    expect(summary.textContent).toBe('');
  });

  it('shows text input value when non-empty', () => {
    document.body.innerHTML = `
      <div class="settings-card">
        <span class="settings-card-summary"></span>
        <div class="setting-item">
          <label>Path</label>
          <input type="text" id="startup-path-input" value="/home/user" />
        </div>
      </div>
    `;

    const ctrl = makeController();
    ctrl.updateSettingsCardSummaries();

    const summary = document.querySelector('.settings-card-summary') as HTMLElement;
    expect(summary.textContent).toContain('/home/user');
  });
});

describe('initSettingsTabs', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not throw on empty DOM', () => {
    const ctrl = makeController();
    expect(() => ctrl.initSettingsTabs()).not.toThrow();
  });

  it('adds click listeners that activate tabs', () => {
    const tab = addSettingsTab('general');
    const section = addSettingsSection('general');

    const ctrl = makeController();
    ctrl.initSettingsTabs();

    tab.click();

    expect(tab.classList.contains('active')).toBe(true);
    expect(section.classList.contains('active')).toBe(true);
  });

  it('decorates tabs with label, count, and dot elements', () => {
    const tab = addSettingsTab('general', 'General');
    addSettingsSection('general');

    const ctrl = makeController();
    ctrl.initSettingsTabs();

    expect(tab.querySelector('.settings-tab-label')).not.toBeNull();
    expect(tab.querySelector('.settings-tab-count')).not.toBeNull();
    expect(tab.querySelector('.settings-tab-dot')).not.toBeNull();
  });

  it('does not duplicate decorations on second call', () => {
    const tab = addSettingsTab('general', 'General');
    addSettingsSection('general');

    const ctrl = makeController();
    ctrl.initSettingsTabs();
    ctrl.initSettingsTabs();

    expect(tab.querySelectorAll('.settings-tab-count').length).toBe(1);
    expect(tab.querySelectorAll('.settings-tab-dot').length).toBe(1);
  });
});

describe('initSettingsUi', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not throw on empty DOM', () => {
    const ctrl = makeController();
    expect(() => ctrl.initSettingsUi()).not.toThrow();
  });

  it('is idempotent – second call is a no-op', () => {
    const ctrl = makeController();
    ctrl.initSettingsUi();

    expect(() => ctrl.initSettingsUi()).not.toThrow();
  });

  it('initializes card UI structure', () => {
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

    const card = document.querySelector('.settings-card')!;
    expect(card.querySelector('.settings-card-body')).not.toBeNull();
    expect(card.querySelector('.settings-card-toggle')).not.toBeNull();
    expect(card.querySelector('.settings-card-summary')).not.toBeNull();
  });
});

describe('initSettingsChangeTracking', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not throw without settings-modal', () => {
    const ctrl = makeController();
    expect(() => ctrl.initSettingsChangeTracking()).not.toThrow();
  });

  it('does not throw with an empty settings-modal', () => {
    setUpSettingsModal('');
    const ctrl = makeController();
    expect(() => ctrl.initSettingsChangeTracking()).not.toThrow();
  });

  it('is idempotent', () => {
    setUpSettingsModal('<input type="checkbox" id="a" />');
    const ctrl = makeController();
    ctrl.initSettingsChangeTracking();
    expect(() => ctrl.initSettingsChangeTracking()).not.toThrow();
  });
});

describe('syncQuickActionsFromMain', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not throw on empty DOM', () => {
    const ctrl = makeController();
    expect(() => ctrl.syncQuickActionsFromMain()).not.toThrow();
  });

  it('syncs quick toggle checked state from main toggle', () => {
    document.body.innerHTML = `
      <input type="checkbox" id="show-hidden-files-toggle" checked />
      <input type="checkbox" id="quick-hidden" data-sync-target="show-hidden-files-toggle" />
    `;

    const ctrl = makeController();
    ctrl.syncQuickActionsFromMain();

    const quick = document.getElementById('quick-hidden') as HTMLInputElement;
    expect(quick.checked).toBe(true);
  });

  it('syncs unchecked state', () => {
    document.body.innerHTML = `
      <input type="checkbox" id="show-hidden-files-toggle" />
      <input type="checkbox" id="quick-hidden" data-sync-target="show-hidden-files-toggle" checked />
    `;

    const ctrl = makeController();
    ctrl.syncQuickActionsFromMain();

    const quick = document.getElementById('quick-hidden') as HTMLInputElement;
    expect(quick.checked).toBe(false);
  });
});

describe('capture → apply round-trip', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('round-trips form state through capture and apply', () => {
    setUpSettingsModal(`
      <input type="checkbox" id="show-hidden-files-toggle" checked />
      <select id="theme-select">
        <option value="dark" selected>Dark</option>
        <option value="light">Light</option>
      </select>
      <input type="text" id="startup-path-input" value="/original" />
    `);

    const ctrl = makeController();
    const captured = ctrl.captureSettingsFormState();

    (document.getElementById('show-hidden-files-toggle') as HTMLInputElement).checked = false;
    (document.getElementById('theme-select') as HTMLSelectElement).value = 'light';
    (document.getElementById('startup-path-input') as HTMLInputElement).value = '/changed';

    ctrl.applySettingsFormState(captured);

    expect((document.getElementById('show-hidden-files-toggle') as HTMLInputElement).checked).toBe(
      true
    );
    expect((document.getElementById('theme-select') as HTMLSelectElement).value).toBe('dark');
    expect((document.getElementById('startup-path-input') as HTMLInputElement).value).toBe(
      '/original'
    );
  });
});

describe('edge cases', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('multiple controllers are independent', () => {
    const ctrl1 = makeController();
    const ctrl2 = makeController();

    ctrl1.setSavedState({ a: '1' });
    expect(ctrl2.getSavedState()).toBeNull();
  });

  it('applySettingsFormState calls updateDangerousOptionsVisibility when dangerous-options-toggle exists', () => {
    const deps = createDeps();
    setUpSettingsModal(`
      <input type="checkbox" id="dangerous-options-toggle" />
    `);
    const ctrl = createSettingsUiController(deps as any);
    ctrl.applySettingsFormState({ 'dangerous-options-toggle': true });

    const el = document.getElementById('dangerous-options-toggle') as HTMLInputElement;
    expect(el.checked).toBe(true);
    expect(deps.updateDangerousOptionsVisibility).toHaveBeenCalledWith(true);
  });

  it('applySettingsFormState updates icon-size-value text', () => {
    setUpSettingsModal(`
      <input type="range" id="icon-size-slider" value="64" min="16" max="256" />
    `);
    const valueEl = document.createElement('span');
    valueEl.id = 'icon-size-value';
    valueEl.textContent = '0';
    document.body.appendChild(valueEl);

    const ctrl = makeController();
    ctrl.applySettingsFormState({ 'icon-size-slider': '128' });

    expect(valueEl.textContent).toBe('128');
  });

  it('captureSettingsFormState handles textarea elements', () => {
    setUpSettingsModal('<textarea id="custom-area">hello</textarea>');
    const ctrl = makeController();
    const state = ctrl.captureSettingsFormState();
    expect(state['custom-area']).toBe('hello');
  });
});
