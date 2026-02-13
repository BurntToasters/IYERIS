import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('./shared.js', () => ({
  escapeHtml: (s: string) => s,
  ignoreError: () => {},
}));

vi.mock('./homeSettings.js', () => ({
  createDefaultHomeSettings: () => ({
    showQuickAccess: true,
    showRecents: true,
    showBookmarks: true,
    showDrives: true,
    showDiskUsage: true,
    hiddenQuickAccessItems: [],
    quickAccessOrder: [
      'userhome',
      'desktop',
      'documents',
      'downloads',
      'music',
      'videos',
      'browse',
      'trash',
    ],
    sectionOrder: ['quick-access', 'recents', 'bookmarks', 'drives'],
    pinnedRecents: [],
    compactCards: false,
    sidebarQuickAccessOrder: [
      'home',
      'userhome',
      'browse',
      'desktop',
      'documents',
      'downloads',
      'music',
      'videos',
      'trash',
    ],
    hiddenSidebarQuickAccessItems: [],
  }),
}));

import { createHomeController } from './home';

function createMinimalDom() {
  document.body.innerHTML = `
    <div id="home-view">
      <div id="home-section-quick-access" style="display:flex">
        <div id="home-quick-access"></div>
      </div>
      <div id="home-section-recents" style="display:flex">
        <div id="home-recents"></div>
      </div>
      <div id="home-section-bookmarks" style="display:flex">
        <div id="home-bookmarks"></div>
      </div>
      <div id="home-section-drives" style="display:flex">
        <div id="home-drives"></div>
      </div>
      <button id="home-customize-btn"></button>
    </div>
    <div id="home-settings-modal" style="display:none">
      <div class="home-settings-content"></div>
    </div>
    <button id="home-settings-close"></button>
    <button id="home-settings-cancel"></button>
    <button id="home-settings-save"></button>
    <button id="home-settings-reset"></button>
    <input id="home-toggle-quick-access" type="checkbox"/>
    <input id="home-toggle-recents" type="checkbox"/>
    <input id="home-toggle-bookmarks" type="checkbox"/>
    <input id="home-toggle-drives" type="checkbox"/>
    <input id="home-toggle-disk-usage" type="checkbox"/>
    <input id="home-toggle-compact" type="checkbox"/>
    <div id="home-quick-access-options"></div>
    <div id="home-section-order"></div>
    <div id="sidebar-quick-access-options"></div>
  `;
}

function createMockElectronAPI() {
  return {
    getHomeSettings: vi.fn(async () => ({ success: true, settings: {} })),
    saveHomeSettings: vi.fn(async () => ({ success: true })),
    getDriveInfo: vi.fn(async () => []),
    getDiskSpace: vi.fn(async () => ({ success: false })),
    onHomeSettingsChanged: vi.fn(() => () => {}),
    getItemProperties: vi.fn(async () => ({ success: false })),
    openFile: vi.fn(async () => ({ success: true })),
  };
}

function createOptions() {
  return {
    twemojiImg: vi.fn((_e: string, _c?: string) => '<img>'),
    showToast: vi.fn(),
    showConfirm: vi.fn(async () => true),
    navigateTo: vi.fn(),
    handleQuickAction: vi.fn(),
    getFileIcon: vi.fn(() => '📄'),
    formatFileSize: vi.fn((n: number) => `${n}B`),
    getSettings: vi.fn(() => ({
      recentFiles: ['/a.txt', '/b.txt', '/c.txt'],
      bookmarks: ['/bm1', '/bm2'],
    })),
    openPath: vi.fn(),
    onModalOpen: vi.fn(),
    onModalClose: vi.fn(),
  };
}

