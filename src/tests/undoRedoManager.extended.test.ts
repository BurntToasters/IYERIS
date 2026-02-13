import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (...args: any[]) => any;
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

vi.mock('../appState', () => ({
  MAX_UNDO_STACK_SIZE: 5,
}));

vi.mock('../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../shared', () => ({
  ignoreError: vi.fn(),
}));

vi.mock('../ipcUtils', () => ({
  isTrustedIpcEvent: vi.fn(() => hoisted.trusted.value),
}));

import {
  pushUndoAction,
  pushRedoAction,
  getUndoStack,
  getRedoStack,
  clearUndoRedoStacks,
  clearUndoStackForPath,
  setupUndoRedoHandlers,
} from '../undoRedoManager';

const fakeEvent = {
  senderFrame: { url: 'file:///app/index.html' },
  sender: { getURL: () => 'file:///app/index.html' },
} as any;

describe('undoRedoManager extended coverage', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    clearUndoRedoStacks();
    hoisted.trusted.value = true;
    setupUndoRedoHandlers();
  });

  describe('pushUndoAction overflow', () => {
    it('shifts oldest action when stack exceeds MAX_UNDO_STACK_SIZE', () => {
      for (let i = 0; i < 6; i++) {
        pushUndoAction({ type: 'create', data: { path: `/file${i}`, isDirectory: false } });
      }
      const stack = getUndoStack();

      expect(stack.length).toBe(5);
      expect((stack[0].data as any).path).toBe('/file1');
    });
  });

  describe('pushRedoAction overflow', () => {
    it('shifts oldest action when stack exceeds MAX_UNDO_STACK_SIZE', () => {
      for (let i = 0; i < 6; i++) {
        pushRedoAction({ type: 'create', data: { path: `/file${i}`, isDirectory: false } });
      }
      const stack = getRedoStack();
      expect(stack.length).toBe(5);
      expect((stack[0].data as any).path).toBe('/file1');
    });
  });

  describe('clearUndoStackForPath edge cases', () => {
    it('removes create actions matching the given path', () => {
      pushUndoAction({ type: 'create', data: { path: '/target', isDirectory: true } });
      pushUndoAction({ type: 'create', data: { path: '/other', isDirectory: false } });

      clearUndoStackForPath('/target');

      const remaining = getUndoStack();
      expect(remaining.length).toBe(1);
      expect((remaining[0].data as any).path).toBe('/other');
    });

    it('follows rename chains across both stacks', () => {
      pushUndoAction({
        type: 'rename',
        data: { oldPath: '/a', newPath: '/b', oldName: 'a', newName: 'b' },
      });
      pushRedoAction({
        type: 'rename',
        data: { oldPath: '/b', newPath: '/c', oldName: 'b', newName: 'c' },
      });

      clearUndoStackForPath('/c');

      expect(getUndoStack().length).toBe(0);
      expect(getRedoStack().length).toBe(0);
    });

    it('does not remove unrelated actions', () => {
      pushUndoAction({ type: 'create', data: { path: '/unrelated', isDirectory: false } });
      pushUndoAction({
        type: 'move',
        data: { sourcePaths: ['/x'], originalPaths: ['/y'], destPath: '/z' },
      });

      clearUndoStackForPath('/nowhere');

      expect(getUndoStack().length).toBe(2);
    });
  });

  describe('redo-action rename failure (line 318)', () => {
    it('pushes action back to redo stack when rename source does not exist', async () => {
      pushRedoAction({
        type: 'rename',
        data: { oldPath: '/old', newPath: '/new', oldName: 'old', newName: 'new' },
      });

      hoisted.fsAccess.mockRejectedValue(new Error('ENOENT'));

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('no longer exists');

      expect(getRedoStack().length).toBe(1);
    });

    it('pushes action back to redo stack when rename target already exists', async () => {
      pushRedoAction({
        type: 'rename',
        data: { oldPath: '/old', newPath: '/new', oldName: 'old', newName: 'new' },
      });

      hoisted.fsAccess.mockResolvedValue(undefined);

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
      expect(getRedoStack().length).toBe(1);
    });
  });

  describe('redo-action move failure (line 325)', () => {
    it('pushes action back to redo stack when move redo source not found', async () => {
      pushRedoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/file.txt'],
          originalPaths: ['/src/file.txt'],
          originalParent: '/src',
          destPath: '/dest',
        },
      });

      hoisted.fsAccess.mockRejectedValue(new Error('ENOENT'));

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
      expect(getRedoStack().length).toBe(1);
    });

    it('pushes action back to redo stack when move redo dest exists', async () => {
      pushRedoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/file.txt'],
          originalPaths: ['/src/file.txt'],
          originalParent: '/src',
          destPath: '/dest',
        },
      });

      hoisted.fsAccess.mockResolvedValue(undefined);

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists at the target');
      expect(getRedoStack().length).toBe(1);
    });
  });

  describe('executeMoveRedo via originalParent fallback (lines 238, 245)', () => {
    it('returns error when source not found using originalParent fallback', async () => {
      pushRedoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/file.txt'],
          originalPaths: [],
          originalParent: '/src',
          destPath: '/dest',
        },
      });

      hoisted.fsAccess.mockRejectedValue(new Error('ENOENT'));

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found at original location');
    });

    it('returns error when dest exists using originalParent fallback', async () => {
      pushRedoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/file.txt'],
          originalPaths: [],
          originalParent: '/src',
          destPath: '/dest',
        },
      });

      hoisted.fsAccess.mockResolvedValue(undefined);

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists at the target location');
    });

    it('succeeds using originalParent fallback', async () => {
      pushRedoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/file.txt'],
          originalPaths: [],
          originalParent: '/src',
          destPath: '/dest',
        },
      });

      hoisted.fsAccess.mockImplementation(async (p: string) => {
        if (p === '/src/file.txt') return;
        throw new Error('ENOENT');
      });
      hoisted.fsRename.mockResolvedValue(undefined);

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(true);
      expect(getUndoStack().length).toBe(1);
    });
  });

  describe('executeMoveRedo no originalParent and no originalPaths', () => {
    it('returns error when neither originalPaths nor originalParent available', async () => {
      pushRedoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/file.txt'],
          originalPaths: [],
          destPath: '/dest',
        },
      } as any);

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Original parent path not available');
    });
  });

  describe('executeMoveUndo edge cases', () => {
    it('returns error when getTargetPaths returns null (no originalPaths, no originalParent)', async () => {
      pushUndoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/file.txt'],
          destPath: '/dest',
        },
      } as any);

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Original parent path not available');

      expect(getUndoStack().length).toBe(1);
    });

    it('returns error when source no longer exists during move undo', async () => {
      pushUndoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/file.txt'],
          originalPaths: ['/src/file.txt'],
          originalParent: '/src',
          destPath: '/dest',
        },
      });

      hoisted.fsAccess.mockRejectedValue(new Error('ENOENT'));

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('One or more files no longer exist');
      expect(getUndoStack().length).toBe(1);
    });

    it('returns error when target already exists during move undo', async () => {
      pushUndoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/file.txt'],
          originalPaths: ['/src/file.txt'],
          originalParent: '/src',
          destPath: '/dest',
        },
      });

      hoisted.fsAccess.mockResolvedValue(undefined);

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists at the original location');
      expect(getUndoStack().length).toBe(1);
    });

    it('handles partial move failure with movedBackCount > 0', async () => {
      pushUndoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/a.txt', '/dest/b.txt'],
          originalPaths: ['/src/a.txt', '/src/b.txt'],
          originalParent: '/src',
          destPath: '/dest',
        },
      });

      hoisted.fsAccess.mockImplementation(async (p: string) => {
        if (p === '/dest/a.txt' || p === '/dest/b.txt') return;
        throw new Error('ENOENT');
      });

      let renameCallCount = 0;
      hoisted.fsRename.mockImplementation(async () => {
        renameCallCount++;
        if (renameCallCount === 2) throw new Error('Disk full');
      });

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Partial undo failed');
      expect(result.error).toContain('Disk full');

      const stack = getUndoStack();
      expect(stack.length).toBe(1);
      expect((stack[0].data as any).sourcePaths).toEqual(['/dest/b.txt']);
    });

    it('handles partial move failure with movedBackCount === 0', async () => {
      pushUndoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/a.txt'],
          originalPaths: ['/src/a.txt'],
          originalParent: '/src',
          destPath: '/dest',
        },
      });

      hoisted.fsAccess.mockImplementation(async (p: string) => {
        if (p === '/dest/a.txt') return;
        throw new Error('ENOENT');
      });
      hoisted.fsRename.mockRejectedValue(new Error('Permission denied'));

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Partial undo failed');
      expect(result.error).toContain('Permission denied');

      expect(getUndoStack().length).toBe(1);
    });

    it('handles partial move failure with non-Error thrown', async () => {
      pushUndoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/a.txt'],
          originalPaths: ['/src/a.txt'],
          originalParent: '/src',
          destPath: '/dest',
        },
      });

      hoisted.fsAccess.mockImplementation(async (p: string) => {
        if (p === '/dest/a.txt') return;
        throw new Error('ENOENT');
      });
      hoisted.fsRename.mockRejectedValue('string error');

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Partial undo failed: string error');
    });

    it('uses originalParent fallback for getTargetPaths', async () => {
      pushUndoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/file.txt'],
          originalParent: '/src',
          destPath: '/dest',
        },
      } as any);

      hoisted.fsAccess.mockImplementation(async (p: string) => {
        if (p === '/dest/file.txt') return;
        throw new Error('ENOENT');
      });
      hoisted.fsRename.mockResolvedValue(undefined);

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(true);
      expect(getRedoStack().length).toBe(1);
    });
  });

  describe('movePath cross-device (EXDEV) handling', () => {
    it('falls back to cp+rm for directories on EXDEV', async () => {
      pushUndoAction({
        type: 'rename',
        data: { oldPath: '/old', newPath: '/new', oldName: 'old', newName: 'new' },
      });

      hoisted.fsAccess.mockImplementation(async (p: string) => {
        if (p === '/new') return;
        throw new Error('ENOENT');
      });

      const exdevError = new Error('EXDEV') as NodeJS.ErrnoException;
      exdevError.code = 'EXDEV';
      hoisted.fsRename.mockRejectedValue(exdevError);
      hoisted.fsStat.mockResolvedValue({ isDirectory: () => true });
      hoisted.fsCp.mockResolvedValue(undefined);
      hoisted.fsRm.mockResolvedValue(undefined);

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(true);
      expect(hoisted.fsCp).toHaveBeenCalledWith('/new', '/old', { recursive: true });
      expect(hoisted.fsRm).toHaveBeenCalledWith('/new', { recursive: true, force: true });
    });

    it('falls back to copyFile+unlink for files on EXDEV', async () => {
      pushUndoAction({
        type: 'rename',
        data: { oldPath: '/old', newPath: '/new', oldName: 'old', newName: 'new' },
      });

      hoisted.fsAccess.mockImplementation(async (p: string) => {
        if (p === '/new') return;
        throw new Error('ENOENT');
      });

      const exdevError = new Error('EXDEV') as NodeJS.ErrnoException;
      exdevError.code = 'EXDEV';
      hoisted.fsRename.mockRejectedValue(exdevError);
      hoisted.fsStat.mockResolvedValue({ isDirectory: () => false });
      hoisted.fsCopyFile.mockResolvedValue(undefined);
      hoisted.fsUnlink.mockResolvedValue(undefined);

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(true);
      expect(hoisted.fsCopyFile).toHaveBeenCalledWith('/new', '/old');
      expect(hoisted.fsUnlink).toHaveBeenCalledWith('/new');
    });

    it('rethrows non-EXDEV rename errors', async () => {
      pushUndoAction({
        type: 'rename',
        data: { oldPath: '/old', newPath: '/new', oldName: 'old', newName: 'new' },
      });

      hoisted.fsAccess.mockImplementation(async (p: string) => {
        if (p === '/new') return;
        throw new Error('ENOENT');
      });

      const eaccesError = new Error('EACCES') as NodeJS.ErrnoException;
      eaccesError.code = 'EACCES';
      hoisted.fsRename.mockRejectedValue(eaccesError);

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('EACCES');

      expect(getUndoStack().length).toBe(1);
    });
  });

  describe('undo/redo error handler with non-Error thrown', () => {
    it('handles non-Error throw during undo', async () => {
      pushUndoAction({ type: 'create', data: { path: '/test', isDirectory: false } });

      hoisted.fsAccess.mockResolvedValue(undefined);
      hoisted.fsStat.mockRejectedValue('raw string error');

      const handler = handlers.get('undo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toBe('raw string error');
      expect(getUndoStack().length).toBe(1);
    });

    it('handles non-Error throw during redo', async () => {
      pushRedoAction({ type: 'create', data: { path: '/test', isDirectory: false } });

      hoisted.fsAccess.mockRejectedValue(new Error('ENOENT'));
      hoisted.fsWriteFile.mockRejectedValue(42);

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toBe('42');
      expect(getRedoStack().length).toBe(1);
    });
  });

  describe('executeMoveRedo multiple files', () => {
    it('moves multiple files via originalPaths successfully', async () => {
      pushRedoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/a.txt', '/dest/b.txt'],
          originalPaths: ['/src/a.txt', '/src/b.txt'],
          originalParent: '/src',
          destPath: '/dest',
        },
      });

      hoisted.fsAccess.mockImplementation(async (p: string) => {
        if (p === '/src/a.txt' || p === '/src/b.txt') return;
        throw new Error('ENOENT');
      });
      hoisted.fsRename.mockResolvedValue(undefined);

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(true);
      const stack = getUndoStack();
      expect(stack.length).toBe(1);
      expect((stack[0].data as any).sourcePaths).toEqual(['/dest/a.txt', '/dest/b.txt']);
    });

    it('fails on second file source not found with originalPaths', async () => {
      pushRedoAction({
        type: 'move',
        data: {
          sourcePaths: ['/dest/a.txt', '/dest/b.txt'],
          originalPaths: ['/src/a.txt', '/src/b.txt'],
          originalParent: '/src',
          destPath: '/dest',
        },
      });

      hoisted.fsAccess.mockImplementation(async (p: string) => {
        if (p === '/src/a.txt') return;
        if (p === '/dest/a.txt') throw new Error('ENOENT');

        if (p === '/src/b.txt') throw new Error('ENOENT');
        throw new Error('ENOENT');
      });
      hoisted.fsRename.mockResolvedValue(undefined);

      const handler = handlers.get('redo-action')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });
  });

  describe('get-undo-redo-state', () => {
    it('returns both false for untrusted events', async () => {
      hoisted.trusted.value = false;
      pushUndoAction({ type: 'create', data: { path: '/a', isDirectory: false } });
      pushRedoAction({ type: 'create', data: { path: '/b', isDirectory: false } });

      const handler = handlers.get('get-undo-redo-state')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result).toEqual({ canUndo: false, canRedo: false });
    });

    it('returns correct state with both stacks populated', async () => {
      pushUndoAction({ type: 'create', data: { path: '/a', isDirectory: false } });
      pushRedoAction({ type: 'create', data: { path: '/b', isDirectory: false } });

      const handler = handlers.get('get-undo-redo-state')!;
      const result = (await handler(fakeEvent)) as any;
      expect(result).toEqual({ canUndo: true, canRedo: true });
    });
  });
});
