import { describe, it, expect, beforeEach } from 'vitest';
import {
  pushUndoAction,
  pushRedoAction,
  getUndoStack,
  getRedoStack,
  clearUndoRedoStacks,
  clearUndoStackForPath,
} from './undoRedoManager';

describe('Undo/Redo Stack Management', () => {
  beforeEach(() => {
    clearUndoRedoStacks();
  });

  describe('pushUndoAction', () => {
    it('adds action to undo stack', () => {
      pushUndoAction({ type: 'create', data: { path: '/test', isDirectory: false } });
      expect(getUndoStack().length).toBe(1);
    });

    it('clears redo stack when pushing undo action', () => {
      pushRedoAction({ type: 'create', data: { path: '/test', isDirectory: false } });
      expect(getRedoStack().length).toBe(1);

      pushUndoAction({ type: 'create', data: { path: '/test2', isDirectory: false } });
      expect(getRedoStack().length).toBe(0);
    });

    it('maintains action order', () => {
      pushUndoAction({ type: 'create', data: { path: '/first', isDirectory: false } });
      pushUndoAction({ type: 'create', data: { path: '/second', isDirectory: false } });
      pushUndoAction({ type: 'create', data: { path: '/third', isDirectory: false } });

      const stack = getUndoStack();
      expect(stack[0].type).toBe('create');
      expect(stack[1].type).toBe('create');
      expect(stack[2].type).toBe('create');
      expect((stack[0].data as { path: string }).path).toBe('/first');
      expect((stack[1].data as { path: string }).path).toBe('/second');
      expect((stack[2].data as { path: string }).path).toBe('/third');
    });
  });

  describe('pushRedoAction', () => {
    it('adds action to redo stack', () => {
      pushRedoAction({ type: 'create', data: { path: '/test', isDirectory: false } });
      expect(getRedoStack().length).toBe(1);
    });

    it('maintains action order', () => {
      pushRedoAction({ type: 'create', data: { path: '/first', isDirectory: false } });
      pushRedoAction({ type: 'create', data: { path: '/second', isDirectory: false } });

      const stack = getRedoStack();
      expect((stack[0].data as { path: string }).path).toBe('/first');
      expect((stack[1].data as { path: string }).path).toBe('/second');
    });
  });

  describe('clearUndoRedoStacks', () => {
    it('clears both stacks', () => {
      pushUndoAction({ type: 'create', data: { path: '/test1', isDirectory: false } });
      pushRedoAction({ type: 'create', data: { path: '/test2', isDirectory: false } });

      clearUndoRedoStacks();

      expect(getUndoStack().length).toBe(0);
      expect(getRedoStack().length).toBe(0);
    });
  });

  describe('clearUndoStackForPath', () => {
    it('removes related rename actions from undo stack', () => {
      pushUndoAction({
        type: 'rename',
        data: { oldPath: '/a', newPath: '/b', oldName: 'a', newName: 'b' },
      });
      pushUndoAction({
        type: 'rename',
        data: { oldPath: '/b', newPath: '/c', oldName: 'b', newName: 'c' },
      });
      pushUndoAction({ type: 'create', data: { path: '/other', isDirectory: false } });

      clearUndoStackForPath('/c');

      const remaining = getUndoStack();
      expect(remaining.length).toBe(1);
      expect(remaining[0].type).toBe('create');
    });

    it('removes related actions from redo stack', () => {
      pushRedoAction({
        type: 'rename',
        data: { oldPath: '/x', newPath: '/y', oldName: 'x', newName: 'y' },
      });
      pushRedoAction({
        type: 'move',
        data: { sourcePaths: ['/y'], originalPaths: ['/x'], destPath: '/dest' },
      });

      clearUndoStackForPath('/y');

      expect(getRedoStack().length).toBe(0);
    });

    it('removes move actions when any source path matches', () => {
      pushUndoAction({
        type: 'move',
        data: { sourcePaths: ['/a', '/b'], originalPaths: ['/a', '/b'], destPath: '/dest' },
      });

      clearUndoStackForPath('/b');

      expect(getUndoStack().length).toBe(0);
    });

    it('removes create actions when path matches', () => {
      pushUndoAction({ type: 'create', data: { path: '/target', isDirectory: true } });
      pushUndoAction({ type: 'create', data: { path: '/other', isDirectory: false } });

      clearUndoStackForPath('/target');

      const remaining = getUndoStack();
      expect(remaining.length).toBe(1);
      expect((remaining[0].data as { path: string }).path).toBe('/other');
    });

    it('follows rename chains', () => {
      pushUndoAction({
        type: 'rename',
        data: {
          oldPath: '/original',
          newPath: '/renamed1',
          oldName: 'original',
          newName: 'renamed1',
        },
      });
      pushUndoAction({
        type: 'rename',
        data: {
          oldPath: '/renamed1',
          newPath: '/renamed2',
          oldName: 'renamed1',
          newName: 'renamed2',
        },
      });
      pushUndoAction({
        type: 'rename',
        data: { oldPath: '/renamed2', newPath: '/final', oldName: 'renamed2', newName: 'final' },
      });

      clearUndoStackForPath('/final');

      expect(getUndoStack().length).toBe(0);
    });

    it('does not remove unrelated actions', () => {
      pushUndoAction({ type: 'create', data: { path: '/unrelated1', isDirectory: false } });
      pushUndoAction({ type: 'create', data: { path: '/unrelated2', isDirectory: true } });
      pushUndoAction({
        type: 'rename',
        data: { oldPath: '/other1', newPath: '/other2', oldName: 'other1', newName: 'other2' },
      });

      clearUndoStackForPath('/target');

      expect(getUndoStack().length).toBe(3);
    });
  });

  describe('getUndoStack', () => {
    it('returns readonly array', () => {
      pushUndoAction({ type: 'create', data: { path: '/test', isDirectory: false } });
      const stack = getUndoStack();
      expect(Array.isArray(stack)).toBe(true);
    });
  });

  describe('getRedoStack', () => {
    it('returns readonly array', () => {
      pushRedoAction({ type: 'create', data: { path: '/test', isDirectory: false } });
      const stack = getRedoStack();
      expect(Array.isArray(stack)).toBe(true);
    });
  });
});
