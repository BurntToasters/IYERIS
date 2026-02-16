import { ipcMain, BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { ApiResponse } from '../types';
import { ZOOM_MIN, ZOOM_MAX } from './appState';
import { getErrorMessage } from './security';
import { logger } from './logger';
import { isTrustedIpcEvent } from './ipcUtils';

export function setupZoomHandlers(): void {
  ipcMain.handle(
    'set-zoom-level',
    async (event: IpcMainInvokeEvent, zoomLevel: number): Promise<ApiResponse> => {
      try {
        if (!isTrustedIpcEvent(event, 'set-zoom-level')) {
          return { success: false, error: 'Untrusted IPC sender' };
        }
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || win.isDestroyed()) {
          return { success: false, error: 'Window not available' };
        }

        const clampedZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomLevel));
        win.webContents.setZoomFactor(clampedZoom);

        logger.debug('[Zoom] Set zoom level to:', clampedZoom);
        return { success: true };
      } catch (error) {
        logger.error('[Zoom] Error:', error);
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    'get-zoom-level',
    async (
      event: IpcMainInvokeEvent
    ): Promise<{ success: boolean; zoomLevel?: number; error?: string }> => {
      try {
        if (!isTrustedIpcEvent(event, 'get-zoom-level')) {
          return { success: false, error: 'Untrusted IPC sender' };
        }
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || win.isDestroyed()) {
          return { success: false, error: 'Window not available' };
        }

        const zoomLevel = win.webContents.getZoomFactor();
        return { success: true, zoomLevel };
      } catch (error) {
        logger.error('[Zoom] Error:', error);
        return { success: false, error: getErrorMessage(error) };
      }
    }
  );
}
