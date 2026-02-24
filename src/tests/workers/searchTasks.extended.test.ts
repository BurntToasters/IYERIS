import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  searchDirectoryFiles,
  searchDirectoryContent,
  searchContentIndex,
  searchContentList,
} from '../../workers/searchTasks';

vi.mock('../../workers/workerUtils', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../workers/workerUtils')>();
  return {
    ...orig,
    isCancelled: vi.fn(() => false),
    sendProgress: vi.fn(),
    isHidden: vi.fn((_filePath: string, fileName: string) => fileName.startsWith('.')),
    batchCheckHidden: vi.fn((_dir: string, names: string[]) => {
      const map = new Map<string, { isHidden: boolean; isSystemProtected: boolean }>();
      for (const name of names) {
        map.set(name, { isHidden: name.startsWith('.'), isSystemProtected: false });
      }
      return Promise.resolve(map);
    }),
  };
});

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'search-ext-'));
  const { resetIndexCache } = await import('../../workers/workerUtils');
  resetIndexCache();
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

async function writeIndex(
  indexPath: string,
  entries: Array<[string, Record<string, unknown>]>
): Promise<void> {
  const data = {
    index: entries,
    lastIndexTime: Date.now(),
    version: 1,
  };
  await fs.promises.writeFile(indexPath, JSON.stringify(data));
}

describe('searchDirectoryFiles – uncovered branches', () => {
  it.skipIf(process.platform === 'win32')(
    'continues when readdir fails on an unreadable subdirectory (line 216)',
    async () => {
      await fs.promises.writeFile(path.join(tmpDir, 'ok.txt'), 'content');

      const badDir = path.join(tmpDir, 'noperm');
      await fs.promises.mkdir(badDir);

      await fs.promises.writeFile(path.join(badDir, 'match.txt'), 'x');
      await fs.promises.chmod(badDir, 0o000);

      const results = await searchDirectoryFiles({
        dirPath: tmpDir,
        query: 'ok',
        maxDepth: 5,
        maxResults: 100,
      });

      expect(results.some((r) => r.name === 'ok.txt')).toBe(true);
      expect(results.some((r) => r.name === 'match.txt')).toBe(false);

      await fs.promises.chmod(badDir, 0o755);
    }
  );
});

