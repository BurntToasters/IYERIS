import type { Settings } from './types';
import {
  THEME_VALUES,
  SORT_BY_VALUES,
  SORT_ORDER_VALUES,
  FILE_CONFLICT_VALUES,
  PREVIEW_POSITION_VALUES,
  GRID_COLUMNS_VALUES,
  UPDATE_CHANNEL_VALUES,
  THUMBNAIL_QUALITY_VALUES,
} from './constants.js';

export const TOGGLE_MAPPINGS: ReadonlyArray<readonly [string, keyof Settings]> = [
  ['system-theme-toggle', 'useSystemTheme'],
  ['show-hidden-files-toggle', 'showHiddenFiles'],
  ['enable-git-status-toggle', 'enableGitStatus'],
  ['git-include-untracked-toggle', 'gitIncludeUntracked'],
  ['show-file-hover-card-toggle', 'showFileHoverCard'],
  ['show-file-checkboxes-toggle', 'showFileCheckboxes'],
  ['minimize-to-tray-toggle', 'minimizeToTray'],
  ['start-on-login-toggle', 'startOnLogin'],
  ['auto-check-updates-toggle', 'autoCheckUpdates'],
  ['enable-search-history-toggle', 'enableSearchHistory'],
  ['enable-indexer-toggle', 'enableIndexer'],
  ['show-recent-files-toggle', 'showRecentFiles'],
  ['show-folder-tree-toggle', 'showFolderTree'],
  ['legacy-tree-spacing-toggle', 'useLegacyTreeSpacing'],
  ['enable-tabs-toggle', 'enableTabs'],
  ['global-content-search-toggle', 'globalContentSearch'],
  ['global-clipboard-toggle', 'globalClipboard'],
  ['enable-syntax-highlighting-toggle', 'enableSyntaxHighlighting'],
  ['reduce-motion-toggle', 'reduceMotion'],
  ['high-contrast-toggle', 'highContrast'],
  ['large-text-toggle', 'largeText'],
  ['use-system-font-size-toggle', 'useSystemFontSize'],
  ['bold-text-toggle', 'boldText'],
  ['visible-focus-toggle', 'visibleFocus'],
  ['reduce-transparency-toggle', 'reduceTransparency'],
  ['liquid-glass-toggle', 'liquidGlassMode'],
  ['themed-icons-toggle', 'themedIcons'],
  ['disable-hw-accel-toggle', 'disableHardwareAcceleration'],
  ['confirm-file-operations-toggle', 'confirmFileOperations'],
  ['auto-play-videos-toggle', 'autoPlayVideos'],
  ['compact-file-info-toggle', 'compactFileInfo'],
  ['show-file-extensions-toggle', 'showFileExtensions'],
] as const;

export const SELECT_MAPPINGS: ReadonlyArray<readonly [string, keyof Settings, readonly string[]]> =
  [
    ['theme-select', 'theme', THEME_VALUES],
    ['sort-by-select', 'sortBy', SORT_BY_VALUES],
    ['sort-order-select', 'sortOrder', SORT_ORDER_VALUES],
    ['update-channel-select', 'updateChannel', UPDATE_CHANNEL_VALUES],
    ['ui-density-select', 'uiDensity', ['default', 'compact', 'larger']],
    ['file-conflict-behavior-select', 'fileConflictBehavior', FILE_CONFLICT_VALUES],
    ['thumbnail-quality-select', 'thumbnailQuality', THUMBNAIL_QUALITY_VALUES],
    ['preview-panel-position-select', 'previewPanelPosition', PREVIEW_POSITION_VALUES],
    ['grid-columns-select', 'gridColumns', GRID_COLUMNS_VALUES],
  ] as const;

export const INT_RANGE_MAPPINGS: ReadonlyArray<readonly [string, keyof Settings, number, number]> =
  [
    ['max-thumbnail-size-input', 'maxThumbnailSizeMB', 1, 100],
    ['max-preview-size-input', 'maxPreviewSizeMB', 1, 500],
    ['max-search-history-input', 'maxSearchHistoryItems', 1, 20],
    ['max-directory-history-input', 'maxDirectoryHistoryItems', 1, 20],
  ] as const;
