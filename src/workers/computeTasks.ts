import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { isCancelled, sendProgress } from './workerUtils';

interface FolderSizePayload {
  folderPath: string;
}

interface ChecksumPayload {
  filePath: string;
  algorithms: string[];
}

function accumulateFolderSizeBatch(
  statResults: PromiseSettledResult<fsSync.Stats>[],
  fileBatch: Array<{ name: string }>,
  fileTypeMap: Map<string, { count: number; size: number }>
): { totalSize: number; fileCount: number } {
  let totalSize = 0;
  let fileCount = 0;
  for (let i = 0; i < statResults.length; i++) {
    const result = statResults[i];
    if (result.status !== 'fulfilled') {
      continue;
    }
    const size = result.value.size;
    totalSize += size;
    fileCount++;
    const ext = path.extname(fileBatch[i].name).toLowerCase() || '(no extension)';
    const existing = fileTypeMap.get(ext) || { count: 0, size: 0 };
    fileTypeMap.set(ext, {
      count: existing.count + 1,
      size: existing.size + size,
    });
  }
  return { totalSize, fileCount };
}

export async function calculateFolderSize(
  payload: FolderSizePayload,
  operationId?: string
): Promise<{
  size: number;
  files: number;
  dirs: number;
  totalSize: number;
  fileCount: number;
  folderCount: number;
  fileTypes: { extension: string; count: number; size: number }[];
}> {
  const { folderPath } = payload;
  let totalSize = 0;
  let fileCount = 0;
  let folderCount = 0;
  let lastProgressUpdate = Date.now();
  const fileTypeMap = new Map<string, { count: number; size: number }>();

  const STAT_BATCH_SIZE = 50;
  const stack: string[] = [folderPath];

  while (stack.length) {
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');
    const currentPath = stack.pop();
    if (!currentPath) continue;

    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    const fileBatch: Array<{ fullPath: string; name: string }> = [];

    for (const entry of entries) {
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        folderCount++;
        stack.push(fullPath);
      } else if (entry.isFile()) {
        fileBatch.push({ fullPath, name: entry.name });

        if (fileBatch.length >= STAT_BATCH_SIZE) {
          const statResults = await Promise.allSettled(
            fileBatch.map(({ fullPath }) => fs.stat(fullPath))
          );
          const delta = accumulateFolderSizeBatch(statResults, fileBatch, fileTypeMap);
          totalSize += delta.totalSize;
          fileCount += delta.fileCount;

          fileBatch.length = 0;
        }
      }

      const now = Date.now();
      if (operationId && now - lastProgressUpdate > 100) {
        lastProgressUpdate = now;
        sendProgress('folder-size', operationId, {
          calculatedSize: totalSize,
          fileCount,
          folderCount,
          currentPath,
        });
      }
    }

    if (fileBatch.length > 0) {
      const statResults = await Promise.allSettled(
        fileBatch.map(({ fullPath }) => fs.stat(fullPath))
      );
      const delta = accumulateFolderSizeBatch(statResults, fileBatch, fileTypeMap);
      totalSize += delta.totalSize;
      fileCount += delta.fileCount;
    }
  }

  const fileTypes = Array.from(fileTypeMap.entries())
    .map(([extension, data]) => ({ extension, count: data.count, size: data.size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 10);

  return {
    size: totalSize,
    files: fileCount,
    dirs: folderCount,
    totalSize,
    fileCount,
    folderCount,
    fileTypes,
  };
}

export async function calculateChecksum(
  payload: ChecksumPayload,
  operationId?: string
): Promise<Record<string, string>> {
  const { filePath, algorithms } = payload;
  const stats = await fs.stat(filePath);
  const fileSize = stats.size;

  const ALLOWED_ALGORITHMS = new Set(['md5', 'sha256']);
  const rawAlgorithms = Array.isArray(algorithms) ? algorithms : [];
  const uniqueAlgorithms = Array.from(
    new Set(
      rawAlgorithms
        .map((algo) => String(algo).toLowerCase())
        .filter((a) => ALLOWED_ALGORITHMS.has(a))
    )
  );

  if (uniqueAlgorithms.length === 0) {
    throw new Error('No valid algorithms specified');
  }

  const hashes = new Map<string, ReturnType<typeof createHash>>();
  for (const algorithm of uniqueAlgorithms) {
    hashes.set(algorithm, createHash(algorithm));
  }

  let bytesRead = 0;
  let lastProgressUpdate = Date.now();

  await new Promise<void>((resolve, reject) => {
    const stream = fsSync.createReadStream(filePath);

    stream.on('data', (chunk: Buffer) => {
      if (isCancelled(operationId)) {
        stream.destroy();
        reject(new Error('Calculation cancelled'));
        return;
      }
      for (const hash of hashes.values()) {
        hash.update(chunk);
      }
      bytesRead += chunk.length;
      const now = Date.now();
      if (operationId && now - lastProgressUpdate > 100) {
        lastProgressUpdate = now;
        const percent = fileSize > 0 ? (bytesRead / fileSize) * 100 : 0;
        const label =
          uniqueAlgorithms.length > 1 ? uniqueAlgorithms.join('+') : uniqueAlgorithms[0] || '';
        sendProgress('checksum', operationId, { percent, algorithm: label });
      }
    });

    stream.on('end', () => resolve());
    stream.on('error', reject);
  });

  const result: { md5?: string; sha256?: string } = {};
  for (const [algorithm, hash] of hashes) {
    const digest = hash.digest('hex');
    if (algorithm === 'md5') result.md5 = digest;
    if (algorithm === 'sha256') result.sha256 = digest;
  }
  return result;
}
