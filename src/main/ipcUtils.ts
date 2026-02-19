import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { WebContents } from 'electron';
import { getMainWindow, getFileTasks } from './appState';
import { isRecord } from '../shared';
import { isTrustedIpcSender } from './security';
import { logger } from './logger';

const directoryOperationTargets = new Map<string, WebContents>();
const progressTargets = new Map<string, WebContents>();

export function safeSendToWindow(
  win: BrowserWindow | null,
  channel: string,
  ...args: unknown[]
): boolean {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, ...args);
      return true;
    }
  } catch (error) {
    logger.error(`[IPC] Failed to send ${channel}:`, error);
  }
  return false;
}

export function safeSendToContents(
  contents: WebContents | null,
  channel: string,
  ...args: unknown[]
): boolean {
  try {
    if (contents && !contents.isDestroyed()) {
      contents.send(channel, ...args);
      return true;
    }
  } catch (error) {
    logger.error(`[IPC] Failed to send ${channel}:`, error);
  }
  return false;
}

export function registerDirectoryOperationTarget(operationId: string, sender: WebContents): void {
  directoryOperationTargets.set(operationId, sender);
}

export function unregisterDirectoryOperationTarget(operationId: string): void {
  directoryOperationTargets.delete(operationId);
}

export function registerProgressTarget(operationId: string, sender: WebContents): void {
  progressTargets.set(operationId, sender);
  sender.once('destroyed', () => {
    progressTargets.delete(operationId);
  });
}

export function unregisterProgressTarget(operationId: string): void {
  progressTargets.delete(operationId);
}

export function setupFileTasksProgressHandler(
  activeFolderSizeCalculations: Map<string, { aborted: boolean }>,
  activeChecksumCalculations: Map<string, { aborted: boolean }>
): void {
  const fileTasks = getFileTasks();

  fileTasks.on('progress', (message: { task: string; operationId: string; data: unknown }) => {
    const data = isRecord(message.data) ? message.data : {};

    if (message.task === 'folder-size') {
      if (activeFolderSizeCalculations.has(message.operationId)) {
        const target = progressTargets.get(message.operationId) || null;
        const fallbackWindow = getMainWindow();
        const sent = target
          ? safeSendToContents(target, 'folder-size-progress', {
              operationId: message.operationId,
              ...data,
            })
          : safeSendToWindow(fallbackWindow, 'folder-size-progress', {
              operationId: message.operationId,
              ...data,
            });
        if (!sent) {
          progressTargets.delete(message.operationId);
        }
      }
      return;
    }
    if (message.task === 'checksum') {
      if (activeChecksumCalculations.has(message.operationId)) {
        const target = progressTargets.get(message.operationId) || null;
        const fallbackWindow = getMainWindow();
        const sent = target
          ? safeSendToContents(target, 'checksum-progress', {
              operationId: message.operationId,
              ...data,
            })
          : safeSendToWindow(fallbackWindow, 'checksum-progress', {
              operationId: message.operationId,
              ...data,
            });
        if (!sent) {
          progressTargets.delete(message.operationId);
        }
      }
      return;
    }
    if (message.task === 'list-directory') {
      const target = directoryOperationTargets.get(message.operationId) || null;
      const sent = safeSendToContents(target, 'directory-contents-progress', {
        operationId: message.operationId,
        ...data,
      });
      if (!sent) {
        directoryOperationTargets.delete(message.operationId);
      }
    }
  });
}

export function isTrustedIpcEvent(event: IpcMainInvokeEvent, channel?: string): boolean {
  if (isTrustedIpcSender(event)) {
    return true;
  }
  const url = event.senderFrame?.url || event.sender?.getURL?.() || '';
  if (channel) {
    logger.warn(`[Security] Blocked IPC ${channel} from:`, url);
  } else {
    logger.warn('[Security] Blocked IPC from:', url);
  }
  return false;
}

export function withTrustedIpcEvent<TArgs extends unknown[], TResult>(
  channel: string,
  untrustedResponse: TResult,
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult | Promise<TResult>
): (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> {
  return async (event: IpcMainInvokeEvent, ...args: TArgs): Promise<TResult> => {
    if (!isTrustedIpcEvent(event, channel)) {
      return untrustedResponse;
    }
    return handler(event, ...args);
  };
}

type IpcOperationResult = { success: boolean; error?: string };

export function withTrustedApiHandler<TArgs extends unknown[], TResult extends IpcOperationResult>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult,
  untrustedResponse: TResult = { success: false, error: 'Untrusted IPC sender' } as TResult
): (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> {
  return async (event: IpcMainInvokeEvent, ...args: TArgs): Promise<TResult> => {
    if (!isTrustedIpcEvent(event, channel)) {
      return untrustedResponse;
    }
    try {
      return await handler(event, ...args);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      } as TResult;
    }
  };
}
