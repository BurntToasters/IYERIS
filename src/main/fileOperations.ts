import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain, app, dialog, shell } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import type * as fsSync from 'fs';
import { fileURLToPath } from 'url';
import * as os from 'os';
import { spawn } from 'child_process';
import type {
  FileItem,
  ApiResponse,
  DirectoryResponse,
  PathResponse,
  PropertiesResponse,
} from '../types';
import { tryWithElevation } from './elevatedOperations';
import { getMainWindow, getFileTasks } from './appState';
import { isPathSafe, isUrlSafe, getErrorMessage } from './security';
import { ignoreError } from '../shared';
import { logger } from './logger';
import {
  isFileHiddenCached,
  startHiddenFileCacheCleanup,
  stopHiddenFileCacheCleanup,
} from './hiddenFileCache';
import {
  cleanupBackups,
  restoreOverwriteBackups,
  ensureOverwriteBackup,
  stashRemainingBackups,
  cleanupStashedBackupsForTests,
} from './backupManager';
import { getDriveInfo, getDrives } from './utils';
import { pushUndoAction, getUndoStack, clearUndoStackForPath } from './undoRedoManager';
import {
  registerDirectoryOperationTarget,
  unregisterDirectoryOperationTarget,
  withTrustedApiHandler,
  withTrustedIpcEvent,
} from './ipcUtils';
import {
  renameWithExdevFallback,
  validateFileOperation,
  copyPathByType,
  removePaths,
  createUniqueFile,
  isValidChildName,
  getParallelBatchSize,
  type ConflictBehavior,
} from './fileOperationUtils';

export {
  pathExists,
  renameWithExdevFallback,
  type PlannedFileOperation,
} from './fileOperationUtils';

type AppPathName = Parameters<typeof app.getPath>[0];

export { cleanupStashedBackupsForTests };

export { isFileHiddenCached, startHiddenFileCacheCleanup, stopHiddenFileCacheCleanup };

