import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import * as path from 'path';
import type {
  UndoAction,
  UndoRenameAction,
  UndoMoveAction,
  UndoBatchRenameAction,
  ApiResponse,
} from '../types';
import { MAX_UNDO_STACK_SIZE } from './appState';
import { logger } from './logger';
import { ignoreError } from '../shared';
import { isTrustedIpcEvent } from './ipcUtils';

const undoStack: UndoAction[] = [];
const redoStack: UndoAction[] = [];

async function movePath(source: string, dest: string): Promise<void> {
  try {
    await fs.rename(source, dest);
    return;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EXDEV') {
      throw error;
    }
  }

  const stats = await fs.stat(source);
  if (stats.isDirectory()) {
    await fs.cp(source, dest, { recursive: true });
    const destStats = await fs.stat(dest);
    if (!destStats.isDirectory()) {
      throw new Error('Cross-device copy verification failed');
    }
    await fs.rm(source, { recursive: true, force: true });
  } else {
    await fs.copyFile(source, dest);
    const [srcStat, destStat] = await Promise.all([fs.stat(source), fs.stat(dest)]);
    if (destStat.size !== srcStat.size) {
      await fs.unlink(dest).catch(ignoreError);
      throw new Error('Cross-device copy verification failed: size mismatch');
    }
    await fs.unlink(source);
  }
}

export function pushUndoAction(action: UndoAction): void {
  undoStack.push(action);
  if (undoStack.length > MAX_UNDO_STACK_SIZE) {
    undoStack.shift();
  }
  redoStack.length = 0;
  logger.debug('[Undo] Action pushed:', action.type, 'Stack size:', undoStack.length);
}

export function pushRedoAction(action: UndoAction): void {
  redoStack.push(action);
  if (redoStack.length > MAX_UNDO_STACK_SIZE) {
    redoStack.shift();
  }
  logger.debug('[Redo] Action pushed:', action.type, 'Stack size:', redoStack.length);
}

export function getUndoStack(): readonly UndoAction[] {
  return undoStack;
}

export function getRedoStack(): readonly UndoAction[] {
  return redoStack;
}

export function clearUndoRedoStacks(): void {
  undoStack.length = 0;
  redoStack.length = 0;
}

export function clearUndoStackForPath(itemPath: string): void {
  const pathsToRemove = new Set<string>([itemPath]);

  const expandPaths = (stack: UndoAction[]) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const action = stack[i];
      if (action.type === 'rename') {
        if (pathsToRemove.has(action.data.newPath) || pathsToRemove.has(action.data.oldPath)) {
          pathsToRemove.add(action.data.oldPath);
          pathsToRemove.add(action.data.newPath);
        }
      }
    }
  };

  expandPaths(undoStack);
  expandPaths(redoStack);

  const pruneStack = (stack: UndoAction[]) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const action = stack[i];
      let shouldRemove = false;

      if (action.type === 'rename') {
        if (pathsToRemove.has(action.data.oldPath) || pathsToRemove.has(action.data.newPath)) {
          shouldRemove = true;
        }
      } else if (action.type === 'create') {
        if (pathsToRemove.has(action.data.path)) {
          shouldRemove = true;
        }
      } else if (action.type === 'move') {
        if (action.data.sourcePaths.some((p: string) => pathsToRemove.has(p))) {
          shouldRemove = true;
        }
      }

      if (shouldRemove) {
        stack.splice(i, 1);
        logger.debug('[Trash] Removed related undo action:', action.type);
      }
    }
  };

  pruneStack(undoStack);
  pruneStack(redoStack);
}

