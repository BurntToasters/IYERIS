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
  if (process.platform === 'win32') return resolved.toLowerCase();
  if (process.platform === 'darwin') return resolved.normalize('NFC');
  return resolved;
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
  'dart',
  'zig',
  'elm',
  'ex',
  'exs',
  'erl',
  'hrl',
  'clj',
  'cljs',
  'groovy',
  'tf',
  'hcl',
  'proto',
]);

export const FILE_TYPE_EXTENSIONS: Record<string, ReadonlySet<string>> = {
  image: new Set([
    'jpg',
    'jpeg',
    'png',
    'gif',
    'bmp',
    'webp',
    'svg',
    'ico',
    'avif',
    'tiff',
    'tif',
    'heic',
    'heif',
  ]),
  video: new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv', 'm4v', '3gp']),
  audio: new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus']),
  document: new Set(['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'ppt', 'pptx']),
  archive: new Set([
    'zip',
    '7z',
    'rar',
    'tar',
    'gz',
    'bz2',
    'xz',
    'tgz',
    'zst',
    'cab',
    'iso',
    'lz',
  ]),
};

const HIDDEN_ATTR_CACHE_TTL_MS = 5 * 60 * 1000;
const HIDDEN_ATTR_CACHE_MAX = 5000;

interface WinAttrFlags {
  isHidden: boolean;
  isSystemProtected: boolean;
}

const hiddenAttrCache = new Map<string, { flags: WinAttrFlags; timestamp: number }>();

function getAttrCache(filePath: string): WinAttrFlags | null {
  const cached = hiddenAttrCache.get(filePath);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > HIDDEN_ATTR_CACHE_TTL_MS) {
    hiddenAttrCache.delete(filePath);
    return null;
  }
  hiddenAttrCache.delete(filePath);
  hiddenAttrCache.set(filePath, cached);
  return cached.flags;
}

function setAttrCache(filePath: string, flags: WinAttrFlags): void {
  hiddenAttrCache.delete(filePath);
  if (hiddenAttrCache.size >= HIDDEN_ATTR_CACHE_MAX) {
    const oldestKey = hiddenAttrCache.keys().next().value;
    if (oldestKey) {
      hiddenAttrCache.delete(oldestKey);
    }
  }
  hiddenAttrCache.set(filePath, { flags, timestamp: Date.now() });
}

function parseAttrFlags(attrStr: string): WinAttrFlags {
  const upper = attrStr.toUpperCase();
  const hasH = upper.includes('H');
  const hasS = upper.includes('S');
  return {
    isHidden: hasH,
    isSystemProtected: hasH && hasS,
  };
}

const DEFAULT_ATTR_FLAGS: WinAttrFlags = { isHidden: false, isSystemProtected: false };

export async function isHidden(filePath: string, fileName: string): Promise<boolean> {
  if (fileName.startsWith('.')) return true;
  if (process.platform !== 'win32') return false;

  const cached = getAttrCache(filePath);
  if (cached !== null) return cached.isHidden;

  try {
    const { stdout } = await execFileAsync('attrib', [filePath], {
      timeout: 500,
      windowsHide: true,
    });
    const line = stdout.split(/\r?\n/).find((item) => item.trim().length > 0);
    if (!line) {
      setAttrCache(filePath, DEFAULT_ATTR_FLAGS);
      return false;
    }
    const match = line.match(/^\s*([A-Za-z ]+)\s+.+$/);
    if (!match) {
      setAttrCache(filePath, DEFAULT_ATTR_FLAGS);
      return false;
    }
    const flags = parseAttrFlags(match[1]);
    setAttrCache(filePath, flags);
    return flags.isHidden;
  } catch {
    setAttrCache(filePath, DEFAULT_ATTR_FLAGS);
    return false;
  }
}

export async function batchCheckHidden(
  dirPath: string,
  fileNames: string[]
): Promise<Map<string, WinAttrFlags>> {
  const results = new Map<string, WinAttrFlags>();

  if (process.platform !== 'win32') {
    for (const fileName of fileNames) {
      if (fileName.startsWith('.')) {
        results.set(fileName, { isHidden: true, isSystemProtected: false });
      }
    }
    return results;
  }

  const pending: string[] = [];

  for (const fileName of fileNames) {
    if (fileName.startsWith('.')) {
      results.set(fileName, { isHidden: true, isSystemProtected: false });
      continue;
    }

    const fullPath = path.join(dirPath, fileName);
    const cached = getAttrCache(fullPath);
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
            timeout: 5000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
          });

          const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
          for (const line of lines) {
            const match = line.match(/^\s*([A-Za-z ]+)\s+(.+)$/);
            if (!match) continue;
            const matchedPath = match[2].trim();
            const name = path.basename(matchedPath);
            const flags = parseAttrFlags(match[1]);
            results.set(name, flags);
            setAttrCache(path.join(dirPath, name), flags);
          }
        } catch {
          for (const fileName of batch) {
            results.set(fileName, DEFAULT_ATTR_FLAGS);
            setAttrCache(path.join(dirPath, fileName), DEFAULT_ATTR_FLAGS);
          }
        }
      })()
    );
  }

  await Promise.all(promises);

  for (const fileName of pending) {
    if (!results.has(fileName)) {
      results.set(fileName, DEFAULT_ATTR_FLAGS);
      setAttrCache(path.join(dirPath, fileName), DEFAULT_ATTR_FLAGS);
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
  regex?: boolean;
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
      throw new Error(emptyMessage, { cause: error });
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
  isSymlink?: boolean;
  isBrokenSymlink?: boolean;
  isAppBundle?: boolean;
  isShortcut?: boolean;
  isDesktopEntry?: boolean;
  symlinkTarget?: string;
  size: number;
  modified: Date;
  isHidden: boolean;
  isSystemProtected?: boolean;
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
