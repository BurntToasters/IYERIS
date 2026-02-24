import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  mockPostMessage: vi.fn(),
  mockStat: vi.fn(),
  mockReadFile: vi.fn(),
  mockExecFileAsync: vi.fn(),
}));

vi.mock('worker_threads', () => ({
  parentPort: { postMessage: hoisted.mockPostMessage },
}));

vi.mock('fs', () => ({
  promises: {
    stat: (...args: unknown[]) => hoisted.mockStat(...args),
    readFile: (...args: unknown[]) => hoisted.mockReadFile(...args),
  },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('util', () => ({
  promisify: () => hoisted.mockExecFileAsync,
}));

const { mockPostMessage, mockStat, mockReadFile, mockExecFileAsync } = hoisted;

import {
  sendProgress,
  readIndexData,
  resetIndexCache,
  isHidden,
  batchCheckHidden,
  parseIndexEntry,
  normalizePathForCompare,
} from '../../workers/workerUtils';

describe('sendProgress', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('posts progress message via parentPort', () => {
    sendProgress('build-index', 'op-1', { current: 5, total: 100, name: 'scanning' });
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'progress',
      task: 'build-index',
      operationId: 'op-1',
      data: { current: 5, total: 100, name: 'scanning' },
    });
  });

  it('sends with different task types', () => {
    sendProgress('search-files', 'op-2', { percent: 50 });
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'search-files', operationId: 'op-2' })
    );
  });

  it('sends empty data object', () => {
    sendProgress('folder-size', 'op-3', {});
    expect(mockPostMessage).toHaveBeenCalledOnce();
  });
});

