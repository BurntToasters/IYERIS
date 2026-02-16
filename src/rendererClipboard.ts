import type { Settings } from './types';
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
    type: 'success' | 'error' | 'info' | 'warning'
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

  async function updateClipboardIndicator() {
    const indicator = document.getElementById('clipboard-indicator');
    const indicatorText = document.getElementById('clipboard-text');
    if (!indicator || !indicatorText) return;

    if (clipboard && clipboard.paths.length > 0) {
      const count = clipboard.paths.length;
      const operation = clipboard.operation === 'cut' ? 'cut' : 'copied';
      indicatorText.textContent = `${count} ${operation}`;
      indicator.classList.toggle('cut-mode', clipboard.operation === 'cut');
      indicator.style.display = 'inline-flex';
    } else {
      if (deps.getCurrentSettings().globalClipboard !== false) {
        const systemFiles = await window.electronAPI.getSystemClipboardFiles();
        if (systemFiles && systemFiles.length > 0) {
          indicatorText.textContent = `${systemFiles.length} from system`;
          indicator.classList.remove('cut-mode');
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

  async function pasteFromClipboard() {
    const currentPath = deps.getCurrentPath();
    if (!currentPath) return;

    try {
      if (!clipboard || clipboard.paths.length === 0) {
        const currentSettings = deps.getCurrentSettings();
        if (currentSettings.globalClipboard !== false) {
          const systemFiles = await window.electronAPI.getSystemClipboardFiles();
          if (systemFiles && systemFiles.length > 0) {
            const result = await window.electronAPI.copyItems(
              systemFiles,
              currentPath,
              currentSettings.fileConflictBehavior || 'ask'
            );
            if (!result.success) {
              deps.showToast(result.error || 'Paste failed', 'Error', 'error');
              return;
            }
            deps.showToast(
              `${systemFiles.length} item(s) pasted from system clipboard`,
              'Success',
              'success'
            );
            deps.refresh();
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
        deps.showToast(result.error || 'Operation failed', 'Error', 'error');
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
      deps.showToast('Paste operation failed', 'Error', 'error');
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
    pasteFromClipboard,
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
