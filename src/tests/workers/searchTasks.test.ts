import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  searchDirectoryFiles,
  searchDirectoryContent,
  searchIndexFile,
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
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'search-test-'));
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('searchDirectoryFiles', () => {
  it('finds files matching query', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'hello.txt'), 'content');
    await fs.promises.writeFile(path.join(tmpDir, 'world.txt'), 'data');
    const results = await searchDirectoryFiles({
      dirPath: tmpDir,
      query: 'hello',
      maxDepth: 5,
      maxResults: 100,
    });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('hello.txt');
  });

  it('returns empty for no matches', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'abc.txt'), 'xyz');
    const results = await searchDirectoryFiles({
      dirPath: tmpDir,
      query: 'zzz',
      maxDepth: 5,
      maxResults: 100,
    });
    expect(results.length).toBe(0);
  });

  it('searches case-insensitively', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'MyFile.TXT'), 'data');
    const results = await searchDirectoryFiles({
      dirPath: tmpDir,
      query: 'myfile',
      maxDepth: 5,
      maxResults: 100,
    });
    expect(results.length).toBe(1);
  });

  it('searches subdirectories up to maxDepth', async () => {
    const sub = path.join(tmpDir, 'level1');
    await fs.promises.mkdir(sub);
    await fs.promises.writeFile(path.join(sub, 'deep.txt'), 'data');
    const results = await searchDirectoryFiles({
      dirPath: tmpDir,
      query: 'deep',
      maxDepth: 5,
      maxResults: 100,
    });
    expect(results.length).toBe(1);
  });

  it('respects maxResults', async () => {
    for (let i = 0; i < 10; i++) {
      await fs.promises.writeFile(path.join(tmpDir, `match${i}.txt`), 'x');
    }
    const results = await searchDirectoryFiles({
      dirPath: tmpDir,
      query: 'match',
      maxDepth: 5,
      maxResults: 3,
    });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('marks hidden files correctly', async () => {
    await fs.promises.writeFile(path.join(tmpDir, '.hidden'), 'secret');
    const results = await searchDirectoryFiles({
      dirPath: tmpDir,
      query: '.hidden',
      maxDepth: 5,
      maxResults: 100,
    });
    expect(results.length).toBe(1);
    expect(results[0].isHidden).toBe(true);
  });

  it('includes file metadata', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'info.txt'), 'hello content');
    const results = await searchDirectoryFiles({
      dirPath: tmpDir,
      query: 'info',
      maxDepth: 5,
      maxResults: 100,
    });
    expect(results[0].isFile).toBe(true);
    expect(results[0].size).toBe(13);
    expect(results[0].modified).toBeInstanceOf(Date);
  });
});

describe('searchDirectoryContent', () => {
  it('finds files containing search text', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'doc.txt'), 'the quick brown fox');
    await fs.promises.writeFile(path.join(tmpDir, 'other.txt'), 'no match here');
    const results = await searchDirectoryContent({
      dirPath: tmpDir,
      query: 'quick brown',
      maxDepth: 5,
      maxResults: 100,
    });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('doc.txt');
    expect(results[0].matchContext).toContain('quick brown');
  });

  it('returns match context and line number', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'code.js'), 'line1\nline2\nfindme here\nline4');
    const results = await searchDirectoryContent({
      dirPath: tmpDir,
      query: 'findme',
      maxDepth: 5,
      maxResults: 100,
    });
    expect(results.length).toBe(1);
    expect(results[0].matchLineNumber).toBe(3);
  });

  it('skips non-text files', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'image.png'), 'findme in binary');
    const results = await searchDirectoryContent({
      dirPath: tmpDir,
      query: 'findme',
      maxDepth: 5,
      maxResults: 100,
    });
    expect(results.length).toBe(0);
  });

  it('returns empty when no content matches', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'file.txt'), 'nothing relevant');
    const results = await searchDirectoryContent({
      dirPath: tmpDir,
      query: 'zzznotfound',
      maxDepth: 5,
      maxResults: 100,
    });
    expect(results.length).toBe(0);
  });
});

