import type { Settings } from './types';
import type { ToastAction } from './rendererToasts.js';
import { rendererPath as path } from './rendererUtils.js';
import { devLog, ignoreError } from './shared.js';

type ClipboardState = { operation: 'copy' | 'cut'; paths: string[] } | null;

export function isPermissionDeniedError(message?: string): boolean {
  if (!message) return false;
  const value = message.toLowerCase();
  return (
    value.includes('eacces') ||
    value.includes('eperm') ||
    value.includes('permission denied') ||
    value.includes('operation not permitted') ||
    value.includes('access is denied') ||
    value.includes('not authorized') ||
    value.includes('unauthorized') ||
    value.includes('access denied') ||
    value.includes('privilege') ||
    /\berr(?:no)?[:\s]+13\b/.test(value)
  );
}

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
  showConfirm: (message: string, title: string, type: 'warning') => Promise<boolean>;
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

  function resolveClipboardIndicatorElements(): {
    indicator: HTMLElement | null;
    text: HTMLElement | null;
  } {
    if (!elIndicator) {
      elIndicator = document.getElementById('status-clipboard');
    }
    if (!elIndicatorText) {
      elIndicatorText = document.getElementById('status-clipboard-text');
    }
    return { indicator: elIndicator, text: elIndicatorText };
  }

  function getRetryActions(retry?: () => void): ToastAction[] | undefined {
    if (!retry) return undefined;
    return [{ label: 'Retry', onClick: () => void retry() }];
  }

  function cloneClipboardState(value: ClipboardState): ClipboardState {
    if (!value) return null;
    return { operation: value.operation, paths: [...value.paths] };
  }

  function isSameClipboardState(a: ClipboardState, b: ClipboardState): boolean {
    if (!a || !b) return a === b;
    if (a.operation !== b.operation || a.paths.length !== b.paths.length) return false;
    return a.paths.every((pathValue, index) => pathValue === b.paths[index]);
  }

  function clearClipboardIfUnchanged(snapshot: ClipboardState): void {
    if (!snapshot || snapshot.operation !== 'cut') return;
    if (!isSameClipboardState(clipboard, snapshot)) return;
    clipboard = null;
    window.tauriAPI.setClipboard(null).catch(ignoreError);
    void updateClipboardIndicator().catch(ignoreError);
  }

  async function getSystemClipboardData(): Promise<{
    operation: 'copy' | 'cut';
    paths: string[];
  } | null> {
    try {
      const CLIPBOARD_TIMEOUT_MS = 5000;
      const timeout = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), CLIPBOARD_TIMEOUT_MS)
      );
      const data = await Promise.race([
        typeof window.tauriAPI.getSystemClipboardData === 'function'
          ? window.tauriAPI.getSystemClipboardData()
          : window.tauriAPI
              .getSystemClipboardFiles()
              .then((paths) => ({ operation: 'copy' as const, paths })),
        timeout,
      ]);

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
      const moveResult = await window.tauriAPI.moveItems(
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
        const confirmed = await deps.showConfirm(
          'This operation requires administrator privileges. You will be prompted to authorize.',
          'Elevated Permissions Required',
          'warning'
        );
        if (confirmed) {
          const elevResult = await window.tauriAPI.elevatedMoveBatch(
            systemClipboard.paths,
            destPath
          );
          if (elevResult.success) {
            deps.showToast(
              `${systemClipboard.paths.length} item(s) moved (elevated)`,
              'Success',
              'success'
            );
            deps.refresh();
            return true;
          }
          deps.showToast(
            elevResult.error || 'Elevated move failed',
            'Error',
            'error',
            retryActions
          );
          return true;
        }
        deps.showToast('Operation cancelled', 'Info', 'info');
        return true;
      }

      deps.showToast(moveResult.error || 'Paste failed', 'Error', 'error', retryActions);
      return true;
    }

    const copyResult = await window.tauriAPI.copyItems(
      systemClipboard.paths,
      destPath,
      conflictBehavior
    );
    if (!copyResult.success) {
      if (isPermissionDeniedError(copyResult.error)) {
        const confirmed = await deps.showConfirm(
          'This operation requires administrator privileges. You will be prompted to authorize.',
          'Elevated Permissions Required',
          'warning'
        );
        if (confirmed) {
          const elevResult = await window.tauriAPI.elevatedCopyBatch(
            systemClipboard.paths,
            destPath
          );
          if (elevResult.success) {
            deps.showToast(
              `${systemClipboard.paths.length} item(s) pasted (elevated)`,
              'Success',
              'success'
            );
            deps.refresh();
            return true;
          }
          deps.showToast(
            elevResult.error || 'Elevated copy failed',
            'Error',
            'error',
            retryActions
          );
          return true;
        }
        deps.showToast('Operation cancelled', 'Info', 'info');
        return true;
      }
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
    devLog('Clipboard', 'updateClipboardIndicator called');
    const { indicator, text: indicatorText } = resolveClipboardIndicatorElements();
    if (!indicator || !indicatorText) return;

    if (clipboard && clipboard.paths.length > 0) {
      const count = clipboard.paths.length;
      const operation = clipboard.operation === 'cut' ? 'cut' : 'copied';
      indicatorText.textContent = `${count} ${operation}`;
      indicator.title = `Clipboard: ${count} ${operation}`;
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
          indicator.title = `Clipboard: ${indicatorText.textContent}`;
          indicator.classList.toggle('cut-mode', systemClipboard.operation === 'cut');
          indicator.style.display = 'inline-flex';
          return;
        }
      }
      indicator.style.display = 'none';
      indicator.title = 'Clipboard contents';
    }
  }

  function setClipboardSelection(operation: 'copy' | 'cut'): void {
    const selectedItems = deps.getSelectedItems();
    if (selectedItems.size === 0) return;
    devLog('Clipboard', `${operation}: ${selectedItems.size} item(s)`);
    clipboard = {
      operation,
      paths: Array.from(selectedItems),
    };
    window.tauriAPI.setClipboard(clipboard).catch(ignoreError);
    updateCutVisuals();
    void updateClipboardIndicator().catch(ignoreError);
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

  function isSourceAlreadyInDestination(sourcePaths: string[], destPath: string): boolean {
    return sourcePaths.some((sourcePath) => {
      const parentDir = path.dirname(sourcePath);
      return parentDir === destPath || sourcePath === destPath;
    });
  }

  async function moveSelectedToFolder(): Promise<string | null> {
    const selectedItems = deps.getSelectedItems();
    if (selectedItems.size === 0) return null;
    const result = await window.tauriAPI.selectFolder();
    if (!result.success) return null;

    const destPath = result.path;
    const sourcePaths = Array.from(selectedItems);
    const alreadyInDest = isSourceAlreadyInDestination(sourcePaths, destPath);

    if (alreadyInDest) {
      deps.showToast('Items are already in this directory', 'Info', 'info');
      return null;
    }

    await deps.handleDrop(sourcePaths, destPath, 'move');
    return destPath;
  }

  async function copySelectedToFolder(): Promise<string | null> {
    const selectedItems = deps.getSelectedItems();
    if (selectedItems.size === 0) return null;
    const result = await window.tauriAPI.selectFolder();
    if (!result.success) return null;

    const destPath = result.path;
    const sourcePaths = Array.from(selectedItems);
    const alreadyInDest = isSourceAlreadyInDestination(sourcePaths, destPath);

    if (alreadyInDest) {
      deps.showToast('Items are already in this directory', 'Info', 'info');
      return null;
    }

    await deps.handleDrop(sourcePaths, destPath, 'copy');
    return destPath;
  }

  async function moveSelectedToDestination(destPath: string): Promise<boolean> {
    if (!destPath) return false;
    const selectedItems = deps.getSelectedItems();
    if (selectedItems.size === 0) return false;
    const sourcePaths = Array.from(selectedItems);
    if (isSourceAlreadyInDestination(sourcePaths, destPath)) {
      deps.showToast('Items are already in this directory', 'Info', 'info');
      return false;
    }
    await deps.handleDrop(sourcePaths, destPath, 'move');
    return true;
  }

  async function copySelectedToDestination(destPath: string): Promise<boolean> {
    if (!destPath) return false;
    const selectedItems = deps.getSelectedItems();
    if (selectedItems.size === 0) return false;
    const sourcePaths = Array.from(selectedItems);
    if (isSourceAlreadyInDestination(sourcePaths, destPath)) {
      deps.showToast('Items are already in this directory', 'Info', 'info');
      return false;
    }
    await deps.handleDrop(sourcePaths, destPath, 'copy');
    return true;
  }

  async function pasteIntoFolder(folderPath: string): Promise<void> {
    if (!folderPath) return;
    if (pasteInProgress) return;

    pasteInProgress = true;
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
      const clipboardSnapshot = cloneClipboardState(clipboard);
      if (!clipboardSnapshot) return;
      if (clipboardSnapshot.operation === 'cut') {
        const validationResults = await Promise.all(
          clipboardSnapshot.paths.map((p) =>
            window.tauriAPI.getItemProperties(p).then(
              (r) => ({ path: p, exists: r.success }),
              () => ({ path: p, exists: false })
            )
          )
        );
        const validPaths = validationResults.filter((r) => r.exists).map((r) => r.path);
        const missingCount = validationResults.length - validPaths.length;
        if (validPaths.length === 0) {
          clipboard = null;
          updateCutVisuals();
          deps.showToast('Source files no longer exist', 'Paste Failed', 'error');
          return;
        }
        if (missingCount > 0) {
          clipboardSnapshot.paths = validPaths;
          clipboard = { operation: 'cut', paths: [...validPaths] };
          window.tauriAPI.setClipboard(clipboard).catch(ignoreError);
          deps.showToast(
            `${missingCount} file(s) no longer exist and were skipped`,
            'Paste',
            'warning'
          );
        }
      }

      const isCopy = clipboardSnapshot.operation === 'copy';
      const conflictBehavior = deps.getCurrentSettings().fileConflictBehavior || 'ask';
      const result = isCopy
        ? await window.tauriAPI.copyItems(clipboardSnapshot.paths, folderPath, conflictBehavior)
        : await window.tauriAPI.moveItems(clipboardSnapshot.paths, folderPath, conflictBehavior);

      if (!result.success) {
        if (isPermissionDeniedError(result.error)) {
          const confirmed = await deps.showConfirm(
            'This operation requires administrator privileges. You will be prompted to authorize.',
            'Elevated Permissions Required',
            'warning'
          );
          if (confirmed) {
            const elevResult = isCopy
              ? await window.tauriAPI.elevatedCopyBatch(clipboardSnapshot.paths, folderPath)
              : await window.tauriAPI.elevatedMoveBatch(clipboardSnapshot.paths, folderPath);
            if (elevResult.success) {
              deps.showToast(
                `${clipboardSnapshot.paths.length} item(s) ${isCopy ? 'copied' : 'moved'} into folder (elevated)`,
                'Success',
                'success'
              );
              if (!isCopy) {
                await deps.updateUndoRedoState();
                clearClipboardIfUnchanged(clipboardSnapshot);
              }
              updateCutVisuals();
              deps.refresh();
              return;
            }
            deps.showToast(elevResult.error || 'Elevated operation failed', 'Error', 'error');
            return;
          }
          deps.showToast('Operation cancelled', 'Info', 'info');
          return;
        }
        deps.showToast(result.error || 'Operation failed', 'Error', 'error');
        return;
      }
      deps.showToast(
        `${clipboardSnapshot.paths.length} item(s) ${isCopy ? 'copied' : 'moved'} into folder`,
        'Success',
        'success'
      );

      if (!isCopy) {
        await deps.updateUndoRedoState();
        clearClipboardIfUnchanged(clipboardSnapshot);
      }

      updateCutVisuals();
      deps.refresh();
    } catch {
      deps.showToast('Paste operation failed', 'Error', 'error');
    } finally {
      pasteInProgress = false;
    }
  }

  async function duplicateItems(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const currentPath = deps.getCurrentPath();

    try {
      const conflictBehavior = 'rename' as const;
      const result = await window.tauriAPI.copyItems(paths, currentPath, conflictBehavior);
      if (!result.success) {
        if (isPermissionDeniedError(result.error)) {
          const confirmed = await deps.showConfirm(
            'This operation requires administrator privileges. You will be prompted to authorize.',
            'Elevated Permissions Required',
            'warning'
          );
          if (confirmed) {
            const elevResult = await window.tauriAPI.elevatedCopyBatch(paths, currentPath);
            if (elevResult.success) {
              deps.showToast(`${paths.length} item(s) duplicated (elevated)`, 'Success', 'success');
              deps.refresh();
              return;
            }
            deps.showToast(elevResult.error || 'Elevated duplicate failed', 'Error', 'error');
            return;
          }
          deps.showToast('Operation cancelled', 'Info', 'info');
          return;
        }
        deps.showToast(result.error || 'Duplicate failed', 'Error', 'error');
        return;
      }
      deps.showToast(`${paths.length} item(s) duplicated`, 'Success', 'success');
      deps.refresh();
    } catch {
      deps.showToast('Duplicate failed', 'Error', 'error');
    }
  }

  let pasteInProgress = false;

  async function pasteFromClipboard() {
    if (pasteInProgress) return;
    const currentPath = deps.getCurrentPath();
    if (!currentPath) return;

    pasteInProgress = true;
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
      const clipboardSnapshot = cloneClipboardState(clipboard);
      if (!clipboardSnapshot) return;

      // For cut operations, validate source paths still exist
      if (clipboardSnapshot.operation === 'cut') {
        const validationResults = await Promise.all(
          clipboardSnapshot.paths.map((p) =>
            window.tauriAPI.getItemProperties(p).then(
              (r) => ({ path: p, exists: r.success }),
              () => ({ path: p, exists: false })
            )
          )
        );
        const missing = validationResults.filter((r) => !r.exists);
        if (missing.length > 0) {
          const validPaths = validationResults.filter((r) => r.exists).map((r) => r.path);
          if (validPaths.length === 0) {
            clipboard = null;
            updateCutVisuals();
            deps.showToast('Source files no longer exist', 'Paste Failed', 'error');
            return;
          }
          clipboardSnapshot.paths = validPaths;
          deps.showToast(
            `${missing.length} file(s) no longer exist and were skipped`,
            'Paste',
            'warning'
          );
        }
      }

      const isCopy = clipboardSnapshot.operation === 'copy';
      const conflictBehavior = deps.getCurrentSettings().fileConflictBehavior || 'ask';
      const result = isCopy
        ? await window.tauriAPI.copyItems(clipboardSnapshot.paths, currentPath, conflictBehavior)
        : await window.tauriAPI.moveItems(clipboardSnapshot.paths, currentPath, conflictBehavior);

      if (!result.success) {
        if (isPermissionDeniedError(result.error)) {
          const confirmed = await deps.showConfirm(
            'This operation requires administrator privileges. You will be prompted to authorize.',
            'Elevated Permissions Required',
            'warning'
          );
          if (confirmed) {
            const elevResult = isCopy
              ? await window.tauriAPI.elevatedCopyBatch(clipboardSnapshot.paths, currentPath)
              : await window.tauriAPI.elevatedMoveBatch(clipboardSnapshot.paths, currentPath);
            if (elevResult.success) {
              deps.showToast(
                `${clipboardSnapshot.paths.length} item(s) ${isCopy ? 'copied' : 'moved'} (elevated)`,
                'Success',
                'success'
              );
              if (!isCopy) {
                await deps.updateUndoRedoState();
                clearClipboardIfUnchanged(clipboardSnapshot);
              }
              updateCutVisuals();
              deps.refresh();
              return;
            }
            deps.showToast(elevResult.error || 'Elevated operation failed', 'Error', 'error');
            return;
          }
          deps.showToast('Operation cancelled', 'Info', 'info');
          return;
        }
        deps.showToast(result.error || 'Operation failed', 'Error', 'error', [
          { label: 'Retry', onClick: () => void pasteFromClipboard() },
        ]);
        return;
      }
      deps.showToast(
        `${clipboardSnapshot.paths.length} item(s) ${isCopy ? 'copied' : 'moved'}`,
        'Success',
        'success'
      );

      if (!isCopy) {
        await deps.updateUndoRedoState();
        clearClipboardIfUnchanged(clipboardSnapshot);
      }

      updateCutVisuals();
      deps.refresh();
    } catch {
      deps.showToast('Paste operation failed', 'Error', 'error', [
        { label: 'Retry', onClick: () => void pasteFromClipboard() },
      ]);
    } finally {
      pasteInProgress = false;
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
    moveSelectedToDestination,
    copySelectedToDestination,
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
