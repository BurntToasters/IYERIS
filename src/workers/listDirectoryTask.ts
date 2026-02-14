import { promises as fs } from 'fs';
import * as path from 'path';
import { ignoreError } from '../shared';
import { type SearchResult, isCancelled, sendProgress, batchCheckHidden } from './workerUtils';

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
      : new Map<string, boolean>();
    let items = await Promise.all(
      batch.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        const isHiddenFlag = shouldCheckHidden
          ? (hiddenMap.get(entry.name) ?? entry.name.startsWith('.'))
          : entry.name.startsWith('.');
        try {
          const stats = await fs.stat(fullPath);
          return {
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
            size: stats.size,
            modified: stats.mtime,
            isHidden: isHiddenFlag,
          };
        } catch {
          return {
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
            size: 0,
            modified: new Date(),
            isHidden: isHiddenFlag,
          };
        }
      })
    );

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
