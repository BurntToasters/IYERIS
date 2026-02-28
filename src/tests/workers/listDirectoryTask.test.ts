import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../workers/workerUtils', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../workers/workerUtils')>();
  return {
    ...original,
    isCancelled: vi.fn(() => false),
    sendProgress: vi.fn(),
    batchCheckHidden: vi.fn(
      async () => new Map<string, { isHidden: boolean; isSystemProtected: boolean }>()
    ),
  };
});

import { batchCheckHidden, isCancelled, sendProgress } from '../../workers/workerUtils';
import { listDirectory } from '../../workers/listDirectoryTask';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iyeris-list-dir-'));
  vi.mocked(isCancelled).mockReset();
  vi.mocked(isCancelled).mockReturnValue(false);
  vi.mocked(sendProgress).mockReset();
  vi.mocked(batchCheckHidden).mockReset();
  vi.mocked(batchCheckHidden).mockResolvedValue(
    new Map<string, { isHidden: boolean; isSystemProtected: boolean }>()
  );
});

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

describe('listDirectory', () => {
  it('returns visible entries and excludes hidden entries by default', async () => {
    await fs.mkdir(path.join(tmpDir, 'folder'));
    await fs.writeFile(path.join(tmpDir, 'visible.txt'), 'visible');
    await fs.writeFile(path.join(tmpDir, '.hidden.txt'), 'hidden');

    const result = await listDirectory({ dirPath: tmpDir, batchSize: 2 }, 'op-list');
    const names = result.contents.map((item) => item.name).sort();

    expect(names).toContain('folder');
    expect(names).toContain('visible.txt');
    expect(names).not.toContain('.hidden.txt');
    expect(sendProgress).toHaveBeenCalled();
  });

  it('includes hidden entries when includeHidden is true', async () => {
    await fs.writeFile(path.join(tmpDir, 'visible.txt'), 'visible');
    await fs.writeFile(path.join(tmpDir, '.hidden.txt'), 'hidden');

    const result = await listDirectory(
      { dirPath: tmpDir, includeHidden: true, batchSize: 10 },
      'op-hidden'
    );
    const names = result.contents.map((item) => item.name).sort();

    expect(names).toEqual(['.hidden.txt', 'visible.txt']);
  });

  it('streams progress while returning empty contents in streamOnly mode', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'a');
    await fs.writeFile(path.join(tmpDir, 'b.txt'), 'b');

    const result = await listDirectory(
      { dirPath: tmpDir, streamOnly: true, includeHidden: true, batchSize: 1 },
      'op-stream'
    );

    expect(result).toEqual({ contents: [] });
    expect(sendProgress).toHaveBeenCalled();
    expect(sendProgress).toHaveBeenCalledWith(
      'list-directory',
      'op-stream',
      expect.objectContaining({
        dirPath: tmpDir,
        items: expect.any(Array),
      })
    );
  });

  it('throws cancellation error when operation is cancelled', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'a');
    vi.mocked(isCancelled).mockReturnValue(true);

    await expect(listDirectory({ dirPath: tmpDir }, 'op-cancel')).rejects.toThrow(
      'Calculation cancelled'
    );
  });
});
