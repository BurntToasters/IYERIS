import type { HomeSettings } from './types';
import { isRecord, RESERVED_KEYS, sanitizeStringArray } from './shared';

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

export function sanitizeHomeSettings(
  raw: unknown,
  defaults: HomeSettings = createDefaultHomeSettings()
): HomeSettings {
  const clean: HomeSettings = {
    ...defaults,
    hiddenQuickAccessItems: [...defaults.hiddenQuickAccessItems],
    quickAccessOrder: [...defaults.quickAccessOrder],
    sectionOrder: [...defaults.sectionOrder],
    pinnedRecents: [...defaults.pinnedRecents],
    sidebarQuickAccessOrder: [...defaults.sidebarQuickAccessOrder],
    hiddenSidebarQuickAccessItems: [...defaults.hiddenSidebarQuickAccessItems],
  };

  if (!isRecord(raw)) return clean;

  if (typeof raw.showQuickAccess === 'boolean') clean.showQuickAccess = raw.showQuickAccess;
  if (typeof raw.showRecents === 'boolean') clean.showRecents = raw.showRecents;
  if (typeof raw.showBookmarks === 'boolean') clean.showBookmarks = raw.showBookmarks;
  if (typeof raw.showDrives === 'boolean') clean.showDrives = raw.showDrives;
  if (typeof raw.showDiskUsage === 'boolean') clean.showDiskUsage = raw.showDiskUsage;
  if (typeof raw.compactCards === 'boolean') clean.compactCards = raw.compactCards;

  if (Array.isArray(raw.hiddenQuickAccessItems)) {
    clean.hiddenQuickAccessItems = sanitizeStringArray(raw.hiddenQuickAccessItems);
  }
  if (Array.isArray(raw.quickAccessOrder)) {
    clean.quickAccessOrder = sanitizeStringArray(raw.quickAccessOrder);
  }
  if (Array.isArray(raw.sectionOrder)) {
    clean.sectionOrder = sanitizeStringArray(raw.sectionOrder);
  }
  if (Array.isArray(raw.pinnedRecents)) {
    clean.pinnedRecents = sanitizeStringArray(raw.pinnedRecents);
  }
  if (Array.isArray(raw.sidebarQuickAccessOrder)) {
    clean.sidebarQuickAccessOrder = sanitizeStringArray(raw.sidebarQuickAccessOrder);
  }
  if (Array.isArray(raw.hiddenSidebarQuickAccessItems)) {
    clean.hiddenSidebarQuickAccessItems = sanitizeStringArray(raw.hiddenSidebarQuickAccessItems);
  }

  for (const key of Object.keys(clean)) {
    if (RESERVED_KEYS.has(key)) {
      delete (clean as unknown as Record<string, unknown>)[key];
    }
  }

  return clean;
}
