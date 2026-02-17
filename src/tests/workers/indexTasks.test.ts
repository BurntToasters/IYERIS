import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildIndex, loadIndexFile, saveIndexFile } from '../../workers/indexTasks';

vi.mock('../../workers/workerUtils', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../workers/workerUtils')>();
  return {
    ...orig,
    isCancelled: vi.fn(() => false),
    sendProgress: vi.fn(),
    batchCheckHidden: vi.fn(async () => new Map()),
  };
});

let tmpDir: string;

// On Windows, os.tmpdir() is under AppData which buildIndex's shouldExclude filters out.
// Use a directory under the user's home that won't match any excluded segments.
const tmpBase =
  process.platform === 'win32' ? path.join(os.homedir(), '.iyeris-test-tmp') : os.tmpdir();

beforeEach(async () => {
  await fs.promises.mkdir(tmpBase, { recursive: true });
  tmpDir = await fs.promises.mkdtemp(path.join(tmpBase, 'index-test-'));
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('buildIndex', () => {
  it('indexes files in a directory', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'aaa');
    await fs.promises.writeFile(path.join(tmpDir, 'b.js'), 'bbb');
    const result = await buildIndex({ locations: [tmpDir], skipDirs: [] });
    expect(result.indexedFiles).toBe(2);
    expect(result.entries).toBeDefined();
    expect(result.entries!.length).toBe(2);
  });

  it('indexes subdirectories recursively', async () => {
    const sub = path.join(tmpDir, 'sub');
    await fs.promises.mkdir(sub);
    await fs.promises.writeFile(path.join(sub, 'c.txt'), 'ccc');
    const result = await buildIndex({ locations: [tmpDir], skipDirs: [] });
    expect(result.indexedFiles).toBeGreaterThanOrEqual(2);
    const names = result.entries!.map((e) => e[1].name);
    expect(names).toContain('sub');
    expect(names).toContain('c.txt');
  });

  it('skips directories by segment name', async () => {
    const nodeModules = path.join(tmpDir, 'node_modules');
    await fs.promises.mkdir(nodeModules);
    await fs.promises.writeFile(path.join(nodeModules, 'pkg.json'), '{}');
    await fs.promises.writeFile(path.join(tmpDir, 'app.js'), 'code');
    const result = await buildIndex({ locations: [tmpDir], skipDirs: [] });
    const names = result.entries!.map((e) => e[1].name);
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('pkg.json');
    expect(names).toContain('app.js');
  });

  it('skips custom directories', async () => {
    const custom = path.join(tmpDir, 'myskip');
    await fs.promises.mkdir(custom);
    await fs.promises.writeFile(path.join(custom, 'secret.txt'), 's');
    await fs.promises.writeFile(path.join(tmpDir, 'ok.txt'), 'ok');
    const result = await buildIndex({ locations: [tmpDir], skipDirs: ['myskip'] });
    const names = result.entries!.map((e) => e[1].name);
    expect(names).not.toContain('myskip');
    expect(names).toContain('ok.txt');
  });

  it('respects maxIndexSize', async () => {
    for (let i = 0; i < 10; i++) {
      await fs.promises.writeFile(path.join(tmpDir, `file${i}.txt`), `data${i}`);
    }
    const result = await buildIndex({ locations: [tmpDir], skipDirs: [], maxIndexSize: 3 });
    expect(result.indexedFiles).toBeLessThanOrEqual(3);
  });

  it('returns empty for empty directory', async () => {
    const result = await buildIndex({ locations: [tmpDir], skipDirs: [] });
    expect(result.indexedFiles).toBe(0);
    expect(result.entries).toEqual([]);
  });

  it('entries contain correct metadata', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'test.txt'), 'hello');
    const result = await buildIndex({ locations: [tmpDir], skipDirs: [] });
    const entry = result.entries![0];
    expect(entry[1].name).toBe('test.txt');
    expect(entry[1].isFile).toBe(true);
    expect(entry[1].isDirectory).toBe(false);
    expect(entry[1].size).toBe(5);
    expect(typeof entry[1].modified).toBe('number');
  });
});