describe('searchDirectoryContent – uncovered branches', () => {
  it.skipIf(process.platform === 'win32')(
    'continues when readdir fails on an unreadable subdirectory (line 302)',
    async () => {
      await fs.promises.writeFile(path.join(tmpDir, 'root.txt'), 'findable text');

      const badDir = path.join(tmpDir, 'unreadable');
      await fs.promises.mkdir(badDir);
      await fs.promises.chmod(badDir, 0o000);

      const results = await searchDirectoryContent({
        dirPath: tmpDir,
        query: 'findable',
        maxDepth: 5,
        maxResults: 100,
      });

      expect(results.length).toBe(1);
      expect(results[0].name).toBe('root.txt');

      await fs.promises.chmod(badDir, 0o755);
    }
  );

  it('traverses into subdirectories for content search (line 316)', async () => {
    const sub = path.join(tmpDir, 'subdir');
    await fs.promises.mkdir(sub);
    await fs.promises.writeFile(path.join(sub, 'nested.txt'), 'deep content match');

    const results = await searchDirectoryContent({
      dirPath: tmpDir,
      query: 'deep content',
      maxDepth: 5,
      maxResults: 100,
    });

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('nested.txt');
    expect(results[0].matchContext).toContain('deep content');
  });

  it('traverses multiple levels of subdirectories', async () => {
    const l1 = path.join(tmpDir, 'a');
    const l2 = path.join(l1, 'b');
    await fs.promises.mkdir(l1);
    await fs.promises.mkdir(l2);
    await fs.promises.writeFile(path.join(l2, 'deep.txt'), 'very deep text');

    const results = await searchDirectoryContent({
      dirPath: tmpDir,
      query: 'very deep',
      maxDepth: 5,
      maxResults: 100,
    });

    expect(results.length).toBe(1);
    expect(results[0].matchLineNumber).toBe(1);
  });

  it('respects maxDepth and does not search too deep', async () => {
    const l1 = path.join(tmpDir, 'x');
    const l2 = path.join(l1, 'y');
    await fs.promises.mkdir(l1);
    await fs.promises.mkdir(l2);
    await fs.promises.writeFile(path.join(l2, 'blocked.txt'), 'should not find');

    const results = await searchDirectoryContent({
      dirPath: tmpDir,
      query: 'should not find',
      maxDepth: 1,
      maxResults: 100,
    });

    expect(results.length).toBe(0);
  });

  it('skips non-text files during content search', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'data.bin'), 'secret content');

    const results = await searchDirectoryContent({
      dirPath: tmpDir,
      query: 'secret',
      maxDepth: 5,
      maxResults: 100,
    });

    expect(results.length).toBe(0);
  });

  it('applies size filters in content search', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'small.txt'), 'x');
    await fs.promises.writeFile(path.join(tmpDir, 'big.txt'), 'y'.repeat(5000));

    const results = await searchDirectoryContent({
      dirPath: tmpDir,
      query: 'y',
      filters: { minSize: 100 },
      maxDepth: 5,
      maxResults: 100,
    });

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('big.txt');
  });

  it('respects maxResults in content search', async () => {
    for (let i = 0; i < 10; i++) {
      await fs.promises.writeFile(path.join(tmpDir, `f${i}.txt`), 'matchme');
    }

    const results = await searchDirectoryContent({
      dirPath: tmpDir,
      query: 'matchme',
      maxDepth: 5,
      maxResults: 2,
    });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('handles cancellation during content search', async () => {
    const { isCancelled } = await import('../../workers/workerUtils');
    const mockCancelled = isCancelled as ReturnType<typeof vi.fn>;

    await fs.promises.writeFile(path.join(tmpDir, 'cancel.txt'), 'data');

    let callCount = 0;
    mockCancelled.mockImplementation(() => {
      callCount++;
      return callCount > 1;
    });

    await expect(
      searchDirectoryContent({
        dirPath: tmpDir,
        query: 'data',
        maxDepth: 5,
        maxResults: 100,
      })
    ).rejects.toThrow('Calculation cancelled');

    mockCancelled.mockReturnValue(false);
  });

  it('marks hidden files correctly in content results', async () => {
    await fs.promises.writeFile(path.join(tmpDir, '.secret.txt'), 'hidden content');

    const results = await searchDirectoryContent({
      dirPath: tmpDir,
      query: 'hidden content',
      maxDepth: 5,
      maxResults: 100,
    });

    expect(results.length).toBe(1);
    expect(results[0].isHidden).toBe(true);
  });
});

