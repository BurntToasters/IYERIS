// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createSettingsActionsController } from '../rendererSettingsActions';

const BUTTON_IDS = [
  'export-settings-btn',
  'import-settings-btn',
  'clear-search-history-btn',
  'clear-bookmarks-btn',
  'clear-thumbnail-cache-btn',
  'open-logs-btn',
  'export-diagnostics-btn',
] as const;

const realCreateElement = document.createElement.bind(document);

function buildDom() {
  document.body.innerHTML = BUTTON_IDS.map((id) => `<button id="${id}"></button>`).join('');
}

function makeDeps() {
  return {
    getCurrentSettings: vi.fn(
      () =>
        ({
          theme: 'dark',
          showHiddenFiles: false,
          searchHistory: ['old-search'],
          bookmarks: ['/tmp/bookmark'],
        }) as any
    ),
    setCurrentSettings: vi.fn(),
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
    showToast: vi.fn(),
    showConfirm: vi.fn().mockResolvedValue(true),
    loadBookmarks: vi.fn(),
    updateThumbnailCacheSize: vi.fn(),
    clearThumbnailCacheLocal: vi.fn(),
    hideSettingsModal: vi.fn().mockResolvedValue(undefined),
    showSettingsModal: vi.fn(),
  };
}

function initController(deps: ReturnType<typeof makeDeps>) {
  const ctrl = createSettingsActionsController(deps as any);
  ctrl.initSettingsActions();
}

function click(id: (typeof BUTTON_IDS)[number]) {
  document.getElementById(id)!.click();
}

function mockImportInput(
  options: { text?: string; textError?: unknown; includeFile?: boolean } = {}
) {
  return vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
    const element = realCreateElement(tagName);
    if (tagName.toLowerCase() !== 'input') return element;

    const input = element as HTMLInputElement;
    vi.spyOn(input, 'click').mockImplementation(() => {
      const includeFile = options.includeFile !== false;
      const file = includeFile
        ? ({
            text: async () => {
              if (options.textError !== undefined) throw options.textError;
              return options.text ?? '{}';
            },
          } as File)
        : undefined;

      Object.defineProperty(input, 'files', {
        configurable: true,
        value: file ? [file] : [],
      });

      input.onchange?.({ target: input } as any);
    });

    return input;
  }) as typeof document.createElement);
}

