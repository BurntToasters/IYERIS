import type { Settings } from './types';
import { getDefaultShortcuts } from './shortcuts.js';

export function createDefaultSettings(): Settings {
  return {
    shortcuts: getDefaultShortcuts(),
    theme: 'default',
    useSystemTheme: false,
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
    tourPromptDismissed: false,
    tourCompleted: false,
    skipFullDiskAccessPrompt: false,
    recentFiles: [],
    folderIcons: {},
    showRecentFiles: true,
    showFolderTree: true,
    enableTabs: true,
    globalContentSearch: false,
    globalClipboard: true,
    enableSyntaxHighlighting: true,
    enableGitStatus: false,
    gitIncludeUntracked: true,
    showFileHoverCard: true,
    showFileCheckboxes: false,

    reduceMotion: false,
    highContrast: false,
    largeText: false,
    boldText: false,
    visibleFocus: false,
    reduceTransparency: false,
    liquidGlassMode: false,
    uiDensity: 'default',
    updateChannel: 'auto',
    themedIcons: false,
    disableHardwareAcceleration: false,
    useSystemFontSize: false,

    confirmFileOperations: false,
    fileConflictBehavior: 'ask',
    skipElevationConfirmation: false,
    maxThumbnailSizeMB: 10,
    thumbnailQuality: 'medium',
    autoPlayVideos: false,
    previewPanelPosition: 'right',
    maxPreviewSizeMB: 50,
    gridColumns: 'auto',
    iconSize: 64,
    compactFileInfo: false,
    showFileExtensions: true,
    maxSearchHistoryItems: 5,
    maxDirectoryHistoryItems: 5,
  };
}

type UnknownRecord = Record<string, unknown>;

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const THEME_VALUES = new Set<Settings['theme']>([
  'dark',
  'light',
  'default',
  'custom',
  'nord',
  'catppuccin',
  'dracula',
  'solarized',
  'github',
]);
const SORT_BY_VALUES = new Set<Settings['sortBy']>(['name', 'date', 'size', 'type']);
const SORT_ORDER_VALUES = new Set<Settings['sortOrder']>(['asc', 'desc']);
const VIEW_MODE_VALUES = new Set<Settings['viewMode']>(['grid', 'list', 'column']);
const UI_DENSITY_VALUES = new Set<Settings['uiDensity']>(['compact', 'default', 'larger']);
const UPDATE_CHANNEL_VALUES = new Set<Settings['updateChannel']>(['auto', 'beta', 'stable']);
const FILE_CONFLICT_VALUES = new Set<Settings['fileConflictBehavior']>([
  'ask',
  'rename',
  'skip',
  'overwrite',
]);
const THUMBNAIL_QUALITY_VALUES = new Set<Settings['thumbnailQuality']>(['low', 'medium', 'high']);
const PREVIEW_PANEL_VALUES = new Set<Settings['previewPanelPosition']>(['right', 'bottom']);
const GRID_COLUMNS_VALUES = new Set<Settings['gridColumns']>(['auto', '2', '3', '4', '5', '6']);

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string');
}

function sanitizeEnum<T extends string>(value: unknown, allowed: Set<T>): T | null {
  if (typeof value !== 'string') return null;
  return allowed.has(value as T) ? (value as T) : null;
}

function sanitizeNumber(value: unknown): number | null {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function sanitizeInt(
  value: unknown,
  min: number | null = null,
  max: number | null = null
): number | null {
  const numeric = sanitizeNumber(value);
  if (numeric === null) return null;
  const intValue = Math.trunc(numeric);
  if (min !== null && intValue < min) return null;
  if (max !== null && intValue > max) return null;
  return intValue;
}

function sanitizeCustomTheme(value: unknown): Settings['customTheme'] | undefined {
  if (!isRecord(value)) return undefined;
  const {
    name,
    accentColor,
    bgPrimary,
    bgSecondary,
    textPrimary,
    textSecondary,
    glassBg,
    glassBorder,
  } = value;
  if (
    typeof name !== 'string' ||
    typeof accentColor !== 'string' ||
    typeof bgPrimary !== 'string' ||
    typeof bgSecondary !== 'string' ||
    typeof textPrimary !== 'string' ||
    typeof textSecondary !== 'string' ||
    typeof glassBg !== 'string' ||
    typeof glassBorder !== 'string'
  ) {
    return undefined;
  }
  return {
    name,
    accentColor,
    bgPrimary,
    bgSecondary,
    textPrimary,
    textSecondary,
    glassBg,
    glassBorder,
  };
}

function sanitizeShortcuts(
  value: unknown,
  defaults: Record<string, string[]>
): Record<string, string[]> {
  const result: Record<string, string[]> = { ...defaults };
  if (!isRecord(value)) return result;
  for (const key of Object.keys(value)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) continue;
    const binding = value[key];
    if (!Array.isArray(binding)) continue;
    result[key] = binding.filter((item) => typeof item === 'string');
  }
  return result;
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isRecord(value)) return result;
  for (const key of Object.keys(value)) {
    if (RESERVED_KEYS.has(key)) continue;
    const item = value[key];
    if (typeof item === 'string') {
      result[key] = item;
    }
  }
  return result;
}