describe('handleHomeItemActivation — delegated clicks', () => {
  let api: ReturnType<typeof createMockElectronAPI>;

  beforeEach(() => {
    createMinimalDom();
    api = createMockElectronAPI();
    (window as unknown as Record<string, unknown>).electronAPI = api;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invokes handleQuickAction when a quick-access item is clicked', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeQuickAccess();

    const items = document.querySelectorAll('#home-quick-access .home-item');
    expect(items.length).toBeGreaterThan(0);
    (items[0] as HTMLElement).click();

    expect(opts.handleQuickAction).toHaveBeenCalled();
  });

  it('invokes navigateTo when a bookmark item is clicked', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeBookmarks();

    const items = document.querySelectorAll('#home-bookmarks .home-item');
    expect(items.length).toBe(2);
    (items[0] as HTMLElement).click();

    expect(opts.navigateTo).toHaveBeenCalledWith('/bm1');
  });

  it('invokes navigateTo when a drive item is clicked', async () => {
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { showDiskUsage: false },
    });
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    await ctrl.renderHomeDrives([{ path: '/mnt/data', label: 'Data' }] as any);

    const items = document.querySelectorAll('#home-drives .home-item');
    expect(items.length).toBe(1);
    (items[0] as HTMLElement).click();

    expect(opts.navigateTo).toHaveBeenCalledWith('/mnt/data');
  });

  it('invokes navigateTo when a drive card is clicked', async () => {
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { showDiskUsage: true },
    });
    api.getDiskSpace.mockResolvedValue({ success: true, total: 1000, free: 400 } as any);
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    await ctrl.renderHomeDrives([{ path: '/dev/sda1', label: 'Root' }] as any);

    await new Promise((r) => setTimeout(r, 10));

    const cards = document.querySelectorAll('#home-drives .home-drive-card');
    expect(cards.length).toBe(1);
    (cards[0] as HTMLElement).click();

    expect(opts.navigateTo).toHaveBeenCalledWith('/dev/sda1');
  });
});

describe('setupHomeDelegatedListeners — keydown events', () => {
  let api: ReturnType<typeof createMockElectronAPI>;

  beforeEach(() => {
    createMinimalDom();
    api = createMockElectronAPI();
    (window as unknown as Record<string, unknown>).electronAPI = api;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('activates quick-access item on Enter key', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeQuickAccess();

    const item = document.querySelector('#home-quick-access .home-item') as HTMLElement;
    expect(item).not.toBeNull();
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(opts.handleQuickAction).toHaveBeenCalled();
  });

  it('activates quick-access item on Space key', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeQuickAccess();

    const item = document.querySelector('#home-quick-access .home-item') as HTMLElement;
    item.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

    expect(opts.handleQuickAction).toHaveBeenCalled();
  });

  it('does not activate on other keydown events', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeQuickAccess();

    const item = document.querySelector('#home-quick-access .home-item') as HTMLElement;
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    expect(opts.handleQuickAction).not.toHaveBeenCalled();
  });

  it('activates bookmark item on Enter key', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeBookmarks();

    const item = document.querySelector('#home-bookmarks .home-item') as HTMLElement;
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(opts.navigateTo).toHaveBeenCalledWith('/bm1');
  });

  it('opens recent item on Enter key', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeRecents();

    const item = document.querySelector('#home-recents .home-recent-item') as HTMLElement;
    expect(item).not.toBeNull();
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await new Promise((r) => setTimeout(r, 10));

    expect(api.getItemProperties).toHaveBeenCalled();
  });

  it('does not activate recent item on pin button keydown', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeRecents();

    const pinBtn = document.querySelector('#home-recents .home-recent-pin') as HTMLElement;
    expect(pinBtn).not.toBeNull();
    pinBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await new Promise((r) => setTimeout(r, 10));

    expect(api.getItemProperties).not.toHaveBeenCalled();
  });
});

