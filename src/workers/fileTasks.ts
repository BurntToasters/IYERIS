import { parentPort } from 'worker_threads';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as readline from 'readline';

type TaskType = 'build-index' | 'search-files' | 'search-content' | 'search-content-list' | 'folder-size' | 'checksum' | 'load-index' | 'save-index' | 'list-directory';

interface TaskRequest {
  id: string;
  type: TaskType;
  payload: any;
  operationId?: string;
}

const execFileAsync = promisify(execFile);
const cancelled = new Set<string>();

const TEXT_FILE_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'js', 'jsx', 'ts', 'tsx', 'json',
  'xml', 'html', 'htm', 'css', 'scss', 'less', 'py', 'rb',
  'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'swift',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'sh', 'bash',
  'ps1', 'bat', 'cmd', 'sql', 'log', 'csv', 'env', 'gitignore',
  'vue', 'svelte', 'php', 'pl', 'r', 'lua', 'kt', 'kts', 'scala'
]);

const CONTENT_SEARCH_MAX_FILE_SIZE = 1024 * 1024;
const CONTENT_CONTEXT_CHARS = 60;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isCancelled(operationId?: string): boolean {
  return Boolean(operationId && cancelled.has(operationId));
}

function sendProgress(task: TaskType, operationId: string, data: any): void {
  parentPort?.postMessage({ type: 'progress', task, operationId, data });
}

async function isHidden(filePath: string, fileName: string): Promise<boolean> {
  if (fileName.startsWith('.')) return true;
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execFileAsync('attrib', [filePath], { timeout: 500, windowsHide: true });
    return stdout.trim().charAt(0).toUpperCase() === 'H';
  } catch {
    return false;
  }
}

async function batchCheckHidden(dirPath: string, fileNames: string[]): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  for (const fileName of fileNames) {
    if (fileName.startsWith('.')) {
      results.set(fileName, true);
    }
  }

  if (process.platform !== 'win32') {
    return results;
  }

  const nonDotFiles = fileNames.filter(name => !name.startsWith('.'));
  if (nonDotFiles.length === 0) {
    return results;
  }

  try {
    const filePaths = nonDotFiles.map(fileName => path.join(dirPath, fileName));
    const escapedPaths = filePaths
      .map(filePath => `'${filePath.replace(/'/g, "''")}'`)
      .join(',');
    const psCommand = `$paths=@(${escapedPaths}); Get-Item -LiteralPath $paths -ErrorAction SilentlyContinue | ForEach-Object { $_.Name + \"\\t\" + $_.Attributes }`;

    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', psCommand], {
      timeout: 2000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });

    const lines = stdout.split(/\r?\n/).filter(line => line.trim().length > 0);
    for (const line of lines) {
      const [name, attrs] = line.split('\t');
      if (!name) continue;
      const isHiddenAttr = (attrs || '').toLowerCase().includes('hidden');
      results.set(name, isHiddenAttr);
    }

    for (const fileName of nonDotFiles) {
      if (!results.has(fileName)) {
        results.set(fileName, false);
      }
    }
  } catch {
    for (const fileName of nonDotFiles) {
      if (!results.has(fileName)) {
        const filePath = path.join(dirPath, fileName);
        results.set(fileName, await isHidden(filePath, fileName));
      }
    }
  }

  return results;
}

