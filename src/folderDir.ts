import type { FileItem } from './types';

type DragOperation = 'copy' | 'move';
type DropIndicatorAction = 'copy' | 'move' | 'add';

type DirectoryContentsResult = {
  success: boolean;
  contents?: FileItem[];
  error?: string;
};

type ParsePathResult = {
  segments: string[];
  isWindows: boolean;
  isUnc: boolean;
};

interface FolderTreeDependencies {
  folderTree: HTMLElement | null;
  nameCollator: Intl.Collator;
  getFolderIcon: (path: string) => string;
  getBasename: (path: string) => string;
  navigateTo: (path: string) => void | Promise<void>;
  handleDrop: (paths: string[], destPath: string, operation: DragOperation) => Promise<void>;
  getDraggedPaths: (event: DragEvent) => Promise<string[]>;
  getDragOperation: (event: DragEvent) => DragOperation;
  scheduleSpringLoad: (target: HTMLElement, action: () => void) => void;
  clearSpringLoad: (target?: HTMLElement) => void;
  showDropIndicator: (action: DropIndicatorAction, destPath: string, x: number, y: number) => void;
  hideDropIndicator: () => void;
  createDirectoryOperationId: (scope: string) => string;
  getDirectoryContents: (
    path: string,
    operationId: string,
    showHidden: boolean
  ) => Promise<DirectoryContentsResult>;
  parsePath: (path: string) => ParsePathResult;
  buildPathFromSegments: (
    segments: string[],
    index: number,
    isWindows: boolean,
    isUnc: boolean
  ) => string;
  getCurrentPath: () => string;
  shouldShowHidden: () => boolean;
}

type TreeNode = {
  item: HTMLElement;
  children: HTMLElement;
  depth: number;
};

export interface FolderTreeManager {
  render: (drives: string[]) => void;
  ensurePathVisible: (targetPath: string) => Promise<void>;
  updateSelection: (currentPath: string) => void;
}

