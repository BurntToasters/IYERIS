import type { Settings } from './types';

export const THEME_VALUES = [
  'dark',
  'light',
  'default',
  'custom',
  'nord',
  'catppuccin',
  'dracula',
  'solarized',
  'github',
] as const satisfies readonly Settings['theme'][];

export const SORT_BY_VALUES = [
  'name',
  'date',
  'size',
  'type',
] as const satisfies readonly Settings['sortBy'][];
export const SORT_ORDER_VALUES = [
  'asc',
  'desc',
] as const satisfies readonly Settings['sortOrder'][];
export const VIEW_MODE_VALUES = [
  'grid',
  'list',
  'column',
] as const satisfies readonly Settings['viewMode'][];
export const UPDATE_CHANNEL_VALUES = [
  'auto',
  'beta',
  'stable',
] as const satisfies readonly Settings['updateChannel'][];
export const FILE_CONFLICT_VALUES = [
  'ask',
  'rename',
  'skip',
  'overwrite',
] as const satisfies readonly Settings['fileConflictBehavior'][];
export const PREVIEW_POSITION_VALUES = [
  'right',
  'bottom',
] as const satisfies readonly Settings['previewPanelPosition'][];
export const GRID_COLUMNS_VALUES = [
  'auto',
  '2',
  '3',
  '4',
  '5',
  '6',
] as const satisfies readonly Settings['gridColumns'][];
export const UI_DENSITY_VALUES = [
  'compact',
  'default',
  'larger',
] as const satisfies readonly Settings['uiDensity'][];
export const THUMBNAIL_QUALITY_VALUES = [
  'low',
  'medium',
  'high',
] as const satisfies readonly Settings['thumbnailQuality'][];

export function isOneOf<T extends readonly string[]>(
  value: string,
  options: T
): value is T[number] {
  return (options as readonly string[]).includes(value);
}