describe('readIndexData', () => {
  beforeEach(() => {
    resetIndexCache();
    mockStat.mockReset();
    mockReadFile.mockReset();
  });

  it('reads and parses valid JSON index file', async () => {
    mockStat.mockResolvedValue({ mtimeMs: 12345 });
    mockReadFile.mockResolvedValue('{"index": {}, "version": 1}');

    const data = await readIndexData('/path/to/index.json', 'No index found');
    expect(data).toEqual({ index: {}, version: 1 });
  });

  it('returns cached data when mtime has not changed', async () => {
    mockStat.mockResolvedValue({ mtimeMs: 99999 });
    mockReadFile.mockResolvedValue('{"version": 2}');

    const first = await readIndexData('/path/to/index.json', 'empty');
    expect(first).toEqual({ version: 2 });

    mockStat.mockResolvedValue({ mtimeMs: 99999 });

    mockReadFile.mockRejectedValue(new Error('should not be called'));

    const second = await readIndexData('/path/to/index.json', 'empty');
    expect(second).toEqual({ version: 2 });
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it('re-reads when mtime changes', async () => {
    mockStat.mockResolvedValue({ mtimeMs: 100 });
    mockReadFile.mockResolvedValue('{"version": 1}');
    await readIndexData('/some/path.json', 'msg');

    mockStat.mockResolvedValue({ mtimeMs: 200 });
    mockReadFile.mockResolvedValue('{"version": 2}');
    const data = await readIndexData('/some/path.json', 'msg');
    expect(data).toEqual({ version: 2 });
    expect(mockReadFile).toHaveBeenCalledTimes(2);
  });

  it('throws custom message for ENOENT', async () => {
    const err = new Error('not found') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    mockStat.mockRejectedValue(err);

    await expect(readIndexData('/missing.json', 'Index not built yet')).rejects.toThrow(
      'Index not built yet'
    );
  });

  it('re-throws non-ENOENT errors', async () => {
    const err = new Error('disk failure') as NodeJS.ErrnoException;
    err.code = 'EIO';
    mockStat.mockRejectedValue(err);

    await expect(readIndexData('/some.json', 'msg')).rejects.toThrow('disk failure');
  });

  it('throws for corrupted JSON', async () => {
    mockStat.mockResolvedValue({ mtimeMs: 500 });
    mockReadFile.mockResolvedValue('not json!!!');

    await expect(readIndexData('/bad.json', 'msg')).rejects.toThrow('Index file is corrupted');
  });

  it('clears cache after corrupted JSON', async () => {
    mockStat.mockResolvedValue({ mtimeMs: 500 });
    mockReadFile.mockResolvedValue('{invalid');
    await expect(readIndexData('/bad.json', 'msg')).rejects.toThrow();

    mockStat.mockResolvedValue({ mtimeMs: 500 });
    mockReadFile.mockResolvedValue('{"version": 3}');
    const data = await readIndexData('/bad.json', 'msg');
    expect(data).toEqual({ version: 3 });
  });

  it('clears cache after ENOENT', async () => {
    mockStat.mockResolvedValue({ mtimeMs: 100 });
    mockReadFile.mockResolvedValue('{"ok": true}');
    await readIndexData('/x.json', 'msg');

    const err = new Error('gone') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    mockStat.mockRejectedValue(err);
    await expect(readIndexData('/x.json', 'no index')).rejects.toThrow('no index');

    mockStat.mockResolvedValue({ mtimeMs: 100 });
    mockReadFile.mockResolvedValue('{"rebuilt": true}');
    const data = await readIndexData('/x.json', 'msg');
    expect(data).toEqual({ rebuilt: true });
  });
});

describe('resetIndexCache', () => {
  beforeEach(() => {
    mockStat.mockReset();
    mockReadFile.mockReset();
    resetIndexCache();
  });

  it('clears the index cache so data is re-read', async () => {
    mockStat.mockResolvedValue({ mtimeMs: 777 });
    mockReadFile.mockResolvedValue('{"cached": true}');
    await readIndexData('/resetTest.json', 'msg');

    resetIndexCache();

    mockReadFile.mockResolvedValue('{"fresh": true}');
    const data = await readIndexData('/resetTest.json', 'msg');
    expect(data).toEqual({ fresh: true });
    expect(mockReadFile).toHaveBeenCalledTimes(2);
  });
});

describe('isHidden', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('returns true for dot-prefixed files on any platform', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(await isHidden('/home/user/.bashrc', '.bashrc')).toBe(true);
  });

  it('returns false for non-dot files on non-win32 platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(await isHidden('/home/user/readme.txt', 'readme.txt')).toBe(false);
  });

  it('returns false for non-dot files on darwin', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(await isHidden('/Users/test/file.txt', 'file.txt')).toBe(false);
  });

  it('returns true for .hidden on linux without checking attrib', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });

    mockExecFileAsync.mockRejectedValue(new Error('should not be called'));
    expect(await isHidden('/tmp/.hidden', '.hidden')).toBe(true);
  });

  it('checks attrib on win32 for non-dot files', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockExecFileAsync.mockResolvedValue({
      stdout: '  A  H        C:\\Users\\test\\hidden.txt\r\n',
    });
    expect(await isHidden('C:\\Users\\test\\hidden.txt', 'hidden.txt')).toBe(true);
  });

  it('returns false on win32 when attrib shows no H', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockExecFileAsync.mockResolvedValue({
      stdout: '  A           C:\\Users\\test\\noH.txt\r\n',
    });
    expect(await isHidden('C:\\Users\\test\\noH.txt', 'noH.txt')).toBe(false);
  });

  it('returns false on win32 when attrib fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockExecFileAsync.mockRejectedValue(new Error('access denied'));
    expect(await isHidden('C:\\Users\\test\\failedAttrib.txt', 'failedAttrib.txt')).toBe(false);
  });

  it('returns false on win32 when attrib returns empty output', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockExecFileAsync.mockResolvedValue({ stdout: '' });
    expect(await isHidden('C:\\Users\\test\\emptyOutput.txt', 'emptyOutput.txt')).toBe(false);
  });

  it('returns false on win32 when attrib output has no match', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockExecFileAsync.mockResolvedValue({ stdout: 'garbage line\n' });
    expect(await isHidden('C:\\Users\\test\\noMatch.txt', 'noMatch.txt')).toBe(false);
  });
});

