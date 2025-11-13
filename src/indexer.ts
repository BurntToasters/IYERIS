import { promises as fs } from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { IndexEntry, IndexStatus } from './types';

export class FileIndexer {
  private index: Map<string, IndexEntry> = new Map();
  private isIndexing: boolean = false;
  private indexedFiles: number = 0;
  private totalFiles: number = 0;
  private lastIndexTime: Date | null = null;
  private indexPath: string;
  private enabled: boolean = true;
  private abortController: AbortController | null = null;

  constructor() {
    const userDataPath = app.getPath('userData');
    this.indexPath = path.join(userDataPath, 'file-index.json');
  }
  private getCommonLocations(): string[] {
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
      const drives = ['C:', 'D:', 'E:']; // I will probably change this later and make it dynamic its not the best way to do this by any means
      for (const drive of drives) {
        try {
          locations.push(drive + '\\');
        } catch {
        }
      }
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
    }

    return locations;
  }
  private shouldExclude(filePath: string): boolean {
    const excludePatterns = [
      'node_modules',
      '.git',
      '.cache',
      'Cache',
      'Caches',
      '.Trash',
      'Trash',
      '$RECYCLE.BIN',
      'System Volume Information',
      '.npm',
      '.docker',
      'AppData',
      'ProgramData',
      'Windows',
      'Program Files',
      'Program Files (x86)',
      '$Windows.~BT',
      '$Windows.~WS',
      'Recovery',
      'PerfLogs',
      'pagefile.sys',
      'hiberfil.sys',
      'swapfile.sys',
      'DumpStack.log.tmp',
      'AppData\\Local\\Temp',
      'Library/Caches',
      'Library/Logs',
      '/System',
      '/private',
      '/dev',
      '/proc',
      '/sys',
      '/tmp',
      '/var/tmp'
    ];

    const lowerPath = filePath.toLowerCase();
    return excludePatterns.some(pattern => 
      lowerPath.includes(pattern.toLowerCase())
    );
  }

  private async scanDirectory(dirPath: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.shouldExclude(dirPath)) {
      return;
    }

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (signal?.aborted) {
          return;
        }

        const fullPath = path.join(dirPath, entry.name);

        if (this.shouldExclude(fullPath)) {
          continue;
        }

        try {
          const stats = await fs.stat(fullPath);
          
          const indexEntry: IndexEntry = {
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
            size: stats.size,
            modified: stats.mtime
          };

          this.index.set(fullPath, indexEntry);
          this.indexedFiles++;

          if (entry.isDirectory() && this.index.size < 100000) { 
            await this.scanDirectory(fullPath, signal);
          }
        } catch (error) {
          console.log(`[Indexer] Skipping ${fullPath}:`, (error as Error).message);
        }
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
      } catch {
      }
    }
    return estimate;
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
      const locations = this.getCommonLocations();
      this.totalFiles = await this.estimateTotalFiles(locations);

      for (const location of locations) {
        if (this.abortController.signal.aborted) {
          break;
        }

        try {
          await fs.access(location);
          console.log(`[Indexer] Scanning: ${location}`);
          await this.scanDirectory(location, this.abortController.signal);
        } catch (error) {
          console.log(`[Indexer] Skipping ${location}:`, (error as Error).message);
        }
      }

      this.lastIndexTime = new Date();
      await this.saveIndex();
      console.log(`[Indexer] Index build complete. Indexed ${this.indexedFiles} files.`);
    } catch (error) {
      console.error('[Indexer] Error building index:', error);
    } finally {
      this.isIndexing = false;
      this.abortController = null;
    }
  }

  async search(query: string): Promise<IndexEntry[]> {
    if (!this.enabled) {
      return [];
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

  async saveIndex(): Promise<void> {
    try {
      const data = {
        index: Array.from(this.index.entries()),
        lastIndexTime: this.lastIndexTime,
        version: 1
      };

      await fs.writeFile(this.indexPath, JSON.stringify(data), 'utf-8');
      console.log(`[Indexer] Index saved to ${this.indexPath}`);
    } catch (error) {
      console.error('[Indexer] Error saving index:', error);
    }
  }

  async loadIndex(): Promise<void> {
    try {
      const data = await fs.readFile(this.indexPath, 'utf-8');
      const parsed = JSON.parse(data);

      this.index = new Map(parsed.index);
      this.lastIndexTime = parsed.lastIndexTime ? new Date(parsed.lastIndexTime) : null;
      this.indexedFiles = this.index.size;

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
    
    await this.clearIndex();
    await this.buildIndex();
  }

  getStatus(): IndexStatus {
    return {
      isIndexing: this.isIndexing,
      totalFiles: this.totalFiles,
      indexedFiles: this.indexedFiles,
      lastIndexTime: this.lastIndexTime
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    console.log(`[Indexer] Indexer ${enabled ? 'enabled' : 'disabled'}`);
    
    if (!enabled && this.abortController) {
      this.abortController.abort();
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

    setImmediate(async () => {
      try {
        await this.loadIndex();

        if (this.index.size === 0) {
          console.log('[Indexer] No existing index found, building now...');
          await this.buildIndex();
        } 
        else if (!this.lastIndexTime || 
                 (Date.now() - this.lastIndexTime.getTime() > 7 * 24 * 60 * 60 * 1000)) {
          console.log('[Indexer] Index is outdated, rebuilding...');
          await this.buildIndex();
        } else {
          console.log('[Indexer] Using existing index with', this.index.size, 'files');
        }
      } catch (err) {
        console.error('[Indexer] Initialization failed:', err);
      }
    });
  }
}
