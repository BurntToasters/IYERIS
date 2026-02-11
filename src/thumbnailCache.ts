import { ipcMain, app, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import { isPathSafe, getErrorMessage } from './security';
import { ignoreError } from './shared';
import { isTrustedIpcEvent } from './ipcUtils';

const CACHE_DIR_NAME = 'thumbnail-cache';
const CACHE_VERSION = 1;
const MAX_CACHE_SIZE_MB = 500;
const MAX_CACHE_AGE_DAYS = 30;
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

let cacheDir: string | null = null;
let cacheInitialized = false;
let cleanupInterval: NodeJS.Timeout | null = null;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let enforceSizeTimer: ReturnType<typeof setTimeout> | null = null;
const ENFORCE_SIZE_DEBOUNCE_MS = 30_000;

function debouncedEnforceCacheSize(): void {
  if (enforceSizeTimer) clearTimeout(enforceSizeTimer);
  enforceSizeTimer = setTimeout(() => {
    enforceSizeTimer = null;
    enforceCacheSize().catch((err) =>
      console.error('[ThumbnailCache] enforceCacheSize error:', err)
    );
  }, ENFORCE_SIZE_DEBOUNCE_MS);
}

async function ensureCacheDir(): Promise<string> {
  if (cacheDir && cacheInitialized) return cacheDir;

  cacheDir = path.join(app.getPath('userData'), CACHE_DIR_NAME);

  try {
    await fs.mkdir(cacheDir, { recursive: true });
    cacheInitialized = true;
  } catch (error) {
    console.error('[ThumbnailCache] Failed to create cache directory:', error);
    throw error;
  }

  return cacheDir;
}

async function enforceCacheSize(): Promise<void> {
  const dir = await ensureCacheDir();
  const limitBytes = MAX_CACHE_SIZE_MB * 1024 * 1024;
  let totalSize = 0;
  const entries: Array<{ path: string; size: number; atimeMs: number }> = [];

  async function walk(dirPath: string): Promise<void> {
    let list: fsSync.Dirent[];
    try {
      list = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of list) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      try {
        const stats = await fs.stat(fullPath);
        totalSize += stats.size;
        entries.push({ path: fullPath, size: stats.size, atimeMs: stats.atimeMs });
      } catch (error) {
        ignoreError(error);
      }
    }
  }

  await walk(dir);

  if (totalSize <= limitBytes) return;

  entries.sort((a, b) => a.atimeMs - b.atimeMs);
  for (const entry of entries) {
    if (totalSize <= limitBytes) break;
    try {
      await fs.unlink(entry.path);
      totalSize -= entry.size;
    } catch (error) {
      ignoreError(error);
    }
  }
}

function generateCacheKey(filePath: string, mtime: number): string {
  const hash = crypto.createHash('md5');
  hash.update(`v${CACHE_VERSION}:${filePath}:${mtime}`);
  return hash.digest('hex');
}

async function getCachePath(filePath: string, mtime: number): Promise<string> {
  const dir = await ensureCacheDir();
  const key = generateCacheKey(filePath, mtime);
  const subDir = key.substring(0, 2);
  const cacheSubDir = path.join(dir, subDir);

  try {
    await fs.mkdir(cacheSubDir, { recursive: true });
  } catch (error) {
    ignoreError(error);
  }

  return path.join(cacheSubDir, `${key}.jpg`);
}

