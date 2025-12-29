import type { Settings } from './types';

export function createDefaultSettings(): Settings {
  return {
    transparency: true,
    theme: 'default',
    sortBy: 'name',
    sortOrder: 'asc',
    bookmarks: [],
    viewMode: 'grid',
    showDangerousOptions: false,
    startupPath: '',
    showHiddenFiles: false,
    enableSearchHistory: true,
    searchHistory: [],
    directoryHistory: [],
    enableIndexer: true,
    minimizeToTray: false,
    startOnLogin: false,
    autoCheckUpdates: true,
    launchCount: 0,
    supportPopupDismissed: false,
    skipFullDiskAccessPrompt: false,
    recentFiles: [],
    folderIcons: {},
    showRecentFiles: true,
    enableTabs: true,
    globalContentSearch: false
  };
}