export function setupFileOperationHandlers(): void {
  const fileTasks = getFileTasks();

  startHiddenFileCacheCleanup();

  const handleTrustedApi = <
    TArgs extends unknown[],
    TResult extends { success: boolean; error?: string },
  >(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult,
    untrustedResponse?: TResult
  ): void => {
    ipcMain.handle(channel, withTrustedApiHandler(channel, handler, untrustedResponse));
  };

  const handleTrustedEvent = <TArgs extends unknown[], TResult>(
    channel: string,
    untrustedResponse: TResult,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult
  ): void => {
    ipcMain.handle(channel, withTrustedIpcEvent(channel, untrustedResponse, handler));
  };

  handleTrustedApi(
    'get-directory-contents',
    async (
      event: IpcMainInvokeEvent,
      dirPath: string,
      requestOperationId?: string,
      includeHidden?: boolean,
      streamOnly?: boolean
    ): Promise<DirectoryResponse> => {
      if (!isPathSafe(dirPath)) {
        logger.warn('[Security] Invalid path rejected:', dirPath);
        return { success: false, error: 'Invalid path' };
      }

      const operationId =
        requestOperationId || `list-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const sender = event.sender;
      const handleDestroyed = () => {
        unregisterDirectoryOperationTarget(operationId);
        fileTasks.cancelOperation(operationId);
      };

      sender.once('destroyed', handleDestroyed);
      registerDirectoryOperationTarget(operationId, sender);

      try {
        const result = await fileTasks.runTask<{ contents: FileItem[] }>(
          'list-directory',
          {
            dirPath,
            batchSize: 500,
            includeHidden: Boolean(includeHidden),
            streamOnly: Boolean(streamOnly),
          },
          operationId
        );

        return { success: true, contents: streamOnly ? [] : result.contents };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      } finally {
        unregisterDirectoryOperationTarget(operationId);
        sender.removeListener('destroyed', handleDestroyed);
      }
    }
  );

  handleTrustedApi(
    'cancel-directory-contents',
    async (_event: IpcMainInvokeEvent, operationId: string): Promise<ApiResponse> => {
      if (!operationId) {
        return { success: false, error: 'Missing operationId' };
      }
      unregisterDirectoryOperationTarget(operationId);
      fileTasks.cancelOperation(operationId);
      return { success: true };
    }
  );

  handleTrustedEvent('get-drives', [] as string[], async (): Promise<string[]> => getDrives());

  handleTrustedEvent('get-drive-info', [], async () => getDriveInfo());

  handleTrustedEvent('get-home-directory', '', (): string => app.getPath('home'));

  const specialDirectoryMap: Record<string, AppPathName> = {
    desktop: 'desktop',
    documents: 'documents',
    downloads: 'downloads',
    music: 'music',
    videos: 'videos',
  };

  handleTrustedEvent(
    'get-special-directory',
    { success: false, error: 'Untrusted IPC sender' } as PathResponse,
    (_event: IpcMainInvokeEvent, directory: string): PathResponse => {
      const mappedPath = specialDirectoryMap[directory];
      if (!mappedPath) {
        return { success: false, error: 'Unsupported directory' };
      }
      try {
        return { success: true, path: app.getPath(mappedPath) };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  handleTrustedApi(
    'open-file',
    async (_event: IpcMainInvokeEvent, filePath: string): Promise<ApiResponse> => {
      const looksLikeWindowsPath =
        process.platform === 'win32' &&
        (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\'));
      let parsed: URL | null = null;

      const looksLikeUrl =
        !looksLikeWindowsPath &&
        (/^(https?|file):/i.test(filePath) ||
          /^mailto:/i.test(filePath) ||
          /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(filePath));

      if (looksLikeUrl) {
        try {
          parsed = new URL(filePath);
        } catch (error) {
          ignoreError(error);
        }
      }

      if (parsed) {
        if (!isUrlSafe(filePath)) {
          logger.warn('[Security] Unsafe URL rejected:', filePath);
          return { success: false, error: 'Invalid or unsafe URL' };
        }
        if (parsed.protocol === 'file:') {
          const targetPath = fileURLToPath(parsed);
          if (!isPathSafe(targetPath)) {
            logger.warn('[Security] Invalid path rejected:', targetPath);
            return { success: false, error: 'Invalid path' };
          }
          const openResult = await shell.openPath(targetPath);
          if (openResult) {
            return { success: false, error: openResult };
          }
          return { success: true };
        }

        await shell.openExternal(filePath);
        return { success: true };
      }

      if (!isPathSafe(filePath)) {
        logger.warn('[Security] Invalid path rejected:', filePath);
        return { success: false, error: 'Invalid path' };
      }
      const openResult = await shell.openPath(filePath);
      if (openResult) {
        return { success: false, error: openResult };
      }
      return { success: true };
    }
  );

  handleTrustedEvent(
    'select-folder',
    { success: false, error: 'Untrusted IPC sender' } as PathResponse,
    async (): Promise<PathResponse> => {
      const mainWindow = getMainWindow();
      if (!mainWindow) {
        return { success: false, error: 'No main window available' };
      }

      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
      });

      if (!result.canceled && result.filePaths.length > 0) {
        return { success: true, path: result.filePaths[0] };
      }
      return { success: false, error: 'No folder selected' };
    }
  );

  handleTrustedApi(
    'create-folder',
    async (
      _event: IpcMainInvokeEvent,
      parentPath: string,
      folderName: string
    ): Promise<PathResponse> => {
      if (!isPathSafe(parentPath)) {
        logger.warn('[Security] Invalid parent path rejected:', parentPath);
        return { success: false, error: 'Invalid path' };
      }
      if (!isValidChildName(folderName)) {
        logger.warn('[Security] Invalid folder name rejected:', folderName);
        return { success: false, error: 'Invalid folder name' };
      }

      const newPath = path.join(parentPath, folderName);

      await fs.mkdir(newPath);

      pushUndoAction({
        type: 'create',
        data: {
          path: newPath,
          isDirectory: true,
          createdAtMs: Date.now(),
        },
      });

      logger.info('[Create] Folder created:', newPath);
      return { success: true, path: newPath };
    }
  );

  handleTrustedApi(
    'trash-item',
    async (_event: IpcMainInvokeEvent, itemPath: string): Promise<ApiResponse> => {
      try {
        if (!isPathSafe(itemPath)) {
          logger.warn('[Security] Invalid path rejected:', itemPath);
          return { success: false, error: 'Invalid path' };
        }

        await shell.trashItem(itemPath);

        clearUndoStackForPath(itemPath);

        logger.info(
          '[Trash] Item moved to trash:',
          itemPath,
          '- Undo stack size:',
          getUndoStack().length
        );
        return { success: true };
      } catch (error) {
        logger.error('[Trash] Error:', error);
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  handleTrustedApi('open-trash', async (): Promise<ApiResponse> => {
    try {
      const platform = process.platform;

      if (platform === 'darwin') {
        const trashPath = path.join(app.getPath('home'), '.Trash');
        const openResult = await shell.openPath(trashPath);
        if (openResult) {
          return { success: false, error: openResult };
        }
      } else if (platform === 'win32') {
        await shell.openExternal('shell:RecycleBinFolder');
      } else if (platform === 'linux') {
        const gioResult = await new Promise<boolean>((resolve) => {
          const child = spawn('gio', ['open', 'trash:///'], {
            stdio: 'ignore',
            detached: true,
          });
          child.on('spawn', () => {
            child.unref();
            resolve(true);
          });
          child.on('error', () => resolve(false));
        });
        if (!gioResult) {
          const xdgResult = await new Promise<boolean>((resolve) => {
            const child = spawn('xdg-open', ['trash:///'], {
              stdio: 'ignore',
              detached: true,
            });
            child.on('spawn', () => {
              child.unref();
              resolve(true);
            });
            child.on('error', () => resolve(false));
          });
          if (!xdgResult) {
            const trashPath = path.join(app.getPath('home'), '.local/share/Trash/files');
            const openResult = await shell.openPath(trashPath);
            if (openResult) {
              return { success: false, error: openResult };
            }
          }
        }
      }

      logger.info('[Trash] Opened system trash folder');
      return { success: true };
    } catch (error) {
      logger.error('[Trash] Error opening trash:', error);
      return { success: false, error: getErrorMessage(error) };
    }
  });

  handleTrustedApi(
    'delete-item',
    async (_event: IpcMainInvokeEvent, itemPath: string): Promise<ApiResponse> => {
      try {
        if (!isPathSafe(itemPath)) {
          logger.warn('[Security] Invalid path rejected:', itemPath);
          return { success: false, error: 'Invalid path' };
        }

        clearUndoStackForPath(itemPath);

        const deleteOp = async () => {
          const stats = await fs.stat(itemPath);
          if (stats.isDirectory()) {
            await fs.rm(itemPath, { recursive: true, force: true });
          } else {
            await fs.unlink(itemPath);
          }
        };

        const result = await tryWithElevation(
          deleteOp,
          { type: 'delete', sourcePath: itemPath },
          'delete'
        );

        if (result.error) {
          return { success: false, error: result.error };
        }

        logger.info(
          '[Delete] Item permanently deleted:',
          itemPath,
          result.elevated ? '(elevated)' : ''
        );
        return { success: true };
      } catch (error) {
        logger.error('[Delete] Error:', error);
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  handleTrustedApi(
    'rename-item',
    async (_event: IpcMainInvokeEvent, oldPath: string, newName: string): Promise<PathResponse> => {
      if (!isPathSafe(oldPath)) {
        logger.warn('[Security] Invalid path rejected:', oldPath);
        return { success: false, error: 'Invalid path' };
      }
      if (!isValidChildName(newName)) {
        logger.warn('[Security] Invalid new name rejected:', newName);
        return { success: false, error: 'Invalid file name' };
      }

      const oldName = path.basename(oldPath);
      const newPath = path.join(path.dirname(oldPath), newName);
      try {
        const renameOp = async () => {
          await fs.rename(oldPath, newPath);
        };

        const result = await tryWithElevation(
          renameOp,
          { type: 'rename', sourcePath: oldPath, newName },
          'rename'
        );

        if (result.error) {
          return { success: false, error: result.error };
        }

        pushUndoAction({
          type: 'rename',
          data: {
            oldPath: oldPath,
            newPath: newPath,
            oldName: oldName,
            newName: newName,
          },
        });

        logger.info(
          '[Rename] Item renamed:',
          oldPath,
          '->',
          newPath,
          result.elevated ? '(elevated)' : ''
        );
        return { success: true, path: newPath };
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          return { success: false, error: 'Item not found' };
        }
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  handleTrustedApi(
    'create-file',
    async (
      _event: IpcMainInvokeEvent,
      parentPath: string,
      fileName: string
    ): Promise<PathResponse> => {
      if (!isPathSafe(parentPath)) {
        logger.warn('[Security] Invalid parent path rejected:', parentPath);
        return { success: false, error: 'Invalid path' };
      }
      if (!isValidChildName(fileName)) {
        logger.warn('[Security] Invalid file name rejected:', fileName);
        return { success: false, error: 'Invalid file name' };
      }

      const created = await createUniqueFile(parentPath, fileName);

      pushUndoAction({
        type: 'create',
        data: {
          path: created.path,
          isDirectory: false,
          createdAtMs: Date.now(),
        },
      });

      logger.info('[Create] File created:', created.path);
      return { success: true, path: created.path };
    }
  );

  handleTrustedApi(
    'get-item-properties',
    async (_event: IpcMainInvokeEvent, itemPath: string): Promise<PropertiesResponse> => {
      if (!isPathSafe(itemPath)) {
        return { success: false, error: 'Invalid path' };
      }
      const stats = await fs.stat(itemPath);
      let isSymlink = false;
      let symlinkTarget: string | undefined;
      try {
        const lstats = await fs.lstat(itemPath);
        isSymlink = lstats.isSymbolicLink();
        if (isSymlink) {
          symlinkTarget = await fs.readlink(itemPath);
        }
      } catch {}
      const properties: import('../types').ItemProperties = {
        path: itemPath,
        name: path.basename(itemPath),
        size: stats.size,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        isSymlink: isSymlink || undefined,
        symlinkTarget,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
        mode: stats.mode,
      };

      if (process.platform !== 'win32') {
        try {
          const userInfo = os.userInfo();
          properties.owner = stats.uid === userInfo.uid ? userInfo.username : String(stats.uid);
          properties.group = String(stats.gid);
        } catch {
          properties.owner = String(stats.uid);
          properties.group = String(stats.gid);
        }
      } else {
        try {
          const { execFile: execFileCb } = await import('child_process');
          const { promisify } = await import('util');
          const execFileAsync = promisify(execFileCb);
          const { stdout } = await execFileAsync('attrib', [itemPath], {
            timeout: 2000,
            windowsHide: true,
          });
          const line = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
          if (line) {
            const match = line.match(/^\s*([A-Za-z ]+)\s+.+$/);
            if (match) {
              const attrs = match[1].toUpperCase();
              properties.isReadOnly = attrs.includes('R');
              properties.isHiddenAttr = attrs.includes('H');
              properties.isSystemAttr = attrs.includes('S');
            }
          }
        } catch {}
      }

      if (process.platform === 'win32' && itemPath.endsWith('.lnk')) {
        try {
          const details = shell.readShortcutLink(itemPath);
          properties.isShortcut = true;
          properties.shortcutTarget = details.target;
        } catch {}
      }

      if (process.platform === 'darwin') {
        try {
          const { execFile: execFileCb } = await import('child_process');
          const { promisify } = await import('util');
          const execFileAsync = promisify(execFileCb);
          const { stdout } = await execFileAsync(
            'mdls',
            ['-name', 'kMDItemUserTags', '-raw', itemPath],
            {
              timeout: 3000,
            }
          );
          const trimmed = stdout.trim();
          if (trimmed && trimmed !== '(null)') {
            const tags = trimmed
              .replace(/^\(/, '')
              .replace(/\)$/, '')
              .split(',')
              .map((t: string) =>
                t
                  .trim()
                  .replace(/^"|"$/g, '')
                  .replace(/\\n\\t/g, '')
                  .trim()
              )
              .filter(Boolean);
            if (tags.length > 0) {
              properties.macTags = tags;
            }
          }
        } catch {}
      }

      return { success: true, properties };
    }
  );

  handleTrustedApi(
    'set-permissions',
    async (_event: IpcMainInvokeEvent, itemPath: string, mode: number): Promise<ApiResponse> => {
      if (!isPathSafe(itemPath)) return { success: false, error: 'Invalid path' };
      if (process.platform === 'win32')
        return { success: false, error: 'Use set-attributes on Windows' };
      try {
        const chmodOp = async () => {
          await fs.chmod(itemPath, mode);
        };
        const result = await tryWithElevation(
          chmodOp,
          { type: 'custom' as 'delete', sourcePath: itemPath },
          'change permissions'
        );
        if (result.error) return { success: false, error: result.error };
        logger.info('[Permissions] Changed permissions for', itemPath, 'to', mode.toString(8));
        return { success: true };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  handleTrustedApi(
    'set-attributes',
    async (
      _event: IpcMainInvokeEvent,
      itemPath: string,
      attrs: { readOnly?: boolean; hidden?: boolean }
    ): Promise<ApiResponse> => {
      if (!isPathSafe(itemPath)) return { success: false, error: 'Invalid path' };
      if (process.platform !== 'win32')
        return { success: false, error: 'Attributes only supported on Windows' };
      try {
        const { execFile: execFileCb } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFileCb);
        const args: string[] = [];
        if (attrs.readOnly !== undefined) args.push(attrs.readOnly ? '+R' : '-R');
        if (attrs.hidden !== undefined) args.push(attrs.hidden ? '+H' : '-H');
        if (args.length === 0) return { success: true };
        args.push(itemPath);
        await execFileAsync('attrib', args, { timeout: 5000, windowsHide: true });
        logger.info('[Attributes] Changed attributes for', itemPath, args.join(' '));
        return { success: true };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  function createConflictResolver(behavior: ConflictBehavior) {
    if (behavior !== 'ask') return undefined;
    return async (fileName: string) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return 'skip' as const;
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Replace', 'Keep Both', 'Skip', 'Cancel'],
        defaultId: 2,
        cancelId: 3,
        title: 'File Conflict',
        message: `"${fileName}" already exists in this location.`,
        detail: 'What would you like to do?',
      });
      return (['overwrite', 'rename', 'skip', 'cancel'] as const)[response];
    };
  }

  handleTrustedApi(
    'copy-items',
    async (
      event: IpcMainInvokeEvent,
      sourcePaths: string[],
      destPath: string,
      conflictBehavior?: ConflictBehavior
    ): Promise<ApiResponse> => {
      try {
        const behavior = conflictBehavior || 'ask';
        const resolveConflict = createConflictResolver(behavior);
        const validation = await validateFileOperation(
          sourcePaths,
          destPath,
          'copy',
          behavior,
          resolveConflict,
          isPathSafe,
          logger
        );
        if (!validation.success) {
          return validation;
        }

        const totalItems = validation.planned.length;
        const copiedPaths: string[] = [];
        const backups = new Map<string, string>();
        try {
          const PARALLEL_BATCH_SIZE = getParallelBatchSize();
          for (let i = 0; i < validation.planned.length; i += PARALLEL_BATCH_SIZE) {
            const batch = validation.planned.slice(i, i + PARALLEL_BATCH_SIZE);
            const settled = await Promise.allSettled(
              batch.map(async (item) => {
                await ensureOverwriteBackup(backups, item);
                await copyPathByType(item.sourcePath, item.destPath, item.isDirectory);
                copiedPaths.push(item.destPath);
              })
            );
            const rejected = settled.find(
              (result): result is PromiseRejectedResult => result.status === 'rejected'
            );
            if (rejected) {
              throw rejected.reason;
            }
            if (totalItems > 1) {
              event.sender.send('file-operation-progress', {
                operation: 'copy',
                current: copiedPaths.length,
                total: totalItems,
                name: batch[batch.length - 1].destPath.split(/[\\/]/).pop() || '',
              });
            }
          }
        } catch (error) {
          await removePaths([...copiedPaths].reverse());
          await restoreOverwriteBackups(backups);
          const stashed = await stashRemainingBackups(backups);
          const baseError = getErrorMessage(error);
          const errorMessage =
            stashed.length > 0
              ? `${baseError}. Backups saved in: ${path.dirname(stashed[0])}`
              : baseError;
          return { success: false, error: errorMessage };
        }

        await cleanupBackups(backups.values());

        return { success: true };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  handleTrustedApi(
    'move-items',
    async (
      event: IpcMainInvokeEvent,
      sourcePaths: string[],
      destPath: string,
      conflictBehavior?: ConflictBehavior
    ): Promise<ApiResponse> => {
      try {
        const behavior = conflictBehavior || 'ask';
        const resolveConflict = createConflictResolver(behavior);
        const validation = await validateFileOperation(
          sourcePaths,
          destPath,
          'move',
          behavior,
          resolveConflict,
          isPathSafe,
          logger
        );
        if (!validation.success) {
          return validation;
        }

        const totalItems = validation.planned.length;
        const originalParent = path.dirname(sourcePaths[0]);
        const movedPaths: string[] = [];
        const originalPaths: string[] = [];
        const completed: Array<{ sourcePath: string; newPath: string; isDirectory: boolean }> = [];
        const backups = new Map<string, string>();

        try {
          const PARALLEL_BATCH_SIZE = getParallelBatchSize();
          for (let i = 0; i < validation.planned.length; i += PARALLEL_BATCH_SIZE) {
            const batch = validation.planned.slice(i, i + PARALLEL_BATCH_SIZE);
            const settled = await Promise.allSettled(
              batch.map(async (item) => {
                await ensureOverwriteBackup(backups, item);
                await renameWithExdevFallback(item.sourcePath, item.destPath, item.isDirectory);
                originalPaths.push(item.sourcePath);
                movedPaths.push(item.destPath);
                completed.push({
                  sourcePath: item.sourcePath,
                  newPath: item.destPath,
                  isDirectory: item.isDirectory,
                });
              })
            );
            const rejected = settled.find(
              (result): result is PromiseRejectedResult => result.status === 'rejected'
            );
            if (rejected) {
              throw rejected.reason;
            }
            if (totalItems > 1) {
              event.sender.send('file-operation-progress', {
                operation: 'move',
                current: movedPaths.length,
                total: totalItems,
                name: batch[batch.length - 1].destPath.split(/[\\/]/).pop() || '',
              });
            }
          }
        } catch (error) {
          for (const item of completed.reverse()) {
            try {
              await renameWithExdevFallback(item.newPath, item.sourcePath, item.isDirectory);
            } catch (restoreError) {
              ignoreError(restoreError);
            }
          }
          await restoreOverwriteBackups(backups, true);
          const stashed = await stashRemainingBackups(backups);
          const baseMessage = error instanceof Error ? error.message : String(error);
          const errorMessage =
            stashed.length > 0
              ? `${baseMessage}. Backups saved in: ${path.dirname(stashed[0])}`
              : baseMessage;
          return { success: false, error: errorMessage };
        }

        await cleanupBackups(backups.values());

        pushUndoAction({
          type: 'move',
          data: {
            sourcePaths: movedPaths,
            originalPaths: originalPaths,
            destPath: destPath,
            originalParent: originalParent,
          },
        });

        logger.info('[Move] Items moved:', sourcePaths.length);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    }
  );

  handleTrustedApi(
    'batch-rename',
    async (
      _event: IpcMainInvokeEvent,
      items: Array<{ oldPath: string; newName: string }>
    ): Promise<ApiResponse> => {
      if (!Array.isArray(items) || items.length === 0) {
        return { success: false, error: 'No items to rename' };
      }

      const completed: Array<{ oldPath: string; newPath: string }> = [];

      try {
        for (const item of items) {
          if (!isPathSafe(item.oldPath)) {
            throw new Error(`Invalid path: ${item.oldPath}`);
          }

          const dir = path.dirname(item.oldPath);
          const newPath = path.join(dir, item.newName);

          if (item.oldPath === newPath) continue;

          const exists = await fs.access(newPath).then(
            () => true,
            () => false
          );
          if (exists) {
            throw new Error(`"${item.newName}" already exists`);
          }

          await renameWithExdevFallback(item.oldPath, newPath, false);
          completed.push({ oldPath: item.oldPath, newPath });
        }

        if (completed.length > 0) {
          pushUndoAction({
            type: 'batch-rename',
            data: {
              renames: completed,
            },
          });
        }

        logger.info('[BatchRename] Renamed:', completed.length, 'items');
        return { success: true };
      } catch (error) {
        for (const item of completed.reverse()) {
          try {
            await renameWithExdevFallback(item.newPath, item.oldPath, false);
          } catch (restoreError) {
            ignoreError(restoreError);
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    }
  );

  handleTrustedApi(
    'create-symlink',
    async (
      _event: IpcMainInvokeEvent,
      targetPath: string,
      linkPath: string
    ): Promise<ApiResponse> => {
      if (!isPathSafe(targetPath) || !isPathSafe(linkPath)) {
        return { success: false, error: 'Invalid path' };
      }

      try {
        let stats: fsSync.Stats;
        try {
          stats = await fs.stat(targetPath);
        } catch {
          return { success: false, error: 'Target does not exist' };
        }

        const symlinkType = stats.isDirectory() ? 'dir' : 'file';

        if (process.platform === 'win32') {
          const result = await tryWithElevation(
            async () => {
              await fs.symlink(targetPath, linkPath, symlinkType);
            },
            { type: 'copy', sourcePath: targetPath, destPath: linkPath },
            'create symlink'
          );
          if (result.error) {
            return {
              success: false,
              error:
                result.error ||
                'Failed to create symlink. On Windows, this may require administrator privileges or Developer Mode.',
            };
          }
        } else {
          await fs.symlink(targetPath, linkPath);
        }

        logger.info('[Symlink] Created:', linkPath, '->', targetPath);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    }
  );
}
