import { promises as fs } from 'fs';
import type * as fsSync from 'fs';
import * as path from 'path';
import { ignoreError } from '../shared';
import {
  type IndexEntry,
  type IndexEntryPayload,
  type IndexFileData,
  isCancelled,
  normalizePathForCompare,
  normalizeIndexTimestamp,
} from './workerUtils';

interface BuildIndexPayload {
  locations: string[];
  skipDirs: string[];
  maxIndexSize?: number;
}

interface LoadIndexPayload {
  indexPath: string;
}

interface SaveIndexPayload {
  indexPath: string;
  entries: IndexEntry[] | Array<[string, IndexEntryPayload]>;
  lastIndexTime?: unknown;
}

async function writeFileAtomic(targetPath: string, data: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(
    dir,
    `${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  await fs.writeFile(tmpPath, data, 'utf-8');

  try {
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES') {
      try {
        await fs.unlink(targetPath);
      } catch (unlinkError) {
        ignoreError(unlinkError);
      }
      try {
        await fs.rename(tmpPath, targetPath);
        return;
      } catch (retryError) {
        ignoreError(retryError);
      }
    }
    try {
      await fs.copyFile(tmpPath, targetPath);
    } catch (copyError) {
      await fs.unlink(tmpPath).catch(ignoreError);
      throw copyError;
    }
    await fs.unlink(tmpPath).catch(ignoreError);
  }
}

export async function buildIndex(
  payload: BuildIndexPayload,
  operationId?: string
): Promise<{
  indexedFiles: number;
  entries?: IndexEntry[];
}> {
  const locations: string[] = payload.locations || [];
  const maxIndexSize: number = payload.maxIndexSize || 200000;
  const skipDirs = Array.isArray(payload.skipDirs) ? payload.skipDirs : [];
  const skipDirSegments = new Set<string>();
  const skipDirPaths = new Set<string>();

  for (const skipDir of skipDirs) {
    if (typeof skipDir !== 'string') continue;
    const trimmed = skipDir.trim();
    if (!trimmed) continue;
    if (path.isAbsolute(trimmed)) {
      skipDirPaths.add(normalizePathForCompare(trimmed));
    } else {
      skipDirSegments.add(trimmed.toLowerCase());
    }
  }

  const excludeSegments = new Set([
    'node_modules',
    '.git',
    '.cache',
    'cache',
    'caches',
    '.trash',
    'trash',
    '$recycle.bin',
    'system volume information',
    '.npm',
    '.docker',
    'appdata',
    'programdata',
    'windows',
    'program files',
    'program files (x86)',
    '$windows.~bt',
    '$windows.~ws',
    'recovery',
    'perflogs',
    'library',
    '$winreagent',
    'config.msi',
    'msocache',
    'intel',
    'nvidia',
    'amd',
  ]);

  const excludeFiles = new Set([
    'pagefile.sys',
    'hiberfil.sys',
    'swapfile.sys',
    'dumpstack.log.tmp',
    'dumpstack.log',
    '.ds_store',
    'thumbs.db',
    'desktop.ini',
    'ntuser.dat',
    'ntuser.dat.log',
    'ntuser.dat.log1',
    'ntuser.dat.log2',
  ]);

  const shouldExclude = (filePath: string): boolean => {
    const parts = filePath.split(/[/\\]/);
    const filename = parts[parts.length - 1].toLowerCase();
    if (excludeFiles.has(filename)) return true;
    const normalizedPath = normalizePathForCompare(filePath);
    for (const skipPath of skipDirPaths) {
      if (normalizedPath === skipPath || normalizedPath.startsWith(skipPath + path.sep)) {
        return true;
      }
    }
    return parts.some((part) => {
      const segment = part.toLowerCase();
      return excludeSegments.has(segment) || skipDirSegments.has(segment);
    });
  };

  const entries: IndexEntry[] = [];
  const stack: string[] = [...locations];

  while (stack.length && entries.length < maxIndexSize) {
    const currentPath = stack.pop();
    if (!currentPath) continue;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');
    if (shouldExclude(currentPath)) continue;

    let dirEntries: fsSync.Dirent[];
    try {
      dirEntries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of dirEntries) {
      if (entries.length >= maxIndexSize) break;
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');
      const fullPath = path.join(currentPath, entry.name);
      if (shouldExclude(fullPath)) continue;

      try {
        const stats = await fs.stat(fullPath);
        entries.push([
          fullPath,
          {
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
            size: stats.size,
            modified: stats.mtime.getTime(),
          },
        ]);

        if (entry.isDirectory() && entries.length < maxIndexSize) {
          stack.push(fullPath);
        }
      } catch (error) {
        ignoreError(error);
      }
    }
  }

  return { indexedFiles: entries.length, entries };
}

export async function loadIndexFile(payload: LoadIndexPayload): Promise<{
  indexedFiles: number;
  indexDate: number;
  exists: boolean;
  index?: Array<unknown>;
  lastIndexTime?: number | null;
}> {
  const { indexPath } = payload;
  try {
    const data = await fs.readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(data) as IndexFileData;
    const indexEntries: unknown[] = Array.isArray(parsed.index) ? parsed.index : [];
    const normalizedLastIndexTime = normalizeIndexTimestamp(parsed.lastIndexTime);
    const sample = indexEntries.slice(0, 20);
    const isLegacy = sample.some((entry: unknown) => {
      if (Array.isArray(entry)) {
        if (entry.length < 2) return true;
        const entryPath = entry[0];
        const item = entry[1];
        if (typeof entryPath !== 'string' || !item || typeof item !== 'object') return true;
        return (
          typeof item.name !== 'string' ||
          typeof item.isFile !== 'boolean' ||
          typeof item.isDirectory !== 'boolean'
        );
      }
      if (entry && typeof entry === 'object') {
        const item = entry as { [key: string]: unknown };
        return (
          typeof item.path !== 'string' ||
          typeof item.name !== 'string' ||
          typeof item.isFile !== 'boolean' ||
          typeof item.isDirectory !== 'boolean'
        );
      }
      return true;
    });

    if (isLegacy && indexEntries.length > 0) {
      try {
        await fs.unlink(indexPath);
      } catch (error) {
        ignoreError(error);
      }
      return { exists: false, indexedFiles: 0, indexDate: 0 };
    }

    return {
      exists: true,
      indexedFiles: indexEntries.length,
      indexDate: normalizedLastIndexTime ?? Date.now(),
      index: indexEntries,
      lastIndexTime: normalizedLastIndexTime,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err && err.code === 'ENOENT') {
      return { exists: false, indexedFiles: 0, indexDate: 0 };
    }
    throw error;
  }
}

export async function saveIndexFile(payload: SaveIndexPayload): Promise<{ success: true }> {
  const { indexPath, entries, lastIndexTime } = payload;
  const normalizedLastIndexTime = normalizeIndexTimestamp(lastIndexTime);
  const data = {
    index: entries || [],
    lastIndexTime: normalizedLastIndexTime,
    version: 1,
  };
  await writeFileAtomic(indexPath, JSON.stringify(data));
  return { success: true };
}
