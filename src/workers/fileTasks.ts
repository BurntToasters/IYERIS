import { parentPort } from 'worker_threads';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as readline from 'readline';
import { ignoreError } from '../shared';

interface SearchFilters {
  fileType?: string;
  minSize?: number;
  maxSize?: number;
  dateFrom?: string;
  dateTo?: string;
}

interface SearchPayload {
  dirPath: string;
  query: string;
  filters?: SearchFilters;
  maxDepth: number;
  maxResults: number;
}

interface ContentSearchPayload {
  dirPath: string;
  query: string;
  filters?: SearchFilters;
  maxDepth: number;
  maxResults: number;
}

interface ContentListSearchPayload {
  files: Array<{ path: string; size: number; name?: string; modified?: number | string | Date }>;
  query: string;
  filters?: SearchFilters;
  maxResults: number;
}

interface ContentIndexSearchPayload extends IndexSearchPayload {
  maxResults: number;
  filters?: SearchFilters;
}

interface IndexSearchPayload {
  indexPath: string;
  query: string;
  maxResults?: number;
}

interface FolderSizePayload {
  folderPath: string;
}

interface ChecksumPayload {
  filePath: string;
  algorithms: string[];
}

interface BuildIndexPayload {
  locations: string[];
  skipDirs: string[];
  maxIndexSize?: number;
}

type IndexEntry = [
  string,
  {
    name: string;
    path: string;
    isDirectory: boolean;
    isFile: boolean;
    size: number;
    modified: number;
  },
];

interface LoadIndexPayload {
  indexPath: string;
}

interface SaveIndexPayload {
  indexPath: string;
  entries: IndexEntry[] | Array<[string, IndexEntryPayload]>;
  lastIndexTime?: unknown;
}

interface ListDirectoryPayload {
  dirPath: string;
  batchSize?: number;
  streamOnly?: boolean;
  includeHidden?: boolean;
}

interface SearchResult {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modified: Date;
  isHidden: boolean;
}

interface IndexSearchResult {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modified: Date;
}

interface ContentSearchResult extends SearchResult {
  matchContext?: string;
  matchLineNumber?: number;
}

interface IndexFileData {
  index?: unknown;
  lastIndexTime?: unknown;
  version?: number;
}

type IndexEntryPayload = {
  name?: string;
  path?: string;
  isDirectory?: boolean;
  isFile?: boolean;
  size?: number | string;
  modified?: number | string | Date;
};

interface ProgressData {
  operationId?: string;
  current?: number;
  total?: number;
  name?: string;
  percent?: number;
  algorithm?: string;
  size?: number;
  files?: number;
  dirs?: number;
  scannedFiles?: number;
  totalFiles?: number;
  currentFile?: string;
  [key: string]: unknown;
}

type TaskType =
  | 'build-index'
  | 'search-files'
  | 'search-content'
  | 'search-content-list'
  | 'search-content-index'
  | 'search-index'
  | 'folder-size'
  | 'checksum'
  | 'load-index'
  | 'save-index'
  | 'list-directory';

const TASK_TYPE_SET = new Set<TaskType>([
  'build-index',
  'search-files',
  'search-content',
  'search-content-list',
  'search-content-index',
  'search-index',
  'folder-size',
  'checksum',
  'load-index',
  'save-index',
  'list-directory',
]);

interface TaskRequest {
  id: string;
  type: TaskType;
  payload: unknown;
  operationId?: string;
}

const execFileAsync = promisify(execFile);
const cancelled = new Map<string, number>();
const CANCEL_TTL_MS = 10 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTaskRequest(value: unknown): value is TaskRequest {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    TASK_TYPE_SET.has(value.type as TaskType) &&
    Object.prototype.hasOwnProperty.call(value, 'payload')
  );
}

function pruneCancelled(): void {
  const now = Date.now();
  for (const [id, timestamp] of cancelled) {
    if (now - timestamp > CANCEL_TTL_MS) {
      cancelled.delete(id);
    }
  }
}

const TEXT_FILE_EXTENSIONS = new Set([
  'txt',
  'text',
  'md',
  'markdown',
  'log',
  'readme',
  'js',
  'jsx',
  'ts',
  'tsx',
  'json',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'py',
  'pyc',
  'pyw',
  'rb',
  'java',
  'c',
  'cpp',
  'cc',
  'cxx',
  'h',
  'hpp',
  'cs',
  'go',
  'rs',
  'swift',
  'kt',
  'kts',
  'scala',
  'r',
  'lua',
  'perl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'config',
  'conf',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'sql',
  'csv',
  'tsv',
  'env',
  'properties',
  'gitignore',
  'gitattributes',
  'editorconfig',
  'dockerfile',
  'dockerignore',
  'rst',
  'tex',
  'adoc',
  'asciidoc',
  'makefile',
  'cmake',
  'gradle',
  'maven',
  'vue',
  'svelte',
  'php',
  'pl',
]);

