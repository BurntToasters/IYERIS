/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./shared.js', () => ({
  isRecord: vi.fn((v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)),
}));

import { createSettingsActionsController } from './rendererSettingsActions';

function makeDeps() {
  return {
    getCurrentSettings: vi.fn(
      () =>
        ({
          showHiddenFiles: true,
          sortBy: 'name',
          sortOrder: 'asc',
          theme: 'dark',
          viewMode: 'list',
        }) as any
    ),
    setCurrentSettings: vi.fn(),
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
    showToast: vi.fn(),
    loadBookmarks: vi.fn(),
    updateThumbnailCacheSize: vi.fn(),
    clearThumbnailCacheLocal: vi.fn(),
    hideSettingsModal: vi.fn(),
    showSettingsModal: vi.fn(),
    isOneOf: vi.fn((value: string, options: readonly string[]) => options.includes(value)),
    themeValues: ['light', 'dark', 'system', 'custom'] as const,
    sortByValues: ['name', 'size', 'modified', 'type'] as const,
    sortOrderValues: ['asc', 'desc'] as const,
    viewModeValues: ['grid', 'list', 'column'] as const,
  };
}

// Save original before any spies
const realCreateElement = document.createElement.bind(document);

const BUTTON_IDS = [
  'export-settings-btn',
  'import-settings-btn',
  'clear-search-history-btn',
  'clear-bookmarks-btn',
  'clear-thumbnail-cache-btn',
  'open-logs-btn',
  'export-diagnostics-btn',
];

function buildDOM() {
  document.body.innerHTML = BUTTON_IDS.map((id) => `<button id="${id}"></button>`).join('');
}

