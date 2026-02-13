import { describe, it, expect, beforeEach } from 'vitest';
import {
  pushUndoAction,
  pushRedoAction,
  getUndoStack,
  getRedoStack,
  clearUndoRedoStacks,
} from '../main/undoRedoManager';
import { MAX_UNDO_STACK_SIZE } from '../main/appState';

describe('Undo/Redo stack size limits', () => {
  beforeEach(() => {
    clearUndoRedoStacks();
  });

  it('MAX_UNDO_STACK_SIZE is a positive number', () => {
    expect(MAX_UNDO_STACK_SIZE).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_UNDO_STACK_SIZE)).toBe(true);
  });

  it('evicts oldest undo action when exceeding limit', () => {
    for (let i = 0; i < MAX_UNDO_STACK_SIZE + 5; i++) {
      pushUndoAction({
        type: 'create',
        data: { path: `/file-${i}`, isDirectory: false },
      });
    }
    const stack = getUndoStack();
    expect(stack.length).toBe(MAX_UNDO_STACK_SIZE);

    const firstPath = (stack[0].data as { path: string }).path;
    expect(firstPath).toBe(`/file-5`);
  });

  it('evicts oldest redo action when exceeding limit', () => {
    for (let i = 0; i < MAX_UNDO_STACK_SIZE + 3; i++) {
      pushRedoAction({
        type: 'create',
        data: { path: `/redo-${i}`, isDirectory: false },
      });
    }
    const stack = getRedoStack();
    expect(stack.length).toBe(MAX_UNDO_STACK_SIZE);

    const firstPath = (stack[0].data as { path: string }).path;
    expect(firstPath).toBe('/redo-3');
  });

  it('preserves newest actions when evicting', () => {
    for (let i = 0; i < MAX_UNDO_STACK_SIZE + 10; i++) {
      pushUndoAction({
        type: 'rename',
        data: {
          oldPath: `/old-${i}`,
          newPath: `/new-${i}`,
          oldName: `old-${i}`,
          newName: `new-${i}`,
        },
      });
    }
    const stack = getUndoStack();
    const lastAction = stack[stack.length - 1];
    const lastData = lastAction.data as { oldPath: string; newPath: string };
    expect(lastData.newPath).toBe(`/new-${MAX_UNDO_STACK_SIZE + 9}`);
  });

  it('pushUndoAction clears redo stack even at overflow', () => {
    pushRedoAction({ type: 'create', data: { path: '/redo', isDirectory: false } });
    expect(getRedoStack().length).toBe(1);

    for (let i = 0; i < MAX_UNDO_STACK_SIZE + 1; i++) {
      pushUndoAction({ type: 'create', data: { path: `/u-${i}`, isDirectory: false } });
    }
    expect(getRedoStack().length).toBe(0);
  });

  it('stack stays at limit after repeated pushes', () => {
    for (let i = 0; i < MAX_UNDO_STACK_SIZE * 3; i++) {
      pushUndoAction({ type: 'create', data: { path: `/f-${i}`, isDirectory: false } });
    }
    expect(getUndoStack().length).toBe(MAX_UNDO_STACK_SIZE);
  });

  it('handles mixed action types at overflow', () => {
    for (let i = 0; i < MAX_UNDO_STACK_SIZE + 2; i++) {
      if (i % 3 === 0) {
        pushUndoAction({ type: 'create', data: { path: `/c-${i}`, isDirectory: false } });
      } else if (i % 3 === 1) {
        pushUndoAction({
          type: 'rename',
          data: { oldPath: `/a-${i}`, newPath: `/b-${i}`, oldName: `a-${i}`, newName: `b-${i}` },
        });
      } else {
        pushUndoAction({
          type: 'move',
          data: { sourcePaths: [`/s-${i}`], destPath: `/d-${i}` },
        });
      }
    }
    expect(getUndoStack().length).toBe(MAX_UNDO_STACK_SIZE);
  });
});
