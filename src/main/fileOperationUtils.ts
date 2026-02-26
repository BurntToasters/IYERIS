import * as path from 'path';
import { promises as fs } from 'fs';
import type * as fsSync from 'fs';
import * as os from 'os';
import { ignoreError } from '../shared';

export interface PlannedFileOperation {
  sourcePath: string;
  destPath: string;
  itemName: string;
  isDirectory: boolean;
  overwrite?: boolean;
}

type FileOperationType = 'copy' | 'move';
export type ConflictBehavior = 'ask' | 'rename' | 'skip' | 'overwrite' | 'cancel';

const INVALID_CHILD_NAMES = new Set(['', '.', '..']);

function normalizeCaseKey(targetPath: string): string {
  if (process.platform === 'win32') {
    return targetPath.toLowerCase();
  }
  return targetPath;
}

function normalizePathForComparison(targetPath: string): string {
  return normalizeCaseKey(path.resolve(targetPath));
}

export function getParallelBatchSize(): number {
  const totalMemGb = os.totalmem() / 1024 ** 3;
  if (totalMemGb < 6) return 4;
  if (totalMemGb < 12) return 8;
  if (totalMemGb < 24) return 12;
  return 16;
}

export function pathExists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false
  );
}

export function isValidChildName(name: string): boolean {
  return !INVALID_CHILD_NAMES.has(name) && !name.includes('/') && !name.includes('\\');
}

function splitFileName(fileName: string): { base: string; ext: string } {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot <= 0) {
    return { base: fileName, ext: '' };
  }
  return { base: fileName.slice(0, lastDot), ext: fileName.slice(lastDot) };
}

async function generateUniqueName(destPath: string, fileName: string): Promise<string> {
  const { base, ext } = splitFileName(fileName);
  let counter = 2;
  let candidatePath = path.join(destPath, fileName);
  while (await pathExists(candidatePath)) {
    const candidateName = `${base} (${counter})${ext}`;
    candidatePath = path.join(destPath, candidateName);
    counter++;
    if (counter > 9999) throw new Error('Unable to generate unique name');
  }
  return candidatePath;
}

export async function validateFileOperation(
  sourcePaths: string[],
  destPath: string,
  operationType: FileOperationType,
  conflictBehavior: ConflictBehavior = 'ask',
  resolveConflict:
    | ((fileName: string) => Promise<'rename' | 'skip' | 'overwrite' | 'cancel'>)
    | undefined,
  isPathSafe: (p: string) => boolean,
  logger?: { warn: (...args: unknown[]) => void }
): Promise<{ success: true; planned: PlannedFileOperation[] } | { success: false; error: string }> {
  if (!isPathSafe(destPath)) {
    logger?.warn(`[Security] Invalid destination path rejected:`, destPath);
    return { success: false, error: 'Invalid destination path' };
  }

  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    return { success: false, error: 'No source items provided' };
  }

  const normalizedDestPath = normalizePathForComparison(destPath);
  let normalizedDestRealPath = normalizedDestPath;
  try {
    normalizedDestRealPath = normalizePathForComparison(await fs.realpath(destPath));
  } catch (error) {
    ignoreError(error);
  }
  const planned: PlannedFileOperation[] = [];
  const destKeys = new Set<string>();

  for (const sourcePath of sourcePaths) {
    if (!isPathSafe(sourcePath)) {
      logger?.warn(`[Security] Invalid source path rejected:`, sourcePath);
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
      return { success: false, error: `Source file not found: ${itemName}` };
    }

    if (stats.isDirectory()) {
      let normalizedSourcePath = normalizePathForComparison(sourcePath);
      try {
        normalizedSourcePath = normalizePathForComparison(await fs.realpath(sourcePath));
      } catch (error) {
        ignoreError(error);
      }
      const sourcePrefix = normalizedSourcePath.endsWith(path.sep)
        ? normalizedSourcePath
        : normalizedSourcePath + path.sep;
      if (
        normalizedDestRealPath === normalizedSourcePath ||
        normalizedDestRealPath.startsWith(sourcePrefix)
      ) {
        return {
          success: false,
          error: `Cannot ${operationType} "${itemName}" into itself or a subfolder`,
        };
      }
    }

    const destExists = await pathExists(itemDestPath);
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

export async function copyPathByType(
  sourcePath: string,
  destPath: string,
  isDirectory: boolean
): Promise<void> {
  if (isDirectory) {
    await fs.cp(sourcePath, destPath, { recursive: true });
  } else {
    await fs.copyFile(sourcePath, destPath);
  }
}

export async function renameWithExdevFallback(
  sourcePath: string,
  destPath: string,
  isDirectory?: boolean
): Promise<void> {
  try {
    await fs.rename(sourcePath, destPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EXDEV') {
      throw error;
    }
    const stats = typeof isDirectory === 'boolean' ? null : await fs.stat(sourcePath);
    await copyPathByType(sourcePath, destPath, isDirectory ?? stats?.isDirectory() ?? false);
    await fs.rm(sourcePath, { recursive: true, force: true });
  }
}

export async function removePaths(paths: string[]): Promise<void> {
  for (const targetPath of paths) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
    } catch (error) {
      ignoreError(error);
    }
  }
}

export async function createUniqueFile(
  parentPath: string,
  fileName: string
): Promise<{ name: string; path: string }> {
  const { base, ext } = splitFileName(fileName);
  const MAX_ATTEMPTS = 9999;
  let counter = 1;

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
