import { BrowserWindow, Tray } from 'electron';
import * as os from 'os';
import { FileIndexer } from './indexer';
import { FileTaskManager } from './fileTasks';

export const MAX_UNDO_STACK_SIZE = 50;
export const HIDDEN_FILE_CACHE_TTL = 300000;
export const HIDDEN_FILE_CACHE_MAX = 5000;
export const SETTINGS_CACHE_TTL_MS = 5000;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.0;
export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
export const MAX_DATA_URL_BYTES = 10 * 1024 * 1024;

const CPU_COUNT = Math.max(1, os.cpus().length);
const TOTAL_MEM_GB = os.totalmem() / 1024 ** 3;
const MAX_WORKERS = TOTAL_MEM_GB < 6 ? 2 : TOTAL_MEM_GB < 12 ? 4 : TOTAL_MEM_GB < 24 ? 6 : 8;
const BASE_WORKER_COUNT = Math.max(1, Math.min(CPU_COUNT, MAX_WORKERS));
const INDEXER_WORKER_COUNT = 1;
const UI_WORKER_COUNT = Math.max(1, BASE_WORKER_COUNT);

const fileTasks = new FileTaskManager(UI_WORKER_COUNT);
const indexerTasks = new FileTaskManager(INDEXER_WORKER_COUNT);

let mainWindow: BrowserWindow | null = null;
let fileIndexer: FileIndexer | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let currentTrayState: 'idle' | 'active' | 'notification' = 'idle';
let trayAssetsPath: string = '';
let shouldStartHidden = false;

let sharedClipboard: { operation: 'copy' | 'cut'; paths: string[] } | null = null;
const windowDragData = new WeakMap<Electron.WebContents, { paths: string[] }>();

const isDev = process.argv.includes('--dev');

export function getFileTasks(): FileTaskManager {
  return fileTasks;
}

export function getIndexerTasks(): FileTaskManager {
  return indexerTasks;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function getActiveWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const allWindows = BrowserWindow.getAllWindows();
  return allWindows.length > 0 ? allWindows[0] : null;
}

export function getFileIndexer(): FileIndexer | null {
  return fileIndexer;
}

export function setFileIndexer(indexer: FileIndexer | null): void {
  fileIndexer = indexer;
}

export function getTray(): Tray | null {
  return tray;
}

export function setTray(t: Tray | null): void {
  tray = t;
}

export function getIsQuitting(): boolean {
  return isQuitting;
}

export function setIsQuitting(quitting: boolean): void {
  isQuitting = quitting;
}

export function getCurrentTrayState(): 'idle' | 'active' | 'notification' {
  return currentTrayState;
}

export function setCurrentTrayState(state: 'idle' | 'active' | 'notification'): void {
  currentTrayState = state;
}

export function getTrayAssetsPath(): string {
  return trayAssetsPath;
}

export function setTrayAssetsPath(path: string): void {
  trayAssetsPath = path;
}

export function getShouldStartHidden(): boolean {
  return shouldStartHidden;
}

export function setShouldStartHidden(hidden: boolean): void {
  shouldStartHidden = hidden;
}

export function getSharedClipboard(): { operation: 'copy' | 'cut'; paths: string[] } | null {
  return sharedClipboard;
}

export function setSharedClipboard(
  clipboard: { operation: 'copy' | 'cut'; paths: string[] } | null
): void {
  sharedClipboard = clipboard;
}

export function getWindowDragData(webContents: Electron.WebContents): { paths: string[] } | null {
  return windowDragData.get(webContents) || null;
}

export function setWindowDragData(
  webContents: Electron.WebContents,
  data: { paths: string[] } | null
): void {
  if (data === null) {
    windowDragData.delete(webContents);
  } else {
    windowDragData.set(webContents, data);
  }
}

export function clearWindowDragData(webContents: Electron.WebContents): void {
  windowDragData.delete(webContents);
}

export function getIsDev(): boolean {
  return isDev;
}

export function broadcastToAllWindows(channel: string, data?: any): void {
  const allWindows = BrowserWindow.getAllWindows();
  for (const win of allWindows) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send(channel, data);
      } catch (error) {
        console.warn(`[Broadcast] Failed to send to window:`, error);
      }
    }
  }
}