function matchesFilters(itemName: string, isDir: boolean, stats: { size: number; mtime: Date }, filters?: any): boolean {
  const fileTypeFilter = filters?.fileType?.toLowerCase();
  if (fileTypeFilter && fileTypeFilter !== 'all') {
    if (fileTypeFilter === 'folder') {
      if (!isDir) return false;
    } else {
      if (isDir) return false;
      const ext = path.extname(itemName).toLowerCase().slice(1);
      if (fileTypeFilter === 'image' && !['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext)) return false;
      if (fileTypeFilter === 'video' && !['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv'].includes(ext)) return false;
      if (fileTypeFilter === 'audio' && !['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'].includes(ext)) return false;
      if (fileTypeFilter === 'document' && !['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return false;
      if (fileTypeFilter === 'archive' && !['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return false;
    }
  }

  const minSize = filters?.minSize;
  const maxSize = filters?.maxSize;
  if (!isDir) {
    if (minSize !== undefined && stats.size < minSize) return false;
    if (maxSize !== undefined && stats.size > maxSize) return false;
  }

  const dateFrom = filters?.dateFrom ? new Date(filters.dateFrom) : null;
  const dateTo = filters?.dateTo ? new Date(filters.dateTo) : null;
  if (dateTo) dateTo.setHours(23, 59, 59, 999);

  if (dateFrom && stats.mtime < dateFrom) return false;
  if (dateTo && stats.mtime > dateTo) return false;

  return true;
}

function matchesContentFilters(stats: { size: number; mtime: Date }, filters?: any): boolean {
  const minSize = filters?.minSize;
  const maxSize = filters?.maxSize;
  if (minSize !== undefined && stats.size < minSize) return false;
  if (maxSize !== undefined && stats.size > maxSize) return false;

  const dateFrom = filters?.dateFrom ? new Date(filters.dateFrom) : null;
  const dateTo = filters?.dateTo ? new Date(filters.dateTo) : null;
  if (dateTo) dateTo.setHours(23, 59, 59, 999);

  if (dateFrom && stats.mtime < dateFrom) return false;
  if (dateTo && stats.mtime > dateTo) return false;

  return true;
}

async function searchFileContent(filePath: string, searchQuery: string, operationId?: string): Promise<{ found: boolean; context?: string; lineNumber?: number }> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!TEXT_FILE_EXTENSIONS.has(ext)) {
    return { found: false };
  }

  try {
    const stats = await fs.stat(filePath);
    if (stats.size > CONTENT_SEARCH_MAX_FILE_SIZE) {
      return { found: false };
    }

    const stream = fsSync.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;

    try {
      for await (const line of rl) {
        if (isCancelled(operationId)) {
          throw new Error('Calculation cancelled');
        }
        lineNumber++;
        const lowerLine = line.toLowerCase();
        const matchIndex = lowerLine.indexOf(searchQuery);
        if (matchIndex !== -1) {
          const start = Math.max(0, matchIndex - CONTENT_CONTEXT_CHARS);
          const end = Math.min(line.length, matchIndex + searchQuery.length + CONTENT_CONTEXT_CHARS);
          let context = line.substring(start, end).trim();
          if (start > 0) context = '...' + context;
          if (end < line.length) context = context + '...';
          return { found: true, context, lineNumber };
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Calculation cancelled') {
      throw error;
    }
    return { found: false };
  }

  return { found: false };
}

async function searchDirectoryFiles(payload: any, operationId?: string): Promise<any[]> {
  const { dirPath, query, filters, maxDepth, maxResults } = payload;
  const results: any[] = [];
  const searchQuery = String(query || '').toLowerCase();

  const stack: Array<{ dir: string; depth: number }> = [{ dir: dirPath, depth: 0 }];
  while (stack.length && results.length < maxResults) {
    const current = stack.pop();
    if (!current) break;
    if (current.depth >= maxDepth) continue;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');

    let items: fsSync.Dirent[];
    try {
      items = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const item of items) {
      if (results.length >= maxResults) break;
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');
      const fullPath = path.join(current.dir, item.name);
      const matches = item.name.toLowerCase().includes(searchQuery);

      if (matches) {
        try {
          const stats = await fs.stat(fullPath);
          const isDir = item.isDirectory();
          if (matchesFilters(item.name, isDir, stats, filters)) {
            results.push({
              name: item.name,
              path: fullPath,
              isDirectory: isDir,
              isFile: item.isFile(),
              size: stats.size,
              modified: stats.mtime,
              isHidden: await isHidden(fullPath, item.name)
            });
          }
        } catch {
        }
      }

      if (item.isDirectory()) {
        stack.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }

  return results;
}

async function searchDirectoryContent(payload: any, operationId?: string): Promise<any[]> {
  const { dirPath, query, filters, maxDepth, maxResults } = payload;
  const results: any[] = [];
  const searchQuery = String(query || '').toLowerCase();

  const stack: Array<{ dir: string; depth: number }> = [{ dir: dirPath, depth: 0 }];
  while (stack.length && results.length < maxResults) {
    const current = stack.pop();
    if (!current) break;
    if (current.depth >= maxDepth) continue;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');

    let items: fsSync.Dirent[];
    try {
      items = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const item of items) {
      if (results.length >= maxResults) break;
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');
      const fullPath = path.join(current.dir, item.name);

      if (item.isFile()) {
        try {
          const stats = await fs.stat(fullPath);
          if (!matchesContentFilters(stats, filters)) {
            continue;
          }
          const contentResult = await searchFileContent(fullPath, searchQuery, operationId);
          if (contentResult.found) {
            results.push({
              name: item.name,
              path: fullPath,
              isDirectory: false,
              isFile: true,
              size: stats.size,
              modified: stats.mtime,
              isHidden: await isHidden(fullPath, item.name),
              matchContext: contentResult.context,
              matchLineNumber: contentResult.lineNumber
            });
          }
        } catch {
        }
      }

      if (item.isDirectory()) {
        stack.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }

  return results;
}

async function searchContentList(payload: any, operationId?: string): Promise<any[]> {
  const { files, query, maxResults, filters } = payload;
  const results: any[] = [];
  const searchQuery = String(query || '').toLowerCase();

  for (const item of files || []) {
    if (results.length >= maxResults) break;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');

    const filePath = item.path;
    const fileName = item.name || path.basename(filePath);
    const ext = path.extname(fileName).slice(1).toLowerCase();
    if (!TEXT_FILE_EXTENSIONS.has(ext)) continue;

    if (filters?.minSize !== undefined && item.size < filters.minSize) continue;
    if (filters?.maxSize !== undefined && item.size > filters.maxSize) continue;
    const modified = item.modified instanceof Date ? item.modified : new Date(item.modified);
    const dateFrom = filters?.dateFrom ? new Date(filters.dateFrom) : null;
    const dateTo = filters?.dateTo ? new Date(filters.dateTo) : null;
    if (dateTo) dateTo.setHours(23, 59, 59, 999);
    if (dateFrom && modified < dateFrom) continue;
    if (dateTo && modified > dateTo) continue;

    const contentResult = await searchFileContent(filePath, searchQuery, operationId);
    if (contentResult.found) {
      results.push({
        name: fileName,
        path: filePath,
        isDirectory: false,
        isFile: true,
        size: item.size,
        modified,
        isHidden: await isHidden(filePath, fileName),
        matchContext: contentResult.context,
        matchLineNumber: contentResult.lineNumber
      });
    }
  }

  return results;
}

async function calculateFolderSize(payload: any, operationId?: string): Promise<any> {
  const { folderPath } = payload;
  let totalSize = 0;
  let fileCount = 0;
  let folderCount = 0;
  let lastProgressUpdate = Date.now();
  const fileTypeMap = new Map<string, { count: number; size: number }>();

  const stack: string[] = [folderPath];
  while (stack.length) {
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');
    const currentPath = stack.pop();
    if (!currentPath) continue;

    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');
      const fullPath = path.join(currentPath, entry.name);
      try {
        if (entry.isDirectory()) {
          folderCount++;
          stack.push(fullPath);
        } else if (entry.isFile()) {
          const stats = await fs.stat(fullPath);
          totalSize += stats.size;
          fileCount++;
          const ext = path.extname(entry.name).toLowerCase() || '(no extension)';
          const existing = fileTypeMap.get(ext) || { count: 0, size: 0 };
          fileTypeMap.set(ext, { count: existing.count + 1, size: existing.size + stats.size });
        }

        const now = Date.now();
        if (operationId && now - lastProgressUpdate > 100) {
          lastProgressUpdate = now;
          sendProgress('folder-size', operationId, {
            calculatedSize: totalSize,
            fileCount,
            folderCount,
            currentPath: fullPath
          });
        }
      } catch {
      }
    }
  }

  const fileTypes = Array.from(fileTypeMap.entries())
    .map(([extension, data]) => ({ extension, count: data.count, size: data.size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 10);

  return { totalSize, fileCount, folderCount, fileTypes };
}

async function calculateChecksum(payload: any, operationId?: string): Promise<any> {
  const { filePath, algorithms } = payload;
  const stats = await fs.stat(filePath);
  const fileSize = stats.size;

  const rawAlgorithms = Array.isArray(algorithms) ? algorithms : [];
  const uniqueAlgorithms = Array.from(new Set(rawAlgorithms.map((algo) => String(algo)).filter(Boolean)));
  const hashes = new Map<string, ReturnType<typeof createHash>>();
  for (const algorithm of uniqueAlgorithms) {
    hashes.set(algorithm, createHash(algorithm));
  }

  let bytesRead = 0;
  let lastProgressUpdate = Date.now();

  await new Promise<void>((resolve, reject) => {
    const stream = fsSync.createReadStream(filePath);

    stream.on('data', (chunk: Buffer) => {
      if (isCancelled(operationId)) {
        stream.destroy();
        reject(new Error('Calculation cancelled'));
        return;
      }
      for (const hash of hashes.values()) {
        hash.update(chunk);
      }
      bytesRead += chunk.length;
      const now = Date.now();
      if (operationId && now - lastProgressUpdate > 100) {
        lastProgressUpdate = now;
        const percent = fileSize > 0 ? (bytesRead / fileSize) * 100 : 0;
        const label = uniqueAlgorithms.length > 1 ? uniqueAlgorithms.join('+') : (uniqueAlgorithms[0] || '');
        sendProgress('checksum', operationId, { percent, algorithm: label });
      }
    });

    stream.on('end', () => resolve());
    stream.on('error', reject);
  });

  const result: { md5?: string; sha256?: string } = {};
  for (const [algorithm, hash] of hashes) {
    const digest = hash.digest('hex');
    if (algorithm === 'md5') result.md5 = digest;
    if (algorithm === 'sha256') result.sha256 = digest;
  }
  return result;
}

async function buildIndex(payload: any, operationId?: string): Promise<any> {
  const locations: string[] = payload.locations || [];
  const maxIndexSize: number = payload.maxIndexSize || 200000;

  const excludeSegments = new Set([
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
    'amd'
  ]);

  const excludeFiles = new Set([
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
    'ntuser.dat.log2'
  ]);

  const shouldExclude = (filePath: string): boolean => {
    const parts = filePath.split(/[/\\]/);
    const filename = parts[parts.length - 1].toLowerCase();
    if (excludeFiles.has(filename)) return true;
    return parts.some(part => excludeSegments.has(part.toLowerCase()));
  };

  const entries: any[] = [];
  const stack: string[] = [...locations];

  while (stack.length && entries.length < maxIndexSize) {
    const currentPath = stack.pop();
    if (!currentPath) continue;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');
    if (shouldExclude(currentPath)) continue;

    let dirEntries: fsSync.Dirent[];
    try {
      dirEntries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of dirEntries) {
      if (entries.length >= maxIndexSize) break;
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');
      const fullPath = path.join(currentPath, entry.name);
      if (shouldExclude(fullPath)) continue;

      try {
        const stats = await fs.stat(fullPath);
        entries.push({
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          size: stats.size,
          modified: stats.mtime
        });

        if (entry.isDirectory() && entries.length < maxIndexSize) {
          stack.push(fullPath);
        }
      } catch {
      }
    }
  }

  return { entries };
}

async function loadIndexFile(payload: any): Promise<any> {
  const { indexPath } = payload;
  try {
    const data = await fs.readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(data);
    return {
      exists: true,
      index: parsed.index || [],
      lastIndexTime: parsed.lastIndexTime || null
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err && err.code === 'ENOENT') {
      return { exists: false };
    }
    throw error;
  }
}

async function saveIndexFile(payload: any): Promise<any> {
  const { indexPath, entries, lastIndexTime } = payload;
  const data = {
    index: entries || [],
    lastIndexTime: lastIndexTime || null,
    version: 1
  };
  await fs.writeFile(indexPath, JSON.stringify(data), 'utf-8');
  return { success: true };
}

async function listDirectory(payload: any, operationId?: string): Promise<any> {
  const { dirPath, batchSize = 100 } = payload;
  const results: any[] = [];
  const batch: fsSync.Dirent[] = [];
  let loaded = 0;
  let dir: fsSync.Dir | null = null;

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');

    const names = batch.map(entry => entry.name);
    const hiddenMap = await batchCheckHidden(dirPath, names);
    const items = await Promise.all(
      batch.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        const isHiddenFlag = hiddenMap.get(entry.name) || entry.name.startsWith('.');
        try {
          const stats = await fs.stat(fullPath);
          return {
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
            size: stats.size,
            modified: stats.mtime,
            isHidden: isHiddenFlag
          };
        } catch {
          return {
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
            size: 0,
            modified: new Date(),
            isHidden: isHiddenFlag
          };
        }
      })
    );

    results.push(...items);
    loaded += items.length;
    if (operationId) {
      sendProgress('list-directory', operationId, { dirPath, loaded });
    }
    batch.length = 0;
  };

  try {
    dir = await fs.opendir(dirPath);
    for await (const entry of dir) {
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');
      batch.push(entry);
      if (batch.length >= batchSize) {
        await flushBatch();
      }
    }
    await flushBatch();
  } finally {
    try {
      await dir?.close();
    } catch {
    }
  }

  return { contents: results };
}

async function handleTask(message: TaskRequest): Promise<any> {
  switch (message.type) {
    case 'search-files':
      return await searchDirectoryFiles(message.payload, message.operationId);
    case 'search-content':
      return await searchDirectoryContent(message.payload, message.operationId);
    case 'search-content-list':
      return await searchContentList(message.payload, message.operationId);
    case 'folder-size':
      return await calculateFolderSize(message.payload, message.operationId);
    case 'checksum':
      return await calculateChecksum(message.payload, message.operationId);
    case 'build-index':
      return await buildIndex(message.payload, message.operationId);
    case 'load-index':
      return await loadIndexFile(message.payload);
    case 'save-index':
      return await saveIndexFile(message.payload);
    case 'list-directory':
      return await listDirectory(message.payload, message.operationId);
    default:
      throw new Error('Unknown task');
  }
}

if (!parentPort) {
  process.exit(1);
}

parentPort.on('message', async (message: any) => {
  if (message?.type === 'cancel' && message.operationId) {
    cancelled.add(message.operationId);
    return;
  }

  const task = message as TaskRequest;
  try {
    const data = await handleTask(task);
    parentPort?.postMessage({ type: 'result', id: task.id, success: true, data });
  } catch (error) {
    parentPort?.postMessage({ type: 'result', id: task.id, success: false, error: getErrorMessage(error) });
  } finally {
    if (task.operationId) {
      cancelled.delete(task.operationId);
    }
  }
});