describe('openRecentPath — via recent item clicks', () => {
  let api: ReturnType<typeof createMockElectronAPI>;

  beforeEach(() => {
    createMinimalDom();
    api = createMockElectronAPI();
    (window as unknown as Record<string, unknown>).electronAPI = api;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('navigates to directory when item is a directory', async () => {
    api.getItemProperties.mockResolvedValue({
      success: true,
      properties: { isDirectory: true },
    } as any);
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeRecents();

    const item = document.querySelector('#home-recents .home-recent-item') as HTMLElement;
    item.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(opts.navigateTo).toHaveBeenCalledWith('/a.txt');
    expect(opts.openPath).not.toHaveBeenCalled();
  });

  it('uses openPath callback when item is not a directory', async () => {
    api.getItemProperties.mockResolvedValue({
      success: true,
      properties: { isDirectory: false },
    } as any);
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeRecents();

    const item = document.querySelector('#home-recents .home-recent-item') as HTMLElement;
    item.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(opts.navigateTo).not.toHaveBeenCalled();
    expect(opts.openPath).toHaveBeenCalledWith('/a.txt');
  });

  it('falls back to electronAPI.openFile when openPath is not provided', async () => {
    api.getItemProperties.mockResolvedValue({
      success: true,
      properties: { isDirectory: false },
    } as any);
    const opts = createOptions();
    delete (opts as any).openPath;
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeRecents();

    const item = document.querySelector('#home-recents .home-recent-item') as HTMLElement;
    item.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(api.openFile).toHaveBeenCalledWith('/a.txt');
  });

  it('uses openPath when getItemProperties fails', async () => {
    api.getItemProperties.mockRejectedValue(new Error('fail'));
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeRecents();

    const item = document.querySelector('#home-recents .home-recent-item') as HTMLElement;
    item.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(opts.openPath).toHaveBeenCalledWith('/a.txt');
  });

  it('uses openPath when getItemProperties returns success: false', async () => {
    api.getItemProperties.mockResolvedValue({ success: false });
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeRecents();

    const item = document.querySelector('#home-recents .home-recent-item') as HTMLElement;
    item.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(opts.openPath).toHaveBeenCalledWith('/a.txt');
  });
});

describe('togglePinnedRecent — pin/unpin', () => {
  let api: ReturnType<typeof createMockElectronAPI>;

  beforeEach(() => {
    createMinimalDom();
    api = createMockElectronAPI();
    (window as unknown as Record<string, unknown>).electronAPI = api;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pins an unpinned recent and re-renders', async () => {
    api.saveHomeSettings.mockResolvedValue({ success: true });
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeRecents();

    const pinBtn = document.querySelector('#home-recents .home-recent-pin') as HTMLElement;
    expect(pinBtn).not.toBeNull();
    pinBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(api.saveHomeSettings).toHaveBeenCalled();
    const savedSettings = (api.saveHomeSettings as any).mock.calls[0][0];
    expect(savedSettings.pinnedRecents).toContain('/a.txt');
  });

  it('unpins a pinned recent', async () => {
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { pinnedRecents: ['/a.txt'] },
    });
    api.saveHomeSettings.mockResolvedValue({ success: true });
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeRecents();

    const pinBtn = document.querySelector('#home-recents .home-recent-pin') as HTMLElement;
    pinBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(api.saveHomeSettings).toHaveBeenCalled();
    const savedSettings = (api.saveHomeSettings as any).mock.calls[0][0];
    expect(savedSettings.pinnedRecents).not.toContain('/a.txt');
  });

  it('shows error toast when save fails', async () => {
    api.saveHomeSettings.mockResolvedValue({ success: false, error: 'disk full' } as any);
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeRecents();

    const pinBtn = document.querySelector('#home-recents .home-recent-pin') as HTMLElement;
    pinBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(opts.showToast).toHaveBeenCalledWith(
      expect.stringContaining('Failed to update pinned items'),
      'Error',
      'error'
    );
  });

  it('syncs modal when modal is open during pin toggle', async () => {
    api.saveHomeSettings.mockResolvedValue({ success: true });
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();
    ctrl.renderHomeRecents();

    const modal = document.getElementById('home-settings-modal')!;
    modal.style.display = 'flex';

    const pinBtn = document.querySelector('#home-recents .home-recent-pin') as HTMLElement;
    pinBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(api.saveHomeSettings).toHaveBeenCalled();

    const items = document.querySelectorAll('#home-recents .home-recent-item');
    expect(items.length).toBeGreaterThan(0);
  });
});

