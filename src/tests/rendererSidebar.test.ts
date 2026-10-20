// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockElements = vi.hoisted(() => ({
  drivesList: document.createElement('div'),
  folderTree: document.createElement('div'),
}));

vi.mock('../rendererElements.js', () => ({
  drivesList: mockElements.drivesList,
  folderTree: mockElements.folderTree,
}));

import { createSidebarController } from '../rendererSidebar';
import { HOME_VIEW_PATH } from '../home';

type SidebarDeps = Parameters<typeof createSidebarController>[0];

function createDeps(overrides: Partial<SidebarDeps> = {}) {
  const settings = {
    showFolderTree: true,
  } as unknown as ReturnType<SidebarDeps['getCurrentSettings']>;
  return {
    getCurrentSettings: vi.fn(() => settings),
    navigateTo: vi.fn(),
    showToast: vi.fn(),
    getVisibleSidebarQuickAccessItems: vi.fn(() => [
      { action: 'userhome', label: 'Home Folder', icon: 'home' },
      { action: 'documents', label: 'Documents', icon: 'file' },
    ]),
    renderHomeDrives: vi.fn(),
    cacheDriveInfo: vi.fn(),
    renderFolderTree: vi.fn(),
    ...overrides,
  } satisfies SidebarDeps;
}

