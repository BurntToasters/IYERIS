import { promises as fs } from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { IndexEntry, IndexStatus } from './types';
import type { FileTaskManager } from './fileTasks';
import { getDrives } from './utils';
import { ignoreError } from './shared';

const execAsync = promisify(exec);
type IndexEntryPayload = Partial<Omit<IndexEntry, 'modified'>> & {
  modified?: Date | number | string;
};

const EXCLUDE_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.cache',
  'cache',
  'caches',
  '.trash',
  'trash',
  '$recycle.bin',
  'system volume information',
  '.npm',
  '.docker',
  'appdata',
  'programdata',
  'windows',
  'program files',
  'program files (x86)',
  '$windows.~bt',
  '$windows.~ws',
  'recovery',
  'perflogs',
  'library',
  '$winreagent',
  'config.msi',
  'msocache',
  'intel',
  'nvidia',
  'amd',
]);

const EXCLUDE_FILES = new Set([
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  'dumpstack.log.tmp',
  'dumpstack.log',
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  'ntuser.dat',
  'ntuser.dat.log',
  'ntuser.dat.log1',
  'ntuser.dat.log2',
]);

async function writeFileAtomic(targetPath: string, data: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(
    dir,
    `${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  await fs.writeFile(tmpPath, data, 'utf-8');

  try {
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES') {
      try {
        await fs.unlink(targetPath);
      } catch (error) {
        ignoreError(error);
      }
      try {
        await fs.rename(tmpPath, targetPath);
        return;
      } catch (error) {
        ignoreError(error);
      }
    }
    try {
      await fs.copyFile(tmpPath, targetPath);
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }
}

export class FileIndexer {
  private index: Map<string, IndexEntry> = new Map();
  private isIndexing: boolean = false;
  private indexedFiles: number = 0;
  private totalFiles: number = 0;
  private lastIndexTime: Date | null = null;
  private indexPath: string;
  private enabled: boolean = true;
  private abortController: AbortController | null = null;
  private initializationPromise: Promise<void> | null = null;
  private fileTasks: FileTaskManager | null = null;
  private buildOperationId: string | null = null;

  // prevent unbounded mem growth
  private static readonly MAX_INDEX_SIZE = 200000;

  constructor(fileTasks?: FileTaskManager) {
    const userDataPath = app.getPath('userData');
    this.indexPath = path.join(userDataPath, 'file-index.json');
    this.fileTasks = fileTasks ?? null;
  }

  // platform-specific important dirs
  private async getCommonLocations(): Promise<string[]> {
    const platform = process.platform;
    const homeDir = app.getPath('home');
    const locations: string[] = [];

    if (platform === 'win32') {
      locations.push(
        path.join(homeDir, 'Desktop'),
        path.join(homeDir, 'Documents'),
        path.join(homeDir, 'Downloads'),
        path.join(homeDir, 'Pictures'),
        path.join(homeDir, 'Music'),
        path.join(homeDir, 'Videos')
      );
      const drives = await getDrives();
      locations.push(...drives);
    } else if (platform === 'darwin') {
      locations.push(
        path.join(homeDir, 'Desktop'),
        path.join(homeDir, 'Documents'),
        path.join(homeDir, 'Downloads'),
        path.join(homeDir, 'Pictures'),
        path.join(homeDir, 'Music'),
        path.join(homeDir, 'Movies'),
        '/Applications',
        '/Users'
      );
      const drives = await getDrives();
      for (const drive of drives) {
        if (drive !== '/' && !locations.includes(drive)) {
          locations.push(drive);
        }
      }
    } else {
      locations.push(
        path.join(homeDir, 'Desktop'),
        path.join(homeDir, 'Documents'),
        path.join(homeDir, 'Downloads'),
        path.join(homeDir, 'Pictures'),
        path.join(homeDir, 'Music'),
        path.join(homeDir, 'Videos'),
        '/usr',
        '/opt',
        '/home'
      );
      const drives = await getDrives();
      for (const drive of drives) {
        if (drive !== '/' && !locations.includes(drive)) {
          locations.push(drive);
        }
      }
    }

    return locations;
  }
  private shouldExclude(filePath: string): boolean {
    const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const filename = (lastSep >= 0 ? filePath.slice(lastSep + 1) : filePath).toLowerCase();

    if (EXCLUDE_FILES.has(filename)) return true;

    const lowerPath = filePath.toLowerCase();
    for (const segment of EXCLUDE_SEGMENTS) {
      const idx = lowerPath.indexOf(segment);
      if (idx === -1) continue;
      const before = idx === 0 || lowerPath[idx - 1] === '/' || lowerPath[idx - 1] === '\\';
      const after =
        idx + segment.length === lowerPath.length ||
        lowerPath[idx + segment.length] === '/' ||
        lowerPath[idx + segment.length] === '\\';
      if (before && after) return true;
    }
    return false;
  }

  // recursive scan with batching
  private async scanDirectory(dirPath: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.shouldExclude(dirPath)) {
      return;
    }

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      const BATCH_SIZE = 50;
      const subdirs: string[] = [];

      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        if (signal?.aborted || this.index.size >= FileIndexer.MAX_INDEX_SIZE) {
          return;
        }

        const batch = entries.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (entry) => {
            const fullPath = path.join(dirPath, entry.name);

            if (this.shouldExclude(fullPath)) {
              return null;
            }

            const stats = await fs.stat(fullPath);
            return {
              entry,
              fullPath,
              stats,
              isDirectory: entry.isDirectory(),
            };
          })
        );

        for (const result of results) {
          if (signal?.aborted || this.index.size >= FileIndexer.MAX_INDEX_SIZE) {
            return;
          }

          if (result.status === 'fulfilled' && result.value) {
            const { entry, fullPath, stats, isDirectory } = result.value;

            const indexEntry: IndexEntry = {
              name: entry.name,
              path: fullPath,
              isDirectory,
              isFile: entry.isFile(),
              size: stats.size,
              modified: stats.mtime,
            };

            this.index.set(fullPath, indexEntry);
            this.indexedFiles++;

            if (isDirectory && this.index.size < FileIndexer.MAX_INDEX_SIZE) {
              subdirs.push(fullPath);
            }
          }
        }
      }

      for (const subdir of subdirs) {
        if (signal?.aborted || this.index.size >= FileIndexer.MAX_INDEX_SIZE) {
          return;
        }
        await this.scanDirectory(subdir, signal);
      }
    } catch (error) {
      console.log(`[Indexer] Cannot access ${dirPath}:`, (error as Error).message);
    }
  }
  private async estimateTotalFiles(locations: string[]): Promise<number> {
    let estimate = 0;
    for (const location of locations) {
      try {
        await fs.access(location);
        estimate += 1000;
      } catch (error) {
        ignoreError(error);
      }
    }
    return estimate;
  }

  private normalizeIndexEntry(entryPath: string, entry: IndexEntryPayload): IndexEntry | null {
    if (!entryPath || typeof entryPath !== 'string') {
      return null;
    }
    const name = typeof entry.name === 'string' ? entry.name : path.basename(entryPath);
    const isDirectory = typeof entry.isDirectory === 'boolean' ? entry.isDirectory : false;
    const isFile = typeof entry.isFile === 'boolean' ? entry.isFile : !isDirectory;
    const size = typeof entry.size === 'number' ? entry.size : 0;
    const modifiedValue = entry.modified ?? 0;
    let modified =
      modifiedValue instanceof Date ? modifiedValue : new Date(modifiedValue as string | number);
    if (Number.isNaN(modified.getTime())) {
      modified = new Date(0);
    }

    return {
      name,
      path: entryPath,
      isDirectory,
      isFile,
      size,
      modified,
    };
  }

  private parseIndexTime(value: unknown): Date | null {
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isNaN(time) ? null : value;
    }
    if (typeof value !== 'number' && typeof value !== 'string') {
      return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private loadIndexEntries(entries: unknown[]): void {
    this.index.clear();
    for (const entry of entries) {
      let entryPath: string | null = null;
      let item: IndexEntryPayload | null = null;

      if (Array.isArray(entry)) {
        entryPath = typeof entry[0] === 'string' ? entry[0] : null;
        item = (entry[1] as IndexEntryPayload) || null;
      } else if (entry && typeof entry === 'object') {
        const obj = entry as IndexEntryPayload & { path?: string };
        entryPath = typeof obj.path === 'string' ? obj.path : null;
        item = obj;
      }

      if (!entryPath || !item) {
        continue;
      }

      const normalized = this.normalizeIndexEntry(entryPath, item);
      if (normalized) {
        this.index.set(entryPath, normalized);
      }
    }

    this.indexedFiles = this.index.size;
  }
  async buildIndex(): Promise<void> {
    if (this.isIndexing) {
      console.log('[Indexer] Already indexing, skipping...');
      return;
    }

    if (!this.enabled) {
      console.log('[Indexer] Indexer is disabled, skipping...');
      return;
    }

    this.isIndexing = true;
    this.indexedFiles = 0;
    this.index.clear();
    this.abortController = new AbortController();

    console.log('[Indexer] Starting index build...');

    try {
      const locations = await this.getCommonLocations();
      console.log(`[Indexer] Locations to scan: ${locations.join(', ')}`);
      this.totalFiles = await this.estimateTotalFiles(locations);

      if (this.fileTasks) {
        this.buildOperationId = `index-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const result = await this.fileTasks.runTask<{
          entries: Array<[string, IndexEntryPayload]>;
        }>(
          'build-index',
          {
            locations,
            skipDirs: Array.from(EXCLUDE_SEGMENTS),
            maxIndexSize: FileIndexer.MAX_INDEX_SIZE,
          },
          this.buildOperationId
        );
        const entries = Array.isArray(result.entries) ? result.entries : [];
        for (const [entryPath, entry] of entries) {
          if (this.index.size >= FileIndexer.MAX_INDEX_SIZE) break;
          const normalized = this.normalizeIndexEntry(entryPath, entry);
          if (normalized) {
            this.index.set(entryPath, normalized);
          }
        }
        this.indexedFiles = this.index.size;
        console.log(`[Indexer] Worker scan complete. Indexed ${this.indexedFiles} files.`);
      } else {
        for (const location of locations) {
          if (this.abortController.signal.aborted) {
            break;
          }

          const beforeCount = this.indexedFiles;
          try {
            await fs.access(location);
            console.log(`[Indexer] Scanning: ${location}`);
            await this.scanDirectory(location, this.abortController.signal);
            console.log(
              `[Indexer] Finished ${location}: indexed ${this.indexedFiles - beforeCount} new files (total: ${this.indexedFiles})`
            );
          } catch (error) {
            console.log(`[Indexer] Skipping ${location}:`, (error as Error).message);
          }
        }
      }

      this.lastIndexTime = new Date();
      await this.saveIndex();
      console.log(`[Indexer] Index build complete. Indexed ${this.indexedFiles} files.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'Cancelled' || message === 'Calculation cancelled') {
        this.index.clear();
        this.indexedFiles = 0;
        console.log('[Indexer] Index build cancelled');
      } else {
        console.error('[Indexer] Error building index:', error);
      }
    } finally {
      this.isIndexing = false;
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
      this.buildOperationId = null;
    }
  }

  async search(query: string): Promise<IndexEntry[]> {
    if (!this.enabled) {
      return [];
    }

    if (this.initializationPromise) {
      await this.initializationPromise;
    }

    if (this.index.size === 0 && !this.isIndexing) {
      await this.loadIndex();
    }

    const lowerQuery = query.toLowerCase();
    const results: IndexEntry[] = [];

    for (const entry of this.index.values()) {
      if (entry.name.toLowerCase().includes(lowerQuery)) {
        results.push(entry);
        if (results.length >= 100) {
          break;
        }
      }
    }
    results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === lowerQuery;
      const bExact = b.name.toLowerCase() === lowerQuery;

      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;

      return a.name.localeCompare(b.name);
    });

    return results;
  }

  async getEntries(): Promise<IndexEntry[]> {
    if (!this.enabled) {
      return [];
    }

    if (this.initializationPromise) {
      await this.initializationPromise;
    }

    if (this.index.size === 0 && !this.isIndexing) {
      await this.loadIndex();
    }

    return Array.from(this.index.values());
  }

  async saveIndex(): Promise<void> {
    try {
      const entries = Array.from(this.index.entries());
      const lastIndexTime = this.lastIndexTime ? this.lastIndexTime.getTime() : null;
      if (this.fileTasks) {
        await this.fileTasks.runTask(
          'save-index',
          { indexPath: this.indexPath, entries, lastIndexTime },
          `save-index-${Date.now()}`
        );
      } else {
        const data = {
          index: entries,
          lastIndexTime,
          version: 1,
        };

        await writeFileAtomic(this.indexPath, JSON.stringify(data));
      }
      console.log(`[Indexer] Index saved to ${this.indexPath}`);
    } catch (error) {
      console.error('[Indexer] Error saving index:', error);
    }
  }

  async loadIndex(): Promise<void> {
    try {
      if (this.fileTasks) {
        const result = await this.fileTasks.runTask<{
          exists: boolean;
          index?: Array<unknown>;
          lastIndexTime?: string | number | null;
        }>('load-index', { indexPath: this.indexPath }, `load-index-${Date.now()}`);
        if (!result.exists) {
          console.log('[Indexer] No existing index found, will build on first search');
          return;
        }
        this.loadIndexEntries(result.index || []);
        this.lastIndexTime = this.parseIndexTime(result.lastIndexTime);
      } else {
        const data = await fs.readFile(this.indexPath, 'utf-8');
        const parsed = JSON.parse(data);

        this.loadIndexEntries(Array.isArray(parsed.index) ? parsed.index : []);
        this.lastIndexTime = this.parseIndexTime(parsed.lastIndexTime);
      }
      console.log(`[Indexer] Index loaded: ${this.indexedFiles} files`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('[Indexer] No existing index found, will build on first search');
      } else {
        console.error('[Indexer] Error loading index:', error);
      }
    }
  }

  async clearIndex(): Promise<void> {
    this.index.clear();
    this.indexedFiles = 0;
    this.lastIndexTime = null;

    try {
      await fs.unlink(this.indexPath);
      console.log('[Indexer] Index file deleted');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[Indexer] Error deleting index:', error);
      }
    }
  }

  async rebuildIndex(): Promise<void> {
    console.log('[Indexer] Rebuilding index...');

    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.fileTasks && this.buildOperationId) {
      this.fileTasks.cancelOperation(this.buildOperationId);
      this.buildOperationId = null;
    }

    await this.clearIndex();
    await this.buildIndex();
  }

  getStatus(): IndexStatus {
    return {
      isIndexing: this.isIndexing,
      totalFiles: this.totalFiles,
      indexedFiles: this.indexedFiles,
      lastIndexTime: this.lastIndexTime,
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    console.log(`[Indexer] Indexer ${enabled ? 'enabled' : 'disabled'}`);

    if (!enabled && this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (!enabled && this.fileTasks && this.buildOperationId) {
      this.fileTasks.cancelOperation(this.buildOperationId);
      this.buildOperationId = null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async initialize(enabled: boolean): Promise<void> {
    this.enabled = enabled;

    if (!enabled) {
      console.log('[Indexer] Indexer disabled, skipping initialization');
      return;
    }

    console.log('[Indexer] Initializing...');

    this.initializationPromise = (async () => {
      try {
        await this.loadIndex();

        if (this.index.size === 0) {
          console.log('[Indexer] No existing index found, building now...');
          await this.buildIndex();
        } else if (
          !this.lastIndexTime ||
          Date.now() - this.lastIndexTime.getTime() > 7 * 24 * 60 * 60 * 1000
        ) {
          console.log('[Indexer] Index is outdated, rebuilding...');
          await this.buildIndex();
        } else {
          console.log('[Indexer] Using existing index with', this.index.size, 'files');
        }
      } catch (err) {
        console.error('[Indexer] Initialization failed:', err);
      } finally {
        this.initializationPromise = null;
      }
    })();
  }
}
