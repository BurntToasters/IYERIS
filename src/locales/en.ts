// English message catalog. Keys are flat, dotted namespaces.
// Pluralization: "singular|plural" chosen by a numeric `count` param.
// Interpolation: {placeholder} tokens filled from params.
export const en = {
  'statusBar.items': '{count} item|{count} items',
  'statusBar.selected': '{count} selected ({size})',
  'statusBar.hidden': '(+{count} hidden)',
  'statusBar.searchResultsAnnounce':
    'Search results: {count} item found|Search results: {count} items found',
  'toast.largeFolder.title': 'Large Folder',
  'toast.largeFolder.message':
    'This folder has more than {count} items. Only the first {count} are shown.',
} as const;

export type MessageKey = keyof typeof en;