function keyboard(el: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

describe('rendererSidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    const grid = document.createElement('div');
    grid.id = 'sidebar-quick-access-grid';
    mockElements.drivesList.replaceChildren();
    mockElements.folderTree.replaceChildren();
    document.body.append(grid, mockElements.drivesList, mockElements.folderTree);
    (window as any).tauriAPI = {
      getHomeDirectory: vi.fn().mockResolvedValue('/home/user'),
      getSpecialDirectory: vi
        .fn()
        .mockResolvedValue({ success: true, path: '/home/user/Documents' }),
      selectFolder: vi.fn().mockResolvedValue({ success: true, path: '/picked' }),
      openTrash: vi.fn().mockResolvedValue({ success: true }),
      getDriveInfo: vi.fn().mockResolvedValue([]),
    };
  });

  describe('renderSidebarQuickAccess', () => {
    it('returns early when the quick access grid is missing', () => {
      document.getElementById('sidebar-quick-access-grid')!.remove();
      const deps = createDeps();
      const sidebar = createSidebarController(deps);

      expect(() => sidebar.renderSidebarQuickAccess()).not.toThrow();
      expect(document.querySelectorAll('.quick-action')).toHaveLength(0);
    });

    it('renders Home followed by visible quick access items', () => {
      const sidebar = createSidebarController(createDeps());
      sidebar.renderSidebarQuickAccess();

      const items = document.querySelectorAll<HTMLElement>('.quick-action');
      expect(items).toHaveLength(3);
      expect(items[0]!.dataset.action).toBe('home');
      expect(items[0]!.querySelector('.nav-label')?.textContent).toBe('Home');
      expect(items[1]!.dataset.action).toBe('userhome');
      expect(items[1]!.querySelector('.nav-label')?.textContent).toBe('Home Folder');
      expect(items[2]!.dataset.action).toBe('documents');
      expect(items[2]!.getAttribute('aria-label')).toBe('Navigate to Documents');
    });

    it('skips actions that are not part of the shipped quick access list', () => {
      const sidebar = createSidebarController(
        createDeps({
          getVisibleSidebarQuickAccessItems: () => [
            { action: 'documents', label: 'Documents', icon: 'file' },
            { action: 'unknown', label: 'Unknown', icon: 'help' },
          ],
        })
      );
      sidebar.renderSidebarQuickAccess();

      const actions = Array.from(
        document.querySelectorAll<HTMLElement>('.quick-action'),
        (item) => item.dataset.action
      );
      expect(actions).toEqual(['home', 'documents']);
    });

    it('replaces previous items on rerender', () => {
      const sidebar = createSidebarController(createDeps());
      sidebar.renderSidebarQuickAccess();
      sidebar.renderSidebarQuickAccess();

      expect(document.querySelectorAll('.quick-action')).toHaveLength(3);
    });

    it('navigates home on click and keyboard activation', () => {
      const deps = createDeps();
      const sidebar = createSidebarController(deps);
      sidebar.renderSidebarQuickAccess();
      const home = document.querySelector<HTMLElement>('.quick-action')!;

      home.click();
      expect(deps.navigateTo).toHaveBeenCalledWith(HOME_VIEW_PATH);

      keyboard(home, 'Enter');
      keyboard(home, ' ');
      expect(deps.navigateTo).toHaveBeenCalledTimes(3);
    });

    it('does not activate Home on unrelated keys', () => {
      const deps = createDeps();
      const sidebar = createSidebarController(deps);
      sidebar.renderSidebarQuickAccess();

      keyboard(document.querySelector<HTMLElement>('.quick-action')!, 'Tab');
      expect(deps.navigateTo).not.toHaveBeenCalled();
    });

    it('activates a quick access item by click and Enter', async () => {
      const deps = createDeps();
      const sidebar = createSidebarController(deps);
      sidebar.renderSidebarQuickAccess();
      const documents = document.querySelectorAll<HTMLElement>('.quick-action')[2]!;

      documents.click();
      await vi.waitFor(() => expect(deps.navigateTo).toHaveBeenCalledWith('/home/user/Documents'));

      keyboard(documents, 'Enter');
      await vi.waitFor(() => expect(deps.navigateTo).toHaveBeenCalledTimes(2));
    });
  });

  describe('handleQuickAction', () => {
    it('ignores an empty action', async () => {
      const deps = createDeps();
      const sidebar = createSidebarController(deps);

      await sidebar.handleQuickAction(null);
      await sidebar.handleQuickAction('');
      expect((window as any).tauriAPI.getHomeDirectory).not.toHaveBeenCalled();
      expect(deps.navigateTo).not.toHaveBeenCalled();
    });

    it('opens the user home directory', async () => {
      const deps = createDeps();
      const sidebar = createSidebarController(deps);

      await sidebar.handleQuickAction('userhome');

      expect(deps.navigateTo).toHaveBeenCalledWith('/home/user');
      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('shows an error when the home directory is unavailable', async () => {
      (window as any).tauriAPI.getHomeDirectory.mockResolvedValue('');
      const deps = createDeps();
      const sidebar = createSidebarController(deps);

      await sidebar.handleQuickAction('userhome');

      expect(deps.navigateTo).not.toHaveBeenCalled();
      expect(deps.showToast).toHaveBeenCalledWith(
        'Failed to open Home Folder',
        'Quick Access',
        'error'
      );
    });

    it('opens a special directory', async () => {
      const deps = createDeps();
      const sidebar = createSidebarController(deps);

      await sidebar.handleQuickAction('downloads');

      expect((window as any).tauriAPI.getSpecialDirectory).toHaveBeenCalledWith('downloads');
      expect(deps.navigateTo).toHaveBeenCalledWith('/home/user/Documents');
    });

    it('surfaces a special directory API error', async () => {
      (window as any).tauriAPI.getSpecialDirectory.mockResolvedValue({
        success: false,
        error: 'denied',
      });
      const deps = createDeps();
      const sidebar = createSidebarController(deps);

      await sidebar.handleQuickAction('music');

      expect(deps.navigateTo).not.toHaveBeenCalled();
      expect(deps.showToast).toHaveBeenCalledWith('denied', 'Quick Access', 'error');
    });

    it('uses a translated fallback when the special directory has no error text', async () => {
      (window as any).tauriAPI.getSpecialDirectory.mockResolvedValue({ success: false });
      const deps = createDeps();
      const sidebar = createSidebarController(deps);

      await sidebar.handleQuickAction('videos');

      expect(deps.showToast).toHaveBeenCalledWith(
        'Failed to open Videos folder',
        'Quick Access',
        'error'
      );
    });

    it('navigates to the folder chosen by the browse dialog', async () => {
      const deps = createDeps();
      const sidebar = createSidebarController(deps);

      await sidebar.handleQuickAction('browse');

      expect((window as any).tauriAPI.selectFolder).toHaveBeenCalled();
      expect(deps.navigateTo).toHaveBeenCalledWith('/picked');
    });

    it('does nothing when the browse dialog is cancelled', async () => {
      (window as any).tauriAPI.selectFolder.mockResolvedValue({ success: false });
      const deps = createDeps();
      const sidebar = createSidebarController(deps);

      await sidebar.handleQuickAction('browse');

      expect(deps.navigateTo).not.toHaveBeenCalled();
      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('opens trash and reports that it is opening', async () => {
      const deps = createDeps();
      const sidebar = createSidebarController(deps);

      await sidebar.handleQuickAction('trash');

      expect((window as any).tauriAPI.openTrash).toHaveBeenCalled();
      expect(deps.showToast).toHaveBeenCalledWith('Opening system trash folder', 'Info', 'info');
    });

    it('shows the trash API error when opening fails', async () => {
      (window as any).tauriAPI.openTrash.mockResolvedValue({ success: false, error: 'no trash' });
      const deps = createDeps();
      const sidebar = createSidebarController(deps);

      await sidebar.handleQuickAction('trash');

      expect(deps.showToast).toHaveBeenCalledWith('no trash', 'Error', 'error');
    });

    it('reports thrown bridge failures', async () => {
      (window as any).tauriAPI.getHomeDirectory.mockRejectedValue(new Error('bridge down'));
      const deps = createDeps();
      const sidebar = createSidebarController(deps);

      await sidebar.handleQuickAction('userhome');

      expect(deps.showToast).toHaveBeenCalledWith('bridge down', 'Quick Access', 'error');
    });
  });

  describe('loadDrives', () => {
    it('renders drives with labels, fallbacks, and folder tree', async () => {
      const drives = [
        { path: '/', label: 'Macintosh HD', total: 100, free: 50 },
        { path: '/Volumes/Data', label: '', total: 200, free: 20 },
      ];
      (window as any).tauriAPI.getDriveInfo.mockResolvedValue(drives);
      const deps = createDeps();
      const sidebar = createSidebarController(deps);

      await sidebar.loadDrives();

      const items = mockElements.drivesList.querySelectorAll<HTMLElement>('.nav-item');
      expect(items).toHaveLength(2);
      expect(items[0]!.getAttribute('aria-label')).toBe('Open Macintosh HD');
      expect(items[0]!.title).toBe('/');
      expect(items[1]!.querySelector('.nav-label')?.textContent).toBe('/Volumes/Data');
      expect(deps.cacheDriveInfo).toHaveBeenCalledWith(drives);
      expect(deps.renderHomeDrives).toHaveBeenCalledWith(drives);
      expect(deps.renderFolderTree).toHaveBeenCalledWith(['/', '/Volumes/Data']);
    });

    it('navigates a drive on click and keyboard activation', async () => {
      (window as any).tauriAPI.getDriveInfo.mockResolvedValue([
        { path: '/', label: 'Root', total: 100, free: 50 },
      ]);
      const deps = createDeps();
      const sidebar = createSidebarController(deps);
      await sidebar.loadDrives();

      const drive = mockElements.drivesList.querySelector<HTMLElement>('.nav-item')!;
      drive.click();
      keyboard(drive, 'Enter');
      keyboard(drive, ' ');
      keyboard(drive, 'Tab');

      expect(deps.navigateTo).toHaveBeenCalledTimes(3);
      expect(deps.navigateTo).toHaveBeenCalledWith('/');
    });

    it('clears the folder tree when folder trees are disabled', async () => {
      (window as any).tauriAPI.getDriveInfo.mockResolvedValue([
        { path: '/', label: 'Root', total: 100, free: 50 },
      ]);
      const deps = createDeps({
        getCurrentSettings: () => ({ showFolderTree: false }) as never,
      });
      mockElements.folderTree.innerHTML = '<div>stale</div>';
      const sidebar = createSidebarController(deps);

      await sidebar.loadDrives();

      expect(deps.renderFolderTree).not.toHaveBeenCalled();
      expect(mockElements.folderTree.children).toHaveLength(0);
    });

    it('reports drive loading failures', async () => {
      (window as any).tauriAPI.getDriveInfo.mockRejectedValue(new Error('no drives'));
      const deps = createDeps();
      const sidebar = createSidebarController(deps);

      await sidebar.loadDrives();

      expect(deps.showToast).toHaveBeenCalledWith('no drives', 'Drives', 'error');
    });
  });
});
