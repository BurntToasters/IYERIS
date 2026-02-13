import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();

const hoisted = vi.hoisted(() => ({
  trusted: { value: true },
  fsAccess: vi.fn(),
  fsStat: vi.fn(),
  fsRename: vi.fn(),
  fsCp: vi.fn(),
  fsRm: vi.fn(),
  fsCopyFile: vi.fn(),
  fsUnlink: vi.fn(),
  fsMkdir: vi.fn(),
  fsWriteFile: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('fs', () => ({
  promises: {
    access: hoisted.fsAccess,
    stat: hoisted.fsStat,
    rename: hoisted.fsRename,
    cp: hoisted.fsCp,
    rm: hoisted.fsRm,
    copyFile: hoisted.fsCopyFile,
    unlink: hoisted.fsUnlink,
    mkdir: hoisted.fsMkdir,
    writeFile: hoisted.fsWriteFile,
  },
}));

vi.mock('./appState', () => ({
  MAX_UNDO_STACK_SIZE: 50,
}));

vi.mock('./utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./shared', () => ({
  ignoreError: vi.fn(),
}));

vi.mock('./ipcUtils', () => ({
  isTrustedIpcEvent: vi.fn(() => hoisted.trusted.value),
}));

import {
  pushUndoAction,
  pushRedoAction,
  getUndoStack,
  getRedoStack,
  clearUndoRedoStacks,
  setupUndoRedoHandlers,
} from './undoRedoManager';

const fakeEvent = {
  senderFrame: { url: 'file:///app/index.html' },
  sender: { getURL: () => 'file:///app/index.html' },
} as unknown as import('electron').IpcMainInvokeEvent;

describe('setupUndoRedoHandlers', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    clearUndoRedoStacks();
    hoisted.trusted.value = true;
    setupUndoRedoHandlers();
  });

  describe('get-undo-redo-state', () => {
    it('returns canUndo and canRedo false when stacks are empty', async () => {
      const handler = handlers.get('get-undo-redo-state')!;
      const result = await handler(fakeEvent);
      expect(result).toEqual({ canUndo: false, canRedo: false });
    });

    it('returns canUndo true when undo stack has items', async () => {
      pushUndoAction({ type: 'create', data: { path: '/test', isDirectory: false } });
      const handler = handlers.get('get-undo-redo-state')!;
      const result = await handler(fakeEvent);
      expect(result).toEqual({ canUndo: true, canRedo: false });
    });

    it('returns canRedo true when redo stack has items', async () => {
      pushRedoAction({ type: 'create', data: { path: '/test', isDirectory: false } });
      const handler = handlers.get('get-undo-redo-state')!;
      const result = await handler(fakeEvent);
      expect(result).toEqual({ canUndo: false, canRedo: true });
    });

    it('returns both false for untrusted events', async () => {
      hoisted.trusted.value = false;
      const handler = handlers.get('get-undo-redo-state')!;
      pushUndoAction({ type: 'create', data: { path: '/test', isDirectory: false } });
      const result = await handler(fakeEvent);
      expect(result).toEqual({ canUndo: false, canRedo: false });
    });
  });

  describe('undo-action', () => {
    it('returns error when undo stack is empty', async () => {
      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toBe('Nothing to undo');
    });

    it('returns error for untrusted sender', async () => {
      hoisted.trusted.value = false;
      pushUndoAction({ type: 'create', data: { path: '/test', isDirectory: false } });
      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toBe('Untrusted IPC sender');
    });

    it('undoes a rename action', async () => {
      pushUndoAction({
        type: 'rename',
        data: { oldPath: '/old', newPath: '/new', oldName: 'old', newName: 'new' },
      });

      // /new exists (source), /old does not exist (target)
      hoisted.fsAccess.mockImplementation(async (p: string) => {
        if (p === '/new') return;
        throw new Error('ENOENT');
      });
      hoisted.fsRename.mockResolvedValue(undefined);

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean };
      expect(result.success).toBe(true);
      expect(getRedoStack().length).toBe(1);
    });

    it('returns error when rename source no longer exists', async () => {
      pushUndoAction({
        type: 'rename',
        data: { oldPath: '/old', newPath: '/new', oldName: 'old', newName: 'new' },
      });

      // /new (source for undo) does not exist
      hoisted.fsAccess.mockRejectedValue(new Error('ENOENT'));

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('no longer exists');
    });

    it('returns error when rename target already exists', async () => {
      pushUndoAction({
        type: 'rename',
        data: { oldPath: '/old', newPath: '/new', oldName: 'old', newName: 'new' },
      });

      // Both /new and /old exist
      hoisted.fsAccess.mockResolvedValue(undefined);

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('undoes a create action by deleting a file', async () => {
      pushUndoAction({ type: 'create', data: { path: '/created.txt', isDirectory: false } });

      hoisted.fsAccess.mockResolvedValue(undefined);
      hoisted.fsStat.mockResolvedValue({ isDirectory: () => false });
      hoisted.fsUnlink.mockResolvedValue(undefined);

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean };
      expect(result.success).toBe(true);
      expect(hoisted.fsUnlink).toHaveBeenCalledWith('/created.txt');
      expect(getRedoStack().length).toBe(1);
    });

    it('undoes a create action by removing a directory', async () => {
      pushUndoAction({ type: 'create', data: { path: '/created-dir', isDirectory: true } });

      hoisted.fsAccess.mockResolvedValue(undefined);
      hoisted.fsStat.mockResolvedValue({ isDirectory: () => true });
      hoisted.fsRm.mockResolvedValue(undefined);

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean };
      expect(result.success).toBe(true);
      expect(hoisted.fsRm).toHaveBeenCalledWith('/created-dir', {
        recursive: true,
        force: true,
      });
    });

    it('returns error when file to undo-create no longer exists', async () => {
      pushUndoAction({ type: 'create', data: { path: '/gone.txt', isDirectory: false } });

      hoisted.fsAccess.mockRejectedValue(new Error('ENOENT'));

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('no longer exists');
    });

    it('undoes a move action', async () => {
      pushUndoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/file.txt'],
          originalPaths: ['/src/file.txt'],
          originalParent: '/src',
          destPath: '/dest',
        },
      });

      hoisted.fsAccess.mockImplementation(async (p: string) => {
        if (p === '/dest/file.txt') return; // moved file exists
        throw new Error('ENOENT'); // original location doesn't exist
      });
      hoisted.fsRename.mockResolvedValue(undefined);

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean };
      expect(result.success).toBe(true);
      expect(getRedoStack().length).toBe(1);
    });

    it('returns error for unknown action type', async () => {
      pushUndoAction({ type: 'unknown' as 'create', data: { path: '/x' } as never });

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown action type');
    });

    it('handles errors during undo and re-pushes action', async () => {
      pushUndoAction({ type: 'create', data: { path: '/test', isDirectory: false } });

      hoisted.fsAccess.mockResolvedValue(undefined);
      hoisted.fsStat.mockRejectedValue(new Error('I/O error'));

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toBe('I/O error');
      // Action should be pushed back onto undo stack
      expect(getUndoStack().length).toBe(1);
    });
  });

  describe('redo-action', () => {
    it('returns error when redo stack is empty', async () => {
      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toBe('Nothing to redo');
    });

    it('returns error for untrusted sender', async () => {
      hoisted.trusted.value = false;
      pushRedoAction({ type: 'create', data: { path: '/test', isDirectory: false } });
      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toBe('Untrusted IPC sender');
    });

    it('redoes a rename action', async () => {
      pushRedoAction({
        type: 'rename',
        data: { oldPath: '/old', newPath: '/new', oldName: 'old', newName: 'new' },
      });

      // /old exists (source for redo), /new does not
      hoisted.fsAccess.mockImplementation(async (p: string) => {
        if (p === '/old') return;
        throw new Error('ENOENT');
      });
      hoisted.fsRename.mockResolvedValue(undefined);

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean };
      expect(result.success).toBe(true);
      expect(getUndoStack().length).toBe(1);
    });

    it('redoes a create file action', async () => {
      pushRedoAction({ type: 'create', data: { path: '/test.txt', isDirectory: false } });

      // File doesn't exist yet (good for redo)
      hoisted.fsAccess.mockRejectedValue(new Error('ENOENT'));
      hoisted.fsWriteFile.mockResolvedValue(undefined);

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean };
      expect(result.success).toBe(true);
      expect(hoisted.fsWriteFile).toHaveBeenCalledWith('/test.txt', '');
      expect(getUndoStack().length).toBe(1);
    });

    it('redoes a create directory action', async () => {
      pushRedoAction({ type: 'create', data: { path: '/new-dir', isDirectory: true } });

      hoisted.fsAccess.mockRejectedValue(new Error('ENOENT'));
      hoisted.fsMkdir.mockResolvedValue(undefined);

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean };
      expect(result.success).toBe(true);
      expect(hoisted.fsMkdir).toHaveBeenCalledWith('/new-dir');
    });

    it('returns error when file already exists at redo create target', async () => {
      pushRedoAction({ type: 'create', data: { path: '/exists.txt', isDirectory: false } });

      hoisted.fsAccess.mockResolvedValue(undefined); // file already exists

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
      // Action should be pushed back to redo stack
      expect(getRedoStack().length).toBe(1);
    });

    it('returns error for unknown action type on redo', async () => {
      pushRedoAction({ type: 'unknown' as 'create', data: { path: '/x' } as never });

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown action type');
    });

    it('handles errors during redo and re-pushes action', async () => {
      pushRedoAction({ type: 'create', data: { path: '/test', isDirectory: false } });

      hoisted.fsAccess.mockRejectedValue(new Error('ENOENT'));
      hoisted.fsWriteFile.mockRejectedValue(new Error('Disk full'));

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toBe('Disk full');
      expect(getRedoStack().length).toBe(1);
    });

    it('redoes a move action with originalPaths', async () => {
      pushRedoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/file.txt'],
          originalPaths: ['/src/file.txt'],
          originalParent: '/src',
          destPath: '/dest',
        },
      });

      hoisted.fsAccess.mockImplementation(async (p: string) => {
        if (p === '/src/file.txt') return; // original location exists
        throw new Error('ENOENT'); // destination doesn't exist yet
      });
      hoisted.fsRename.mockResolvedValue(undefined);

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as { success: boolean };
      expect(result.success).toBe(true);
      expect(getUndoStack().length).toBe(1);
    });
  });
});
