import { ipcMain } from 'electron';
import type { WebContents, IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'fs';
import type { ApiResponse, AdvancedCompressOptions } from '../types';
import { getMainWindow } from './appState';
import { isPathSafe, getErrorMessage } from './security';
import { ignoreError } from '../shared';
import { get7zipModule, get7zipPath } from './platformUtils';
import { logger } from './logger';
import { isTrustedIpcEvent } from './ipcUtils';
import {
  buildAdvancedRawFlags,
  assertArchiveEntriesSafe,
  assertExtractedPathsSafe,
} from './archiveSafety';

export { buildAdvancedRawFlags } from './archiveSafety';

interface SevenZipOptions {
  $bin: string;
  recursive?: boolean;
  $raw?: string[];
}

interface SevenZipProgress {
  file?: string;
}

interface SevenZipError {
  message?: string;
  level?: string;
}

interface SevenZipProcess {
  on(event: 'progress', callback: (progress: SevenZipProgress) => void): void;
  on(event: 'end', callback: () => void): void;
  on(event: 'error', callback: (error: SevenZipError) => void): void;
  _childProcess?: { kill: (signal: string) => void };
  cancel?: () => void;
}

interface ArchiveProcess {
  operationId: string;
  process: SevenZipProcess;
  startTime: number;
}

const activeArchiveProcesses = new Map<string, ArchiveProcess>();

function safeSend(channel: string, data: unknown, sender?: WebContents | null): void {
  if (sender && !sender.isDestroyed()) {
    try {
      sender.send(channel, data);
      return;
    } catch {
      // fall through to mainWindow
    }
  }
  const mainWindow = getMainWindow();
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.webContents &&
    !mainWindow.webContents.isDestroyed()
  ) {
    mainWindow.webContents.send(channel, data);
  }
}