export function setupUndoRedoHandlers(): void {
  async function executeRenameAction(
    data: UndoRenameAction['data'],
    fromKey: 'oldPath' | 'newPath',
    toKey: 'oldPath' | 'newPath',
    direction: string
  ): Promise<ApiResponse> {
    const fromPath = data[fromKey];
    const toPath = data[toKey];
    try {
      await fs.access(fromPath);
    } catch {
      return {
        success: false,
        error: `Cannot ${direction}: File no longer exists (may have been moved or deleted)`,
      };
    }
    try {
      await fs.access(toPath);
      return {
        success: false,
        error: `Cannot ${direction}: A file already exists at the ${direction === 'undo' ? 'original' : 'target'} location`,
      };
    } catch (error) {
      ignoreError(error);
    }
    await movePath(fromPath, toPath);
    return { success: true };
  }

  async function executeMoveUndo(action: UndoMoveAction): Promise<ApiResponse> {
    const { sourcePaths: movedPaths, originalPaths, originalParent } = action.data;

    const getTargetPaths = (): string[] | null => {
      if (Array.isArray(originalPaths) && originalPaths.length === movedPaths.length)
        return originalPaths;
      if (originalParent)
        return movedPaths.map((p: string) => path.join(originalParent, path.basename(p)));
      return null;
    };

    const targetPaths = getTargetPaths();
    if (!targetPaths) {
      undoStack.push(action);
      return { success: false, error: 'Cannot undo: Original parent path not available' };
    }

    const sourcePaths = movedPaths;

    for (const sp of sourcePaths) {
      try {
        await fs.access(sp);
      } catch {
        undoStack.push(action);
        return { success: false, error: 'Cannot undo: One or more files no longer exist' };
      }
    }
    for (const tp of targetPaths) {
      try {
        await fs.access(tp);
        undoStack.push(action);
        return {
          success: false,
          error: 'Cannot undo: A file already exists at the original location',
        };
      } catch (error) {
        ignoreError(error);
      }
    }

    let movedBackCount = 0;
    try {
      for (let i = 0; i < sourcePaths.length; i++) {
        await movePath(sourcePaths[i], targetPaths[i]);
        movedBackCount++;
      }
    } catch (moveError) {
      logger.error('[Undo] Partial move undo failed at index', movedBackCount, moveError);
      if (movedBackCount > 0) {
        undoStack.push({
          ...action,
          data: {
            ...action.data,
            sourcePaths: movedPaths.slice(movedBackCount),
            originalPaths: originalPaths?.slice?.(movedBackCount),
          },
        });
      } else {
        undoStack.push(action);
      }
      const message = moveError instanceof Error ? moveError.message : String(moveError);
      return { success: false, error: `Partial undo failed: ${message}` };
    }
    return { success: true };
  }

  async function executeMoveRedo(
    action: UndoMoveAction
  ): Promise<{ result: ApiResponse; newMovedPaths: string[] }> {
    const { destPath: redoDestPath, originalPaths, originalParent, sourcePaths } = action.data;
    const newMovedPaths: string[] = [];

    const sourcesAndTargets: Array<[string, string]> = [];
    if (Array.isArray(originalPaths) && originalPaths.length > 0) {
      for (const op of originalPaths) {
        sourcesAndTargets.push([op, path.join(redoDestPath, path.basename(op))]);
      }
    } else {
      if (!originalParent)
        return {
          result: { success: false, error: 'Cannot redo: Original parent path not available' },
          newMovedPaths,
        };
      for (const sp of sourcePaths) {
        const fileName = path.basename(sp);
        sourcesAndTargets.push([
          path.join(originalParent, fileName),
          path.join(redoDestPath, fileName),
        ]);
      }
    }

    for (const [src, dest] of sourcesAndTargets) {
      try {
        await fs.access(src);
      } catch {
        return {
          result: { success: false, error: 'Cannot redo: File not found at original location' },
          newMovedPaths,
        };
      }
      try {
        await fs.access(dest);
        return {
          result: {
            success: false,
            error: 'Cannot redo: A file already exists at the target location',
          },
          newMovedPaths,
        };
      } catch (error) {
        ignoreError(error);
      }
      await movePath(src, dest);
      newMovedPaths.push(dest);
    }
    return { result: { success: true }, newMovedPaths };
  }

  ipcMain.handle('undo-action', async (_event: IpcMainInvokeEvent): Promise<ApiResponse> => {
    if (!isTrustedIpcEvent(_event, 'undo-action'))
      return { success: false, error: 'Untrusted IPC sender' };
    if (undoStack.length === 0) return { success: false, error: 'Nothing to undo' };

    const action = undoStack.pop()!;
    logger.debug('[Undo] Undoing action:', action.type);

    try {
      switch (action.type) {
        case 'rename': {
          const result = await executeRenameAction(action.data, 'newPath', 'oldPath', 'undo');
          if (result.success) pushRedoAction(action);
          else undoStack.push(action);
          return result;
        }
        case 'move': {
          const result = await executeMoveUndo(action);
          if (result.success) pushRedoAction(action);
          return result;
        }
        case 'create': {
          const itemPath = action.data.path;
          try {
            await fs.access(itemPath);
          } catch {
            return { success: false, error: 'Cannot undo: File no longer exists' };
          }
          const stats = await fs.stat(itemPath);
          if (action.data.createdAtMs !== undefined) {
            const birthMs = stats.birthtimeMs || stats.ctimeMs;
            if (Math.abs(birthMs - action.data.createdAtMs) > 2000) {
              undoStack.push(action);
              return {
                success: false,
                error: 'Cannot undo: File has been replaced since creation',
              };
            }
          }
          if (stats.isDirectory()) {
            const entries = await fs.readdir(itemPath);
            if (entries.length > 0) {
              undoStack.push(action);
              return {
                success: false,
                error: 'Cannot undo: Folder is not empty. Remove its contents first.',
              };
            }
            await fs.rm(itemPath, { recursive: true, force: true });
          } else {
            if (!action.data.isDirectory && stats.size > 0) {
              undoStack.push(action);
              return {
                success: false,
                error: 'Cannot undo: File has been modified since creation',
              };
            }
            await fs.unlink(itemPath);
          }
          pushRedoAction(action);
          return { success: true };
        }
        case 'batch-rename': {
          const renames = (action as UndoBatchRenameAction).data.renames;
          for (const item of [...renames].reverse()) {
            await movePath(item.newPath, item.oldPath);
          }
          pushRedoAction(action);
          return { success: true };
        }
        default:
          return { success: false, error: 'Unknown action type' };
      }
    } catch (error) {
      logger.error('[Undo] Error:', error);
      undoStack.push(action);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('redo-action', async (_event: IpcMainInvokeEvent): Promise<ApiResponse> => {
    if (!isTrustedIpcEvent(_event, 'redo-action'))
      return { success: false, error: 'Untrusted IPC sender' };
    if (redoStack.length === 0) return { success: false, error: 'Nothing to redo' };

    const action = redoStack.pop()!;
    logger.debug('[Redo] Redoing action:', action.type);

    try {
      switch (action.type) {
        case 'rename': {
          const result = await executeRenameAction(action.data, 'oldPath', 'newPath', 'redo');
          if (result.success) undoStack.push(action);
          else redoStack.push(action);
          return result;
        }
        case 'move': {
          const { result, newMovedPaths } = await executeMoveRedo(action);
          if (result.success)
            undoStack.push({ ...action, data: { ...action.data, sourcePaths: newMovedPaths } });
          else redoStack.push(action);
          return result;
        }
        case 'create': {
          const itemPath = action.data.path;
          try {
            await fs.access(itemPath);
            redoStack.push(action);
            return {
              success: false,
              error: 'Cannot redo: A file or folder already exists at this location',
            };
          } catch (error) {
            ignoreError(error);
          }
          if (action.data.isDirectory) await fs.mkdir(itemPath);
          else await fs.writeFile(itemPath, '');
          undoStack.push(action);
          return { success: true };
        }
        case 'batch-rename': {
          const renames = (action as UndoBatchRenameAction).data.renames;
          for (const item of renames) {
            await movePath(item.oldPath, item.newPath);
          }
          undoStack.push(action);
          return { success: true };
        }
        default:
          return { success: false, error: 'Unknown action type' };
      }
    } catch (error) {
      logger.error('[Redo] Error:', error);
      redoStack.push(action);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(
    'get-undo-redo-state',
    async (event: IpcMainInvokeEvent): Promise<{ canUndo: boolean; canRedo: boolean }> => {
      if (!isTrustedIpcEvent(event, 'get-undo-redo-state')) {
        return { canUndo: false, canRedo: false };
      }
      return {
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
      };
    }
  );
}