function sanitizeListColumnWidths(value: unknown): Settings['listColumnWidths'] | undefined {
  if (!isRecord(value)) return undefined;
  const clean: Settings['listColumnWidths'] = {};
  const name = sanitizeNumber(value.name);
  const type = sanitizeNumber(value.type);
  const size = sanitizeNumber(value.size);
  const modified = sanitizeNumber(value.modified);
  if (name !== null) clean.name = name;
  if (type !== null) clean.type = type;
  if (size !== null) clean.size = size;
  if (modified !== null) clean.modified = modified;
  return Object.keys(clean).length > 0 ? clean : undefined;
}

type TabStateValue = NonNullable<Settings['tabState']>;

function sanitizeTabState(value: unknown): Settings['tabState'] | undefined {
  if (!isRecord(value)) return undefined;
  const tabsRaw = Array.isArray(value.tabs) ? value.tabs : [];
  const tabs: TabStateValue['tabs'] = [];

  for (const tabValue of tabsRaw) {
    if (!isRecord(tabValue)) continue;
    const id = typeof tabValue.id === 'string' ? tabValue.id : null;
    const path = typeof tabValue.path === 'string' ? tabValue.path : null;
    if (!id || !path) continue;
    const history = Array.isArray(tabValue.history) ? sanitizeStringArray(tabValue.history) : [];
    const selectedItems = Array.isArray(tabValue.selectedItems)
      ? sanitizeStringArray(tabValue.selectedItems)
      : [];
    const scrollPosition = sanitizeNumber(tabValue.scrollPosition) ?? 0;
    let historyIndex = sanitizeInt(tabValue.historyIndex, -1, null) ?? -1;
    if (history.length === 0) {
      historyIndex = -1;
    } else if (historyIndex >= history.length) {
      historyIndex = history.length - 1;
    }

    tabs.push({
      id,
      path,
      history,
      historyIndex,
      selectedItems,
      scrollPosition,
    });
  }

  if (tabs.length === 0) return undefined;

  let activeTabId = typeof value.activeTabId === 'string' ? value.activeTabId : tabs[0].id;
  if (!tabs.some((tab) => tab.id === activeTabId)) {
    activeTabId = tabs[0].id;
  }

  return { tabs, activeTabId };
}

