import type { Settings } from './types';
import { isRecord, RESERVED_KEYS, sanitizeStringArray } from './shared.js';
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
    useLegacyTreeSpacing: false,
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

  // Boolean settings — apply if value is boolean
  const BOOLEAN_KEYS: (keyof Settings)[] = [
    'useSystemTheme',
    'showDangerousOptions',
    'showHiddenFiles',
    'enableSearchHistory',
    'enableIndexer',
    'minimizeToTray',
    'startOnLogin',
    'autoCheckUpdates',
    'showRecentFiles',
    'showFolderTree',
    'useLegacyTreeSpacing',
    'enableTabs',
    'globalContentSearch',
    'globalClipboard',
    'enableSyntaxHighlighting',
    'enableGitStatus',
    'gitIncludeUntracked',
    'showFileHoverCard',
    'showFileCheckboxes',
    'reduceMotion',
    'highContrast',
    'largeText',
    'boldText',
    'visibleFocus',
    'reduceTransparency',
    'liquidGlassMode',
    'themedIcons',
    'disableHardwareAcceleration',
    'useSystemFontSize',
    'confirmFileOperations',
    'skipElevationConfirmation',
    'autoPlayVideos',
    'compactFileInfo',
    'showFileExtensions',
    'supportPopupDismissed',
    'tourPromptDismissed',
    'tourCompleted',
    'skipFullDiskAccessPrompt',
  ];
  for (const key of BOOLEAN_KEYS) {
    if (typeof raw[key] === 'boolean')
      (clean as unknown as Record<string, unknown>)[key as string] = raw[key];
  }

  // Enum settings — apply if value is in allowed set
  const ENUM_FIELDS: [keyof Settings, Set<string>][] = [
    ['theme', THEME_VALUES as Set<string>],
    ['sortBy', SORT_BY_VALUES as Set<string>],
    ['sortOrder', SORT_ORDER_VALUES as Set<string>],
    ['viewMode', VIEW_MODE_VALUES as Set<string>],
    ['uiDensity', UI_DENSITY_VALUES as Set<string>],
    ['updateChannel', UPDATE_CHANNEL_VALUES as Set<string>],
    ['fileConflictBehavior', FILE_CONFLICT_VALUES as Set<string>],
    ['thumbnailQuality', THUMBNAIL_QUALITY_VALUES as Set<string>],
    ['previewPanelPosition', PREVIEW_PANEL_VALUES as Set<string>],
    ['gridColumns', GRID_COLUMNS_VALUES as Set<string>],
  ];
  for (const [key, allowed] of ENUM_FIELDS) {
    const val = sanitizeEnum(raw[key], allowed);
    if (val) (clean as unknown as Record<string, unknown>)[key as string] = val;
  }

  // String settings
  if (typeof raw.startupPath === 'string') clean.startupPath = raw.startupPath;

  // Positive number settings
  for (const key of [
    'maxThumbnailSizeMB',
    'maxPreviewSizeMB',
    'iconSize',
    'sidebarWidth',
    'previewPanelWidth',
  ] as const) {
    const val = sanitizeNumber(raw[key]);
    if (val !== null && val > 0) (clean as unknown as Record<string, unknown>)[key as string] = val;
  }

  // Non-negative integer settings
  for (const key of ['maxSearchHistoryItems', 'maxDirectoryHistoryItems', 'launchCount'] as const) {
    const val = sanitizeInt(raw[key], 0, null);
    if (val !== null) (clean as unknown as Record<string, unknown>)[key as string] = val;
  }

  const customTheme = sanitizeCustomTheme(raw.customTheme);
  if (customTheme) clean.customTheme = customTheme;

  // String array settings
  for (const key of ['bookmarks', 'searchHistory', 'directoryHistory', 'recentFiles'] as const) {
    if (Array.isArray(raw[key])) {
      const sanitized = sanitizeStringArray(raw[key]);
      const maxLen = key === 'bookmarks' ? 500 : key === 'recentFiles' ? 200 : 100;
      clean[key] = sanitized.slice(0, maxLen);
    }
  }

  clean.shortcuts = sanitizeShortcuts(raw.shortcuts, clean.shortcuts);
  if (raw.folderIcons && isRecord(raw.folderIcons))
    clean.folderIcons = sanitizeStringRecord(raw.folderIcons);

  const listColumnWidths = sanitizeListColumnWidths(raw.listColumnWidths);
  if (listColumnWidths) clean.listColumnWidths = listColumnWidths;

  const tabState = sanitizeTabState(raw.tabState);
  if (tabState) clean.tabState = tabState;

  return clean;
}
