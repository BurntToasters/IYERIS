import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  Tray: vi.fn(),
}));

vi.mock('os', () => ({
  default: {
    cpus: () => [{ model: 'test' }],
    totalmem: () => 8 * 1024 ** 3,
  },
  cpus: () => [{ model: 'test' }],
  totalmem: () => 8 * 1024 ** 3,
}));

vi.mock('../main/indexer', () => ({
  FileIndexer: vi.fn(),
}));

vi.mock('../main/fileTasks', () => {
  class MockFileTaskManager {
    on = vi.fn();
    off = vi.fn();
    removeAllListeners = vi.fn();
    constructor() {}
  }
  return { FileTaskManager: MockFileTaskManager };
});

import {
  getMainWindow,
  setMainWindow,
  getFileIndexer,
  setFileIndexer,
  getTray,
  setTray,
  getIsQuitting,
  setIsQuitting,
  getCurrentTrayState,
  setCurrentTrayState,
  getTrayAssetsPath,
  setTrayAssetsPath,
  getShouldStartHidden,
  setShouldStartHidden,
  getSharedClipboard,
  setSharedClipboard,
  getWindowDragData,
  setWindowDragData,
  clearWindowDragData,
  getIsDev,
  getFileTasks,
  getIndexerTasks,
  getActiveWindow,
  ZOOM_MIN,
  ZOOM_MAX,
} from '../main/appState';

describe('appState getters/setters', () => {
  describe('mainWindow', () => {
    it('starts as null', () => {
      setMainWindow(null);
      expect(getMainWindow()).toBe(null);
    });

    it('can be set and retrieved', () => {
      const mockWindow = {
        isDestroyed: () => false,
      } as unknown as import('electron').BrowserWindow;
      setMainWindow(mockWindow);
      expect(getMainWindow()).toBe(mockWindow);
      setMainWindow(null);
    });
  });

  describe('fileIndexer', () => {
    it('starts as null', () => {
      expect(getFileIndexer()).toBe(null);
    });

    it('can be set and retrieved', () => {
      const mockIndexer = {} as unknown as import('../main/indexer').FileIndexer;
      setFileIndexer(mockIndexer);
      expect(getFileIndexer()).toBe(mockIndexer);
      setFileIndexer(null);
    });
  });

  describe('tray', () => {
    it('starts as null', () => {
      expect(getTray()).toBe(null);
    });

    it('can be set and retrieved', () => {
      const mockTray = {} as unknown as import('electron').Tray;
      setTray(mockTray);
      expect(getTray()).toBe(mockTray);
      setTray(null);
    });
  });

  describe('isQuitting', () => {
    it('starts as false', () => {
      expect(getIsQuitting()).toBe(false);
    });

    it('can be toggled', () => {
      setIsQuitting(true);
      expect(getIsQuitting()).toBe(true);
      setIsQuitting(false);
      expect(getIsQuitting()).toBe(false);
    });
  });

  describe('currentTrayState', () => {
    it('starts as idle', () => {
      expect(getCurrentTrayState()).toBe('idle');
    });

    it('can be set to different states', () => {
      setCurrentTrayState('active');
      expect(getCurrentTrayState()).toBe('active');
      setCurrentTrayState('notification');
      expect(getCurrentTrayState()).toBe('notification');
      setCurrentTrayState('idle');
    });
  });

  describe('trayAssetsPath', () => {
    it('starts as empty string', () => {
      expect(getTrayAssetsPath()).toBe('');
    });

    it('can be set and retrieved', () => {
      setTrayAssetsPath('/path/to/assets');
      expect(getTrayAssetsPath()).toBe('/path/to/assets');
      setTrayAssetsPath('');
    });
  });

  describe('shouldStartHidden', () => {
    it('starts as false', () => {
      expect(getShouldStartHidden()).toBe(false);
    });

    it('can be toggled', () => {
      setShouldStartHidden(true);
      expect(getShouldStartHidden()).toBe(true);
      setShouldStartHidden(false);
    });
  });

  describe('sharedClipboard', () => {
    it('starts as null', () => {
      expect(getSharedClipboard()).toBe(null);
    });

    it('can store copy operations', () => {
      setSharedClipboard({ operation: 'copy', paths: ['/a', '/b'] });
      const clip = getSharedClipboard();
      expect(clip).toEqual({ operation: 'copy', paths: ['/a', '/b'] });
    });

    it('can store cut operations', () => {
      setSharedClipboard({ operation: 'cut', paths: ['/x'] });
      expect(getSharedClipboard()!.operation).toBe('cut');
    });

    it('can be cleared', () => {
      setSharedClipboard({ operation: 'copy', paths: ['/a'] });
      setSharedClipboard(null);
      expect(getSharedClipboard()).toBe(null);
    });
  });

  describe('windowDragData', () => {
    it('returns null for unknown webContents', () => {
      const mockContents = {} as unknown as import('electron').WebContents;
      expect(getWindowDragData(mockContents)).toBe(null);
    });

    it('can set and retrieve drag data', () => {
      const mockContents = {} as unknown as import('electron').WebContents;
      setWindowDragData(mockContents, { paths: ['/file1.txt'] });
      expect(getWindowDragData(mockContents)).toEqual({ paths: ['/file1.txt'] });
    });

    it('can clear drag data with null', () => {
      const mockContents = {} as unknown as import('electron').WebContents;
      setWindowDragData(mockContents, { paths: ['/file1.txt'] });
      setWindowDragData(mockContents, null);
      expect(getWindowDragData(mockContents)).toBe(null);
    });

    it('can clear drag data with clearWindowDragData', () => {
      const mockContents = {} as unknown as import('electron').WebContents;
      setWindowDragData(mockContents, { paths: ['/file.txt'] });
      clearWindowDragData(mockContents);
      expect(getWindowDragData(mockContents)).toBe(null);
    });
  });

  describe('isDev', () => {
    it('returns a boolean', () => {
      expect(typeof getIsDev()).toBe('boolean');
    });
  });

  describe('fileTasks and indexerTasks', () => {
    it('returns fileTasks manager', () => {
      const tasks = getFileTasks();
      expect(tasks).toBeDefined();
    });

    it('returns indexerTasks manager', () => {
      const tasks = getIndexerTasks();
      expect(tasks).toBeDefined();
    });
  });

  describe('getActiveWindow', () => {
    it('returns mainWindow if not destroyed', () => {
      const mockWindow = {
        isDestroyed: () => false,
      } as unknown as import('electron').BrowserWindow;
      setMainWindow(mockWindow);
      expect(getActiveWindow()).toBe(mockWindow);
      setMainWindow(null);
    });

    it('returns null when no windows exist', () => {
      setMainWindow(null);
      const result = getActiveWindow();

      expect(result).toBe(null);
    });
  });

  describe('ZOOM constants', () => {
    it('ZOOM_MIN is less than ZOOM_MAX', () => {
      expect(ZOOM_MIN).toBeLessThan(ZOOM_MAX);
    });
  });
});