const CONTENT_SEARCH_MAX_FILE_SIZE = 1024 * 1024;
const CONTENT_CONTEXT_CHARS = 60;
const HIDDEN_ATTR_CACHE_TTL_MS = 5 * 60 * 1000;
const HIDDEN_ATTR_CACHE_MAX = 5000;

const hiddenAttrCache = new Map<string, { isHidden: boolean; timestamp: number }>();
let cachedIndexPath: string | null = null;
let cachedIndexMtimeMs: number | null = null;
let cachedIndexData: IndexFileData | null = null;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeIndexTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function normalizePathForCompare(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isCancelled(operationId?: string): boolean {
  if (!operationId) return false;
  const timestamp = cancelled.get(operationId);
  if (!timestamp) return false;
  if (Date.now() - timestamp > CANCEL_TTL_MS) {
    cancelled.delete(operationId);
    return false;
  }
  return true;
}

function sendProgress(task: TaskType, operationId: string, data: ProgressData): void {
  parentPort?.postMessage({ type: 'progress', task, operationId, data });
}

function getTextExtensionKey(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext) return ext;
  const base = path.basename(filePath).toLowerCase();
  if (!base) return '';
  return base.startsWith('.') ? base.slice(1) : base;
}

function getHiddenCache(filePath: string): boolean | null {
  const cached = hiddenAttrCache.get(filePath);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > HIDDEN_ATTR_CACHE_TTL_MS) {
    hiddenAttrCache.delete(filePath);
    return null;
  }
  hiddenAttrCache.delete(filePath);
  hiddenAttrCache.set(filePath, cached);
  return cached.isHidden;
}

function setHiddenCache(filePath: string, isHidden: boolean): void {
  hiddenAttrCache.delete(filePath);
  if (hiddenAttrCache.size >= HIDDEN_ATTR_CACHE_MAX) {
    const lruKey = hiddenAttrCache.keys().next().value;
    if (lruKey) {
      hiddenAttrCache.delete(lruKey);
    }
  }
  hiddenAttrCache.set(filePath, { isHidden, timestamp: Date.now() });
}

async function readIndexData(indexPath: string, emptyMessage: string): Promise<IndexFileData> {
  try {
    const stats = await fs.stat(indexPath);
    if (cachedIndexPath === indexPath && cachedIndexMtimeMs === stats.mtimeMs && cachedIndexData) {
      return cachedIndexData;
    }

    const rawData = await fs.readFile(indexPath, 'utf-8');
    let parsed: IndexFileData;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      cachedIndexPath = null;
      cachedIndexMtimeMs = null;
      cachedIndexData = null;
      throw new Error('Index file is corrupted');
    }

    cachedIndexPath = indexPath;
    cachedIndexMtimeMs = stats.mtimeMs;
    cachedIndexData = parsed;
    return parsed;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      cachedIndexPath = null;
      cachedIndexMtimeMs = null;
      cachedIndexData = null;
      throw new Error(emptyMessage);
    }
    throw error;
  }
}

function parseIndexEntry(entry: unknown): { filePath?: string; item?: IndexEntryPayload } {
  if (Array.isArray(entry)) {
    const filePath = typeof entry[0] === 'string' ? entry[0] : undefined;
    const item = isRecord(entry[1]) ? (entry[1] as IndexEntryPayload) : undefined;
    return { filePath, item };
  }
  if (isRecord(entry)) {
    const item = entry as IndexEntryPayload;
    const filePath = typeof item.path === 'string' ? item.path : undefined;
    return { filePath, item };
  }
  return {};
}

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
      await fs.unlink(tmpPath).catch(ignoreError);
    }
  }
}

async function isHidden(filePath: string, fileName: string): Promise<boolean> {
  if (fileName.startsWith('.')) return true;
  if (process.platform !== 'win32') return false;

  const cached = getHiddenCache(filePath);
  if (cached !== null) return cached;

  try {
    const { stdout } = await execFileAsync('attrib', [filePath], {
      timeout: 500,
      windowsHide: true,
    });
    const line = stdout.split(/\r?\n/).find((item) => item.trim().length > 0);
    if (!line) {
      setHiddenCache(filePath, false);
      return false;
    }
    const match = line.match(/^\s*([A-Za-z ]+)\s+.+$/);
    if (!match) {
      setHiddenCache(filePath, false);
      return false;
    }
    const hidden = match[1].toUpperCase().includes('H');
    setHiddenCache(filePath, hidden);
    return hidden;
  } catch {
    setHiddenCache(filePath, false);
    return false;
  }
}

