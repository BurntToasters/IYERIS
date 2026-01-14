import { ipcMain, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import type { ApiResponse } from './types';
import { getMainWindow } from './appState';
import { isPathSafe, getErrorMessage } from './security';
import { get7zipModule, get7zipPath } from './platformUtils';
import { logger } from './utils/logger';

interface ArchiveProcess {
  operationId: string;
  process: any;
  startTime: number;
}

const activeArchiveProcesses = new Map<string, ArchiveProcess>();

async function assertArchiveEntriesSafe(archivePath: string, destPath: string): Promise<void> {
  const Seven = get7zipModule();
  const sevenZipPath = get7zipPath();

  const entries = await new Promise<string[]>((resolve, reject) => {
    const list = Seven.list(archivePath, { $bin: sevenZipPath });
    const names: string[] = [];

    list.on('data', (data: { file?: string }) => {
      if (data && data.file) {
        names.push(String(data.file));
      }
    });
    list.on('end', () => resolve(names));
    list.on('error', (err: Error) => reject(err));
  });

  const destRoot = path.resolve(destPath);
  const destRootWithSep = destRoot.endsWith(path.sep) ? destRoot : destRoot + path.sep;
  const invalidEntries: string[] = [];

  for (const entry of entries) {
    if (!entry) continue;

    const normalized = entry.replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!normalized) continue;
    if (
      normalized.startsWith('/') ||
      normalized.startsWith('//') ||
      /^[a-zA-Z]:/.test(normalized)
    ) {
      invalidEntries.push(entry);
      continue;
    }
    const parts = normalized.split('/');
    if (parts.some((part) => part === '..')) {
      invalidEntries.push(entry);
      continue;
    }

    const targetPath = path.resolve(destRoot, normalized);
    if (targetPath !== destRoot && !targetPath.startsWith(destRootWithSep)) {
      invalidEntries.push(entry);
    }
  }

  if (invalidEntries.length > 0) {
    const preview = invalidEntries.slice(0, 5).join(', ');
    throw new Error(
      `Archive contains unsafe paths: ${preview}${invalidEntries.length > 5 ? '...' : ''}`
    );
  }
}

