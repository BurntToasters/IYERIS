// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { Settings } from '../types';

describe('rendererStatusBar', () => {
  let deps: any;
  let currentSettings: Settings;
  let createStatusBarController: any;

  beforeAll(async () => {
    // Create all required DOM elements to satisfy top-level requireElement calls in rendererElements.ts
    // eslint-disable-next-line no-restricted-syntax -- static HTML test fixture, no user input
    document.body.innerHTML = `
      <input id="address-input" />
      <div id="file-grid"></div>
      <div id="file-view"></div>
      <div id="column-view"></div>
      <div id="home-view"></div>
      <div id="loading"></div>
      <div id="loading-text"></div>
      <div id="empty-state"></div>
      <button id="back-btn"></button>
      <button id="forward-btn"></button>
      <button id="up-btn"></button>
      <button id="refresh-btn"></button>
      <button id="new-file-btn"></button>
      <button id="new-folder-btn"></button>
      <button id="view-toggle-btn"></button>
      <div id="view-options"></div>
      <div id="list-header"></div>
      <div id="folder-tree"></div>
      <div id="sidebar-resize-handle"></div>
      <div id="drives-list"></div>
      <button id="sort-btn"></button>
      <div id="bookmarks-list"></div>
      <button id="bookmark-add-btn"></button>
      <div id="drop-indicator"></div>
      <div id="drop-indicator-action"></div>
      <div id="drop-indicator-path"></div>
      <div id="preview-resize-handle"></div>
      <button id="selection-copy-btn"></button>
      <button id="selection-cut-btn"></button>
      <button id="selection-move-btn"></button>
      <button id="selection-rename-btn"></button>
      <button id="selection-delete-btn"></button>

      <div class="status-bar">
        <span id="status-items"></span>
        <span id="status-hidden" style="display: none"></span>
        <span id="status-selected" style="display: none"></span>
        <span id="selection-indicator" style="display: none">
          <span id="selection-count"></span>
        </span>
        <span id="status-search" style="display: none">
          <span id="status-search-text"></span>
        </span>
        <div id="status-pane" style="display: none">
          <span id="status-pane-text"></span>
        </div>
        <div id="status-view-mode" style="display: none">
          <span id="status-view-mode-text"></span>
        </div>
        <span id="status-git-branch" style="display: none"></span>
        <span id="status-clipboard" style="display: none"></span>
      </div>
    `;

    const mod = await import('../rendererStatusBar');
    createStatusBarController = mod.createStatusBarController;
  });

  beforeEach(() => {
    // Reset individual display properties and texts before each test
    const els = [
      'status-items',
      'status-hidden',
      'status-selected',
      'selection-indicator',
      'selection-count',
      'status-search',
      'status-search-text',
      'status-pane',
      'status-pane-text',
      'status-view-mode',
      'status-view-mode-text',
      'status-git-branch',
      'status-clipboard',
    ];

    els.forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.style.display = id.includes('items') ? 'inline' : 'none';
        el.textContent = '';
      }
    });

    currentSettings = {
      theme: 'default',
      viewMode: 'grid',
      sortBy: 'name',
      sortOrder: 'asc',
      showHiddenFiles: false,
      dualPaneEnabled: false,
      activePane: 'left',
      statusBarItems: {
        items: true,
        selected: true,
        hidden: true,
        search: true,
        pane: true,
        viewMode: true,
        gitBranch: true,
        clipboard: true,
      },
    } as any;

    deps = {
      getCurrentSettings: () => currentSettings,
      getSelectedItems: vi.fn(() => new Set<string>()),
      getAllFiles: vi.fn(() => []),
      getSecondaryPaneItems: vi.fn(() => []),
      getSelectedItemsSizeBytes: vi.fn(() => 0),
      getHiddenFilesCount: vi.fn(() => 0),
      getCurrentPath: vi.fn(() => '/home'),
      getViewMode: vi.fn(() => 'grid'),
      getSearchStatusText: vi.fn(() => ({ active: false, text: '' })),
      syncDualPaneControls: vi.fn(),
      updateUtilitySelection: vi.fn(),
      saveSettings: vi.fn(),
      updateGitBranch: vi.fn(),
      updateClipboardIndicator: vi.fn(),
    };
  });

  it('updates status bar item count correctly', () => {
    deps.getAllFiles.mockReturnValue([{ name: 'a' }, { name: 'b' }]);
    const ctrl = createStatusBarController(deps);
    ctrl.update();

    const statusItems = document.getElementById('status-items');
    expect(statusItems?.style.display).not.toBe('none');
    expect(statusItems?.textContent).toContain('2 items');
  });

  it('hides item count when disabled in settings', () => {
    currentSettings.statusBarItems!.items = false;
    deps.getAllFiles.mockReturnValue([{ name: 'a' }]);
    const ctrl = createStatusBarController(deps);
    ctrl.update();

    const statusItems = document.getElementById('status-items');
    expect(statusItems?.style.display).toBe('none');
  });

  it('displays selection info when items are selected', () => {
    deps.getSelectedItems.mockReturnValue(new Set(['/path/a']));
    deps.getSelectedItemsSizeBytes.mockReturnValue(2048);
    const ctrl = createStatusBarController(deps);
    ctrl.update();

    const statusSelected = document.getElementById('status-selected');
    expect(statusSelected?.style.display).not.toBe('none');
    expect(statusSelected?.textContent).toContain('1 selected');
    expect(statusSelected?.textContent).toContain('2 KB');
  });

  it('hides selection info when disabled in settings', () => {
    currentSettings.statusBarItems!.selected = false;
    deps.getSelectedItems.mockReturnValue(new Set(['/path/a']));
    const ctrl = createStatusBarController(deps);
    ctrl.update();

    const statusSelected = document.getElementById('status-selected');
    expect(statusSelected?.style.display).toBe('none');
  });

  it('displays hidden files count when showHiddenFiles is false and hidden count > 0', () => {
    deps.getHiddenFilesCount.mockReturnValue(3);
    const ctrl = createStatusBarController(deps);
    ctrl.update();

    const statusHidden = document.getElementById('status-hidden');
    expect(statusHidden?.style.display).not.toBe('none');
    expect(statusHidden?.textContent).toContain('3 hidden');
  });

  it('hides hidden files count when disabled in settings', () => {
    currentSettings.statusBarItems!.hidden = false;
    deps.getHiddenFilesCount.mockReturnValue(3);
    const ctrl = createStatusBarController(deps);
    ctrl.update();

    const statusHidden = document.getElementById('status-hidden');
    expect(statusHidden?.style.display).toBe('none');
  });

  it('handles right-click context menu and toggles settings correctly', () => {
    createStatusBarController(deps);
    const event = new MouseEvent('contextmenu', {
      clientX: 100,
      clientY: 100,
      bubbles: true,
      cancelable: true,
    });
    const statusBar = document.querySelector('.status-bar');
    statusBar?.dispatchEvent(event);

    const menu = document.querySelector('.status-bar-context-menu');
    expect(menu).toBeTruthy();

    const menuItems = menu?.querySelectorAll('.context-menu-item');
    expect(menuItems?.length).toBe(8);

    const firstItem = menuItems?.[0] as HTMLElement;
    firstItem.click();

    expect(deps.saveSettings).toHaveBeenCalled();
    expect(currentSettings.statusBarItems!.items).toBe(false);
  });

  it('refreshes owner-controlled indicators when re-enabled from context menu', () => {
    currentSettings.statusBarItems!.gitBranch = false;
    currentSettings.statusBarItems!.clipboard = false;
    createStatusBarController(deps);

    document.querySelector('.status-bar')?.dispatchEvent(
      new MouseEvent('contextmenu', {
        clientX: 100,
        clientY: 100,
        bubbles: true,
        cancelable: true,
      })
    );
    const gitMenu = Array.from(document.querySelectorAll('.context-menu-item')).find((item) =>
      item.textContent?.includes('Git Branch')
    ) as HTMLElement;
    gitMenu.click();

    expect(deps.updateGitBranch).toHaveBeenCalledWith('/home');

    document.querySelector('.status-bar')?.dispatchEvent(
      new MouseEvent('contextmenu', {
        clientX: 100,
        clientY: 100,
        bubbles: true,
        cancelable: true,
      })
    );
    const clipboardMenu = Array.from(document.querySelectorAll('.context-menu-item')).find((item) =>
      item.textContent?.includes('Clipboard')
    ) as HTMLElement;
    clipboardMenu.click();

    expect(deps.updateClipboardIndicator).toHaveBeenCalled();
  });
});
