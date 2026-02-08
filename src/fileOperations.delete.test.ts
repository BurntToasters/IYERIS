import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
type DeleteHandler = (
  event: unknown,
  itemPath: string
) => Promise<{ success: boolean; error?: string }>;
const clearUndoStackForPath = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
  },
  app: {
    getPath: vi.fn(() => os.tmpdir()),
  },
  dialog: {},
  shell: {
    openPath: vi.fn(),
    trashItem: vi.fn(),
    openExternal: vi.fn(),
  },
}));

vi.mock('./appState', () => ({
  getMainWindow: () => null,
  getFileTasks: () => ({
    runTask: vi.fn(),
    cancelOperation: vi.fn(),
  }),
  HIDDEN_FILE_CACHE_TTL: 300000,
  HIDDEN_FILE_CACHE_MAX: 5000,
  MAX_UNDO_STACK_SIZE: 50,
}));

vi.mock('./ipcUtils', () => ({
  registerDirectoryOperationTarget: vi.fn(),
  unregisterDirectoryOperationTarget: vi.fn(),
  isTrustedIpcEvent: vi.fn(() => true),
}));

vi.mock('./undoRedoManager', () => ({
  clearUndoStackForPath: (...args: unknown[]) => clearUndoStackForPath(...args),
  getUndoStack: () => [],
  pushUndoAction: vi.fn(),
}));

import { setupFileOperationHandlers, stopHiddenFileCacheCleanup } from './fileOperations';

describe('delete-item handler', () => {
  beforeEach(() => {
    handlers.clear();
    clearUndoStackForPath.mockClear();
    setupFileOperationHandlers();
  });

  afterEach(() => {
    stopHiddenFileCacheCleanup();
  });

  it('deletes files and clears undo stack entries', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iyeris-delete-file-'));
    const filePath = path.join(tempDir, 'to-delete.txt');
    try {
      await fs.writeFile(filePath, 'data');
      const handler = handlers.get('delete-item') as DeleteHandler | undefined;
      if (!handler) throw new Error('delete-item handler not registered');

      const result = await handler({} as unknown, filePath);
      expect(result.success).toBe(true);
      expect(clearUndoStackForPath).toHaveBeenCalledWith(filePath);
      await expect(fs.stat(filePath)).rejects.toBeTruthy();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('deletes directories and clears undo stack entries', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iyeris-delete-dir-'));
    const dirPath = path.join(tempDir, 'folder');
    try {
      await fs.mkdir(dirPath);
      await fs.writeFile(path.join(dirPath, 'child.txt'), 'data');
      const handler = handlers.get('delete-item') as DeleteHandler | undefined;
      if (!handler) throw new Error('delete-item handler not registered');

      const result = await handler({} as unknown, dirPath);
      expect(result.success).toBe(true);
      expect(clearUndoStackForPath).toHaveBeenCalledWith(dirPath);
      await expect(fs.stat(dirPath)).rejects.toBeTruthy();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