async function batchCheckHidden(
  dirPath: string,
  fileNames: string[]
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();

  if (process.platform !== 'win32') {
    for (const fileName of fileNames) {
      if (fileName.startsWith('.')) {
        results.set(fileName, true);
      }
    }
    return results;
  }

  const pending: string[] = [];

  for (const fileName of fileNames) {
    if (fileName.startsWith('.')) {
      results.set(fileName, true);
      continue;
    }

    const filePath = path.join(dirPath, fileName);
    const cached = getHiddenCache(filePath);
    if (cached !== null) {
      results.set(fileName, cached);
      continue;
    }

    pending.push(fileName);
  }

  if (pending.length === 0) {
    return results;
  }

  const ATTRIB_BATCH_SIZE = 200;
  const promises: Promise<void>[] = [];

  for (let i = 0; i < pending.length; i += ATTRIB_BATCH_SIZE) {
    const batch = pending.slice(i, i + ATTRIB_BATCH_SIZE);

    promises.push(
      (async () => {
        try {
          const { stdout } = await execFileAsync('attrib', batch, {
            cwd: dirPath,
            timeout: 2000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
          });

          const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
          for (const line of lines) {
            const match = line.match(/^\s*([A-Za-z ]+)\s+(.+)$/);
            if (!match) continue;
            const attrs = match[1].toUpperCase();
            const filePath = match[2].trim();
            const name = path.basename(filePath);
            const isHiddenAttr = attrs.includes('H');
            results.set(name, isHiddenAttr);
            setHiddenCache(path.join(dirPath, name), isHiddenAttr);
          }
        } catch {
          for (const fileName of batch) {
            results.set(fileName, false);
            setHiddenCache(path.join(dirPath, fileName), false);
          }
        }
      })()
    );
  }

  await Promise.all(promises);

  for (const fileName of pending) {
    if (!results.has(fileName)) {
      results.set(fileName, false);
      setHiddenCache(path.join(dirPath, fileName), false);
    }
  }

  return results;
}

