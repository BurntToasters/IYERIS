// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createFolderTreeManager } from '../folderDir';

const mockGetDirectoryContents = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ success: true, contents: [] })
);
const mockNavigateTo = vi.hoisted(() => vi.fn());
const mockHandleDrop = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGetDraggedPaths = vi.hoisted(() => vi.fn().mockResolvedValue(['/source.txt']));
const mockGetDragOperation = vi.hoisted(() => vi.fn().mockReturnValue('move' as const));
const mockScheduleSpringLoad = vi.hoisted(() => vi.fn());
const mockClearSpringLoad = vi.hoisted(() => vi.fn());
const mockShowDropIndicator = vi.hoisted(() => vi.fn());
const mockHideDropIndicator = vi.hoisted(() => vi.fn());
const mockShouldShowHidden = vi.hoisted(() => vi.fn().mockReturnValue(false));

function createParsePath(pathValue: string) {
  if (pathValue === '/') {
    return { segments: [] as string[], isWindows: false, isUnc: false };
  }
  const segments = pathValue.split('/').filter(Boolean);
  return { segments, isWindows: false, isUnc: false };
}

function buildPathFromSegments(
  segments: string[],
  index: number,
  _isWindows: boolean,
  _isUnc: boolean
) {
  if (index < 0 || segments.length === 0) return '/';
  return `/${segments.slice(0, index + 1).join('/')}`;
}

function makeDirEntry(
  path: string,
  name: string,
  isHidden = false
): {
  path: string;
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modified: Date;
  isHidden: boolean;
} {
  return {
    path,
    name,
    isDirectory: true,
    isFile: false,
    size: 0,
    modified: new Date(),
    isHidden,
  };
}

function createDeps(overrides: Record<string, unknown> = {}) {
  const folderTree = document.getElementById('folder-tree');
  return {
    folderTree,
    nameCollator: new Intl.Collator('en'),
    getFolderIcon: () => '📁',
    getBasename: (v: string) => v.split('/').filter(Boolean).pop() || '/',
    navigateTo: mockNavigateTo,
    handleDrop: mockHandleDrop,
    getDraggedPaths: mockGetDraggedPaths,
    getDragOperation: mockGetDragOperation,
    scheduleSpringLoad: mockScheduleSpringLoad,
    clearSpringLoad: mockClearSpringLoad,
    showDropIndicator: mockShowDropIndicator,
    hideDropIndicator: mockHideDropIndicator,
    createDirectoryOperationId: vi.fn().mockReturnValue('op-tree'),
    getDirectoryContents: mockGetDirectoryContents,
    parsePath: createParsePath,
    buildPathFromSegments,
    getCurrentPath: vi.fn().mockReturnValue('/'),
    shouldShowHidden: mockShouldShowHidden,
    ...overrides,
  };
}

async function renderWithChildren() {
  mockGetDirectoryContents.mockResolvedValue({
    success: true,
    contents: [makeDirEntry('/alpha', 'alpha'), makeDirEntry('/beta', 'beta')],
  });

  const deps = createDeps({ getCurrentPath: vi.fn().mockReturnValue('') });
  const manager = createFolderTreeManager(deps as any);
  manager.render(['/']);

  const rootToggle = document.querySelector(
    '.tree-item[data-path="/"] .tree-toggle'
  ) as HTMLElement;
  rootToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await vi.waitFor(() => {
    expect(document.querySelector('.tree-item[data-path="/alpha"]')).toBeTruthy();
  });

  patchOffsetParent();

  return { manager, deps };
}

function patchOffsetParent() {
  document.querySelectorAll<HTMLElement>('.tree-item').forEach((el) => {
    if (!el.dataset.path) return;
    Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  });
}

