// @vitest-environment jsdom
/**
 * Regression tests for drag-and-drop.
 * L2: When a drop event lands on a child content-item inside the file-view, the
 *     early-return path must still clean up the drag-over CSS class and hide the
 *     drop indicator.  Previously the early return happened before the cleanup,
 *     leaving the highlight and indicator permanently visible.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared.js', () => ({
  escapeHtml: (v: string) => v,
  devLog: vi.fn(),
  ignoreError: () => {},
  getErrorMessage: (e: unknown) => String(e),
}));
vi.mock('../rendererUtils.js', () => ({
  isWindowsPath: (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\'),
  rendererPath: {
    basename: (p: string) => p.split(/[\\/]/).pop() || '',
    dirname: (p: string) => {
      const idx = p.lastIndexOf('/');
      return idx <= 0 ? '/' : p.slice(0, idx);
    },
  },
  formatFileSize: (n: number) => `${n}`,
}));
vi.mock('../home.js', () => ({ isHomeViewPath: (p: string) => p === 'home://' }));
vi.mock('../i18n.js', () => ({ t: (k: string) => k }));
vi.mock('../rendererDom.js', () => ({ getById: (id: string) => document.getElementById(id) }));
vi.mock('../fileTypes.js', () => ({
  getFileIconClass: () => 'icon-file',
  VIDEO_EXTENSIONS: new Set(),
}));

import { createDragDropController } from '../rendererDragDrop';

function buildDom() {
  // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
  document.body.innerHTML = `
    <div id="file-view">
      <div class="column-view">
        <div class="column-item" data-path="/dest/folder" data-type="directory">folder</div>
      </div>
      <div id="file-grid">
        <div class="file-item" data-path="/dest/child.txt">child item</div>
      </div>
    </div>
    <div id="drop-indicator" style="display:none">
      <span id="drop-indicator-action"></span>
      <span id="drop-indicator-path"></span>
    </div>
  `;
}

function createConfig() {
  const showToast = vi.fn();
  return {
    getCurrentPath: () => '/dest',
    getCurrentSettings: () => ({ fileConflictBehavior: 'ask' }) as never,
    getShowToast: () => showToast,
    getFileGrid: () => document.getElementById('file-grid') as HTMLElement,
    getFileView: () => document.getElementById('file-view') as HTMLElement,
    getDropIndicator: () => document.getElementById('drop-indicator') as HTMLElement,
    getDropIndicatorAction: () => document.getElementById('drop-indicator-action') as HTMLElement,
    getDropIndicatorPath: () => document.getElementById('drop-indicator-path') as HTMLElement,
    consumeEvent: vi.fn((e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    }),
    clearSelection: vi.fn(),
    navigateTo: vi.fn().mockResolvedValue(undefined),
    updateUndoRedoState: vi.fn().mockResolvedValue(undefined),
    getPlatformOS: () => 'linux',
    getPlatformOSNative: () => 'linux',
    getDragOperation: vi.fn().mockReturnValue('copy' as const),
    getDraggedPaths: vi.fn().mockResolvedValue(['/src/file.txt']),
    handleDrop: vi.fn().mockResolvedValue(undefined),
    scheduleSpringLoad: vi.fn(),
    clearSpringLoad: vi.fn(),
    addOperation: vi.fn(),
    updateOperation: vi.fn(),
    completeOperation: vi.fn(),
    generateOperationId: () => 'op-dd',
    isOperationCancelling: vi.fn(() => false),
    showToast,
  };
}

describe('rendererDragDrop — L2 drag-over cleanup on child-item drop', () => {
  beforeEach(() => {
    buildDom();
    vi.clearAllMocks();
    window.tauriAPI = {
      setDragData: vi.fn(),
      clearDragData: vi.fn(),
    } as never;
  });

  it('removes drag-over class from file-view when drop target is a content item', () => {
    const config = createConfig();
    const ctrl = createDragDropController(config as never);
    ctrl.initDragAndDropListeners();

    const fileView = document.getElementById('file-view')!;
    const childItem = fileView.querySelector('.column-item')!;

    // Simulate drag-over state.
    fileView.classList.add('drag-over');
    expect(fileView.classList.contains('drag-over')).toBe(true);

    // Create a drop event targeting the child file item.
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
    Object.assign(dropEvent, {
      dataTransfer: { files: [], types: [], getData: () => '', dropEffect: 'none' },
      clientX: 10,
      clientY: 10,
    });

    childItem.dispatchEvent(dropEvent);

    // The drag-over class must be removed even though execution returned early.
    expect(fileView.classList.contains('drag-over')).toBe(false);
  });

  it('hides drop indicator when drop target is a content item', () => {
    const config = createConfig();
    const ctrl = createDragDropController(config as never);
    ctrl.initDragAndDropListeners();

    const dropIndicator = document.getElementById('drop-indicator')!;
    dropIndicator.style.display = 'flex'; // simulate visible indicator

    const fileView = document.getElementById('file-view')!;
    const childItem = fileView.querySelector('.column-item')!;

    const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
    Object.assign(dropEvent, {
      dataTransfer: { files: [], types: [], getData: () => '', dropEffect: 'none' },
      clientX: 10,
      clientY: 10,
    });

    childItem.dispatchEvent(dropEvent);

    // Indicator must be hidden via hideDropIndicator().
    expect(dropIndicator.style.display).toBe('none');
  });
});