export function sanitizeSettings(
  raw: unknown,
  defaults: Settings = createDefaultSettings()
): Settings {
  const clean: Settings = {
    ...defaults,
    shortcuts: { ...defaults.shortcuts },
    bookmarks: [...defaults.bookmarks],
    searchHistory: [...defaults.searchHistory],
    directoryHistory: [...defaults.directoryHistory],
    recentFiles: defaults.recentFiles ? [...defaults.recentFiles] : [],
    folderIcons: defaults.folderIcons ? { ...defaults.folderIcons } : {},
    tabState: defaults.tabState ? { ...defaults.tabState } : undefined,
    listColumnWidths: defaults.listColumnWidths ? { ...defaults.listColumnWidths } : undefined,
    customTheme: defaults.customTheme ? { ...defaults.customTheme } : undefined,
  };

  if (!isRecord(raw)) return clean;

  const theme = sanitizeEnum(raw.theme, THEME_VALUES);
  if (theme) clean.theme = theme;

  if (typeof raw.useSystemTheme === 'boolean') clean.useSystemTheme = raw.useSystemTheme;

  const sortBy = sanitizeEnum(raw.sortBy, SORT_BY_VALUES);
  if (sortBy) clean.sortBy = sortBy;

  const sortOrder = sanitizeEnum(raw.sortOrder, SORT_ORDER_VALUES);
  if (sortOrder) clean.sortOrder = sortOrder;

  const viewMode = sanitizeEnum(raw.viewMode, VIEW_MODE_VALUES);
  if (viewMode) clean.viewMode = viewMode;

  if (typeof raw.showDangerousOptions === 'boolean')
    clean.showDangerousOptions = raw.showDangerousOptions;
  if (typeof raw.startupPath === 'string') clean.startupPath = raw.startupPath;
  if (typeof raw.showHiddenFiles === 'boolean') clean.showHiddenFiles = raw.showHiddenFiles;
  if (typeof raw.enableSearchHistory === 'boolean')
    clean.enableSearchHistory = raw.enableSearchHistory;
  if (typeof raw.enableIndexer === 'boolean') clean.enableIndexer = raw.enableIndexer;
  if (typeof raw.minimizeToTray === 'boolean') clean.minimizeToTray = raw.minimizeToTray;
  if (typeof raw.startOnLogin === 'boolean') clean.startOnLogin = raw.startOnLogin;
  if (typeof raw.autoCheckUpdates === 'boolean') clean.autoCheckUpdates = raw.autoCheckUpdates;
  if (typeof raw.showRecentFiles === 'boolean') clean.showRecentFiles = raw.showRecentFiles;
  if (typeof raw.showFolderTree === 'boolean') clean.showFolderTree = raw.showFolderTree;
  if (typeof raw.enableTabs === 'boolean') clean.enableTabs = raw.enableTabs;
  if (typeof raw.globalContentSearch === 'boolean')
    clean.globalContentSearch = raw.globalContentSearch;
  if (typeof raw.globalClipboard === 'boolean') clean.globalClipboard = raw.globalClipboard;
  if (typeof raw.enableSyntaxHighlighting === 'boolean')
    clean.enableSyntaxHighlighting = raw.enableSyntaxHighlighting;
  if (typeof raw.enableGitStatus === 'boolean') clean.enableGitStatus = raw.enableGitStatus;
  if (typeof raw.gitIncludeUntracked === 'boolean')
    clean.gitIncludeUntracked = raw.gitIncludeUntracked;
  if (typeof raw.showFileHoverCard === 'boolean') clean.showFileHoverCard = raw.showFileHoverCard;
  if (typeof raw.showFileCheckboxes === 'boolean')
    clean.showFileCheckboxes = raw.showFileCheckboxes;

  if (typeof raw.reduceMotion === 'boolean') clean.reduceMotion = raw.reduceMotion;
  if (typeof raw.highContrast === 'boolean') clean.highContrast = raw.highContrast;
  if (typeof raw.largeText === 'boolean') clean.largeText = raw.largeText;
  if (typeof raw.boldText === 'boolean') clean.boldText = raw.boldText;
  if (typeof raw.visibleFocus === 'boolean') clean.visibleFocus = raw.visibleFocus;
  if (typeof raw.reduceTransparency === 'boolean')
    clean.reduceTransparency = raw.reduceTransparency;
  if (typeof raw.liquidGlassMode === 'boolean') clean.liquidGlassMode = raw.liquidGlassMode;

  const uiDensity = sanitizeEnum(raw.uiDensity, UI_DENSITY_VALUES);
  if (uiDensity) clean.uiDensity = uiDensity;

  const updateChannel = sanitizeEnum(raw.updateChannel, UPDATE_CHANNEL_VALUES);
  if (updateChannel) clean.updateChannel = updateChannel;

  if (typeof raw.themedIcons === 'boolean') clean.themedIcons = raw.themedIcons;
  if (typeof raw.disableHardwareAcceleration === 'boolean')
    clean.disableHardwareAcceleration = raw.disableHardwareAcceleration;
  if (typeof raw.useSystemFontSize === 'boolean') clean.useSystemFontSize = raw.useSystemFontSize;

  if (typeof raw.confirmFileOperations === 'boolean')
    clean.confirmFileOperations = raw.confirmFileOperations;

  const conflictBehavior = sanitizeEnum(raw.fileConflictBehavior, FILE_CONFLICT_VALUES);
  if (conflictBehavior) clean.fileConflictBehavior = conflictBehavior;

  if (typeof raw.skipElevationConfirmation === 'boolean')
    clean.skipElevationConfirmation = raw.skipElevationConfirmation;

  const thumbnailQuality = sanitizeEnum(raw.thumbnailQuality, THUMBNAIL_QUALITY_VALUES);
  if (thumbnailQuality) clean.thumbnailQuality = thumbnailQuality;

  const previewPosition = sanitizeEnum(raw.previewPanelPosition, PREVIEW_PANEL_VALUES);
  if (previewPosition) clean.previewPanelPosition = previewPosition;

  const gridColumns = sanitizeEnum(raw.gridColumns, GRID_COLUMNS_VALUES);
  if (gridColumns) clean.gridColumns = gridColumns;

  const maxThumbnailSize = sanitizeNumber(raw.maxThumbnailSizeMB);
  if (maxThumbnailSize !== null && maxThumbnailSize > 0)
    clean.maxThumbnailSizeMB = maxThumbnailSize;

  const maxPreviewSize = sanitizeNumber(raw.maxPreviewSizeMB);
  if (maxPreviewSize !== null && maxPreviewSize > 0) clean.maxPreviewSizeMB = maxPreviewSize;

  const iconSize = sanitizeNumber(raw.iconSize);
  if (iconSize !== null && iconSize > 0) clean.iconSize = iconSize;

  if (typeof raw.autoPlayVideos === 'boolean') clean.autoPlayVideos = raw.autoPlayVideos;
  if (typeof raw.compactFileInfo === 'boolean') clean.compactFileInfo = raw.compactFileInfo;
  if (typeof raw.showFileExtensions === 'boolean')
    clean.showFileExtensions = raw.showFileExtensions;

  const maxSearchHistoryItems = sanitizeInt(raw.maxSearchHistoryItems, 0, null);
  if (maxSearchHistoryItems !== null) clean.maxSearchHistoryItems = maxSearchHistoryItems;

  const maxDirectoryHistoryItems = sanitizeInt(raw.maxDirectoryHistoryItems, 0, null);
  if (maxDirectoryHistoryItems !== null) clean.maxDirectoryHistoryItems = maxDirectoryHistoryItems;

  const launchCount = sanitizeInt(raw.launchCount, 0, null);
  if (launchCount !== null) clean.launchCount = launchCount;
  if (typeof raw.supportPopupDismissed === 'boolean')
    clean.supportPopupDismissed = raw.supportPopupDismissed;
  if (typeof raw.tourPromptDismissed === 'boolean')
    clean.tourPromptDismissed = raw.tourPromptDismissed;
  if (typeof raw.tourCompleted === 'boolean') clean.tourCompleted = raw.tourCompleted;
  if (typeof raw.skipFullDiskAccessPrompt === 'boolean')
    clean.skipFullDiskAccessPrompt = raw.skipFullDiskAccessPrompt;

  const customTheme = sanitizeCustomTheme(raw.customTheme);
  if (customTheme) clean.customTheme = customTheme;

  if (Array.isArray(raw.bookmarks)) clean.bookmarks = sanitizeStringArray(raw.bookmarks);
  if (Array.isArray(raw.searchHistory))
    clean.searchHistory = sanitizeStringArray(raw.searchHistory);
  if (Array.isArray(raw.directoryHistory))
    clean.directoryHistory = sanitizeStringArray(raw.directoryHistory);
  if (Array.isArray(raw.recentFiles)) clean.recentFiles = sanitizeStringArray(raw.recentFiles);

  clean.shortcuts = sanitizeShortcuts(raw.shortcuts, clean.shortcuts);
  if (raw.folderIcons && isRecord(raw.folderIcons)) {
    clean.folderIcons = sanitizeStringRecord(raw.folderIcons);
  }

  const listColumnWidths = sanitizeListColumnWidths(raw.listColumnWidths);
  if (listColumnWidths) clean.listColumnWidths = listColumnWidths;

  const sidebarWidth = sanitizeNumber(raw.sidebarWidth);
  if (sidebarWidth !== null && sidebarWidth > 0) clean.sidebarWidth = sidebarWidth;

  const previewPanelWidth = sanitizeNumber(raw.previewPanelWidth);
  if (previewPanelWidth !== null && previewPanelWidth > 0)
    clean.previewPanelWidth = previewPanelWidth;

  const tabState = sanitizeTabState(raw.tabState);
  if (tabState) clean.tabState = tabState;

  return clean;
}