function matchesFilters(
  itemName: string,
  isDir: boolean,
  stats: { size: number; mtime: Date },
  filters?: SearchFilters
): boolean {
  const fileTypeFilter = filters?.fileType?.toLowerCase();
  if (fileTypeFilter && fileTypeFilter !== 'all') {
    if (fileTypeFilter === 'folder') {
      if (!isDir) return false;
    } else {
      if (isDir) return false;
      const ext = path.extname(itemName).toLowerCase().slice(1);
      if (
        fileTypeFilter === 'image' &&
        !['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext)
      )
        return false;
      if (
        fileTypeFilter === 'video' &&
        !['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv'].includes(ext)
      )
        return false;
      if (
        fileTypeFilter === 'audio' &&
        !['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'].includes(ext)
      )
        return false;
      if (
        fileTypeFilter === 'document' &&
        !['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)
      )
        return false;
      if (
        fileTypeFilter === 'archive' &&
        !['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz'].includes(ext)
      )
        return false;
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

function matchesContentFilters(
  stats: { size: number; mtime: Date },
  filters?: SearchFilters
): boolean {
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

async function searchFileContent(
  filePath: string,
  searchQuery: string,
  operationId?: string,
  sizeHint?: number
): Promise<{ found: boolean; context?: string; lineNumber?: number }> {
  const key = getTextExtensionKey(filePath);
  if (!key || !TEXT_FILE_EXTENSIONS.has(key)) {
    return { found: false };
  }

  try {
    let size = Number.isFinite(sizeHint) ? Number(sizeHint) : undefined;
    if (size === undefined) {
      const stats = await fs.stat(filePath);
      size = stats.size;
    }
    if (size > CONTENT_SEARCH_MAX_FILE_SIZE) {
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
          const end = Math.min(
            line.length,
            matchIndex + searchQuery.length + CONTENT_CONTEXT_CHARS
          );
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

async function searchDirectoryFiles(
  payload: SearchPayload,
  operationId?: string
): Promise<SearchResult[]> {
  const { dirPath, query, filters, maxDepth, maxResults } = payload;
  const results: SearchResult[] = [];
  const searchQuery = String(query || '').toLowerCase();
  const STAT_BATCH_SIZE = 50;

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

    const matchingItems: Array<{ item: fsSync.Dirent; fullPath: string }> = [];

    for (const item of items) {
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');
      const fullPath = path.join(current.dir, item.name);
      const matches = item.name.toLowerCase().includes(searchQuery);

      if (matches) {
        matchingItems.push({ item, fullPath });
      }

      if (item.isDirectory()) {
        stack.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }

    for (let i = 0; i < matchingItems.length && results.length < maxResults; i += STAT_BATCH_SIZE) {
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');
      const batch = matchingItems.slice(i, i + STAT_BATCH_SIZE);
      const statResults = await Promise.allSettled(batch.map(({ fullPath }) => fs.stat(fullPath)));

      const filteredItems: Array<{ item: fsSync.Dirent; fullPath: string; stats: fsSync.Stats }> =
        [];

      for (let j = 0; j < statResults.length; j++) {
        if (results.length >= maxResults) break;
        const result = statResults[j];
        if (result.status === 'fulfilled') {
          const { item, fullPath } = batch[j];
          const isDir = item.isDirectory();
          if (matchesFilters(item.name, isDir, result.value, filters)) {
            filteredItems.push({ item, fullPath, stats: result.value });
          }
        }
      }

      if (filteredItems.length === 0) continue;

      const hiddenMap = await batchCheckHidden(
        current.dir,
        filteredItems.map(({ item }) => item.name)
      );

      for (const { item, fullPath, stats } of filteredItems) {
        if (results.length >= maxResults) break;
        results.push({
          name: item.name,
          path: fullPath,
          isDirectory: item.isDirectory(),
          isFile: item.isFile(),
          size: stats.size,
          modified: stats.mtime,
          isHidden: hiddenMap.get(item.name) || false,
        });
      }
    }
  }

  return results;
}

async function searchDirectoryContent(
  payload: ContentSearchPayload,
  operationId?: string
): Promise<ContentSearchResult[]> {
  const { dirPath, query, filters, maxDepth, maxResults } = payload;
  const results: ContentSearchResult[] = [];
  const searchQuery = String(query || '').toLowerCase();
  const STAT_BATCH_SIZE = 50;
  const CONTENT_SEARCH_BATCH_SIZE = 8;

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

    const fileItems: Array<{ item: fsSync.Dirent; fullPath: string }> = [];

    for (const item of items) {
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');
      const fullPath = path.join(current.dir, item.name);

      if (item.isFile()) {
        fileItems.push({ item, fullPath });
      }

      if (item.isDirectory()) {
        stack.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }

    for (let i = 0; i < fileItems.length && results.length < maxResults; i += STAT_BATCH_SIZE) {
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');

      const statBatch = fileItems.slice(i, i + STAT_BATCH_SIZE);
      const statResults = await Promise.allSettled(
        statBatch.map(({ fullPath }) => fs.stat(fullPath))
      );

      const contentBatch: Array<{ item: fsSync.Dirent; fullPath: string; stats: fsSync.Stats }> =
        [];

      for (let j = 0; j < statResults.length; j++) {
        if (results.length >= maxResults) break;
        const result = statResults[j];
        if (result.status === 'fulfilled') {
          const { item, fullPath } = statBatch[j];
          if (matchesContentFilters(result.value, filters)) {
            contentBatch.push({ item, fullPath, stats: result.value });
          }
        }
      }

      for (
        let k = 0;
        k < contentBatch.length && results.length < maxResults;
        k += CONTENT_SEARCH_BATCH_SIZE
      ) {
        if (isCancelled(operationId)) throw new Error('Calculation cancelled');

        const batch = contentBatch.slice(
          k,
          Math.min(k + CONTENT_SEARCH_BATCH_SIZE, contentBatch.length)
        );
        const contentResults = await Promise.allSettled(
          batch.map(({ fullPath, stats }) =>
            searchFileContent(fullPath, searchQuery, operationId, stats.size)
          )
        );

        const foundItems: Array<{
          item: fsSync.Dirent;
          fullPath: string;
          stats: fsSync.Stats;
          contentResult: { found: boolean; context?: string; lineNumber?: number };
        }> = [];

        for (let j = 0; j < contentResults.length; j++) {
          const result = contentResults[j];
          if (result.status === 'fulfilled' && result.value.found) {
            foundItems.push({ ...batch[j], contentResult: result.value });
          }
        }

        if (foundItems.length > 0) {
          const hiddenMap = await batchCheckHidden(
            current.dir,
            foundItems.map(({ item }) => item.name)
          );

          for (const { item, fullPath, stats, contentResult } of foundItems) {
            if (results.length >= maxResults) break;
            results.push({
              name: item.name,
              path: fullPath,
              isDirectory: false,
              isFile: true,
              size: stats.size,
              modified: stats.mtime,
              isHidden: hiddenMap.get(item.name) || false,
              matchContext: contentResult.context,
              matchLineNumber: contentResult.lineNumber,
            });
          }
        }
      }
    }
  }

  return results;
}

async function searchContentList(
  payload: ContentListSearchPayload,
  operationId?: string
): Promise<ContentSearchResult[]> {
  const { files, query, maxResults, filters } = payload;
  const results: ContentSearchResult[] = [];
  const searchQuery = String(query || '').toLowerCase();

  const CONTENT_SEARCH_BATCH_SIZE = 8;
  const batch: Array<{
    item: { path: string; size: number; name?: string; modified?: number | string | Date };
    filePath: string;
    fileName: string;
    modified: Date;
  }> = [];

  for (const item of files || []) {
    if (results.length >= maxResults) break;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');

    const filePath = item.path;
    const fileName = item.name || path.basename(filePath);
    const key = getTextExtensionKey(fileName);
    if (!TEXT_FILE_EXTENSIONS.has(key)) continue;

    if (filters?.minSize !== undefined && item.size < filters.minSize) continue;
    if (filters?.maxSize !== undefined && item.size > filters.maxSize) continue;
    const modifiedValue = item.modified;
    const modified =
      modifiedValue instanceof Date
        ? modifiedValue
        : modifiedValue !== undefined
          ? new Date(modifiedValue)
          : new Date(0);
    const dateFrom = filters?.dateFrom ? new Date(filters.dateFrom) : null;
    const dateTo = filters?.dateTo ? new Date(filters.dateTo) : null;
    if (dateTo) dateTo.setHours(23, 59, 59, 999);
    if (dateFrom && modified < dateFrom) continue;
    if (dateTo && modified > dateTo) continue;

    batch.push({ item, filePath, fileName, modified });

    if (batch.length >= CONTENT_SEARCH_BATCH_SIZE) {
      const searchResults = await Promise.allSettled(
        batch.map(({ item, filePath }) =>
          searchFileContent(filePath, searchQuery, operationId, item.size)
        )
      );

      for (let i = 0; i < searchResults.length; i++) {
        if (results.length >= maxResults) break;
        const result = searchResults[i];
        if (result.status === 'fulfilled' && result.value.found) {
          const { item, filePath, fileName, modified } = batch[i];
          results.push({
            name: fileName,
            path: filePath,
            isDirectory: false,
            isFile: true,
            size: item.size,
            modified,
            isHidden: await isHidden(filePath, fileName),
            matchContext: result.value.context,
            matchLineNumber: result.value.lineNumber,
          });
        }
      }

      batch.length = 0;
    }
  }

  if (batch.length > 0 && results.length < maxResults) {
    const searchResults = await Promise.allSettled(
      batch.map(({ item, filePath }) =>
        searchFileContent(filePath, searchQuery, operationId, item.size)
      )
    );

    for (let i = 0; i < searchResults.length; i++) {
      if (results.length >= maxResults) break;
      const result = searchResults[i];
      if (result.status === 'fulfilled' && result.value.found) {
        const { item, filePath, fileName, modified } = batch[i];
        results.push({
          name: fileName,
          path: filePath,
          isDirectory: false,
          isFile: true,
          size: item.size,
          modified,
          isHidden: await isHidden(filePath, fileName),
          matchContext: result.value.context,
          matchLineNumber: result.value.lineNumber,
        });
      }
    }
  }

  return results;
}

async function searchContentIndex(
  payload: ContentIndexSearchPayload,
  operationId?: string
): Promise<ContentSearchResult[]> {
  const { indexPath, query, maxResults, filters } = payload;
  const searchQuery = String(query || '').toLowerCase();
  const limit = Number.isFinite(maxResults) ? Math.max(1, maxResults) : 100;

  const parsed = await readIndexData(
    indexPath,
    'Index is empty. Rebuild the index to enable global content search.'
  );

  const indexEntries = parsed?.index;
  if (!Array.isArray(indexEntries) || indexEntries.length === 0) {
    throw new Error('Index is empty. Rebuild the index to enable global content search.');
  }

  const results: ContentSearchResult[] = [];
  const CONTENT_SEARCH_BATCH_SIZE = 8;
  const batch: Array<{ filePath: string; fileName: string; size: number; modified: Date }> = [];

  for (const entry of indexEntries) {
    if (results.length >= limit) break;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');

    const { filePath, item } = parseIndexEntry(entry);
    if (!item || item.isFile !== true || !filePath) continue;

    const fileName = typeof item.name === 'string' ? item.name : path.basename(filePath);
    const key = getTextExtensionKey(fileName);
    if (!TEXT_FILE_EXTENSIONS.has(key)) continue;

    const modified =
      item.modified instanceof Date
        ? item.modified
        : item.modified !== undefined
          ? new Date(item.modified)
          : new Date(0);
    const sizeValue = typeof item.size === 'number' ? item.size : Number(item.size);
    const size = Number.isFinite(sizeValue) ? sizeValue : 0;
    if (!matchesContentFilters({ size, mtime: modified }, filters)) continue;

    batch.push({ filePath, fileName, size, modified });

    if (batch.length >= CONTENT_SEARCH_BATCH_SIZE) {
      const searchResults = await Promise.allSettled(
        batch.map(({ filePath, size }) =>
          searchFileContent(filePath, searchQuery, operationId, size)
        )
      );

      for (let i = 0; i < searchResults.length; i++) {
        if (results.length >= limit) break;
        const result = searchResults[i];
        if (result.status === 'fulfilled' && result.value.found) {
          const { filePath, fileName, size, modified } = batch[i];
          results.push({
            name: fileName,
            path: filePath,
            isDirectory: false,
            isFile: true,
            size,
            modified,
            isHidden: await isHidden(filePath, fileName),
            matchContext: result.value.context,
            matchLineNumber: result.value.lineNumber,
          });
        }
      }

      batch.length = 0;
    }
  }

  if (batch.length > 0 && results.length < limit) {
    const searchResults = await Promise.allSettled(
      batch.map(({ filePath, size }) => searchFileContent(filePath, searchQuery, operationId, size))
    );

    for (let i = 0; i < searchResults.length; i++) {
      if (results.length >= limit) break;
      const result = searchResults[i];
      if (result.status === 'fulfilled' && result.value.found) {
        const { filePath, fileName, size, modified } = batch[i];
        results.push({
          name: fileName,
          path: filePath,
          isDirectory: false,
          isFile: true,
          size,
          modified,
          isHidden: await isHidden(filePath, fileName),
          matchContext: result.value.context,
          matchLineNumber: result.value.lineNumber,
        });
      }
    }
  }

  return results;
}

async function searchIndexFile(
  payload: IndexSearchPayload,
  operationId?: string
): Promise<IndexSearchResult[]> {
  const { indexPath, query, maxResults } = payload;
  const searchQuery = String(query || '').toLowerCase();
  const limit =
    typeof maxResults === 'number' && Number.isFinite(maxResults) ? Math.max(1, maxResults) : 100;

  if (!searchQuery) {
    return [];
  }

  const parsed = await readIndexData(
    indexPath,
    'Index is empty. Rebuild the index to enable global search.'
  );

  const indexEntries = parsed?.index;
  if (!Array.isArray(indexEntries) || indexEntries.length === 0) {
    throw new Error('Index is empty. Rebuild the index to enable global search.');
  }

  const results: IndexSearchResult[] = [];

  for (const entry of indexEntries) {
    if (results.length >= limit) break;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');

    const { filePath, item } = parseIndexEntry(entry);
    if (!item || !filePath) continue;
    const name = typeof item.name === 'string' ? item.name : path.basename(filePath);
    if (!String(name).toLowerCase().includes(searchQuery)) continue;

    const sizeValue = typeof item.size === 'number' ? item.size : Number(item.size);
    const size = Number.isFinite(sizeValue) ? sizeValue : 0;
    const modified =
      item.modified instanceof Date
        ? item.modified
        : item.modified !== undefined
          ? new Date(item.modified)
          : new Date(0);

    results.push({
      name,
      path: filePath,
      isDirectory: item.isDirectory === true,
      isFile: item.isFile === true,
      size,
      modified,
    });
  }

  results.sort((a, b) => {
    const aExact = a.name.toLowerCase() === searchQuery;
    const bExact = b.name.toLowerCase() === searchQuery;

    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

async function calculateFolderSize(
  payload: FolderSizePayload,
  operationId?: string
): Promise<{
  size: number;
  files: number;
  dirs: number;
  totalSize: number;
  fileCount: number;
  folderCount: number;
  fileTypes: { extension: string; count: number; size: number }[];
}> {
  const { folderPath } = payload;
  let totalSize = 0;
  let fileCount = 0;
  let folderCount = 0;
  let lastProgressUpdate = Date.now();
  const fileTypeMap = new Map<string, { count: number; size: number }>();

  const STAT_BATCH_SIZE = 50;
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

    const fileBatch: Array<{ fullPath: string; name: string }> = [];

    for (const entry of entries) {
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        folderCount++;
        stack.push(fullPath);
      } else if (entry.isFile()) {
        fileBatch.push({ fullPath, name: entry.name });

        if (fileBatch.length >= STAT_BATCH_SIZE) {
          const results = await Promise.allSettled(
            fileBatch.map(({ fullPath }) => fs.stat(fullPath))
          );

          for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result.status === 'fulfilled') {
              totalSize += result.value.size;
              fileCount++;
              const ext = path.extname(fileBatch[i].name).toLowerCase() || '(no extension)';
              const existing = fileTypeMap.get(ext) || { count: 0, size: 0 };
              fileTypeMap.set(ext, {
                count: existing.count + 1,
                size: existing.size + result.value.size,
              });
            }
          }

          fileBatch.length = 0;
        }
      }

      const now = Date.now();
      if (operationId && now - lastProgressUpdate > 100) {
        lastProgressUpdate = now;
        sendProgress('folder-size', operationId, {
          calculatedSize: totalSize,
          fileCount,
          folderCount,
          currentPath,
        });
      }
    }

    if (fileBatch.length > 0) {
      const results = await Promise.allSettled(fileBatch.map(({ fullPath }) => fs.stat(fullPath)));

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
          totalSize += result.value.size;
          fileCount++;
          const ext = path.extname(fileBatch[i].name).toLowerCase() || '(no extension)';
          const existing = fileTypeMap.get(ext) || { count: 0, size: 0 };
          fileTypeMap.set(ext, {
            count: existing.count + 1,
            size: existing.size + result.value.size,
          });
        }
      }
    }
  }

  const fileTypes = Array.from(fileTypeMap.entries())
    .map(([extension, data]) => ({ extension, count: data.count, size: data.size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 10);

  return {
    size: totalSize,
    files: fileCount,
    dirs: folderCount,
    totalSize,
    fileCount,
    folderCount,
    fileTypes,
  };
}

async function calculateChecksum(
  payload: ChecksumPayload,
  operationId?: string
): Promise<Record<string, string>> {
  const { filePath, algorithms } = payload;
  const stats = await fs.stat(filePath);
  const fileSize = stats.size;

  const ALLOWED_ALGORITHMS = new Set(['md5', 'sha256']);
  const rawAlgorithms = Array.isArray(algorithms) ? algorithms : [];
  const uniqueAlgorithms = Array.from(
    new Set(
      rawAlgorithms
        .map((algo) => String(algo).toLowerCase())
        .filter((a) => ALLOWED_ALGORITHMS.has(a))
    )
  );

  if (uniqueAlgorithms.length === 0) {
    throw new Error('No valid algorithms specified');
  }

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
        const label =
          uniqueAlgorithms.length > 1 ? uniqueAlgorithms.join('+') : uniqueAlgorithms[0] || '';
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

async function buildIndex(
  payload: BuildIndexPayload,
  operationId?: string
): Promise<{
  indexedFiles: number;
  entries?: IndexEntry[];
}> {
  const locations: string[] = payload.locations || [];
  const maxIndexSize: number = payload.maxIndexSize || 200000;
  const skipDirs = Array.isArray(payload.skipDirs) ? payload.skipDirs : [];
  const skipDirSegments = new Set<string>();
  const skipDirPaths = new Set<string>();

  for (const skipDir of skipDirs) {
    if (typeof skipDir !== 'string') continue;
    const trimmed = skipDir.trim();
    if (!trimmed) continue;
    if (path.isAbsolute(trimmed)) {
      skipDirPaths.add(normalizePathForCompare(trimmed));
    } else {
      skipDirSegments.add(trimmed.toLowerCase());
    }
  }

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
    'amd',
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
    'ntuser.dat.log2',
  ]);

  const shouldExclude = (filePath: string): boolean => {
    const parts = filePath.split(/[/\\]/);
    const filename = parts[parts.length - 1].toLowerCase();
    if (excludeFiles.has(filename)) return true;
    const normalizedPath = normalizePathForCompare(filePath);
    for (const skipPath of skipDirPaths) {
      if (normalizedPath === skipPath || normalizedPath.startsWith(skipPath + path.sep)) {
        return true;
      }
    }
    return parts.some((part) => {
      const segment = part.toLowerCase();
      return excludeSegments.has(segment) || skipDirSegments.has(segment);
    });
  };

  const entries: IndexEntry[] = [];
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
        entries.push([
          fullPath,
          {
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
            size: stats.size,
            modified: stats.mtime.getTime(),
          },
        ]);

        if (entry.isDirectory() && entries.length < maxIndexSize) {
          stack.push(fullPath);
        }
      } catch (error) {
        ignoreError(error);
      }
    }
  }

  return { indexedFiles: entries.length, entries };
}

async function loadIndexFile(payload: LoadIndexPayload): Promise<{
  indexedFiles: number;
  indexDate: number;
  exists: boolean;
  index?: Array<unknown>;
  lastIndexTime?: number | null;
}> {
  const { indexPath } = payload;
  try {
    const data = await fs.readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(data);
    const indexEntries: unknown[] = Array.isArray(parsed.index) ? parsed.index : [];
    const normalizedLastIndexTime = normalizeIndexTimestamp(parsed.lastIndexTime);
    const sample = indexEntries.slice(0, 20);
    const isLegacy = sample.some((entry: unknown) => {
      if (Array.isArray(entry)) {
        if (entry.length < 2) return true;
        const entryPath = entry[0];
        const item = entry[1];
        if (typeof entryPath !== 'string' || !item || typeof item !== 'object') return true;
        return (
          typeof item.name !== 'string' ||
          typeof item.isFile !== 'boolean' ||
          typeof item.isDirectory !== 'boolean'
        );
      }
      if (entry && typeof entry === 'object') {
        const item = entry as { [key: string]: unknown };
        return (
          typeof item.path !== 'string' ||
          typeof item.name !== 'string' ||
          typeof item.isFile !== 'boolean' ||
          typeof item.isDirectory !== 'boolean'
        );
      }
      return true;
    });

    if (isLegacy && indexEntries.length > 0) {
      try {
        await fs.unlink(indexPath);
      } catch (error) {
        ignoreError(error);
      }
      return { exists: false, indexedFiles: 0, indexDate: 0 };
    }

    return {
      exists: true,
      indexedFiles: indexEntries.length,
      indexDate: normalizedLastIndexTime ?? Date.now(),
      index: indexEntries,
      lastIndexTime: normalizedLastIndexTime,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err && err.code === 'ENOENT') {
      return { exists: false, indexedFiles: 0, indexDate: 0 };
    }
    throw error;
  }
}

async function saveIndexFile(payload: SaveIndexPayload): Promise<{ success: true }> {
  const { indexPath, entries, lastIndexTime } = payload;
  const normalizedLastIndexTime = normalizeIndexTimestamp(lastIndexTime);
  const data = {
    index: entries || [],
    lastIndexTime: normalizedLastIndexTime,
    version: 1,
  };
  await writeFileAtomic(indexPath, JSON.stringify(data));
  return { success: true };
}

async function listDirectory(
  payload: ListDirectoryPayload,
  operationId?: string
): Promise<{ contents: SearchResult[] }> {
  const { dirPath, batchSize = 500, streamOnly = false, includeHidden = false } = payload;
  const results: SearchResult[] = [];
  const batch: fsSync.Dirent[] = [];
  let loaded = 0;
  let dir: fsSync.Dir | null = null;
  const shouldCheckHidden = process.platform === 'win32';

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');

    const names = batch.map((entry) => entry.name);
    const hiddenMap = shouldCheckHidden
      ? await batchCheckHidden(dirPath, names)
      : new Map<string, boolean>();
    let items = await Promise.all(
      batch.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        const isHiddenFlag = shouldCheckHidden
          ? (hiddenMap.get(entry.name) ?? entry.name.startsWith('.'))
          : entry.name.startsWith('.');
        try {
          const stats = await fs.stat(fullPath);
          return {
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
            size: stats.size,
            modified: stats.mtime,
            isHidden: isHiddenFlag,
          };
        } catch {
          return {
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
            size: 0,
            modified: new Date(),
            isHidden: isHiddenFlag,
          };
        }
      })
    );

    if (!includeHidden) {
      items = items.filter((item) => !item.isHidden);
    }

    if (!streamOnly) {
      results.push(...items);
    }
    loaded += items.length;
    if (operationId) {
      sendProgress('list-directory', operationId, { dirPath, loaded, items });
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
    } catch (error) {
      ignoreError(error);
    }
  }

  return { contents: streamOnly ? [] : results };
}

async function handleTask(message: TaskRequest): Promise<unknown> {
  switch (message.type) {
    case 'search-files':
      return await searchDirectoryFiles(message.payload as SearchPayload, message.operationId);
    case 'search-content':
      return await searchDirectoryContent(
        message.payload as ContentSearchPayload,
        message.operationId
      );
    case 'search-content-list':
      return await searchContentList(
        message.payload as ContentListSearchPayload,
        message.operationId
      );
    case 'search-content-index':
      return await searchContentIndex(
        message.payload as ContentIndexSearchPayload,
        message.operationId
      );
    case 'search-index':
      return await searchIndexFile(message.payload as IndexSearchPayload, message.operationId);
    case 'folder-size':
      return await calculateFolderSize(message.payload as FolderSizePayload, message.operationId);
    case 'checksum':
      return await calculateChecksum(message.payload as ChecksumPayload, message.operationId);
    case 'build-index':
      return await buildIndex(message.payload as BuildIndexPayload, message.operationId);
    case 'load-index':
      return await loadIndexFile(message.payload as LoadIndexPayload);
    case 'save-index':
      return await saveIndexFile(message.payload as SaveIndexPayload);
    case 'list-directory':
      return await listDirectory(message.payload as ListDirectoryPayload, message.operationId);
    default:
      throw new Error('Unknown task');
  }
}

if (!parentPort) {
  process.exit(1);
}

parentPort.on('message', async (message: unknown) => {
  if (isRecord(message) && message.type === 'cancel' && typeof message.operationId === 'string') {
    cancelled.set(message.operationId, Date.now());
    pruneCancelled();
    return;
  }

  if (!isRecord(message) || !isTaskRequest(message)) return;
  const task = message;
  try {
    const data = await handleTask(task);
    parentPort?.postMessage({ type: 'result', id: task.id, success: true, data });
  } catch (error) {
    parentPort?.postMessage({
      type: 'result',
      id: task.id,
      success: false,
      error: getErrorMessage(error),
    });
  } finally {
    if (task.operationId) {
      cancelled.delete(task.operationId);
    }
  }
});
