import { BrowserWindow } from 'electron';
import type { WebContents } from 'electron';
import { getMainWindow, getFileTasks } from './appState';

const directoryOperationTargets = new Map<string, WebContents>();

export function safeSendToWindow(
  win: BrowserWindow | null,
  channel: string,
  ...args: any[]
): boolean {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, ...args);
      return true;
    }
  } catch (error) {
    console.error(`[IPC] Failed to send ${channel}:`, error);
  }
  return false;
}

export function safeSendToContents(
  contents: WebContents | null,
  channel: string,
  ...args: any[]
): boolean {
  try {
    if (contents && !contents.isDestroyed()) {
      contents.send(channel, ...args);
      return true;
    }
  } catch (error) {
    console.error(`[IPC] Failed to send ${channel}:`, error);
  }
  return false;
}

export function registerDirectoryOperationTarget(operationId: string, sender: WebContents): void {
  directoryOperationTargets.set(operationId, sender);
}

export function unregisterDirectoryOperationTarget(operationId: string): void {
  directoryOperationTargets.delete(operationId);
}

export function getDirectoryOperationTarget(operationId: string): WebContents | undefined {
  return directoryOperationTargets.get(operationId);
}

export function setupFileTasksProgressHandler(
  activeFolderSizeCalculations: Map<string, { aborted: boolean }>,
  activeChecksumCalculations: Map<string, { aborted: boolean }>
): void {
  const fileTasks = getFileTasks();

  fileTasks.on('progress', (message: { task: string; operationId: string; data: any }) => {
    const mainWindow = getMainWindow();

    if (message.task === 'folder-size') {
      if (activeFolderSizeCalculations.has(message.operationId)) {
        safeSendToWindow(mainWindow, 'folder-size-progress', {
          operationId: message.operationId,
          ...message.data,
        });
      }
      return;
    }
    if (message.task === 'checksum') {
      if (activeChecksumCalculations.has(message.operationId)) {
        safeSendToWindow(mainWindow, 'checksum-progress', {
          operationId: message.operationId,
          ...message.data,
        });
      }
      return;
    }
    if (message.task === 'list-directory') {
      const target = directoryOperationTargets.get(message.operationId) || null;
      const sent = safeSendToContents(target, 'directory-contents-progress', {
        operationId: message.operationId,
        ...message.data,
      });
      if (!sent) {
        directoryOperationTargets.delete(message.operationId);
      }
    }
  });
}