describe('searchContentIndex', () => {
  it('searches content of files referenced in the index', async () => {
    const filePath = path.join(tmpDir, 'indexed.txt');
    await fs.promises.writeFile(filePath, 'indexed searchable content');

    const indexPath = path.join(tmpDir, 'index.json');
    await writeIndex(indexPath, [
      [
        filePath,
        {
          name: 'indexed.txt',
          path: filePath,
          isDirectory: false,
          isFile: true,
          size: 25,
          modified: Date.now(),
        },
      ],
    ]);

    const results = await searchContentIndex({
      indexPath,
      query: 'searchable',
      maxResults: 100,
    });

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('indexed.txt');
    expect(results[0].matchContext).toContain('searchable');
  });

  it('throws on empty index', async () => {
    const indexPath = path.join(tmpDir, 'empty-index.json');
    await writeIndex(indexPath, []);

    await expect(searchContentIndex({ indexPath, query: 'test', maxResults: 10 })).rejects.toThrow(
      'Index is empty'
    );
  });

  it('throws when index file does not exist', async () => {
    const indexPath = path.join(tmpDir, 'nonexistent.json');

    await expect(
      searchContentIndex({ indexPath, query: 'test', maxResults: 10 })
    ).rejects.toThrow();
  });

  it('skips directory entries in the index', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'content here');

    const indexPath = path.join(tmpDir, 'index-dirs.json');
    await writeIndex(indexPath, [
      [
        '/tmp/mydir',
        {
          name: 'mydir',
          path: '/tmp/mydir',
          isDirectory: true,
          isFile: false,
          size: 0,
          modified: Date.now(),
        },
      ],
      [
        filePath,
        {
          name: 'file.txt',
          path: filePath,
          isFile: true,
          isDirectory: false,
          size: 12,
          modified: Date.now(),
        },
      ],
    ]);

    const results = await searchContentIndex({
      indexPath,
      query: 'content here',
      maxResults: 100,
    });

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('file.txt');
  });

  it('skips non-text file extensions', async () => {
    const binPath = path.join(tmpDir, 'photo.png');
    await fs.promises.writeFile(binPath, 'findme');

    const indexPath = path.join(tmpDir, 'index-bin.json');
    await writeIndex(indexPath, [
      [
        binPath,
        {
          name: 'photo.png',
          path: binPath,
          isFile: true,
          isDirectory: false,
          size: 6,
          modified: Date.now(),
        },
      ],
    ]);

    const results = await searchContentIndex({
      indexPath,
      query: 'findme',
      maxResults: 100,
    });

    expect(results.length).toBe(0);
  });

  it('applies minSize filter', async () => {
    const smallFile = path.join(tmpDir, 'small.txt');
    await fs.promises.writeFile(smallFile, 'tiny');
    const bigFile = path.join(tmpDir, 'big.txt');
    await fs.promises.writeFile(bigFile, 'content '.repeat(100));

    const indexPath = path.join(tmpDir, 'index-minsize.json');
    await writeIndex(indexPath, [
      [
        smallFile,
        {
          name: 'small.txt',
          path: smallFile,
          isFile: true,
          isDirectory: false,
          size: 4,
          modified: Date.now(),
        },
      ],
      [
        bigFile,
        {
          name: 'big.txt',
          path: bigFile,
          isFile: true,
          isDirectory: false,
          size: 800,
          modified: Date.now(),
        },
      ],
    ]);

    const results = await searchContentIndex({
      indexPath,
      query: 'content',
      maxResults: 100,
      filters: { minSize: 100 },
    });

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('big.txt');
  });

  it('applies maxSize filter', async () => {
    const smallFile = path.join(tmpDir, 'small.txt');
    await fs.promises.writeFile(smallFile, 'hi there');
    const bigFile = path.join(tmpDir, 'big.txt');
    await fs.promises.writeFile(bigFile, 'hi there '.repeat(200));

    const indexPath = path.join(tmpDir, 'index-maxsize.json');
    await writeIndex(indexPath, [
      [
        smallFile,
        {
          name: 'small.txt',
          path: smallFile,
          isFile: true,
          isDirectory: false,
          size: 8,
          modified: Date.now(),
        },
      ],
      [
        bigFile,
        {
          name: 'big.txt',
          path: bigFile,
          isFile: true,
          isDirectory: false,
          size: 1800,
          modified: Date.now(),
        },
      ],
    ]);

    const results = await searchContentIndex({
      indexPath,
      query: 'hi there',
      maxResults: 100,
      filters: { maxSize: 100 },
    });

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('small.txt');
  });

  it('respects maxResults', async () => {
    const files: Array<[string, Record<string, unknown>]> = [];
    for (let i = 0; i < 10; i++) {
      const fp = path.join(tmpDir, `r${i}.txt`);
      await fs.promises.writeFile(fp, 'common keyword');
      files.push([
        fp,
        {
          name: `r${i}.txt`,
          path: fp,
          isFile: true,
          isDirectory: false,
          size: 14,
          modified: Date.now(),
        },
      ]);
    }

    const indexPath = path.join(tmpDir, 'index-max.json');
    await writeIndex(indexPath, files);

    const results = await searchContentIndex({
      indexPath,
      query: 'common keyword',
      maxResults: 3,
    });

    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('uses path.basename when name is missing from index entry', async () => {
    const filePath = path.join(tmpDir, 'noname.txt');
    await fs.promises.writeFile(filePath, 'discoverable text');

    const indexPath = path.join(tmpDir, 'index-noname.json');
    await writeIndex(indexPath, [
      [
        filePath,
        {
          path: filePath,
          isFile: true,
          isDirectory: false,
          size: 17,
          modified: Date.now(),
        },
      ],
    ]);

    const results = await searchContentIndex({
      indexPath,
      query: 'discoverable',
      maxResults: 100,
    });

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('noname.txt');
  });

  it('handles size as string using Number()', async () => {
    const filePath = path.join(tmpDir, 'strsize.txt');
    await fs.promises.writeFile(filePath, 'size test content');

    const indexPath = path.join(tmpDir, 'index-strsize.json');
    await writeIndex(indexPath, [
      [
        filePath,
        {
          name: 'strsize.txt',
          path: filePath,
          isFile: true,
          isDirectory: false,
          size: '17' as any,
          modified: Date.now(),
        },
      ],
    ]);

    const results = await searchContentIndex({
      indexPath,
      query: 'size test',
      maxResults: 100,
    });

    expect(results.length).toBe(1);
    expect(results[0].size).toBe(17);
  });

  it('defaults size to 0 when NaN', async () => {
    const filePath = path.join(tmpDir, 'nansize.txt');
    await fs.promises.writeFile(filePath, 'nan size data');

    const indexPath = path.join(tmpDir, 'index-nansize.json');
    await writeIndex(indexPath, [
      [
        filePath,
        {
          name: 'nansize.txt',
          path: filePath,
          isFile: true,
          isDirectory: false,
          size: 'not-a-number' as any,
          modified: Date.now(),
        },
      ],
    ]);

    const results = await searchContentIndex({
      indexPath,
      query: 'nan size',
      maxResults: 100,
    });

    expect(results.length).toBe(1);
    expect(results[0].size).toBe(0);
  });

  it('handles cancellation', async () => {
    const { isCancelled } = await import('../../workers/workerUtils');
    const mockCancelled = isCancelled as ReturnType<typeof vi.fn>;

    const filePath = path.join(tmpDir, 'cancel.txt');
    await fs.promises.writeFile(filePath, 'cancel data');

    const indexPath = path.join(tmpDir, 'index-cancel.json');
    await writeIndex(indexPath, [
      [
        filePath,
        {
          name: 'cancel.txt',
          path: filePath,
          isFile: true,
          isDirectory: false,
          size: 11,
          modified: Date.now(),
        },
      ],
    ]);

    mockCancelled.mockReturnValue(true);

    await expect(
      searchContentIndex({ indexPath, query: 'cancel', maxResults: 100 })
    ).rejects.toThrow('Calculation cancelled');

    mockCancelled.mockReturnValue(false);
  });

  it('defaults maxResults to 100 when not finite', async () => {
    const filePath = path.join(tmpDir, 'default.txt');
    await fs.promises.writeFile(filePath, 'default limit');

    const indexPath = path.join(tmpDir, 'index-default.json');
    await writeIndex(indexPath, [
      [
        filePath,
        {
          name: 'default.txt',
          path: filePath,
          isFile: true,
          isDirectory: false,
          size: 13,
          modified: Date.now(),
        },
      ],
    ]);

    const results = await searchContentIndex({
      indexPath,
      query: 'default limit',
      maxResults: NaN as any,
    });

    expect(results.length).toBe(1);
  });

  it('skips entries with invalid parseIndexEntry result', async () => {
    const filePath = path.join(tmpDir, 'valid.txt');
    await fs.promises.writeFile(filePath, 'valid content');

    const indexPath = path.join(tmpDir, 'index-invalid.json');
    const data = {
      index: [
        'just a string',
        42,
        null,
        [
          filePath,
          {
            name: 'valid.txt',
            path: filePath,
            isFile: true,
            isDirectory: false,
            size: 13,
            modified: Date.now(),
          },
        ],
      ],
      lastIndexTime: Date.now(),
      version: 1,
    };
    await fs.promises.writeFile(indexPath, JSON.stringify(data));

    const results = await searchContentIndex({
      indexPath,
      query: 'valid content',
      maxResults: 100,
    });

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('valid.txt');
  });

  it('flushes batch when CONTENT_SEARCH_BATCH_SIZE (8) is reached', async () => {
    const entries: Array<[string, Record<string, unknown>]> = [];
    for (let i = 0; i < 10; i++) {
      const fp = path.join(tmpDir, `batch${i}.txt`);
      await fs.promises.writeFile(fp, 'batchword content');
      entries.push([
        fp,
        {
          name: `batch${i}.txt`,
          path: fp,
          isFile: true,
          isDirectory: false,
          size: 17,
          modified: Date.now(),
        },
      ]);
    }

    const indexPath = path.join(tmpDir, 'index-batch.json');
    await writeIndex(indexPath, entries);

    const results = await searchContentIndex({
      indexPath,
      query: 'batchword',
      maxResults: 100,
    });

    expect(results.length).toBe(10);
  });

  it('handles entries where isFile is not true', async () => {
    const indexPath = path.join(tmpDir, 'index-nofile.json');
    await writeIndex(indexPath, [
      [
        '/tmp/something',
        {
          name: 'something',
          path: '/tmp/something',
          isFile: false,
          isDirectory: false,
          size: 0,
          modified: Date.now(),
        },
      ],
    ]);

    const results = await searchContentIndex({
      indexPath,
      query: 'anything',
      maxResults: 100,
    });

    expect(results.length).toBe(0);
  });
});

