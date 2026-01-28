import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { UndoAction, ApiResponse } from './types';
import { MAX_UNDO_STACK_SIZE } from './appState';
import { logger } from './utils/logger';

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
    await fs.rm(source, { recursive: true, force: true });
  } else {
    await fs.copyFile(source, dest);
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
  const pathsToRemove: string[] = [itemPath];

  const expandPaths = (stack: UndoAction[]) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const action = stack[i];
      if (action.type === 'rename') {
        if (
          pathsToRemove.includes(action.data.newPath) ||
          pathsToRemove.includes(action.data.oldPath)
        ) {
          if (!pathsToRemove.includes(action.data.oldPath)) {
            pathsToRemove.push(action.data.oldPath);
          }
          if (!pathsToRemove.includes(action.data.newPath)) {
            pathsToRemove.push(action.data.newPath);
          }
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
        if (
          pathsToRemove.includes(action.data.oldPath) ||
          pathsToRemove.includes(action.data.newPath)
        ) {
          shouldRemove = true;
        }
      } else if (action.type === 'create') {
        if (pathsToRemove.includes(action.data.path)) {
          shouldRemove = true;
        }
      } else if (action.type === 'move') {
        if (action.data.sourcePaths.some((p: string) => pathsToRemove.includes(p))) {
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
  ipcMain.handle('undo-action', async (_event: IpcMainInvokeEvent): Promise<ApiResponse> => {
    if (undoStack.length === 0) {
      return { success: false, error: 'Nothing to undo' };
    }

    const action = undoStack.pop()!;
    logger.debug('[Undo] Undoing action:', action.type);

    try {
      switch (action.type) {
        case 'rename':
          try {
            await fs.access(action.data.newPath);
          } catch {
            logger.debug('[Undo] File no longer exists:', action.data.newPath);
            return {
              success: false,
              error: 'Cannot undo: File no longer exists (may have been moved or deleted)',
            };
          }

          try {
            await fs.access(action.data.oldPath);
            logger.debug('[Undo] Old path already exists:', action.data.oldPath);
            return {
              success: false,
              error: 'Cannot undo: A file already exists at the original location',
            };
          } catch {}

          await fs.rename(action.data.newPath, action.data.oldPath);
          pushRedoAction(action);
          logger.debug('[Undo] Renamed back:', action.data.newPath, '->', action.data.oldPath);
          return { success: true };

        case 'move':
          const movedPaths = action.data.sourcePaths;
          const originalPaths = action.data.originalPaths;
          const originalParent = action.data.originalParent;

          if (Array.isArray(originalPaths) && originalPaths.length === movedPaths.length) {
            for (const movedPath of movedPaths) {
              try {
                await fs.access(movedPath);
              } catch {
                logger.debug('[Undo] File no longer exists:', movedPath);
                return { success: false, error: 'Cannot undo: One or more files no longer exist' };
              }
            }

            for (const originalPath of originalPaths) {
              try {
                await fs.access(originalPath);
                logger.debug('[Undo] Original path already exists:', originalPath);
                return {
                  success: false,
                  error: 'Cannot undo: A file already exists at the original location',
                };
              } catch {}
            }

            for (let i = 0; i < movedPaths.length; i++) {
              await movePath(movedPaths[i], originalPaths[i]);
            }
          } else {
            if (!originalParent) {
              return { success: false, error: 'Cannot undo: Original parent path not available' };
            }

            for (const source of movedPaths) {
              try {
                await fs.access(source);
              } catch {
                logger.debug('[Undo] File no longer exists:', source);
                return { success: false, error: 'Cannot undo: One or more files no longer exist' };
              }
            }

            for (const source of movedPaths) {
              const fileName = path.basename(source);
              const originalPath = path.join(originalParent, fileName);
              await movePath(source, originalPath);
            }
          }
          pushRedoAction(action);
          logger.debug('[Undo] Moved back to original location');
          return { success: true };

        case 'create':
          const itemPath = action.data.path;

          try {
            await fs.access(itemPath);
          } catch {
            logger.debug('[Undo] Created item no longer exists:', itemPath);
            return { success: false, error: 'Cannot undo: File no longer exists' };
          }

          const stats = await fs.stat(itemPath);
          if (stats.isDirectory()) {
            await fs.rm(itemPath, { recursive: true, force: true });
          } else {
            await fs.unlink(itemPath);
          }
          pushRedoAction(action);
          logger.debug('[Undo] Deleted created item:', itemPath);
          return { success: true };

        default:
          return { success: false, error: 'Unknown action type' };
      }
    } catch (error) {
      console.error('[Undo] Error:', error);
      undoStack.push(action);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('redo-action', async (_event: IpcMainInvokeEvent): Promise<ApiResponse> => {
    if (redoStack.length === 0) {
      return { success: false, error: 'Nothing to redo' };
    }

    const action = redoStack.pop()!;
    logger.debug('[Redo] Redoing action:', action.type);

    try {
      switch (action.type) {
        case 'rename':
          try {
            await fs.access(action.data.oldPath);
          } catch {
            logger.debug('[Redo] Source file no longer exists:', action.data.oldPath);
            return { success: false, error: 'Cannot redo: Source file no longer exists' };
          }

          try {
            await fs.access(action.data.newPath);
            logger.debug('[Redo] Target path already exists:', action.data.newPath);
            return {
              success: false,
              error: 'Cannot redo: A file already exists at the target location',
            };
          } catch {}

          await fs.rename(action.data.oldPath, action.data.newPath);
          undoStack.push(action);
          logger.debug('[Redo] Renamed:', action.data.oldPath, '->', action.data.newPath);
          return { success: true };

        case 'move':
          const redoDestPath = action.data.destPath;
          const newMovedPaths: string[] = [];
          const originalPaths = action.data.originalPaths;

          if (Array.isArray(originalPaths) && originalPaths.length > 0) {
            for (const originalPath of originalPaths) {
              const fileName = path.basename(originalPath);
              const newPath = path.join(redoDestPath, fileName);
              try {
                await fs.access(originalPath);
              } catch {
                logger.debug('[Redo] File not found at expected location:', originalPath);
                return {
                  success: false,
                  error: 'Cannot redo: File not found at original location',
                };
              }
              try {
                await fs.access(newPath);
                logger.debug('[Redo] Target path already exists:', newPath);
                return {
                  success: false,
                  error: 'Cannot redo: A file already exists at the target location',
                };
              } catch {}
              await movePath(originalPath, newPath);
              newMovedPaths.push(newPath);
            }
          } else {
            const redoOriginalParent = action.data.originalParent;
            const filesToMove = action.data.sourcePaths;

            if (!redoOriginalParent) {
              return { success: false, error: 'Cannot redo: Original parent path not available' };
            }

            for (const sourcePath of filesToMove) {
              const fileName = path.basename(sourcePath);
              const currentPath = path.join(redoOriginalParent, fileName);
              const newPath = path.join(redoDestPath, fileName);
              try {
                await fs.access(currentPath);
              } catch {
                logger.debug('[Redo] File not found at expected location:', currentPath);
                return {
                  success: false,
                  error: 'Cannot redo: File not found at original location',
                };
              }
              try {
                await fs.access(newPath);
                logger.debug('[Redo] Target path already exists:', newPath);
                return {
                  success: false,
                  error: 'Cannot redo: A file already exists at the target location',
                };
              } catch {}
              await movePath(currentPath, newPath);
              newMovedPaths.push(newPath);
            }
          }
          action.data.sourcePaths = newMovedPaths;
          undoStack.push(action);
          logger.debug('[Redo] Moved to destination');
          return { success: true };

        case 'create':
          const itemPath = action.data.path;

          try {
            await fs.access(itemPath);
            logger.debug('[Redo] Item already exists at path:', itemPath);
            return {
              success: false,
              error: 'Cannot redo: A file or folder already exists at this location',
            };
          } catch {}

          if (action.data.isDirectory) {
            await fs.mkdir(itemPath);
          } else {
            await fs.writeFile(itemPath, '');
          }
          undoStack.push(action);
          logger.debug('[Redo] Recreated item:', itemPath);
          return { success: true };

        default:
          return { success: false, error: 'Unknown action type' };
      }
    } catch (error) {
      console.error('[Redo] Error:', error);
      redoStack.push(action);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle(
    'get-undo-redo-state',
    async (): Promise<{ canUndo: boolean; canRedo: boolean }> => {
      return {
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
      };
    }
  );
}
