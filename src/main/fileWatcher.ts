import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import * as fs from 'fs';
import { isTrustedIpcEvent } from './ipcUtils';
import { isPathSafe } from './security';
import { logger } from './logger';
import { ignoreError } from '../shared';

const DEBOUNCE_MS = 300;
const MAX_DEBOUNCE_MS = 2000;

interface WatcherEntry {
  watcher: fs.FSWatcher;
  sender: Electron.WebContents;
  dirPath: string;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  firstEventTime: number;
}

const activeWatchers = new Map<number, WatcherEntry>();

function cleanupWatcher(senderId: number): void {
  const entry = activeWatchers.get(senderId);
  if (!entry) return;
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  try {
    entry.watcher.close();
  } catch (error) {
    ignoreError(error);
  }
  activeWatchers.delete(senderId);
}

function notifyChanged(entry: WatcherEntry): void {
  try {
    if (!entry.sender.isDestroyed()) {
      entry.sender.send('directory-changed', { dirPath: entry.dirPath });
    }
  } catch (error) {
    ignoreError(error);
  }
  entry.firstEventTime = 0;
}

export function setupFileWatcherHandlers(): void {
  ipcMain.handle('watch-directory', (event: IpcMainInvokeEvent, dirPath: string): boolean => {
    if (!isTrustedIpcEvent(event, 'watch-directory')) return false;
    if (!isPathSafe(dirPath)) return false;

    const senderId = event.sender.id;
    cleanupWatcher(senderId);

    try {
      const watcher = fs.watch(dirPath, { persistent: false }, (_eventType, filename) => {
        if (!filename) return;
        const entry = activeWatchers.get(senderId);
        if (!entry) return;

        const now = Date.now();
        if (entry.firstEventTime === 0) {
          entry.firstEventTime = now;
        }

        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);

        if (now - entry.firstEventTime >= MAX_DEBOUNCE_MS) {
          notifyChanged(entry);
          return;
        }

        entry.debounceTimer = setTimeout(() => {
          entry.debounceTimer = null;
          notifyChanged(entry);
        }, DEBOUNCE_MS);
      });

      watcher.on('error', (error) => {
        logger.debug('[FileWatcher] Watcher error for', dirPath, error.message);
        cleanupWatcher(senderId);
      });

      activeWatchers.set(senderId, {
        watcher,
        sender: event.sender,
        dirPath,
        debounceTimer: null,
        firstEventTime: 0,
      });

      event.sender.once('destroyed', () => cleanupWatcher(senderId));

      logger.debug('[FileWatcher] Watching:', dirPath);
      return true;
    } catch (error) {
      logger.debug('[FileWatcher] Failed to watch:', dirPath, (error as Error).message);
      return false;
    }
  });

  ipcMain.handle('unwatch-directory', (event: IpcMainInvokeEvent): void => {
    if (!isTrustedIpcEvent(event, 'unwatch-directory')) return;
    cleanupWatcher(event.sender.id);
  });
}

export function cleanupAllWatchers(): void {
  for (const senderId of activeWatchers.keys()) {
    cleanupWatcher(senderId);
  }
}
