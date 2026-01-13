import { ipcMain, BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { ApiResponse } from './types';
import { ZOOM_MIN, ZOOM_MAX } from './appState';
import { getErrorMessage } from './security';

export function setupZoomHandlers(): void {
  ipcMain.handle('set-zoom-level', async (event: IpcMainInvokeEvent, zoomLevel: number): Promise<ApiResponse> => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Window not available' };
      }

      const clampedZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomLevel));
      win.webContents.setZoomFactor(clampedZoom);

      console.log('[Zoom] Set zoom level to:', clampedZoom);
      return { success: true };
    } catch (error) {
      console.error('[Zoom] Error:', error);
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('get-zoom-level', async (event: IpcMainInvokeEvent): Promise<{ success: boolean; zoomLevel?: number; error?: string }> => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Window not available' };
      }

      const zoomLevel = win.webContents.getZoomFactor();
      return { success: true, zoomLevel };
    } catch (error) {
      console.error('[Zoom] Error:', error);
      return { success: false, error: getErrorMessage(error) };
    }
  });
}
