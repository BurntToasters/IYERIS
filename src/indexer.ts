import { promises as fs } from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { IndexEntry, IndexStatus } from './types';

const execAsync = promisify(exec);

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
  private async getDrives(): Promise<string[]> {
    const platform = process.platform;

    if (platform === 'win32') {
      const drives: Set<string> = new Set();

      // WMIC
      try {
        const { stdout } = await execAsync('wmic logicaldisk get name', { timeout: 2000 });
        const lines = stdout.split(/[\r\n]+/);
        for (const line of lines) {
          const drive = line.trim();
          if (/^[A-Z]:$/.test(drive)) {
            drives.add(drive + '\\');
          }
        }
      } catch (e) {
      }

      // Method PS
      if (drives.size === 0) {
        try {
          const { stdout } = await execAsync('powershell -NoProfile -Command "Get-CimInstance -ClassName Win32_LogicalDisk | Select-Object -ExpandProperty DeviceID"', { timeout: 3000 });
          const lines = stdout.split(/[\r\n]+/);
          for (const line of lines) {
            const drive = line.trim();
            if (/^[A-Z]:$/.test(drive)) {
              drives.add(drive + '\\');
            }
          }
        } catch (e) {
        }
      }

      // if all else fails, go down the line from A-Z
      if (drives.size === 0) {
        const driveLetters: string[] = [];
        for (let i = 65; i <= 90; i++) {
          driveLetters.push(String.fromCharCode(i) + ':\\');
        }

        const checkDrive = async (drive: string): Promise<string | null> => {
          try {
            await Promise.race([
              fs.access(drive),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 200))
            ]);
            return drive;
          } catch {
            return null;
          }
        };

        const results = await Promise.all(driveLetters.map(checkDrive));
        results.forEach(d => {
          if (d) drives.add(d);
        });
      }

      if (drives.size === 0) return ['C:\\'];
      return Array.from(drives).sort();
    } else {
      // macOS and Linux
      const commonRoots = platform === 'darwin' ? ['/Volumes'] : ['/media', '/mnt', '/run/media'];
      const detected: string[] = ['/'];
      
      for (const root of commonRoots) {
        try {
          const subs = await fs.readdir(root);
          for (const sub of subs) {
            if (sub.startsWith('.')) continue;
            const fullPath = path.join(root, sub);
            try {
              const stats = await fs.stat(fullPath);
              if (stats.isDirectory()) {
                detected.push(fullPath);
              }
            } catch {}
          }
        } catch {}
      }
      return detected;
    }
  }

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
      const drives = await this.getDrives();
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
      const drives = await this.getDrives();
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
      const drives = await this.getDrives();
      for (const drive of drives) {
        if (drive !== '/' && !locations.includes(drive)) {
          locations.push(drive);
        }
      }
    }

    return locations;
  }
  private shouldExclude(filePath: string): boolean {
    const excludeSegments = new Set([
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
      'Library'
    ]);

    const excludeFiles = new Set([
      'pagefile.sys',
      'hiberfil.sys',
      'swapfile.sys',
      'DumpStack.log.tmp',
      '.DS_Store',
      'Thumbs.db'
    ]);

    const parts = filePath.split(/[/\\]/);
    const filename = parts[parts.length - 1];

    if (excludeFiles.has(filename)) return true;
    
    // Check if any segment matches exactly an excluded folder name
    // This prevents "Windows App" from being excluded because it contains "Windows"
    return parts.some(part => excludeSegments.has(part));
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
      const locations = await this.getCommonLocations();
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
