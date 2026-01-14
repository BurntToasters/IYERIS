import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { UndoAction, ApiResponse } from './types';
import { MAX_UNDO_STACK_SIZE } from './appState';

const undoStack: UndoAction[] = [];
const redoStack: UndoAction[] = [];

export function pushUndoAction(action: UndoAction): void {
  undoStack.push(action);
  if (undoStack.length > MAX_UNDO_STACK_SIZE) {
    undoStack.shift();
  }
  redoStack.length = 0;
  console.log('[Undo] Action pushed:', action.type, 'Stack size:', undoStack.length);
}

export function pushRedoAction(action: UndoAction): void {
  redoStack.push(action);
  if (redoStack.length > MAX_UNDO_STACK_SIZE) {
    redoStack.shift();
  }
  console.log('[Redo] Action pushed:', action.type, 'Stack size:', redoStack.length);
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
  const pathsToRemove = [itemPath];

  for (let i = undoStack.length - 1; i >= 0; i--) {
    const action = undoStack[i];
    if (action.type === 'rename' && action.data.newPath === itemPath) {
      pathsToRemove.push(action.data.oldPath);
    }
  }

  for (let i = undoStack.length - 1; i >= 0; i--) {
    const action = undoStack[i];
    let shouldRemove = false;

    if (action.type === 'rename') {
      if (pathsToRemove.includes(action.data.oldPath) || pathsToRemove.includes(action.data.newPath)) {
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
      undoStack.splice(i, 1);
      console.log('[Trash] Removed related undo action:', action.type);
    }
  }
}

export function setupUndoRedoHandlers(): void {
  ipcMain.handle('undo-action', async (_event: IpcMainInvokeEvent): Promise<ApiResponse> => {
    if (undoStack.length === 0) {
      return { success: false, error: 'Nothing to undo' };
    }

    const action = undoStack.pop()!;
    console.log('[Undo] Undoing action:', action.type);

    try {
      switch (action.type) {
        case 'rename':
          try {
            await fs.access(action.data.newPath);
          } catch {
            console.log('[Undo] File no longer exists:', action.data.newPath);
            return { success: false, error: 'Cannot undo: File no longer exists (may have been moved or deleted)' };
          }

          try {
            await fs.access(action.data.oldPath);
            console.log('[Undo] Old path already exists:', action.data.oldPath);
            return { success: false, error: 'Cannot undo: A file already exists at the original location' };
          } catch {}

          await fs.rename(action.data.newPath, action.data.oldPath);
          pushRedoAction(action);
          console.log('[Undo] Renamed back:', action.data.newPath, '->', action.data.oldPath);
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
                console.log('[Undo] File no longer exists:', movedPath);
                return { success: false, error: 'Cannot undo: One or more files no longer exist' };
              }
            }

            for (const originalPath of originalPaths) {
              try {
                await fs.access(originalPath);
                console.log('[Undo] Original path already exists:', originalPath);
                return { success: false, error: 'Cannot undo: A file already exists at the original location' };
              } catch {}
            }

            for (let i = 0; i < movedPaths.length; i++) {
              await fs.rename(movedPaths[i], originalPaths[i]);
            }
          } else {
            if (!originalParent) {
              return { success: false, error: 'Cannot undo: Original parent path not available' };
            }

            for (const source of movedPaths) {
              try {
                await fs.access(source);
              } catch {
                console.log('[Undo] File no longer exists:', source);
                return { success: false, error: 'Cannot undo: One or more files no longer exist' };
              }
            }

            for (const source of movedPaths) {
              const fileName = path.basename(source);
              const originalPath = path.join(originalParent, fileName);
              await fs.rename(source, originalPath);
            }
          }
          pushRedoAction(action);
          console.log('[Undo] Moved back to original location');
          return { success: true };

        case 'create':
          const itemPath = action.data.path;

          try {
            await fs.access(itemPath);
          } catch {
            console.log('[Undo] Created item no longer exists:', itemPath);
            return { success: false, error: 'Cannot undo: File no longer exists' };
          }

          const stats = await fs.stat(itemPath);
          if (stats.isDirectory()) {
            await fs.rm(itemPath, { recursive: true, force: true });
          } else {
            await fs.unlink(itemPath);
          }
          pushRedoAction(action);
          console.log('[Undo] Deleted created item:', itemPath);
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
    console.log('[Redo] Redoing action:', action.type);

    try {
      switch (action.type) {
        case 'rename':
          try {
            await fs.access(action.data.oldPath);
          } catch {
            console.log('[Redo] Source file no longer exists:', action.data.oldPath);
            return { success: false, error: 'Cannot redo: Source file no longer exists' };
          }

          try {
            await fs.access(action.data.newPath);
            console.log('[Redo] Target path already exists:', action.data.newPath);
            return { success: false, error: 'Cannot redo: A file already exists at the target location' };
          } catch {}

          await fs.rename(action.data.oldPath, action.data.newPath);
          undoStack.push(action);
          console.log('[Redo] Renamed:', action.data.oldPath, '->', action.data.newPath);
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
                console.log('[Redo] File not found at expected location:', originalPath);
                return { success: false, error: 'Cannot redo: File not found at original location' };
              }
              try {
                await fs.access(newPath);
                console.log('[Redo] Target path already exists:', newPath);
                return { success: false, error: 'Cannot redo: A file already exists at the target location' };
              } catch {}
              await fs.rename(originalPath, newPath);
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
                console.log('[Redo] File not found at expected location:', currentPath);
                return { success: false, error: 'Cannot redo: File not found at original location' };
              }
              try {
                await fs.access(newPath);
                console.log('[Redo] Target path already exists:', newPath);
                return { success: false, error: 'Cannot redo: A file already exists at the target location' };
              } catch {}
              await fs.rename(currentPath, newPath);
              newMovedPaths.push(newPath);
            }
          }
          action.data.sourcePaths = newMovedPaths;
          undoStack.push(action);
          console.log('[Redo] Moved to destination');
          return { success: true };

        case 'create':
          const itemPath = action.data.path;

          try {
            await fs.access(itemPath);
            console.log('[Redo] Item already exists at path:', itemPath);
            return { success: false, error: 'Cannot redo: A file or folder already exists at this location' };
          } catch {}

          if (action.data.isDirectory) {
            await fs.mkdir(itemPath);
          } else {
            await fs.writeFile(itemPath, '');
          }
          undoStack.push(action);
          console.log('[Redo] Recreated item:', itemPath);
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

  ipcMain.handle('get-undo-redo-state', async (): Promise<{ canUndo: boolean; canRedo: boolean }> => {
    return {
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0
    };
  });
}
