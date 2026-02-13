import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { createHomeController, HOME_QUICK_ACCESS_ITEMS } from './home';

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
    <div id="home-settings-modal" style="display:none"></div>
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

function createOptions() {
  return {
    twemojiImg: vi.fn((_e: string, _c?: string) => '<img>'),
    showToast: vi.fn(),
    showConfirm: vi.fn(),
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

describe('createHomeController - normalizeHomeSettings via loadHomeSettings', () => {
  beforeEach(() => {
    createMinimalDom();
    (window as unknown as Record<string, unknown>).electronAPI = {
      getHomeSettings: vi.fn(),
      saveHomeSettings: vi.fn(),
      getDriveInfo: vi.fn(async () => []),
      getDiskSpace: vi.fn(async () => ({ success: false })),
      onHomeSettingsChanged: vi.fn(),
    };
  });

  it('loads and normalizes valid settings', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: {
        showQuickAccess: false,
        sectionOrder: ['drives', 'recents'],
        quickAccessOrder: ['trash', 'desktop'],
        pinnedRecents: ['/pinned'],
      },
    });

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    const hs = ctrl.getHomeSettings();
    expect(hs.showQuickAccess).toBe(false);

    expect(hs.sectionOrder).toContain('drives');
    expect(hs.sectionOrder).toContain('recents');
    expect(hs.sectionOrder).toContain('quick-access');
    expect(hs.sectionOrder).toContain('bookmarks');
    expect(hs.sectionOrder.length).toBe(4);

    expect(hs.quickAccessOrder[0]).toBe('trash');
    expect(hs.quickAccessOrder[1]).toBe('desktop');
    expect(hs.quickAccessOrder.length).toBe(HOME_QUICK_ACCESS_ITEMS.length);
    expect(hs.pinnedRecents).toEqual(['/pinned']);
  });

  it('handles null settings from API', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({ success: true, settings: null });

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    const hs = ctrl.getHomeSettings();
    expect(hs.showQuickAccess).toBe(true);
    expect(hs.sectionOrder.length).toBe(4);
  });

  it('handles API failure', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({ success: false, error: 'disk error' });

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    const hs = ctrl.getHomeSettings();
    expect(hs.showQuickAccess).toBe(true);
  });

  it('handles API exception', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockRejectedValue(new Error('network'));

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    const hs = ctrl.getHomeSettings();
    expect(hs.showQuickAccess).toBe(true);
  });

  it('normalizes non-array sectionOrder', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { sectionOrder: 'not-an-array' },
    });

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    const hs = ctrl.getHomeSettings();
    expect(Array.isArray(hs.sectionOrder)).toBe(true);
    expect(hs.sectionOrder.length).toBe(4);
  });

  it('deduplicates sectionOrder', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { sectionOrder: ['drives', 'drives', 'recents', 'recents'] },
    });

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    const hs = ctrl.getHomeSettings();
    expect(hs.sectionOrder.filter((s: string) => s === 'drives').length).toBe(1);
    expect(hs.sectionOrder.length).toBe(4);
  });

  it('filters invalid sectionOrder entries', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { sectionOrder: ['nonsense', 'drives', 42] },
    });

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    const hs = ctrl.getHomeSettings();
    expect(hs.sectionOrder[0]).toBe('drives');
    expect(hs.sectionOrder.length).toBe(4);
  });

  it('normalizes non-array quickAccessOrder', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { quickAccessOrder: null },
    });

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    const hs = ctrl.getHomeSettings();
    expect(Array.isArray(hs.quickAccessOrder)).toBe(true);
    expect(hs.quickAccessOrder.length).toBe(HOME_QUICK_ACCESS_ITEMS.length);
  });

  it('deduplicates and validates hiddenQuickAccessItems', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: {
        hiddenQuickAccessItems: ['trash', 'trash', 'invalid-action', 'desktop'],
      },
    });

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    const hs = ctrl.getHomeSettings();
    expect(hs.hiddenQuickAccessItems).toEqual(['trash', 'desktop']);
  });

  it('normalizes non-array pinnedRecents', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { pinnedRecents: 'not-array' },
    });

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    const hs = ctrl.getHomeSettings();
    expect(Array.isArray(hs.pinnedRecents)).toBe(true);
    expect(hs.pinnedRecents.length).toBe(0);
  });

  it('deduplicates pinnedRecents and filters non-strings', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { pinnedRecents: ['/a', '/a', 42, '/b', null] },
    });

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    const hs = ctrl.getHomeSettings();
    expect(hs.pinnedRecents).toEqual(['/a', '/b']);
  });
});

