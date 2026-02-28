import * as path from 'path';
import { promises as fs } from 'fs';
import * as crypto from 'crypto';
import { app } from 'electron';
import { ignoreError } from '../shared';
import { pathExists, renameWithExdevFallback } from './fileOperationUtils';
import type { PlannedFileOperation } from './fileOperationUtils';

const OVERWRITE_BACKUP_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const OVERWRITE_BACKUP_MAX_FILES = 200;

export async function cleanupBackups(backupPaths: Iterable<string>): Promise<void> {
  for (const backupPath of backupPaths) {
    try {
      await fs.rm(backupPath, { recursive: true, force: true });
    } catch (error) {
      ignoreError(error);
    }
  }
}

export async function restoreOverwriteBackups(
  backups: Map<string, string>,
  skipIfDestinationExists = false
): Promise<void> {
  for (const [destPath, backupPath] of backups) {
    if (skipIfDestinationExists && (await pathExists(destPath))) {
      continue;
    }
    try {
      await restoreBackup(backupPath, destPath);
    } catch (error) {
      ignoreError(error);
    }
  }
}

export async function ensureOverwriteBackup(
  backups: Map<string, string>,
  operation: PlannedFileOperation
): Promise<void> {
  if (!operation.overwrite || backups.has(operation.destPath)) {
    return;
  }
  const backupPath = await backupExistingPath(operation.destPath);
  backups.set(operation.destPath, backupPath);
}

async function createBackupPath(destPath: string): Promise<string> {
  const dir = path.dirname(destPath);
  const base = path.basename(destPath);
  for (let attempt = 0; attempt < 10; attempt++) {
    const suffix = `.iyeris-backup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const candidate = path.join(dir, `.${base}${suffix}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error('Unable to create backup path');
}

async function getBackupRoot(): Promise<string> {
  const root = path.join(app.getPath('userData'), 'overwrite-backups');
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function cleanupStashedBackups(root: string): Promise<void> {
  const now = Date.now();
  const entries = await fs.readdir(root, { withFileTypes: true });
  const retained: Array<{ path: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.bak')) {
      continue;
    }

    const backupPath = path.join(root, entry.name);
    try {
      const stats = await fs.stat(backupPath);
      if (now - stats.mtimeMs > OVERWRITE_BACKUP_RETENTION_MS) {
        await fs.rm(backupPath, { force: true });
      } else {
        retained.push({ path: backupPath, mtimeMs: stats.mtimeMs });
      }
    } catch (error) {
      ignoreError(error);
    }
  }

  if (retained.length <= OVERWRITE_BACKUP_MAX_FILES) {
    return;
  }

  retained.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const toRemove = retained.length - OVERWRITE_BACKUP_MAX_FILES;
  for (let i = 0; i < toRemove; i++) {
    try {
      await fs.rm(retained[i].path, { force: true });
    } catch (error) {
      ignoreError(error);
    }
  }
}

export async function cleanupStashedBackupsForTests(root: string): Promise<void> {
  await cleanupStashedBackups(root);
}

async function stashBackup(backupPath: string, destPath: string): Promise<string> {
  const root = await getBackupRoot();
  const base = path.basename(destPath);
  const hash = crypto.createHash('sha256').update(destPath).digest('hex').slice(0, 8);
  const ext = path.extname(base);
  const baseName = ext ? base.slice(0, -ext.length) : base;

  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const candidate = path.join(root, `${baseName}.${hash}-${timestamp}-${rand}${ext || ''}.bak`);
  await renameWithExdevFallback(backupPath, candidate);
  return candidate;
}

export async function stashRemainingBackups(backups: Map<string, string>): Promise<string[]> {
  const stashed: string[] = [];
  for (const [destPath, backupPath] of backups) {
    if (!(await pathExists(backupPath))) continue;
    try {
      const newPath = await stashBackup(backupPath, destPath);
      stashed.push(newPath);
    } catch (error) {
      ignoreError(error);
    }
  }
  if (stashed.length > 0) {
    try {
      const root = await getBackupRoot();
      await cleanupStashedBackups(root);
    } catch (error) {
      ignoreError(error);
    }
  }
  return stashed;
}

async function backupExistingPath(destPath: string): Promise<string> {
  const backupPath = await createBackupPath(destPath);
  await renameWithExdevFallback(destPath, backupPath);
  return backupPath;
}

export async function restoreBackup(backupPath: string, destPath: string): Promise<void> {
  try {
    await fs.rm(destPath, { recursive: true, force: true });
  } catch (error) {
    ignoreError(error);
  }

  await renameWithExdevFallback(backupPath, destPath);
}
