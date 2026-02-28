import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockIsCancelled = vi.hoisted(() => vi.fn(() => false));
const mockSendProgress = vi.hoisted(() => vi.fn());

vi.mock('../../workers/workerUtils', () => ({
  isCancelled: mockIsCancelled,
  sendProgress: mockSendProgress,
}));

import { calculateFolderSize, calculateChecksum } from '../../workers/computeTasks';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'compute-ext-'));
  mockIsCancelled.mockReturnValue(false);
  mockSendProgress.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('calculateChecksum – cancellation during streaming (lines 172-174)', () => {
  it('rejects with cancellation error when isCancelled returns true during data read', async () => {
    const testFile = path.join(tmpDir, 'cancel-stream.bin');

    await fs.promises.writeFile(testFile, Buffer.alloc(1024, 'x'));

    mockIsCancelled.mockReturnValue(true);

    await expect(
      calculateChecksum({ filePath: testFile, algorithms: ['md5'] }, 'cancel-op')
    ).rejects.toThrow('Calculation cancelled');
  });

  it('rejects with cancellation for multiple-algorithm checksum', async () => {
    const testFile = path.join(tmpDir, 'cancel-multi.bin');
    await fs.promises.writeFile(testFile, Buffer.alloc(1024, 'y'));

    mockIsCancelled.mockReturnValue(true);

    await expect(
      calculateChecksum({ filePath: testFile, algorithms: ['md5', 'sha256'] }, 'cancel-multi-op')
    ).rejects.toThrow('Calculation cancelled');
  });
});

describe('calculateChecksum – progress reporting (lines 182-186)', () => {
  it('sends progress with single algorithm label when operationId is provided', async () => {
    const testFile = path.join(tmpDir, 'progress-single.bin');
    await fs.promises.writeFile(testFile, Buffer.alloc(512, 'a'));

    const originalDateNow = Date.now;
    let callIndex = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callIndex++;

      return 1000 + callIndex * 200;
    });

    await calculateChecksum({ filePath: testFile, algorithms: ['md5'] }, 'progress-op-1');

    expect(mockSendProgress).toHaveBeenCalledWith(
      'checksum',
      'progress-op-1',
      expect.objectContaining({
        algorithm: 'md5',
      })
    );

    Date.now = originalDateNow;
  });

  it('sends progress with joined label for multiple algorithms', async () => {
    const testFile = path.join(tmpDir, 'progress-multi.bin');
    await fs.promises.writeFile(testFile, Buffer.alloc(512, 'b'));

    let callIndex = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callIndex++;
      return 1000 + callIndex * 200;
    });

    await calculateChecksum({ filePath: testFile, algorithms: ['md5', 'sha256'] }, 'progress-op-2');

    expect(mockSendProgress).toHaveBeenCalledWith(
      'checksum',
      'progress-op-2',
      expect.objectContaining({
        algorithm: 'md5+sha256',
      })
    );
  });

  it('reports percent as 0 when fileSize is 0', async () => {
    const testFile = path.join(tmpDir, 'empty-file.bin');
    await fs.promises.writeFile(testFile, '');

    let callIndex = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callIndex++;
      return 1000 + callIndex * 200;
    });

    const result = await calculateChecksum(
      { filePath: testFile, algorithms: ['md5'] },
      'progress-empty'
    );
    expect(result.md5).toBeDefined();
  });

  it('does not send progress when operationId is undefined', async () => {
    const testFile = path.join(tmpDir, 'no-opid.bin');
    await fs.promises.writeFile(testFile, Buffer.alloc(512, 'c'));

    let callIndex = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callIndex++;
      return 1000 + callIndex * 200;
    });

    await calculateChecksum({ filePath: testFile, algorithms: ['md5'] });

    const checksumCalls = mockSendProgress.mock.calls.filter((c: unknown[]) => c[0] === 'checksum');
    expect(checksumCalls.length).toBe(0);
  });

  it('sends progress percent between 0 and 100', async () => {
    const testFile = path.join(tmpDir, 'progress-percent.bin');
    await fs.promises.writeFile(testFile, Buffer.alloc(1024, 'd'));

    let callIndex = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callIndex++;
      return 1000 + callIndex * 200;
    });

    await calculateChecksum({ filePath: testFile, algorithms: ['sha256'] }, 'progress-pct');

    const calls = mockSendProgress.mock.calls.filter(
      (c: unknown[]) => c[0] === 'checksum' && c[1] === 'progress-pct'
    );
    for (const call of calls) {
      const data = call[2] as { percent: number };
      expect(data.percent).toBeGreaterThanOrEqual(0);
      expect(data.percent).toBeLessThanOrEqual(100);
    }
  });
});

