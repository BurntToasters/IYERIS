// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClipboardController } from '../rendererClipboard';

type ClipboardElectronApi = {
  setClipboard: ReturnType<typeof vi.fn>;
  getSystemClipboardData: ReturnType<typeof vi.fn>;
  getSystemClipboardFiles: ReturnType<typeof vi.fn>;
  copyItems: ReturnType<typeof vi.fn>;
  moveItems: ReturnType<typeof vi.fn>;
  selectFolder: ReturnType<typeof vi.fn>;
};

function setupElectronApi(overrides: Partial<ClipboardElectronApi> = {}): ClipboardElectronApi {
  const api: ClipboardElectronApi = {
    setClipboard: vi.fn().mockResolvedValue(undefined),
    getSystemClipboardData: vi.fn().mockResolvedValue({ operation: 'copy', paths: [] }),
    getSystemClipboardFiles: vi.fn().mockResolvedValue([]),
    copyItems: vi.fn().mockResolvedValue({ success: true }),
    moveItems: vi.fn().mockResolvedValue({ success: true }),
    selectFolder: vi.fn().mockResolvedValue({ success: true, path: '/target' }),
    ...overrides,
  };

  Object.defineProperty(window, 'electronAPI', {
    value: api,
    configurable: true,
    writable: true,
  });

  return api;
}

function createDeps(selectedItems: Set<string>, fileElementMap: Map<string, HTMLElement>) {
  return {
    getSelectedItems: () => selectedItems,
    getCurrentPath: () => '/dest',
    getFileElementMap: () => fileElementMap,
    getCurrentSettings: () =>
      ({
        globalClipboard: true,
        fileConflictBehavior: 'ask',
      }) as never,
    showToast: vi.fn(),
    handleDrop: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn(),
    updateUndoRedoState: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createClipboardController', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="clipboard-indicator" style="display:none">
        <span id="clipboard-text"></span>
      </div>
      <div id="file-a"></div>
      <div id="file-b"></div>
    `;
  });

  it('copies selected items and updates clipboard indicator', async () => {
    const selected = new Set<string>(['/a']);
    const fileMap = new Map<string, HTMLElement>([['/a', document.getElementById('file-a')!]]);
    const electronApi = setupElectronApi();
    const deps = createDeps(selected, fileMap);
    const controller = createClipboardController(deps);

    controller.copyToClipboard();
    await Promise.resolve();

    expect(electronApi.setClipboard).toHaveBeenCalledWith({
      operation: 'copy',
      paths: ['/a'],
    });
    expect(document.getElementById('clipboard-indicator')!.style.display).toBe('inline-flex');
    expect(document.getElementById('clipboard-text')!.textContent).toBe('1 copied');
    expect(deps.showToast).toHaveBeenCalledWith('1 item(s) copied', 'Clipboard', 'success');
  });

  it('cuts selected items and marks file elements as cut', async () => {
    const selected = new Set<string>(['/a']);
    const fileA = document.getElementById('file-a')!;
    const fileMap = new Map<string, HTMLElement>([['/a', fileA]]);
    const electronApi = setupElectronApi();
    const deps = createDeps(selected, fileMap);
    const controller = createClipboardController(deps);

    controller.cutToClipboard();
    await Promise.resolve();

    expect(electronApi.setClipboard).toHaveBeenCalledWith({
      operation: 'cut',
      paths: ['/a'],
    });
    expect(fileA.classList.contains('cut')).toBe(true);
    expect(document.getElementById('clipboard-text')!.textContent).toBe('1 cut');
  });

  it('pastes local clipboard using copy operation', async () => {
    const selected = new Set<string>();
    const deps = createDeps(selected, new Map());
    const electronApi = setupElectronApi();
    const controller = createClipboardController(deps);
    controller.setClipboard({ operation: 'copy', paths: ['/src/file.txt'] });

    await controller.pasteFromClipboard();

    expect(electronApi.copyItems).toHaveBeenCalledWith(['/src/file.txt'], '/dest', 'ask');
    expect(deps.refresh).toHaveBeenCalledTimes(1);
    expect(deps.showToast).toHaveBeenCalledWith('1 item(s) copied', 'Success', 'success');
  });

  it('pastes local clipboard using move operation and clears clipboard', async () => {
    const selected = new Set<string>();
    const deps = createDeps(selected, new Map());
    const electronApi = setupElectronApi();
    const controller = createClipboardController(deps);
    controller.setClipboard({ operation: 'cut', paths: ['/src/file.txt'] });

    await controller.pasteFromClipboard();

    expect(electronApi.moveItems).toHaveBeenCalledWith(['/src/file.txt'], '/dest', 'ask');
    expect(deps.updateUndoRedoState).toHaveBeenCalledTimes(1);
    expect(electronApi.setClipboard).toHaveBeenCalledWith(null);
    expect(controller.getClipboard()).toBeNull();
  });

  it('uses system clipboard files when local clipboard is empty', async () => {
    const selected = new Set<string>();
    const deps = createDeps(selected, new Map());
    const electronApi = setupElectronApi({
      getSystemClipboardData: vi.fn().mockResolvedValue({
        operation: 'copy',
        paths: ['/tmp/a.txt'],
      }),
      copyItems: vi.fn().mockResolvedValue({ success: true }),
    });
    const controller = createClipboardController(deps);

    await controller.pasteFromClipboard();

    expect(electronApi.copyItems).toHaveBeenCalledWith(['/tmp/a.txt'], '/dest', 'ask');
    expect(deps.showToast).toHaveBeenCalledWith(
      '1 item(s) pasted from system clipboard',
      'Success',
      'success'
    );
  });

  it('prevents moving to same destination folder', async () => {
    const selected = new Set<string>(['/target/file.txt']);
    const deps = createDeps(selected, new Map());
    const electronApi = setupElectronApi({
      selectFolder: vi.fn().mockResolvedValue({ success: true, path: '/target' }),
    });
    const controller = createClipboardController(deps);

    await controller.moveSelectedToFolder();

    expect(deps.handleDrop).not.toHaveBeenCalled();
    expect(deps.showToast).toHaveBeenCalledWith(
      'Items are already in this directory',
      'Info',
      'info'
    );
    expect(electronApi.selectFolder).toHaveBeenCalledTimes(1);
  });
});
