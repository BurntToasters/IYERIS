import { ipcMain, app, dialog, shell, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import type {
  FileItem,
  ApiResponse,
  DirectoryResponse,
  PathResponse,
  PropertiesResponse,
} from './types';
import { tryWithElevation } from './elevatedOperations';
import {
  getMainWindow,
  getFileTasks,
  HIDDEN_FILE_CACHE_TTL,
  HIDDEN_FILE_CACHE_MAX,
} from './appState';
import { isPathSafe, isUrlSafe, getErrorMessage } from './security';
import { getDriveInfo, getDrives } from './utils';
import { pushUndoAction, getUndoStack, clearUndoStackForPath } from './undoRedoManager';
import { registerDirectoryOperationTarget, unregisterDirectoryOperationTarget } from './ipcUtils';

const hiddenFileCache = new Map<string, { isHidden: boolean; timestamp: number }>();
let isCleaningCache = false;
let hiddenFileCacheCleanupInterval: NodeJS.Timeout | null = null;
type AppPathName = Parameters<typeof app.getPath>[0];

function normalizeCaseKey(targetPath: string): string {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return targetPath.toLowerCase();
  }
  return targetPath;
}

function normalizePathForComparison(targetPath: string): string {
  return normalizeCaseKey(path.resolve(targetPath));
}

interface PlannedFileOperation {
  sourcePath: string;
  destPath: string;
  itemName: string;
  isDirectory: boolean;
  overwrite?: boolean;
}

type FileOperationType = 'copy' | 'move';
type ConflictBehavior = 'ask' | 'rename' | 'skip' | 'overwrite' | 'cancel';

async function generateUniqueName(destPath: string, fileName: string): Promise<string> {
  const { base, ext } = splitFileName(fileName);
  let counter = 2;
  let candidatePath = path.join(destPath, fileName);
  while (
    await fs
      .stat(candidatePath)
      .then(() => true)
      .catch(() => false)
  ) {
    const candidateName = `${base} (${counter})${ext}`;
    candidatePath = path.join(destPath, candidateName);
    counter++;
    if (counter > 9999) throw new Error('Unable to generate unique name');
  }
  return candidatePath;
}

async function validateFileOperation(
  sourcePaths: string[],
  destPath: string,
  operationType: FileOperationType,
  conflictBehavior: ConflictBehavior = 'ask',
  resolveConflict?: (fileName: string) => Promise<'rename' | 'skip' | 'overwrite' | 'cancel'>
): Promise<{ success: true; planned: PlannedFileOperation[] } | { success: false; error: string }> {
  if (!isPathSafe(destPath)) {
    console.warn(`[Security] Invalid destination path rejected:`, destPath);
    return { success: false, error: 'Invalid destination path' };
  }

  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    return { success: false, error: 'No source items provided' };
  }

  const normalizedDestPath = normalizePathForComparison(destPath);
  const planned: PlannedFileOperation[] = [];
  const destKeys = new Set<string>();

  for (const sourcePath of sourcePaths) {
    if (!isPathSafe(sourcePath)) {
      console.warn(`[Security] Invalid source path rejected:`, sourcePath);
      return { success: false, error: 'Invalid source path' };
    }

    const itemName = path.basename(sourcePath);
    const itemDestPath = path.join(destPath, itemName);
    const destKey = normalizeCaseKey(itemDestPath);

    if (destKeys.has(destKey)) {
      return { success: false, error: `Multiple items share the same name: "${itemName}"` };
    }
    destKeys.add(destKey);

    let stats: fsSync.Stats;
    try {
      stats = await fs.stat(sourcePath);
    } catch {
      console.log(`[${operationType}] Source file not found:`, sourcePath);
      return { success: false, error: `Source file not found: ${itemName}` };
    }

    if (stats.isDirectory()) {
      // prevent copying dir into itself
      const normalizedSourcePath = normalizePathForComparison(sourcePath);
      if (
        normalizedDestPath === normalizedSourcePath ||
        normalizedDestPath.startsWith(normalizedSourcePath + path.sep)
      ) {
        return {
          success: false,
          error: `Cannot ${operationType} "${itemName}" into itself or a subfolder`,
        };
      }
    }

    const destExists = await fs
      .stat(itemDestPath)
      .then(() => true)
      .catch(() => false);
    if (destExists) {
      let behavior = conflictBehavior;
      if (behavior === 'ask' && resolveConflict) {
        behavior = await resolveConflict(itemName);
        if (behavior === 'cancel') {
          return { success: false, error: 'Operation cancelled' };
        }
      }
      if (behavior === 'skip') {
        continue;
      } else if (behavior === 'rename') {
        const newDestPath = await generateUniqueName(destPath, itemName);
        planned.push({
          sourcePath,
          destPath: newDestPath,
          itemName: path.basename(newDestPath),
          isDirectory: stats.isDirectory(),
        });
        continue;
      } else if (behavior === 'overwrite') {
        planned.push({
          sourcePath,
          destPath: itemDestPath,
          itemName,
          isDirectory: stats.isDirectory(),
          overwrite: true,
        });
        continue;
      }
      return {
        success: false,
        error: `A file named "${itemName}" already exists in the destination`,
      };
    }

    planned.push({
      sourcePath,
      destPath: itemDestPath,
      itemName,
      isDirectory: stats.isDirectory(),
    });
  }

  return { success: true, planned };
}

