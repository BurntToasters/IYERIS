/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFolderTreeManager } from './folderDir';

function createParsePath(pathValue: string) {
  if (pathValue === '/') {
    return { segments: [], isWindows: false, isUnc: false };
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

function createTreeDeps(
  getDirectoryContentsMock: (
    path: string,
    operationId: string,
    showHidden: boolean
  ) => Promise<{
    success: boolean;
    contents?: Array<{
      path: string;
      name: string;
      isDirectory: boolean;
      isFile: boolean;
      size: number;
      modified: Date;
      isHidden: boolean;
    }>;
    error?: string;
  }>
) {
  const folderTree = document.getElementById('folder-tree');
  const getDirectoryContents = (
    path: string,
    operationId: string,
    showHidden: boolean
  ): Promise<{
    success: boolean;
    contents?: Array<{
      path: string;
      name: string;
      isDirectory: boolean;
      isFile: boolean;
      size: number;
      modified: Date;
      isHidden: boolean;
    }>;
    error?: string;
  }> => getDirectoryContentsMock(path, operationId, showHidden);

  const deps = {
    folderTree,
    nameCollator: new Intl.Collator('en'),
    getFolderIcon: () => '📁',
    getBasename: (value: string) => value.split('/').filter(Boolean).pop() || '/',
    navigateTo: vi.fn(),
    handleDrop: vi.fn().mockResolvedValue(undefined),
    getDraggedPaths: vi.fn().mockResolvedValue(['/source.txt']),
    getDragOperation: vi.fn().mockReturnValue('move'),
    scheduleSpringLoad: vi.fn(),
    clearSpringLoad: vi.fn(),
    showDropIndicator: vi.fn(),
    hideDropIndicator: vi.fn(),
    createDirectoryOperationId: vi.fn().mockReturnValue('op-tree'),
    getDirectoryContents,
    parsePath: createParsePath,
    buildPathFromSegments,
    getCurrentPath: vi.fn().mockReturnValue('/'),
    shouldShowHidden: vi.fn().mockReturnValue(false),
  };

  return deps;
}

describe('createFolderTreeManager', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="folder-tree"></div>';
  });

  it('renders drives and focuses the first tree item', () => {
    const getDirectoryContents = vi.fn().mockResolvedValue({ success: true, contents: [] });
    const deps = createTreeDeps(getDirectoryContents);
    const manager = createFolderTreeManager(deps);

    manager.render(['/']);

    const firstItem = document.querySelector('.tree-item') as HTMLElement;
    expect(firstItem).toBeTruthy();
    expect(firstItem.getAttribute('data-path')).toBe('/');
    expect(firstItem.tabIndex).toBe(0);
  });

  it('expands a node and loads child directories', async () => {
    const getDirectoryContents = vi.fn().mockResolvedValue({
      success: true,
      contents: [
        {
          path: '/docs',
          name: 'docs',
          isDirectory: true,
          isFile: false,
          size: 0,
          modified: new Date(),
          isHidden: false,
        },
        {
          path: '/notes.txt',
          name: 'notes.txt',
          isDirectory: false,
          isFile: true,
          size: 12,
          modified: new Date(),
          isHidden: false,
        },
      ],
    });
    const deps = createTreeDeps(getDirectoryContents);
    const manager = createFolderTreeManager(deps);
    manager.render(['/']);

    const rootToggle = document.querySelector('.tree-item .tree-toggle') as HTMLElement;
    rootToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(getDirectoryContents).toHaveBeenCalledWith('/', 'op-tree', false);
    expect(document.querySelector('.tree-item[data-path="/docs"]')).toBeTruthy();
  });

  it('routes drop events to handleDrop with destination path', async () => {
    const getDirectoryContents = vi.fn().mockResolvedValue({ success: true, contents: [] });
    const deps = createTreeDeps(getDirectoryContents);
    const manager = createFolderTreeManager(deps);
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

    expect(deps.handleDrop).toHaveBeenCalledWith(['/source.txt'], '/', 'move');
  });

  it('ensures target path is visible and marks it active', async () => {
    const getDirectoryContents = vi.fn(async (pathValue: string) => {
      if (pathValue === '/') {
        return {
          success: true,
          contents: [
            {
              path: '/a',
              name: 'a',
              isDirectory: true,
              isFile: false,
              size: 0,
              modified: new Date(),
              isHidden: false,
            },
          ],
        };
      }
      if (pathValue === '/a') {
        return {
          success: true,
          contents: [
            {
              path: '/a/b',
              name: 'b',
              isDirectory: true,
              isFile: false,
              size: 0,
              modified: new Date(),
              isHidden: false,
            },
          ],
        };
      }
      return { success: true, contents: [] };
    });

    const deps = createTreeDeps(getDirectoryContents);
    const manager = createFolderTreeManager(deps);
    manager.render(['/']);
    await manager.ensurePathVisible('/a/b');

    expect(getDirectoryContents).toHaveBeenCalledWith('/', 'op-tree', false);
    expect(getDirectoryContents).toHaveBeenCalledWith('/a', 'op-tree', false);
    expect(
      document.querySelector('.tree-item[data-path="/a/b"]')?.classList.contains('active')
    ).toBe(true);
  });
});
