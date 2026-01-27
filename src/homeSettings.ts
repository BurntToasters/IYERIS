import type { HomeSettings } from './types';

export function createDefaultHomeSettings(): HomeSettings {
  return {
    showQuickAccess: true,
    showRecents: true,
    showBookmarks: true,
    showDrives: true,
    showDiskUsage: true,
    hiddenQuickAccessItems: [],
    quickAccessOrder: [
      'home',
      'desktop',
      'documents',
      'downloads',
      'music',
      'videos',
      'browse',
      'trash',
    ],
    sectionOrder: ['quick-access', 'recents', 'bookmarks', 'drives'],
    pinnedRecents: [],
    compactCards: false,
  };
}