export function createFolderTreeManager(deps: FolderTreeDependencies): FolderTreeManager {
  const {
    folderTree,
    nameCollator,
    getFolderIcon,
    getBasename,
    navigateTo,
    handleDrop,
    getDraggedPaths,
    getDragOperation,
    scheduleSpringLoad,
    clearSpringLoad,
    showDropIndicator,
    hideDropIndicator,
    createDirectoryOperationId,
    getDirectoryContents,
    parsePath,
    buildPathFromSegments,
    getCurrentPath,
    shouldShowHidden,
  } = deps;

  const folderTreeNodeMap = new Map<string, TreeNode>();
  const folderTreeExpandedPaths = new Set<string>();
  const loadingPaths = new Set<string>();
  let focusedTreePath: string | null = null;

  if (!folderTree) {
    return {
      render: () => {},
      ensurePathVisible: async () => {},
      updateSelection: () => {},
    };
  }

  const getVisibleTreeItems = (): HTMLElement[] =>
    Array.from(folderTree.querySelectorAll<HTMLElement>('.tree-item')).filter(
      (item) => item.offsetParent !== null
    );

  const setTreeItemFocus = (item: HTMLElement | null, shouldFocus: boolean) => {
    if (!item) return;
    const current = folderTree.querySelector<HTMLElement>('.tree-item[tabindex="0"]');
    if (current && current !== item) {
      current.tabIndex = -1;
    }
    item.tabIndex = 0;
    focusedTreePath = item.dataset.path || null;
    if (shouldFocus) {
      item.focus({ preventScroll: true });
      item.scrollIntoView({ block: 'nearest' });
    }
  };

  const getParentPath = (nodePath: string): string | null => {
    const { segments, isWindows, isUnc } = parsePath(nodePath);
    if (segments.length <= 1) return null;
    return buildPathFromSegments(segments, segments.length - 2, isWindows, isUnc);
  };

  const createTreeNode = (
    nodePath: string,
    depth: number
  ): { item: HTMLElement; children: HTMLElement } => {
    const item = document.createElement('div');
    item.className = 'tree-item';
    item.dataset.path = nodePath;
    item.dataset.expanded = 'false';
    item.setAttribute('role', 'treeitem');
    item.setAttribute('aria-expanded', 'false');
    item.setAttribute('aria-level', String(depth + 1));
    item.tabIndex = -1;
    item.style.setProperty('--tree-item-depth', String(depth));

    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    toggle.textContent = '\u25B8';

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.innerHTML = getFolderIcon(nodePath);

    const label = document.createElement('span');
    label.className = 'tree-label';
    const labelText = getBasename(nodePath) || nodePath;
    label.textContent = labelText;
    item.setAttribute('aria-label', labelText);

    item.appendChild(toggle);
    item.appendChild(icon);
    item.appendChild(label);

    const children = document.createElement('div');
    children.className = 'tree-children';
    children.setAttribute('role', 'group');

    folderTreeNodeMap.set(nodePath, { item, children, depth });

    item.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('tree-toggle')) {
        toggleTreeNode(nodePath);
        return;
      }
      void navigateTo(nodePath);
      setTreeItemFocus(item, true);
    });

    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void navigateTo(nodePath);
        return;
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        const node = folderTreeNodeMap.get(nodePath);
        const isExpanded = node?.item.dataset.expanded === 'true';
        if (!isExpanded) {
          void toggleTreeNode(nodePath, true);
          return;
        }
        const items = getVisibleTreeItems();
        const index = items.indexOf(item);
        if (index >= 0 && index < items.length - 1) {
          setTreeItemFocus(items[index + 1], true);
        }
        return;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const node = folderTreeNodeMap.get(nodePath);
        const isExpanded = node?.item.dataset.expanded === 'true';
        if (isExpanded) {
          void toggleTreeNode(nodePath, false);
          return;
        }
        const parentPath = getParentPath(nodePath);
        if (parentPath) {
          const parentNode = folderTreeNodeMap.get(parentPath);
          if (parentNode) setTreeItemFocus(parentNode.item, true);
        }
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = getVisibleTreeItems();
        const index = items.indexOf(item);
        if (index === -1) return;
        const nextIndex = e.key === 'ArrowDown' ? index + 1 : index - 1;
        if (nextIndex >= 0 && nextIndex < items.length) {
          setTreeItemFocus(items[nextIndex], true);
        }
        return;
      }

      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const items = getVisibleTreeItems();
        if (items.length === 0) return;
        const target = e.key === 'Home' ? items[0] : items[items.length - 1];
        setTreeItemFocus(target, true);
      }
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const operation = getDragOperation(e);
      e.dataTransfer!.dropEffect = operation;
      item.classList.add('drag-over');
      showDropIndicator(operation, nodePath, e.clientX, e.clientY);
      scheduleSpringLoad(item, () => {
        item.classList.remove('drag-over', 'spring-loading');
        void toggleTreeNode(nodePath, true);
        void navigateTo(nodePath);
      });
    });

    item.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = item.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX >= rect.right ||
        e.clientY < rect.top ||
        e.clientY >= rect.bottom
      ) {
        item.classList.remove('drag-over');
        clearSpringLoad(item);
        hideDropIndicator();
      }
    });

    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove('drag-over');
      clearSpringLoad(item);
      const draggedPaths = await getDraggedPaths(e);
      if (draggedPaths.length === 0) {
        hideDropIndicator();
        return;
      }
      if (draggedPaths.includes(nodePath)) {
        hideDropIndicator();
        return;
      }
      const operation = getDragOperation(e);
      await handleDrop(draggedPaths, nodePath, operation);
      hideDropIndicator();
    });

    return { item, children };
  };

  const toggleTreeNode = async (nodePath: string, forceExpand: boolean = false): Promise<void> => {
    const node = folderTreeNodeMap.get(nodePath);
    if (!node) return;
    const isExpanded = node.item.dataset.expanded === 'true';
    const shouldExpand = forceExpand ? true : !isExpanded;

    if (!shouldExpand) {
      node.item.dataset.expanded = 'false';
      node.item.setAttribute('aria-expanded', 'false');
      const toggle = node.item.querySelector('.tree-toggle');
      if (toggle) toggle.textContent = '\u25B8';
      folderTreeExpandedPaths.delete(nodePath);
      return;
    }

    node.item.dataset.expanded = 'true';
    node.item.setAttribute('aria-expanded', 'true');
    const toggle = node.item.querySelector('.tree-toggle');
    if (toggle) toggle.textContent = '\u25BE';
    folderTreeExpandedPaths.add(nodePath);

    if (node.item.dataset.loaded === 'true') {
      return;
    }

    if (loadingPaths.has(nodePath)) return;
    loadingPaths.add(nodePath);

    node.children.innerHTML =
      '<div class="tree-item" style="opacity: 0.6; padding-left: 12px;">Loading...</div>';

    const operationId = createDirectoryOperationId('tree');
    let result: DirectoryContentsResult;
    try {
      result = await getDirectoryContents(nodePath, operationId, shouldShowHidden());
    } catch {
      node.children.innerHTML =
        '<div class="tree-item" style="opacity: 0.6; padding-left: 12px;">Failed to load</div>';
      loadingPaths.delete(nodePath);
      return;
    }

    if (!result.success) {
      node.children.innerHTML =
        '<div class="tree-item" style="opacity: 0.6; padding-left: 12px;">Failed to load</div>';
      loadingPaths.delete(nodePath);
      return;
    }

    const items = (result.contents || []).filter(
      (entry) => entry.isDirectory && (shouldShowHidden() || !entry.isHidden)
    );
    items.sort((a, b) => nameCollator.compare(a.name, b.name));

    node.children.innerHTML = '';

    if (items.length === 0) {
      node.children.innerHTML =
        '<div class="tree-item" style="opacity: 0.6; padding-left: 12px;">Empty</div>';
    } else {
      items.forEach((child) => {
        const { item, children } = createTreeNode(child.path, node.depth + 1);
        node.children.appendChild(item);
        node.children.appendChild(children);
      });
    }

    node.item.dataset.loaded = 'true';
    loadingPaths.delete(nodePath);
  };

  const render = (drives: string[]): void => {
    folderTree.innerHTML = '';
    folderTreeNodeMap.clear();
    folderTreeExpandedPaths.clear();

    drives.forEach((drive) => {
      const { item, children } = createTreeNode(drive, 0);
      folderTree.appendChild(item);
      folderTree.appendChild(children);
    });

    const firstItem = folderTree.querySelector<HTMLElement>('.tree-item');
    if (firstItem) {
      setTreeItemFocus(firstItem, false);
    }

    const currentPath = getCurrentPath();
    if (currentPath) {
      void ensurePathVisible(currentPath);
    }
  };

  const updateSelection = (currentPath: string): void => {
    if (!currentPath) return;
    folderTree.querySelectorAll('.tree-item.active').forEach((item) => {
      item.classList.remove('active');
      item.removeAttribute('aria-current');
    });
    const node = folderTreeNodeMap.get(currentPath);
    if (node) {
      node.item.classList.add('active');
      node.item.setAttribute('aria-current', 'true');
      if (!focusedTreePath || focusedTreePath === currentPath) {
        setTreeItemFocus(node.item, false);
      }
    }
  };

  const ensurePathVisible = async (targetPath: string): Promise<void> => {
    if (!targetPath) return;
    const { segments, isWindows, isUnc } = parsePath(targetPath);
    const ancestorPaths: string[] = [];
    if (!isWindows && !isUnc) {
      ancestorPaths.push('/');
    }
    segments.forEach((_, index) => {
      ancestorPaths.push(buildPathFromSegments(segments, index, isWindows, isUnc));
    });

    for (const pathValue of ancestorPaths) {
      if (!folderTreeNodeMap.has(pathValue)) {
        continue;
      }
      await toggleTreeNode(pathValue, true);
    }

    updateSelection(targetPath);
  };

  return {
    render,
    ensurePathVisible,
    updateSelection,
  };
}
