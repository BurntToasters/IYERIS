import type { TabState } from './tabs';

export interface CustomTheme {
  name: string;
  accentColor: string;
  bgPrimary: string;
  bgSecondary: string;
  textPrimary: string;
  textSecondary: string;
  glassBg: string;
  glassBorder: string;
}

export interface Settings {
  transparency: boolean;
  theme: 'dark' | 'light' | 'default' | 'custom';
  sortBy: 'name' | 'date' | 'size' | 'type';
  sortOrder: 'asc' | 'desc';
  bookmarks: string[];
  viewMode: 'grid' | 'list' | 'column';
  showDangerousOptions: boolean;
  startupPath: string;
  showHiddenFiles: boolean;
  enableSearchHistory: boolean;
  searchHistory: string[];
  directoryHistory: string[];
  enableIndexer: boolean;
  minimizeToTray: boolean;
  startOnLogin: boolean;
  autoCheckUpdates: boolean;
  customTheme?: CustomTheme;
  launchCount?: number;
  supportPopupDismissed?: boolean;
  skipFullDiskAccessPrompt?: boolean;
  recentFiles?: string[];
  folderIcons?: { [path: string]: string };
  showRecentFiles: boolean;
  enableTabs: boolean;
  globalContentSearch: boolean;
  tabState?: TabState;
  enableSyntaxHighlighting: boolean;
  enableGitStatus: boolean;

  reduceMotion: boolean;
  highContrast: boolean;
  largeText: boolean;
  boldText: boolean;
  visibleFocus: boolean;
  reduceTransparency: boolean;
  updateChannel: 'auto' | 'beta' | 'stable';
}