describe('rendererSettingsActions', () => {
  let tauriApi: {
    clearThumbnailCache: ReturnType<typeof vi.fn>;
    openLogsFolder: ReturnType<typeof vi.fn>;
    exportDiagnostics: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    buildDom();

    tauriApi = {
      clearThumbnailCache: vi.fn().mockResolvedValue({ success: true }),
      openLogsFolder: vi.fn().mockResolvedValue({ success: true }),
      exportDiagnostics: vi.fn().mockResolvedValue({ success: true, path: '/tmp/diag.zip' }),
    };
    (window as any).tauriAPI = tauriApi;

    (window as any).URL.createObjectURL = vi.fn(() => 'blob:settings-url');
    (window as any).URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    delete (window as any).tauriAPI;
  });

  it('creates controller with initSettingsActions method', () => {
    const deps = makeDeps();
    const ctrl = createSettingsActionsController(deps as any);
    expect(ctrl.initSettingsActions).toBeTypeOf('function');
  });

  describe('export settings', () => {
    it('exports settings and revokes object URL', async () => {
      const deps = makeDeps();
      const anchorClick = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => undefined);

      initController(deps);
      click('export-settings-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Settings exported successfully',
          'Export',
          'success'
        );
      });

      expect((window as any).URL.createObjectURL).toHaveBeenCalledTimes(1);
      expect(anchorClick).toHaveBeenCalledTimes(1);
      expect((window as any).URL.revokeObjectURL).toHaveBeenCalledWith('blob:settings-url');
    });

    it('shows export error when stringify fails', async () => {
      const deps = makeDeps();
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      deps.getCurrentSettings.mockReturnValueOnce(circular as any);

      initController(deps);
      click('export-settings-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          expect.stringContaining('Failed to export settings:'),
          'Export',
          'error'
        );
      });

      expect((window as any).URL.revokeObjectURL).not.toHaveBeenCalled();
    });
  });

  describe('import settings', () => {
    it('returns early when no file is selected', async () => {
      const deps = makeDeps();
      mockImportInput({ includeFile: false });

      initController(deps);
      click('import-settings-btn');
      await Promise.resolve();

      expect(deps.setCurrentSettings).not.toHaveBeenCalled();
      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('shows warning for invalid file shape', async () => {
      const deps = makeDeps();
      mockImportInput({ text: '[]' });

      initController(deps);
      click('import-settings-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Invalid settings file format',
          'Import',
          'warning'
        );
      });
    });

    it('shows warning when imported file has no valid setting keys', async () => {
      const deps = makeDeps();
      mockImportInput({ text: JSON.stringify({ _timestamp: 1234, nope: true }) });

      initController(deps);
      click('import-settings-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'No valid settings found in file',
          'Import',
          'warning'
        );
      });
    });

    it('shows error when JSON parsing fails', async () => {
      const deps = makeDeps();
      mockImportInput({ text: '{"theme":' });

      initController(deps);
      click('import-settings-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          expect.stringContaining('Failed to import settings:'),
          'Import',
          'error'
        );
      });
    });

    it('shows error when file read throws', async () => {
      const deps = makeDeps();
      mockImportInput({ textError: new Error('read failed') });

      initController(deps);
      click('import-settings-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Failed to import settings: read failed',
          'Import',
          'error'
        );
      });
    });

    it('shows save error from saveSettingsWithTimestamp', async () => {
      const deps = makeDeps();
      deps.saveSettingsWithTimestamp.mockResolvedValueOnce({ success: false, error: 'disk full' });
      mockImportInput({ text: JSON.stringify({ showHiddenFiles: true }) });

      initController(deps);
      click('import-settings-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('disk full', 'Import', 'error');
      });

      expect(deps.hideSettingsModal).not.toHaveBeenCalled();
      expect(deps.showSettingsModal).not.toHaveBeenCalled();
    });

    it('uses save error fallback when save fails without message', async () => {
      const deps = makeDeps();
      deps.saveSettingsWithTimestamp.mockResolvedValueOnce({ success: false });
      mockImportInput({ text: JSON.stringify({ showHiddenFiles: true }) });

      initController(deps);
      click('import-settings-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Failed to save imported settings',
          'Import',
          'error'
        );
      });
    });

    it('shows import error when hideSettingsModal rejects', async () => {
      const deps = makeDeps();
      deps.hideSettingsModal.mockRejectedValueOnce(new Error('modal busy'));
      mockImportInput({ text: JSON.stringify({ showHiddenFiles: true }) });

      initController(deps);
      click('import-settings-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Failed to import settings: modal busy',
          'Import',
          'error'
        );
      });

      expect(deps.showSettingsModal).not.toHaveBeenCalled();
    });

    it('imports valid settings, excludes reserved keys, and shows success toast', async () => {
      const deps = makeDeps();
      mockImportInput({
        text: JSON.stringify({
          _timestamp: 999,
          showHiddenFiles: true,
          theme: 'light',
          nonSetting: 'ignore-me',
        }),
      });

      initController(deps);
      click('import-settings-btn');

      await vi.waitFor(() => {
        expect(deps.setCurrentSettings).toHaveBeenCalledTimes(1);
      });

      const next = deps.setCurrentSettings.mock.calls[0]![0];
      expect(next.showHiddenFiles).toBe(true);
      expect(next.theme).toBe('light');
      expect(next).not.toHaveProperty('_timestamp');

      expect(deps.saveSettingsWithTimestamp).toHaveBeenCalledWith(next);
      expect(deps.hideSettingsModal).toHaveBeenCalledTimes(1);
      expect(deps.showSettingsModal).toHaveBeenCalledTimes(1);
      expect(deps.showToast).toHaveBeenCalledWith(
        'Imported 2 settings successfully',
        'Import',
        'success'
      );
    });
  });

  describe('clear search history', () => {
    it('does nothing when confirmation is declined', async () => {
      const deps = makeDeps();
      deps.showConfirm.mockResolvedValueOnce(false);

      initController(deps);
      click('clear-search-history-btn');

      await vi.waitFor(() => {
        expect(deps.showConfirm).toHaveBeenCalled();
      });
      expect(deps.setCurrentSettings).not.toHaveBeenCalled();
      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('shows error when save fails', async () => {
      const deps = makeDeps();
      deps.saveSettingsWithTimestamp.mockResolvedValueOnce({
        success: false,
        error: 'save failed',
      });

      initController(deps);
      click('clear-search-history-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('save failed', 'Data', 'error');
      });
    });

    it('clears history and shows success on confirm', async () => {
      const deps = makeDeps();

      initController(deps);
      click('clear-search-history-btn');

      await vi.waitFor(() => {
        expect(deps.setCurrentSettings).toHaveBeenCalledTimes(1);
      });

      const next = deps.setCurrentSettings.mock.calls[0]![0];
      expect(next.searchHistory).toEqual([]);
      expect(deps.showToast).toHaveBeenCalledWith('Search history cleared', 'Data', 'success');
    });
  });

  describe('clear bookmarks', () => {
    it('does nothing when confirmation is declined', async () => {
      const deps = makeDeps();
      deps.showConfirm.mockResolvedValueOnce(false);

      initController(deps);
      click('clear-bookmarks-btn');

      await vi.waitFor(() => {
        expect(deps.showConfirm).toHaveBeenCalled();
      });
      expect(deps.setCurrentSettings).not.toHaveBeenCalled();
      expect(deps.loadBookmarks).not.toHaveBeenCalled();
    });

    it('uses fallback error when save fails without explicit message', async () => {
      const deps = makeDeps();
      deps.saveSettingsWithTimestamp.mockResolvedValueOnce({ success: false });

      initController(deps);
      click('clear-bookmarks-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('Failed to clear bookmarks', 'Data', 'error');
      });

      expect(deps.loadBookmarks).not.toHaveBeenCalled();
    });

    it('clears bookmarks, reloads UI, and shows success', async () => {
      const deps = makeDeps();

      initController(deps);
      click('clear-bookmarks-btn');

      await vi.waitFor(() => {
        expect(deps.loadBookmarks).toHaveBeenCalledTimes(1);
      });
      expect(deps.showToast).toHaveBeenCalledWith('Bookmarks cleared', 'Data', 'success');
    });
  });

  describe('clear thumbnail cache', () => {
    it('does nothing when confirmation is declined', async () => {
      const deps = makeDeps();
      deps.showConfirm.mockResolvedValueOnce(false);

      initController(deps);
      click('clear-thumbnail-cache-btn');

      await vi.waitFor(() => {
        expect(deps.showConfirm).toHaveBeenCalled();
      });
      expect(tauriApi.clearThumbnailCache).not.toHaveBeenCalled();
    });

    it('shows API error when clear cache fails', async () => {
      const deps = makeDeps();
      tauriApi.clearThumbnailCache.mockResolvedValueOnce({ success: false, error: 'tauri failed' });

      initController(deps);
      click('clear-thumbnail-cache-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('tauri failed', 'Error', 'error');
      });
      expect(deps.clearThumbnailCacheLocal).not.toHaveBeenCalled();
      expect(deps.updateThumbnailCacheSize).not.toHaveBeenCalled();
    });

    it('uses fallback API error when clear cache fails without message', async () => {
      const deps = makeDeps();
      tauriApi.clearThumbnailCache.mockResolvedValueOnce({ success: false });

      initController(deps);
      click('clear-thumbnail-cache-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('Failed to clear cache', 'Error', 'error');
      });
    });

    it('clears local cache and updates size on success', async () => {
      const deps = makeDeps();

      initController(deps);
      click('clear-thumbnail-cache-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('Thumbnail cache cleared', 'Data', 'success');
      });
      expect(deps.clearThumbnailCacheLocal).toHaveBeenCalledTimes(1);
      expect(deps.updateThumbnailCacheSize).toHaveBeenCalledTimes(1);
    });
  });

  describe('open logs', () => {
    it('shows explicit open logs error', async () => {
      const deps = makeDeps();
      tauriApi.openLogsFolder.mockResolvedValueOnce({ success: false, error: 'cannot open logs' });

      initController(deps);
      click('open-logs-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('cannot open logs', 'Error', 'error');
      });
    });

    it('uses fallback open logs error when API omits message', async () => {
      const deps = makeDeps();
      tauriApi.openLogsFolder.mockResolvedValueOnce({ success: false });

      initController(deps);
      click('open-logs-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('Failed to open logs folder', 'Error', 'error');
      });
    });
  });

  describe('export diagnostics', () => {
    it('shows success with export path', async () => {
      const deps = makeDeps();
      tauriApi.exportDiagnostics.mockResolvedValueOnce({ success: true, path: '/tmp/out.zip' });

      initController(deps);
      click('export-diagnostics-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Diagnostics exported\n/tmp/out.zip',
          'Diagnostics',
          'success'
        );
      });
    });

    it('shows success without export path', async () => {
      const deps = makeDeps();
      tauriApi.exportDiagnostics.mockResolvedValueOnce({ success: true });

      initController(deps);
      click('export-diagnostics-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Diagnostics exported',
          'Diagnostics',
          'success'
        );
      });
    });

    it('shows info when export is cancelled', async () => {
      const deps = makeDeps();
      tauriApi.exportDiagnostics.mockResolvedValueOnce({
        success: false,
        error: 'Export cancelled',
      });

      initController(deps);
      click('export-diagnostics-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Diagnostics export cancelled',
          'Diagnostics',
          'info'
        );
      });
    });

    it('shows explicit error for diagnostics failure', async () => {
      const deps = makeDeps();
      tauriApi.exportDiagnostics.mockResolvedValueOnce({ success: false, error: 'disk full' });

      initController(deps);
      click('export-diagnostics-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('disk full', 'Diagnostics', 'error');
      });
    });

    it('shows fallback error for diagnostics failure without message', async () => {
      const deps = makeDeps();
      tauriApi.exportDiagnostics.mockResolvedValueOnce({ success: false, error: '' });

      initController(deps);
      click('export-diagnostics-btn');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Failed to export diagnostics',
          'Diagnostics',
          'error'
        );
      });
    });
  });
});