describe('getDriveUsage — cache behavior', () => {
  let api: ReturnType<typeof createMockElectronAPI>;

  beforeEach(() => {
    createMinimalDom();
    api = createMockElectronAPI();
    (window as unknown as Record<string, unknown>).electronAPI = api;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches disk space from API and caches on first call', async () => {
    api.getDiskSpace.mockResolvedValue({ success: true, total: 1000, free: 500 } as any);
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { showDiskUsage: true },
    });
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    await ctrl.renderHomeDrives([{ path: '/dev/sda1', label: 'Root' }] as any);
    await new Promise((r) => setTimeout(r, 50));

    expect(api.getDiskSpace).toHaveBeenCalledWith('/dev/sda1');
    const meta = document.querySelector('.home-drive-meta') as HTMLElement;
    expect(meta.textContent).toContain('free');
  });

  it('uses cached value on second call within TTL', async () => {
    api.getDiskSpace.mockResolvedValue({ success: true, total: 2000, free: 800 } as any);
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { showDiskUsage: true },
    });
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    await ctrl.renderHomeDrives([{ path: '/x', label: 'X' }] as any);
    await new Promise((r) => setTimeout(r, 50));

    api.getDiskSpace.mockClear();
    await ctrl.renderHomeDrives([{ path: '/x', label: 'X' }] as any);
    await new Promise((r) => setTimeout(r, 50));

    expect(api.getDiskSpace).not.toHaveBeenCalled();
  });

  it('shows "Usage unavailable" when getDiskSpace fails', async () => {
    api.getDiskSpace.mockResolvedValue({ success: false });
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { showDiskUsage: true },
    });
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    await ctrl.renderHomeDrives([{ path: '/fail', label: 'Fail' }] as any);
    await new Promise((r) => setTimeout(r, 50));

    const meta = document.querySelector('.home-drive-meta') as HTMLElement;
    expect(meta.textContent).toBe('Usage unavailable');
  });

  it('shows "Usage unavailable" when total/free are not numbers', async () => {
    api.getDiskSpace.mockResolvedValue({ success: true, total: 'bad', free: 'bad' } as any);
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { showDiskUsage: true },
    });
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    await ctrl.renderHomeDrives([{ path: '/nan', label: 'NaN' }] as any);
    await new Promise((r) => setTimeout(r, 50));

    const meta = document.querySelector('.home-drive-meta') as HTMLElement;
    expect(meta.textContent).toBe('Usage unavailable');
  });
});

describe('saveHomeSettings — via save button click', () => {
  let api: ReturnType<typeof createMockElectronAPI>;

  beforeEach(() => {
    createMinimalDom();
    api = createMockElectronAPI();
    (window as unknown as Record<string, unknown>).electronAPI = api;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves settings, applies them, closes modal, shows toast on success', async () => {
    api.saveHomeSettings.mockResolvedValue({ success: true });
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const modal = document.getElementById('home-settings-modal')!;
    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();
    expect(modal.style.display).toBe('flex');

    const saveBtn = document.getElementById('home-settings-save')!;
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(api.saveHomeSettings).toHaveBeenCalled();
    expect(modal.style.display).toBe('none');
    expect(opts.showToast).toHaveBeenCalledWith('Home settings saved!', 'Home', 'success');
    expect(opts.onModalClose).toHaveBeenCalled();
  });

  it('shows error toast on save failure', async () => {
    api.saveHomeSettings.mockResolvedValue({ success: false, error: 'write error' } as any);
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const saveBtn = document.getElementById('home-settings-save')!;
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(opts.showToast).toHaveBeenCalledWith(
      expect.stringContaining('Failed to save home settings'),
      'Error',
      'error'
    );

    const modal = document.getElementById('home-settings-modal')!;
    expect(modal.style.display).toBe('flex');
  });
});

describe('openHomeSettingsModal — via customize button', () => {
  let api: ReturnType<typeof createMockElectronAPI>;

  beforeEach(() => {
    createMinimalDom();
    api = createMockElectronAPI();
    (window as unknown as Record<string, unknown>).electronAPI = api;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens modal and calls onModalOpen callback', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const modal = document.getElementById('home-settings-modal')!;
    expect(modal.style.display).toBe('flex');
    expect(opts.onModalOpen).toHaveBeenCalledWith(modal);
  });

  it('syncs toggles to current settings when opening', async () => {
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { showQuickAccess: false, showRecents: false },
    });
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const qaToggle = document.getElementById('home-toggle-quick-access') as HTMLInputElement;
    const recentsToggle = document.getElementById('home-toggle-recents') as HTMLInputElement;
    expect(qaToggle.checked).toBe(false);
    expect(recentsToggle.checked).toBe(false);
  });

  it('populates section order list when opening', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const orderList = document.getElementById('home-section-order')!;
    const items = orderList.querySelectorAll('.home-section-order-item');
    expect(items.length).toBe(4);
  });

  it('populates quick access options when opening', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const qaOptions = document.getElementById('home-quick-access-options')!;
    const labels = qaOptions.querySelectorAll('.home-option');
    expect(labels.length).toBeGreaterThan(0);
  });
});

