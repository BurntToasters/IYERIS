import { ipcMain, app, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { FileItem, ApiResponse, IndexSearchResponse, IndexEntry } from './types';
import { getFileTasks, getIndexerTasks, getFileIndexer } from './appState';
import { isPathSafe, getErrorMessage } from './security';
import { isFileHiddenCached } from './fileOperations';

interface SearchFilters {
  fileType?: string;
  minSize?: number;
  maxSize?: number;
  dateFrom?: string;
  dateTo?: string;
}

const TEXT_FILE_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
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
  'less',
  'py',
  'rb',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'go',
  'rs',
  'swift',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'sh',
  'bash',
  'ps1',
  'bat',
  'cmd',
  'sql',
  'log',
  'csv',
  'env',
  'gitignore',
  'vue',
  'svelte',
  'php',
  'pl',
  'r',
  'lua',
  'kt',
  'kts',
  'scala',
]);

const CONTENT_SEARCH_MAX_FILE_SIZE = 1024 * 1024;
const CONTENT_CONTEXT_CHARS = 60;

interface ContentSearchResult {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modified: Date;
  isHidden: boolean;
  matchContext?: string;
  matchLineNumber?: number;
}

interface ContentSearchFilters {
  dateFrom: Date | null;
  dateTo: Date | null;
  minSize?: number;
  maxSize?: number;
}

function parseContentFilters(filters?: SearchFilters): ContentSearchFilters {
  const dateFrom = filters?.dateFrom ? new Date(filters.dateFrom) : null;
  const dateTo = filters?.dateTo ? new Date(filters.dateTo) : null;
  if (dateTo) dateTo.setHours(23, 59, 59, 999);
  return {
    dateFrom,
    dateTo,
    minSize: filters?.minSize,
    maxSize: filters?.maxSize,
  };
}

async function searchFileContent(
  filePath: string,
  searchQuery: string
): Promise<{ found: boolean; context?: string; lineNumber?: number }> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!TEXT_FILE_EXTENSIONS.has(ext)) {
    return { found: false };
  }

  try {
    const stats = await fs.stat(filePath);
    if (stats.size > CONTENT_SEARCH_MAX_FILE_SIZE) {
      return { found: false };
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lowerLine = line.toLowerCase();
      const matchIndex = lowerLine.indexOf(searchQuery);

      if (matchIndex !== -1) {
        const start = Math.max(0, matchIndex - CONTENT_CONTEXT_CHARS);
        const end = Math.min(line.length, matchIndex + searchQuery.length + CONTENT_CONTEXT_CHARS);
        let context = line.substring(start, end).trim();
        if (start > 0) context = '...' + context;
        if (end < line.length) context = context + '...';

        return { found: true, context, lineNumber: i + 1 };
      }
    }
  } catch {
    return { found: false };
  }

  return { found: false };
}

async function searchDirectoryForContent(
  currentPath: string,
  searchQuery: string,
  filters: ContentSearchFilters,
  results: ContentSearchResult[],
  depth: number,
  maxDepth: number,
  maxResults: number
): Promise<void> {
  if (depth >= maxDepth || results.length >= maxResults) {
    return;
  }

  try {
    const items = await fs.readdir(currentPath, { withFileTypes: true });

    for (const item of items) {
      if (results.length >= maxResults) return;

      const fullPath = path.join(currentPath, item.name);

      if (item.isFile()) {
        try {
          const stats = await fs.stat(fullPath);

          if (filters.minSize !== undefined && stats.size < filters.minSize) continue;
          if (filters.maxSize !== undefined && stats.size > filters.maxSize) continue;
          if (filters.dateFrom && stats.mtime < filters.dateFrom) continue;
          if (filters.dateTo && stats.mtime > filters.dateTo) continue;

          const contentResult = await searchFileContent(fullPath, searchQuery);
          if (contentResult.found) {
            const isHidden = await isFileHiddenCached(fullPath, item.name);
            results.push({
              name: item.name,
              path: fullPath,
              isDirectory: false,
              isFile: true,
              size: stats.size,
              modified: stats.mtime,
              isHidden,
              matchContext: contentResult.context,
              matchLineNumber: contentResult.lineNumber,
            });
          }
        } catch {}
      }

      if (item.isDirectory() && results.length < maxResults) {
        try {
          await searchDirectoryForContent(
            fullPath,
            searchQuery,
            filters,
            results,
            depth + 1,
            maxDepth,
            maxResults
          );
        } catch {}
      }
    }
  } catch {}
}

