// English message catalog. Keys are flat, dotted namespaces.
// Pluralization: "singular|plural" chosen by a numeric `count` param.
// Interpolation: {placeholder} tokens filled from params.
export const en = {
  'common.error': 'Error',
  'common.info': 'Info',
  'common.operationFailed': 'Operation failed',
  'common.retry': 'Retry',
  'common.success': 'Success',
  'dualPane.empty': 'No items',
  'dualPane.title': 'Dual Pane',
  'dragDrop.title': 'Drag and Drop',
  'dragDrop.elevatedFailed': 'Elevated {operation} failed',
  'dragDrop.failed': 'Failed to {operation} items',
  'dragDrop.operationCancelled': 'Operation cancelled',
  'fileType.file': 'File',
  'fileType.folder': 'Folder',
  'sidebar.openHomeFailed': 'Failed to open Home Folder',
  'sidebar.openSpecialFailed': 'Failed to open {label} folder',
  'sidebar.openTrashFailed': 'Failed to open trash folder',
  'sidebar.openingTrash': 'Opening system trash folder',
  'sidebar.quickAccess': 'Quick Access',
  'toast.settingsSaveFailed': 'Failed to save settings: {error}',
  'statusBar.items': '{count} item|{count} items',
  'statusBar.selected': '{count} selected ({size})',
  'statusBar.hidden': '(+{count} hidden)',
  'statusBar.searchResultsAnnounce':
    'Search results: {count} item found|Search results: {count} items found',
  'toast.largeFolder.title': 'Large Folder',
  'toast.largeFolder.message':
    'This folder has more than {count} items. Only the first {count} are shown.',
  'toast.alreadyInDirectory': 'Items are already in this directory',
  'toast.sourceFilesGone': 'Source files no longer exist',
  'toast.dualPane.loadFailed': 'Failed to load secondary pane',
  'clipboard.copied': '{count} item copied|{count} items copied',
  'clipboard.cut': '{count} item cut|{count} items cut',
  'clipboard.moved': '{count} item moved|{count} items moved',
  'clipboard.copiedElevated': '{count} item copied (elevated)|{count} items copied (elevated)',
  'clipboard.movedElevated': '{count} item moved (elevated)|{count} items moved (elevated)',
  'clipboard.copiedIntoFolder': '{count} item copied into folder|{count} items copied into folder',
  'clipboard.movedIntoFolder': '{count} item moved into folder|{count} items moved into folder',
  'clipboard.copiedIntoFolderElevated':
    '{count} item copied into folder (elevated)|{count} items copied into folder (elevated)',
  'clipboard.movedIntoFolderElevated':
    '{count} item moved into folder (elevated)|{count} items moved into folder (elevated)',
  'clipboard.pastedFromSystem':
    '{count} item pasted from system clipboard|{count} items pasted from system clipboard',
  'clipboard.movedFromSystem':
    '{count} item moved from system clipboard|{count} items moved from system clipboard',
  'clipboard.pastedElevated': '{count} item pasted (elevated)|{count} items pasted (elevated)',
  'clipboard.duplicated': '{count} item duplicated|{count} items duplicated',
  'clipboard.duplicatedElevated':
    '{count} item duplicated (elevated)|{count} items duplicated (elevated)',
  'clipboard.filesSkipped':
    '{count} file no longer exists and was skipped|{count} files no longer exist and were skipped',
  'clipboard.elevatedConfirm':
    'This operation requires administrator privileges. You will be prompted to authorize.',
} as const;

export type MessageKey = keyof typeof en;
