import { parentPort } from 'worker_threads';
import { promises as fs } from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

export const execFileAsync = promisify(execFile);

const CANCEL_TTL_MS = 10 * 60 * 1000;
export const cancelled = new Map<string, number>();

export function pruneCancelled(): void {
  const now = Date.now();
  for (const [id, timestamp] of cancelled) {
    if (now - timestamp > CANCEL_TTL_MS) {
      cancelled.delete(id);
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isCancelled(operationId?: string): boolean {
  if (!operationId) return false;
  const timestamp = cancelled.get(operationId);
  if (!timestamp) return false;
  if (Date.now() - timestamp > CANCEL_TTL_MS) {
    cancelled.delete(operationId);
    return false;
  }
  return true;
}

export interface ProgressData {
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

export type TaskType =
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

export function sendProgress(task: TaskType, operationId: string, data: ProgressData): void {
  parentPort?.postMessage({ type: 'progress', task, operationId, data });
}

export function normalizePathForCompare(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function normalizeModifiedDate(value: number | string | Date | undefined): Date {
  if (value instanceof Date) return value;
  if (value !== undefined) return new Date(value);
  return new Date(0);
}

export function normalizeIndexTimestamp(value: unknown): number | null {
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

export function getTextExtensionKey(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext) return ext;
  const base = path.basename(filePath).toLowerCase();
  if (!base) return '';
  return base.startsWith('.') ? base.slice(1) : base;
}

export const TEXT_FILE_EXTENSIONS = new Set([
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

export const FILE_TYPE_EXTENSIONS: Record<string, ReadonlySet<string>> = {
  image: new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico']),
  video: new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv']),
  audio: new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma']),
  document: new Set(['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'ppt', 'pptx']),
  archive: new Set(['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz']),
};

const HIDDEN_ATTR_CACHE_TTL_MS = 5 * 60 * 1000;
const HIDDEN_ATTR_CACHE_MAX = 5000;
const hiddenAttrCache = new Map<string, { isHidden: boolean; timestamp: number }>();

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

export async function isHidden(filePath: string, fileName: string): Promise<boolean> {
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

export async function batchCheckHidden(
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

    const fullPath = path.join(dirPath, fileName);
    const cached = getHiddenCache(fullPath);
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
            const matchedPath = match[2].trim();
            const name = path.basename(matchedPath);
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

export interface SearchFilters {
  fileType?: string;
  minSize?: number;
  maxSize?: number;
  dateFrom?: string;
  dateTo?: string;
}

export type DateRangeFilter = {
  dateFrom: Date | null;
  dateTo: Date | null;
};

export function parseDateRange(filters?: SearchFilters): DateRangeFilter {
  const dateFrom = filters?.dateFrom ? new Date(filters.dateFrom) : null;
  const dateTo = filters?.dateTo ? new Date(filters.dateTo) : null;
  if (dateTo) dateTo.setHours(23, 59, 59, 999);
  return { dateFrom, dateTo };
}

export function matchesDateRange(value: Date, range: DateRangeFilter): boolean {
  if (range.dateFrom && value < range.dateFrom) return false;
  if (range.dateTo && value > range.dateTo) return false;
  return true;
}

export function matchesFilters(
  itemName: string,
  isDir: boolean,
  stats: { size: number; mtime: Date },
  filters?: SearchFilters,
  dateRange: DateRangeFilter = parseDateRange(filters)
): boolean {
  const fileTypeFilter = filters?.fileType?.toLowerCase();
  if (fileTypeFilter && fileTypeFilter !== 'all') {
    if (fileTypeFilter === 'folder') {
      if (!isDir) return false;
    } else {
      if (isDir) return false;
      const ext = path.extname(itemName).toLowerCase().slice(1);
      const allowedExtensions = FILE_TYPE_EXTENSIONS[fileTypeFilter];
      if (allowedExtensions && !allowedExtensions.has(ext)) return false;
    }
  }

  const minSize = filters?.minSize;
  const maxSize = filters?.maxSize;
  if (!isDir) {
    if (minSize !== undefined && stats.size < minSize) return false;
    if (maxSize !== undefined && stats.size > maxSize) return false;
  }
  return matchesDateRange(stats.mtime, dateRange);
}

export interface IndexFileData {
  index?: unknown;
  lastIndexTime?: unknown;
  version?: number;
}

export type IndexEntryPayload = {
  name?: string;
  path?: string;
  isDirectory?: boolean;
  isFile?: boolean;
  size?: number | string;
  modified?: number | string | Date;
};

export function parseIndexEntry(entry: unknown): { filePath?: string; item?: IndexEntryPayload } {
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

export async function readIndexData(
  indexPath: string,
  emptyMessage: string
): Promise<IndexFileData> {
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

let cachedIndexPath: string | null = null;
let cachedIndexMtimeMs: number | null = null;
let cachedIndexData: IndexFileData | null = null;

export function resetIndexCache(): void {
  cachedIndexPath = null;
  cachedIndexMtimeMs = null;
  cachedIndexData = null;
}

export interface SearchResult {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modified: Date;
  isHidden: boolean;
}

export interface ContentSearchResult extends SearchResult {
  matchContext?: string;
  matchLineNumber?: number;
}

export interface IndexSearchResult {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modified: Date;
}

export type IndexEntry = [
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