describe('folderDir extended coverage', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="folder-tree"></div>';

    Element.prototype.scrollIntoView = vi.fn();
    vi.clearAllMocks();
    mockGetDirectoryContents.mockResolvedValue({ success: true, contents: [] });
    mockShouldShowHidden.mockReturnValue(false);
    mockGetDraggedPaths.mockResolvedValue(['/source.txt']);
    mockGetDragOperation.mockReturnValue('move');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('null folderTree guard', () => {
    it('returns a noop manager when folderTree is null', async () => {
      const deps = createDeps({ folderTree: null });
      const manager = createFolderTreeManager(deps as any);

      expect(() => manager.render(['/'])).not.toThrow();
      expect(() => manager.updateSelection('/')).not.toThrow();
      await expect(manager.ensurePathVisible('/foo')).resolves.toBeUndefined();
    });
  });

  describe('keyboard navigation', () => {
    it('ArrowRight expands a collapsed node', async () => {
      mockGetDirectoryContents.mockResolvedValue({ success: true, contents: [] });
      const deps = createDeps({ getCurrentPath: vi.fn().mockReturnValue('') });
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      expect(rootItem.dataset.expanded).toBe('false');

      rootItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await Promise.resolve();

      expect(rootItem.dataset.expanded).toBe('true');
    });

    it('ArrowRight moves to first child when already expanded', async () => {
      await renderWithChildren();

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;

      expect(rootItem.dataset.expanded).toBe('true');

      rootItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

      const alphaItem = document.querySelector('.tree-item[data-path="/alpha"]') as HTMLElement;
      expect(alphaItem.tabIndex).toBe(0);
    });

    it('ArrowLeft collapses an expanded node', async () => {
      await renderWithChildren();

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      expect(rootItem.dataset.expanded).toBe('true');

      rootItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      await Promise.resolve();

      expect(rootItem.dataset.expanded).toBe('false');
    });

    it('ArrowLeft moves focus to parent when node is collapsed', async () => {
      await renderWithChildren();

      const alphaItem = document.querySelector('.tree-item[data-path="/alpha"]') as HTMLElement;
      alphaItem.tabIndex = 0;

      alphaItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      expect(rootItem.tabIndex).toBe(0);
    });

    it('ArrowDown moves focus to the next visible item', async () => {
      await renderWithChildren();

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      rootItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

      const alphaItem = document.querySelector('.tree-item[data-path="/alpha"]') as HTMLElement;
      expect(alphaItem.tabIndex).toBe(0);
    });

    it('ArrowUp moves focus to the previous visible item', async () => {
      await renderWithChildren();

      const alphaItem = document.querySelector('.tree-item[data-path="/alpha"]') as HTMLElement;

      alphaItem.tabIndex = 0;
      alphaItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      expect(rootItem.tabIndex).toBe(0);
    });

    it('ArrowDown does nothing when at the last item', async () => {
      await renderWithChildren();

      const betaItem = document.querySelector('.tree-item[data-path="/beta"]') as HTMLElement;
      betaItem.tabIndex = 0;
      betaItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

      expect(betaItem.tabIndex).toBe(0);
    });

    it('ArrowUp does nothing when at the first item', async () => {
      await renderWithChildren();

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      rootItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));

      expect(rootItem.tabIndex).toBe(0);
    });

    it('Home key focuses the first visible item', async () => {
      await renderWithChildren();

      const betaItem = document.querySelector('.tree-item[data-path="/beta"]') as HTMLElement;
      betaItem.tabIndex = 0;
      betaItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      expect(rootItem.tabIndex).toBe(0);
    });

    it('End key focuses the last visible item', async () => {
      await renderWithChildren();

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      rootItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));

      const betaItem = document.querySelector('.tree-item[data-path="/beta"]') as HTMLElement;
      expect(betaItem.tabIndex).toBe(0);
    });

    it('Enter key navigates to the node path', async () => {
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      rootItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(mockNavigateTo).toHaveBeenCalledWith('/');
    });

    it('Space key navigates to the node path', async () => {
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      rootItem.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

      expect(mockNavigateTo).toHaveBeenCalledWith('/');
    });
  });

  describe('drag/drop handlers', () => {
    it('dragover sets dropEffect, adds drag-over class, and schedules spring load', () => {
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;

      const dragEvent = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(dragEvent, 'dataTransfer', {
        value: { dropEffect: '' },
        writable: true,
      });
      Object.defineProperty(dragEvent, 'clientX', { value: 50 });
      Object.defineProperty(dragEvent, 'clientY', { value: 60 });

      rootItem.dispatchEvent(dragEvent);

      expect((dragEvent as any).dataTransfer.dropEffect).toBe('move');
      expect(rootItem.classList.contains('drag-over')).toBe(true);
      expect(mockShowDropIndicator).toHaveBeenCalledWith('move', '/', 50, 60);
      expect(mockScheduleSpringLoad).toHaveBeenCalled();
    });

    it('dragleave removes drag-over class when pointer exits bounds', () => {
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      rootItem.classList.add('drag-over');

      rootItem.getBoundingClientRect = () =>
        ({
          left: 0,
          right: 100,
          top: 0,
          bottom: 50,
          width: 100,
          height: 50,
          x: 0,
          y: 0,
          toJSON: () => {},
        }) as DOMRect;

      const dragLeaveEvent = new Event('dragleave', {
        bubbles: true,
        cancelable: true,
      }) as DragEvent;

      Object.defineProperty(dragLeaveEvent, 'clientX', { value: 150 });
      Object.defineProperty(dragLeaveEvent, 'clientY', { value: 25 });

      rootItem.dispatchEvent(dragLeaveEvent);

      expect(rootItem.classList.contains('drag-over')).toBe(false);
      expect(mockClearSpringLoad).toHaveBeenCalledWith(rootItem);
      expect(mockHideDropIndicator).toHaveBeenCalled();
    });

    it('dragleave does NOT remove drag-over class when pointer is still inside', () => {
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      rootItem.classList.add('drag-over');

      rootItem.getBoundingClientRect = () =>
        ({
          left: 0,
          right: 100,
          top: 0,
          bottom: 50,
          width: 100,
          height: 50,
          x: 0,
          y: 0,
          toJSON: () => {},
        }) as DOMRect;

      const dragLeaveEvent = new Event('dragleave', {
        bubbles: true,
        cancelable: true,
      }) as DragEvent;
      Object.defineProperty(dragLeaveEvent, 'clientX', { value: 50 });
      Object.defineProperty(dragLeaveEvent, 'clientY', { value: 25 });

      rootItem.dispatchEvent(dragLeaveEvent);

      expect(rootItem.classList.contains('drag-over')).toBe(true);
    });

    it('drop with self-reference guard hides indicator and skips handleDrop', async () => {
      mockGetDraggedPaths.mockResolvedValue(['/']);
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
      Object.assign(dropEvent, {
        dataTransfer: { dropEffect: 'move' },
        clientX: 10,
        clientY: 10,
      });

      rootItem.dispatchEvent(dropEvent);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockHandleDrop).not.toHaveBeenCalled();
      expect(mockHideDropIndicator).toHaveBeenCalled();
    });

    it('drop with empty dragged paths hides indicator and skips handleDrop', async () => {
      mockGetDraggedPaths.mockResolvedValue([]);
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
      Object.assign(dropEvent, {
        dataTransfer: { dropEffect: 'move' },
        clientX: 10,
        clientY: 10,
      });

      rootItem.dispatchEvent(dropEvent);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockHandleDrop).not.toHaveBeenCalled();
      expect(mockHideDropIndicator).toHaveBeenCalled();
    });

    it('drop clears drag-over class and springLoad', async () => {
      mockGetDraggedPaths.mockResolvedValue(['/other']);
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      rootItem.classList.add('drag-over');

      const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
      Object.assign(dropEvent, {
        dataTransfer: { dropEffect: 'move' },
        clientX: 10,
        clientY: 10,
      });

      rootItem.dispatchEvent(dropEvent);
      await Promise.resolve();
      await Promise.resolve();

      expect(rootItem.classList.contains('drag-over')).toBe(false);
      expect(mockClearSpringLoad).toHaveBeenCalledWith(rootItem);
    });
  });

  describe('toggleTreeNode collapse', () => {
    it('collapses an expanded node when toggle is clicked again', async () => {
      await renderWithChildren();

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      expect(rootItem.dataset.expanded).toBe('true');

      const rootToggle = rootItem.querySelector('.tree-toggle') as HTMLElement;
      rootToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();

      expect(rootItem.dataset.expanded).toBe('false');
      expect(rootItem.getAttribute('aria-expanded')).toBe('false');
      expect(rootToggle.textContent).toBe('\u25B8');
    });
  });

  describe('loading failure paths', () => {
    it('shows "Failed to load" when getDirectoryContents returns success: false', async () => {
      mockGetDirectoryContents.mockResolvedValue({
        success: false,
        error: 'EACCES',
      });
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootToggle = document.querySelector(
        '.tree-item[data-path="/"] .tree-toggle'
      ) as HTMLElement;
      rootToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await vi.waitFor(() => {
        const children = document.querySelector('.tree-children');
        expect(children?.textContent).toContain('Failed to load');
      });
    });

    it('shows "Failed to load" when getDirectoryContents throws an exception', async () => {
      mockGetDirectoryContents.mockRejectedValue(new Error('Network error'));
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootToggle = document.querySelector(
        '.tree-item[data-path="/"] .tree-toggle'
      ) as HTMLElement;
      rootToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await vi.waitFor(() => {
        const children = document.querySelector('.tree-children');
        expect(children?.textContent).toContain('Failed to load');
      });
    });
  });

  describe('empty directory placeholder', () => {
    it('shows "Empty" placeholder when directory has no subdirectories', async () => {
      mockGetDirectoryContents.mockResolvedValue({
        success: true,
        contents: [
          {
            path: '/file.txt',
            name: 'file.txt',
            isDirectory: false,
            isFile: true,
            size: 100,
            modified: new Date(),
            isHidden: false,
          },
        ],
      });
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootToggle = document.querySelector(
        '.tree-item[data-path="/"] .tree-toggle'
      ) as HTMLElement;
      rootToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await vi.waitFor(() => {
        const children = document.querySelector('.tree-children');
        expect(children?.textContent).toContain('Empty');
      });
    });

    it('shows "Empty" placeholder when contents array is empty', async () => {
      mockGetDirectoryContents.mockResolvedValue({
        success: true,
        contents: [],
      });
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootToggle = document.querySelector(
        '.tree-item[data-path="/"] .tree-toggle'
      ) as HTMLElement;
      rootToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await vi.waitFor(() => {
        const children = document.querySelector('.tree-children');
        expect(children?.textContent).toContain('Empty');
      });
    });
  });

  describe('hidden file filtering', () => {
    it('filters out hidden directories when shouldShowHidden returns false', async () => {
      mockShouldShowHidden.mockReturnValue(false);
      mockGetDirectoryContents.mockResolvedValue({
        success: true,
        contents: [
          makeDirEntry('/visible', 'visible', false),
          makeDirEntry('/.hidden', '.hidden', true),
        ],
      });
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootToggle = document.querySelector(
        '.tree-item[data-path="/"] .tree-toggle'
      ) as HTMLElement;
      rootToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await vi.waitFor(() => {
        expect(document.querySelector('.tree-item[data-path="/visible"]')).toBeTruthy();
      });

      expect(document.querySelector('.tree-item[data-path="/.hidden"]')).toBeNull();
    });

    it('shows hidden directories when shouldShowHidden returns true', async () => {
      mockShouldShowHidden.mockReturnValue(true);
      mockGetDirectoryContents.mockResolvedValue({
        success: true,
        contents: [
          makeDirEntry('/visible', 'visible', false),
          makeDirEntry('/.hidden', '.hidden', true),
        ],
      });
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootToggle = document.querySelector(
        '.tree-item[data-path="/"] .tree-toggle'
      ) as HTMLElement;
      rootToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await vi.waitFor(() => {
        expect(document.querySelector('.tree-item[data-path="/visible"]')).toBeTruthy();
        expect(document.querySelector('.tree-item[data-path="/.hidden"]')).toBeTruthy();
      });
    });
  });

  describe('focus management', () => {
    it('setTreeItemFocus updates tabindex and removes it from previous item', async () => {
      await renderWithChildren();

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      const alphaItem = document.querySelector('.tree-item[data-path="/alpha"]') as HTMLElement;

      expect(rootItem.tabIndex).toBe(0);

      alphaItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(alphaItem.tabIndex).toBe(0);
      expect(rootItem.tabIndex).toBe(-1);
    });

    it('getVisibleTreeItems only returns items with offsetParent !== null', async () => {
      await renderWithChildren();

      const betaItem = document.querySelector('.tree-item[data-path="/beta"]') as HTMLElement;
      betaItem.tabIndex = 0;
      betaItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      expect(rootItem.tabIndex).toBe(0);
    });

    it('clicking a tree item (non-toggle) navigates and focuses', () => {
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      const label = rootItem.querySelector('.tree-label') as HTMLElement;
      label.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(mockNavigateTo).toHaveBeenCalledWith('/');
      expect(rootItem.tabIndex).toBe(0);
    });
  });

  describe('updateSelection', () => {
    it('marks the matching node as active and sets aria-current', async () => {
      await renderWithChildren();
      const { manager } = await renderWithChildren();
      const alphaItem = document.querySelector('.tree-item[data-path="/alpha"]') as HTMLElement;

      manager.updateSelection('/alpha');

      expect(alphaItem.classList.contains('active')).toBe(true);
      expect(alphaItem.getAttribute('aria-current')).toBe('true');
    });

    it('removes active class from previously active node', async () => {
      const { manager } = await renderWithChildren();

      manager.updateSelection('/alpha');
      const alphaItem = document.querySelector('.tree-item[data-path="/alpha"]') as HTMLElement;
      expect(alphaItem.classList.contains('active')).toBe(true);

      manager.updateSelection('/beta');
      expect(alphaItem.classList.contains('active')).toBe(false);

      const betaItem = document.querySelector('.tree-item[data-path="/beta"]') as HTMLElement;
      expect(betaItem.classList.contains('active')).toBe(true);
    });

    it('does nothing for an empty currentPath', async () => {
      const { manager } = await renderWithChildren();

      expect(() => manager.updateSelection('')).not.toThrow();
    });
  });

  describe('render edge cases', () => {
    it('renders multiple drives', () => {
      mockGetDirectoryContents.mockResolvedValue({ success: true, contents: [] });
      const deps = createDeps({ getCurrentPath: vi.fn().mockReturnValue('') });
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/', '/mnt/data']);

      const items = document.querySelectorAll('.tree-item');
      expect(items.length).toBe(2);
      expect((items[0] as HTMLElement).dataset.path).toBe('/');
      expect((items[1] as HTMLElement).dataset.path).toBe('/mnt/data');
    });

    it('clears previous tree on re-render', async () => {
      const { manager } = await renderWithChildren();
      expect(document.querySelectorAll('.tree-item').length).toBeGreaterThan(1);

      mockGetDirectoryContents.mockResolvedValue({ success: true, contents: [] });
      manager.render(['/new']);

      const items = document.querySelectorAll('.tree-item');
      expect(items.length).toBe(1);
      expect((items[0] as HTMLElement).dataset.path).toBe('/new');
    });
  });

  describe('loading indicator', () => {
    it('shows "Loading..." while getDirectoryContents is pending', async () => {
      let resolveContents!: (value: unknown) => void;
      mockGetDirectoryContents.mockReturnValue(
        new Promise((resolve) => {
          resolveContents = resolve;
        })
      );
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootToggle = document.querySelector(
        '.tree-item[data-path="/"] .tree-toggle'
      ) as HTMLElement;
      rootToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await Promise.resolve();
      const children = document.querySelector('.tree-children');
      expect(children?.textContent).toContain('Loading...');

      resolveContents({ success: true, contents: [] });
      await vi.waitFor(() => {
        expect(children?.textContent).toContain('Empty');
      });
    });
  });

  describe('sorting', () => {
    it('sorts child directories alphabetically using nameCollator', async () => {
      mockGetDirectoryContents.mockResolvedValue({
        success: true,
        contents: [
          makeDirEntry('/zebra', 'zebra'),
          makeDirEntry('/apple', 'apple'),
          makeDirEntry('/mango', 'mango'),
        ],
      });
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootToggle = document.querySelector(
        '.tree-item[data-path="/"] .tree-toggle'
      ) as HTMLElement;
      rootToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await vi.waitFor(() => {
        const childItems = document.querySelectorAll('.tree-children .tree-item[data-path]');
        const paths = Array.from(childItems).map((el) => (el as HTMLElement).dataset.path);
        expect(paths).toEqual(['/apple', '/mango', '/zebra']);
      });
    });
  });

  describe('already loaded node', () => {
    it('does not reload children when the node was already loaded', async () => {
      const { manager } = await renderWithChildren();
      const callCountAfterFirstLoad = mockGetDirectoryContents.mock.calls.length;

      const rootToggle = document.querySelector(
        '.tree-item[data-path="/"] .tree-toggle'
      ) as HTMLElement;
      rootToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();

      rootToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();

      expect(mockGetDirectoryContents.mock.calls.length).toBe(callCountAfterFirstLoad);
    });
  });

  describe('dragover copy operation', () => {
    it('sets dropEffect to copy when getDragOperation returns copy', () => {
      mockGetDragOperation.mockReturnValue('copy');
      const deps = createDeps();
      const manager = createFolderTreeManager(deps as any);
      manager.render(['/']);

      const rootItem = document.querySelector('.tree-item[data-path="/"]') as HTMLElement;
      const dragEvent = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(dragEvent, 'dataTransfer', {
        value: { dropEffect: '' },
        writable: true,
      });
      Object.defineProperty(dragEvent, 'clientX', { value: 10 });
      Object.defineProperty(dragEvent, 'clientY', { value: 20 });

      rootItem.dispatchEvent(dragEvent);

      expect((dragEvent as any).dataTransfer.dropEffect).toBe('copy');
      expect(mockShowDropIndicator).toHaveBeenCalledWith('copy', '/', 10, 20);
    });
  });
});
