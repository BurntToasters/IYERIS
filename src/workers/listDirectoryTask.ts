import { promises as fs } from 'fs';
import * as path from 'path';
import { ignoreError } from '../shared';
import { type SearchResult, isCancelled, sendProgress, batchCheckHidden } from './workerUtils';

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';

interface ListDirectoryPayload {
  dirPath: string;
  batchSize?: number;
  streamOnly?: boolean;
  includeHidden?: boolean;
}

export async function listDirectory(
  payload: ListDirectoryPayload,
  operationId?: string
): Promise<{ contents: SearchResult[] }> {
  const { dirPath, batchSize = 500, streamOnly = false, includeHidden = false } = payload;
  const results: SearchResult[] = [];
  const batch: import('fs').Dirent[] = [];
  let loaded = 0;
  let dir: import('fs').Dir | null = null;
  const shouldCheckHidden = process.platform === 'win32';

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');

    const names = batch.map((entry) => entry.name);
    const hiddenMap = shouldCheckHidden
      ? await batchCheckHidden(dirPath, names)
      : new Map<string, { isHidden: boolean; isSystemProtected: boolean }>();
    let items = await Promise.all(
      batch.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        const attrFlags = hiddenMap.get(entry.name);
        const isHiddenFlag = shouldCheckHidden
          ? (attrFlags?.isHidden ?? entry.name.startsWith('.'))
          : entry.name.startsWith('.');
        const isSystemProtectedFlag = attrFlags?.isSystemProtected ?? false;
        const isDir = entry.isDirectory();
        const isBundle = isMac && isDir && entry.name.endsWith('.app');
        const isLink = entry.isSymbolicLink();
        let linkTarget: string | undefined;
        let isBrokenSymlink = false;
        if (isLink) {
          try {
            const rawTarget = await fs.readlink(fullPath);
            linkTarget = isWin ? rawTarget.replace(/\//g, '\\') : rawTarget;
          } catch {
            isBrokenSymlink = true;
          }
        }
        try {
          const stats = await fs.stat(fullPath);
          return {
            name: entry.name,
            path: fullPath,
            isDirectory: isDir,
            isFile: entry.isFile(),
            isSymlink: isLink || undefined,
            isBrokenSymlink: isBrokenSymlink || undefined,
            isAppBundle: isBundle || undefined,
            isShortcut: (isWin && entry.name.endsWith('.lnk')) || undefined,
            isDesktopEntry: (isLinux && entry.name.endsWith('.desktop')) || undefined,
            symlinkTarget: linkTarget,
            size: stats.size,
            modified: stats.mtime,
            isHidden: isHiddenFlag,
            isSystemProtected: isSystemProtectedFlag || undefined,
          };
        } catch {
          return {
            name: entry.name,
            path: fullPath,
            isDirectory: isDir,
            isFile: entry.isFile(),
            isSymlink: isLink || undefined,
            isBrokenSymlink: (isLink && true) || undefined,
            isAppBundle: isBundle || undefined,
            isShortcut: (isWin && entry.name.endsWith('.lnk')) || undefined,
            isDesktopEntry: (isLinux && entry.name.endsWith('.desktop')) || undefined,
            symlinkTarget: linkTarget,
            size: 0,
            modified: new Date(),
            isHidden: isHiddenFlag,
            isSystemProtected: isSystemProtectedFlag || undefined,
          };
        }
      })
    );

    items = items.filter((item) => !item.isSystemProtected);
    if (!includeHidden) {
      items = items.filter((item) => !item.isHidden);
    }

    if (!streamOnly) {
      results.push(...items);
    }
    loaded += items.length;
    if (operationId) {
      sendProgress('list-directory', operationId, { dirPath, loaded, items });
    }
    batch.length = 0;
  };

  try {
    dir = await fs.opendir(dirPath);
    for await (const entry of dir) {
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');
      batch.push(entry);
      if (batch.length >= batchSize) {
        await flushBatch();
      }
    }
    await flushBatch();
  } finally {
    try {
      await dir?.close();
    } catch (error) {
      ignoreError(error);
    }
  }

  return { contents: streamOnly ? [] : results };
}
