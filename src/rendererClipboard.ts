import type { Settings } from './types';
import type { ToastAction } from './rendererToasts.js';
import { rendererPath as path } from './rendererUtils.js';
import { devLog, ignoreError } from './shared.js';
import { t } from './i18n.js';

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
  generateOperationId?: () => string;
  addOperation?: (
    id: string,
    kind: 'copy' | 'move' | 'duplicate',
    name: string,
    options?: { cancellable?: boolean; total?: number; retry?: () => void }
  ) => void;
  updateOperation?: (
    id: string,
    update: { current?: number; total?: number; currentFile?: string; status?: 'active' }
  ) => void;
  completeOperation?: (id: string, status: 'done' | 'failed', error?: string) => void;
  refresh: () => void;
  updateUndoRedoState: () => Promise<void>;
  registerRecentlyPastedPaths?: (paths: string[]) => void;
};

export function createClipboardController(deps: ClipboardDeps) {
  let clipboard: ClipboardState = null;
  let cutPaths = new Set<string>();

  const joinDestinationPath = (dest: string, name: string): string => {
    const separator = dest.includes('\\') && !dest.includes('/') ? '\\' : '/';
    return dest.replace(/[\\/]+$/, '') + separator + name;
  };

  const registerPasted = (paths: string[], dest: string) => {
    if (deps.registerRecentlyPastedPaths) {
      const expectedPaths = paths.map((p) => {
        const name = path.basename(p);
        return joinDestinationPath(dest, name || p);
      });
      deps.registerRecentlyPastedPaths(expectedPaths);
    }
  };
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

  function queueName(paths: string[], destPath: string): string {
    const destination = path.basename(destPath) || destPath;
    return `${paths.length} item${paths.length === 1 ? '' : 's'} to ${destination}`;
  }

  function startQueuedTransfer(
    paths: string[],
    destPath: string,
    operation: 'copy' | 'move' | 'duplicate',
    retry?: () => void
  ): string | undefined {
    if (!deps.addOperation) return undefined;
    const operationId =
      deps.generateOperationId?.() ?? `clipboard_${Date.now()}_${Math.random().toString(36)}`;
    deps.addOperation(operationId, operation, queueName(paths, destPath), {
      cancellable: true,
      total: paths.length,
      retry,
    });
    return operationId;
  }

  function updateQueued(
    operationId: string | undefined,
    update: { currentFile?: string; status?: 'active' }
  ): void {
    // Delegate to the operation-queue dep (must NOT call itself — infinite recursion).
    if (operationId) deps.updateOperation?.(operationId, update);
  }

  function completeQueued(
    operationId: string | undefined,
    status: 'done' | 'failed',
    error?: string
  ): void {
    if (operationId) deps.completeOperation?.(operationId, status, error);
  }

  function copyItemsQueued(
    sourcePaths: string[],
    destPath: string,
    conflictBehavior: 'ask' | 'rename' | 'skip' | 'overwrite',
    operationId: string | undefined
  ) {
    return operationId
      ? window.tauriAPI.copyItems(sourcePaths, destPath, conflictBehavior, operationId)
      : window.tauriAPI.copyItems(sourcePaths, destPath, conflictBehavior);
  }

  function moveItemsQueued(
    sourcePaths: string[],
    destPath: string,
    conflictBehavior: 'ask' | 'rename' | 'skip' | 'overwrite',
    operationId: string | undefined
  ) {
    return operationId
      ? window.tauriAPI.moveItems(sourcePaths, destPath, conflictBehavior, operationId)
      : window.tauriAPI.moveItems(sourcePaths, destPath, conflictBehavior);
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

  async function clearClipboardIfUnchanged(snapshot: ClipboardState): Promise<void> {
    if (!snapshot || snapshot.operation !== 'cut') return;
    if (!isSameClipboardState(clipboard, snapshot)) return;
    clipboard = null;
    try {
      await window.tauriAPI.setClipboard(null);
    } catch {
      /* ignore */
    }
    try {
      await updateClipboardIndicator();
    } catch {
      /* ignore */
    }
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
    const operationId = startQueuedTransfer(
      systemClipboard.paths,
      destPath,
      systemClipboard.operation === 'cut' ? 'move' : 'copy',
      retry
    );

    if (systemClipboard.operation === 'cut') {
      const moveResult = await moveItemsQueued(
        systemClipboard.paths,
        destPath,
        conflictBehavior,
        operationId
      );
      if (moveResult.success) {
        completeQueued(operationId, 'done');
        deps.showToast(
          t('clipboard.movedFromSystem', { count: systemClipboard.paths.length }),
          'Success',
          'success'
        );
        registerPasted(systemClipboard.paths, destPath);
        deps.refresh();
        return true;
      }

      if (isPermissionDeniedError(moveResult.error)) {
        const confirmed = await deps.showConfirm(
          t('clipboard.elevatedConfirm'),
          'Elevated Permissions Required',
          'warning'
        );
        if (confirmed) {
          updateQueued(operationId, {
            currentFile: 'Waiting for elevated permissions...',
            status: 'active',
          });
          const elevResult = await window.tauriAPI.elevatedMoveBatch(
            systemClipboard.paths,
            destPath
          );
          if (elevResult.success) {
            completeQueued(operationId, 'done');
            deps.showToast(
              t('clipboard.movedElevated', { count: systemClipboard.paths.length }),
              'Success',
              'success'
            );
            registerPasted(systemClipboard.paths, destPath);
            deps.refresh();
            return true;
          }
          deps.showToast(
            elevResult.error || 'Elevated move failed',
            'Error',
            'error',
            retryActions
          );
          completeQueued(operationId, 'failed', elevResult.error || 'Elevated move failed');
          return true;
        }
        completeQueued(operationId, 'failed', 'Operation cancelled');
        deps.showToast('Operation cancelled', 'Info', 'info');
        return true;
      }

      deps.showToast(moveResult.error || 'Paste failed', 'Error', 'error', retryActions);
      completeQueued(operationId, 'failed', moveResult.error || 'Paste failed');
      return true;
    }

    const copyResult = await copyItemsQueued(
      systemClipboard.paths,
      destPath,
      conflictBehavior,
      operationId
    );
    if (!copyResult.success) {
      if (isPermissionDeniedError(copyResult.error)) {
        const confirmed = await deps.showConfirm(
          t('clipboard.elevatedConfirm'),
          'Elevated Permissions Required',
          'warning'
        );
        if (confirmed) {
          updateQueued(operationId, {
            currentFile: 'Waiting for elevated permissions...',
            status: 'active',
          });
          const elevResult = await window.tauriAPI.elevatedCopyBatch(
            systemClipboard.paths,
            destPath
          );
          if (elevResult.success) {
            completeQueued(operationId, 'done');
            deps.showToast(
              t('clipboard.pastedElevated', { count: systemClipboard.paths.length }),
              'Success',
              'success'
            );
            registerPasted(systemClipboard.paths, destPath);
            deps.refresh();
            return true;
          }
          deps.showToast(
            elevResult.error || 'Elevated copy failed',
            'Error',
            'error',
            retryActions
          );
          completeQueued(operationId, 'failed', elevResult.error || 'Elevated copy failed');
          return true;
        }
        completeQueued(operationId, 'failed', 'Operation cancelled');
        deps.showToast('Operation cancelled', 'Info', 'info');
        return true;
      }
      deps.showToast(copyResult.error || 'Paste failed', 'Error', 'error', retryActions);
      completeQueued(operationId, 'failed', copyResult.error || 'Paste failed');
      return true;
    }

    completeQueued(operationId, 'done');
    deps.showToast(
      t('clipboard.pastedFromSystem', { count: systemClipboard.paths.length }),
      'Success',
      'success'
    );
    registerPasted(systemClipboard.paths, destPath);
    deps.refresh();
    return true;
  }

  async function updateClipboardIndicator() {
    devLog('Clipboard', 'updateClipboardIndicator called');
    const { indicator, text: indicatorText } = resolveClipboardIndicatorElements();
    if (!indicator || !indicatorText) return;

    if (deps.getCurrentSettings().statusBarItems?.clipboard === false) {
      indicator.style.display = 'none';
      indicator.title = 'Clipboard contents';
      return;
    }

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
          if (deps.getCurrentSettings().statusBarItems?.clipboard === false) {
            indicator.style.display = 'none';
            indicator.title = 'Clipboard contents';
            return;
          }
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
      operation === 'cut'
        ? t('clipboard.cut', { count: selectedItems.size })
        : t('clipboard.copied', { count: selectedItems.size }),
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
      deps.showToast(t('toast.alreadyInDirectory'), 'Info', 'info');
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
      deps.showToast(t('toast.alreadyInDirectory'), 'Info', 'info');
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
      deps.showToast(t('toast.alreadyInDirectory'), 'Info', 'info');
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
      deps.showToast(t('toast.alreadyInDirectory'), 'Info', 'info');
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
          deps.showToast(t('toast.sourceFilesGone'), 'Paste Failed', 'error');
          return;
        }
        if (missingCount > 0) {
          clipboardSnapshot.paths = validPaths;
          clipboard = { operation: 'cut', paths: [...validPaths] };
          window.tauriAPI.setClipboard(clipboard).catch(ignoreError);
          deps.showToast(t('clipboard.filesSkipped', { count: missingCount }), 'Paste', 'warning');
        }
      }

      const isCopy = clipboardSnapshot.operation === 'copy';
      const conflictBehavior = deps.getCurrentSettings().fileConflictBehavior || 'ask';
      const retry = () => void pasteIntoFolder(folderPath);
      const operationId = startQueuedTransfer(
        clipboardSnapshot.paths,
        folderPath,
        isCopy ? 'copy' : 'move',
        retry
      );
      const result = isCopy
        ? await copyItemsQueued(clipboardSnapshot.paths, folderPath, conflictBehavior, operationId)
        : await moveItemsQueued(clipboardSnapshot.paths, folderPath, conflictBehavior, operationId);

      if (!result.success) {
        if (isPermissionDeniedError(result.error)) {
          const confirmed = await deps.showConfirm(
            'This operation requires administrator privileges. You will be prompted to authorize.',
            'Elevated Permissions Required',
            'warning'
          );
          if (confirmed) {
            updateQueued(operationId, {
              currentFile: 'Waiting for elevated permissions...',
              status: 'active',
            });
            const elevResult = isCopy
              ? await window.tauriAPI.elevatedCopyBatch(clipboardSnapshot.paths, folderPath)
              : await window.tauriAPI.elevatedMoveBatch(clipboardSnapshot.paths, folderPath);
            if (elevResult.success) {
              completeQueued(operationId, 'done');
              deps.showToast(
                isCopy
                  ? t('clipboard.copiedIntoFolderElevated', {
                      count: clipboardSnapshot.paths.length,
                    })
                  : t('clipboard.movedIntoFolderElevated', {
                      count: clipboardSnapshot.paths.length,
                    }),
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
            completeQueued(operationId, 'failed', elevResult.error || 'Elevated operation failed');
            deps.showToast(elevResult.error || 'Elevated operation failed', 'Error', 'error');
            return;
          }
          completeQueued(operationId, 'failed', 'Operation cancelled');
          deps.showToast('Operation cancelled', 'Info', 'info');
          return;
        }
        completeQueued(operationId, 'failed', result.error || 'Operation failed');
        deps.showToast(result.error || 'Operation failed', 'Error', 'error');
        return;
      }
      completeQueued(operationId, 'done');
      deps.showToast(
        isCopy
          ? t('clipboard.copiedIntoFolder', { count: clipboardSnapshot.paths.length })
          : t('clipboard.movedIntoFolder', { count: clipboardSnapshot.paths.length }),
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

    const operationId = startQueuedTransfer(
      paths,
      currentPath,
      'duplicate',
      () => void duplicateItems(paths)
    );
    try {
      const conflictBehavior = 'rename' as const;
      const result = await copyItemsQueued(paths, currentPath, conflictBehavior, operationId);
      if (!result.success) {
        if (isPermissionDeniedError(result.error)) {
          const confirmed = await deps.showConfirm(
            'This operation requires administrator privileges. You will be prompted to authorize.',
            'Elevated Permissions Required',
            'warning'
          );
          if (confirmed) {
            updateQueued(operationId, {
              currentFile: 'Waiting for elevated permissions...',
              status: 'active',
            });
            const elevResult = await window.tauriAPI.elevatedCopyBatch(paths, currentPath);
            if (elevResult.success) {
              completeQueued(operationId, 'done');
              deps.showToast(
                t('clipboard.duplicatedElevated', { count: paths.length }),
                'Success',
                'success'
              );
              deps.refresh();
              return;
            }
            completeQueued(operationId, 'failed', elevResult.error || 'Elevated duplicate failed');
            deps.showToast(elevResult.error || 'Elevated duplicate failed', 'Error', 'error');
            return;
          }
          completeQueued(operationId, 'failed', 'Operation cancelled');
          deps.showToast('Operation cancelled', 'Info', 'info');
          return;
        }
        completeQueued(operationId, 'failed', result.error || 'Duplicate failed');
        deps.showToast(result.error || 'Duplicate failed', 'Error', 'error');
        return;
      }
      completeQueued(operationId, 'done');
      deps.showToast(t('clipboard.duplicated', { count: paths.length }), 'Success', 'success');
      deps.refresh();
    } catch (error) {
      completeQueued(operationId, 'failed', String(error));
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
            deps.showToast(t('toast.sourceFilesGone'), 'Paste Failed', 'error');
            return;
          }
          clipboardSnapshot.paths = validPaths;
          clipboard = { operation: 'cut', paths: [...validPaths] };
          window.tauriAPI.setClipboard(clipboard).catch(ignoreError);
          deps.showToast(
            t('clipboard.filesSkipped', { count: missing.length }),
            'Paste',
            'warning'
          );
        }
      }

      const isCopy = clipboardSnapshot.operation === 'copy';
      const conflictBehavior = deps.getCurrentSettings().fileConflictBehavior || 'ask';
      const retry = () => void pasteFromClipboard();
      const operationId = startQueuedTransfer(
        clipboardSnapshot.paths,
        currentPath,
        isCopy ? 'copy' : 'move',
        retry
      );
      const result = isCopy
        ? await copyItemsQueued(clipboardSnapshot.paths, currentPath, conflictBehavior, operationId)
        : await moveItemsQueued(
            clipboardSnapshot.paths,
            currentPath,
            conflictBehavior,
            operationId
          );

      if (!result.success) {
        if (isPermissionDeniedError(result.error)) {
          const confirmed = await deps.showConfirm(
            'This operation requires administrator privileges. You will be prompted to authorize.',
            'Elevated Permissions Required',
            'warning'
          );
          if (confirmed) {
            updateQueued(operationId, {
              currentFile: 'Waiting for elevated permissions...',
              status: 'active',
            });
            const elevResult = isCopy
              ? await window.tauriAPI.elevatedCopyBatch(clipboardSnapshot.paths, currentPath)
              : await window.tauriAPI.elevatedMoveBatch(clipboardSnapshot.paths, currentPath);
            if (elevResult.success) {
              completeQueued(operationId, 'done');
              deps.showToast(
                isCopy
                  ? t('clipboard.copiedElevated', { count: clipboardSnapshot.paths.length })
                  : t('clipboard.movedElevated', { count: clipboardSnapshot.paths.length }),
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
            completeQueued(operationId, 'failed', elevResult.error || 'Elevated operation failed');
            deps.showToast(elevResult.error || 'Elevated operation failed', 'Error', 'error');
            return;
          }
          completeQueued(operationId, 'failed', 'Operation cancelled');
          deps.showToast('Operation cancelled', 'Info', 'info');
          return;
        }
        completeQueued(operationId, 'failed', result.error || 'Operation failed');
        deps.showToast(result.error || 'Operation failed', 'Error', 'error', [
          { label: 'Retry', onClick: () => void pasteFromClipboard() },
        ]);
        return;
      }
      completeQueued(operationId, 'done');
      deps.showToast(
        isCopy
          ? t('clipboard.copied', { count: clipboardSnapshot.paths.length })
          : t('clipboard.moved', { count: clipboardSnapshot.paths.length }),
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
