import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebContents, BrowserWindow } from 'electron';

type ProgressCallback = (msg: { task: string; operationId: string; data: unknown }) => void;
let progressCallback: ProgressCallback | null = null;
let mockMainWindow: BrowserWindow | null = null;

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
}));

vi.mock('../main/appState', () => ({
  getMainWindow: vi.fn(() => mockMainWindow),
  getFileTasks: vi.fn(() => ({
    on: vi.fn((_event: string, cb: ProgressCallback) => {
      progressCallback = cb;
    }),
  })),
}));

vi.mock('../main/security', () => ({
  isTrustedIpcSender: vi.fn(() => true),
}));

vi.mock('../shared', () => ({
  isRecord: vi.fn((v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v)),
}));

import {
  setupFileTasksProgressHandler,
  registerDirectoryOperationTarget,
  unregisterDirectoryOperationTarget,
} from '../main/ipcUtils';

function makeMockWindow(sendFn = vi.fn()): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: sendFn,
    },
  } as unknown as BrowserWindow;
}

function makeMockContents(sendFn = vi.fn(), destroyed = false): WebContents {
  return {
    isDestroyed: () => destroyed,
    send: sendFn,
  } as unknown as WebContents;
}

describe('setupFileTasksProgressHandler', () => {
  const activeFolderSizeCalculations = new Map<string, { aborted: boolean }>();
  const activeChecksumCalculations = new Map<string, { aborted: boolean }>();

  beforeEach(() => {
    vi.clearAllMocks();
    progressCallback = null;
    mockMainWindow = null;
    activeFolderSizeCalculations.clear();
    activeChecksumCalculations.clear();
  });

  it('registers a progress listener on fileTasks', () => {
    setupFileTasksProgressHandler(activeFolderSizeCalculations, activeChecksumCalculations);
    expect(progressCallback).not.toBe(null);
  });

  describe('folder-size progress', () => {
    it('forwards folder-size progress to mainWindow when active', () => {
      const send = vi.fn();
      mockMainWindow = makeMockWindow(send);
      activeFolderSizeCalculations.set('op1', { aborted: false });

      setupFileTasksProgressHandler(activeFolderSizeCalculations, activeChecksumCalculations);
      progressCallback!({ task: 'folder-size', operationId: 'op1', data: { bytes: 1024 } });

      expect(send).toHaveBeenCalledWith('folder-size-progress', {
        operationId: 'op1',
        bytes: 1024,
      });
    });

    it('does not forward folder-size if operation not tracked', () => {
      const send = vi.fn();
      mockMainWindow = makeMockWindow(send);

      setupFileTasksProgressHandler(activeFolderSizeCalculations, activeChecksumCalculations);
      progressCallback!({ task: 'folder-size', operationId: 'unknown', data: {} });

      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('checksum progress', () => {
    it('forwards checksum progress to mainWindow when active', () => {
      const send = vi.fn();
      mockMainWindow = makeMockWindow(send);
      activeChecksumCalculations.set('cs1', { aborted: false });

      setupFileTasksProgressHandler(activeFolderSizeCalculations, activeChecksumCalculations);
      progressCallback!({ task: 'checksum', operationId: 'cs1', data: { progress: 50 } });

      expect(send).toHaveBeenCalledWith('checksum-progress', {
        operationId: 'cs1',
        progress: 50,
      });
    });

    it('does not forward checksum if operation not tracked', () => {
      const send = vi.fn();
      mockMainWindow = makeMockWindow(send);

      setupFileTasksProgressHandler(activeFolderSizeCalculations, activeChecksumCalculations);
      progressCallback!({ task: 'checksum', operationId: 'unknown', data: {} });

      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('list-directory progress', () => {
    it('forwards list-directory progress to registered target', () => {
      const send = vi.fn();
      const contents = makeMockContents(send);
      registerDirectoryOperationTarget('dir1', contents);

      setupFileTasksProgressHandler(activeFolderSizeCalculations, activeChecksumCalculations);
      progressCallback!({ task: 'list-directory', operationId: 'dir1', data: { count: 10 } });

      expect(send).toHaveBeenCalledWith('directory-contents-progress', {
        operationId: 'dir1',
        count: 10,
      });
    });

    it('unregisters target when send fails (destroyed contents)', () => {
      const contents = makeMockContents(vi.fn(), true);
      registerDirectoryOperationTarget('dir2', contents);

      setupFileTasksProgressHandler(activeFolderSizeCalculations, activeChecksumCalculations);
      progressCallback!({ task: 'list-directory', operationId: 'dir2', data: {} });

      progressCallback!({ task: 'list-directory', operationId: 'dir2', data: {} });
    });

    it('handles non-record data', () => {
      const send = vi.fn();
      mockMainWindow = makeMockWindow(send);
      activeFolderSizeCalculations.set('op1', { aborted: false });

      setupFileTasksProgressHandler(activeFolderSizeCalculations, activeChecksumCalculations);

      progressCallback!({ task: 'folder-size', operationId: 'op1', data: 'string-data' });

      expect(send).toHaveBeenCalledWith('folder-size-progress', {
        operationId: 'op1',
      });
    });
  });

  describe('unregisterDirectoryOperationTarget', () => {
    it('removes the registered target', () => {
      const send = vi.fn();
      const contents = makeMockContents(send);
      registerDirectoryOperationTarget('op1', contents);
      unregisterDirectoryOperationTarget('op1');

      setupFileTasksProgressHandler(activeFolderSizeCalculations, activeChecksumCalculations);
      progressCallback!({ task: 'list-directory', operationId: 'op1', data: {} });

      expect(send).not.toHaveBeenCalled();
    });
  });
});
