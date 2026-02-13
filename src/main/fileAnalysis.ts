import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { getFileTasks } from './appState';
import { isPathSafe, getErrorMessage } from './security';
import { logger } from './logger';
import { isTrustedIpcEvent } from './ipcUtils';

const activeFolderSizeCalculations = new Map<string, { aborted: boolean }>();
const activeChecksumCalculations = new Map<string, { aborted: boolean }>();

export function getActiveFolderSizeCalculations(): Map<string, { aborted: boolean }> {
  return activeFolderSizeCalculations;
}

export function getActiveChecksumCalculations(): Map<string, { aborted: boolean }> {
  return activeChecksumCalculations;
}

function registerCalculationHandler<T>(
  channel: string,
  taskType: 'folder-size' | 'checksum',
  label: string,
  activeMap: Map<string, { aborted: boolean }>,
  buildPayload: (...args: unknown[]) => { path: string; payload: Record<string, unknown> }
): void {
  const fileTasks = getFileTasks();

  ipcMain.handle(
    channel,
    async (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ): Promise<{
      success: boolean;
      result?: T;
      error?: string;
    }> => {
      let operationId = '';
      try {
        if (!isTrustedIpcEvent(event, channel))
          return { success: false, error: 'Untrusted IPC sender' };
        const { path: itemPath, payload } = buildPayload(...args);
        operationId = payload.operationId as string;
        if (!isPathSafe(itemPath))
          return { success: false, error: `Invalid ${label.toLowerCase()} path` };
        logger.debug(`[${label}] Starting calculation for:`, itemPath, 'operationId:', operationId);

        activeMap.set(operationId, { aborted: false });
        const result = await fileTasks.runTask<T>(taskType, payload, operationId);
        activeMap.delete(operationId);
        logger.debug(`[${label}] Completed:`, result);
        return { success: true, result };
      } catch (error) {
        if (operationId) activeMap.delete(operationId);
        const errorMessage = getErrorMessage(error);
        if (errorMessage === 'Calculation cancelled') {
          logger.debug(`[${label}] Calculation cancelled for operationId:`, operationId);
          return { success: false, error: 'Calculation cancelled' };
        }
        console.error(`[${label}] Error:`, error);
        return { success: false, error: errorMessage };
      }
    }
  );
}

function registerCancelHandler(
  channel: string,
  label: string,
  activeMap: Map<string, { aborted: boolean }>
): void {
  const fileTasks = getFileTasks();

  ipcMain.handle(
    channel,
    async (
      event: IpcMainInvokeEvent,
      operationId: string
    ): Promise<{ success: boolean; error?: string }> => {
      if (!isTrustedIpcEvent(event, channel))
        return { success: false, error: 'Untrusted IPC sender' };
      const operation = activeMap.get(operationId);
      if (operation) {
        operation.aborted = true;
        fileTasks.cancelOperation(operationId);
        activeMap.delete(operationId);
        logger.debug(`[${label}] Cancellation requested for operationId:`, operationId);
        return { success: true };
      }
      return { success: false, error: 'Operation not found' };
    }
  );
}

export function setupFileAnalysisHandlers(): void {
  registerCalculationHandler<{
    totalSize: number;
    fileCount: number;
    folderCount: number;
    fileTypes?: { extension: string; count: number; size: number }[];
  }>(
    'calculate-folder-size',
    'folder-size',
    'FolderSize',
    activeFolderSizeCalculations,
    (folderPath, operationId) => ({
      path: folderPath as string,
      payload: { folderPath, operationId },
    })
  );

  registerCancelHandler(
    'cancel-folder-size-calculation',
    'FolderSize',
    activeFolderSizeCalculations
  );

  registerCalculationHandler<{ md5?: string; sha256?: string }>(
    'calculate-checksum',
    'checksum',
    'Checksum',
    activeChecksumCalculations,
    (filePath, operationId, algorithms) => ({
      path: filePath as string,
      payload: { filePath, operationId, algorithms },
    })
  );

  registerCancelHandler('cancel-checksum-calculation', 'Checksum', activeChecksumCalculations);
}

export function cleanupFileAnalysis(): void {
  const fileTasks = getFileTasks();
  const allMaps = [activeFolderSizeCalculations, activeChecksumCalculations];
  for (const map of allMaps) {
    for (const [operationId, operation] of map) {
      logger.debug('[Cleanup] Aborting calculation:', operationId);
      operation.aborted = true;
      fileTasks.cancelOperation(operationId);
    }
    map.clear();
  }
}