describe('saveIndexFile', () => {
  it('saves index data to file', async () => {
    const indexPath = path.join(tmpDir, 'index.json');
    const entries: Array<
      [
        string,
        {
          name: string;
          path: string;
          isDirectory: boolean;
          isFile: boolean;
          size: number;
          modified: number;
        },
      ]
    > = [
      [
        '/tmp/a.txt',
        {
          name: 'a.txt',
          path: '/tmp/a.txt',
          isDirectory: false,
          isFile: true,
          size: 10,
          modified: Date.now(),
        },
      ],
    ];
    const result = await saveIndexFile({ indexPath, entries, lastIndexTime: Date.now() });
    expect(result.success).toBe(true);
    const contents = JSON.parse(await fs.promises.readFile(indexPath, 'utf-8'));
    expect(contents.version).toBe(1);
    expect(contents.index.length).toBe(1);
  });
});

describe('loadIndexFile', () => {
  it('returns exists:false for nonexistent file', async () => {
    const result = await loadIndexFile({ indexPath: path.join(tmpDir, 'nope.json') });
    expect(result.exists).toBe(false);
    expect(result.indexedFiles).toBe(0);
  });

  it('loads a valid saved index', async () => {
    const indexPath = path.join(tmpDir, 'test-index.json');
    const now = Date.now();
    const entries: Array<
      [
        string,
        {
          name: string;
          path: string;
          isDirectory: boolean;
          isFile: boolean;
          size: number;
          modified: number;
        },
      ]
    > = [
      [
        '/a.txt',
        { name: 'a.txt', path: '/a.txt', isDirectory: false, isFile: true, size: 5, modified: now },
      ],
      ['/b', { name: 'b', path: '/b', isDirectory: true, isFile: false, size: 0, modified: now }],
    ];
    await saveIndexFile({ indexPath, entries, lastIndexTime: now });
    const loaded = await loadIndexFile({ indexPath });
    expect(loaded.exists).toBe(true);
    expect(loaded.indexedFiles).toBe(2);
    expect(loaded.lastIndexTime).toBe(now);
  });

  it('detects and removes legacy index format', async () => {
    const indexPath = path.join(tmpDir, 'legacy.json');
    const legacy = { index: [{ path: '/old' }], lastIndexTime: Date.now() };
    await fs.promises.writeFile(indexPath, JSON.stringify(legacy));
    const result = await loadIndexFile({ indexPath });
    expect(result.exists).toBe(false);
    const fileExists = await fs.promises
      .access(indexPath)
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(false);
  });

  it('throws for non-ENOENT errors', async () => {
    const dirPath = path.join(tmpDir, 'isdir');
    await fs.promises.mkdir(dirPath);
    await expect(loadIndexFile({ indexPath: dirPath })).rejects.toThrow();
  });

  it('roundtrips through save and load', async () => {
    const indexPath = path.join(tmpDir, 'roundtrip.json');
    const now = Date.now();
    const entries: Array<
      [
        string,
        {
          name: string;
          path: string;
          isDirectory: boolean;
          isFile: boolean;
          size: number;
          modified: number;
        },
      ]
    > = [];
    for (let i = 0; i < 5; i++) {
      entries.push([
        `/file${i}.txt`,
        {
          name: `file${i}.txt`,
          path: `/file${i}.txt`,
          isDirectory: false,
          isFile: true,
          size: i * 100,
          modified: now,
        },
      ]);
    }
    await saveIndexFile({ indexPath, entries, lastIndexTime: now });
    const loaded = await loadIndexFile({ indexPath });
    expect(loaded.exists).toBe(true);
    expect(loaded.indexedFiles).toBe(5);
    expect(loaded.lastIndexTime).toBe(now);
  });
});
