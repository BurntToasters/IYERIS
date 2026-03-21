import { isRecord } from './shared.js';
import { sanitizeSettings } from './settings.js';
import type { Settings } from './types';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface SettingsActionsDeps {
  getCurrentSettings: () => Settings;
  setCurrentSettings: (settings: Settings) => void;
  saveSettingsWithTimestamp: (settings: Settings) => Promise<{ success: boolean; error?: string }>;
  showToast: (message: string, title?: string, type?: ToastType) => void;
  showConfirm: (message: string, title: string) => Promise<boolean>;
  loadBookmarks: () => void;
  updateThumbnailCacheSize: () => void;
  clearThumbnailCacheLocal: () => void;
  hideSettingsModal: () => void | Promise<void>;
  showSettingsModal: () => void;
}

export function createSettingsActionsController(deps: SettingsActionsDeps) {
  function validateImportedSettings(imported: unknown): Partial<Settings> {
    if (!isRecord(imported)) return {};
    const sanitized = sanitizeSettings(imported);
    const result: Partial<Settings> = {};
    const data = imported as Record<string, unknown>;
    for (const key of Object.keys(data)) {
      if (key !== '_timestamp' && key in sanitized) {
        (result as Record<string, unknown>)[key] = sanitized[key as keyof Settings];
      }
    }
    return result;
  }

  function initSettingsActions(): void {
    document.getElementById('export-settings-btn')?.addEventListener('click', async () => {
      try {
        const settingsJson = JSON.stringify(deps.getCurrentSettings(), null, 2);
        const blob = new Blob([settingsJson], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `iyeris-settings-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        deps.showToast('Settings exported successfully', 'Export', 'success');
      } catch {
        deps.showToast('Failed to export settings', 'Export', 'error');
      }
    });

    document.getElementById('import-settings-btn')?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        try {
          const text = await file.text();
          const parsed = JSON.parse(text);

          const validatedSettings = validateImportedSettings(parsed);

          if (Object.keys(validatedSettings).length === 0) {
            deps.showToast('No valid settings found in file', 'Import', 'warning');
            return;
          }

          const nextSettings = { ...deps.getCurrentSettings(), ...validatedSettings };
          deps.setCurrentSettings(nextSettings);
          await deps.saveSettingsWithTimestamp(nextSettings);

          deps.hideSettingsModal();
          deps.showSettingsModal();
          deps.showToast(
            `Imported ${Object.keys(validatedSettings).length} settings successfully`,
            'Import',
            'success'
          );
        } catch {
          deps.showToast('Failed to import settings: Invalid file format', 'Import', 'error');
        }
      };
      input.click();
    });

    document.getElementById('clear-search-history-btn')?.addEventListener('click', async () => {
      const confirmed = await deps.showConfirm(
        'Are you sure you want to clear your search history?',
        'Clear Search History'
      );
      if (confirmed) {
        const nextSettings = { ...deps.getCurrentSettings(), searchHistory: [] };
        deps.setCurrentSettings(nextSettings);
        await deps.saveSettingsWithTimestamp(nextSettings);
        deps.showToast('Search history cleared', 'Data', 'success');
      }
    });

    document.getElementById('clear-bookmarks-btn')?.addEventListener('click', async () => {
      const confirmed = await deps.showConfirm(
        'Are you sure you want to clear all bookmarks?',
        'Clear Bookmarks'
      );
      if (confirmed) {
        const nextSettings = { ...deps.getCurrentSettings(), bookmarks: [] };
        deps.setCurrentSettings(nextSettings);
        await deps.saveSettingsWithTimestamp(nextSettings);
        deps.loadBookmarks();
        deps.showToast('Bookmarks cleared', 'Data', 'success');
      }
    });

    document.getElementById('clear-thumbnail-cache-btn')?.addEventListener('click', async () => {
      const confirmed = await deps.showConfirm(
        'Are you sure you want to clear the thumbnail cache?',
        'Clear Thumbnail Cache'
      );
      if (confirmed) {
        const result = await window.tauriAPI.clearThumbnailCache();
        if (!result.success) {
          deps.showToast(result.error || 'Failed to clear cache', 'Error', 'error');
          return;
        }
        deps.clearThumbnailCacheLocal();
        deps.showToast('Thumbnail cache cleared', 'Data', 'success');
        deps.updateThumbnailCacheSize();
      }
    });

    document.getElementById('open-logs-btn')?.addEventListener('click', async () => {
      const result = await window.tauriAPI.openLogsFolder();
      if (!result.success) {
        deps.showToast(result.error || 'Failed to open logs folder', 'Error', 'error');
      }
    });

    document.getElementById('export-diagnostics-btn')?.addEventListener('click', async () => {
      const result = await window.tauriAPI.exportDiagnostics();
      if (result.success) {
        const exportPath = result.path ? `\n${result.path}` : '';
        deps.showToast(`Diagnostics exported${exportPath}`, 'Diagnostics', 'success');
        return;
      }
      if (result.error === 'Export cancelled') {
        deps.showToast('Diagnostics export cancelled', 'Diagnostics', 'info');
        return;
      }
      deps.showToast(result.error || 'Failed to export diagnostics', 'Diagnostics', 'error');
    });
  }

  return { initSettingsActions };
}
