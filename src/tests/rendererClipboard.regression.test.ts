// @vitest-environment jsdom
/**
 * Regression tests for clipboard.
 * M3: When pasting a cut clipboard with some source files missing, both the
 *     in-memory `clipboard` variable and the backend clipboard store must be
 *     updated to contain only the surviving valid paths.  Previously only the
 *     local snapshot was patched, so `clearClipboardIfUnchanged` mismatch left
 *     the full-path cut clipboard permanently armed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared.js', () => ({
  escapeHtml: (v: string) => v,
  devLog: vi.fn(),
  ignoreError: () => {},
  getErrorMessage: (e: unknown) => String(e),
}));
vi.mock('../rendererDom.js', () => ({ getById: (id: string) => document.getElementById(id) }));
vi.mock('../rendererUtils.js', () => ({
  rendererPath: {
    basename: (p: string) => p.split('/').pop() || '',
    dirname: (p: string) => {
      const idx = p.lastIndexOf('/');
      return idx <= 0 ? '/' : p.slice(0, idx);
    },
  },
}));
vi.mock('../home.js', () => ({ isHomeViewPath: (p: string) => p === 'home://' }));
vi.mock('../i18n.js', () => ({
  t: (key: string, _params?: Record<string, unknown>) => key,
}));

import { createClipboardController } from '../rendererClipboard';

function buildDom() {
  // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
  document.body.innerHTML = `
    <div id="status-clipboard" style="display:none">
      <span id="status-clipboard-text"></span>
    </div>
  `;
}

function makeTauriApi(overrides: Record<string, unknown> = {}) {
  const api = {
    setClipboard: vi.fn().mockResolvedValue(undefined),
    getSystemClipboardData: vi.fn().mockResolvedValue(null),
    getSystemClipboardFiles: vi.fn().mockResolvedValue([]),
    getItemProperties: vi.fn().mockResolvedValue({ success: true }),
    copyItems: vi.fn().mockResolvedValue({ success: true }),
    moveItems: vi.fn().mockResolvedValue({ success: true }),
    onFileOperationProgress: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
  Object.defineProperty(window, 'tauriAPI', { value: api, configurable: true, writable: true });
  return api;
}

function createDeps() {
  return {
    getSelectedItems: () => new Set<string>(),
    getCurrentPath: () => '/dest',
    getFileElementMap: () => new Map<string, HTMLElement>(),
    getCurrentSettings: () => ({ globalClipboard: false, fileConflictBehavior: 'ask' }) as never,
    showToast: vi.fn(),
    showConfirm: vi.fn().mockResolvedValue(true),
    handleDrop: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn(),
    updateUndoRedoState: vi.fn().mockResolvedValue(undefined),
    addOperation: vi.fn(),
    updateOperation: vi.fn(),
    completeOperation: vi.fn(),
    generateOperationId: () => 'op-test',
    isOperationCancelling: vi.fn(() => false),
  };
}

describe('rendererClipboard — M3 stale cut clipboard after partial paste', () => {
  beforeEach(() => {
    buildDom();
  });

  it('updates clipboard and calls setClipboard with only valid paths when some cut sources are missing', async () => {
    const api = makeTauriApi({
      // '/good' exists, '/gone' does not
      getItemProperties: vi.fn((p: string) => Promise.resolve({ success: p === '/good' })),
      moveItems: vi.fn().mockResolvedValue({ success: true }),
    });
    const deps = createDeps();
    const ctrl = createClipboardController(deps as never);

    // Arm a cut clipboard with two paths.
    ctrl.setClipboard({ operation: 'cut', paths: ['/good', '/gone'] });

    await ctrl.pasteFromClipboard();

    // setClipboard (IPC) must have been called with only the surviving path.
    const setClipboardCalls = (api.setClipboard as ReturnType<typeof vi.fn>).mock.calls;
    const pruneCall = setClipboardCalls.find(
      ([arg]) => arg && Array.isArray(arg.paths) && arg.paths.length === 1
    );
    expect(pruneCall).toBeTruthy();
    expect(pruneCall![0]).toEqual({ operation: 'cut', paths: ['/good'] });
  });

  it('clears clipboard and does NOT call moveItems when ALL cut sources are missing', async () => {
    const api = makeTauriApi({
      getItemProperties: vi.fn().mockResolvedValue({ success: false }),
    });
    const deps = createDeps();
    const ctrl = createClipboardController(deps as never);

    ctrl.setClipboard({ operation: 'cut', paths: ['/gone-a', '/gone-b'] });
    await ctrl.pasteFromClipboard();

    expect(api.moveItems).not.toHaveBeenCalled();
    expect(ctrl.getClipboard()).toBeNull();
  });

  it('does not modify setClipboard for copy operations (no path validation needed)', async () => {
    const api = makeTauriApi({
      copyItems: vi.fn().mockResolvedValue({ success: true }),
    });
    const deps = createDeps();
    const ctrl = createClipboardController(deps as never);

    ctrl.setClipboard({ operation: 'copy', paths: ['/src/a', '/src/b'] });
    await ctrl.pasteFromClipboard();

    // setClipboard should only have been called for the initial cut visual state, not
    // for pruning (copies don't validate path existence before pasting).
    const pruneCall = (api.setClipboard as ReturnType<typeof vi.fn>).mock.calls.find(
      ([arg]) => arg && Array.isArray(arg?.paths) && arg.paths.length < 2
    );
    expect(pruneCall).toBeUndefined();
  });
});
