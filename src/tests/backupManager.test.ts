import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PlannedFileOperation } from '../main/fileOperations';

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
  cleanupBackups,
  ensureOverwriteBackup,
  restoreBackup,
  restoreOverwriteBackups,
  stashRemainingBackups,
} from '../main/backupManager';
import { pathExists, renameWithExdevFallback } from '../main/fileOperations';
import { ignoreError } from '../shared';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'iyeris-backup-manager-'));
  hoisted.appMock.getPath.mockReset();
  hoisted.appMock.getPath.mockImplementation(() => tmpRoot);
  vi.mocked(pathExists).mockReset();
  vi.mocked(renameWithExdevFallback).mockReset();
  vi.mocked(ignoreError).mockReset();
});

afterEach(async () => {
  if (tmpRoot) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = '';
  }
});

describe('backupManager', () => {
  it('cleanupBackups ignores rm failures and continues', async () => {
    const rmSpy = vi
      .spyOn(fs, 'rm')
      .mockRejectedValueOnce(new Error('rm failed'))
      .mockResolvedValue(undefined);

    await cleanupBackups(['/tmp/a', '/tmp/b']);

    expect(rmSpy).toHaveBeenCalledTimes(2);
    expect(ignoreError).toHaveBeenCalledTimes(1);
    rmSpy.mockRestore();
  });

  it('ensureOverwriteBackup creates one backup per destination', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(renameWithExdevFallback).mockResolvedValue(undefined);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123);
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const backups = new Map<string, string>();
    const operation: PlannedFileOperation = {
      sourcePath: '/tmp/source.txt',
      destPath: '/tmp/dest.txt',
      itemName: 'dest.txt',
      isDirectory: false,
      overwrite: true,
    };

    await ensureOverwriteBackup(backups, operation);
    await ensureOverwriteBackup(backups, operation);

    expect(backups.has('/tmp/dest.txt')).toBe(true);
    const backupPath = backups.get('/tmp/dest.txt');
    expect(backupPath).toContain('/tmp/.dest.txt.iyeris-backup-123-');
    expect(renameWithExdevFallback).toHaveBeenCalledTimes(1);
    expect(renameWithExdevFallback).toHaveBeenCalledWith('/tmp/dest.txt', backupPath);
    nowSpy.mockRestore();
    randomSpy.mockRestore();
  });

  it('restoreOverwriteBackups respects skipIfDestinationExists', async () => {
    const rmSpy = vi.spyOn(fs, 'rm').mockResolvedValue(undefined);
    vi.mocked(pathExists).mockImplementation(
      async (target: string) => target === '/tmp/existing.txt'
    );
    vi.mocked(renameWithExdevFallback).mockResolvedValue(undefined);
    const backups = new Map<string, string>([
      ['/tmp/existing.txt', '/tmp/backup-1'],
      ['/tmp/missing.txt', '/tmp/backup-2'],
    ]);

    await restoreOverwriteBackups(backups, true);

    expect(rmSpy).toHaveBeenCalledWith('/tmp/missing.txt', { recursive: true, force: true });
    expect(renameWithExdevFallback).toHaveBeenCalledTimes(1);
    expect(renameWithExdevFallback).toHaveBeenCalledWith('/tmp/backup-2', '/tmp/missing.txt');
    rmSpy.mockRestore();
  });

  it('stashRemainingBackups only stashes paths that still exist', async () => {
    vi.mocked(pathExists).mockImplementation(async (target: string) => {
      if (target === '/tmp/backup-a') return true;
      if (target === '/tmp/backup-missing') return false;
      if (target.endsWith('.bak')) return false;
      return false;
    });
    vi.mocked(renameWithExdevFallback).mockResolvedValue(undefined);

    const stashed = await stashRemainingBackups(
      new Map<string, string>([
        ['/tmp/dest.txt', '/tmp/backup-a'],
        ['/tmp/skip.txt', '/tmp/backup-missing'],
      ])
    );

    expect(stashed).toHaveLength(1);
    expect(stashed[0]).toContain(path.join(tmpRoot, 'overwrite-backups', 'dest.'));
    expect(stashed[0]).toMatch(/\.bak$/);
    expect(renameWithExdevFallback).toHaveBeenCalledTimes(1);
    expect(renameWithExdevFallback).toHaveBeenCalledWith('/tmp/backup-a', stashed[0]);
  });

  it('restoreBackup continues even if destination removal fails', async () => {
    const rmSpy = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('rm failed'));
    vi.mocked(renameWithExdevFallback).mockResolvedValue(undefined);

    await restoreBackup('/tmp/backup-final', '/tmp/dest-final');

    expect(ignoreError).toHaveBeenCalledTimes(1);
    expect(renameWithExdevFallback).toHaveBeenCalledWith('/tmp/backup-final', '/tmp/dest-final');
    rmSpy.mockRestore();
  });
});