describe('createHomeController - getVisibleSidebarQuickAccessItems', () => {
  beforeEach(() => {
    createMinimalDom();
    (window as unknown as Record<string, unknown>).electronAPI = {
      getHomeSettings: vi.fn(async () => ({ success: true, settings: {} })),
      saveHomeSettings: vi.fn(),
      getDriveInfo: vi.fn(async () => []),
      getDiskSpace: vi.fn(async () => ({ success: false })),
      onHomeSettingsChanged: vi.fn(),
    };
  });

  it('returns items in order with hidden removed', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: {
        sidebarQuickAccessOrder: ['trash', 'desktop', 'downloads'],
        hiddenSidebarQuickAccessItems: ['desktop'],
      },
    });

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    const items = ctrl.getVisibleSidebarQuickAccessItems();
    const actions = items.map((i) => i.action);

    expect(actions).toContain('trash');
    expect(actions).toContain('downloads');
    expect(actions).not.toContain('desktop');

    expect(actions[0]).toBe('trash');
  });

  it('returns all items when none hidden', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: {
        hiddenSidebarQuickAccessItems: [],
      },
    });

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    const items = ctrl.getVisibleSidebarQuickAccessItems();
    expect(items.length).toBe(HOME_QUICK_ACCESS_ITEMS.length);
  });
});

describe('createHomeController - renderHomeView', () => {
  beforeEach(() => {
    createMinimalDom();
    (window as unknown as Record<string, unknown>).electronAPI = {
      getHomeSettings: vi.fn(async () => ({ success: true, settings: {} })),
      saveHomeSettings: vi.fn(),
      getDriveInfo: vi.fn(async () => []),
      getDiskSpace: vi.fn(async () => ({ success: false })),
      onHomeSettingsChanged: vi.fn(),
    };
  });

  it('renders quick access items', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.renderHomeView();

    const qa = document.getElementById('home-quick-access')!;
    expect(qa.querySelectorAll('.home-item').length).toBeGreaterThan(0);
  });

  it('renders empty message when showQuickAccess is false', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { showQuickAccess: false },
    });

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.renderHomeQuickAccess();

    const qa = document.getElementById('home-quick-access')!;
    expect(qa.querySelectorAll('.home-item').length).toBe(0);
  });

  it('renders bookmarks from settings', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.renderHomeBookmarks();

    const bk = document.getElementById('home-bookmarks')!;
    expect(bk.querySelectorAll('.home-item').length).toBe(2);
  });

  it('shows empty message when no bookmarks', async () => {
    const opts = createOptions();
    opts.getSettings.mockReturnValue({ recentFiles: [], bookmarks: [] });
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.renderHomeBookmarks();

    const bk = document.getElementById('home-bookmarks')!;
    expect(bk.innerHTML).toContain('No bookmarks yet');
  });

  it('renders recents with pinned first', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { pinnedRecents: ['/c.txt'] },
    });

    const opts = createOptions();
    opts.getSettings.mockReturnValue({
      recentFiles: ['/a.txt', '/b.txt', '/c.txt'],
      bookmarks: [],
    });

    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.renderHomeRecents();

    const recents = document.getElementById('home-recents')!;
    const items = recents.querySelectorAll('.home-recent-item');
    expect(items.length).toBe(3);

    expect(items[0].getAttribute('data-recent-path')).toBe('/c.txt');
  });

  it('shows empty message when no recents', async () => {
    const opts = createOptions();
    opts.getSettings.mockReturnValue({ recentFiles: [], bookmarks: [] });
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.renderHomeRecents();

    const recents = document.getElementById('home-recents')!;
    expect(recents.innerHTML).toContain('No recent items yet');
  });

  it('caps recents to 10', async () => {
    const opts = createOptions();
    const paths = Array.from({ length: 15 }, (_, i) => `/file${i}.txt`);
    opts.getSettings.mockReturnValue({ recentFiles: paths, bookmarks: [] });
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.renderHomeRecents();

    const recents = document.getElementById('home-recents')!;
    expect(recents.querySelectorAll('.home-recent-item').length).toBe(10);
  });

  it('deduplicates pinned + recent paths', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { pinnedRecents: ['/a.txt'] },
    });

    const opts = createOptions();
    opts.getSettings.mockReturnValue({
      recentFiles: ['/a.txt', '/b.txt'],
      bookmarks: [],
    });

    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    ctrl.renderHomeRecents();

    const recents = document.getElementById('home-recents')!;
    const items = recents.querySelectorAll('.home-recent-item');
    expect(items.length).toBe(2);
  });
});

