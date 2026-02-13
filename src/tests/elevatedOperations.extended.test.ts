import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  app: {
    getPath: () => '/tmp',
    on: vi.fn(),
  },
}));

vi.mock('../main/appState', () => ({
  getMainWindow: vi.fn(() => null),
}));

vi.mock('../main/security', () => ({
  isPathSafe: (p: string) => !p.includes('\0') && !p.includes('..'),
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

vi.mock('../shared', () => ({
  ignoreError: () => {},
}));

vi.mock('../main/settingsManager', () => ({
  loadSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock('../main/ipcUtils', () => ({
  isTrustedIpcEvent: () => true,
}));

import { isPermissionError, executeElevated, tryWithElevation } from '../main/elevatedOperations';

describe('executeElevated validation', () => {
  it('rejects copy with missing sourcePath', async () => {
    const result = await executeElevated({ type: 'copy', destPath: '/dst' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('source');
  });

  it('rejects copy with missing destPath', async () => {
    const result = await executeElevated({ type: 'copy', sourcePath: '/src' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('destination');
  });

  it('rejects move with missing sourcePath', async () => {
    const result = await executeElevated({ type: 'move', destPath: '/dst' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('source');
  });

  it('rejects move with missing destPath', async () => {
    const result = await executeElevated({ type: 'move', sourcePath: '/src' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('destination');
  });

  it('rejects delete with missing sourcePath', async () => {
    const result = await executeElevated({ type: 'delete' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('source');
  });

  it('rejects rename with missing sourcePath', async () => {
    const result = await executeElevated({ type: 'rename', newName: 'new.txt' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('source');
  });

  it('rejects rename with missing newName', async () => {
    const result = await executeElevated({
      type: 'rename',
      sourcePath: '/src/old.txt',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('new name');
  });

  it('rejects createFolder with missing destPath', async () => {
    const result = await executeElevated({ type: 'createFolder' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('destination');
  });

  it('rejects createFile with missing destPath', async () => {
    const result = await executeElevated({ type: 'createFile' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('destination');
  });
});

describe('isPermissionError extended', () => {
  it('returns false for ENOTEMPTY', () => {
    const err = new Error('not empty') as NodeJS.ErrnoException;
    err.code = 'ENOTEMPTY';
    expect(isPermissionError(err)).toBe(false);
  });

  it('returns false for object without code', () => {
    expect(isPermissionError({})).toBe(false);
  });

  it('returns false for number', () => {
    expect(isPermissionError(42)).toBe(false);
  });
});

describe('tryWithElevation extended', () => {
  it('returns result when operation succeeds without elevation', async () => {
    const result = await tryWithElevation(
      async () => 'done',
      { type: 'copy', sourcePath: '/src', destPath: '/dst' },
      'copy'
    );
    expect(result.result).toBe('done');
    expect(result.elevated).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('rejects invalid source path with null byte', async () => {
    const result = await tryWithElevation(
      async () => 'done',
      { type: 'copy', sourcePath: '/src\0bad', destPath: '/dst' },
      'copy'
    );
    expect(result.elevated).toBe(false);
    expect(result.error).toBe('Invalid source path');
  });

  it('rejects invalid destination path with traversal', async () => {
    const result = await tryWithElevation(
      async () => 'done',
      { type: 'copy', sourcePath: '/src', destPath: '/dst/../../../etc' },
      'copy'
    );
    expect(result.elevated).toBe(false);
    expect(result.error).toBe('Invalid destination path');
  });

  it('rejects empty newName (validated later by executeElevated, but passed by tryWithElevation)', async () => {
    const result = await tryWithElevation(
      async () => 'done',
      { type: 'rename', sourcePath: '/src', newName: '' },
      'rename'
    );

    expect(result.result).toBe('done');
    expect(result.elevated).toBe(false);
  });

  it('rejects newName with dot only', async () => {
    const result = await tryWithElevation(
      async () => 'done',
      { type: 'rename', sourcePath: '/src', newName: '.' },
      'rename'
    );
    expect(result.elevated).toBe(false);
    expect(result.error).toBe('Invalid name');
  });

  it('throws non-permission errors without elevation prompt', async () => {
    const err = new Error('disk full') as NodeJS.ErrnoException;
    err.code = 'ENOSPC';

    await expect(
      tryWithElevation(
        async () => {
          throw err;
        },
        { type: 'delete', sourcePath: '/file' },
        'delete'
      )
    ).rejects.toThrow('disk full');
  });

  it('returns cancelled when user declines elevation (no mainWindow)', async () => {
    const err = new Error('perm') as NodeJS.ErrnoException;
    err.code = 'EACCES';

    const result = await tryWithElevation(
      async () => {
        throw err;
      },
      { type: 'delete', sourcePath: '/protected' },
      'delete'
    );
    expect(result.elevated).toBe(false);
    expect(result.error).toBe('Operation cancelled');
  });
});
