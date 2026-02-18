import type { Tray } from 'electron';
import { BrowserWindow } from 'electron';
import * as os from 'os';
import type { FileIndexer } from './indexer';
import { FileTaskManager } from './fileTasks';

export const MAX_UNDO_STACK_SIZE = 50;
export const HIDDEN_FILE_CACHE_TTL = 300000;
export const HIDDEN_FILE_CACHE_MAX = 5000;
export const SETTINGS_CACHE_TTL_MS = 30000;
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

export interface AppContext {
  readonly fileTasks: FileTaskManager;
  readonly indexerTasks: FileTaskManager;
  readonly windowDragData: WeakMap<Electron.WebContents, { paths: string[] }>;

  mainWindow: BrowserWindow | null;
  fileIndexer: FileIndexer | null;
  tray: Tray | null;
  isQuitting: boolean;
  currentTrayState: 'idle' | 'active' | 'notification';
  trayAssetsPath: string;
  shouldStartHidden: boolean;
  sharedClipboard: { operation: 'copy' | 'cut'; paths: string[] } | null;
  isDev: boolean;
}

export function createAppContext(overrides?: Partial<AppContext>): AppContext {
  return {
    fileTasks: overrides?.fileTasks ?? new FileTaskManager(UI_WORKER_COUNT),
    indexerTasks: overrides?.indexerTasks ?? new FileTaskManager(INDEXER_WORKER_COUNT),
    windowDragData: overrides?.windowDragData ?? new WeakMap(),
    mainWindow: overrides?.mainWindow ?? null,
    fileIndexer: overrides?.fileIndexer ?? null,
    tray: overrides?.tray ?? null,
    isQuitting: overrides?.isQuitting ?? false,
    currentTrayState: overrides?.currentTrayState ?? 'idle',
    trayAssetsPath: overrides?.trayAssetsPath ?? '',
    shouldStartHidden: overrides?.shouldStartHidden ?? false,
    sharedClipboard: overrides?.sharedClipboard ?? null,
    isDev: overrides?.isDev ?? process.argv.includes('--dev'),
  };
}

const defaultContext = createAppContext();

export function getAppContext(): AppContext {
  return defaultContext;
}

export function getFileTasks(): FileTaskManager {
  return defaultContext.fileTasks;
}

export function getIndexerTasks(): FileTaskManager {
  return defaultContext.indexerTasks;
}

export function getMainWindow(): BrowserWindow | null {
  return defaultContext.mainWindow;
}

export function setMainWindow(win: BrowserWindow | null): void {
  defaultContext.mainWindow = win;
}

export function getActiveWindow(): BrowserWindow | null {
  if (defaultContext.mainWindow && !defaultContext.mainWindow.isDestroyed())
    return defaultContext.mainWindow;
  const allWindows = BrowserWindow.getAllWindows();
  return allWindows.length > 0 ? allWindows[0] : null;
}

export function getFileIndexer(): FileIndexer | null {
  return defaultContext.fileIndexer;
}

export function setFileIndexer(indexer: FileIndexer | null): void {
  defaultContext.fileIndexer = indexer;
}

export function getTray(): Tray | null {
  return defaultContext.tray;
}

export function setTray(t: Tray | null): void {
  defaultContext.tray = t;
}

export function getIsQuitting(): boolean {
  return defaultContext.isQuitting;
}

export function setIsQuitting(quitting: boolean): void {
  defaultContext.isQuitting = quitting;
}

export function getCurrentTrayState(): 'idle' | 'active' | 'notification' {
  return defaultContext.currentTrayState;
}

export function setCurrentTrayState(state: 'idle' | 'active' | 'notification'): void {
  defaultContext.currentTrayState = state;
}

export function getTrayAssetsPath(): string {
  return defaultContext.trayAssetsPath;
}

export function setTrayAssetsPath(path: string): void {
  defaultContext.trayAssetsPath = path;
}

export function getShouldStartHidden(): boolean {
  return defaultContext.shouldStartHidden;
}

export function setShouldStartHidden(hidden: boolean): void {
  defaultContext.shouldStartHidden = hidden;
}

export function getSharedClipboard(): { operation: 'copy' | 'cut'; paths: string[] } | null {
  return defaultContext.sharedClipboard;
}

export function setSharedClipboard(
  clipboard: { operation: 'copy' | 'cut'; paths: string[] } | null
): void {
  defaultContext.sharedClipboard = clipboard;
}

export function getWindowDragData(webContents: Electron.WebContents): { paths: string[] } | null {
  return defaultContext.windowDragData.get(webContents) || null;
}

export function setWindowDragData(
  webContents: Electron.WebContents,
  data: { paths: string[] } | null
): void {
  if (data === null) {
    defaultContext.windowDragData.delete(webContents);
  } else {
    defaultContext.windowDragData.set(webContents, data);
  }
}

export function clearWindowDragData(webContents: Electron.WebContents): void {
  defaultContext.windowDragData.delete(webContents);
}

export function getIsDev(): boolean {
  return defaultContext.isDev;
}
