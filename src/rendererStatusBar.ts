import type { Settings, FileItem } from './types';
import { formatFileSize } from './rendererFileIcons.js';
import { t } from './i18n.js';
import {
  statusItems,
  statusSelected,
  statusSearch,
  statusSearchText,
  selectionIndicator,
  selectionCount,
  statusHidden,
  announceToScreenReader,
} from './rendererElements.js';

export interface StatusBarDeps {
  getCurrentSettings: () => Settings;
  getSelectedItems: () => Set<string>;
  getAllFiles: () => FileItem[];
  getSecondaryPaneItems: () => FileItem[];
  getSelectedItemsSizeBytes: () => number;
  getHiddenFilesCount: () => number;
  getCurrentPath: () => string;
  getViewMode: () => string;
  getSearchStatusText: () => { active: boolean; text: string };
  syncDualPaneControls: () => void;
  updateUtilitySelection: (path: string | null) => void;
}

export function createStatusBarController(deps: StatusBarDeps) {
  function update(): void {
    const currentSettings = deps.getCurrentSettings();
    const selectedItems = deps.getSelectedItems();
    const allFiles = deps.getAllFiles();
    const activeItems =
      currentSettings.dualPaneEnabled === true && currentSettings.activePane === 'right'
        ? deps.getSecondaryPaneItems()
        : allFiles;
    if (statusItems) {
      statusItems.textContent = t('statusBar.items', { count: activeItems.length });
    }

    if (statusSelected) {
      if (selectedItems.size > 0) {
        const totalSize = deps.getSelectedItemsSizeBytes();
        const sizeStr = formatFileSize(totalSize);
        statusSelected.textContent = t('statusBar.selected', {
          count: selectedItems.size,
          size: sizeStr,
        });
        statusSelected.style.display = 'inline';
      } else {
        statusSelected.style.display = 'none';
      }
    }

    if (selectionIndicator && selectionCount) {
      if (selectedItems.size > 0) {
        selectionCount.textContent = String(selectedItems.size);
        selectionIndicator.style.display = 'inline-flex';
      } else {
        selectionIndicator.style.display = 'none';
      }
    }

    if (statusHidden) {
      if (!currentSettings.showHiddenFiles) {
        const hiddenCount = deps.getHiddenFilesCount();
        if (hiddenCount > 0) {
          statusHidden.textContent = t('statusBar.hidden', { count: hiddenCount });
          statusHidden.style.display = 'inline';
          statusHidden.title = 'Click to show hidden files';
        } else {
          statusHidden.style.display = 'none';
        }
      } else {
        statusHidden.style.display = 'none';
      }
    }

    if (statusSearch && statusSearchText) {
      const searchStatus = deps.getSearchStatusText();
      if (searchStatus.active) {
        statusSearchText.textContent = searchStatus.text;
        statusSearch.style.display = 'inline-flex';
        announceToScreenReader(t('statusBar.searchResultsAnnounce', { count: allFiles.length }));
      } else {
        statusSearch.style.display = 'none';
        const currentPath = deps.getCurrentPath();
        const folderName = currentPath ? currentPath.split(/[\\/]/).pop() || currentPath : '';
        const prefix = folderName ? `${folderName}: ` : '';
        announceToScreenReader(`${prefix}${t('statusBar.items', { count: allFiles.length })}`);
      }
    }
    const statusPane = document.getElementById('status-pane');
    const statusPaneText = document.getElementById('status-pane-text');
    if (statusPane && statusPaneText) {
      const dualPaneEnabled = currentSettings.dualPaneEnabled === true;
      statusPane.style.display = dualPaneEnabled ? 'inline-flex' : 'none';
      statusPaneText.textContent = currentSettings.activePane === 'right' ? 'Right' : 'Left';
    }
    const statusViewMode = document.getElementById('status-view-mode');
    const statusViewModeText = document.getElementById('status-view-mode-text');
    if (statusViewMode && statusViewModeText) {
      const viewMode = deps.getViewMode();
      const viewLabel = viewMode === 'column' ? 'Columns' : viewMode === 'list' ? 'List' : 'Grid';
      const sortLabel = `${currentSettings.sortBy} ${currentSettings.sortOrder.toUpperCase()}`;
      statusViewMode.style.display = 'inline-flex';
      statusViewModeText.textContent = `${viewLabel} · ${sortLabel}`;
    }
    deps.syncDualPaneControls();
    deps.updateUtilitySelection(
      selectedItems.size === 1 ? (Array.from(selectedItems)[0] ?? null) : null
    );
  }

  return { update };
}
