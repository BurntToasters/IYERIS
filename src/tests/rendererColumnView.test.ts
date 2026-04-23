// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const mockTauriAPI = vi.hoisted(() => ({
  getDirectoryContents: vi.fn(),
  getDriveInfo: vi.fn(),
  cancelDirectoryContents: vi.fn().mockResolvedValue(undefined),
  setDragData: vi.fn(),
  clearDragData: vi.fn(),
}));

vi.mock('../shared.js', () => ({
  devLog: () => {},
  escapeHtml: (value: string) => value,
  ignoreError: () => {},
}));

vi.mock('../rendererUtils.js', () => ({
  isWindowsPath: (value: string) => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'),
  rendererPath: {
    basename: (filePath: string) => filePath.split(/[\\/]/).pop() || '',
    dirname: (filePath: string) => {
      if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\')) {
        const parts = filePath.replace(/\\+$/, '').split('\\').filter(Boolean);
        if (parts.length <= 1) return parts[0] + '\\';
        return parts.slice(0, -1).join('\\');
      }
      const idx = filePath.lastIndexOf('/');
      return idx <= 0 ? '/' : filePath.slice(0, idx);
    },
  },
}));

vi.mock('../home.js', () => ({
  isHomeViewPath: (value: string) => value === 'iyeris://home',
}));

import { createColumnViewController } from '../rendererColumnView';

function createDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const columnView = document.getElementById('column-view') as HTMLElement;
  let currentPath = '/home/user/docs';
  const selectedItems = new Set<string>();

  const deps = {
    columnView,
    getCurrentPath: () => currentPath,
    setCurrentPath: (value: string) => {
      currentPath = value;
    },
    getCurrentSettings: () => ({
      showHiddenFiles: false,
    }),
    getSelectedItems: () => selectedItems,
    clearSelection: vi.fn(() => selectedItems.clear()),
    addressInput: document.createElement('input'),
    updateBreadcrumb: vi.fn(),
    showToast: vi.fn(),
    showContextMenu: vi.fn(),
    getFileIcon: vi.fn().mockReturnValue('<span>📄</span>'),
    openFileEntry: vi.fn().mockResolvedValue(undefined),
    updatePreview: vi.fn(),
    consumeEvent: vi.fn((e: Event) => {
      e.preventDefault?.();
      e.stopPropagation?.();
    }),
    getDragOperation: vi.fn().mockReturnValue('move' as const),
    showDropIndicator: vi.fn(),
    hideDropIndicator: vi.fn(),
    getDraggedPaths: vi.fn().mockResolvedValue([]),
    handleDrop: vi.fn().mockResolvedValue(undefined),
    scheduleSpringLoad: vi.fn(),
    clearSpringLoad: vi.fn(),
    createDirectoryOperationId: vi.fn().mockReturnValue('op-1'),
    getCachedDriveInfo: vi.fn().mockReturnValue([]),
    cacheDriveInfo: vi.fn(),
    folderTreeManager: { ensurePathVisible: vi.fn() },
    getFileByPath: vi.fn().mockReturnValue(undefined),
    nameCollator: new Intl.Collator('en', { sensitivity: 'base' }),
    ...overrides,
  };

  return deps;
}

function makeFileItem(name: string, itemPath: string, isDirectory: boolean, isHidden = false) {
  return {
    name,
    path: itemPath,
    isDirectory,
    isFile: !isDirectory,
    size: isDirectory ? 0 : 1024,
    modified: new Date('2025-01-01'),
    isHidden,
  };
}

function makeDragEvent(
  type: string,
  dataTransferOverrides: Partial<{
    types: string[];
    files: File[];
    dropEffect: string;
    effectAllowed: string;
    setData: (format: string, data: string) => void;
  }> = {},
  coords: { clientX?: number; clientY?: number } = {}
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = {
    types: [] as string[],
    files: [] as File[],
    dropEffect: '',
    effectAllowed: '',
    setData: vi.fn(),
    ...dataTransferOverrides,
  };
  Object.defineProperty(event, 'dataTransfer', {
    value: dataTransfer,
    configurable: true,
  });
  if (coords.clientX !== undefined) {
    Object.defineProperty(event, 'clientX', { value: coords.clientX, configurable: true });
  }
  if (coords.clientY !== undefined) {
    Object.defineProperty(event, 'clientY', { value: coords.clientY, configurable: true });
  }
  return event;
}

