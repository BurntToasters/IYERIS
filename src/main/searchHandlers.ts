import { ipcMain, app, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import type { FileItem, ApiResponse, IndexSearchResponse, IndexEntry, IndexStatus } from './types';
import { getFileTasks, getIndexerTasks, getFileIndexer } from './appState';
import { isPathSafe, getErrorMessage } from './security';
import { isTrustedIpcEvent } from './ipcUtils';

interface SearchFilters {
  fileType?: string;
  minSize?: number;
  maxSize?: number;
  dateFrom?: string;
  dateTo?: string;
}

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

export function setupSearchHandlers(): void {
  const fileTasks = getFileTasks();
  const indexerTasks = getIndexerTasks();

  ipcMain.handle(
    'search-files',
    async (
      event: IpcMainInvokeEvent,
      dirPath: string,
      query: string,
      filters?: SearchFilters,
      operationId?: string
    ): Promise<{ success: boolean; results?: FileItem[]; error?: string }> => {
      try {
        if (!isTrustedIpcEvent(event, 'search-files')) {
          return { success: false, error: 'Untrusted IPC sender' };
        }
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
      event: IpcMainInvokeEvent,
      dirPath: string,
      query: string,
      filters?: SearchFilters,
      operationId?: string
    ): Promise<{ success: boolean; results?: ContentSearchResult[]; error?: string }> => {
      try {
        if (!isTrustedIpcEvent(event, 'search-files-content')) {
          return { success: false, error: 'Untrusted IPC sender' };
        }
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
      event: IpcMainInvokeEvent,
      query: string,
      filters?: SearchFilters,
      operationId?: string
    ): Promise<{ success: boolean; results?: ContentSearchResult[]; error?: string }> => {
      try {
        if (!isTrustedIpcEvent(event, 'search-files-content-global')) {
          return { success: false, error: 'Untrusted IPC sender' };
        }
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
    async (event: IpcMainInvokeEvent, operationId: string): Promise<ApiResponse> => {
      try {
        if (!isTrustedIpcEvent(event, 'cancel-search')) {
          return { success: false, error: 'Untrusted IPC sender' };
        }
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
      event: IpcMainInvokeEvent,
      query: string,
      operationId?: string
    ): Promise<IndexSearchResponse> => {
      try {
        if (!isTrustedIpcEvent(event, 'search-index')) {
          return { success: false, error: 'Untrusted IPC sender' };
        }
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

  ipcMain.handle('rebuild-index', async (event: IpcMainInvokeEvent): Promise<ApiResponse> => {
    try {
      if (!isTrustedIpcEvent(event, 'rebuild-index')) {
        return { success: false, error: 'Untrusted IPC sender' };
      }
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
    async (
      event: IpcMainInvokeEvent
    ): Promise<{ success: boolean; status?: IndexStatus; error?: string }> => {
      try {
        if (!isTrustedIpcEvent(event, 'get-index-status')) {
          return { success: false, error: 'Untrusted IPC sender' };
        }
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