function splitFileName(fileName: string): { base: string; ext: string } {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot <= 0) {
    return { base: fileName, ext: '' };
  }
  return { base: fileName.slice(0, lastDot), ext: fileName.slice(lastDot) };
}

async function createBackupPath(destPath: string): Promise<string> {
  const dir = path.dirname(destPath);
  const base = path.basename(destPath);
  for (let attempt = 0; attempt < 10; attempt++) {
    const suffix = `.iyeris-backup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const candidate = path.join(dir, `.${base}${suffix}`);
    const exists = await fs
      .stat(candidate)
      .then(() => true)
      .catch(() => false);
    if (!exists) return candidate;
  }
  throw new Error('Unable to create backup path');
}

async function getBackupRoot(): Promise<string> {
  const root = path.join(app.getPath('userData'), 'overwrite-backups');
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function stashBackup(backupPath: string, destPath: string): Promise<string> {
  const root = await getBackupRoot();
  const base = path.basename(destPath);
  const hash = crypto.createHash('sha256').update(destPath).digest('hex').slice(0, 8);
  const ext = path.extname(base);
  const baseName = ext ? base.slice(0, -ext.length) : base;

  let counter = 0;
  while (counter < 1000) {
    const suffix = counter === 0 ? `${hash}` : `${hash}-${counter}`;
    const candidate = path.join(root, `${baseName}.${suffix}${ext || ''}.bak`);
    const exists = await fs
      .stat(candidate)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      try {
        await fs.rename(backupPath, candidate);
        return candidate;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'EXDEV') {
          const stats = await fs.stat(backupPath);
          if (stats.isDirectory()) {
            await fs.cp(backupPath, candidate, { recursive: true });
          } else {
            await fs.copyFile(backupPath, candidate);
          }
          await fs.rm(backupPath, { recursive: true, force: true });
          return candidate;
        }
        throw error;
      }
    }
    counter++;
  }

  throw new Error('Unable to stash backup');
}

async function stashRemainingBackups(backups: Map<string, string>): Promise<string[]> {
  const stashed: string[] = [];
  for (const [destPath, backupPath] of backups) {
    const exists = await fs
      .stat(backupPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) continue;
    try {
      const newPath = await stashBackup(backupPath, destPath);
      stashed.push(newPath);
    } catch {}
  }
  return stashed;
}

async function backupExistingPath(destPath: string): Promise<string> {
  const backupPath = await createBackupPath(destPath);
  try {
    await fs.rename(destPath, backupPath);
    return backupPath;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EXDEV') {
      const stats = await fs.stat(destPath);
      if (stats.isDirectory()) {
        await fs.cp(destPath, backupPath, { recursive: true });
      } else {
        await fs.copyFile(destPath, backupPath);
      }
      await fs.rm(destPath, { recursive: true, force: true });
      return backupPath;
    }
    throw error;
  }
}

async function restoreBackup(backupPath: string, destPath: string): Promise<void> {
  try {
    await fs.rm(destPath, { recursive: true, force: true });
  } catch {}

  try {
    await fs.rename(backupPath, destPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EXDEV') {
      const stats = await fs.stat(backupPath);
      if (stats.isDirectory()) {
        await fs.cp(backupPath, destPath, { recursive: true });
      } else {
        await fs.copyFile(backupPath, destPath);
      }
      await fs.rm(backupPath, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}

async function createUniqueFile(
  parentPath: string,
  fileName: string
): Promise<{ name: string; path: string }> {
  const { base, ext } = splitFileName(fileName);
  const MAX_ATTEMPTS = 9999;
  let counter = 1;

  // find available name with (n) suffix
  while (counter <= MAX_ATTEMPTS) {
    const candidateName = counter === 1 ? fileName : `${base} (${counter})${ext}`;
    const candidatePath = path.join(parentPath, candidateName);
    try {
      const handle = await fs.open(candidatePath, 'wx');
      await handle.close();
      return { name: candidateName, path: candidatePath };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EEXIST') {
        counter += 1;
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Unable to create unique file after ${MAX_ATTEMPTS} attempts`);
}