describe('searchIndexFile', () => {
  it('searches index entries by name', async () => {
    const indexPath = path.join(tmpDir, 'test-index.json');
    const now = Date.now();
    const data = {
      index: [
        [
          '/tmp/hello.txt',
          {
            name: 'hello.txt',
            path: '/tmp/hello.txt',
            isDirectory: false,
            isFile: true,
            size: 10,
            modified: now,
          },
        ],
        [
          '/tmp/world.js',
          {
            name: 'world.js',
            path: '/tmp/world.js',
            isDirectory: false,
            isFile: true,
            size: 20,
            modified: now,
          },
        ],
        [
          '/tmp/docs',
          {
            name: 'docs',
            path: '/tmp/docs',
            isDirectory: true,
            isFile: false,
            size: 0,
            modified: now,
          },
        ],
      ],
      lastIndexTime: now,
      version: 1,
    };
    await fs.promises.writeFile(indexPath, JSON.stringify(data));

    const results = await searchIndexFile({ indexPath, query: 'hello' });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('hello.txt');
    expect(results[0].isFile).toBe(true);
  });

  it('returns empty for no matches', async () => {
    const indexPath = path.join(tmpDir, 'test-index2.json');
    const data = {
      index: [
        [
          '/tmp/a.txt',
          {
            name: 'a.txt',
            path: '/tmp/a.txt',
            isDirectory: false,
            isFile: true,
            size: 5,
            modified: Date.now(),
          },
        ],
      ],
      lastIndexTime: Date.now(),
      version: 1,
    };
    await fs.promises.writeFile(indexPath, JSON.stringify(data));
    const results = await searchIndexFile({ indexPath, query: 'zzz' });
    expect(results.length).toBe(0);
  });

  it('returns empty for empty query', async () => {
    const indexPath = path.join(tmpDir, 'test-index3.json');
    const data = {
      index: [
        [
          '/tmp/a.txt',
          {
            name: 'a.txt',
            path: '/tmp/a.txt',
            isDirectory: false,
            isFile: true,
            size: 5,
            modified: Date.now(),
          },
        ],
      ],
      lastIndexTime: Date.now(),
      version: 1,
    };
    await fs.promises.writeFile(indexPath, JSON.stringify(data));
    const results = await searchIndexFile({ indexPath, query: '' });
    expect(results.length).toBe(0);
  });

  it('respects maxResults', async () => {
    const indexPath = path.join(tmpDir, 'test-index4.json');
    const now = Date.now();
    const entries = [];
    for (let i = 0; i < 20; i++) {
      entries.push([
        `/tmp/match${i}.txt`,
        {
          name: `match${i}.txt`,
          path: `/tmp/match${i}.txt`,
          isDirectory: false,
          isFile: true,
          size: 5,
          modified: now,
        },
      ]);
    }
    await fs.promises.writeFile(
      indexPath,
      JSON.stringify({ index: entries, lastIndexTime: now, version: 1 })
    );
    const results = await searchIndexFile({ indexPath, query: 'match', maxResults: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('sorts exact matches first', async () => {
    const indexPath = path.join(tmpDir, 'test-index5.json');
    const now = Date.now();
    const data = {
      index: [
        [
          '/tmp/foobar.txt',
          {
            name: 'foobar.txt',
            path: '/tmp/foobar.txt',
            isDirectory: false,
            isFile: true,
            size: 5,
            modified: now,
          },
        ],
        [
          '/tmp/foo',
          {
            name: 'foo',
            path: '/tmp/foo',
            isDirectory: true,
            isFile: false,
            size: 0,
            modified: now,
          },
        ],
      ],
      lastIndexTime: now,
      version: 1,
    };
    await fs.promises.writeFile(indexPath, JSON.stringify(data));
    const results = await searchIndexFile({ indexPath, query: 'foo' });
    expect(results.length).toBe(2);
    expect(results[0].name).toBe('foo');
  });

  it('throws for empty index', async () => {
    const indexPath = path.join(tmpDir, 'empty.json');
    await fs.promises.writeFile(
      indexPath,
      JSON.stringify({ index: [], lastIndexTime: Date.now(), version: 1 })
    );
    await expect(searchIndexFile({ indexPath, query: 'test' })).rejects.toThrow('Index is empty');
  });
});

describe('searchContentList', () => {
  it('searches content of provided file list', async () => {
    const filePath = path.join(tmpDir, 'searchable.txt');
    await fs.promises.writeFile(filePath, 'this is searchable content');
    const results = await searchContentList({
      files: [{ path: filePath, size: 26, name: 'searchable.txt', modified: Date.now() }],
      query: 'searchable',
      maxResults: 100,
    });
    expect(results.length).toBe(1);
    expect(results[0].matchContext).toContain('searchable');
  });

  it('returns empty for non-text files', async () => {
    const filePath = path.join(tmpDir, 'photo.png');
    await fs.promises.writeFile(filePath, 'findme');
    const results = await searchContentList({
      files: [{ path: filePath, size: 6, name: 'photo.png', modified: Date.now() }],
      query: 'findme',
      maxResults: 100,
    });
    expect(results.length).toBe(0);
  });

  it('respects maxResults', async () => {
    const files = [];
    for (let i = 0; i < 10; i++) {
      const fp = path.join(tmpDir, `f${i}.txt`);
      await fs.promises.writeFile(fp, 'findme');
      files.push({ path: fp, size: 6, name: `f${i}.txt`, modified: Date.now() });
    }
    const results = await searchContentList({
      files,
      query: 'findme',
      maxResults: 3,
    });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