describe('searchContentList – additional edge cases', () => {
  it('handles files array being undefined/empty', async () => {
    const results = await searchContentList({
      files: [],
      query: 'test',
      maxResults: 100,
    });

    expect(results.length).toBe(0);
  });

  it('applies minSize filter on content list', async () => {
    const fp = path.join(tmpDir, 'tiny.txt');
    await fs.promises.writeFile(fp, 'hi');

    const results = await searchContentList({
      files: [{ path: fp, size: 2, name: 'tiny.txt', modified: Date.now() }],
      query: 'hi',
      maxResults: 100,
      filters: { minSize: 100 },
    });

    expect(results.length).toBe(0);
  });

  it('applies maxSize filter on content list', async () => {
    const fp = path.join(tmpDir, 'large.txt');
    const content = 'searchterm '.repeat(100);
    await fs.promises.writeFile(fp, content);

    const results = await searchContentList({
      files: [{ path: fp, size: content.length, name: 'large.txt', modified: Date.now() }],
      query: 'searchterm',
      maxResults: 100,
      filters: { maxSize: 10 },
    });

    expect(results.length).toBe(0);
  });

  it('uses path.basename when name is not provided', async () => {
    const fp = path.join(tmpDir, 'unnamed.txt');
    await fs.promises.writeFile(fp, 'findable');

    const results = await searchContentList({
      files: [{ path: fp, size: 8 }],
      query: 'findable',
      maxResults: 100,
    });

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('unnamed.txt');
  });

  it('flushes remaining batch at the end', async () => {
    const files = [];
    for (let i = 0; i < 3; i++) {
      const fp = path.join(tmpDir, `end${i}.txt`);
      await fs.promises.writeFile(fp, 'endbatch');
      files.push({ path: fp, size: 8, name: `end${i}.txt`, modified: Date.now() });
    }

    const results = await searchContentList({
      files,
      query: 'endbatch',
      maxResults: 100,
    });

    expect(results.length).toBe(3);
  });

  it('handles cancellation in content list search', async () => {
    const { isCancelled } = await import('../../workers/workerUtils');
    const mockCancelled = isCancelled as ReturnType<typeof vi.fn>;

    const fp = path.join(tmpDir, 'cl.txt');
    await fs.promises.writeFile(fp, 'data');

    mockCancelled.mockReturnValue(true);

    await expect(
      searchContentList({
        files: [{ path: fp, size: 4, name: 'cl.txt', modified: Date.now() }],
        query: 'data',
        maxResults: 100,
      })
    ).rejects.toThrow('Calculation cancelled');

    mockCancelled.mockReturnValue(false);
  });

  it('triggers flushContentSearchBatch early return when results are already at maxResults (lines 149-150)', async () => {
    const files = [];
    for (let i = 0; i < 10; i++) {
      const fp = path.join(tmpDir, `full${i}.txt`);
      await fs.promises.writeFile(fp, 'earlyreturn');
      files.push({ path: fp, size: 11, name: `full${i}.txt`, modified: Date.now() });
    }

    const results = await searchContentList({
      files,
      query: 'earlyreturn',
      maxResults: 1,
    });

    expect(results.length).toBe(1);
  });
});

describe('searchFileContent – error handling (line 135)', () => {
  it.skipIf(process.platform === 'win32')(
    'returns found:false when file read throws a non-cancellation error',
    async () => {
      const fp = path.join(tmpDir, 'unreadable.txt');
      await fs.promises.writeFile(fp, 'secret data');
      await fs.promises.chmod(fp, 0o000);

      const results = await searchContentList({
        files: [{ path: fp, size: 11, name: 'unreadable.txt', modified: Date.now() }],
        query: 'secret',
        maxResults: 100,
      });

      expect(results.length).toBe(0);

      await fs.promises.chmod(fp, 0o644);
    }
  );

  it('returns found:false when file does not exist', async () => {
    const fp = path.join(tmpDir, 'ghost.txt');

    const results = await searchContentList({
      files: [{ path: fp, size: 100, name: 'ghost.txt', modified: Date.now() }],
      query: 'anything',
      maxResults: 100,
    });

    expect(results.length).toBe(0);
  });
});