export async function getThumbnailFromCache(
  filePath: string
): Promise<{ success: boolean; dataUrl?: string; error?: string }> {
  try {
    if (!isPathSafe(filePath)) {
      return { success: false, error: 'Invalid path' };
    }

    const stats = await fs.stat(filePath);
    const mtime = stats.mtimeMs;
    const cachePath = await getCachePath(filePath, mtime);

    try {
      const data = await fs.readFile(cachePath);
      const dataUrl = `data:image/jpeg;base64,${data.toString('base64')}`;
      return { success: true, dataUrl };
    } catch {
      return { success: false, error: 'Not in cache' };
    }
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function saveThumbnailToCache(
  filePath: string,
  dataUrl: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isPathSafe(filePath)) {
      return { success: false, error: 'Invalid path' };
    }

    const stats = await fs.stat(filePath);
    const mtime = stats.mtimeMs;
    const cachePath = await getCachePath(filePath, mtime);

    const base64Match = dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
    if (!base64Match) {
      return { success: false, error: 'Invalid data URL format' };
    }

    const base64Payload = base64Match[1];
    const estimatedBytes = Math.floor((base64Payload.length * 3) / 4);
    if (estimatedBytes > MAX_THUMBNAIL_BYTES) {
      return { success: false, error: 'Thumbnail too large' };
    }

    const buffer = Buffer.from(base64Payload, 'base64');
    if (buffer.length > MAX_THUMBNAIL_BYTES) {
      return { success: false, error: 'Thumbnail too large' };
    }
    await fs.writeFile(cachePath, buffer);

    debouncedEnforceCacheSize();

    return { success: true };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function clearThumbnailCache(): Promise<{ success: boolean; error?: string }> {
  try {
    const dir = await ensureCacheDir();
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDirPath = path.join(dir, entry.name);
        await fs.rm(subDirPath, { recursive: true, force: true });
      }
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function getThumbnailCacheSize(): Promise<{
  success: boolean;
  sizeBytes?: number;
  fileCount?: number;
  error?: string;
}> {
  try {
    const dir = await ensureCacheDir();
    let totalSize = 0;
    let fileCount = 0;

    async function walkDir(dirPath: string): Promise<void> {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else {
          const stats = await fs.stat(fullPath);
          totalSize += stats.size;
          fileCount++;
        }
      }
    }

    await walkDir(dir);

    return { success: true, sizeBytes: totalSize, fileCount };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function cleanupOldThumbnails(): Promise<void> {
  try {
    const dir = await ensureCacheDir();
    const now = Date.now();
    const maxAge = MAX_CACHE_AGE_DAYS * 24 * 60 * 60 * 1000;

    async function cleanDir(dirPath: string): Promise<void> {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await cleanDir(fullPath);
          try {
            const remaining = await fs.readdir(fullPath);
            if (remaining.length === 0) {
              await fs.rmdir(fullPath);
            }
          } catch (error) {
            ignoreError(error);
          }
        } else {
          try {
            const stats = await fs.stat(fullPath);
            if (now - stats.atimeMs > maxAge) {
              await fs.unlink(fullPath);
            }
          } catch (error) {
            ignoreError(error);
          }
        }
      }
    }

    await cleanDir(dir);
    await enforceCacheSize();
  } catch (error) {
    console.error('[ThumbnailCache] Cleanup error:', error);
  }
}

export function setupThumbnailCacheHandlers(): void {
  ipcMain.handle('get-cached-thumbnail', async (event: IpcMainInvokeEvent, filePath: string) => {
    if (!isTrustedIpcEvent(event, 'get-cached-thumbnail')) {
      return { success: false, error: 'Untrusted IPC sender' };
    }
    return getThumbnailFromCache(filePath);
  });

  ipcMain.handle(
    'save-cached-thumbnail',
    async (event: IpcMainInvokeEvent, filePath: string, dataUrl: string) => {
      if (!isTrustedIpcEvent(event, 'save-cached-thumbnail')) {
        return { success: false, error: 'Untrusted IPC sender' };
      }
      return saveThumbnailToCache(filePath, dataUrl);
    }
  );

  ipcMain.handle('clear-thumbnail-cache', async (event: IpcMainInvokeEvent) => {
    if (!isTrustedIpcEvent(event, 'clear-thumbnail-cache')) {
      return { success: false, error: 'Untrusted IPC sender' };
    }
    return clearThumbnailCache();
  });

  ipcMain.handle('get-thumbnail-cache-size', async (event: IpcMainInvokeEvent) => {
    if (!isTrustedIpcEvent(event, 'get-thumbnail-cache-size')) {
      return { success: false, error: 'Untrusted IPC sender' };
    }
    return getThumbnailCacheSize();
  });

  setTimeout(() => {
    cleanupOldThumbnails();
  }, 30000);

  cleanupInterval = setInterval(() => {
    cleanupOldThumbnails();
  }, CLEANUP_INTERVAL_MS);
}

export function stopThumbnailCacheCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (enforceSizeTimer) {
    clearTimeout(enforceSizeTimer);
    enforceSizeTimer = null;
  }
}