export function setupArchiveHandlers(): void {
  ipcMain.handle(
    'compress-files',
    async (
      event: IpcMainInvokeEvent,
      sourcePaths: string[],
      outputPath: string,
      format: string = 'zip',
      operationId?: string,
      advancedOptions?: AdvancedCompressOptions
    ): Promise<ApiResponse> => {
      try {
        if (!isTrustedIpcEvent(event, 'compress-files')) {
          return { success: false, error: 'Untrusted IPC sender' };
        }
        if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
          return { success: false, error: 'No source files provided' };
        }
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
        if (format === 'tar.gz') {
          const lowerOutput = outputPath.toLowerCase();
          if (!lowerOutput.endsWith('.tar.gz') && !lowerOutput.endsWith('.tgz')) {
            logger.warn('[Security] Invalid tar.gz output path:', outputPath);
            return { success: false, error: 'Output file must end with .tar.gz' };
          }
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
        } catch (error) {
          ignoreError(error);
        }

        if (format === 'tar.gz') {
          return new Promise((resolve) => {
            const Seven = get7zipModule();
            const sevenZipPath = get7zipPath();
            logger.info('[Compress] Using 7zip at:', sevenZipPath);
            const lowerOutputPath = outputPath.toLowerCase();
            const tarPath = lowerOutputPath.endsWith('.tgz')
              ? `${outputPath.slice(0, -4)}.tar`
              : outputPath.replace(/\.gz$/i, '');
            logger.info('[Compress] Creating tar file:', tarPath);

            const tarOptions: SevenZipOptions = {
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
              safeSend(
                'compress-progress',
                {
                  operationId,
                  current: fileCount,
                  total: fileCount + 20,
                  name: progress.file || 'Creating tar...',
                },
                event.sender
              );
            });

            tarProcess.on('end', () => {
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
                safeSend(
                  'compress-progress',
                  {
                    operationId,
                    current: fileCount + 10,
                    total: fileCount + 20,
                    name: 'Compressing with gzip...',
                  },
                  event.sender
                );
              });

              gzipProcess.on('end', () => {
                logger.info('[Compress] tar.gz compression completed');

                fs.unlink(tarPath).catch((err) => {
                  logger.error('[Compress] Failed to delete intermediate tar:', err);
                });

                if (operationId) {
                  activeArchiveProcesses.delete(operationId);
                }
                resolve({ success: true });
              });

              gzipProcess.on('error', (error: { message?: string; level?: string }) => {
                logger.error('[Compress] Gzip error:', error);

                fs.unlink(tarPath).catch(ignoreError);
                fs.unlink(outputPath).catch(ignoreError);

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
                  resolve({ success: false, error: errorMsg || 'Gzip compression failed' });
                }
              });
            });

            tarProcess.on('error', (error: { message?: string; level?: string }) => {
              logger.error('[Compress] Tar error:', error);

              fs.unlink(tarPath).catch(ignoreError);

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

                gzipProcess.on('end', () => {
                  fs.unlink(tarPath).catch(ignoreError);
                  if (operationId) {
                    activeArchiveProcesses.delete(operationId);
                  }
                  resolve({ success: true });
                });

                gzipProcess.on('error', (gzipError: { message?: string }) => {
                  fs.unlink(tarPath).catch(ignoreError);
                  fs.unlink(outputPath).catch(ignoreError);
                  if (operationId) {
                    activeArchiveProcesses.delete(operationId);
                  }
                  resolve({
                    success: false,
                    error: gzipError.message || 'Gzip compression failed',
                  });
                });
              } else {
                resolve({ success: false, error: errorMsg || 'Tar creation failed' });
              }
            });
          });
        }

        return new Promise((resolve, _reject) => {
          const Seven = get7zipModule();
          const sevenZipPath = get7zipPath();
          logger.info('[Compress] Using 7zip at:', sevenZipPath);

          const options: SevenZipOptions = {
            $bin: sevenZipPath,
            recursive: true,
            $raw: [
              '-xr!My Music',
              '-xr!My Pictures',
              '-xr!My Videos',
              ...buildAdvancedRawFlags(advancedOptions, format),
            ],
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
            safeSend(
              'compress-progress',
              {
                operationId,
                current: fileCount,
                total: fileCount + 10,
                name: progress.file || 'Compressing...',
              },
              event.sender
            );
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
            fs.unlink(outputPath).catch(ignoreError);

            const errorMsg = error.message || '';
            if (error.level === 'WARNING' && errorMsg.includes('Access is denied')) {
              logger.info(
                '[Compress] Warning about access denied, but compression may have succeeded'
              );
              resolve({ success: true });
            } else {
              resolve({ success: false, error: errorMsg || 'Compression failed' });
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
      event: IpcMainInvokeEvent,
      archivePath: string,
      destPath: string,
      operationId?: string
    ): Promise<ApiResponse> => {
      try {
        if (!isTrustedIpcEvent(event, 'extract-archive')) {
          return { success: false, error: 'Untrusted IPC sender' };
        }
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

        return new Promise((resolve, _reject) => {
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
            safeSend(
              'extract-progress',
              {
                operationId,
                current: fileCount,
                total: fileCount + 10,
                name: progress.file || 'Extracting...',
              },
              event.sender
            );
          });

          seven.on('end', async () => {
            logger.info('[Extract] 7zip extraction completed for:', archivePath);
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
              resolve({ success: false, error: getErrorMessage(error) });
            }
          });

          seven.on('error', async (error: { message?: string }) => {
            logger.error('[Extract] 7zip extraction error:', error);
            try {
              await assertExtractedPathsSafe(destPath);
            } catch (cleanupError) {
              logger.error('[Extract] Cleanup after error failed:', cleanupError);
            }
            if (operationId) {
              activeArchiveProcesses.delete(operationId);
            }
            resolve({ success: false, error: error.message || 'Extraction failed' });
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
    async (event: IpcMainInvokeEvent, operationId: string): Promise<ApiResponse> => {
      try {
        if (!isTrustedIpcEvent(event, 'cancel-archive-operation')) {
          return { success: false, error: 'Untrusted IPC sender' };
        }
        const process = activeArchiveProcesses.get(operationId);
        if (!process) {
          logger.warn('[Archive] Operation not found for cancellation:', operationId);
          return { success: false, error: 'Operation not found' };
        }

        logger.info('[Archive] Cancelling operation:', operationId);
        let cancelled = false;

        if (process.process?._childProcess) {
          try {
            process.process._childProcess.kill('SIGTERM');
            cancelled = true;
          } catch (killError) {
            logger.debug('[Archive] Process already terminated:', killError);
          }
        }

        if (!cancelled && typeof process.process?.cancel === 'function') {
          try {
            process.process.cancel();
            cancelled = true;
          } catch (cancelError) {
            logger.error('[Archive] Failed to cancel process:', cancelError);
          }
        }

        if (!cancelled) {
          logger.warn('[Archive] Unable to cancel process, no cancellation method available');
        }

        activeArchiveProcesses.delete(operationId);
        return { success: true };
      } catch (error) {
        logger.error('[Archive] Cancel error:', error);
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    'list-archive-contents',
    async (
      event: IpcMainInvokeEvent,
      archivePath: string
    ): Promise<{
      success: boolean;
      entries?: Array<{ name: string; size: number; isDirectory: boolean }>;
      error?: string;
    }> => {
      try {
        if (!isTrustedIpcEvent(event, 'list-archive-contents')) {
          return { success: false, error: 'Untrusted IPC sender' };
        }
        if (!isPathSafe(archivePath)) {
          return { success: false, error: 'Invalid archive path' };
        }

        const Seven = get7zipModule();
        const sevenZipPath = get7zipPath();

        const entries = await new Promise<
          Array<{ name: string; size: number; isDirectory: boolean }>
        >((resolve, reject) => {
          const list = Seven.list(archivePath, { $bin: sevenZipPath });
          const items: Array<{ name: string; size: number; isDirectory: boolean }> = [];

          list.on('data', (data: { file?: string; size?: number; attributes?: string }) => {
            if (data && data.file) {
              items.push({
                name: String(data.file),
                size: data.size || 0,
                isDirectory: data.attributes?.includes('D') || data.file.endsWith('/') || false,
              });
            }
          });
          list.on('end', () => resolve(items));
          list.on('error', (err: Error) => reject(err));
        });

        return { success: true, entries };
      } catch (error) {
        logger.error('[Archive] List contents error:', error);
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