export function setupSearchHandlers(): void {
  const fileTasks = getFileTasks();
  const indexerTasks = getIndexerTasks();

  ipcMain.handle(
    'search-files',
    async (
      _event: IpcMainInvokeEvent,
      dirPath: string,
      query: string,
      filters?: SearchFilters,
      operationId?: string
    ): Promise<{ success: boolean; results?: FileItem[]; error?: string }> => {
      try {
        if (!isPathSafe(dirPath)) {
          return { success: false, error: 'Invalid directory path' };
        }
        const results = await fileTasks.runTask<FileItem[]>(
          'search-files',
          {
            dirPath,
            query,
            filters,
            maxDepth: 10,
            maxResults: 100,
          },
          operationId
        );
        return { success: true, results };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    }
  );

  ipcMain.handle(
    'search-files-content',
    async (
      _event: IpcMainInvokeEvent,
      dirPath: string,
      query: string,
      filters?: SearchFilters,
      operationId?: string
    ): Promise<{ success: boolean; results?: ContentSearchResult[]; error?: string }> => {
      try {
        if (!isPathSafe(dirPath)) {
          return { success: false, error: 'Invalid directory path' };
        }

        const results = await fileTasks.runTask<ContentSearchResult[]>(
          'search-content',
          {
            dirPath,
            query,
            filters,
            maxDepth: 10,
            maxResults: 100,
          },
          operationId
        );
        return { success: true, results };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    }
  );

  ipcMain.handle(
    'search-files-content-global',
    async (
      _event: IpcMainInvokeEvent,
      query: string,
      filters?: SearchFilters,
      operationId?: string
    ): Promise<{ success: boolean; results?: ContentSearchResult[]; error?: string }> => {
      try {
        const fileIndexer = getFileIndexer();
        if (!fileIndexer) {
          return { success: false, error: 'Indexer not initialized' };
        }
        if (!fileIndexer.isEnabled()) {
          return { success: false, error: 'Indexer is disabled' };
        }
        const MAX_RESULTS = 100;
        const indexPath = path.join(app.getPath('userData'), 'file-index.json');
        const searchTasks = indexerTasks ?? fileTasks;

        const results = await searchTasks.runTask<ContentSearchResult[]>(
          'search-content-index',
          {
            indexPath,
            query,
            filters,
            maxResults: MAX_RESULTS,
          },
          operationId
        );

        return { success: true, results };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    }
  );

  ipcMain.handle(
    'cancel-search',
    async (_event: IpcMainInvokeEvent, operationId: string): Promise<ApiResponse> => {
      try {
        if (!operationId) {
          return { success: false, error: 'Missing operationId' };
        }
        fileTasks.cancelOperation(operationId);
        indexerTasks?.cancelOperation(operationId);
        return { success: true };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    'search-index',
    async (
      _event: IpcMainInvokeEvent,
      query: string,
      operationId?: string
    ): Promise<IndexSearchResponse> => {
      try {
        const fileIndexer = getFileIndexer();
        if (!fileIndexer) {
          return { success: false, error: 'Indexer not initialized' };
        }

        if (!fileIndexer.isEnabled()) {
          return { success: false, error: 'Indexer is disabled' };
        }

        const MAX_RESULTS = 100;
        const indexPath = path.join(app.getPath('userData'), 'file-index.json');
        const searchTasks = indexerTasks ?? fileTasks;

        const results = await searchTasks.runTask<IndexEntry[]>(
          'search-index',
          {
            indexPath,
            query,
            maxResults: MAX_RESULTS,
          },
          operationId
        );

        return { success: true, results };
      } catch (error) {
        console.error('[Indexer] Search error:', error);
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle('rebuild-index', async (): Promise<ApiResponse> => {
    try {
      const fileIndexer = getFileIndexer();
      if (!fileIndexer) {
        return { success: false, error: 'Indexer not initialized' };
      }

      console.log('[Indexer] Rebuild requested');
      await fileIndexer.rebuildIndex();
      return { success: true };
    } catch (error) {
      console.error('[Indexer] Rebuild error:', error);
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle(
    'get-index-status',
    async (): Promise<{ success: boolean; status?: any; error?: string }> => {
      try {
        const fileIndexer = getFileIndexer();
        if (!fileIndexer) {
          return { success: false, error: 'Indexer not initialized' };
        }

        const status = fileIndexer.getStatus();
        return { success: true, status };
      } catch (error) {
        console.error('[Indexer] Status error:', error);
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );
}
