// @vitest-environment jsdom
/**
 * Regression tests for column view.
 * L4: Windows paths that use forward-slashes (e.g. "C:/Users/dev/docs")
 *     must build the same breadcrumb column list as backslash paths
 *     ("C:\\Users\\dev\\docs").  Previously only backslash splitting was
 *     applied, so forward-slash Windows paths produced a broken breadcrumb.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const mockTauriAPI = vi.hoisted(() => ({
  getDirectoryContents: vi.fn(),
  getDriveInfo: vi.fn(),
  cancelDirectoryContents: vi.fn().mockResolvedValue(undefined),
  setDragData: vi.fn(),
  clearDragData: vi.fn(),
}));

vi.mock('../shared.js', () => ({
  devLog: () => {},
  escapeHtml: (v: string) => v,
  ignoreError: () => {},
}));
vi.mock('../rendererUtils.js', () => ({
  isWindowsPath: (v: string) => /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\'),
  rendererPath: {
    basename: (p: string) => p.split(/[\\/]/).pop() || '',
    dirname: (p: string) => {
      if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')) {
        const parts = p.replace(/\\+$/, '').split(/[/\\]/).filter(Boolean);
        if (parts.length <= 1) return (parts[0] || '') + '\\';
        return parts.slice(0, -1).join('\\');
      }
      const idx = p.lastIndexOf('/');
      return idx <= 0 ? '/' : p.slice(0, idx);
    },
  },
  twemojiImg: (_e: string, cls?: string) =>
    `<span class="${cls ?? 'twemoji'}" data-emoji="${_e}"></span>`,
}));
vi.mock('../home.js', () => ({ isHomeViewPath: (v: string) => v === 'iyeris://home' }));
vi.mock('../rendererDom.js', () => ({ getById: (id: string) => document.getElementById(id) }));

import { createColumnViewController } from '../rendererColumnView';

function buildDom(currentPath: string) {
  // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
  document.body.innerHTML = `<div id="column-view"></div>`;
  Object.defineProperty(window, 'tauriAPI', {
    value: mockTauriAPI,
    configurable: true,
    writable: true,
  });

  let path = currentPath;
  const columnView = document.getElementById('column-view') as HTMLElement;

  return {
    columnView,
    getCurrentPath: () => path,
    setCurrentPath: (v: string) => {
      path = v;
    },
    getCurrentSettings: () => ({ showHiddenFiles: false }),
    getSelectedItems: () => new Set<string>(),
    clearSelection: vi.fn(),
    addressInput: document.createElement('input'),
    updateBreadcrumb: vi.fn(),
    showToast: vi.fn(),
    showContextMenu: vi.fn(),
    getFileIcon: vi.fn().mockReturnValue('<span>📄</span>'),
    openFileEntry: vi.fn().mockResolvedValue(undefined),
    updatePreview: vi.fn(),
    consumeEvent: vi.fn((e: Event) => {
      e.preventDefault?.();
      e.stopPropagation?.();
    }),
    getDragOperation: vi.fn().mockReturnValue('move' as const),
    showDropIndicator: vi.fn(),
    hideDropIndicator: vi.fn(),
    getDraggedPaths: vi.fn().mockResolvedValue([]),
    handleDrop: vi.fn().mockResolvedValue(undefined),
    scheduleSpringLoad: vi.fn(),
    clearSpringLoad: vi.fn(),
    createDirectoryOperationId: vi.fn().mockReturnValue('op-1'),
    getCachedDriveInfo: vi.fn().mockReturnValue([]),
    cacheDriveInfo: vi.fn(),
    folderTreeManager: { ensurePathVisible: vi.fn() },
    getFileByPath: vi.fn().mockReturnValue(undefined),
  };
}

describe('rendererColumnView — L4 Windows forward-slash breadcrumb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTauriAPI.getDirectoryContents.mockResolvedValue({ success: true, contents: [] });
    mockTauriAPI.getDriveInfo.mockResolvedValue({ success: true, drives: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds correct column paths for a backslash Windows path', async () => {
    const deps = buildDom('C:\\Users\\dev\\docs');
    const ctrl = createColumnViewController(deps as never);
    await ctrl.renderColumnView();

    // Should have called getDirectoryContents for C:\, C:\Users, C:\Users\dev, C:\Users\dev\docs.
    const calls = mockTauriAPI.getDirectoryContents.mock.calls.map(([p]) => p as string);
    expect(calls).toContain('C:\\');
    expect(calls.some((p) => p.includes('Users'))).toBe(true);
    expect(calls.some((p) => p.includes('dev'))).toBe(true);
    expect(calls.some((p) => p.includes('docs'))).toBe(true);
  });

  it('builds equivalent column paths for a forward-slash Windows path', async () => {
    const deps = buildDom('C:/Users/dev/docs');
    const ctrl = createColumnViewController(deps as never);
    await ctrl.renderColumnView();

    // Must call getDirectoryContents with segments derived from the forward-slash path —
    // it should not treat the whole path as a single non-Windows POSIX segment.
    const calls = mockTauriAPI.getDirectoryContents.mock.calls.map(([p]) => p as string);
    // At minimum: root drive, a mid segment, and the final 'docs' directory.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.some((p) => p.includes('Users'))).toBe(true);
    expect(calls.some((p) => p.includes('docs'))).toBe(true);
  });

  it('produces the same number of column panes for backslash and forward-slash variants', async () => {
    const depsBack = buildDom('C:\\Users\\dev\\projects');
    const depsForward = buildDom('C:/Users/dev/projects');

    const ctrlBack = createColumnViewController(depsBack as never);
    await ctrlBack.renderColumnView();
    const backCallCount = mockTauriAPI.getDirectoryContents.mock.calls.length;

    mockTauriAPI.getDirectoryContents.mockClear();

    const ctrlForward = createColumnViewController(depsForward as never);
    await ctrlForward.renderColumnView();
    const forwardCallCount = mockTauriAPI.getDirectoryContents.mock.calls.length;

    expect(forwardCallCount).toBe(backCallCount);
  });
});
