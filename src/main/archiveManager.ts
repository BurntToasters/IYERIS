import { ipcMain, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import type { ApiResponse, AdvancedCompressOptions } from '../types';
import { getMainWindow } from './appState';
import { isPathSafe, getErrorMessage } from './security';
import { ignoreError } from '../shared';
import { get7zipModule, get7zipPath } from './platformUtils';
import { logger } from './logger';
import { isTrustedIpcEvent } from './ipcUtils';

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

function safeSend(channel: string, data: unknown): void {
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

const SAFE_METHOD_VALUES = new Set([
  'LZMA',
  'LZMA2',
  'PPMd',
  'BZip2',
  'Deflate',
  'Deflate64',
  'Copy',
]);
const ZIP_METHODS_WITH_DICTIONARY = new Set(['LZMA', 'PPMd']);
const SAFE_SIZE_RE = /^\d{1,5}[kmg]?$/i;
const SAFE_THREADS_RE = /^[1-9]\d{0,1}$/;
const SAFE_ENCRYPTION_METHODS = new Set(['AES256', 'ZipCrypto']);

export function buildAdvancedRawFlags(
  opts: AdvancedCompressOptions | undefined,
  format: string
): string[] {
  const flags: string[] = [];
  if (!opts) return flags;

  if (typeof opts.compressionLevel === 'number' && Number.isFinite(opts.compressionLevel)) {
    const level = Math.max(0, Math.min(9, Math.round(opts.compressionLevel)));
    flags.push(`-mx=${level}`);
  }

  const safeMethod =
    typeof opts.method === 'string' && SAFE_METHOD_VALUES.has(opts.method) ? opts.method : null;

  if (safeMethod) {
    flags.push(format === 'zip' ? `-mm=${safeMethod}` : `-m0=${safeMethod}`);
  }

  if (opts.dictionarySize && SAFE_SIZE_RE.test(opts.dictionarySize)) {
    if (format === 'zip') {
      if (safeMethod && ZIP_METHODS_WITH_DICTIONARY.has(safeMethod)) {
        flags.push(`-md=${opts.dictionarySize}`);
      }
    } else {
      flags.push(`-md=${opts.dictionarySize}`);
    }
  }

  if (format === '7z') {
    if (opts.solidBlockSize === 'on' || opts.solidBlockSize === 'off') {
      flags.push(`-ms=${opts.solidBlockSize}`);
    } else if (opts.solidBlockSize && SAFE_SIZE_RE.test(opts.solidBlockSize)) {
      flags.push(`-ms=${opts.solidBlockSize}`);
    }
  }

  if (opts.cpuThreads && SAFE_THREADS_RE.test(opts.cpuThreads)) {
    flags.push(`-mmt=${opts.cpuThreads}`);
  }

  if (opts.password && opts.password.length > 0) {
    flags.push(`-p${opts.password}`);
    if (format === '7z' && opts.encryptFileNames) {
      flags.push('-mhe=on');
    }
    if (format === 'zip') {
      const safeEncryptionMethod =
        opts.encryptionMethod && SAFE_ENCRYPTION_METHODS.has(opts.encryptionMethod)
          ? opts.encryptionMethod
          : 'AES256';
      flags.push(`-mem=${safeEncryptionMethod}`);
    }
  }

  if (opts.splitVolume && SAFE_SIZE_RE.test(opts.splitVolume)) {
    flags.push(`-v${opts.splitVolume}`);
  }

  return flags;
}

// prevent path traversal in archive
async function assertArchiveEntriesSafe(archivePath: string, destPath: string): Promise<void> {
  const Seven = get7zipModule();
  const sevenZipPath = get7zipPath();

  const entries = await new Promise<
    Array<{
      name: string;
      attributes?: string;
      type?: string;
      link?: string;
      symlink?: string;
      symbolicLink?: string;
    }>
  >((resolve, reject) => {
    const list = Seven.list(archivePath, { $bin: sevenZipPath });
    const items: Array<{
      name: string;
      attributes?: string;
      type?: string;
      link?: string;
      symlink?: string;
      symbolicLink?: string;
    }> = [];

    list.on(
      'data',
      (data: { file?: string; attributes?: string; type?: string; [key: string]: unknown }) => {
        if (data && data.file) {
          const attr = data.attributes ?? (typeof data.attr === 'string' ? data.attr : undefined);
          const link = typeof data.link === 'string' ? data.link : undefined;
          const symlink = typeof data.symlink === 'string' ? data.symlink : undefined;
          const symbolicLink =
            typeof data.symbolicLink === 'string' ? data.symbolicLink : undefined;

          items.push({
            name: String(data.file),
            attributes: attr,
            type: data.type,
            link,
            symlink,
            symbolicLink,
          });
        }
      }
    );
    list.on('end', () => resolve(items));
    list.on('error', (err: Error) => reject(err));
  });

  const destRoot = path.resolve(destPath);
  const destRootWithSep = destRoot.endsWith(path.sep) ? destRoot : destRoot + path.sep;
  const invalidEntries: string[] = [];

  for (const entry of entries) {
    if (!entry || !entry.name) continue;

    // block symlinks for safety
    const attr = (entry.attributes || '').toUpperCase();
    const type = (entry.type || '').toLowerCase();
    const isLink =
      attr.includes('L') ||
      type.includes('link') ||
      Boolean(entry.link) ||
      Boolean(entry.symlink) ||
      Boolean(entry.symbolicLink);
    if (isLink) {
      invalidEntries.push(entry.name);
      continue;
    }

    const normalized = entry.name.replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!normalized) continue;
    if (
      normalized.startsWith('/') ||
      normalized.startsWith('//') ||
      /^[a-zA-Z]:/.test(normalized)
    ) {
      invalidEntries.push(entry.name);
      continue;
    }
    const parts = normalized.split('/');
    if (parts.some((part) => part === '..')) {
      invalidEntries.push(entry.name);
      continue;
    }

    const targetPath = path.resolve(destRoot, normalized);
    if (targetPath !== destRoot && !targetPath.startsWith(destRootWithSep)) {
      invalidEntries.push(entry.name);
    }
  }

  if (invalidEntries.length > 0) {
    const preview = invalidEntries.slice(0, 5).join(', ');
    throw new Error(
      `Archive contains unsafe paths: ${preview}${invalidEntries.length > 5 ? '...' : ''}`
    );
  }
}

// verify extracted paths stayed in bounds
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

    const BATCH_SIZE = 20;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (entry) => {
          const fullPath = path.join(current, entry.name);
          let stat: fsSync.Stats;
          try {
            stat = await fs.lstat(fullPath);
          } catch {
            return null;
          }

          if (stat.isSymbolicLink()) {
            unsafe.push(fullPath);
            try {
              await fs.unlink(fullPath);
            } catch (error) {
              logger.error('[Archive] Failed to remove symlink:', fullPath, error);
            }
            return null;
          }

          if (stat.isFile() && stat.nlink > 1) {
            unsafe.push(fullPath);
            try {
              await fs.rm(fullPath, { force: true });
            } catch (error) {
              logger.error('[Archive] Failed to remove hardlinked file:', fullPath, error);
            }
            return null;
          }

          let realPath: string;
          try {
            realPath = await fs.realpath(fullPath);
          } catch (error) {
            unsafe.push(fullPath);
            logger.error('[Archive] Failed to resolve realpath for:', fullPath, error);
            try {
              await fs.rm(fullPath, { recursive: true, force: true });
            } catch (rmError) {
              logger.error('[Archive] Failed to remove unsafe path:', fullPath, rmError);
            }
            return null;
          }

          if (realPath !== destRoot && !realPath.startsWith(destRootWithSep)) {
            unsafe.push(fullPath);
            try {
              await fs.rm(fullPath, { recursive: true, force: true });
            } catch (error) {
              logger.error('[Archive] Failed to remove path outside destination:', fullPath, error);
            }
            return null;
          }

          if (stat.isDirectory()) {
            return fullPath;
          }
          return null;
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          stack.push(result.value);
        }
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
              safeSend('compress-progress', {
                operationId,
                current: fileCount,
                total: fileCount + 20,
                name: progress.file || 'Creating tar...',
              });
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
                safeSend('compress-progress', {
                  operationId,
                  current: fileCount + 10,
                  total: fileCount + 20,
                  name: 'Compressing with gzip...',
                });
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
            safeSend('compress-progress', {
              operationId,
              current: fileCount,
              total: fileCount + 10,
              name: progress.file || 'Compressing...',
            });
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
            safeSend('extract-progress', {
              operationId,
              current: fileCount,
              total: fileCount + 10,
              name: progress.file || 'Extracting...',
            });
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
