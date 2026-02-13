import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), on: vi.fn() },
}));

vi.mock('../appState', () => ({
  getMainWindow: vi.fn(() => null),
}));

vi.mock('../security', () => ({
  isPathSafe: vi.fn((p: string) => !p.includes('\0') && p.startsWith('/')),
  getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

vi.mock('../shared', () => ({
  ignoreError: vi.fn(),
}));

vi.mock('../settingsManager', () => ({
  loadSettings: vi.fn(async () => ({ skipElevationConfirmation: false })),
}));

vi.mock('../ipcUtils', () => ({
  isTrustedIpcEvent: vi.fn(() => true),
}));

import { isPermissionError, tryWithElevation } from '../elevatedOperations';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isPermissionError', () => {
  it('returns true for EACCES', () => {
    const err = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    expect(isPermissionError(err)).toBe(true);
  });

  it('returns true for EPERM', () => {
    const err = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    expect(isPermissionError(err)).toBe(true);
  });

  it('returns false for ENOENT', () => {
    const err = Object.assign(new Error('Not found'), { code: 'ENOENT' });
    expect(isPermissionError(err)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isPermissionError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isPermissionError(undefined)).toBe(false);
  });

  it('returns false for plain error without code', () => {
    expect(isPermissionError(new Error('generic'))).toBe(false);
  });

  it('returns false for string', () => {
    expect(isPermissionError('EACCES')).toBe(false);
  });
});

describe('tryWithElevation - path validation', () => {
  it('rejects invalid source path', async () => {
    const result = await tryWithElevation(
      async () => 'ok',
      { type: 'copy', sourcePath: '\0bad', destPath: '/tmp/dest' },
      'copy'
    );
    expect(result.error).toBe('Invalid source path');
  });

  it('rejects invalid destination path', async () => {
    const result = await tryWithElevation(
      async () => 'ok',
      { type: 'copy', sourcePath: '/tmp/src', destPath: '\0bad' },
      'copy'
    );
    expect(result.error).toBe('Invalid destination path');
  });

  it('rejects newName with forward slash', async () => {
    const result = await tryWithElevation(
      async () => 'ok',
      { type: 'rename', sourcePath: '/tmp/file', newName: 'a/b' },
      'rename'
    );
    expect(result.error).toBe('Invalid name');
  });

  it('rejects newName with backslash', async () => {
    const result = await tryWithElevation(
      async () => 'ok',
      { type: 'rename', sourcePath: '/tmp/file', newName: 'a\\b' },
      'rename'
    );
    expect(result.error).toBe('Invalid name');
  });

  it('rejects newName with double dot', async () => {
    const result = await tryWithElevation(
      async () => 'ok',
      { type: 'rename', sourcePath: '/tmp/file', newName: '..' },
      'rename'
    );
    expect(result.error).toBe('Invalid name');
  });

  it('rejects newName that is just a dot', async () => {
    const result = await tryWithElevation(
      async () => 'ok',
      { type: 'rename', sourcePath: '/tmp/file', newName: '.' },
      'rename'
    );
    expect(result.error).toBe('Invalid name');
  });

  it('allows empty newName through tryWithElevation (validated later in executeElevated)', async () => {
    const result = await tryWithElevation(
      async () => 'ok',
      { type: 'rename', sourcePath: '/tmp/file', newName: '' },
      'rename'
    );
    expect(result.result).toBe('ok');
    expect(result.elevated).toBe(false);
  });

  it('succeeds when operation succeeds', async () => {
    const result = await tryWithElevation(
      async () => 'success',
      { type: 'copy', sourcePath: '/tmp/src', destPath: '/tmp/dest' },
      'copy'
    );
    expect(result.result).toBe('success');
    expect(result.elevated).toBe(false);
  });

  it('throws non-permission errors', async () => {
    await expect(
      tryWithElevation(
        async () => {
          throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
        },
        { type: 'delete', sourcePath: '/tmp/file' },
        'delete'
      )
    ).rejects.toThrow('Not found');
  });
});