describe('reorderList — section order drag and drop', () => {
  let api: ReturnType<typeof createMockElectronAPI>;

  beforeEach(() => {
    createMinimalDom();
    api = createMockElectronAPI();
    (window as unknown as Record<string, unknown>).electronAPI = api;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reorders sections via simulated drag and drop', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const orderList = document.getElementById('home-section-order')!;
    let items = orderList.querySelectorAll('.home-section-order-item');
    expect(items.length).toBe(4);

    const firstItem = items[0] as HTMLElement;
    const lastItem = items[3] as HTMLElement;

    firstItem.dispatchEvent(
      Object.assign(new Event('dragstart', { bubbles: true }), {
        dataTransfer: { effectAllowed: '', setData: vi.fn() },
      })
    );

    lastItem.dispatchEvent(
      Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
        dataTransfer: { getData: () => '' },
      })
    );

    items = orderList.querySelectorAll('.home-section-order-item');
    expect(items.length).toBe(4);
  });

  it('does not reorder when dropping on same item', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const orderList = document.getElementById('home-section-order')!;
    const items = orderList.querySelectorAll('.home-section-order-item');
    const first = items[0] as HTMLElement;
    const firstSectionBefore = first.dataset.section;

    first.dispatchEvent(
      Object.assign(new Event('dragstart', { bubbles: true }), {
        dataTransfer: { effectAllowed: '', setData: vi.fn() },
      })
    );
    first.dispatchEvent(
      Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
        dataTransfer: { getData: () => '' },
      })
    );

    const updatedItems = orderList.querySelectorAll('.home-section-order-item');
    expect((updatedItems[0] as HTMLElement).dataset.section).toBe(firstSectionBefore);
  });

  it('reorders quick access options via drag and drop', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const qaOptions = document.getElementById('home-quick-access-options')!;
    const labels = qaOptions.querySelectorAll('.home-option');
    expect(labels.length).toBeGreaterThan(1);

    const first = labels[0] as HTMLElement;
    const second = labels[1] as HTMLElement;

    first.dispatchEvent(
      Object.assign(new Event('dragstart', { bubbles: true }), {
        dataTransfer: { effectAllowed: '', setData: vi.fn() },
      })
    );
    second.dispatchEvent(
      Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
        dataTransfer: { getData: () => '' },
      })
    );

    const updated = qaOptions.querySelectorAll('.home-option');
    expect(updated.length).toBeGreaterThan(1);
  });
});

