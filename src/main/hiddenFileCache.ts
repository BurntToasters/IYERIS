import { execFile } from 'child_process';
import { promisify } from 'util';
import { HIDDEN_FILE_CACHE_TTL, HIDDEN_FILE_CACHE_MAX } from './appState';

const hiddenFileCache = new Map<string, { isHidden: boolean; timestamp: number }>();
let isCleaningCache = false;
let hiddenFileCacheCleanupInterval: NodeJS.Timeout | null = null;

async function isFileHidden(filePath: string, fileName: string): Promise<boolean> {
  if (fileName.startsWith('.')) {
    return true;
  }

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