async function isFileHidden(filePath: string, fileName: string): Promise<boolean> {
  if (fileName.startsWith('.')) {
    return true;
  }

  // win hidden attr check
  if (process.platform === 'win32') {
    try {
      const execFilePromise = promisify(execFile);

      const { stdout } = await execFilePromise('attrib', [filePath], {
        timeout: 500,
        windowsHide: true,
      });

      const line = stdout.split(/\r?\n/).find((item) => item.trim().length > 0);
      if (!line) return false;
      const match = line.match(/^\s*([A-Za-z ]+)\s+.+$/);
      if (!match) return false;
      return match[1].toUpperCase().includes('H');
    } catch {
      return false;
    }
  }

  return false;
}

function cleanupHiddenFileCache(): void {
  if (isCleaningCache) return;
  isCleaningCache = true;

  try {
    const now = Date.now();
    let entriesRemoved = 0;

    // expire old entries
    for (const [key, value] of hiddenFileCache) {
      if (now - value.timestamp > HIDDEN_FILE_CACHE_TTL) {
        hiddenFileCache.delete(key);
        entriesRemoved++;
      }
    }

    if (hiddenFileCache.size > HIDDEN_FILE_CACHE_MAX) {
      const entries = Array.from(hiddenFileCache.entries()).sort(
        (a, b) => a[1].timestamp - b[1].timestamp
      );
      const toRemove = entries.slice(0, hiddenFileCache.size - HIDDEN_FILE_CACHE_MAX);
      for (const [key] of toRemove) {
        hiddenFileCache.delete(key);
        entriesRemoved++;
      }
    }

    if (entriesRemoved > 0) {
      console.log(
        `[Cache] Cleaned up ${entriesRemoved} hidden file cache entries, ${hiddenFileCache.size} remaining`
      );
    }
  } finally {
    isCleaningCache = false;
  }
}

export async function isFileHiddenCached(filePath: string, fileName: string): Promise<boolean> {
  if (fileName.startsWith('.')) {
    return true;
  }

  if (process.platform !== 'win32') {
    return false;
  }

  const cached = hiddenFileCache.get(filePath);
  if (cached && Date.now() - cached.timestamp < HIDDEN_FILE_CACHE_TTL) {
    return cached.isHidden;
  }

  const isHidden = await isFileHidden(filePath, fileName);

  if (hiddenFileCache.size >= HIDDEN_FILE_CACHE_MAX) {
    cleanupHiddenFileCache();
  }

  hiddenFileCache.set(filePath, { isHidden, timestamp: Date.now() });

  return isHidden;
}

export function startHiddenFileCacheCleanup(): void {
  if (!hiddenFileCacheCleanupInterval) {
    hiddenFileCacheCleanupInterval = setInterval(cleanupHiddenFileCache, 5 * 60 * 1000);
  }
}

export function stopHiddenFileCacheCleanup(): void {
  if (hiddenFileCacheCleanupInterval) {
    clearInterval(hiddenFileCacheCleanupInterval);
    hiddenFileCacheCleanupInterval = null;
  }
  hiddenFileCache.clear();
}