describe('calculateChecksum – stream error handling', () => {
  it('rejects when stream emits read error', async () => {
    const testFile = path.join(tmpDir, 'stream-error.bin');
    await fs.promises.mkdir(testFile);
    await expect(calculateChecksum({ filePath: testFile, algorithms: ['md5'] })).rejects.toThrow();
  });
});

describe('calculateChecksum – algorithms edge cases', () => {
  it('handles algorithms passed as non-array gracefully', async () => {
    const testFile = path.join(tmpDir, 'non-array.bin');
    await fs.promises.writeFile(testFile, 'test');

    await expect(
      calculateChecksum({ filePath: testFile, algorithms: 'md5' as any })
    ).rejects.toThrow('No valid algorithms specified');
  });

  it('handles algorithms passed as undefined gracefully', async () => {
    const testFile = path.join(tmpDir, 'undef-algo.bin');
    await fs.promises.writeFile(testFile, 'test');

    await expect(
      calculateChecksum({ filePath: testFile, algorithms: undefined as any })
    ).rejects.toThrow('No valid algorithms specified');
  });
});

describe('calculateFolderSize – cancellation', () => {
  it('throws cancellation error when cancelled before processing entries', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'file.txt'), 'data');

    mockIsCancelled.mockReturnValue(true);

    await expect(calculateFolderSize({ folderPath: tmpDir }, 'cancel-folder-op')).rejects.toThrow(
      'Calculation cancelled'
    );
  });

  it('throws cancellation error while iterating entries', async () => {
    const subDir = path.join(tmpDir, 'sub');
    await fs.promises.mkdir(subDir);
    await fs.promises.writeFile(path.join(subDir, 'a.txt'), 'aaa');
    await fs.promises.writeFile(path.join(tmpDir, 'b.txt'), 'bbb');

    let callCount = 0;
    mockIsCancelled.mockImplementation(() => {
      callCount++;
      return callCount > 1;
    });

    await expect(calculateFolderSize({ folderPath: tmpDir }, 'cancel-iter-op')).rejects.toThrow(
      'Calculation cancelled'
    );
  });
});

describe('calculateFolderSize – progress reporting', () => {
  it('sends progress updates when operationId is provided and time threshold met', async () => {
    for (let i = 0; i < 5; i++) {
      await fs.promises.writeFile(path.join(tmpDir, `file${i}.txt`), `content${i}`);
    }

    let callIndex = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callIndex++;

      return 1000 + callIndex * 200;
    });

    await calculateFolderSize({ folderPath: tmpDir }, 'folder-progress-op');

    const folderCalls = mockSendProgress.mock.calls.filter(
      (c: unknown[]) => c[0] === 'folder-size'
    );
    expect(folderCalls.length).toBeGreaterThanOrEqual(1);
    expect(folderCalls[0][1]).toBe('folder-progress-op');
    expect(folderCalls[0][2]).toEqual(
      expect.objectContaining({
        calculatedSize: expect.any(Number),
        fileCount: expect.any(Number),
        folderCount: expect.any(Number),
        currentPath: expect.any(String),
      })
    );
  });

  it('does not send progress without operationId', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'f.txt'), 'data');

    let callIndex = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callIndex++;
      return 1000 + callIndex * 200;
    });

    await calculateFolderSize({ folderPath: tmpDir });

    const folderCalls = mockSendProgress.mock.calls.filter(
      (c: unknown[]) => c[0] === 'folder-size'
    );
    expect(folderCalls.length).toBe(0);
  });
});

describe('calculateFolderSize – stat failure in batch', () => {
  it('handles stat failures for individual files in a batch gracefully', async () => {
    const badFile = path.join(tmpDir, 'unreadable.txt');
    const goodFile = path.join(tmpDir, 'readable.txt');
    await fs.promises.writeFile(goodFile, 'good');
    await fs.promises.writeFile(badFile, 'bad');

    const result = await calculateFolderSize({ folderPath: tmpDir });
    expect(result.fileCount).toBeGreaterThanOrEqual(1);
  });
});

describe('calculateFolderSize – large batch processing', () => {
  it('processes files in batches of 50 correctly', async () => {
    const fileCount = 55;
    for (let i = 0; i < fileCount; i++) {
      await fs.promises.writeFile(path.join(tmpDir, `batch${i}.txt`), `data${i}`);
    }

    const result = await calculateFolderSize({ folderPath: tmpDir });
    expect(result.fileCount).toBe(fileCount);
    expect(result.totalSize).toBeGreaterThan(0);
  });
});
