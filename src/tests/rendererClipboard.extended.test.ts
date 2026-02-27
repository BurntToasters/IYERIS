// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClipboardController } from '../rendererClipboard';

type ElectronApi = {
  setClipboard: ReturnType<typeof vi.fn>;
  getSystemClipboardData: ReturnType<typeof vi.fn>;
  getSystemClipboardFiles: ReturnType<typeof vi.fn>;
  copyItems: ReturnType<typeof vi.fn>;
  moveItems: ReturnType<typeof vi.fn>;
  selectFolder: ReturnType<typeof vi.fn>;
};

function setupElectronApi(overrides: Partial<ElectronApi> = {}): ElectronApi {
  const api: ElectronApi = {
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

function createDeps(overrides: Record<string, unknown> = {}) {
  const settings = {
    globalClipboard: true,
    fileConflictBehavior: 'ask',
    ...((overrides.settingsOverrides as Record<string, unknown>) ?? {}),
  };
  const fileElementMap = (overrides.fileElementMap as Map<string, HTMLElement>) ?? new Map();
  return {
    getSelectedItems: () => (overrides.selectedItems as Set<string>) ?? new Set<string>(),
    getCurrentPath: () => (overrides.currentPath as string) ?? '/dest',
    getFileElementMap: () => fileElementMap,
    getCurrentSettings: () => settings as never,
    showToast: vi.fn(),
    handleDrop: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn(),
    updateUndoRedoState: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createClipboardController — extended', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="clipboard-indicator" style="display:none">
        <span id="clipboard-text"></span>
      </div>
    `;
  });

  describe('setClipboardSelection', () => {
    it('does nothing when nothing is selected', () => {
      const electronApi = setupElectronApi();
      const deps = createDeps({ selectedItems: new Set<string>() });
      const ctrl = createClipboardController(deps);
      ctrl.setClipboardSelection('copy');
      expect(electronApi.setClipboard).not.toHaveBeenCalled();
      expect(deps.showToast).not.toHaveBeenCalled();
    });
  });

  describe('pasteFromClipboard', () => {
    it('returns early when currentPath is empty', async () => {
      setupElectronApi();
      const deps = createDeps({ currentPath: '' });
      const ctrl = createClipboardController(deps);
      await ctrl.pasteFromClipboard();
      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('returns silently when clipboard empty and globalClipboard is disabled', async () => {
      setupElectronApi();
      const deps = createDeps({ settingsOverrides: { globalClipboard: false } });
      const ctrl = createClipboardController(deps);
      await ctrl.pasteFromClipboard();
      expect(deps.showToast).not.toHaveBeenCalled();
      expect(deps.refresh).not.toHaveBeenCalled();
    });

    it('returns silently when clipboard empty and no system files', async () => {
      setupElectronApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({ operation: 'copy', paths: [] }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      await ctrl.pasteFromClipboard();
      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('returns silently when clipboard empty and system files is null', async () => {
      setupElectronApi({ getSystemClipboardData: vi.fn().mockResolvedValue(null) });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      await ctrl.pasteFromClipboard();
      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('shows error toast when system clipboard paste fails', async () => {
      setupElectronApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'copy',
          paths: ['/sys/file.txt'],
        }),
        copyItems: vi.fn().mockResolvedValue({ success: false, error: 'Copy failed' }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      await ctrl.pasteFromClipboard();
      expect(deps.showToast).toHaveBeenCalledWith(
        'Copy failed',
        'Error',
        'error',
        expect.any(Array)
      );
      expect(deps.refresh).not.toHaveBeenCalled();
    });

    it('shows generic error when paste result has no error message', async () => {
      setupElectronApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'copy',
          paths: ['/sys/file.txt'],
        }),
        copyItems: vi.fn().mockResolvedValue({ success: false }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      await ctrl.pasteFromClipboard();
      expect(deps.showToast).toHaveBeenCalledWith(
        'Paste failed',
        'Error',
        'error',
        expect.any(Array)
      );
    });

    it('shows error toast when local paste operation fails', async () => {
      const electronApi = setupElectronApi({
        copyItems: vi.fn().mockResolvedValue({ success: false, error: 'disk full' }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      ctrl.setClipboard({ operation: 'copy', paths: ['/a.txt'] });
      await ctrl.pasteFromClipboard();
      expect(electronApi.copyItems).toHaveBeenCalled();
      expect(deps.showToast).toHaveBeenCalledWith('disk full', 'Error', 'error', expect.any(Array));
    });

    it('shows generic error when local paste has no error message', async () => {
      setupElectronApi({
        moveItems: vi.fn().mockResolvedValue({ success: false }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      ctrl.setClipboard({ operation: 'cut', paths: ['/a.txt'] });
      await ctrl.pasteFromClipboard();
      expect(deps.showToast).toHaveBeenCalledWith(
        'Operation failed',
        'Error',
        'error',
        expect.any(Array)
      );
    });

    it('moves items when system clipboard operation is cut', async () => {
      const electronApi = setupElectronApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'cut',
          paths: ['/sys/file.txt'],
        }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.pasteFromClipboard();

      expect(electronApi.moveItems).toHaveBeenCalledWith(['/sys/file.txt'], '/dest', 'ask');
      expect(deps.showToast).toHaveBeenCalledWith(
        '1 item(s) moved from system clipboard',
        'Success',
        'success'
      );
    });

    it('falls back to copy with warning when system cut move is permission denied', async () => {
      const electronApi = setupElectronApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'cut',
          paths: ['/sys/file.txt'],
        }),
        moveItems: vi.fn().mockResolvedValue({ success: false, error: 'EPERM: access denied' }),
        copyItems: vi.fn().mockResolvedValue({ success: true }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.pasteFromClipboard();

      expect(electronApi.copyItems).toHaveBeenCalledWith(['/sys/file.txt'], '/dest', 'ask');
      expect(deps.showToast).toHaveBeenCalledWith(
        "1 item(s) copied from system clipboard; couldn't remove originals",
        'Permission Required',
        'warning'
      );
    });
  });

  describe('moveSelectedToFolder', () => {
    it('does nothing when nothing is selected', async () => {
      setupElectronApi();
      const deps = createDeps({ selectedItems: new Set<string>() });
      const ctrl = createClipboardController(deps);
      await ctrl.moveSelectedToFolder();
      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('does nothing when folder selection is cancelled', async () => {
      setupElectronApi({
        selectFolder: vi.fn().mockResolvedValue({ success: false }),
      });
      const deps = createDeps({ selectedItems: new Set(['/a.txt']) });
      const ctrl = createClipboardController(deps);
      await ctrl.moveSelectedToFolder();
      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('does nothing when folder selection returns no path', async () => {
      setupElectronApi({
        selectFolder: vi.fn().mockResolvedValue({ success: false, error: 'No folder selected' }),
      });
      const deps = createDeps({ selectedItems: new Set(['/a.txt']) });
      const ctrl = createClipboardController(deps);
      await ctrl.moveSelectedToFolder();
      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('prevents move when source matches destination', async () => {
      setupElectronApi({
        selectFolder: vi.fn().mockResolvedValue({ success: true, path: '/target' }),
      });
      const deps = createDeps({ selectedItems: new Set(['/target']) });
      const ctrl = createClipboardController(deps);
      await ctrl.moveSelectedToFolder();
      expect(deps.showToast).toHaveBeenCalledWith(
        'Items are already in this directory',
        'Info',
        'info'
      );
      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('moves items to selected folder', async () => {
      setupElectronApi({
        selectFolder: vi.fn().mockResolvedValue({ success: true, path: '/new-dest' }),
      });
      const deps = createDeps({ selectedItems: new Set(['/a.txt', '/b.txt']) });
      const ctrl = createClipboardController(deps);
      await ctrl.moveSelectedToFolder();
      expect(deps.handleDrop).toHaveBeenCalledWith(
        expect.arrayContaining(['/a.txt', '/b.txt']),
        '/new-dest',
        'move'
      );
    });
  });

  describe('pasteIntoFolder', () => {
    it('moves items for system cut clipboard data', async () => {
      const electronApi = setupElectronApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'cut',
          paths: ['/sys/file.txt'],
        }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.pasteIntoFolder('/target');

      expect(electronApi.moveItems).toHaveBeenCalledWith(['/sys/file.txt'], '/target', 'ask');
      expect(deps.showToast).toHaveBeenCalledWith(
        '1 item(s) moved from system clipboard',
        'Success',
        'success'
      );
    });

    it('falls back to copy in pasteIntoFolder when system cut move is permission denied', async () => {
      const electronApi = setupElectronApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'cut',
          paths: ['/sys/file.txt'],
        }),
        moveItems: vi.fn().mockResolvedValue({ success: false, error: 'permission denied' }),
        copyItems: vi.fn().mockResolvedValue({ success: true }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.pasteIntoFolder('/target');

      expect(electronApi.copyItems).toHaveBeenCalledWith(['/sys/file.txt'], '/target', 'ask');
      expect(deps.showToast).toHaveBeenCalledWith(
        "1 item(s) copied from system clipboard; couldn't remove originals",
        'Permission Required',
        'warning'
      );
    });
  });

  describe('updateClipboardIndicator', () => {
    it('hides indicator when clipboard is empty and globalClipboard is off', async () => {
      setupElectronApi();
      const deps = createDeps({ settingsOverrides: { globalClipboard: false } });
      const ctrl = createClipboardController(deps);
      await ctrl.updateClipboardIndicator();
      expect(document.getElementById('clipboard-indicator')!.style.display).toBe('none');
    });

    it('does nothing when indicator elements are missing', async () => {
      document.body.innerHTML = '';
      setupElectronApi();
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.updateClipboardIndicator();
    });

    it('shows system clipboard files info', async () => {
      setupElectronApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'copy',
          paths: ['/a.txt', '/b.txt'],
        }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      await ctrl.updateClipboardIndicator();
      expect(document.getElementById('clipboard-text')!.textContent).toBe('2 from system');
      expect(document.getElementById('clipboard-indicator')!.style.display).toBe('inline-flex');
    });

    it('shows system cut state in indicator', async () => {
      setupElectronApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'cut',
          paths: ['/a.txt'],
        }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      await ctrl.updateClipboardIndicator();
      expect(document.getElementById('clipboard-text')!.textContent).toBe('1 from system (cut)');
      expect(document.getElementById('clipboard-indicator')!.classList.contains('cut-mode')).toBe(
        true
      );
    });
  });

  describe('updateCutVisuals', () => {
    it('removes cut class from old paths and adds to new', () => {
      const fileA = document.createElement('div');
      const fileB = document.createElement('div');
      const fileMap = new Map<string, HTMLElement>([
        ['/a', fileA],
        ['/b', fileB],
      ]);
      setupElectronApi();
      const deps = createDeps({ fileElementMap: fileMap, selectedItems: new Set(['/a']) });
      const ctrl = createClipboardController(deps);

      ctrl.cutToClipboard();
      expect(fileA.classList.contains('cut')).toBe(true);
      expect(fileB.classList.contains('cut')).toBe(false);

      deps.getSelectedItems = () => new Set(['/b']);
      ctrl.cutToClipboard();
      expect(fileA.classList.contains('cut')).toBe(false);
      expect(fileB.classList.contains('cut')).toBe(true);
    });

    it('clears cut visuals when clipboard is cleared', () => {
      const fileA = document.createElement('div');
      const fileMap = new Map<string, HTMLElement>([['/a', fileA]]);
      setupElectronApi();
      const deps = createDeps({ fileElementMap: fileMap, selectedItems: new Set(['/a']) });
      const ctrl = createClipboardController(deps);

      ctrl.cutToClipboard();
      expect(fileA.classList.contains('cut')).toBe(true);

      ctrl.setClipboard(null);
      ctrl.updateCutVisuals();
      expect(fileA.classList.contains('cut')).toBe(false);
    });
  });
});
