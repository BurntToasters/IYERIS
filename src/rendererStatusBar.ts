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
  saveSettings: () => void;
  updateGitBranch?: (path: string) => Promise<void> | void;
  updateClipboardIndicator?: () => Promise<void> | void;
}

export function createStatusBarController(deps: StatusBarDeps) {
  // Listen to right-click context menu on the status bar
  const statusBarEl = document.querySelector('.status-bar') as HTMLElement | null;
  if (statusBarEl) {
    statusBarEl.addEventListener('contextmenu', showStatusBarContextMenu);
  }

  function showStatusBarContextMenu(e: MouseEvent): void {
    e.preventDefault();

    // Remove any existing status bar context menus
    const existing = document.querySelector('.status-bar-context-menu');
    if (existing) existing.remove();

    const currentSettings = deps.getCurrentSettings();
    const configItems = currentSettings.statusBarItems || {};

    const menu = document.createElement('div');
    menu.className = 'status-bar-context-menu context-menu';
    menu.style.position = 'fixed';
    menu.style.zIndex = '10000';
    menu.style.display = 'block';

    const itemsList = [
      { key: 'items', label: 'Item Count' },
      { key: 'selected', label: 'Selection Info' },
      { key: 'hidden', label: 'Hidden Files' },
      { key: 'search', label: 'Search Status' },
      { key: 'pane', label: 'Active Pane' },
      { key: 'viewMode', label: 'View Mode & Sort' },
      { key: 'gitBranch', label: 'Git Branch' },
      { key: 'clipboard', label: 'Clipboard' },
    ];

    itemsList.forEach((item) => {
      const checked = configItems[item.key] !== false;
      const menuItem = document.createElement('div');
      menuItem.className = 'context-menu-item';
      menuItem.style.display = 'flex';
      menuItem.style.alignItems = 'center';
      menuItem.style.gap = '8px';

      const checkbox = document.createElement('span');
      checkbox.className = 'status-menu-checkbox';
      checkbox.innerHTML = checked ? '✓' : '&nbsp;&nbsp;';
      checkbox.style.fontWeight = 'bold';
      checkbox.style.width = '12px';

      const label = document.createElement('span');
      label.textContent = item.label;

      menuItem.appendChild(checkbox);
      menuItem.appendChild(label);

      menuItem.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!currentSettings.statusBarItems) {
          currentSettings.statusBarItems = {};
        }
        const enabled = !checked;
        currentSettings.statusBarItems[item.key] = enabled;

        deps.saveSettings();
        update();
        refreshExternalStatusItem(item.key, enabled);
        menu.remove();
      });

      menu.appendChild(menuItem);
    });

    document.body.appendChild(menu);

    // Position menu clamping to avoid off-screen
    let left = e.clientX;
    let top = e.clientY;
    const menuWidth = 180;
    const menuHeight = 240;
    if (left + menuWidth > window.innerWidth) {
      left = window.innerWidth - menuWidth - 10;
    }
    if (top + menuHeight > window.innerHeight) {
      top = window.innerHeight - menuHeight - 10;
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const closeMenu = () => {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    };

    setTimeout(() => {
      document.addEventListener('click', closeMenu);
    }, 10);
  }

  function refreshExternalStatusItem(key: string, enabled: boolean): void {
    if (!enabled) return;
    if (key === 'gitBranch') {
      void deps.updateGitBranch?.(deps.getCurrentPath());
    } else if (key === 'clipboard') {
      void deps.updateClipboardIndicator?.();
    }
  }

  function update(): void {
    const currentSettings = deps.getCurrentSettings();
    const configItems = currentSettings.statusBarItems || {};
    const selectedItems = deps.getSelectedItems();
    const allFiles = deps.getAllFiles();
    const activeItems =
      currentSettings.dualPaneEnabled === true && currentSettings.activePane === 'right'
        ? deps.getSecondaryPaneItems()
        : allFiles;

    if (statusItems) {
      statusItems.textContent = t('statusBar.items', { count: activeItems.length });
      statusItems.style.display = configItems.items !== false ? 'inline' : 'none';
    }

    const showSelected = configItems.selected !== false && selectedItems.size > 0;
    if (statusSelected) {
      if (showSelected) {
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
      if (showSelected) {
        selectionCount.textContent = String(selectedItems.size);
        selectionIndicator.style.display = 'inline-flex';
      } else {
        selectionIndicator.style.display = 'none';
      }
    }

    if (statusHidden) {
      const hiddenCount = deps.getHiddenFilesCount();
      if (configItems.hidden !== false && !currentSettings.showHiddenFiles && hiddenCount > 0) {
        statusHidden.textContent = t('statusBar.hidden', { count: hiddenCount });
        statusHidden.style.display = 'inline';
        statusHidden.title = 'Click to show hidden files';
      } else {
        statusHidden.style.display = 'none';
      }
    }

    if (statusSearch && statusSearchText) {
      const searchStatus = deps.getSearchStatusText();
      if (configItems.search !== false && searchStatus.active) {
        statusSearchText.textContent = searchStatus.text;
        statusSearch.style.display = 'inline-flex';
        announceToScreenReader(t('statusBar.searchResultsAnnounce', { count: allFiles.length }));
      } else {
        statusSearch.style.display = 'none';
        if (!searchStatus.active) {
          const currentPath = deps.getCurrentPath();
          const folderName = currentPath ? currentPath.split(/[\\/]/).pop() || currentPath : '';
          const prefix = folderName ? `${folderName}: ` : '';
          announceToScreenReader(`${prefix}${t('statusBar.items', { count: allFiles.length })}`);
        }
      }
    }

    const statusPane = document.getElementById('status-pane');
    const statusPaneText = document.getElementById('status-pane-text');
    if (statusPane && statusPaneText) {
      const dualPaneEnabled = currentSettings.dualPaneEnabled === true;
      statusPane.style.display =
        configItems.pane !== false && dualPaneEnabled ? 'inline-flex' : 'none';
      statusPaneText.textContent = currentSettings.activePane === 'right' ? 'Right' : 'Left';
    }

    const statusViewMode = document.getElementById('status-view-mode');
    const statusViewModeText = document.getElementById('status-view-mode-text');
    if (statusViewMode && statusViewModeText) {
      const viewMode = deps.getViewMode();
      const viewLabel = viewMode === 'column' ? 'Columns' : viewMode === 'list' ? 'List' : 'Grid';
      const sortLabel = `${currentSettings.sortBy} ${currentSettings.sortOrder.toUpperCase()}`;
      statusViewMode.style.display = configItems.viewMode !== false ? 'inline-flex' : 'none';
      statusViewModeText.textContent = `${viewLabel} · ${sortLabel}`;
    }

    // Central overrides for gitBranch and clipboard
    const statusGitBranch = document.getElementById('status-git-branch');
    if (statusGitBranch && configItems.gitBranch === false) {
      statusGitBranch.style.display = 'none';
    }

    const statusClipboard = document.getElementById('status-clipboard');
    if (statusClipboard && configItems.clipboard === false) {
      statusClipboard.style.display = 'none';
    }

    deps.syncDualPaneControls();
    deps.updateUtilitySelection(
      selectedItems.size === 1 ? (Array.from(selectedItems)[0] ?? null) : null
    );
  }

  return { update };
}