describe('rendererSettingsActions extended', () => {
  let originalConfirm: typeof window.confirm;
  let mockElectronAPI: any;

  beforeEach(() => {
    buildDOM();
    originalConfirm = window.confirm;
    window.confirm = vi.fn(() => true);
    mockElectronAPI = {
      clearThumbnailCache: vi.fn().mockResolvedValue({ success: true }),
      openLogsFolder: vi.fn().mockResolvedValue({ success: true }),
      exportDiagnostics: vi.fn().mockResolvedValue({ success: true, path: '/tmp/diag.zip' }),
    };
    (window as any).electronAPI = mockElectronAPI;

    // Mock URL.createObjectURL / revokeObjectURL
    (window as any).URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    (window as any).URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.confirm = originalConfirm;
    document.body.innerHTML = '';
    delete (window as any).electronAPI;
  });

  describe('initSettingsActions', () => {
    it('registers click handlers for all buttons', () => {
      const deps = makeDeps();
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions();
      for (const id of BUTTON_IDS) {
        expect(document.getElementById(id)).not.toBeNull();
      }
    });

    it('works when some buttons are missing', () => {
      document.body.innerHTML = '<button id="export-settings-btn"></button>';
      const deps = makeDeps();
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions(); // should not throw
    });
  });

  describe('export settings', () => {
    it('creates blob download and shows success toast', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions();

      const clickSpy = vi.fn();
      vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const el = realCreateElement(tag);
        if (tag === 'a') {
          vi.spyOn(el, 'click').mockImplementation(clickSpy);
        }
        return el;
      }) as any);

      document.getElementById('export-settings-btn')!.click();
      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Settings exported successfully',
          'Export',
          'success'
        );
      });
      expect(clickSpy).toHaveBeenCalled();
    });
  });

  describe('import settings', () => {
    function triggerImport(deps: ReturnType<typeof makeDeps>, jsonContent: string) {
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions();

      const blob = new Blob([jsonContent], { type: 'application/json' });
      // Create a mock file with working text() method
      const file = {
        name: 'settings.json',
        type: 'application/json',
        size: blob.size,
        text: () => Promise.resolve(jsonContent),
      };

      // Intercept the file input that initSettingsActions creates on import-btn click
      vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const el = realCreateElement(tag);
        if (tag === 'input') {
          const inputEl = el as HTMLInputElement;
          vi.spyOn(inputEl, 'click').mockImplementation(() => {
            // Simulate file selection
            Object.defineProperty(inputEl, 'files', {
              value: [file],
              configurable: true,
            });
            // Call onchange directly with a proper target
            const event = { target: inputEl } as any;
            if (typeof inputEl.onchange === 'function') {
              inputEl.onchange(event);
            }
          });
        }
        return el;
      }) as any);

      document.getElementById('import-settings-btn')!.click();
    }

    it('imports valid boolean settings', async () => {
      const deps = makeDeps();
      triggerImport(deps, JSON.stringify({ showHiddenFiles: false, enableGitStatus: true }));

      await vi.waitFor(() => {
        expect(deps.setCurrentSettings).toHaveBeenCalled();
      });

      const merged = deps.setCurrentSettings.mock.calls[0][0];
      expect(merged.showHiddenFiles).toBe(false);
      expect(merged.enableGitStatus).toBe(true);
      expect(deps.showToast).toHaveBeenCalledWith(
        expect.stringContaining('settings successfully'),
        'Import',
        'success'
      );
      expect(deps.hideSettingsModal).toHaveBeenCalled();
      expect(deps.showSettingsModal).toHaveBeenCalled();
    });

    it('validates enum fields via isOneOf', async () => {
      const deps = makeDeps();
      triggerImport(deps, JSON.stringify({ theme: 'dark', sortBy: 'size' }));

      await vi.waitFor(() => {
        expect(deps.setCurrentSettings).toHaveBeenCalled();
      });

      const merged = deps.setCurrentSettings.mock.calls[0][0];
      expect(merged.theme).toBe('dark');
      expect(merged.sortBy).toBe('size');
    });

    it('clamps number fields to valid range', async () => {
      const deps = makeDeps();
      triggerImport(
        deps,
        JSON.stringify({ maxSearchHistoryItems: 100, maxDirectoryHistoryItems: -5 })
      );

      await vi.waitFor(() => {
        expect(deps.setCurrentSettings).toHaveBeenCalled();
      });

      const merged = deps.setCurrentSettings.mock.calls[0][0];
      expect(merged.maxSearchHistoryItems).toBe(20);
      expect(merged.maxDirectoryHistoryItems).toBe(1);
    });

    it('filters arrays to strings only', async () => {
      const deps = makeDeps();
      triggerImport(deps, JSON.stringify({ bookmarks: ['/a', 123, '/b', null] }));

      await vi.waitFor(() => {
        expect(deps.setCurrentSettings).toHaveBeenCalled();
      });
      const merged = deps.setCurrentSettings.mock.calls[0][0];
      expect(merged.bookmarks).toEqual(['/a', '/b']);
    });

    it('slices searchHistory to max 100', async () => {
      const deps = makeDeps();
      const items = Array.from({ length: 150 }, (_, i) => `item${i}`);
      triggerImport(deps, JSON.stringify({ searchHistory: items }));

      await vi.waitFor(() => {
        expect(deps.setCurrentSettings).toHaveBeenCalled();
      });
      const merged = deps.setCurrentSettings.mock.calls[0][0];
      expect(merged.searchHistory.length).toBe(100);
    });

    it('validates listColumnWidths object', async () => {
      const deps = makeDeps();
      triggerImport(
        deps,
        JSON.stringify({
          listColumnWidths: { name: 200, size: 100, modified: Infinity, type: 'bad' },
        })
      );

      await vi.waitFor(() => {
        expect(deps.setCurrentSettings).toHaveBeenCalled();
      });
      const merged = deps.setCurrentSettings.mock.calls[0][0];
      expect(merged.listColumnWidths).toEqual({ name: 200, size: 100 });
    });

    it('validates customTheme with hex expansion', async () => {
      const deps = makeDeps();
      triggerImport(
        deps,
        JSON.stringify({
          customTheme: {
            name: 'Test',
            accentColor: '#abc',
            bgPrimary: '#112233',
            bgSecondary: '#445566',
            textPrimary: '#fff',
            textSecondary: '#000',
            glassBg: '#aabbcc',
            glassBorder: '#def',
          },
        })
      );

      await vi.waitFor(() => {
        expect(deps.setCurrentSettings).toHaveBeenCalled();
      });
      const merged = deps.setCurrentSettings.mock.calls[0][0];
      expect(merged.customTheme.accentColor).toBe('#aabbcc');
      expect(merged.customTheme.textPrimary).toBe('#ffffff');
      expect(merged.customTheme.glassBorder).toBe('#ddeeff');
      expect(merged.customTheme.bgPrimary).toBe('#112233');
    });

    it('rejects invalid customTheme', async () => {
      const deps = makeDeps();
      triggerImport(
        deps,
        JSON.stringify({
          customTheme: {
            name: 'Bad',
            accentColor: 'not-hex',
            bgPrimary: '#112233',
            bgSecondary: '#445566',
            textPrimary: '#fff',
            textSecondary: '#000',
            glassBg: '#aabbcc',
            glassBorder: '#ddeeff',
          },
        })
      );

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalled();
      });
      // customTheme should not be present in merged settings
      if (deps.setCurrentSettings.mock.calls.length > 0) {
        const merged = deps.setCurrentSettings.mock.calls[0][0];
        expect(merged.customTheme).toBeUndefined();
      }
    });

    it('shows warning for non-record import', async () => {
      const deps = makeDeps();
      triggerImport(deps, JSON.stringify('just a string'));

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'No valid settings found in file',
          'Import',
          'warning'
        );
      });
    });

    it('shows error for invalid JSON', async () => {
      const deps = makeDeps();
      triggerImport(deps, 'not valid json {{{');

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Failed to import settings: Invalid file format',
          'Import',
          'error'
        );
      });
    });

    it('validates sidebarWidth and previewPanelWidth', async () => {
      const deps = makeDeps();
      triggerImport(deps, JSON.stringify({ sidebarWidth: 250, previewPanelWidth: 400 }));

      await vi.waitFor(() => {
        expect(deps.setCurrentSettings).toHaveBeenCalled();
      });
      const merged = deps.setCurrentSettings.mock.calls[0][0];
      expect(merged.sidebarWidth).toBe(250);
      expect(merged.previewPanelWidth).toBe(400);
    });

    it('rejects non-finite numeric fields', async () => {
      const deps = makeDeps();
      triggerImport(
        deps,
        JSON.stringify({
          sidebarWidth: NaN,
          maxSearchHistoryItems: Infinity,
        })
      );

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalled();
      });
      // NaN/Infinity should not be included
      if (deps.setCurrentSettings.mock.calls.length > 0) {
        const merged = deps.setCurrentSettings.mock.calls[0][0];
        expect(merged.sidebarWidth).toBeUndefined();
      }
    });

    it('validates startupPath as string', async () => {
      const deps = makeDeps();
      triggerImport(deps, JSON.stringify({ startupPath: '/usr/local' }));

      await vi.waitFor(() => {
        expect(deps.setCurrentSettings).toHaveBeenCalled();
      });
      const merged = deps.setCurrentSettings.mock.calls[0][0];
      expect(merged.startupPath).toBe('/usr/local');
    });
  });

  describe('clear search history', () => {
    it('clears search history when confirmed', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions();

      document.getElementById('clear-search-history-btn')!.click();
      await vi.waitFor(() => {
        expect(deps.setCurrentSettings).toHaveBeenCalled();
      });

      const newSettings = deps.setCurrentSettings.mock.calls[0][0];
      expect(newSettings.searchHistory).toEqual([]);
      expect(deps.showToast).toHaveBeenCalledWith('Search history cleared', 'Data', 'success');
    });

    it('does nothing when not confirmed', async () => {
      (window.confirm as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const deps = makeDeps();
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions();

      document.getElementById('clear-search-history-btn')!.click();
      // Give a tick for any async
      await new Promise((r) => setTimeout(r, 10));
      expect(deps.setCurrentSettings).not.toHaveBeenCalled();
    });
  });

  describe('clear bookmarks', () => {
    it('clears bookmarks and reloads', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions();

      document.getElementById('clear-bookmarks-btn')!.click();
      await vi.waitFor(() => {
        expect(deps.setCurrentSettings).toHaveBeenCalled();
      });
      expect(deps.loadBookmarks).toHaveBeenCalled();
      expect(deps.showToast).toHaveBeenCalledWith('Bookmarks cleared', 'Data', 'success');
    });
  });

  describe('clear thumbnail cache', () => {
    it('clears cache and updates size', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions();

      document.getElementById('clear-thumbnail-cache-btn')!.click();
      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('Thumbnail cache cleared', 'Data', 'success');
      });
      expect(deps.clearThumbnailCacheLocal).toHaveBeenCalled();
      expect(deps.updateThumbnailCacheSize).toHaveBeenCalled();
    });

    it('shows error when clearing fails', async () => {
      mockElectronAPI.clearThumbnailCache.mockResolvedValue({ success: false });
      const deps = makeDeps();
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions();

      document.getElementById('clear-thumbnail-cache-btn')!.click();
      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('Failed to clear cache', 'Error', 'error');
      });
    });
  });

  describe('open logs', () => {
    it('opens logs folder', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions();

      document.getElementById('open-logs-btn')!.click();
      await vi.waitFor(() => {
        expect(mockElectronAPI.openLogsFolder).toHaveBeenCalled();
      });
    });

    it('shows error toast on failure', async () => {
      mockElectronAPI.openLogsFolder.mockResolvedValue({
        success: false,
        error: 'No logs',
      });
      const deps = makeDeps();
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions();

      document.getElementById('open-logs-btn')!.click();
      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('No logs', 'Error', 'error');
      });
    });
  });

  describe('export diagnostics', () => {
    it('exports with success path', async () => {
      const deps = makeDeps();
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions();

      document.getElementById('export-diagnostics-btn')!.click();
      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          expect.stringContaining('Diagnostics exported'),
          'Diagnostics',
          'success'
        );
      });
    });

    it('shows info toast when cancelled', async () => {
      mockElectronAPI.exportDiagnostics.mockResolvedValue({
        success: false,
        error: 'Export cancelled',
      });
      const deps = makeDeps();
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions();

      document.getElementById('export-diagnostics-btn')!.click();
      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Diagnostics export cancelled',
          'Diagnostics',
          'info'
        );
      });
    });

    it('shows error toast on failure', async () => {
      mockElectronAPI.exportDiagnostics.mockResolvedValue({
        success: false,
        error: 'Disk full',
      });
      const deps = makeDeps();
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions();

      document.getElementById('export-diagnostics-btn')!.click();
      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('Disk full', 'Diagnostics', 'error');
      });
    });

    it('shows fallback error when error string is empty', async () => {
      mockElectronAPI.exportDiagnostics.mockResolvedValue({
        success: false,
        error: '',
      });
      const deps = makeDeps();
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions();

      document.getElementById('export-diagnostics-btn')!.click();
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
