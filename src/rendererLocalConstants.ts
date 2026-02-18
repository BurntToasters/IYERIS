import type { SpecialDirectory } from './types';

export type ViewMode = 'grid' | 'list' | 'column';

export const SEARCH_DEBOUNCE_MS = 300;
export const SETTINGS_SAVE_DEBOUNCE_MS = 1000;
export const TOAST_DURATION_MS = 3000;
export const SEARCH_HISTORY_MAX = 5;
export const DIRECTORY_HISTORY_MAX = 5;
export const DIRECTORY_PROGRESS_THROTTLE_MS = 100;
export const SUPPORT_POPUP_DELAY_MS = 1500;
export const MAX_RECENT_FILES = 10;
export const MAX_CACHED_TABS = 5;
export const MAX_CACHED_FILES_PER_TAB = 10000;

export const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

export const SPECIAL_DIRECTORY_ACTIONS: Record<string, { key: SpecialDirectory; label: string }> = {
  desktop: { key: 'desktop', label: 'Desktop' },
  documents: { key: 'documents', label: 'Documents' },
  downloads: { key: 'downloads', label: 'Downloads' },
  music: { key: 'music', label: 'Music' },
  videos: { key: 'videos', label: 'Videos' },
};

export function consumeEvent(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}