describe('batchCheckHidden', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('marks dot-files as hidden on non-win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const results = await batchCheckHidden('/home/user', ['.bashrc', 'readme.md', '.gitignore']);
    expect(results.get('.bashrc')).toEqual({ isHidden: true, isSystemProtected: false });
    expect(results.get('.gitignore')).toEqual({ isHidden: true, isSystemProtected: false });
    expect(results.has('readme.md')).toBe(false);
  });

  it('ignores non-dot files on non-win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const results = await batchCheckHidden('/Users/test', ['file.txt', 'photo.jpg']);
    expect(results.size).toBe(0);
  });

  it('checks attrib on win32 for non-dot files', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockExecFileAsync.mockResolvedValue({
      stdout: '  A  H        file1.txt\r\n  A           file2.txt\r\n',
    });

    const results = await batchCheckHidden('C:\\Users\\test', ['.dot', 'file1.txt', 'file2.txt']);
    expect(results.get('.dot')).toEqual({ isHidden: true, isSystemProtected: false });
    expect(results.get('file1.txt')).toEqual({ isHidden: true, isSystemProtected: false });
    expect(results.get('file2.txt')).toEqual({ isHidden: false, isSystemProtected: false });
  });

  it('handles attrib failure gracefully on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockExecFileAsync.mockRejectedValue(new Error('attrib failed'));

    const results = await batchCheckHidden('C:\\test', ['normal.txt']);
    expect(results.get('normal.txt')).toEqual({ isHidden: false, isSystemProtected: false });
  });

  it('detects System+Hidden as isSystemProtected on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockExecFileAsync.mockResolvedValue({
      stdout:
        'A  SH        ntuser.dat.LOG1\r\n   SH        ntuser.ini\r\n    H        AppData\r\nA            readme.txt\r\n',
    });

    const results = await batchCheckHidden('C:\\Users\\test', [
      'ntuser.dat.LOG1',
      'ntuser.ini',
      'AppData',
      'readme.txt',
    ]);
    expect(results.get('ntuser.dat.LOG1')).toEqual({ isHidden: true, isSystemProtected: true });
    expect(results.get('ntuser.ini')).toEqual({ isHidden: true, isSystemProtected: true });
    expect(results.get('AppData')).toEqual({ isHidden: true, isSystemProtected: false });
    expect(results.get('readme.txt')).toEqual({ isHidden: false, isSystemProtected: false });
  });

  it('returns empty map for empty file list', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const results = await batchCheckHidden('/tmp', []);
    expect(results.size).toBe(0);
  });
});

describe('parseIndexEntry edge cases', () => {
  it('handles null first element in array', () => {
    const result = parseIndexEntry([null, { name: 'test' }]);
    expect(result.filePath).toBeUndefined();
    expect(result.item).toEqual({ name: 'test' });
  });

  it('handles array with only string path', () => {
    const result = parseIndexEntry(['/path/to/file', 'not-a-record']);
    expect(result.filePath).toBe('/path/to/file');
    expect(result.item).toBeUndefined();
  });

  it('returns empty for number input', () => {
    const result = parseIndexEntry(42);
    expect(result.filePath).toBeUndefined();
    expect(result.item).toBeUndefined();
  });

  it('returns empty for string input', () => {
    const result = parseIndexEntry('just a string');
    expect(result.filePath).toBeUndefined();
    expect(result.item).toBeUndefined();
  });

  it('handles record without path property', () => {
    const result = parseIndexEntry({ name: 'hello', size: 100 });
    expect(result.filePath).toBeUndefined();
    expect(result.item).toEqual({ name: 'hello', size: 100 });
  });
});
