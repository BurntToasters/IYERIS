import { isRecord } from './shared.js';
import type { ListColumnWidths, Settings } from './types';

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
  hideSettingsModal: () => void;
  showSettingsModal: () => void;
  isOneOf: <T extends readonly string[]>(value: string, options: T) => value is T[number];
  themeValues: readonly Settings['theme'][];
  sortByValues: readonly Settings['sortBy'][];
  sortOrderValues: readonly Settings['sortOrder'][];
  viewModeValues: readonly Settings['viewMode'][];
}

export function createSettingsActionsController(deps: SettingsActionsDeps) {
  function validateImportedSettings(imported: unknown): Partial<Settings> {
    const validated: Partial<Settings> = {};
    if (!isRecord(imported)) return validated;
    const data = imported as Record<string, unknown>;

    if (typeof data.reduceTransparency === 'boolean')
      validated.reduceTransparency = data.reduceTransparency;
    if (typeof data.showDangerousOptions === 'boolean')
      validated.showDangerousOptions = data.showDangerousOptions;
    if (typeof data.showHiddenFiles === 'boolean') validated.showHiddenFiles = data.showHiddenFiles;
    if (typeof data.enableGitStatus === 'boolean') validated.enableGitStatus = data.enableGitStatus;
    if (typeof data.gitIncludeUntracked === 'boolean')
      validated.gitIncludeUntracked = data.gitIncludeUntracked;
    if (typeof data.showFileHoverCard === 'boolean')
      validated.showFileHoverCard = data.showFileHoverCard;
    if (typeof data.showFileCheckboxes === 'boolean')
      validated.showFileCheckboxes = data.showFileCheckboxes;
    if (typeof data.enableSearchHistory === 'boolean')
      validated.enableSearchHistory = data.enableSearchHistory;
    if (typeof data.enableIndexer === 'boolean') validated.enableIndexer = data.enableIndexer;
    if (typeof data.minimizeToTray === 'boolean') validated.minimizeToTray = data.minimizeToTray;
    if (typeof data.startOnLogin === 'boolean') validated.startOnLogin = data.startOnLogin;
    if (typeof data.autoCheckUpdates === 'boolean')
      validated.autoCheckUpdates = data.autoCheckUpdates;
    if (typeof data.showRecentFiles === 'boolean') validated.showRecentFiles = data.showRecentFiles;
    if (typeof data.showFolderTree === 'boolean') validated.showFolderTree = data.showFolderTree;
    if (typeof data.enableTabs === 'boolean') validated.enableTabs = data.enableTabs;
    if (typeof data.globalContentSearch === 'boolean')
      validated.globalContentSearch = data.globalContentSearch;

    if (typeof data.startupPath === 'string') validated.startupPath = data.startupPath;
    if (
      typeof data.maxSearchHistoryItems === 'number' &&
      Number.isFinite(data.maxSearchHistoryItems)
    ) {
      validated.maxSearchHistoryItems = Math.max(
        1,
        Math.min(20, Math.floor(data.maxSearchHistoryItems))
      );
    }
    if (
      typeof data.maxDirectoryHistoryItems === 'number' &&
      Number.isFinite(data.maxDirectoryHistoryItems)
    ) {
      validated.maxDirectoryHistoryItems = Math.max(
        1,
        Math.min(20, Math.floor(data.maxDirectoryHistoryItems))
      );
    }

    if (typeof data.theme === 'string' && deps.isOneOf(data.theme, deps.themeValues)) {
      validated.theme = data.theme;
    }

    if (typeof data.sortBy === 'string' && deps.isOneOf(data.sortBy, deps.sortByValues)) {
      validated.sortBy = data.sortBy;
    }

    if (typeof data.sortOrder === 'string' && deps.isOneOf(data.sortOrder, deps.sortOrderValues)) {
      validated.sortOrder = data.sortOrder;
    }

    if (typeof data.viewMode === 'string' && deps.isOneOf(data.viewMode, deps.viewModeValues)) {
      validated.viewMode = data.viewMode;
    }

    if (Array.isArray(data.bookmarks)) {
      validated.bookmarks = data.bookmarks.filter((b): b is string => typeof b === 'string');
    }
    if (Array.isArray(data.searchHistory)) {
      validated.searchHistory = data.searchHistory
        .filter((s): s is string => typeof s === 'string')
        .slice(0, 100);
    }
    if (Array.isArray(data.directoryHistory)) {
      validated.directoryHistory = data.directoryHistory
        .filter((d): d is string => typeof d === 'string')
        .slice(0, 100);
    }

    if (isRecord(data.listColumnWidths)) {
      const widths = data.listColumnWidths;
      const parsed: ListColumnWidths = {};
      (['name', 'type', 'size', 'modified'] as const).forEach((key) => {
        const value = widths[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          parsed[key] = value;
        }
      });
      if (Object.keys(parsed).length > 0) {
        validated.listColumnWidths = parsed;
      }
    }

    if (typeof data.sidebarWidth === 'number' && Number.isFinite(data.sidebarWidth)) {
      validated.sidebarWidth = data.sidebarWidth;
    }

    if (typeof data.previewPanelWidth === 'number' && Number.isFinite(data.previewPanelWidth)) {
      validated.previewPanelWidth = data.previewPanelWidth;
    }

    if (isRecord(data.customTheme)) {
      const ct = data.customTheme;
      const isValidHex = (s: unknown): s is string =>
        typeof s === 'string' && (/^#[0-9a-fA-F]{6}$/.test(s) || /^#[0-9a-fA-F]{3}$/.test(s));
      const expandHex = (s: string) => {
        if (/^#[0-9a-fA-F]{3}$/.test(s)) {
          return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
        }
        return s;
      };
      if (
        typeof ct.name === 'string' &&
        isValidHex(ct.accentColor) &&
        isValidHex(ct.bgPrimary) &&
        isValidHex(ct.bgSecondary) &&
        isValidHex(ct.textPrimary) &&
        isValidHex(ct.textSecondary) &&
        isValidHex(ct.glassBg) &&
        isValidHex(ct.glassBorder)
      ) {
        validated.customTheme = {
          name: ct.name,
          accentColor: expandHex(ct.accentColor),
          bgPrimary: expandHex(ct.bgPrimary),
          bgSecondary: expandHex(ct.bgSecondary),
          textPrimary: expandHex(ct.textPrimary),
          textSecondary: expandHex(ct.textSecondary),
          glassBg: expandHex(ct.glassBg),
          glassBorder: expandHex(ct.glassBorder),
        };
      }
    }

    return validated;
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
        const result = await window.electronAPI.clearThumbnailCache();
        if (result.success) {
          deps.clearThumbnailCacheLocal();
          deps.showToast('Thumbnail cache cleared', 'Data', 'success');
          deps.updateThumbnailCacheSize();
        } else {
          deps.showToast('Failed to clear cache', 'Error', 'error');
        }
      }
    });

    document.getElementById('open-logs-btn')?.addEventListener('click', async () => {
      const result = await window.electronAPI.openLogsFolder();
      if (!result.success) {
        deps.showToast(result.error || 'Failed to open logs folder', 'Error', 'error');
      }
    });

    document.getElementById('export-diagnostics-btn')?.addEventListener('click', async () => {
      const result = await window.electronAPI.exportDiagnostics();
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
