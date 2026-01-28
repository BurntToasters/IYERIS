import { describe, it, expect, beforeEach } from 'vitest';
import {
  pushUndoAction,
  pushRedoAction,
  getUndoStack,
  getRedoStack,
  clearUndoRedoStacks,
  clearUndoStackForPath,
} from './undoRedoManager';

describe('clearUndoStackForPath', () => {
  beforeEach(() => {
    clearUndoRedoStacks();
  });

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
});
