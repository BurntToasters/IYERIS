import type { Settings } from './types';
import type { ToastAction } from './rendererToasts.js';
import { rendererPath as path } from './rendererUtils.js';

type ClipboardState = { operation: 'copy' | 'cut'; paths: string[] } | null;

type ClipboardDeps = {
  getSelectedItems: () => Set<string>;
  getCurrentPath: () => string;
  getFileElementMap: () => Map<string, HTMLElement>;
  getCurrentSettings: () => Settings;
  showToast: (
    message: string,
    title: string,
    type: 'success' | 'error' | 'info' | 'warning',
    actions?: ToastAction[]
  ) => void;
  handleDrop: (
    sourcePaths: string[],
    destPath: string,
    operation: 'copy' | 'move'
  ) => Promise<void>;
  refresh: () => void;
  updateUndoRedoState: () => Promise<void>;
};

export function createClipboardController(deps: ClipboardDeps) {
  let clipboard: ClipboardState = null;
  let cutPaths = new Set<string>();
  let elIndicator: HTMLElement | null = null;
  let elIndicatorText: HTMLElement | null = null;

  function getRetryActions(retry?: () => void): ToastAction[] | undefined {
    if (!retry) return undefined;
    return [{ label: 'Retry', onClick: () => void retry() }];
  }

  function isPermissionDeniedError(message?: string): boolean {
    if (!message) return false;
    const value = message.toLowerCase();
    return (
      value.includes('eacces') ||
      value.includes('eperm') ||
      value.includes('permission denied') ||
      value.includes('operation not permitted') ||
      value.includes('access is denied') ||
      value.includes('not authorized')
    );
  }

  async function getSystemClipboardData(): Promise<{
    operation: 'copy' | 'cut';
    paths: string[];
  } | null> {
    try {
      const data =
        typeof window.electronAPI.getSystemClipboardData === 'function'
          ? await window.electronAPI.getSystemClipboardData()
          : {
              operation: 'copy' as const,
              paths: await window.electronAPI.getSystemClipboardFiles(),
            };

      if (!data || !Array.isArray(data.paths) || data.paths.length === 0) {
        return null;
      }

      return {
        operation: data.operation === 'cut' ? 'cut' : 'copy',
        paths: data.paths,
      };
    } catch {
      return null;
    }
  }

  async function pasteSystemClipboard(destPath: string, retry?: () => void): Promise<boolean> {
    const systemClipboard = await getSystemClipboardData();
    if (!systemClipboard || systemClipboard.paths.length === 0) {
      return false;
    }

    const conflictBehavior = deps.getCurrentSettings().fileConflictBehavior || 'ask';
    const retryActions = getRetryActions(retry);

    if (systemClipboard.operation === 'cut') {
      const moveResult = await window.electronAPI.moveItems(
        systemClipboard.paths,
        destPath,
        conflictBehavior
      );
      if (moveResult.success) {
        deps.showToast(
          `${systemClipboard.paths.length} item(s) moved from system clipboard`,
          'Success',
          'success'
        );
        deps.refresh();
        return true;
      }

      if (isPermissionDeniedError(moveResult.error)) {
        const copyResult = await window.electronAPI.copyItems(
          systemClipboard.paths,
          destPath,
          conflictBehavior
        );
        if (!copyResult.success) {
          deps.showToast(copyResult.error || 'Paste failed', 'Error', 'error', retryActions);
          return true;
        }
        deps.showToast(
          `${systemClipboard.paths.length} item(s) copied from system clipboard; couldn't remove originals`,
          'Permission Required',
          'warning'
        );
        deps.refresh();
        return true;
      }

      deps.showToast(moveResult.error || 'Paste failed', 'Error', 'error', retryActions);
      return true;
    }

    const copyResult = await window.electronAPI.copyItems(
      systemClipboard.paths,
      destPath,
      conflictBehavior
    );
    if (!copyResult.success) {
      deps.showToast(copyResult.error || 'Paste failed', 'Error', 'error', retryActions);
      return true;
    }

    deps.showToast(
      `${systemClipboard.paths.length} item(s) pasted from system clipboard`,
      'Success',
      'success'
    );
    deps.refresh();
    return true;
  }

  async function updateClipboardIndicator() {
    if (!elIndicator) elIndicator = document.getElementById('clipboard-indicator');
    if (!elIndicatorText) elIndicatorText = document.getElementById('clipboard-text');
    const indicator = elIndicator;
    const indicatorText = elIndicatorText;
    if (!indicator || !indicatorText) return;

    if (clipboard && clipboard.paths.length > 0) {
      const count = clipboard.paths.length;
      const operation = clipboard.operation === 'cut' ? 'cut' : 'copied';
      indicatorText.textContent = `${count} ${operation}`;
      indicator.classList.toggle('cut-mode', clipboard.operation === 'cut');
      indicator.style.display = 'inline-flex';
    } else {
      if (deps.getCurrentSettings().globalClipboard !== false) {
        const systemClipboard = await getSystemClipboardData();
        if (systemClipboard && systemClipboard.paths.length > 0) {
          indicatorText.textContent =
            systemClipboard.operation === 'cut'
              ? `${systemClipboard.paths.length} from system (cut)`
              : `${systemClipboard.paths.length} from system`;
          indicator.classList.toggle('cut-mode', systemClipboard.operation === 'cut');
          indicator.style.display = 'inline-flex';
          return;
        }
      }
      indicator.style.display = 'none';
    }
  }

  function setClipboardSelection(operation: 'copy' | 'cut'): void {
    const selectedItems = deps.getSelectedItems();
    if (selectedItems.size === 0) return;
    clipboard = {
      operation,
      paths: Array.from(selectedItems),
    };
    window.electronAPI.setClipboard(clipboard);
    updateCutVisuals();
    updateClipboardIndicator();
    deps.showToast(
      `${selectedItems.size} item(s) ${operation === 'cut' ? 'cut' : 'copied'}`,
      'Clipboard',
      'success'
    );
  }

  function copyToClipboard() {
    setClipboardSelection('copy');
  }

  function cutToClipboard() {
    setClipboardSelection('cut');
  }

  async function moveSelectedToFolder(): Promise<void> {
    const selectedItems = deps.getSelectedItems();
    if (selectedItems.size === 0) return;
    const result = await window.electronAPI.selectFolder();
    if (!result.success) return;

    const destPath = result.path;
    const sourcePaths = Array.from(selectedItems);
    const alreadyInDest = sourcePaths.some((sourcePath) => {
      const parentDir = path.dirname(sourcePath);
      return parentDir === destPath || sourcePath === destPath;
    });

    if (alreadyInDest) {
      deps.showToast('Items are already in this directory', 'Info', 'info');
      return;
    }

    await deps.handleDrop(sourcePaths, destPath, 'move');
  }

  async function copySelectedToFolder(): Promise<void> {
    const selectedItems = deps.getSelectedItems();
    if (selectedItems.size === 0) return;
    const result = await window.electronAPI.selectFolder();
    if (!result.success) return;

    const destPath = result.path;
    const sourcePaths = Array.from(selectedItems);
    const alreadyInDest = sourcePaths.some((sourcePath) => {
      const parentDir = path.dirname(sourcePath);
      return parentDir === destPath || sourcePath === destPath;
    });

    if (alreadyInDest) {
      deps.showToast('Items are already in this directory', 'Info', 'info');
      return;
    }

    await deps.handleDrop(sourcePaths, destPath, 'copy');
  }

  async function pasteIntoFolder(folderPath: string): Promise<void> {
    if (!folderPath) return;

    try {
      if (!clipboard || clipboard.paths.length === 0) {
        const currentSettings = deps.getCurrentSettings();
        if (currentSettings.globalClipboard !== false) {
          const handled = await pasteSystemClipboard(folderPath);
          if (handled) {
            return;
          }
        }
        return;
      }

      const isCopy = clipboard.operation === 'copy';
      const conflictBehavior = deps.getCurrentSettings().fileConflictBehavior || 'ask';
      const result = isCopy
        ? await window.electronAPI.copyItems(clipboard.paths, folderPath, conflictBehavior)
        : await window.electronAPI.moveItems(clipboard.paths, folderPath, conflictBehavior);

      if (!result.success) {
        deps.showToast(result.error || 'Operation failed', 'Error', 'error');
        return;
      }
      deps.showToast(
        `${clipboard.paths.length} item(s) ${isCopy ? 'copied' : 'moved'} into folder`,
        'Success',
        'success'
      );

      if (!isCopy) {
        await deps.updateUndoRedoState();
        clipboard = null;
        window.electronAPI.setClipboard(null);
        updateClipboardIndicator();
      }

      updateCutVisuals();
      deps.refresh();
    } catch {
      deps.showToast('Paste operation failed', 'Error', 'error');
    }
  }

  async function duplicateItems(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const currentPath = deps.getCurrentPath();

    try {
      const conflictBehavior = 'rename' as const;
      const result = await window.electronAPI.copyItems(paths, currentPath, conflictBehavior);
      if (!result.success) {
        deps.showToast(result.error || 'Duplicate failed', 'Error', 'error');
        return;
      }
      deps.showToast(`${paths.length} item(s) duplicated`, 'Success', 'success');
      deps.refresh();
    } catch {
      deps.showToast('Duplicate failed', 'Error', 'error');
    }
  }

  async function pasteFromClipboard() {
    const currentPath = deps.getCurrentPath();
    if (!currentPath) return;

    try {
      if (!clipboard || clipboard.paths.length === 0) {
        const currentSettings = deps.getCurrentSettings();
        if (currentSettings.globalClipboard !== false) {
          const handled = await pasteSystemClipboard(currentPath, () => void pasteFromClipboard());
          if (handled) {
            return;
          }
        }
        return;
      }

      const isCopy = clipboard.operation === 'copy';
      const conflictBehavior = deps.getCurrentSettings().fileConflictBehavior || 'ask';
      const result = isCopy
        ? await window.electronAPI.copyItems(clipboard.paths, currentPath, conflictBehavior)
        : await window.electronAPI.moveItems(clipboard.paths, currentPath, conflictBehavior);

      if (!result.success) {
        deps.showToast(result.error || 'Operation failed', 'Error', 'error', [
          { label: 'Retry', onClick: () => void pasteFromClipboard() },
        ]);
        return;
      }
      deps.showToast(
        `${clipboard.paths.length} item(s) ${isCopy ? 'copied' : 'moved'}`,
        'Success',
        'success'
      );

      if (!isCopy) {
        await deps.updateUndoRedoState();
        clipboard = null;
        window.electronAPI.setClipboard(null);
        updateClipboardIndicator();
      }

      updateCutVisuals();
      deps.refresh();
    } catch {
      deps.showToast('Paste operation failed', 'Error', 'error', [
        { label: 'Retry', onClick: () => void pasteFromClipboard() },
      ]);
    }
  }

  function updateCutVisuals() {
    const fileElementMap = deps.getFileElementMap();
    const nextCutPaths = new Set(clipboard && clipboard.operation === 'cut' ? clipboard.paths : []);

    for (const itemPath of cutPaths) {
      if (!nextCutPaths.has(itemPath)) {
        fileElementMap.get(itemPath)?.classList.remove('cut');
      }
    }

    for (const itemPath of nextCutPaths) {
      const element = fileElementMap.get(itemPath);
      if (element) {
        element.classList.add('cut');
      }
    }

    cutPaths = nextCutPaths;
  }

  return {
    updateClipboardIndicator,
    setClipboardSelection,
    copyToClipboard,
    cutToClipboard,
    moveSelectedToFolder,
    copySelectedToFolder,
    pasteFromClipboard,
    pasteIntoFolder,
    duplicateItems,
    updateCutVisuals,
    getClipboard: () => clipboard,
    setClipboard: (value: ClipboardState) => {
      clipboard = value;
    },
    clearCutPaths: () => {
      cutPaths.clear();
    },
  };
}
