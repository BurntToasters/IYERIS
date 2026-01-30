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
      'userhome',
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
    sidebarQuickAccessOrder: [
      'home',
      'userhome',
      'browse',
      'desktop',
      'documents',
      'downloads',
      'music',
      'videos',
      'trash',
    ],
    hiddenSidebarQuickAccessItems: [],
  };
}