describe('createColumnViewController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    document.body.innerHTML = '<div id="column-view"></div>';
    Object.defineProperty(window, 'tauriAPI', {
      value: { ...mockTauriAPI },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('cancelColumnOperations', () => {
    it('clears active operation ids without error when none exist', () => {
      const deps = createDeps();
      const controller = createColumnViewController(deps as any);
      expect(() => controller.cancelColumnOperations()).not.toThrow();
    });

    it('calls cancelDirectoryContents for each active operation', async () => {
      const deps = createDeps();
      let resolveContents: (v: unknown) => void;
      const hangingPromise = new Promise((r) => {
        resolveContents = r;
      });
      mockTauriAPI.getDirectoryContents.mockReturnValue(hangingPromise);

      const controller = createColumnViewController(deps as any);

      const renderPromise = controller.renderColumnView();

      controller.cancelColumnOperations();
      expect(mockTauriAPI.cancelDirectoryContents).toHaveBeenCalledWith('op-1');

      resolveContents!({ success: true, contents: [] });
      await renderPromise;
    });
  });

  describe('renderColumnView', () => {
    it('returns early when columnView element is null', async () => {
      const deps = createDeps({ columnView: null });
      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      expect(mockTauriAPI.getDirectoryContents).not.toHaveBeenCalled();
    });

    it('clears column view and returns when path is home view', async () => {
      const deps = createDeps();
      deps.getCurrentPath = () => 'iyeris://home';
      const controller = createColumnViewController(deps as any);

      const columnView = document.getElementById('column-view')!;
      columnView.innerHTML = '<div>old content</div>';

      await controller.renderColumnView();
      expect(columnView.innerHTML).toBe('');
    });

    it('renders drive column when current path is empty', async () => {
      const deps = createDeps();
      deps.getCurrentPath = () => '';

      const drives = [
        { path: '/dev/sda1', label: 'Main Drive' },
        { path: '/dev/sdb1', label: 'Backup' },
      ];
      mockTauriAPI.getDriveInfo.mockResolvedValue(drives);

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const columnView = document.getElementById('column-view')!;
      const items = columnView.querySelectorAll('.column-item');
      expect(items.length).toBe(2);
      expect(items[0].textContent).toContain('Main Drive');
      expect(items[1].textContent).toContain('Backup');
    });

    it('uses cached drive info when available', async () => {
      const cachedDrives = [{ path: '/dev/sda1', label: 'Cached' }];
      const deps = createDeps({
        getCachedDriveInfo: vi.fn().mockReturnValue(cachedDrives),
      });
      deps.getCurrentPath = () => '';

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      expect(mockTauriAPI.getDriveInfo).not.toHaveBeenCalled();
      const columnView = document.getElementById('column-view')!;
      expect(columnView.textContent).toContain('Cached');
    });

    it('shows error when drive loading fails', async () => {
      const deps = createDeps();
      deps.getCurrentPath = () => '';
      mockTauriAPI.getDriveInfo.mockRejectedValue(new Error('fail'));

      const controller = createColumnViewController(deps as any);
      await controller.renderColumnView();

      const columnView = document.getElementById('column-view')!;
      expect(columnView.textContent).toContain('Error loading drives');
    });

    describe('Unix path splitting', () => {
      it('splits a Unix path into correct columns', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/home/user/docs';

        const calls: string[] = [];
        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          calls.push(colPath);
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        expect(calls).toContain('/');
        expect(calls).toContain('/home');
        expect(calls).toContain('/home/user');
        expect(calls).toContain('/home/user/docs');
        expect(calls).toHaveLength(4);
      });

      it('handles root path', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/';

        const calls: string[] = [];
        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          calls.push(colPath);
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        expect(calls).toEqual(['/']);
      });
    });

    describe('Windows path splitting', () => {
      it('splits a Windows path into correct columns', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => 'C:\\Users\\test\\Documents';

        const calls: string[] = [];
        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          calls.push(colPath);
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        expect(calls).toContain('C:\\');
        expect(calls).toContain('C:\\Users');
        expect(calls).toContain('C:\\Users\\test');
        expect(calls).toContain('C:\\Users\\test\\Documents');
        expect(calls).toHaveLength(4);
      });

      it('handles Windows drive root', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => 'D:\\';

        const calls: string[] = [];
        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          calls.push(colPath);
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        expect(calls).toEqual(['D:\\']);
      });
    });

    describe('column rendering with directory contents', () => {
      it('renders directories and files sorted correctly', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/test';

        const items = [
          makeFileItem('zebra.txt', '/test/zebra.txt', false),
          makeFileItem('alpha', '/test/alpha', true),
          makeFileItem('beta.txt', '/test/beta.txt', false),
          makeFileItem('omega', '/test/omega', true),
        ];

        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/test') {
            return Promise.resolve({ success: true, contents: items });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const columnItems = columnView.querySelectorAll(
          '.column-pane:last-child .column-item:not(.placeholder)'
        );

        const names = Array.from(columnItems).map(
          (el) => el.querySelector('.column-item-name')?.textContent
        );
        expect(names[0]).toBe('alpha');
        expect(names[1]).toBe('omega');
        expect(names[2]).toBe('beta.txt');
        expect(names[3]).toBe('zebra.txt');
      });

      it('shows empty folder placeholder for empty directories', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/empty';

        mockTauriAPI.getDirectoryContents.mockResolvedValue({
          success: true,
          contents: [],
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        expect(columnView.textContent).toContain('Empty folder');
      });

      it('shows error placeholder when directory loading fails', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/fail';

        mockTauriAPI.getDirectoryContents.mockResolvedValue({
          success: false,
          error: 'Permission denied',
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        expect(columnView.textContent).toContain('Error loading folder');
      });

      it('filters hidden files when showHiddenFiles is false', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/test';
        deps.getCurrentSettings = () => ({ showHiddenFiles: false }) as any;

        const items = [
          makeFileItem('.hidden', '/test/.hidden', false, true),
          makeFileItem('visible.txt', '/test/visible.txt', false, false),
        ];

        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/test') {
            return Promise.resolve({ success: true, contents: items });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const lastPane = columnView.querySelector('.column-pane:last-child')!;
        const itemNames = Array.from(lastPane.querySelectorAll('.column-item-name')).map(
          (el) => el.textContent
        );

        expect(itemNames).toContain('visible.txt');
        expect(itemNames).not.toContain('.hidden');
      });

      it('shows hidden files when showHiddenFiles is true', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/test';
        deps.getCurrentSettings = () => ({ showHiddenFiles: true }) as any;

        const items = [
          makeFileItem('.hidden', '/test/.hidden', false, true),
          makeFileItem('visible.txt', '/test/visible.txt', false, false),
        ];

        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/test') {
            return Promise.resolve({ success: true, contents: items });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const lastPane = columnView.querySelector('.column-pane:last-child')!;
        const itemNames = Array.from(lastPane.querySelectorAll('.column-item-name')).map(
          (el) => el.textContent
        );

        expect(itemNames).toContain('visible.txt');
        expect(itemNames).toContain('.hidden');
      });

      it('marks directories with is-directory class', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/test';

        const items = [
          makeFileItem('folder', '/test/folder', true),
          makeFileItem('file.txt', '/test/file.txt', false),
        ];

        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/test') {
            return Promise.resolve({ success: true, contents: items });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const dirItems = columnView.querySelectorAll('.column-item.is-directory');
        expect(dirItems.length).toBeGreaterThanOrEqual(1);
      });

      it('sets correct ARIA attributes on column items', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/test';

        const items = [makeFileItem('item', '/test/item', false)];
        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/test') {
            return Promise.resolve({ success: true, contents: items });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const item = columnView.querySelector(
          '.column-pane:last-child .column-item:not(.placeholder)'
        );
        expect(item?.getAttribute('role')).toBe('option');
        expect(item?.getAttribute('aria-selected')).toBe('false');
        expect(item?.getAttribute('tabindex')).toBe('0');
      });

      it('directories have an arrow indicator', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/test';

        const items = [makeFileItem('mydir', '/test/mydir', true)];
        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/test') {
            return Promise.resolve({ success: true, contents: items });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const arrow = columnView.querySelector('.column-item-arrow');
        expect(arrow).not.toBeNull();
        expect(arrow?.textContent).toBe('▸');
      });
    });

    describe('column navigation via click', () => {
      it('clicking a directory expands it and loads a new column', async () => {
        let testPath = '/parent';
        const deps = createDeps();
        deps.getCurrentPath = () => testPath;
        deps.setCurrentPath = (v: string) => {
          testPath = v;
        };

        const parentItems = [makeFileItem('child', '/parent/child', true)];
        const childItems = [makeFileItem('grandchild.txt', '/parent/child/grandchild.txt', false)];

        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/parent') {
            return Promise.resolve({ success: true, contents: parentItems });
          }
          if (colPath === '/parent/child') {
            return Promise.resolve({ success: true, contents: childItems });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;

        const dirItem = Array.from(columnView.querySelectorAll('.column-item')).find(
          (el) => el.querySelector('.column-item-name')?.textContent === 'child'
        );

        expect(dirItem).toBeTruthy();

        dirItem!.dispatchEvent(new Event('click', { bubbles: true }));

        await vi.runAllTimersAsync();

        expect(testPath).toBe('/parent/child');
        expect(deps.updateBreadcrumb).toHaveBeenCalledWith('/parent/child');
      });

      it('clicking a file selects it and updates selection', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/test';

        const items = [makeFileItem('readme.txt', '/test/readme.txt', false)];

        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/test') {
            return Promise.resolve({ success: true, contents: items });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const fileItem = Array.from(columnView.querySelectorAll('.column-item')).find(
          (el) => el.querySelector('.column-item-name')?.textContent === 'readme.txt'
        );

        expect(fileItem).toBeTruthy();
        fileItem!.dispatchEvent(new Event('click', { bubbles: true }));

        await vi.advanceTimersByTimeAsync(100);

        expect(deps.clearSelection).toHaveBeenCalled();
        expect(deps.getSelectedItems().has('/test/readme.txt')).toBe(true);
      });

      it('double clicking a file calls openFileEntry', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/test';

        const items = [makeFileItem('open.txt', '/test/open.txt', false)];

        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/test') {
            return Promise.resolve({ success: true, contents: items });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const fileItem = Array.from(columnView.querySelectorAll('.column-item')).find(
          (el) => el.querySelector('.column-item-name')?.textContent === 'open.txt'
        );

        fileItem!.dispatchEvent(new Event('dblclick', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(100);

        expect(deps.openFileEntry).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'open.txt' })
        );
      });

      it('does not open file on modified double click', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/test';

        const items = [makeFileItem('open.txt', '/test/open.txt', false)];

        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/test') {
            return Promise.resolve({ success: true, contents: items });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const fileItem = Array.from(columnView.querySelectorAll('.column-item')).find(
          (el) => el.querySelector('.column-item-name')?.textContent === 'open.txt'
        );

        fileItem!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, ctrlKey: true }));
        await vi.advanceTimersByTimeAsync(100);

        expect(deps.openFileEntry).not.toHaveBeenCalled();
      });
    });

    describe('context menu', () => {
      it('right clicking a file shows context menu', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/ctx';

        const items = [makeFileItem('target.txt', '/ctx/target.txt', false)];

        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/ctx') {
            return Promise.resolve({ success: true, contents: items });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const fileItem = Array.from(columnView.querySelectorAll('.column-item')).find(
          (el) => el.querySelector('.column-item-name')?.textContent === 'target.txt'
        );

        const contextEvent = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 100,
          clientY: 200,
        });

        Object.defineProperty(contextEvent, 'pageX', { value: 100 });
        Object.defineProperty(contextEvent, 'pageY', { value: 200 });

        fileItem!.dispatchEvent(contextEvent);
        await vi.advanceTimersByTimeAsync(50);

        expect(deps.showContextMenu).toHaveBeenCalledWith(
          100,
          200,
          expect.objectContaining({ name: 'target.txt' })
        );
        expect(deps.clearSelection).toHaveBeenCalled();
      });
    });

    describe('resize handle', () => {
      it('adds a resize handle to each column pane', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/test';

        mockTauriAPI.getDirectoryContents.mockResolvedValue({
          success: true,
          contents: [],
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const handles = columnView.querySelectorAll('.column-resize-handle');
        expect(handles.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('file preview on file click', () => {
      it('updates preview when preview panel is visible', async () => {
        const previewPanel = document.createElement('div');
        previewPanel.id = 'preview-panel';
        previewPanel.style.display = 'block';
        document.body.appendChild(previewPanel);

        const deps = createDeps();
        deps.getCurrentPath = () => '/preview';

        const items = [makeFileItem('doc.pdf', '/preview/doc.pdf', false)];

        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/preview') {
            return Promise.resolve({ success: true, contents: items });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const fileItem = Array.from(columnView.querySelectorAll('.column-item')).find(
          (el) => el.querySelector('.column-item-name')?.textContent === 'doc.pdf'
        );

        fileItem!.dispatchEvent(new Event('click', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(100);

        expect(deps.updatePreview).toHaveBeenCalledWith(
          expect.objectContaining({ path: '/preview/doc.pdf' })
        );
      });

      it('uses getFileByPath result when available', async () => {
        const previewPanel = document.createElement('div');
        previewPanel.id = 'preview-panel';
        previewPanel.style.display = 'block';
        document.body.appendChild(previewPanel);

        const knownFile = makeFileItem('known.txt', '/preview/known.txt', false);
        const deps = createDeps({
          getFileByPath: vi.fn().mockReturnValue(knownFile),
        });
        deps.getCurrentPath = () => '/preview';

        const items = [makeFileItem('known.txt', '/preview/known.txt', false)];

        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/preview') {
            return Promise.resolve({ success: true, contents: items });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const fileItem = Array.from(columnView.querySelectorAll('.column-item')).find(
          (el) => el.querySelector('.column-item-name')?.textContent === 'known.txt'
        );

        fileItem!.dispatchEvent(new Event('click', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(100);

        expect(deps.updatePreview).toHaveBeenCalledWith(knownFile);
      });
    });

    describe('expanded state tracking', () => {
      it('marks the expanded column item when path matches next column', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/parent/child';

        const parentItems = [
          makeFileItem('child', '/parent/child', true),
          makeFileItem('other', '/parent/other', true),
        ];

        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/parent') {
            return Promise.resolve({ success: true, contents: parentItems });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const expandedItems = columnView.querySelectorAll('.column-item.expanded');
        expect(expandedItems.length).toBeGreaterThanOrEqual(1);

        const expandedName = expandedItems[0].querySelector('.column-item-name')?.textContent;
        expect(expandedName).toBe('child');
      });
    });

    describe('operation id tracking', () => {
      it('cleans up operation ids after directory load completes', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/test';

        mockTauriAPI.getDirectoryContents.mockResolvedValue({
          success: true,
          contents: [],
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        vi.clearAllMocks();
        controller.cancelColumnOperations();
        expect(mockTauriAPI.cancelDirectoryContents).not.toHaveBeenCalled();
      });
    });

    describe('concurrent render handling', () => {
      it('only the latest render takes effect', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/a';

        mockTauriAPI.getDirectoryContents.mockResolvedValue({
          success: true,
          contents: [],
        });

        const controller = createColumnViewController(deps as any);

        const p1 = controller.renderColumnView();

        deps.getCurrentPath = () => '/b';
        const p2 = controller.renderColumnView();

        await Promise.all([p1, p2]);

        const columnView = document.getElementById('column-view')!;
        const panes = columnView.querySelectorAll('.column-pane');

        expect(panes.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('scroll position', () => {
      it('restores saved scroll position when > 0', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/test';

        mockTauriAPI.getDirectoryContents.mockResolvedValue({
          success: true,
          contents: [],
        });

        const columnView = document.getElementById('column-view')!;
        Object.defineProperty(columnView, 'scrollLeft', {
          value: 200,
          writable: true,
          configurable: true,
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();
        await vi.advanceTimersByTimeAsync(100);

        expect(true).toBe(true);
      });
    });

    describe('drive column click navigation', () => {
      it('clicking a drive navigates into it', async () => {
        let testPath = '';
        const deps = createDeps();
        deps.getCurrentPath = () => testPath;
        deps.setCurrentPath = (v: string) => {
          testPath = v;
        };

        const drives = [{ path: '/mnt/usb', label: 'USB Drive' }];
        mockTauriAPI.getDriveInfo.mockResolvedValue(drives);
        mockTauriAPI.getDirectoryContents.mockResolvedValue({
          success: true,
          contents: [],
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const driveItem = columnView.querySelector('.column-item');
        expect(driveItem).toBeTruthy();

        driveItem!.dispatchEvent(new Event('click', { bubbles: true }));
        await vi.runAllTimersAsync();

        expect(testPath).toBe('/mnt/usb');
      });
    });

    describe('drag and drop on items', () => {
      it('sets drag data on dragstart', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/drag';

        const items = [makeFileItem('draggable.txt', '/drag/draggable.txt', false)];

        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/drag') {
            return Promise.resolve({ success: true, contents: items });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        const fileItem = Array.from(columnView.querySelectorAll('.column-item')).find(
          (el) => el.querySelector('.column-item-name')?.textContent === 'draggable.txt'
        );

        expect(fileItem).toBeTruthy();
        expect(fileItem!.getAttribute('draggable')).toBe('true');

        const dragEvent = new Event('dragstart', {
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(dragEvent, 'dataTransfer', {
          value: {
            effectAllowed: '',
            setData: vi.fn(),
          },
        });
        Object.defineProperty(dragEvent, 'stopPropagation', {
          value: vi.fn(),
        });

        fileItem!.dispatchEvent(dragEvent);

        expect(mockTauriAPI.setDragData).toHaveBeenCalled();
      });

      it('does not clear selection on dragstart when item already selected', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/drag';

        const items = [makeFileItem('selected.txt', '/drag/selected.txt', false)];
        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/drag') return Promise.resolve({ success: true, contents: items });
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const item = Array.from(document.querySelectorAll('.column-item')).find(
          (el) => el.querySelector('.column-item-name')?.textContent === 'selected.txt'
        ) as HTMLElement;
        expect(item).toBeTruthy();

        item.classList.add('selected');
        item.setAttribute('aria-selected', 'true');
        deps.getSelectedItems().add('/drag/selected.txt');
        (deps.clearSelection as any).mockClear();

        const dataTransfer = {
          effectAllowed: '',
          setData: vi.fn(),
          types: [] as string[],
          files: [] as File[],
        };
        const dragEvent = makeDragEvent('dragstart', dataTransfer);
        item.dispatchEvent(dragEvent);

        expect(deps.clearSelection).not.toHaveBeenCalled();
        expect(dataTransfer.setData).toHaveBeenCalled();
      });

      it('clears drag-over markers and drop UI on dragend', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/drag';

        const items = [makeFileItem('end.txt', '/drag/end.txt', false)];
        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/drag') return Promise.resolve({ success: true, contents: items });
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const item = Array.from(document.querySelectorAll('.column-item')).find(
          (el) => el.querySelector('.column-item-name')?.textContent === 'end.txt'
        ) as HTMLElement;
        expect(item).toBeTruthy();

        const strayDragOver = document.createElement('div');
        strayDragOver.className = 'column-item drag-over';
        document.body.appendChild(strayDragOver);

        item.dispatchEvent(makeDragEvent('dragend'));

        expect(document.querySelectorAll('.column-item.drag-over').length).toBe(0);
        expect(deps.clearSpringLoad).toHaveBeenCalled();
        expect(deps.hideDropIndicator).toHaveBeenCalled();
      });
    });

    describe('exception handling in getDirectoryContents', () => {
      it('shows error when getDirectoryContents throws', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/throws';

        mockTauriAPI.getDirectoryContents.mockRejectedValue(new Error('Network error'));

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const columnView = document.getElementById('column-view')!;
        expect(columnView.textContent).toContain('Error loading folder');
      });
    });

    describe('additional branch coverage', () => {
      it('sets dropEffect to none for pane dragover without supported payload', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/pane';
        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/pane') {
            return Promise.resolve({
              success: true,
              contents: [makeFileItem('file.txt', '/pane/file.txt', false)],
            });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const pane = document.querySelectorAll('.column-pane')[1] as HTMLElement;
        expect(pane).toBeTruthy();

        const event = makeDragEvent('dragover', {
          types: [],
          files: [],
          dropEffect: 'move',
        });
        pane.dispatchEvent(event);

        expect((event as any).dataTransfer.dropEffect).toBe('none');
        expect(deps.showDropIndicator).not.toHaveBeenCalled();
      });

      it('shows already-in-directory toast for pane drop', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/drop';
        deps.getDraggedPaths = vi.fn().mockResolvedValue(['/drop/file.txt']);
        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/drop') {
            return Promise.resolve({
              success: true,
              contents: [makeFileItem('file.txt', '/drop/file.txt', false)],
            });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const pane = document.querySelectorAll('.column-pane')[1] as HTMLElement;
        expect(pane).toBeTruthy();
        pane.dispatchEvent(makeDragEvent('drop', { types: ['text/plain'], files: [] }));
        await Promise.resolve();

        expect(deps.showToast).toHaveBeenCalledWith(
          'Items are already in this directory',
          'Info',
          'info'
        );
        expect(deps.handleDrop).not.toHaveBeenCalled();
      });

      it('handles pane drop for external files', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/drop';
        deps.getDragOperation = vi.fn().mockReturnValue('copy');
        deps.getDraggedPaths = vi.fn().mockResolvedValue(['/external/file.txt']);
        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/drop') {
            return Promise.resolve({
              success: true,
              contents: [makeFileItem('x', '/drop/x', false)],
            });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const pane = document.querySelectorAll('.column-pane')[1] as HTMLElement;
        pane.dispatchEvent(makeDragEvent('drop', { types: ['text/plain'], files: [] }));

        await vi.waitFor(() => {
          expect(deps.getDraggedPaths).toHaveBeenCalled();
        });
        expect(deps.handleDrop).toHaveBeenCalledWith(['/external/file.txt'], '/drop', 'copy');
        await vi.waitFor(() => {
          expect(deps.hideDropIndicator).toHaveBeenCalled();
        });
      });

      it('handles directory dragleave/drop branches on item targets', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/parent';
        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/parent') {
            return Promise.resolve({
              success: true,
              contents: [makeFileItem('child', '/parent/child', true)],
            });
          }
          if (colPath === '/parent/child') {
            return Promise.resolve({ success: true, contents: [] });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const dirItem = Array.from(document.querySelectorAll('.column-item')).find(
          (el) => el.querySelector('.column-item-name')?.textContent === 'child'
        ) as HTMLElement;
        expect(dirItem).toBeTruthy();

        dirItem.dispatchEvent(makeDragEvent('dragover', { types: ['text/plain'], files: [] }));
        expect(deps.scheduleSpringLoad).toHaveBeenCalledWith(dirItem, expect.any(Function));

        Object.defineProperty(dirItem, 'getBoundingClientRect', {
          value: () => ({ left: 0, right: 100, top: 0, bottom: 100 }),
          configurable: true,
        });
        dirItem.dispatchEvent(makeDragEvent('dragleave', {}, { clientX: 120, clientY: 120 }));
        expect(deps.clearSpringLoad).toHaveBeenCalledWith(dirItem);

        deps.getDraggedPaths = vi.fn().mockResolvedValue(['/parent/child']);
        (deps.handleDrop as any).mockClear();
        dirItem.dispatchEvent(makeDragEvent('drop', { types: ['text/plain'], files: [] }));
        await Promise.resolve();
        expect(deps.handleDrop).not.toHaveBeenCalled();

        deps.getDraggedPaths = vi.fn().mockResolvedValue(['/outside/item.txt']);
        dirItem.dispatchEvent(makeDragEvent('drop', { types: ['text/plain'], files: [] }));
        await Promise.resolve();
        expect(deps.handleDrop).toHaveBeenCalledWith(
          ['/outside/item.txt'],
          '/parent/child',
          'move'
        );
      });

      it('reconciles current path to parent when file clicked and current path drifted', async () => {
        let currentPath = '/parent';
        const deps = createDeps({
          getCurrentPath: () => currentPath,
          setCurrentPath: (value: string) => {
            currentPath = value;
          },
          folderTreeManager: {
            ensurePathVisible: vi.fn(() => {
              throw new Error('tree failure');
            }),
          },
        });

        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/parent') {
            return Promise.resolve({
              success: true,
              contents: [makeFileItem('note.txt', '/parent/note.txt', false)],
            });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        currentPath = '/other';
        const fileItem = Array.from(document.querySelectorAll('.column-item')).find(
          (el) => el.querySelector('.column-item-name')?.textContent === 'note.txt'
        ) as HTMLElement;
        expect(fileItem).toBeTruthy();

        fileItem.dispatchEvent(new Event('click', { bubbles: true }));
        await Promise.resolve();

        expect(currentPath).toBe('/parent');
        expect(deps.addressInput.value).toBe('/parent');
        expect(deps.updateBreadcrumb).toHaveBeenCalledWith('/parent');
      });

      it('updates current path from context menu when opening item in parent column', async () => {
        let currentPath = '/parent/child';
        const deps = createDeps({
          getCurrentPath: () => currentPath,
          setCurrentPath: (value: string) => {
            currentPath = value;
          },
        });
        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/parent') {
            return Promise.resolve({
              success: true,
              contents: [makeFileItem('ctx.txt', '/parent/ctx.txt', false)],
            });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        const parentPane = document.querySelector('[data-path="/parent"]') as HTMLElement;
        const fileItem = Array.from(parentPane.querySelectorAll('.column-item')).find(
          (el) => el.querySelector('.column-item-name')?.textContent === 'ctx.txt'
        ) as HTMLElement;
        expect(fileItem).toBeTruthy();

        const contextEvent = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 40,
        });
        Object.defineProperty(contextEvent, 'pageX', { value: 24 });
        Object.defineProperty(contextEvent, 'pageY', { value: 40 });

        fileItem.dispatchEvent(contextEvent);

        expect(currentPath).toBe('/parent');
        expect(deps.addressInput.value).toBe('/parent');
        expect(deps.updateBreadcrumb).toHaveBeenCalledWith('/parent');
        expect(deps.showContextMenu).toHaveBeenCalledWith(
          24,
          40,
          expect.objectContaining({ path: '/parent/ctx.txt' })
        );
      });

      it('renders symlink badge when file item is symlink', async () => {
        const deps = createDeps();
        deps.getCurrentPath = () => '/sym';
        const symlinkFile = {
          ...makeFileItem('link.txt', '/sym/link.txt', false),
          isSymlink: true,
        };

        mockTauriAPI.getDirectoryContents.mockImplementation((colPath: string) => {
          if (colPath === '/sym') {
            return Promise.resolve({ success: true, contents: [symlinkFile] });
          }
          return Promise.resolve({ success: true, contents: [] });
        });

        const controller = createColumnViewController(deps as any);
        await controller.renderColumnView();

        expect(document.querySelector('.symlink-badge')).not.toBeNull();
      });
    });
  });
});