export function setupFileOperationHandlers(): void {
  const fileTasks = getFileTasks();

  startHiddenFileCacheCleanup();

  ipcMain.handle(
    'get-directory-contents',
    async (
      event: IpcMainInvokeEvent,
      dirPath: string,
      requestOperationId?: string,
      includeHidden?: boolean,
      streamOnly?: boolean
    ): Promise<DirectoryResponse> => {
      if (!isPathSafe(dirPath)) {
        console.warn('[Security] Invalid path rejected:', dirPath);
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

        return { success: true, contents: streamOnly ? undefined : result.contents };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      } finally {
        unregisterDirectoryOperationTarget(operationId);
        sender.removeListener('destroyed', handleDestroyed);
      }
    }
  );

  ipcMain.handle(
    'cancel-directory-contents',
    async (_event: IpcMainInvokeEvent, operationId: string): Promise<ApiResponse> => {
      try {
        if (!operationId) {
          return { success: false, error: 'Missing operationId' };
        }
        unregisterDirectoryOperationTarget(operationId);
        fileTasks.cancelOperation(operationId);
        return { success: true };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle('get-drives', async (): Promise<string[]> => {
    return getDrives();
  });

  ipcMain.handle('get-drive-info', async () => {
    return getDriveInfo();
  });

  ipcMain.handle('get-home-directory', (): string => {
    return app.getPath('home');
  });

  const specialDirectoryMap: Record<string, AppPathName> = {
    desktop: 'desktop',
    documents: 'documents',
    downloads: 'downloads',
    music: 'music',
    videos: 'videos',
  };

  ipcMain.handle(
    'get-special-directory',
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

  ipcMain.handle(
    'open-file',
    async (_event: IpcMainInvokeEvent, filePath: string): Promise<ApiResponse> => {
      try {
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
          } catch {}
        }

        if (parsed) {
          if (!isUrlSafe(filePath)) {
            console.warn('[Security] Unsafe URL rejected:', filePath);
            return { success: false, error: 'Invalid or unsafe URL' };
          }
          if (parsed.protocol === 'file:') {
            const targetPath = fileURLToPath(parsed);
            if (!isPathSafe(targetPath)) {
              console.warn('[Security] Invalid path rejected:', targetPath);
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
          console.warn('[Security] Invalid path rejected:', filePath);
          return { success: false, error: 'Invalid path' };
        }
        const openResult = await shell.openPath(filePath);
        if (openResult) {
          return { success: false, error: openResult };
        }
        return { success: true };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle('select-folder', async (): Promise<PathResponse> => {
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
    return { success: false };
  });

  ipcMain.handle(
    'create-folder',
    async (
      _event: IpcMainInvokeEvent,
      parentPath: string,
      folderName: string
    ): Promise<PathResponse> => {
      try {
        if (!isPathSafe(parentPath)) {
          console.warn('[Security] Invalid parent path rejected:', parentPath);
          return { success: false, error: 'Invalid path' };
        }
        if (
          !folderName ||
          folderName === '.' ||
          folderName === '..' ||
          folderName.includes('/') ||
          folderName.includes('\\')
        ) {
          console.warn('[Security] Invalid folder name rejected:', folderName);
          return { success: false, error: 'Invalid folder name' };
        }

        const newPath = path.join(parentPath, folderName);

        await fs.mkdir(newPath);

        pushUndoAction({
          type: 'create',
          data: {
            path: newPath,
            isDirectory: true,
          },
        });

        console.log('[Create] Folder created:', newPath);
        return { success: true, path: newPath };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    'trash-item',
    async (_event: IpcMainInvokeEvent, itemPath: string): Promise<ApiResponse> => {
      try {
        if (!isPathSafe(itemPath)) {
          console.warn('[Security] Invalid path rejected:', itemPath);
          return { success: false, error: 'Invalid path' };
        }

        await shell.trashItem(itemPath);

        clearUndoStackForPath(itemPath);

        console.log(
          '[Trash] Item moved to trash:',
          itemPath,
          '- Undo stack size:',
          getUndoStack().length
        );
        return { success: true };
      } catch (error) {
        console.error('[Trash] Error:', error);
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle('open-trash', async (): Promise<ApiResponse> => {
    try {
      const platform = process.platform;

      if (platform === 'darwin') {
        const trashPath = path.join(app.getPath('home'), '.Trash');
        await shell.openPath(trashPath);
      } else if (platform === 'win32') {
        await shell.openExternal('shell:RecycleBinFolder');
      } else if (platform === 'linux') {
        const trashPath = path.join(app.getPath('home'), '.local/share/Trash/files');
        await shell.openPath(trashPath);
      }

      console.log('[Trash] Opened system trash folder');
      return { success: true };
    } catch (error) {
      console.error('[Trash] Error opening trash:', error);
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle(
    'delete-item',
    async (_event: IpcMainInvokeEvent, itemPath: string): Promise<ApiResponse> => {
      try {
        if (!isPathSafe(itemPath)) {
          console.warn('[Security] Invalid path rejected:', itemPath);
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

        console.log(
          '[Delete] Item permanently deleted:',
          itemPath,
          result.elevated ? '(elevated)' : ''
        );
        return { success: true };
      } catch (error) {
        console.error('[Delete] Error:', error);
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    'rename-item',
    async (_event: IpcMainInvokeEvent, oldPath: string, newName: string): Promise<PathResponse> => {
      if (!isPathSafe(oldPath)) {
        console.warn('[Security] Invalid path rejected:', oldPath);
        return { success: false, error: 'Invalid path' };
      }
      if (
        !newName ||
        newName === '.' ||
        newName === '..' ||
        newName.includes('/') ||
        newName.includes('\\')
      ) {
        console.warn('[Security] Invalid new name rejected:', newName);
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

        console.log(
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

  ipcMain.handle(
    'create-file',
    async (
      _event: IpcMainInvokeEvent,
      parentPath: string,
      fileName: string
    ): Promise<PathResponse> => {
      try {
        if (!isPathSafe(parentPath)) {
          console.warn('[Security] Invalid parent path rejected:', parentPath);
          return { success: false, error: 'Invalid path' };
        }
        if (
          !fileName ||
          fileName === '.' ||
          fileName === '..' ||
          fileName.includes('/') ||
          fileName.includes('\\')
        ) {
          console.warn('[Security] Invalid file name rejected:', fileName);
          return { success: false, error: 'Invalid file name' };
        }

        const created = await createUniqueFile(parentPath, fileName);

        pushUndoAction({
          type: 'create',
          data: {
            path: created.path,
            isDirectory: false,
          },
        });

        console.log('[Create] File created:', created.path);
        return { success: true, path: created.path };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    'get-item-properties',
    async (_event: IpcMainInvokeEvent, itemPath: string): Promise<PropertiesResponse> => {
      if (!isPathSafe(itemPath)) {
        return { success: false, error: 'Invalid path' };
      }
      try {
        const stats = await fs.stat(itemPath);
        return {
          success: true,
          properties: {
            path: itemPath,
            name: path.basename(itemPath),
            size: stats.size,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime,
          },
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    'copy-items',
    async (
      _event: IpcMainInvokeEvent,
      sourcePaths: string[],
      destPath: string,
      conflictBehavior?: ConflictBehavior
    ): Promise<ApiResponse> => {
      try {
        const behavior = conflictBehavior || 'ask';
        const resolveConflict =
          behavior === 'ask'
            ? async (fileName: string) => {
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
              }
            : undefined;
        const validation = await validateFileOperation(
          sourcePaths,
          destPath,
          'copy',
          behavior,
          resolveConflict
        );
        if (!validation.success) {
          return validation;
        }

        const copiedPaths: string[] = [];
        const backups = new Map<string, string>();
        try {
          const PARALLEL_BATCH_SIZE = 4;
          for (let i = 0; i < validation.planned.length; i += PARALLEL_BATCH_SIZE) {
            const batch = validation.planned.slice(i, i + PARALLEL_BATCH_SIZE);
            await Promise.all(
              batch.map(async (item) => {
                if (item.overwrite) {
                  if (!backups.has(item.destPath)) {
                    const backupPath = await backupExistingPath(item.destPath);
                    backups.set(item.destPath, backupPath);
                  }
                }
                if (item.isDirectory) {
                  await fs.cp(item.sourcePath, item.destPath, { recursive: true });
                } else {
                  await fs.copyFile(item.sourcePath, item.destPath);
                }
                copiedPaths.push(item.destPath);
              })
            );
          }
        } catch (error) {
          for (const copied of copiedPaths.reverse()) {
            try {
              await fs.rm(copied, { recursive: true, force: true });
            } catch {}
          }
          for (const [destPath, backupPath] of backups) {
            try {
              await restoreBackup(backupPath, destPath);
            } catch {}
          }
          const stashed = await stashRemainingBackups(backups);
          const baseError = getErrorMessage(error);
          const errorMessage =
            stashed.length > 0
              ? `${baseError}. Backups saved in: ${path.dirname(stashed[0])}`
              : baseError;
          return { success: false, error: errorMessage };
        }

        for (const backupPath of backups.values()) {
          try {
            await fs.rm(backupPath, { recursive: true, force: true });
          } catch {}
        }

        return { success: true };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    'move-items',
    async (
      _event: IpcMainInvokeEvent,
      sourcePaths: string[],
      destPath: string,
      conflictBehavior?: ConflictBehavior
    ): Promise<ApiResponse> => {
      try {
        const behavior = conflictBehavior || 'ask';
        const resolveConflict =
          behavior === 'ask'
            ? async (fileName: string) => {
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
              }
            : undefined;
        const validation = await validateFileOperation(
          sourcePaths,
          destPath,
          'move',
          behavior,
          resolveConflict
        );
        if (!validation.success) {
          return validation;
        }

        const originalParent = path.dirname(sourcePaths[0]);
        const movedPaths: string[] = [];
        const originalPaths: string[] = [];
        const completed: Array<{ sourcePath: string; newPath: string }> = [];
        const backups = new Map<string, string>();

        try {
          const PARALLEL_BATCH_SIZE = 4;
          for (let i = 0; i < validation.planned.length; i += PARALLEL_BATCH_SIZE) {
            const batch = validation.planned.slice(i, i + PARALLEL_BATCH_SIZE);
            await Promise.all(
              batch.map(async (item) => {
                if (item.overwrite) {
                  if (!backups.has(item.destPath)) {
                    const backupPath = await backupExistingPath(item.destPath);
                    backups.set(item.destPath, backupPath);
                  }
                }
                try {
                  await fs.rename(item.sourcePath, item.destPath);
                } catch (renameError) {
                  const err = renameError as NodeJS.ErrnoException;
                  if (err.code === 'EXDEV') {
                    if (item.isDirectory) {
                      await fs.cp(item.sourcePath, item.destPath, { recursive: true });
                    } else {
                      await fs.copyFile(item.sourcePath, item.destPath);
                    }
                    await fs.rm(item.sourcePath, { recursive: true, force: true });
                  } else {
                    throw renameError;
                  }
                }
                originalPaths.push(item.sourcePath);
                movedPaths.push(item.destPath);
                completed.push({ sourcePath: item.sourcePath, newPath: item.destPath });
              })
            );
          }
        } catch (error) {
          for (const item of completed.reverse()) {
            try {
              await fs.rename(item.newPath, item.sourcePath);
            } catch (restoreError) {
              const err = restoreError as NodeJS.ErrnoException;
              if (err.code === 'EXDEV') {
                try {
                  const stats = await fs.stat(item.newPath);
                  if (stats.isDirectory()) {
                    await fs.cp(item.newPath, item.sourcePath, { recursive: true });
                  } else {
                    await fs.copyFile(item.newPath, item.sourcePath);
                  }
                  await fs.rm(item.newPath, { recursive: true, force: true });
                } catch {}
              }
            }
          }
          for (const [destPath, backupPath] of backups) {
            const exists = await fs
              .stat(destPath)
              .then(() => true)
              .catch(() => false);
            if (exists) {
              continue;
            }
            try {
              await restoreBackup(backupPath, destPath);
            } catch {}
          }
          const stashed = await stashRemainingBackups(backups);
          const baseMessage = error instanceof Error ? error.message : String(error);
          const errorMessage =
            stashed.length > 0
              ? `${baseMessage}. Backups saved in: ${path.dirname(stashed[0])}`
              : baseMessage;
          return { success: false, error: errorMessage };
        }

        for (const backupPath of backups.values()) {
          try {
            await fs.rm(backupPath, { recursive: true, force: true });
          } catch {}
        }

        pushUndoAction({
          type: 'move',
          data: {
            sourcePaths: movedPaths,
            originalPaths: originalPaths,
            destPath: destPath,
            originalParent: originalParent,
          },
        });

        console.log('[Move] Items moved:', sourcePaths.length);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    }
  );
}