describe('createHomeController - closeHomeSettingsModal', () => {
  beforeEach(() => {
    createMinimalDom();
    (window as unknown as Record<string, unknown>).electronAPI = {
      getHomeSettings: vi.fn(async () => ({ success: true, settings: {} })),
      saveHomeSettings: vi.fn(),
      getDriveInfo: vi.fn(async () => []),
      getDiskSpace: vi.fn(async () => ({ success: false })),
      onHomeSettingsChanged: vi.fn(),
    };
  });

  it('closes modal with skipConfirmation', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    const modal = document.getElementById('home-settings-modal')!;
    modal.style.display = 'flex';

    await ctrl.closeHomeSettingsModal(true);
    expect(modal.style.display).toBe('none');
    expect(opts.onModalClose).toHaveBeenCalled();
  });

  it('closes modal when no unsaved changes', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    const modal = document.getElementById('home-settings-modal')!;
    modal.style.display = 'flex';

    await ctrl.closeHomeSettingsModal();
    expect(modal.style.display).toBe('none');
  });
});

describe('createHomeController - renderHomeDrives', () => {
  beforeEach(() => {
    createMinimalDom();
    (window as unknown as Record<string, unknown>).electronAPI = {
      getHomeSettings: vi.fn(async () => ({ success: true, settings: {} })),
      saveHomeSettings: vi.fn(),
      getDriveInfo: vi.fn(async () => []),
      getDiskSpace: vi.fn(async () => ({ success: false })),
      onHomeSettingsChanged: vi.fn(),
    };
  });

  it('renders drive items when given drives', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { showDiskUsage: false },
    });

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    await ctrl.renderHomeDrives([
      { path: '/dev/sda1', label: 'Linux' },
      { path: '/dev/sdb1', label: 'Data' },
    ] as Array<{ path: string; label: string }>);

    const drives = document.getElementById('home-drives')!;
    expect(drives.querySelectorAll('.home-item').length).toBe(2);
  });

  it('shows empty message when no drives', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    await ctrl.renderHomeDrives([]);

    const drives = document.getElementById('home-drives')!;
    expect(drives.innerHTML).toContain('No drives found');
  });

  it('shows disk usage cards when showDiskUsage is true', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { showDiskUsage: true },
    });
    api.getDiskSpace = vi.fn(async () => ({ success: true, total: 1000, free: 500 }));

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    await ctrl.renderHomeDrives([{ path: '/', label: 'Root' }] as Array<{
      path: string;
      label: string;
    }>);

    const drives = document.getElementById('home-drives')!;
    expect(drives.querySelectorAll('.home-drive-card').length).toBe(1);
  });

  it('hides drives section when showDrives is false', async () => {
    const api = window.electronAPI as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.getHomeSettings.mockResolvedValue({
      success: true,
      settings: { showDrives: false },
    });

    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();

    await ctrl.renderHomeDrives([{ path: '/' }] as any);

    const drives = document.getElementById('home-drives')!;
    expect(drives.innerHTML).toBe('');
  });
});

describe('createHomeController - setupHomeSettingsListeners', () => {
  beforeEach(() => {
    createMinimalDom();
    (window as unknown as Record<string, unknown>).electronAPI = {
      getHomeSettings: vi.fn(async () => ({ success: true, settings: {} })),
      saveHomeSettings: vi.fn(async () => ({ success: true })),
      getDriveInfo: vi.fn(async () => []),
      getDiskSpace: vi.fn(async () => ({ success: false })),
      onHomeSettingsChanged: vi.fn(),
    };
  });

  it('registers all event listeners without error', async () => {
    const opts = createOptions();
    const ctrl = createHomeController(
      opts as unknown as Parameters<typeof createHomeController>[0]
    );
    await ctrl.loadHomeSettings();
    expect(() => ctrl.setupHomeSettingsListeners()).not.toThrow();
  });
});