describe('Home settings listeners — toggles and actions', () => {
  let api: ReturnType<typeof createMockElectronAPI>;

  beforeEach(() => {
    createMinimalDom();
    api = createMockElectronAPI();
    (window as unknown as Record<string, unknown>).electronAPI = api;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('toggle checkbox updates tempHomeSettings and marks unsaved changes', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const qaToggle = document.getElementById('home-toggle-quick-access') as HTMLInputElement;
    expect(qaToggle.checked).toBe(true);

    qaToggle.checked = false;
    qaToggle.dispatchEvent(new Event('change', { bubbles: true }));

    api.saveHomeSettings.mockResolvedValue({ success: true });
    const saveBtn = document.getElementById('home-settings-save')!;
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    const saved = (api.saveHomeSettings as any).mock.calls[0][0];
    expect(saved.showQuickAccess).toBe(false);
  });

  it('toggling compact cards checkbox works', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const compactToggle = document.getElementById('home-toggle-compact') as HTMLInputElement;
    compactToggle.checked = true;
    compactToggle.dispatchEvent(new Event('change', { bubbles: true }));

    api.saveHomeSettings.mockResolvedValue({ success: true });
    const saveBtn = document.getElementById('home-settings-save')!;
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    const saved = (api.saveHomeSettings as any).mock.calls[0][0];
    expect(saved.compactCards).toBe(true);
  });

  it('toggling disk usage checkbox works', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const diskToggle = document.getElementById('home-toggle-disk-usage') as HTMLInputElement;
    diskToggle.checked = false;
    diskToggle.dispatchEvent(new Event('change', { bubbles: true }));

    api.saveHomeSettings.mockResolvedValue({ success: true });
    document.getElementById('home-settings-save')!.click();
    await new Promise((r) => setTimeout(r, 10));

    const saved = (api.saveHomeSettings as any).mock.calls[0][0];
    expect(saved.showDiskUsage).toBe(false);
  });

  it('reset button restores default settings', async () => {
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { showQuickAccess: false, compactCards: true },
    });
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const qaToggle = document.getElementById('home-toggle-quick-access') as HTMLInputElement;
    expect(qaToggle.checked).toBe(false);

    const resetBtn = document.getElementById('home-settings-reset')!;
    resetBtn.click();

    expect(qaToggle.checked).toBe(true);
    const compactToggle = document.getElementById('home-toggle-compact') as HTMLInputElement;
    expect(compactToggle.checked).toBe(false);
  });

  it('clicking modal backdrop closes modal', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const modal = document.getElementById('home-settings-modal')!;
    expect(modal.style.display).toBe('flex');

    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));

    expect(modal.style.display).toBe('none');
  });

  it('clicking inside modal content does not close modal', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const modal = document.getElementById('home-settings-modal')!;
    expect(modal.style.display).toBe('flex');

    const content = modal.querySelector('.home-settings-content') as HTMLElement;
    content.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(modal.style.display).toBe('flex');
  });

  it('close button closes modal', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const modal = document.getElementById('home-settings-modal')!;
    expect(modal.style.display).toBe('flex');

    const closeBtn = document.getElementById('home-settings-close')!;
    closeBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(modal.style.display).toBe('none');
  });

  it('cancel button closes modal', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const modal = document.getElementById('home-settings-modal')!;
    expect(modal.style.display).toBe('flex');

    const cancelBtn = document.getElementById('home-settings-cancel')!;
    cancelBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(modal.style.display).toBe('none');
  });

  it('close button prompts confirm when there are unsaved changes', async () => {
    const opts = createOptions();
    opts.showConfirm.mockResolvedValue(false);
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const qaToggle = document.getElementById('home-toggle-quick-access') as HTMLInputElement;
    qaToggle.checked = false;
    qaToggle.dispatchEvent(new Event('change', { bubbles: true }));

    const closeBtn = document.getElementById('home-settings-close')!;
    closeBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(opts.showConfirm).toHaveBeenCalled();

    const modal = document.getElementById('home-settings-modal')!;
    expect(modal.style.display).toBe('flex');
  });

  it('toggling quick access option checkbox updates hidden items', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const qaOptions = document.getElementById('home-quick-access-options')!;
    const checkboxes = qaOptions.querySelectorAll(
      'input[type="checkbox"]'
    ) as NodeListOf<HTMLInputElement>;
    expect(checkboxes.length).toBeGreaterThan(0);

    checkboxes[0].checked = false;
    checkboxes[0].dispatchEvent(new Event('change', { bubbles: true }));

    api.saveHomeSettings.mockResolvedValue({ success: true });
    document.getElementById('home-settings-save')!.click();
    await new Promise((r) => setTimeout(r, 10));

    const saved = (api.saveHomeSettings as any).mock.calls[0][0];
    expect(saved.hiddenQuickAccessItems.length).toBeGreaterThan(0);
  });
});

describe('onHomeSettingsChanged — external updates', () => {
  let api: ReturnType<typeof createMockElectronAPI>;

  beforeEach(() => {
    createMinimalDom();
    api = createMockElectronAPI();
    (window as unknown as Record<string, unknown>).electronAPI = api;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies new settings when callback is triggered', async () => {
    let settingsCallback: ((settings: any) => void) | null = null;
    api.onHomeSettingsChanged.mockImplementation(((cb: any) => {
      settingsCallback = cb;
      return () => {};
    }) as any);

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    expect(settingsCallback).not.toBeNull();

    settingsCallback!({ showQuickAccess: false, compactCards: true });

    const hs = ctrl.getHomeSettings();
    expect(hs.showQuickAccess).toBe(false);
    expect(hs.compactCards).toBe(true);
  });

  it('syncs modal if it is open when external change happens', async () => {
    let settingsCallback: ((settings: any) => void) | null = null;
    api.onHomeSettingsChanged.mockImplementation(((cb: any) => {
      settingsCallback = cb;
      return () => {};
    }) as any);

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.setupHomeSettingsListeners();

    const customizeBtn = document.getElementById('home-customize-btn')!;
    customizeBtn.click();

    const qaToggle = document.getElementById('home-toggle-quick-access') as HTMLInputElement;
    expect(qaToggle.checked).toBe(true);

    settingsCallback!({ showQuickAccess: false });

    expect(qaToggle.checked).toBe(false);
  });
});
