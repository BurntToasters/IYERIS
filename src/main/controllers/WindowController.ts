import { ipcMain, BrowserWindow, IpcMainInvokeEvent } from 'electron';

export function setupWindowControllers(createWindowAction: (isInitial: boolean) => BrowserWindow) {
  ipcMain.handle('minimize-window', (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });

  ipcMain.handle('maximize-window', (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  ipcMain.handle('close-window', (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });

  ipcMain.handle('open-new-window', () => {
    createWindowAction(false);
  });
}
