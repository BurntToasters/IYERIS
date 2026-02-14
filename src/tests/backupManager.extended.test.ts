import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const hoisted = vi.hoisted(() => ({
  appMock: {
    getPath: vi.fn(),
  },
  pathExistsMock: vi.fn(),
  renameWithExdevFallbackMock: vi.fn(),
  ignoreErrorMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: hoisted.appMock,
}));

vi.mock('../main/fileOperations', () => ({
  pathExists: hoisted.pathExistsMock,
  renameWithExdevFallback: hoisted.renameWithExdevFallbackMock,
}));

vi.mock('../shared', () => ({
  ignoreError: hoisted.ignoreErrorMock,
}));

import {
  cleanupStashedBackupsForTests,
  cleanupBackups,
  ensureOverwriteBackup,
} from '../main/backupManager';
import { pathExists, renameWithExdevFallback } from '../main/fileOperations';
import type { PlannedFileOperation } from '../main/fileOperations';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'iyeris-backup-ext-'));
  hoisted.appMock.getPath.mockReset();
  hoisted.appMock.getPath.mockImplementation(() => tmpRoot);
  vi.mocked(pathExists).mockReset();
  vi.mocked(renameWithExdevFallback).mockReset();
  hoisted.ignoreErrorMock.mockReset();
});

afterEach(async () => {
  if (tmpRoot) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = '';
  }
});

describe('cleanupStashedBackupsForTests - retention logic', () => {
  it('removes files older than 14 days', async () => {
    const root = path.join(tmpRoot, 'cleanup-test');
    await fs.mkdir(root, { recursive: true });

    const oldFile = path.join(root, 'old.bak');
    await fs.writeFile(oldFile, 'old');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldFile, thirtyDaysAgo, thirtyDaysAgo);

    const recentFile = path.join(root, 'recent.bak');
    await fs.writeFile(recentFile, 'recent');

    await cleanupStashedBackupsForTests(root);

    const remaining = await fs.readdir(root);
    expect(remaining).toEqual(['recent.bak']);
  });

  it('caps to 200 files by removing oldest first', async () => {
    const root = path.join(tmpRoot, 'cap-test');
    await fs.mkdir(root, { recursive: true });

    for (let i = 0; i < 205; i++) {
      const filePath = path.join(root, `file-${String(i).padStart(3, '0')}.bak`);
      await fs.writeFile(filePath, `data-${i}`);

      const time = new Date(Date.now() - (205 - i) * 1000);
      await fs.utimes(filePath, time, time);
    }

    await cleanupStashedBackupsForTests(root);

    const remaining = await fs.readdir(root);
    expect(remaining.length).toBe(200);

    expect(remaining).not.toContain('file-000.bak');
    expect(remaining).not.toContain('file-004.bak');
    expect(remaining).toContain('file-005.bak');
  });

  it('ignores non-.bak files', async () => {
    const root = path.join(tmpRoot, 'ignore-test');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'readme.txt'), 'hello');
    await fs.writeFile(path.join(root, 'data.bak'), 'bak');

    await cleanupStashedBackupsForTests(root);

    const remaining = await fs.readdir(root);
    expect(remaining).toContain('readme.txt');
    expect(remaining).toContain('data.bak');
  });

  it('ignores directories', async () => {
    const root = path.join(tmpRoot, 'dir-test');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(root, 'subdir'));
    await fs.writeFile(path.join(root, 'data.bak'), 'bak');

    await cleanupStashedBackupsForTests(root);

    const remaining = await fs.readdir(root);
    expect(remaining).toContain('subdir');
    expect(remaining).toContain('data.bak');
  });

  it('handles empty directory', async () => {
    const root = path.join(tmpRoot, 'empty-test');
    await fs.mkdir(root, { recursive: true });

    await expect(cleanupStashedBackupsForTests(root)).resolves.toBeUndefined();
  });
});

describe('cleanupBackups edge cases', () => {
  it('handles empty iterable', async () => {
    await expect(cleanupBackups([])).resolves.toBeUndefined();
  });

  it('cleans up multiple paths', async () => {
    const rmSpy = vi.spyOn(fs, 'rm').mockResolvedValue(undefined);
    await cleanupBackups(['/a', '/b', '/c']);
    expect(rmSpy).toHaveBeenCalledTimes(3);
    rmSpy.mockRestore();
  });
});

describe('ensureOverwriteBackup edge cases', () => {
  it('skips when overwrite is false', async () => {
    const backups = new Map<string, string>();
    const op: PlannedFileOperation = {
      sourcePath: '/src',
      destPath: '/dst',
      itemName: 'dst',
      isDirectory: false,
      overwrite: false,
    };
    await ensureOverwriteBackup(backups, op);
    expect(backups.size).toBe(0);
    expect(renameWithExdevFallback).not.toHaveBeenCalled();
  });
});
