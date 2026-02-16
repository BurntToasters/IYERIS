import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { calculateFolderSize, calculateChecksum } from '../../workers/computeTasks';

vi.mock('../../workers/workerUtils', () => ({
  isCancelled: vi.fn(() => false),
  sendProgress: vi.fn(),
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'compute-test-'));
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('calculateFolderSize', () => {
  it('returns zero for an empty directory', async () => {
    const result = await calculateFolderSize({ folderPath: tmpDir });
    expect(result.totalSize).toBe(0);
    expect(result.fileCount).toBe(0);
    expect(result.folderCount).toBe(0);
    expect(result.fileTypes).toEqual([]);
  });

  it('counts a single file', async () => {
    const content = 'hello world';
    await fs.promises.writeFile(path.join(tmpDir, 'file.txt'), content);
    const result = await calculateFolderSize({ folderPath: tmpDir });
    expect(result.fileCount).toBe(1);
    expect(result.totalSize).toBe(Buffer.byteLength(content));
    expect(result.folderCount).toBe(0);
  });

  it('counts files in subdirectories', async () => {
    const subDir = path.join(tmpDir, 'sub');
    await fs.promises.mkdir(subDir);
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'aaa');
    await fs.promises.writeFile(path.join(subDir, 'b.txt'), 'bbb');
    const result = await calculateFolderSize({ folderPath: tmpDir });
    expect(result.fileCount).toBe(2);
    expect(result.folderCount).toBe(1);
  });

  it('groups file types by extension', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'aa');
    await fs.promises.writeFile(path.join(tmpDir, 'b.txt'), 'bb');
    await fs.promises.writeFile(path.join(tmpDir, 'c.js'), 'cc');
    const result = await calculateFolderSize({ folderPath: tmpDir });
    expect(result.fileTypes.length).toBeGreaterThanOrEqual(2);
    const txtType = result.fileTypes.find((t) => t.extension === '.txt');
    const jsType = result.fileTypes.find((t) => t.extension === '.js');
    expect(txtType?.count).toBe(2);
    expect(jsType?.count).toBe(1);
  });

  it('returns size and files as aliases', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'x.dat'), 'data');
    const result = await calculateFolderSize({ folderPath: tmpDir });
    expect(result.size).toBe(result.totalSize);
    expect(result.files).toBe(result.fileCount);
    expect(result.dirs).toBe(result.folderCount);
  });

  it.skipIf(process.platform === 'win32')(
    'handles unreadable subdirectories gracefully',
    async () => {
      const badDir = path.join(tmpDir, 'noaccess');
      await fs.promises.mkdir(badDir);
      await fs.promises.writeFile(path.join(tmpDir, 'ok.txt'), 'ok');
      await fs.promises.chmod(badDir, 0o000);
      const result = await calculateFolderSize({ folderPath: tmpDir });
      expect(result.fileCount).toBe(1);
      await fs.promises.chmod(badDir, 0o755);
    }
  );

  it('limits fileTypes to top 10', async () => {
    for (let i = 0; i < 15; i++) {
      await fs.promises.writeFile(path.join(tmpDir, `file.ext${i}`), `data${i}`);
    }
    const result = await calculateFolderSize({ folderPath: tmpDir });
    expect(result.fileTypes.length).toBeLessThanOrEqual(10);
  });

  it('files without extension get (no extension) label', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'Makefile'), 'all:');
    const result = await calculateFolderSize({ folderPath: tmpDir });
    const noExt = result.fileTypes.find((t) => t.extension === '(no extension)');
    expect(noExt).toBeDefined();
    expect(noExt!.count).toBe(1);
  });
});

describe('calculateChecksum', () => {
  let testFile: string;

  beforeEach(async () => {
    testFile = path.join(tmpDir, 'checksum-test.bin');
    await fs.promises.writeFile(testFile, 'hello checksum');
  });

  it('computes md5 hash', async () => {
    const result = await calculateChecksum({ filePath: testFile, algorithms: ['md5'] });
    expect(result.md5).toBeDefined();
    expect(result.md5).toMatch(/^[0-9a-f]{32}$/);
  });

  it('computes sha256 hash', async () => {
    const result = await calculateChecksum({ filePath: testFile, algorithms: ['sha256'] });
    expect(result.sha256).toBeDefined();
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computes both md5 and sha256 at once', async () => {
    const result = await calculateChecksum({
      filePath: testFile,
      algorithms: ['md5', 'sha256'],
    });
    expect(result.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces consistent hashes for same content', async () => {
    const r1 = await calculateChecksum({ filePath: testFile, algorithms: ['sha256'] });
    const r2 = await calculateChecksum({ filePath: testFile, algorithms: ['sha256'] });
    expect(r1.sha256).toBe(r2.sha256);
  });

  it('produces different hashes for different content', async () => {
    const file2 = path.join(tmpDir, 'other.bin');
    await fs.promises.writeFile(file2, 'different content');
    const r1 = await calculateChecksum({ filePath: testFile, algorithms: ['sha256'] });
    const r2 = await calculateChecksum({ filePath: file2, algorithms: ['sha256'] });
    expect(r1.sha256).not.toBe(r2.sha256);
  });

  it('throws when no valid algorithms specified', async () => {
    await expect(
      calculateChecksum({ filePath: testFile, algorithms: ['invalid'] })
    ).rejects.toThrow('No valid algorithms specified');
  });

  it('throws when algorithms array is empty', async () => {
    await expect(calculateChecksum({ filePath: testFile, algorithms: [] })).rejects.toThrow(
      'No valid algorithms specified'
    );
  });

  it('filters out invalid algorithms and keeps valid ones', async () => {
    const result = await calculateChecksum({
      filePath: testFile,
      algorithms: ['invalid', 'md5', 'unknown'],
    });
    expect(result.md5).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is case insensitive for algorithm names', async () => {
    const r1 = await calculateChecksum({ filePath: testFile, algorithms: ['MD5'] });
    const r2 = await calculateChecksum({ filePath: testFile, algorithms: ['md5'] });
    expect(r1.md5).toBe(r2.md5);
  });

  it('deduplicates algorithms', async () => {
    const result = await calculateChecksum({
      filePath: testFile,
      algorithms: ['md5', 'md5', 'MD5'],
    });
    expect(result.md5).toMatch(/^[0-9a-f]{32}$/);
  });

  it('throws for nonexistent file', async () => {
    await expect(
      calculateChecksum({ filePath: path.join(tmpDir, 'nope'), algorithms: ['md5'] })
    ).rejects.toThrow();
  });
});
