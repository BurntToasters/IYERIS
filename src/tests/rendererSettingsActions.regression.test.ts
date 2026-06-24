// @vitest-environment jsdom
/**
 * Regression tests for settings actions.
 * N5: refreshNativeIntegrationStatus must re-enable both buttons and show an
 *     error status when the IPC call rejects — previously the buttons were
 *     left permanently disabled.
 * N6b: "Clear search history" and "Clear bookmarks" must only commit the
 *      cleared state to in-memory currentSettings AFTER a successful save.
 *      Previously setCurrentSettings was called before the save, leaving
 *      memory cleared even if the disk write failed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSettingsActionsController } from '../rendererSettingsActions';

const NATIVE_IDS = [
  'native-integration-status-text',
  'native-integration-install-btn',
  'native-integration-uninstall-btn',
] as const;

const ACTION_BUTTON_IDS = [
  'export-settings-btn',
  'import-settings-btn',
  'clear-search-history-btn',
  'clear-bookmarks-btn',
  'clear-thumbnail-cache-btn',
  'open-logs-btn',
  'export-diagnostics-btn',
] as const;

function buildDom() {
  document.body.innerHTML = [
    ...ACTION_BUTTON_IDS.map((id) => `<button id="${id}"></button>`),
    `<p id="${NATIVE_IDS[0]}"></p>`,
    `<button id="${NATIVE_IDS[1]}" disabled></button>`,
    `<button id="${NATIVE_IDS[2]}" disabled></button>`,
  ].join('\n');
}

function makeDeps(
  settings: Record<string, unknown> = { searchHistory: ['q1'], bookmarks: ['/bm'] }
) {
  return {
    getCurrentSettings: vi.fn(() => ({ ...settings })),
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

function init(deps: ReturnType<typeof makeDeps>) {
  const ctrl = createSettingsActionsController(deps as any);
  ctrl.initSettingsActions();
  return ctrl;
}

describe('rendererSettingsActions — regressions', () => {
  beforeEach(() => {
    buildDom();
    vi.clearAllMocks();
  });

  // N5 -----------------------------------------------------------------------
  describe('N5 — native integration buttons must not stay disabled after IPC reject', () => {
    it('re-enables both buttons when getNativeIntegrationStatus rejects', async () => {
      (window as any).tauriAPI = {
        getNativeIntegrationStatus: vi.fn().mockRejectedValue(new Error('IPC error')),
        clearThumbnailCache: vi.fn(),
        openLogsFolder: vi.fn(),
        exportDiagnostics: vi.fn(),
      };
      const deps = makeDeps();
      init(deps);

      // Flush the automatic status check that fires on controller init.
      await new Promise((r) => setTimeout(r, 0));

      const installBtn = document.getElementById(
        'native-integration-install-btn'
      ) as HTMLButtonElement;
      const uninstallBtn = document.getElementById(
        'native-integration-uninstall-btn'
      ) as HTMLButtonElement;
      const statusText = document.getElementById('native-integration-status-text') as HTMLElement;

      expect(installBtn.disabled).toBe(false);
      expect(uninstallBtn.disabled).toBe(false);
      expect(statusText.textContent).toMatch(/failed|error/i);
    });

    it('shows error status text when getNativeIntegrationStatus rejects', async () => {
      (window as any).tauriAPI = {
        getNativeIntegrationStatus: vi.fn().mockRejectedValue(new Error('Network error')),
        clearThumbnailCache: vi.fn(),
        openLogsFolder: vi.fn(),
        exportDiagnostics: vi.fn(),
      };
      init(makeDeps());
      await new Promise((r) => setTimeout(r, 0));

      const statusText = document.getElementById('native-integration-status-text') as HTMLElement;
      expect(statusText.textContent).not.toBe('Checking integration status...');
    });

    it('sets buttons correctly when integration is installed', async () => {
      (window as any).tauriAPI = {
        getNativeIntegrationStatus: vi.fn().mockResolvedValue({
          success: true,
          supported: true,
          installed: true,
          message: 'Installed',
        }),
        clearThumbnailCache: vi.fn(),
        openLogsFolder: vi.fn(),
        exportDiagnostics: vi.fn(),
      };
      init(makeDeps());
      await new Promise((r) => setTimeout(r, 0));

      const installBtn = document.getElementById(
        'native-integration-install-btn'
      ) as HTMLButtonElement;
      const uninstallBtn = document.getElementById(
        'native-integration-uninstall-btn'
      ) as HTMLButtonElement;

      expect(installBtn.disabled).toBe(true);
      expect(uninstallBtn.disabled).toBe(false);
    });
  });

  // N6b ----------------------------------------------------------------------
  describe('N6b — clear actions only commit to memory after successful save', () => {
    it('does not call setCurrentSettings when clear-search-history save fails', async () => {
      (window as any).tauriAPI = {
        getNativeIntegrationStatus: vi.fn().mockResolvedValue({
          success: false,
          error: 'unsupported',
        }),
        clearThumbnailCache: vi.fn(),
        openLogsFolder: vi.fn(),
        exportDiagnostics: vi.fn(),
      };
      const deps = makeDeps({ searchHistory: ['q1', 'q2'] });
      deps.saveSettingsWithTimestamp = vi.fn().mockResolvedValue({
        success: false,
        error: 'Disk full',
      });
      init(deps);

      document.getElementById('clear-search-history-btn')!.click();
      await new Promise((r) => setTimeout(r, 0));

      expect(deps.setCurrentSettings).not.toHaveBeenCalled();
      expect(deps.showToast).toHaveBeenCalledWith(
        expect.stringMatching(/disk full|failed/i),
        'Data',
        'error'
      );
    });

    it('calls setCurrentSettings after successful clear-search-history save', async () => {
      (window as any).tauriAPI = {
        getNativeIntegrationStatus: vi.fn().mockResolvedValue({ success: false }),
        clearThumbnailCache: vi.fn(),
        openLogsFolder: vi.fn(),
        exportDiagnostics: vi.fn(),
      };
      const deps = makeDeps({ searchHistory: ['q1'] });
      init(deps);

      document.getElementById('clear-search-history-btn')!.click();
      await new Promise((r) => setTimeout(r, 0));

      expect(deps.setCurrentSettings).toHaveBeenCalledWith(
        expect.objectContaining({ searchHistory: [] })
      );
    });

    it('does not call setCurrentSettings when clear-bookmarks save fails', async () => {
      (window as any).tauriAPI = {
        getNativeIntegrationStatus: vi.fn().mockResolvedValue({ success: false }),
        clearThumbnailCache: vi.fn(),
        openLogsFolder: vi.fn(),
        exportDiagnostics: vi.fn(),
      };
      const deps = makeDeps({ bookmarks: ['/a', '/b'] });
      deps.saveSettingsWithTimestamp = vi.fn().mockResolvedValue({
        success: false,
        error: 'write error',
      });
      init(deps);

      document.getElementById('clear-bookmarks-btn')!.click();
      await new Promise((r) => setTimeout(r, 0));

      expect(deps.setCurrentSettings).not.toHaveBeenCalled();
      expect(deps.loadBookmarks).not.toHaveBeenCalled();
    });

    it('calls setCurrentSettings and loadBookmarks after successful clear-bookmarks save', async () => {
      (window as any).tauriAPI = {
        getNativeIntegrationStatus: vi.fn().mockResolvedValue({ success: false }),
        clearThumbnailCache: vi.fn(),
        openLogsFolder: vi.fn(),
        exportDiagnostics: vi.fn(),
      };
      const deps = makeDeps({ bookmarks: ['/a'] });
      init(deps);

      document.getElementById('clear-bookmarks-btn')!.click();
      await new Promise((r) => setTimeout(r, 0));

      expect(deps.setCurrentSettings).toHaveBeenCalledWith(
        expect.objectContaining({ bookmarks: [] })
      );
      expect(deps.loadBookmarks).toHaveBeenCalled();
    });
  });
});
