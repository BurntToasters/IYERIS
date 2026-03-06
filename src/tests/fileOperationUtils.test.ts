import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

const { fsMock, osMock } = vi.hoisted(() => ({
  fsMock: {
    stat: vi.fn(),
    cp: vi.fn(),
    copyFile: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
    open: vi.fn(),
    realpath: vi.fn(),
  },
  osMock: {
    totalmem: vi.fn(() => 16 * 1024 ** 3),
  },
}));

vi.mock('fs', () => ({
  promises: fsMock,
}));

vi.mock('os', () => ({
  default: osMock,
  totalmem: osMock.totalmem,
}));

vi.mock('../shared', () => ({
  ignoreError: vi.fn(),
}));

import {
  isValidChildName,
  pathExists,
  getParallelBatchSize,
  validateFileOperation,
  copyPathByType,
  renameWithExdevFallback,
  removePaths,
  createUniqueFile,
} from '../main/fileOperationUtils';

beforeEach(() => {
  vi.clearAllMocks();
  osMock.totalmem.mockReturnValue(16 * 1024 ** 3);
});

describe('isValidChildName', () => {
  it('rejects empty string', () => {
    expect(isValidChildName('')).toBe(false);
  });

  it('rejects single dot', () => {
    expect(isValidChildName('.')).toBe(false);
  });

  it('rejects double dot (path traversal)', () => {
    expect(isValidChildName('..')).toBe(false);
  });

  it('rejects names containing forward slash', () => {
    expect(isValidChildName('foo/bar')).toBe(false);
  });

  it('rejects names containing backslash', () => {
    expect(isValidChildName('foo\\bar')).toBe(false);
  });

  it('accepts normal file names', () => {
    expect(isValidChildName('file.txt')).toBe(true);
    expect(isValidChildName('my-folder')).toBe(true);
    expect(isValidChildName('.hidden')).toBe(true);
    expect(isValidChildName('...triple')).toBe(true);
  });
});

describe('pathExists', () => {
  it('returns true for existing path', async () => {
    fsMock.stat.mockResolvedValue({});
    expect(await pathExists('/existing')).toBe(true);
  });

  it('returns false for non-existing path', async () => {
    fsMock.stat.mockRejectedValue(new Error('ENOENT'));
    expect(await pathExists('/nope')).toBe(false);
  });
});

describe('getParallelBatchSize', () => {
  it('returns 4 for low memory systems', () => {
    osMock.totalmem.mockReturnValue(4 * 1024 ** 3);
    expect(getParallelBatchSize()).toBe(4);
  });

  it('returns 8 for 8GB systems', () => {
    osMock.totalmem.mockReturnValue(8 * 1024 ** 3);
    expect(getParallelBatchSize()).toBe(8);
  });

  it('returns 12 for 16GB systems', () => {
    osMock.totalmem.mockReturnValue(16 * 1024 ** 3);
    expect(getParallelBatchSize()).toBe(12);
  });

  it('returns 16 for 32GB+ systems', () => {
    osMock.totalmem.mockReturnValue(32 * 1024 ** 3);
    expect(getParallelBatchSize()).toBe(16);
  });
});

describe('validateFileOperation', () => {
  const mockIsPathSafe = vi.fn(() => true);
  const mockLogger = { warn: vi.fn() };

  beforeEach(() => {
    mockIsPathSafe.mockReturnValue(true);
    mockLogger.warn.mockClear();
    fsMock.realpath.mockImplementation((p: string) => Promise.resolve(p));
  });

  it('rejects unsafe destination path', async () => {
    mockIsPathSafe.mockReturnValue(false);
    const result = await validateFileOperation(
      ['/src/file.txt'],
      '/dest',
      'copy',
      'ask',
      undefined,
      mockIsPathSafe,
      mockLogger
    );
    expect(result).toEqual({ success: false, error: 'Invalid destination path' });
  });

  it('rejects empty source paths', async () => {
    const result = await validateFileOperation(
      [],
      '/dest',
      'copy',
      'ask',
      undefined,
      mockIsPathSafe
    );
    expect(result).toEqual({ success: false, error: 'No source items provided' });
  });

  it('rejects unsafe source path', async () => {
    mockIsPathSafe.mockImplementation(((p: string) => p !== '/unsafe/file.txt') as () => boolean);
    const result = await validateFileOperation(
      ['/unsafe/file.txt'],
      '/dest',
      'copy',
      'ask',
      undefined,
      mockIsPathSafe,
      mockLogger
    );
    expect(result).toEqual({ success: false, error: 'Invalid source path' });
  });

  it('plans simple copy for non-existing destination', async () => {
    fsMock.stat
      .mockResolvedValueOnce({ isDirectory: () => false })
      .mockRejectedValueOnce(new Error('ENOENT'));

    const result = await validateFileOperation(
      ['/src/file.txt'],
      '/dest',
      'copy',
      'ask',
      undefined,
      mockIsPathSafe
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.planned).toHaveLength(1);
      expect(result.planned[0].itemName).toBe('file.txt');
    }
  });

  it('prevents copying directory into itself', async () => {
    fsMock.stat.mockResolvedValue({ isDirectory: () => true });

    const result = await validateFileOperation(
      ['/dest'],
      '/dest',
      'copy',
      'ask',
      undefined,
      mockIsPathSafe
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('into itself');
    }
  });
});

