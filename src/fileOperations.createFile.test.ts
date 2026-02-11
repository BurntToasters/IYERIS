import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
type CreateFileHandler = (
  event: unknown,
  parentPath: string,
  fileName: string
) => Promise<{ success: boolean; path?: string; error?: string }>;

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
  shell: {},
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
  withTrustedIpcEvent: vi.fn(
    (_channel: string, _untrustedResponse: unknown, handler: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        handler(...args)
  ),
}));

import { setupFileOperationHandlers, stopHiddenFileCacheCleanup } from './fileOperations';

describe('create-file handler', () => {
  beforeEach(() => {
    handlers.clear();
    setupFileOperationHandlers();
  });

  afterEach(() => {
    stopHiddenFileCacheCleanup();
  });

  it('creates the file when the target does not exist', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iyeris-create-file-'));
    try {
      const handler = handlers.get('create-file') as CreateFileHandler | undefined;
      if (!handler) {
        throw new Error('create-file handler not registered');
      }

      const result = await handler({} as unknown, tempDir, 'New File.txt');
      if (!result.success) {
        throw new Error(result.error || 'create-file failed');
      }
      expect(result.success).toBe(true);
      const createdPath = result.path;
      if (!createdPath) {
        throw new Error('create-file did not return a path');
      }
      expect(createdPath).toBe(path.join(tempDir, 'New File.txt'));

      const stats = await fs.stat(createdPath);
      expect(stats.isFile()).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('auto-renames when the target already exists', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iyeris-create-file-'));
    try {
      const existingPath = path.join(tempDir, 'New File.txt');
      await fs.writeFile(existingPath, 'original');

      const handler = handlers.get('create-file') as CreateFileHandler | undefined;
      if (!handler) {
        throw new Error('create-file handler not registered');
      }

      const result = await handler({} as unknown, tempDir, 'New File.txt');
      if (!result.success) {
        throw new Error(result.error || 'create-file failed');
      }
      expect(result.success).toBe(true);
      const createdPath = result.path;
      if (!createdPath) {
        throw new Error('create-file did not return a path');
      }
      expect(createdPath).toBe(path.join(tempDir, 'New File (2).txt'));

      const stats = await fs.stat(createdPath);
      expect(stats.isFile()).toBe(true);

      const originalContent = await fs.readFile(existingPath, 'utf-8');
      expect(originalContent).toBe('original');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
