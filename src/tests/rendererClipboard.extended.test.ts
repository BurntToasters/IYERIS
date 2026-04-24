// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClipboardController, isPermissionDeniedError } from '../rendererClipboard';

type TauriApi = {
  setClipboard: ReturnType<typeof vi.fn>;
  getSystemClipboardData: ReturnType<typeof vi.fn>;
  getSystemClipboardFiles: ReturnType<typeof vi.fn>;
  copyItems: ReturnType<typeof vi.fn>;
  moveItems: ReturnType<typeof vi.fn>;
  selectFolder: ReturnType<typeof vi.fn>;
  elevatedCopyBatch: ReturnType<typeof vi.fn>;
  elevatedMoveBatch: ReturnType<typeof vi.fn>;
  elevatedDeleteBatch: ReturnType<typeof vi.fn>;
  getItemProperties: ReturnType<typeof vi.fn>;
};

function setupTauriApi(overrides: Partial<TauriApi> = {}): TauriApi {
  const api: TauriApi = {
    setClipboard: vi.fn().mockResolvedValue(undefined),
    getSystemClipboardData: vi.fn().mockResolvedValue({ operation: 'copy', paths: [] }),
    getSystemClipboardFiles: vi.fn().mockResolvedValue([]),
    copyItems: vi.fn().mockResolvedValue({ success: true }),
    moveItems: vi.fn().mockResolvedValue({ success: true }),
    selectFolder: vi.fn().mockResolvedValue({ success: true, path: '/target' }),
    elevatedCopyBatch: vi.fn().mockResolvedValue({ success: true }),
    elevatedMoveBatch: vi.fn().mockResolvedValue({ success: true }),
    elevatedDeleteBatch: vi.fn().mockResolvedValue({ success: true }),
    getItemProperties: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
  Object.defineProperty(window, 'tauriAPI', {
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
    showConfirm: vi.fn().mockResolvedValue(true),
    handleDrop: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn(),
    updateUndoRedoState: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createClipboardController — extended', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="status-clipboard" style="display:none">
        <span id="status-clipboard-text"></span>
      </div>
    `;
  });

  describe('setClipboardSelection', () => {
    it('does nothing when nothing is selected', () => {
      const tauriApi = setupTauriApi();
      const deps = createDeps({ selectedItems: new Set<string>() });
      const ctrl = createClipboardController(deps);
      ctrl.setClipboardSelection('copy');
      expect(tauriApi.setClipboard).not.toHaveBeenCalled();
      expect(deps.showToast).not.toHaveBeenCalled();
    });
  });

  describe('pasteFromClipboard', () => {
    it('returns early when currentPath is empty', async () => {
      setupTauriApi();
      const deps = createDeps({ currentPath: '' });
      const ctrl = createClipboardController(deps);
      await ctrl.pasteFromClipboard();
      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('returns silently when clipboard empty and globalClipboard is disabled', async () => {
      setupTauriApi();
      const deps = createDeps({ settingsOverrides: { globalClipboard: false } });
      const ctrl = createClipboardController(deps);
      await ctrl.pasteFromClipboard();
      expect(deps.showToast).not.toHaveBeenCalled();
      expect(deps.refresh).not.toHaveBeenCalled();
    });

    it('returns silently when clipboard empty and no system files', async () => {
      setupTauriApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({ operation: 'copy', paths: [] }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      await ctrl.pasteFromClipboard();
      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('returns silently when clipboard empty and system files is null', async () => {
      setupTauriApi({ getSystemClipboardData: vi.fn().mockResolvedValue(null) });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      await ctrl.pasteFromClipboard();
      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('shows error toast when system clipboard paste fails', async () => {
      setupTauriApi({
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

    it('retries system clipboard paste via toast action', async () => {
      const copyItems = vi
        .fn()
        .mockResolvedValueOnce({ success: false, error: 'Copy failed' })
        .mockResolvedValueOnce({ success: true });
      setupTauriApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'copy',
          paths: ['/sys/file.txt'],
        }),
        copyItems,
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.pasteFromClipboard();

      const actions = deps.showToast.mock.calls[0]?.[3] as
        | Array<{ label: string; onClick: () => void }>
        | undefined;
      expect(actions?.[0]?.label).toBe('Retry');
      actions?.[0]?.onClick();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(copyItems).toHaveBeenCalledTimes(2);
    });

    it('shows generic error when paste result has no error message', async () => {
      setupTauriApi({
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
      const tauriApi = setupTauriApi({
        copyItems: vi.fn().mockResolvedValue({ success: false, error: 'disk full' }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      ctrl.setClipboard({ operation: 'copy', paths: ['/a.txt'] });
      await ctrl.pasteFromClipboard();
      expect(tauriApi.copyItems).toHaveBeenCalled();
      expect(deps.showToast).toHaveBeenCalledWith('disk full', 'Error', 'error', expect.any(Array));
    });

    it('shows generic error when local paste has no error message', async () => {
      setupTauriApi({
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
      const tauriApi = setupTauriApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'cut',
          paths: ['/sys/file.txt'],
        }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.pasteFromClipboard();

      expect(tauriApi.moveItems).toHaveBeenCalledWith(['/sys/file.txt'], '/dest', 'ask');
      expect(deps.showToast).toHaveBeenCalledWith(
        '1 item(s) moved from system clipboard',
        'Success',
        'success'
      );
    });

    it('uses fallback getSystemClipboardFiles when structured clipboard API is unavailable', async () => {
      const tauriApi = setupTauriApi({
        getSystemClipboardFiles: vi.fn().mockResolvedValue(['/legacy.txt']),
      });
      delete (window as any).tauriAPI.getSystemClipboardData;
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.pasteFromClipboard();

      expect(tauriApi.copyItems).toHaveBeenCalledWith(['/legacy.txt'], '/dest', 'ask');
      expect(deps.showToast).toHaveBeenCalledWith(
        '1 item(s) pasted from system clipboard',
        'Success',
        'success'
      );
    });

    it('returns silently when reading system clipboard throws', async () => {
      setupTauriApi({
        getSystemClipboardData: vi.fn().mockRejectedValue(new Error('clipboard read failed')),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.pasteFromClipboard();

      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('shows cancelled toast when permission prompt is declined for system clipboard copy', async () => {
      setupTauriApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'copy',
          paths: ['/sys/file.txt'],
        }),
        copyItems: vi.fn().mockResolvedValue({ success: false, error: 'EACCES' }),
      });
      const deps = createDeps();
      deps.showConfirm = vi.fn().mockResolvedValue(false);
      const ctrl = createClipboardController(deps);

      await ctrl.pasteFromClipboard();

      expect(deps.showToast).toHaveBeenCalledWith('Operation cancelled', 'Info', 'info');
    });

    it('shows elevated-copy fallback error for system clipboard copy', async () => {
      const tauriApi = setupTauriApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'copy',
          paths: ['/sys/file.txt'],
        }),
        copyItems: vi.fn().mockResolvedValue({ success: false, error: 'permission denied' }),
        elevatedCopyBatch: vi.fn().mockResolvedValue({ success: false, error: '' }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.pasteFromClipboard();

      expect(tauriApi.elevatedCopyBatch).toHaveBeenCalledWith(['/sys/file.txt'], '/dest');
      expect(deps.showToast).toHaveBeenCalledWith('Elevated copy failed', 'Error', 'error', [
        expect.objectContaining({ label: 'Retry' }),
      ]);
    });

    it('skips missing source files for cut clipboard and continues with remaining files', async () => {
      const tauriApi = setupTauriApi({
        getItemProperties: vi
          .fn()
          .mockResolvedValueOnce({ success: true })
          .mockResolvedValueOnce({ success: false }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      ctrl.setClipboard({ operation: 'cut', paths: ['/ok.txt', '/missing.txt'] });

      await ctrl.pasteFromClipboard();

      expect(tauriApi.moveItems).toHaveBeenCalledWith(['/ok.txt'], '/dest', 'ask');
      expect(deps.showToast).toHaveBeenCalledWith(
        '1 file(s) no longer exist and were skipped',
        'Paste',
        'warning'
      );
    });

    it('clears clipboard when all cut sources are missing', async () => {
      setupTauriApi({
        getItemProperties: vi.fn().mockResolvedValue({ success: false }),
      });
      const deps = createDeps({
        fileElementMap: new Map<string, HTMLElement>([
          ['/gone.txt', document.createElement('div')],
        ]),
      });
      const ctrl = createClipboardController(deps);
      ctrl.setClipboard({ operation: 'cut', paths: ['/gone.txt'] });

      await ctrl.pasteFromClipboard();

      expect(ctrl.getClipboard()).toBeNull();
      expect(deps.showToast).toHaveBeenCalledWith(
        'Source files no longer exist',
        'Paste Failed',
        'error'
      );
    });

    it('shows cancelled toast when local permission prompt is declined', async () => {
      setupTauriApi({
        moveItems: vi.fn().mockResolvedValue({ success: false, error: 'permission denied' }),
      });
      const deps = createDeps();
      deps.showConfirm = vi.fn().mockResolvedValue(false);
      const ctrl = createClipboardController(deps);
      ctrl.setClipboard({ operation: 'cut', paths: ['/a.txt'] });

      await ctrl.pasteFromClipboard();

      expect(deps.showToast).toHaveBeenCalledWith('Operation cancelled', 'Info', 'info');
    });

    it('shows elevated operation fallback error for local paste', async () => {
      const tauriApi = setupTauriApi({
        moveItems: vi.fn().mockResolvedValue({ success: false, error: 'permission denied' }),
        elevatedMoveBatch: vi.fn().mockResolvedValue({ success: false, error: '' }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      ctrl.setClipboard({ operation: 'cut', paths: ['/a.txt'] });

      await ctrl.pasteFromClipboard();

      expect(tauriApi.elevatedMoveBatch).toHaveBeenCalledWith(['/a.txt'], '/dest');
      expect(deps.showToast).toHaveBeenCalledWith('Elevated operation failed', 'Error', 'error');
    });

    it('prompts elevation when system cut move is permission denied', async () => {
      const tauriApi = setupTauriApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'cut',
          paths: ['/sys/file.txt'],
        }),
        moveItems: vi.fn().mockResolvedValue({ success: false, error: 'EPERM: access denied' }),
        elevatedMoveBatch: vi.fn().mockResolvedValue({ success: true }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.pasteFromClipboard();

      expect(deps.showConfirm).toHaveBeenCalled();
      expect(tauriApi.elevatedMoveBatch).toHaveBeenCalledWith(['/sys/file.txt'], '/dest');
      expect(deps.showToast).toHaveBeenCalledWith(
        '1 item(s) moved (elevated)',
        'Success',
        'success'
      );
    });
  });

  describe('moveSelectedToFolder', () => {
    it('does nothing when nothing is selected', async () => {
      setupTauriApi();
      const deps = createDeps({ selectedItems: new Set<string>() });
      const ctrl = createClipboardController(deps);
      await ctrl.moveSelectedToFolder();
      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('does nothing when folder selection is cancelled', async () => {
      setupTauriApi({
        selectFolder: vi.fn().mockResolvedValue({ success: false }),
      });
      const deps = createDeps({ selectedItems: new Set(['/a.txt']) });
      const ctrl = createClipboardController(deps);
      await ctrl.moveSelectedToFolder();
      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('does nothing when folder selection returns no path', async () => {
      setupTauriApi({
        selectFolder: vi.fn().mockResolvedValue({ success: false, error: 'No folder selected' }),
      });
      const deps = createDeps({ selectedItems: new Set(['/a.txt']) });
      const ctrl = createClipboardController(deps);
      await ctrl.moveSelectedToFolder();
      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('prevents move when source matches destination', async () => {
      setupTauriApi({
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
      setupTauriApi({
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

  describe('copySelectedToFolder', () => {
    it('does nothing when nothing is selected', async () => {
      setupTauriApi();
      const deps = createDeps({ selectedItems: new Set<string>() });
      const ctrl = createClipboardController(deps);
      await ctrl.copySelectedToFolder();
      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('does nothing when folder selection is cancelled', async () => {
      setupTauriApi({
        selectFolder: vi.fn().mockResolvedValue({ success: false }),
      });
      const deps = createDeps({ selectedItems: new Set(['/a.txt']) });
      const ctrl = createClipboardController(deps);
      await ctrl.copySelectedToFolder();
      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('prevents copy when source is already in destination', async () => {
      setupTauriApi({
        selectFolder: vi.fn().mockResolvedValue({ success: true, path: '/target' }),
      });
      const deps = createDeps({ selectedItems: new Set(['/target/file.txt']) });
      const ctrl = createClipboardController(deps);
      await ctrl.copySelectedToFolder();
      expect(deps.showToast).toHaveBeenCalledWith(
        'Items are already in this directory',
        'Info',
        'info'
      );
      expect(deps.handleDrop).not.toHaveBeenCalled();
    });

    it('copies items to selected folder', async () => {
      setupTauriApi({
        selectFolder: vi.fn().mockResolvedValue({ success: true, path: '/new-dest' }),
      });
      const deps = createDeps({ selectedItems: new Set(['/a.txt', '/b.txt']) });
      const ctrl = createClipboardController(deps);
      await ctrl.copySelectedToFolder();
      expect(deps.handleDrop).toHaveBeenCalledWith(
        expect.arrayContaining(['/a.txt', '/b.txt']),
        '/new-dest',
        'copy'
      );
    });
  });

  describe('pasteIntoFolder', () => {
    it('returns early when target folder path is empty', async () => {
      setupTauriApi();
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.pasteIntoFolder('');

      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('moves items for system cut clipboard data', async () => {
      const tauriApi = setupTauriApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'cut',
          paths: ['/sys/file.txt'],
        }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.pasteIntoFolder('/target');

      expect(tauriApi.moveItems).toHaveBeenCalledWith(['/sys/file.txt'], '/target', 'ask');
      expect(deps.showToast).toHaveBeenCalledWith(
        '1 item(s) moved from system clipboard',
        'Success',
        'success'
      );
    });

    it('prompts elevation in pasteIntoFolder when system cut move is permission denied', async () => {
      const tauriApi = setupTauriApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'cut',
          paths: ['/sys/file.txt'],
        }),
        moveItems: vi.fn().mockResolvedValue({ success: false, error: 'permission denied' }),
        elevatedMoveBatch: vi.fn().mockResolvedValue({ success: true }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.pasteIntoFolder('/target');

      expect(deps.showConfirm).toHaveBeenCalled();
      expect(tauriApi.elevatedMoveBatch).toHaveBeenCalledWith(['/sys/file.txt'], '/target');
      expect(deps.showToast).toHaveBeenCalledWith(
        '1 item(s) moved (elevated)',
        'Success',
        'success'
      );
    });

    it('pastes local clipboard items into folder and refreshes', async () => {
      const tauriApi = setupTauriApi();
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      ctrl.setClipboard({ operation: 'copy', paths: ['/from/local.txt'] });

      await ctrl.pasteIntoFolder('/target');

      expect(tauriApi.copyItems).toHaveBeenCalledWith(['/from/local.txt'], '/target', 'ask');
      expect(deps.showToast).toHaveBeenCalledWith(
        '1 item(s) copied into folder',
        'Success',
        'success'
      );
      expect(deps.refresh).toHaveBeenCalledTimes(1);
    });

    it('shows operation failed toast for local paste errors', async () => {
      setupTauriApi({
        copyItems: vi.fn().mockResolvedValue({ success: false, error: 'copy denied' }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      ctrl.setClipboard({ operation: 'copy', paths: ['/from/local.txt'] });

      await ctrl.pasteIntoFolder('/target');

      expect(deps.showToast).toHaveBeenCalledWith('copy denied', 'Error', 'error');
    });

    it('shows cancelled toast when pasteIntoFolder elevation is declined', async () => {
      setupTauriApi({
        moveItems: vi.fn().mockResolvedValue({ success: false, error: 'permission denied' }),
      });
      const deps = createDeps();
      deps.showConfirm = vi.fn().mockResolvedValue(false);
      const ctrl = createClipboardController(deps);
      ctrl.setClipboard({ operation: 'cut', paths: ['/a.txt'] });

      await ctrl.pasteIntoFolder('/target');

      expect(deps.showToast).toHaveBeenCalledWith('Operation cancelled', 'Info', 'info');
    });

    it('shows elevated operation fallback error in pasteIntoFolder', async () => {
      const tauriApi = setupTauriApi({
        moveItems: vi.fn().mockResolvedValue({ success: false, error: 'permission denied' }),
        elevatedMoveBatch: vi.fn().mockResolvedValue({ success: false, error: '' }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      ctrl.setClipboard({ operation: 'cut', paths: ['/a.txt'] });

      await ctrl.pasteIntoFolder('/target');

      expect(tauriApi.elevatedMoveBatch).toHaveBeenCalledWith(['/a.txt'], '/target');
      expect(deps.showToast).toHaveBeenCalledWith('Elevated operation failed', 'Error', 'error');
    });

    it('shows paste operation failed when local folder paste throws', async () => {
      setupTauriApi({
        copyItems: vi.fn().mockRejectedValue(new Error('ipc down')),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      ctrl.setClipboard({ operation: 'copy', paths: ['/from/local.txt'] });

      await ctrl.pasteIntoFolder('/target');

      expect(deps.showToast).toHaveBeenCalledWith('Paste operation failed', 'Error', 'error');
    });
  });

  describe('duplicateItems', () => {
    it('returns when duplicate path list is empty', async () => {
      setupTauriApi();
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.duplicateItems([]);

      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('duplicates items successfully', async () => {
      const tauriApi = setupTauriApi();
      const deps = createDeps({ currentPath: '/dest-dir' });
      const ctrl = createClipboardController(deps);

      await ctrl.duplicateItems(['/a.txt', '/b.txt']);

      expect(tauriApi.copyItems).toHaveBeenCalledWith(['/a.txt', '/b.txt'], '/dest-dir', 'rename');
      expect(deps.showToast).toHaveBeenCalledWith('2 item(s) duplicated', 'Success', 'success');
      expect(deps.refresh).toHaveBeenCalledTimes(1);
    });

    it('uses elevated duplicate when permission is denied', async () => {
      const tauriApi = setupTauriApi({
        copyItems: vi.fn().mockResolvedValue({ success: false, error: 'EACCES' }),
        elevatedCopyBatch: vi.fn().mockResolvedValue({ success: true }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.duplicateItems(['/a.txt']);

      expect(deps.showConfirm).toHaveBeenCalled();
      expect(tauriApi.elevatedCopyBatch).toHaveBeenCalledWith(['/a.txt'], '/dest');
      expect(deps.showToast).toHaveBeenCalledWith(
        '1 item(s) duplicated (elevated)',
        'Success',
        'success'
      );
    });

    it('shows cancellation toast when elevated duplicate is declined', async () => {
      setupTauriApi({
        copyItems: vi.fn().mockResolvedValue({ success: false, error: 'permission denied' }),
      });
      const deps = createDeps();
      deps.showConfirm = vi.fn().mockResolvedValue(false);
      const ctrl = createClipboardController(deps);

      await ctrl.duplicateItems(['/a.txt']);

      expect(deps.showToast).toHaveBeenCalledWith('Operation cancelled', 'Info', 'info');
    });

    it('shows duplicate failed when duplicate operation throws', async () => {
      setupTauriApi({
        copyItems: vi.fn().mockRejectedValue(new Error('broken copy')),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.duplicateItems(['/a.txt']);

      expect(deps.showToast).toHaveBeenCalledWith('Duplicate failed', 'Error', 'error');
    });

    it('shows elevated duplicate fallback error when elevated copy fails', async () => {
      const tauriApi = setupTauriApi({
        copyItems: vi.fn().mockResolvedValue({ success: false, error: 'permission denied' }),
        elevatedCopyBatch: vi.fn().mockResolvedValue({ success: false, error: '' }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.duplicateItems(['/a.txt']);

      expect(tauriApi.elevatedCopyBatch).toHaveBeenCalledWith(['/a.txt'], '/dest');
      expect(deps.showToast).toHaveBeenCalledWith('Elevated duplicate failed', 'Error', 'error');
    });
  });

  describe('pasteFromClipboard concurrency', () => {
    it('ignores a second paste request while one is in progress', async () => {
      let resolveCopy: ((value: { success: boolean }) => void) | undefined;
      const copyItems = vi.fn(
        () =>
          new Promise<{ success: boolean }>((resolve) => {
            resolveCopy = resolve;
          })
      );
      setupTauriApi({ copyItems });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      ctrl.setClipboard({ operation: 'copy', paths: ['/a.txt'] });

      const first = ctrl.pasteFromClipboard();
      const second = ctrl.pasteFromClipboard();

      expect(copyItems).toHaveBeenCalledTimes(1);

      resolveCopy?.({ success: true });
      await first;
      await second;
    });
  });

  describe('isPermissionDeniedError', () => {
    it('detects common permission denied messages', () => {
      expect(isPermissionDeniedError('EACCES: permission denied')).toBe(true);
      expect(isPermissionDeniedError('Operation not permitted')).toBe(true);
      expect(isPermissionDeniedError('errno 13')).toBe(true);
      expect(isPermissionDeniedError('Access is denied')).toBe(true);
    });

    it('returns false for non-permission errors or empty input', () => {
      expect(isPermissionDeniedError('file not found')).toBe(false);
      expect(isPermissionDeniedError('')).toBe(false);
      expect(isPermissionDeniedError()).toBe(false);
    });
  });

  describe('updateClipboardIndicator', () => {
    it('hides indicator when clipboard is empty and globalClipboard is off', async () => {
      setupTauriApi();
      const deps = createDeps({ settingsOverrides: { globalClipboard: false } });
      const ctrl = createClipboardController(deps);
      await ctrl.updateClipboardIndicator();
      expect(document.getElementById('status-clipboard')!.style.display).toBe('none');
    });

    it('does nothing when indicator elements are missing', async () => {
      document.body.innerHTML = '';
      setupTauriApi();
      const deps = createDeps();
      const ctrl = createClipboardController(deps);

      await ctrl.updateClipboardIndicator();
    });

    it('shows system clipboard files info', async () => {
      setupTauriApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'copy',
          paths: ['/a.txt', '/b.txt'],
        }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      await ctrl.updateClipboardIndicator();
      expect(document.getElementById('status-clipboard-text')!.textContent).toBe('2 from system');
      expect(document.getElementById('status-clipboard')!.style.display).toBe('inline-flex');
    });

    it('shows system cut state in indicator', async () => {
      setupTauriApi({
        getSystemClipboardData: vi.fn().mockResolvedValue({
          operation: 'cut',
          paths: ['/a.txt'],
        }),
      });
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      await ctrl.updateClipboardIndicator();
      expect(document.getElementById('status-clipboard-text')!.textContent).toBe(
        '1 from system (cut)'
      );
      expect(document.getElementById('status-clipboard')!.classList.contains('cut-mode')).toBe(
        true
      );
    });

    it('shows local cut state and title text when local clipboard exists', async () => {
      setupTauriApi();
      const deps = createDeps();
      const ctrl = createClipboardController(deps);
      ctrl.setClipboard({ operation: 'cut', paths: ['/a.txt', '/b.txt'] });

      await ctrl.updateClipboardIndicator();

      expect(document.getElementById('status-clipboard-text')!.textContent).toBe('2 cut');
      expect(document.getElementById('status-clipboard')!.title).toBe('Clipboard: 2 cut');
      expect(document.getElementById('status-clipboard')!.classList.contains('cut-mode')).toBe(
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
      setupTauriApi();
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
      setupTauriApi();
      const deps = createDeps({ fileElementMap: fileMap, selectedItems: new Set(['/a']) });
      const ctrl = createClipboardController(deps);

      ctrl.cutToClipboard();
      expect(fileA.classList.contains('cut')).toBe(true);

      ctrl.setClipboard(null);
      ctrl.updateCutVisuals();
      expect(fileA.classList.contains('cut')).toBe(false);
    });

    it('clearCutPaths clears internal memory without retroactively removing css classes', () => {
      const fileA = document.createElement('div');
      const fileMap = new Map<string, HTMLElement>([['/a', fileA]]);
      setupTauriApi();
      const deps = createDeps({ fileElementMap: fileMap, selectedItems: new Set(['/a']) });
      const ctrl = createClipboardController(deps);

      ctrl.cutToClipboard();
      ctrl.clearCutPaths();
      ctrl.setClipboard(null);
      ctrl.updateCutVisuals();

      expect(fileA.classList.contains('cut')).toBe(true);
    });
  });
});