describe('copyPathByType', () => {
  it('uses cp with recursive for directories', async () => {
    fsMock.cp.mockResolvedValue(undefined);
    await copyPathByType('/src', '/dest', true);
    expect(fsMock.cp).toHaveBeenCalledWith('/src', '/dest', { recursive: true });
  });

  it('uses copyFile for files', async () => {
    fsMock.copyFile.mockResolvedValue(undefined);
    await copyPathByType('/src/file.txt', '/dest/file.txt', false);
    expect(fsMock.copyFile).toHaveBeenCalledWith('/src/file.txt', '/dest/file.txt');
  });
});

describe('renameWithExdevFallback', () => {
  it('uses rename for same-device moves', async () => {
    fsMock.rename.mockResolvedValue(undefined);
    await renameWithExdevFallback('/src/file.txt', '/dest/file.txt');
    expect(fsMock.rename).toHaveBeenCalledWith('/src/file.txt', '/dest/file.txt');
  });

  it('falls back to copy+delete on EXDEV error', async () => {
    const exdevError = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    fsMock.rename.mockRejectedValue(exdevError);
    fsMock.stat.mockResolvedValue({ isDirectory: () => false });
    fsMock.copyFile.mockResolvedValue(undefined);
    fsMock.rm.mockResolvedValue(undefined);

    await renameWithExdevFallback('/src/file.txt', '/dest/file.txt');
    expect(fsMock.copyFile).toHaveBeenCalled();
    expect(fsMock.rm).toHaveBeenCalledWith('/src/file.txt', { recursive: true, force: true });
  });

  it('rethrows non-EXDEV errors', async () => {
    const error = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    fsMock.rename.mockRejectedValue(error);
    await expect(renameWithExdevFallback('/src', '/dest')).rejects.toThrow('EACCES');
  });

  it('uses provided isDirectory flag for EXDEV fallback', async () => {
    const exdevError = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    fsMock.rename.mockRejectedValue(exdevError);
    fsMock.cp.mockResolvedValue(undefined);
    fsMock.rm.mockResolvedValue(undefined);

    await renameWithExdevFallback('/src/dir', '/dest/dir', true);
    expect(fsMock.cp).toHaveBeenCalledWith('/src/dir', '/dest/dir', { recursive: true });
  });
});

describe('removePaths', () => {
  it('removes all provided paths', async () => {
    fsMock.rm.mockResolvedValue(undefined);
    await removePaths(['/a', '/b', '/c']);
    expect(fsMock.rm).toHaveBeenCalledTimes(3);
  });

  it('continues removing even if one path fails', async () => {
    fsMock.rm.mockRejectedValueOnce(new Error('EACCES')).mockResolvedValue(undefined);
    await removePaths(['/fail', '/ok']);
    expect(fsMock.rm).toHaveBeenCalledTimes(2);
  });
});

describe('createUniqueFile', () => {
  it('creates file with original name if it does not exist', async () => {
    const mockHandle = { close: vi.fn() };
    fsMock.open.mockResolvedValue(mockHandle);

    const result = await createUniqueFile('/parent', 'test.txt');
    expect(result.name).toBe('test.txt');
    expect(result.path).toBe(path.join('/parent', 'test.txt'));
    expect(mockHandle.close).toHaveBeenCalled();
  });

  it('increments counter on EEXIST', async () => {
    const eexistError = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    const mockHandle = { close: vi.fn() };
    fsMock.open.mockRejectedValueOnce(eexistError).mockResolvedValue(mockHandle);

    const result = await createUniqueFile('/parent', 'test.txt');
    expect(result.name).toBe('test (2).txt');
    expect(result.path).toBe(path.join('/parent', 'test (2).txt'));
  });

  it('rethrows non-EEXIST errors', async () => {
    const error = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    fsMock.open.mockRejectedValue(error);
    await expect(createUniqueFile('/parent', 'test.txt')).rejects.toThrow('EACCES');
  });

  it('handles files without extension', async () => {
    const eexistError = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    const mockHandle = { close: vi.fn() };
    fsMock.open.mockRejectedValueOnce(eexistError).mockResolvedValue(mockHandle);

    const result = await createUniqueFile('/parent', 'Makefile');
    expect(result.name).toBe('Makefile (2)');
  });
});
