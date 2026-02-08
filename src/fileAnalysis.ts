import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { getFileTasks } from './appState';
import { isPathSafe, getErrorMessage } from './security';
import { logger } from './utils/logger';
import { isTrustedIpcEvent } from './ipcUtils';

const activeFolderSizeCalculations = new Map<string, { aborted: boolean }>();
const activeChecksumCalculations = new Map<string, { aborted: boolean }>();

export function getActiveFolderSizeCalculations(): Map<string, { aborted: boolean }> {
  return activeFolderSizeCalculations;
}

export function getActiveChecksumCalculations(): Map<string, { aborted: boolean }> {
  return activeChecksumCalculations;
}

export function setupFileAnalysisHandlers(): void {
  const fileTasks = getFileTasks();

  ipcMain.handle(
    'calculate-folder-size',
    async (
      event: IpcMainInvokeEvent,
      folderPath: string,
      operationId: string
    ): Promise<{
      success: boolean;
      result?: {
        totalSize: number;
        fileCount: number;
        folderCount: number;
        fileTypes?: { extension: string; count: number; size: number }[];
      };
      error?: string;
    }> => {
      try {
        if (!isTrustedIpcEvent(event, 'calculate-folder-size')) {
          return { success: false, error: 'Untrusted IPC sender' };
        }
        if (!isPathSafe(folderPath)) {
          return { success: false, error: 'Invalid folder path' };
        }
        logger.debug(
          '[FolderSize] Starting calculation for:',
          folderPath,
          'operationId:',
          operationId
        );

        const operation = { aborted: false };
        activeFolderSizeCalculations.set(operationId, operation);

        const result = await fileTasks.runTask<{
          totalSize: number;
          fileCount: number;
          folderCount: number;
          fileTypes?: { extension: string; count: number; size: number }[];
        }>('folder-size', { folderPath, operationId }, operationId);

        activeFolderSizeCalculations.delete(operationId);
        logger.debug('[FolderSize] Completed:', {
          totalSize: result.totalSize,
          fileCount: result.fileCount,
          folderCount: result.folderCount,
          fileTypes: result.fileTypes?.length || 0,
        });
        return { success: true, result };
      } catch (error) {
        activeFolderSizeCalculations.delete(operationId);
        const errorMessage = getErrorMessage(error);
        if (errorMessage === 'Calculation cancelled') {
          logger.debug('[FolderSize] Calculation cancelled for operationId:', operationId);
          return { success: false, error: 'Calculation cancelled' };
        }
        console.error('[FolderSize] Error:', error);
        return { success: false, error: errorMessage };
      }
    }
  );

  ipcMain.handle(
    'cancel-folder-size-calculation',
    async (
      event: IpcMainInvokeEvent,
      operationId: string
    ): Promise<{ success: boolean; error?: string }> => {
      if (!isTrustedIpcEvent(event, 'cancel-folder-size-calculation')) {
        return { success: false, error: 'Untrusted IPC sender' };
      }
      const operation = activeFolderSizeCalculations.get(operationId);
      if (operation) {
        operation.aborted = true;
        fileTasks.cancelOperation(operationId);
        activeFolderSizeCalculations.delete(operationId);
        logger.debug('[FolderSize] Cancellation requested for operationId:', operationId);
        return { success: true };
      }
      return { success: false, error: 'Operation not found' };
    }
  );

  ipcMain.handle(
    'calculate-checksum',
    async (
      event: IpcMainInvokeEvent,
      filePath: string,
      operationId: string,
      algorithms: string[]
    ): Promise<{
      success: boolean;
      result?: { md5?: string; sha256?: string };
      error?: string;
    }> => {
      try {
        if (!isTrustedIpcEvent(event, 'calculate-checksum')) {
          return { success: false, error: 'Untrusted IPC sender' };
        }
        if (!isPathSafe(filePath)) {
          return { success: false, error: 'Invalid file path' };
        }
        logger.debug(
          '[Checksum] Starting calculation for:',
          filePath,
          'algorithms:',
          algorithms,
          'operationId:',
          operationId
        );

        const operation = { aborted: false };
        activeChecksumCalculations.set(operationId, operation);

        const result = await fileTasks.runTask<{ md5?: string; sha256?: string }>(
          'checksum',
          { filePath, operationId, algorithms },
          operationId
        );

        activeChecksumCalculations.delete(operationId);
        logger.debug('[Checksum] Completed:', result);
        return { success: true, result };
      } catch (error) {
        activeChecksumCalculations.delete(operationId);
        const errorMessage = getErrorMessage(error);
        if (errorMessage === 'Calculation cancelled') {
          logger.debug('[Checksum] Calculation cancelled for operationId:', operationId);
          return { success: false, error: 'Calculation cancelled' };
        }
        console.error('[Checksum] Error:', error);
        return { success: false, error: errorMessage };
      }
    }
  );

  ipcMain.handle(
    'cancel-checksum-calculation',
    async (
      event: IpcMainInvokeEvent,
      operationId: string
    ): Promise<{ success: boolean; error?: string }> => {
      if (!isTrustedIpcEvent(event, 'cancel-checksum-calculation')) {
        return { success: false, error: 'Untrusted IPC sender' };
      }
      const operation = activeChecksumCalculations.get(operationId);
      if (operation) {
        operation.aborted = true;
        fileTasks.cancelOperation(operationId);
        activeChecksumCalculations.delete(operationId);
        logger.debug('[Checksum] Cancellation requested for operationId:', operationId);
        return { success: true };
      }
      return { success: false, error: 'Operation not found' };
    }
  );
}

export function cleanupFileAnalysis(): void {
  const fileTasks = getFileTasks();

  for (const [operationId, operation] of activeFolderSizeCalculations) {
    logger.debug('[Cleanup] Aborting folder size calculation:', operationId);
    operation.aborted = true;
    fileTasks.cancelOperation(operationId);
  }
  activeFolderSizeCalculations.clear();

  for (const [operationId, operation] of activeChecksumCalculations) {
    logger.debug('[Cleanup] Aborting checksum calculation:', operationId);
    operation.aborted = true;
    fileTasks.cancelOperation(operationId);
  }
  activeChecksumCalculations.clear();
}
