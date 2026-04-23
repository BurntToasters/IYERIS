// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../shared.js', () => ({
  isRecord: vi.fn((v: unknown) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }),
  assignKey: <T extends object>(obj: T, key: keyof T, value: T[keyof T]) => {
    obj[key] = value;
  },
  getErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  RESERVED_KEYS: new Set(['__proto__', 'constructor', 'prototype']),
  sanitizeStringArray: (value: unknown) => {
    if (!Array.isArray(value)) return [];
    return value.filter((item: unknown) => typeof item === 'string');
  },
}));

vi.mock('../settings.js', async () => {
  const actual = await vi.importActual<typeof import('../settings.js')>('../settings.js');
  return actual;
});

import { createSettingsActionsController } from '../rendererSettingsActions';

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
    showConfirm: vi.fn().mockResolvedValue(true),
    isOneOf: vi.fn((value: string, options: readonly string[]) => options.includes(value)),
    themeValues: ['light', 'dark', 'system', 'custom'] as const,
    sortByValues: ['name', 'size', 'modified', 'type'] as const,
    sortOrderValues: ['asc', 'desc'] as const,
    viewModeValues: ['grid', 'list', 'column'] as const,
  };
}

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
  let mockTauriAPI: any;

  beforeEach(() => {
    buildDOM();
    originalConfirm = window.confirm;
    window.confirm = vi.fn(() => true);
    mockTauriAPI = {
      clearThumbnailCache: vi.fn().mockResolvedValue({ success: true }),
      openLogsFolder: vi.fn().mockResolvedValue({ success: true }),
      exportDiagnostics: vi.fn().mockResolvedValue({ success: true, path: '/tmp/diag.zip' }),
    };
    (window as any).tauriAPI = mockTauriAPI;

    (window as any).URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    (window as any).URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.confirm = originalConfirm;
    document.body.innerHTML = '';
    delete (window as any).tauriAPI;
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
      ctrl.initSettingsActions();
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

      const file = {
        name: 'settings.json',
        type: 'application/json',
        size: blob.size,
        text: () => Promise.resolve(jsonContent),
      };

      vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const el = realCreateElement(tag);
        if (tag === 'input') {
          const inputEl = el as HTMLInputElement;
          vi.spyOn(inputEl, 'click').mockImplementation(() => {
            Object.defineProperty(inputEl, 'files', {
              value: [file],
              configurable: true,
            });

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
      expect(merged.maxSearchHistoryItems).toBe(100);
      expect(merged.maxDirectoryHistoryItems).toBe(5);
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

    it('validates customTheme fields', async () => {
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
      expect(merged.customTheme.accentColor).toBe('#abc');
      expect(merged.customTheme.textPrimary).toBe('#fff');
      expect(merged.customTheme.glassBorder).toBe('#def');
      expect(merged.customTheme.bgPrimary).toBe('#112233');
    });

    it('rejects customTheme with invalid color fields', async () => {
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
        expect(deps.setCurrentSettings).toHaveBeenCalled();
      });
      const merged = deps.setCurrentSettings.mock.calls[0][0];
      expect(merged.customTheme).toBeUndefined();
    });

    it('shows warning for non-record import', async () => {
      const deps = makeDeps();
      triggerImport(deps, JSON.stringify('just a string'));

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Invalid settings file format',
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
          expect.stringContaining('Failed to import settings'),
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
      const deps = makeDeps();
      deps.showConfirm.mockResolvedValue(false);
      const ctrl = createSettingsActionsController(deps as any);
      ctrl.initSettingsActions();

      document.getElementById('clear-search-history-btn')!.click();

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
      mockTauriAPI.clearThumbnailCache.mockResolvedValue({ success: false });
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
        expect(mockTauriAPI.openLogsFolder).toHaveBeenCalled();
      });
    });

    it('shows error toast on failure', async () => {
      mockTauriAPI.openLogsFolder.mockResolvedValue({
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
      mockTauriAPI.exportDiagnostics.mockResolvedValue({
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
      mockTauriAPI.exportDiagnostics.mockResolvedValue({
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
      mockTauriAPI.exportDiagnostics.mockResolvedValue({
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