async function assertExtractedPathsSafe(destPath: string): Promise<void> {
  const destRoot = await fs.realpath(destPath);
  const destRootWithSep = destRoot.endsWith(path.sep) ? destRoot : destRoot + path.sep;
  const unsafe: string[] = [];
  const stack: string[] = [destRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      let stat: fsSync.Stats;
      try {
        stat = await fs.lstat(fullPath);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) {
        unsafe.push(fullPath);
        try {
          await fs.unlink(fullPath);
        } catch {}
        continue;
      }

      let realPath: string;
      try {
        realPath = await fs.realpath(fullPath);
      } catch {
        unsafe.push(fullPath);
        try {
          await fs.rm(fullPath, { recursive: true, force: true });
        } catch {}
        continue;
      }

      if (realPath !== destRoot && !realPath.startsWith(destRootWithSep)) {
        unsafe.push(fullPath);
        try {
          await fs.rm(fullPath, { recursive: true, force: true });
        } catch {}
        continue;
      }

      if (stat.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }

  if (unsafe.length > 0) {
    const preview = unsafe.slice(0, 5).join(', ');
    throw new Error(
      `Archive extraction created unsafe paths: ${preview}${unsafe.length > 5 ? '...' : ''}`
    );
  }
}

export function setupArchiveHandlers(): void {
  ipcMain.handle(
    'compress-files',
    async (
      _event: IpcMainInvokeEvent,
      sourcePaths: string[],
      outputPath: string,
      format: string = 'zip',
      operationId?: string
    ): Promise<ApiResponse> => {
      try {
        if (!isPathSafe(outputPath)) {
          logger.warn('[Security] Invalid output path rejected:', outputPath);
          return { success: false, error: 'Invalid output path' };
        }

        for (const sourcePath of sourcePaths) {
          if (!isPathSafe(sourcePath)) {
            logger.warn('[Security] Invalid source path rejected:', sourcePath);
            return { success: false, error: 'Invalid source path' };
          }
        }

        const allowedFormats = ['zip', '7z', 'tar', 'tar.gz', 'gz'];
        if (!allowedFormats.includes(format)) {
          logger.warn('[Security] Invalid archive format rejected:', format);
          return { success: false, error: 'Invalid archive format' };
        }

        logger.info(
          '[Compress] Starting compression:',
          sourcePaths,
          'to',
          outputPath,
          'format:',
          format
        );

        try {
          await fs.access(outputPath);
          logger.info('[Compress] Removing existing file:', outputPath);
          await fs.unlink(outputPath);
        } catch (err) {}

        const mainWindow = getMainWindow();

        if (format === 'tar.gz') {
          return new Promise(async (resolve, reject) => {
            const Seven = get7zipModule();
            const sevenZipPath = get7zipPath();
            logger.info('[Compress] Using 7zip at:', sevenZipPath);
            const tarPath = outputPath.replace(/\.gz$/, '');
            logger.info('[Compress] Creating tar file:', tarPath);

            const tarOptions: any = {
              $bin: sevenZipPath,
              recursive: true,
              $raw: ['-xr!My Music', '-xr!My Pictures', '-xr!My Videos'],
            };

            const tarProcess = Seven.add(tarPath, sourcePaths, tarOptions);

            if (operationId) {
              activeArchiveProcesses.set(operationId, {
                operationId,
                process: tarProcess,
                startTime: Date.now(),
              });
            }

            let fileCount = 0;

            tarProcess.on('progress', (progress: { file?: string }) => {
              fileCount++;
              if (
                mainWindow &&
                !mainWindow.isDestroyed() &&
                mainWindow.webContents &&
                !mainWindow.webContents.isDestroyed()
              ) {
                mainWindow.webContents.send('compress-progress', {
                  operationId,
                  current: fileCount,
                  total: fileCount + 20,
                  name: progress.file || 'Creating tar...',
                });
              }
            });

            tarProcess.on('end', async () => {
              logger.info('[Compress] Tar created, now compressing with gzip...');
              const gzipProcess = Seven.add(outputPath, [tarPath], {
                $bin: sevenZipPath,
              });

              if (operationId) {
                activeArchiveProcesses.set(operationId, {
                  operationId,
                  process: gzipProcess,
                  startTime: Date.now(),
                });
              }

              gzipProcess.on('progress', () => {
                if (
                  mainWindow &&
                  !mainWindow.isDestroyed() &&
                  mainWindow.webContents &&
                  !mainWindow.webContents.isDestroyed()
                ) {
                  mainWindow.webContents.send('compress-progress', {
                    operationId,
                    current: fileCount + 10,
                    total: fileCount + 20,
                    name: 'Compressing with gzip...',
                  });
                }
              });

              gzipProcess.on('end', async () => {
                logger.info('[Compress] tar.gz compression completed');

                try {
                  await fs.unlink(tarPath);
                } catch (err) {
                  logger.error('[Compress] Failed to delete intermediate tar:', err);
                }

                if (operationId) {
                  activeArchiveProcesses.delete(operationId);
                }
                resolve({ success: true });
              });

              gzipProcess.on('error', async (error: { message?: string; level?: string }) => {
                logger.error('[Compress] Gzip error:', error);

                try {
                  await fs.unlink(tarPath);
                } catch {}
                try {
                  await fs.unlink(outputPath);
                } catch {}

                if (operationId) {
                  activeArchiveProcesses.delete(operationId);
                }

                const errorMsg = error.message || '';
                if (error.level === 'WARNING' && errorMsg.includes('Access is denied')) {
                  logger.info(
                    '[Compress] Warning about access denied, but gzip compression may have succeeded'
                  );
                  resolve({ success: true });
                } else {
                  reject({ success: false, error: errorMsg || 'Gzip compression failed' });
                }
              });
            });

            tarProcess.on('error', async (error: { message?: string; level?: string }) => {
              logger.error('[Compress] Tar error:', error);

              try {
                await fs.unlink(tarPath);
              } catch {}

              if (operationId) {
                activeArchiveProcesses.delete(operationId);
              }

              const errorMsg = error.message || '';
              if (error.level === 'WARNING' && errorMsg.includes('Access is denied')) {
                logger.info(
                  '[Compress] Warning about access denied, but tar creation may have succeeded'
                );
                const gzipProcess = Seven.add(outputPath, [tarPath], {
                  $bin: sevenZipPath,
                });

                if (operationId) {
                  activeArchiveProcesses.set(operationId, {
                    operationId,
                    process: gzipProcess,
                    startTime: Date.now(),
                  });
                }

                gzipProcess.on('end', async () => {
                  try {
                    await fs.unlink(tarPath);
                  } catch {}
                  if (operationId) {
                    activeArchiveProcesses.delete(operationId);
                  }
                  resolve({ success: true });
                });

                gzipProcess.on('error', async (gzipError: { message?: string }) => {
                  try {
                    await fs.unlink(tarPath);
                    await fs.unlink(outputPath);
                  } catch {}
                  if (operationId) {
                    activeArchiveProcesses.delete(operationId);
                  }
                  reject({ success: false, error: gzipError.message || 'Gzip compression failed' });
                });
              } else {
                reject({ success: false, error: errorMsg || 'Tar creation failed' });
              }
            });
          });
        }

        return new Promise((resolve, reject) => {
          const Seven = get7zipModule();
          const sevenZipPath = get7zipPath();
          logger.info('[Compress] Using 7zip at:', sevenZipPath);

          const options: any = {
            $bin: sevenZipPath,
            recursive: true,
            $raw: ['-xr!My Music', '-xr!My Pictures', '-xr!My Videos'],
          };

          const seven = Seven.add(outputPath, sourcePaths, options);

          if (operationId) {
            activeArchiveProcesses.set(operationId, {
              operationId,
              process: seven,
              startTime: Date.now(),
            });
          }

          let fileCount = 0;

          seven.on('progress', (progress: { file?: string }) => {
            fileCount++;
            if (
              mainWindow &&
              !mainWindow.isDestroyed() &&
              mainWindow.webContents &&
              !mainWindow.webContents.isDestroyed()
            ) {
              mainWindow.webContents.send('compress-progress', {
                operationId,
                current: fileCount,
                total: fileCount + 10,
                name: progress.file || 'Compressing...',
              });
            }
          });

          seven.on('end', () => {
            logger.info('[Compress] 7zip compression completed for format:', format);
            if (operationId) {
              activeArchiveProcesses.delete(operationId);
            }
            resolve({ success: true });
          });

          seven.on('error', (error: { message?: string; level?: string }) => {
            logger.error('[Compress] 7zip error:', error);
            if (operationId) {
              activeArchiveProcesses.delete(operationId);
            }
            fs.unlink(outputPath).catch(() => {});

            const errorMsg = error.message || '';
            if (error.level === 'WARNING' && errorMsg.includes('Access is denied')) {
              logger.info(
                '[Compress] Warning about access denied, but compression may have succeeded'
              );
              resolve({ success: true });
            } else {
              reject({ success: false, error: errorMsg || 'Compression failed' });
            }
          });
        });
      } catch (error) {
        logger.error('[Compress] Error:', error);
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    'extract-archive',
    async (
      _event: IpcMainInvokeEvent,
      archivePath: string,
      destPath: string,
      operationId?: string
    ): Promise<ApiResponse> => {
      try {
        if (!isPathSafe(archivePath)) {
          logger.warn('[Security] Invalid archive path rejected:', archivePath);
          return { success: false, error: 'Invalid archive path' };
        }
        if (!isPathSafe(destPath)) {
          logger.warn('[Security] Invalid destination path rejected:', destPath);
          return { success: false, error: 'Invalid destination path' };
        }

        logger.info('[Extract] Starting extraction:', archivePath, 'to', destPath);

        await fs.mkdir(destPath, { recursive: true });
        try {
          await assertArchiveEntriesSafe(archivePath, destPath);
        } catch (error) {
          logger.error('[Extract] Unsafe archive:', error);
          return { success: false, error: 'Archive contains unsafe paths' };
        }

        const mainWindow = getMainWindow();

        return new Promise((resolve, reject) => {
          const Seven = get7zipModule();
          const sevenZipPath = get7zipPath();
          logger.info('[Extract] Using 7zip at:', sevenZipPath);

          const seven = Seven.extractFull(archivePath, destPath, {
            $bin: sevenZipPath,
            recursive: true,
          });

          if (operationId) {
            activeArchiveProcesses.set(operationId, {
              operationId,
              process: seven,
              startTime: Date.now(),
            });
          }

          let fileCount = 0;

          seven.on('progress', (progress: { file?: string }) => {
            fileCount++;
            if (
              mainWindow &&
              !mainWindow.isDestroyed() &&
              mainWindow.webContents &&
              !mainWindow.webContents.isDestroyed()
            ) {
              mainWindow.webContents.send('extract-progress', {
                operationId,
                current: fileCount,
                total: fileCount + 10,
                name: progress.file || 'Extracting...',
              });
            }
          });

          seven.on('end', async () => {
            console.log('[Extract] 7zip extraction completed for:', archivePath);
            try {
              await assertExtractedPathsSafe(destPath);
              if (operationId) {
                activeArchiveProcesses.delete(operationId);
              }
              resolve({ success: true });
            } catch (error) {
              logger.error('[Extract] Post-extraction safety check failed:', error);
              if (operationId) {
                activeArchiveProcesses.delete(operationId);
              }
              reject({ success: false, error: getErrorMessage(error) });
            }
          });

          seven.on('error', (error: { message?: string }) => {
            logger.error('[Extract] 7zip extraction error:', error);
            if (operationId) {
              activeArchiveProcesses.delete(operationId);
            }
            reject({ success: false, error: error.message || 'Extraction failed' });
          });
        });
      } catch (error) {
        logger.error('[Extract] Error:', error);
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    'cancel-archive-operation',
    async (_event: IpcMainInvokeEvent, operationId: string): Promise<ApiResponse> => {
      try {
        const process = activeArchiveProcesses.get(operationId);
        if (!process) {
          logger.warn('[Archive] Operation not found for cancellation:', operationId);
          return { success: false, error: 'Operation not found' };
        }

        logger.info('[Archive] Cancelling operation:', operationId);
        if (process.process?._childProcess) {
          try {
            process.process._childProcess.kill('SIGTERM');
          } catch (killError) {
            logger.debug('[Archive] Process already terminated:', killError);
          }
        } else if (typeof process.process?.cancel === 'function') {
          process.process.cancel();
        }

        activeArchiveProcesses.delete(operationId);
        return { success: true };
      } catch (error) {
        logger.error('[Archive] Cancel error:', error);
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );
}

const ARCHIVE_OPERATION_TIMEOUT = 30 * 60 * 1000;

export function cleanupArchiveOperations(): void {
  const now = Date.now();
  for (const [operationId, archiveProcess] of activeArchiveProcesses) {
    try {
      if (now - archiveProcess.startTime > ARCHIVE_OPERATION_TIMEOUT) {
        logger.warn('[Cleanup] Cleaning up stale archive operation:', operationId);
      } else {
        logger.info('[Cleanup] Aborting archive operation:', operationId);
      }
      if (archiveProcess.process?._childProcess) {
        archiveProcess.process._childProcess.kill('SIGTERM');
      } else if (typeof archiveProcess.process?.cancel === 'function') {
        archiveProcess.process.cancel();
      }
    } catch (error) {
      logger.error('[Cleanup] Error aborting archive operation:', error);
    }
  }
  activeArchiveProcesses.clear();
}
