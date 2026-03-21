import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Update } from '@tauri-apps/plugin-updater';
import type { TauriAPI, Settings, HomeSettings } from './types';

type SpecialDirectory = 'desktop' | 'documents' | 'downloads' | 'music' | 'videos';
type FileConflictBehavior = 'ask' | 'rename' | 'skip' | 'overwrite';
type ConflictResolution = 'rename' | 'skip' | 'overwrite' | 'cancel';
type ConflictDecision = Exclude<ConflictResolution, 'cancel'>;

let pendingUpdate: Update | null = null;
let currentUpdateChannel: 'auto' | 'beta' | 'stable' = 'auto';

function updaterTargetBase(): string {
  const os = navigator.userAgent.includes('Windows')
    ? 'windows'
    : navigator.userAgent.includes('Mac')
      ? 'darwin'
      : 'linux';
  return os;
}

function getCheckTarget(channel: 'auto' | 'beta' | 'stable', isBeta: boolean): string | undefined {
  const useBeta = channel === 'beta' || (channel === 'auto' && isBeta);
  if (!useBeta) return undefined;
  return `${updaterTargetBase()}-beta`;
}
const updateDownloadProgressCallbacks = new Set<
  (progress: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  }) => void
>();
const updateDownloadedCallbacks = new Set<(info: { version: string }) => void>();
const updateAvailableCallbacks = new Set<
  (info: { version: string; releaseDate: string; releaseNotes?: string }) => void
>();
const systemResumedCallbacks = new Set<() => void>();
const systemThemeChangedCallbacks = new Set<(data: { isDarkMode: boolean }) => void>();
let systemFallbacksBound = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function wrap(fn: () => Promise<any>): Promise<any> {
  try {
    await fn();
    return { success: true as const };
  } catch (e) {
    return { success: false as const, error: String(e) };
  }
}

function buildFileItem(raw: Record<string, unknown>) {
  return {
    name: raw.name as string,
    path: raw.path as string,
    isDirectory: raw.isDirectory as boolean,
    isFile: !(raw.isDirectory as boolean),
    isSymlink: (raw.isSymlink as boolean) ?? false,
    isBrokenSymlink: (raw.isBrokenSymlink as boolean) ?? false,
    isAppBundle: (raw.isAppBundle as boolean) ?? false,
    isShortcut: (raw.isShortcut as boolean) ?? false,
    isDesktopEntry: (raw.isDesktopEntry as boolean) ?? false,
    symlinkTarget: (raw.symlinkTarget as string) ?? undefined,
    shortcutTarget: (raw.shortcutTarget as string) ?? undefined,
    isHidden: (raw.isHidden as boolean) ?? false,
    size: raw.size as number,
    modified: new Date(raw.modified as number),
    isSystemProtected: false,
  };
}

function bindSystemFallbacks() {
  if (systemFallbacksBound) return;
  systemFallbacksBound = true;

  const emitResumed = () => {
    systemResumedCallbacks.forEach((cb) => cb());
  };

  const emitThemeChanged = () => {
    const isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
    systemThemeChangedCallbacks.forEach((cb) => cb({ isDarkMode }));
  };

  window.addEventListener('focus', emitResumed);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') emitResumed();
  });

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', emitThemeChanged);
}

function decodeFileUri(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith('file://')) return null;
  const withoutScheme = trimmed.replace(/^file:\/\//i, '');
  const normalized =
    withoutScheme.startsWith('/') && /^[A-Za-z]:/.test(withoutScheme.slice(1))
      ? withoutScheme.slice(1)
      : withoutScheme;
  const isWindowsPath = /^[A-Za-z]:/.test(normalized) || normalized.startsWith('\\\\');
  try {
    const decoded = decodeURIComponent(normalized);
    return isWindowsPath ? decoded.replace(/\//g, '\\') : decoded;
  } catch {
    return isWindowsPath ? normalized.replace(/\//g, '\\') : normalized;
  }
}

function extractClipboardPaths(text: string): string[] {
  if (!text) return [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'));
  const parsed = lines
    .map((line) => decodeFileUri(line) ?? (/^[A-Za-z]:\\|^\\\\/.test(line) ? line : null))
    .filter((line): line is string => Boolean(line));
  return Array.from(new Set(parsed));
}

function parseConflictItem(errorMessage: string): string | null {
  const marker = 'CONFLICT:';
  const index = errorMessage.indexOf(marker);
  if (index === -1) return null;
  const item = errorMessage.slice(index + marker.length).trim();
  return item || null;
}

async function promptConflictResolution(
  fileName: string,
  operation: 'copy' | 'move'
): Promise<ConflictResolution> {
  try {
    const { message } = await import('@tauri-apps/plugin-dialog');
    const result = await message(`"${fileName}" already exists in this location.`, {
      title: operation === 'copy' ? 'Copy Conflict' : 'Move Conflict',
      kind: 'warning',
      buttons: {
        yes: 'Replace',
        no: 'Keep Both',
        cancel: 'Skip',
      },
    });
    const normalized = String(result).trim().toLowerCase();
    if (normalized === 'yes' || normalized === 'replace') return 'overwrite';
    if (normalized === 'no' || normalized === 'keep both') return 'rename';
    if (normalized === 'cancel' || normalized === 'skip') return 'skip';
    return 'skip';
  } catch {
    return 'cancel';
  }
}

async function runFileOperationWithConflictResolution(
  command: 'copy_items' | 'move_items',
  operation: 'copy' | 'move',
  sourcePaths: string[],
  destPath: string,
  conflictBehavior?: FileConflictBehavior
) {
  const behavior = conflictBehavior ?? 'ask';
  const conflictResolutions: Record<string, ConflictDecision> = {};

  while (true) {
    try {
      await invoke(command, {
        sourcePaths,
        destPath,
        conflictBehavior: behavior,
        conflictResolutions: behavior === 'ask' ? conflictResolutions : null,
      });
      return { success: true as const };
    } catch (e) {
      const error = String(e);
      if (behavior !== 'ask') {
        return { success: false as const, error };
      }

      const conflictItem = parseConflictItem(error);
      if (!conflictItem) {
        return { success: false as const, error };
      }

      const resolution = await promptConflictResolution(conflictItem, operation);
      if (resolution === 'cancel') {
        return { success: false as const, error: 'Operation cancelled' };
      }

      conflictResolutions[conflictItem] = resolution;
    }
  }
}

const tauriAPI: TauriAPI = {
  getDirectoryContents: async (dirPath, operationId, includeHidden, _streamOnly) => {
    try {
      const items = await invoke<Record<string, unknown>[]>('get_directory_contents', {
        dirPath,
        operationId: operationId ?? null,
        includeHidden: includeHidden ?? null,
        streamOnly: null,
      });
      return { success: true, contents: items.map(buildFileItem) } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  cancelDirectoryContents: (operationId) =>
    wrap(() => invoke('cancel_directory_contents', { operationId })),
  getDrives: async () => {
    try {
      const drives = await invoke<Record<string, unknown>[]>('get_drives');
      return drives.map((d) => d.mountPoint as string);
    } catch {
      return [];
    }
  },
  getDriveInfo: async () => {
    try {
      const drives = await invoke<Record<string, unknown>[]>('get_drive_info');
      return drives.map((d) => ({ path: d.mountPoint as string, label: d.name as string }));
    } catch {
      return [];
    }
  },
  getHomeDirectory: () => invoke('get_home_directory'),
  getSpecialDirectory: async (directory: SpecialDirectory) => {
    try {
      const p = await invoke<string>('get_special_directory', { directory });
      return { success: true, path: p } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  openFile: (filePath) => wrap(() => invoke('open_file', { filePath })),
  selectFolder: async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      if (selected) return { success: true, path: selected as string } as never;
      return { success: false, error: 'No folder selected' } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  minimizeWindow: () => invoke('minimize_window'),
  maximizeWindow: () => invoke('maximize_window'),
  closeWindow: () => invoke('close_window'),
  openNewWindow: () => invoke('open_new_window'),
  setAutostart: (enabled: boolean) => invoke('set_autostart', { enabled }),
  getAutostart: async () => {
    try {
      return await invoke<boolean>('get_autostart');
    } catch {
      return false;
    }
  },
  createFolder: async (parentPath, folderName) => {
    try {
      const p = await invoke<string>('create_folder', { parentPath, folderName });
      return { success: true, path: p } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  createFile: async (parentPath, fileName) => {
    try {
      const p = await invoke<string>('create_file', { parentPath, fileName });
      return { success: true, path: p } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  deleteItem: (itemPath) => wrap(() => invoke('delete_item', { itemPath })),
  trashItem: (itemPath) => wrap(() => invoke('trash_item', { itemPath })),
  openTrash: () => wrap(() => invoke('open_trash')),
  renameItem: async (oldPath, newName) => {
    try {
      const p = await invoke<string>('rename_item', { oldPath, newName });
      return { success: true, path: p } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  getItemProperties: async (itemPath) => {
    try {
      const props = await invoke<Record<string, unknown>>('get_item_properties', { itemPath });
      return {
        success: true,
        properties: {
          path: props.path as string,
          name: props.name as string,
          size: props.size as number,
          isDirectory: props.isDirectory as boolean,
          isFile: !(props.isDirectory as boolean),
          isSymlink: (props.isSymlink as boolean) ?? false,
          isHidden: (props.isHidden as boolean) ?? false,
          created: new Date(props.created as number),
          modified: new Date(props.modified as number),
          accessed: new Date(props.accessed as number),
          mode: props.permissions as number,
          isReadOnly: props.readonly as boolean,
        },
      } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  setPermissions: (itemPath, mode) => wrap(() => invoke('set_permissions', { itemPath, mode })),
  setAttributes: (itemPath, attrs) => wrap(() => invoke('set_attributes', { itemPath, attrs })),
  getSettings: async () => {
    try {
      const json = await invoke<string>('get_settings');
      const settings = json && json !== '{}' ? JSON.parse(json) : {};
      return { success: true, settings } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  saveSettings: (settings: Settings) =>
    wrap(() => invoke('save_settings', { settings: JSON.stringify(settings) })),
  saveSettingsSync: (settings: Settings) => {
    void invoke('save_settings', { settings: JSON.stringify(settings) });
    return { success: true } as never;
  },
  resetSettings: () => wrap(() => invoke('reset_settings')),
  relaunchApp: () => invoke('relaunch_app'),
  getSettingsPath: () => invoke('get_settings_path'),
  getHomeSettings: async () => {
    try {
      const json = await invoke<string>('get_home_settings');
      const settings = json && json !== '{}' ? JSON.parse(json) : {};
      return { success: true, settings } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  saveHomeSettings: (settings: HomeSettings) =>
    wrap(() => invoke('save_home_settings', { settings: JSON.stringify(settings) })),
  resetHomeSettings: () => wrap(() => invoke('reset_home_settings')),
  getHomeSettingsPath: () => invoke('get_home_settings_path'),

  setClipboard: (clipboardData) => invoke('set_clipboard', { clipboardData }),
  getClipboard: () => invoke('get_clipboard'),
  getSystemClipboardData: async () => {
    try {
      const data = await invoke<{ operation?: string; paths?: string[] } | null>(
        'get_system_clipboard_data'
      );
      if (data?.paths?.length) {
        return {
          operation: data.operation === 'cut' ? 'cut' : 'copy',
          paths: data.paths,
        } as never;
      }
    } catch {
      /* fallback below */
    }

    try {
      const text = await navigator.clipboard.readText();
      const paths = extractClipboardPaths(text);
      if (paths.length === 0) return null as never;
      return { operation: 'copy', paths } as never;
    } catch {
      return null as never;
    }
  },
  getSystemClipboardFiles: async () => {
    try {
      const paths = await invoke<string[]>('get_system_clipboard_files');
      if (Array.isArray(paths) && paths.length > 0) return paths;
    } catch {
      /* fallback below */
    }

    try {
      const text = await navigator.clipboard.readText();
      return extractClipboardPaths(text);
    } catch {
      return [];
    }
  },
  onClipboardChanged: (callback) => {
    const unlisten = listen('clipboard-changed', (event) => callback(event.payload as never));
    return () => {
      unlisten.then((fn) => fn());
    };
  },

  setDragData: (paths) => invoke('set_drag_data', { paths }),
  getDragData: async () => {
    try {
      const paths = await invoke<string[]>('get_drag_data');
      return paths.length > 0 ? { paths } : null;
    } catch {
      return null;
    }
  },
  clearDragData: () => invoke('clear_drag_data'),
  getPathForFile: () => '',

  onSettingsChanged: (callback) => {
    const unlisten = listen('settings-changed', (event) => {
      const payload = event.payload as string;
      try {
        callback(JSON.parse(payload));
      } catch {
        callback(payload as never);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  },
  onHomeSettingsChanged: (callback) => {
    const unlisten = listen('home-settings-changed', (event) => {
      const payload = event.payload as string;
      try {
        callback(JSON.parse(payload));
      } catch {
        callback(payload as never);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  },

  copyItems: (sourcePaths, destPath, conflictBehavior) =>
    runFileOperationWithConflictResolution(
      'copy_items',
      'copy',
      sourcePaths,
      destPath,
      conflictBehavior
    ) as never,
  moveItems: (sourcePaths, destPath, conflictBehavior) =>
    runFileOperationWithConflictResolution(
      'move_items',
      'move',
      sourcePaths,
      destPath,
      conflictBehavior
    ) as never,
  showConflictDialog: (fileName, operation) =>
    promptConflictResolution(fileName, operation as 'copy' | 'move') as never,
  searchFiles: async (dirPath, query, filters, operationId) => {
    try {
      const results = await invoke<Record<string, unknown>[]>('search_files', {
        dirPath,
        query,
        filters: filters ? JSON.stringify(filters) : null,
        operationId: operationId ?? null,
      });
      return { success: true, results: results.map(buildFileItem) } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  searchFilesWithContent: async (dirPath, query, filters, operationId) => {
    try {
      const results = await invoke<Record<string, unknown>[]>('search_files_content', {
        dirPath,
        query,
        filters: filters ? JSON.stringify(filters) : null,
        operationId: operationId ?? null,
      });
      return {
        success: true,
        results: results.map((r) => ({
          ...buildFileItem(r),
          matchContext: r.matchContext as string | undefined,
        })),
      } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  searchFilesWithContentGlobal: async (query, filters, operationId) => {
    try {
      const results = await invoke<Record<string, unknown>[]>('search_files_content_global', {
        query,
        filters: filters ? JSON.stringify(filters) : null,
        operationId: operationId ?? null,
      });
      return {
        success: true,
        results: results.map((r) => ({
          ...buildFileItem(r),
          matchContext: r.matchContext as string | undefined,
        })),
      } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  getDiskSpace: async (drivePath) => {
    try {
      const info = await invoke<Record<string, unknown>>('get_disk_space', { drivePath });
      return { success: true, total: info.total as number, free: info.free as number } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  openTerminal: (dirPath) => wrap(() => invoke('open_terminal', { dirPath })),
  restartAsAdmin: () => wrap(() => invoke('restart_as_admin')),
  elevatedCopy: (sourcePath, destPath) =>
    wrap(() => invoke('elevated_copy', { sourcePath, destPath })),
  elevatedMove: (sourcePath, destPath) =>
    wrap(() => invoke('elevated_move', { sourcePath, destPath })),
  elevatedDelete: (itemPath) => wrap(() => invoke('elevated_delete', { itemPath })),
  elevatedRename: (itemPath, newName) =>
    wrap(() => invoke('elevated_rename', { itemPath, newName })),
  resolveShortcut: async (shortcutPath) => {
    try {
      const target = await invoke<string>('resolve_shortcut', { shortcutPath });
      return { success: true, target };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  readFileContent: async (filePath, maxSize) => {
    try {
      const content = await invoke<string>('read_file_content', {
        filePath,
        maxSize: maxSize ?? null,
      });
      return { success: true, content, isTruncated: false } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  getFileDataUrl: async (filePath, maxSize) => {
    try {
      const dataUrl = await invoke<string>('get_file_data_url', {
        filePath,
        maxSize: maxSize ?? null,
      });
      return { success: true, dataUrl } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  getLicenses: async () => {
    try {
      const json = await invoke<string>('get_licenses');
      return { success: true, licenses: JSON.parse(json) } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  getPlatform: () => invoke('get_platform'),
  getAppVersion: () => invoke('get_app_version'),
  getSystemAccentColor: () => invoke('get_system_accent_color'),
  isMas: () => invoke('is_mas'),
  isFlatpak: () => invoke('is_flatpak'),
  isMsStore: () => invoke('is_ms_store'),
  getSystemTextScale: () => invoke('get_system_text_scale'),
  checkFullDiskAccess: async () => {
    try {
      const hasAccess = await invoke<boolean>('check_full_disk_access');
      return { success: true, hasAccess } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  requestFullDiskAccess: () => wrap(() => invoke('request_full_disk_access')),
  checkForUpdates: async () => {
    const [currentVersion, isFlatpak, isMas, isMsStore, isMsi] = await Promise.all([
      invoke<string>('get_app_version'),
      invoke<boolean>('is_flatpak'),
      invoke<boolean>('is_mas'),
      invoke<boolean>('is_ms_store'),
      invoke<boolean>('is_msi'),
    ]);
    const isBeta = /-(beta|alpha|rc)/i.test(currentVersion);

    const storeChecks: Array<{
      active: boolean;
      flag: 'isFlatpak' | 'isMas' | 'isMsStore' | 'isMsi';
      messageKey: 'flatpakMessage' | 'masMessage' | 'msStoreMessage' | 'msiMessage';
      message: string;
    }> = [
      {
        active: isFlatpak,
        flag: 'isFlatpak',
        messageKey: 'flatpakMessage',
        message: 'Updates are managed by Flatpak. Run: flatpak update run.rosie.iyeris',
      },
      {
        active: isMas,
        flag: 'isMas',
        messageKey: 'masMessage',
        message: 'Updates are managed by the Mac App Store.',
      },
      {
        active: isMsStore,
        flag: 'isMsStore',
        messageKey: 'msStoreMessage',
        message: 'Updates are managed by the Microsoft Store.',
      },
      {
        active: isMsi,
        flag: 'isMsi',
        messageKey: 'msiMessage',
        message:
          'This is an enterprise installation. Updates are managed by your IT administrator. To enable auto-updates, uninstall the MSI version and install the regular version from the website.',
      },
    ];

    for (const store of storeChecks) {
      if (!store.active) continue;
      return {
        success: true,
        hasUpdate: false,
        currentVersion,
        latestVersion: currentVersion,
        isBeta,
        [store.flag]: true,
        [store.messageKey]: store.message,
      } as never;
    }

    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const target = getCheckTarget(currentUpdateChannel, isBeta);
      const update = target ? await check({ target }) : await check();
      if (update) {
        pendingUpdate = update;
        updateAvailableCallbacks.forEach((cb) => {
          try {
            cb({
              version: update.version,
              releaseDate: '',
              releaseNotes: typeof update.body === 'string' ? update.body : undefined,
            });
          } catch (err) {
            console.error('[Updater] onUpdateAvailable callback error:', err);
          }
        });
        return {
          success: true,
          hasUpdate: true,
          currentVersion,
          latestVersion: update.version,
          isBeta,
        } as never;
      }
      pendingUpdate = null;
      return {
        success: true,
        hasUpdate: false,
        currentVersion,
        latestVersion: currentVersion,
        isBeta,
      } as never;
    } catch (e) {
      pendingUpdate = null;
      const message = String(e);
      const error = /pubkey|signature|updater/i.test(message)
        ? 'Updater is not configured correctly. Configure the updater public key before checking for updates.'
        : message;
      return {
        success: false,
        error,
      } as never;
    }
  },
  downloadUpdate: async () => {
    try {
      if (!pendingUpdate) return { success: false as const, error: 'No update available' };
      let downloaded = 0;
      let contentLength = 0;
      await pendingUpdate.downloadAndInstall((event) => {
        if (event.event === 'Started' && event.data.contentLength) {
          contentLength = event.data.contentLength;
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          const percent = contentLength > 0 ? (downloaded / contentLength) * 100 : 0;
          const payload = {
            percent,
            transferred: downloaded,
            total: contentLength,
            bytesPerSecond: 0,
          };
          updateDownloadProgressCallbacks.forEach((cb) => {
            try {
              cb(payload);
            } catch (err) {
              console.error('[Updater] onDownloadProgress callback error:', err);
            }
          });
        } else if (event.event === 'Finished') {
          updateDownloadedCallbacks.forEach((cb) => {
            try {
              cb({ version: pendingUpdate?.version ?? '' });
            } catch (err) {
              console.error('[Updater] onUpdateDownloaded callback error:', err);
            }
          });
        }
      });
      return { success: true as const };
    } catch (e) {
      return { success: false as const, error: String(e) };
    }
  },
  installUpdate: async () => {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
      return { success: true as const };
    } catch (e) {
      return { success: false as const, error: String(e) };
    }
  },
  onUpdateDownloadProgress: (callback) => {
    updateDownloadProgressCallbacks.add(callback);
    return () => {
      updateDownloadProgressCallbacks.delete(callback);
    };
  },
  onUpdateAvailable: (callback) => {
    updateAvailableCallbacks.add(
      callback as (info: { version: string; releaseDate: string; releaseNotes?: string }) => void
    );
    return () => {
      updateAvailableCallbacks.delete(
        callback as (info: { version: string; releaseDate: string; releaseNotes?: string }) => void
      );
    };
  },
  onUpdateDownloaded: (callback) => {
    updateDownloadedCallbacks.add(callback);
    return () => {
      updateDownloadedCallbacks.delete(callback);
    };
  },
  undoAction: async () => {
    try {
      const state = await invoke<{ canUndo: boolean; canRedo: boolean }>('undo_action');
      return { success: true, canUndo: state.canUndo, canRedo: state.canRedo } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  redoAction: async () => {
    try {
      const state = await invoke<{ canUndo: boolean; canRedo: boolean }>('redo_action');
      return { success: true, canUndo: state.canUndo, canRedo: state.canRedo } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  getUndoRedoState: async () => {
    try {
      const state = await invoke<{ canUndo: boolean; canRedo: boolean }>('get_undo_redo_state');
      return { success: true, canUndo: state.canUndo, canRedo: state.canRedo } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  searchIndex: async (query, operationId) => {
    try {
      const results = await invoke<Record<string, unknown>[]>('search_index', {
        query,
        operationId: operationId ?? null,
      });
      return {
        success: true,
        results: results.map((r) => ({
          name: r.name as string,
          path: r.path as string,
          isDirectory: r.isDirectory as boolean,
          isFile: !(r.isDirectory as boolean),
          size: r.size as number,
          modified: new Date(r.modified as number),
        })),
      } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  cancelSearch: (operationId) => wrap(() => invoke('cancel_search', { operationId })),
  rebuildIndex: () => wrap(() => invoke('rebuild_index')),
  getIndexStatus: async () => {
    try {
      const status = await invoke<Record<string, unknown>>('get_index_status');
      return {
        success: true,
        status: {
          isIndexing: status.isBuilding as boolean,
          totalFiles: status.entryCount as number,
          indexedFiles: status.entryCount as number,
          lastIndexTime: status.lastBuilt ? new Date(status.lastBuilt as string) : null,
        },
      } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  compressFiles: (sourcePaths, outputPath, format, operationId, advancedOptions) =>
    wrap(() =>
      invoke('compress_files', {
        sourcePaths,
        outputPath,
        format: format ?? null,
        operationId: operationId ?? null,
        advancedOptions: advancedOptions ? JSON.stringify(advancedOptions) : null,
      })
    ),
  extractArchive: (archivePath, destPath, operationId) =>
    wrap(() =>
      invoke('extract_archive', { archivePath, destPath, operationId: operationId ?? null })
    ),
  cancelArchiveOperation: (operationId) =>
    wrap(() => invoke('cancel_archive_operation', { operationId })),
  onCompressProgress: (callback) => {
    const unlisten = listen('compress-progress', (event) => callback(event.payload as never));
    return () => {
      unlisten.then((fn) => fn());
    };
  },
  onExtractProgress: (callback) => {
    const unlisten = listen('extract-progress', (event) => callback(event.payload as never));
    return () => {
      unlisten.then((fn) => fn());
    };
  },
  onFileOperationProgress: (callback) => {
    const unlisten = listen('file-operation-progress', (event) => callback(event.payload as never));
    return () => {
      unlisten.then((fn) => fn());
    };
  },
  onSystemResumed: (callback) => {
    bindSystemFallbacks();
    systemResumedCallbacks.add(callback);
    return () => {
      systemResumedCallbacks.delete(callback);
    };
  },
  onDirectoryChanged: (callback) => {
    const unlisten = listen('directory-changed', (event) => callback(event.payload as never));
    return () => {
      unlisten.then((fn) => fn());
    };
  },
  onSystemThemeChanged: (callback) => {
    bindSystemFallbacks();
    systemThemeChangedCallbacks.add(callback);
    return () => {
      systemThemeChangedCallbacks.delete(callback);
    };
  },
  setZoomLevel: (zoomLevel) => wrap(() => invoke('set_zoom_level', { zoomLevel })),
  getZoomLevel: async () => {
    try {
      const zoomLevel = await invoke<number>('get_zoom_level');
      return { success: true, zoomLevel } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  watchDirectory: async (dirPath) => {
    try {
      await invoke('watch_directory', { dirPath });
      return true;
    } catch {
      return false;
    }
  },
  unwatchDirectory: () => invoke('unwatch_directory'),
  calculateFolderSize: async (folderPath, operationId) => {
    try {
      const result = await invoke<Record<string, number>>('calculate_folder_size', {
        folderPath,
        operationId,
      });
      return {
        success: true,
        result: {
          totalSize: result.totalSize ?? 0,
          fileCount: result.fileCount ?? 0,
          folderCount: result.folderCount ?? 0,
        },
      } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  cancelFolderSizeCalculation: (operationId) =>
    wrap(() => invoke('cancel_folder_size_calculation', { operationId })),
  onFolderSizeProgress: (callback) => {
    const unlisten = listen('folder-size-progress', (event) => {
      const p = event.payload as Record<string, unknown>;
      callback({
        operationId: p.operationId as string,
        calculatedSize: p.size as number,
        fileCount: p.files as number,
        folderCount: 0,
        currentPath: '',
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  },
  onDirectoryContentsProgress: (callback) => {
    const unlisten = listen('directory-contents-progress', (event) =>
      callback(event.payload as never)
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  },
  calculateChecksum: async (filePath, operationId, algorithms) => {
    try {
      const result = await invoke<Record<string, string>>('calculate_checksum', {
        filePath,
        operationId,
        algorithms,
      });
      return { success: true, result: { md5: result.md5, sha256: result.sha256 } } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  cancelChecksumCalculation: (operationId) =>
    wrap(() => invoke('cancel_checksum_calculation', { operationId })),
  onChecksumProgress: (callback) => {
    const unlisten = listen('checksum-progress', (event) => callback(event.payload as never));
    return () => {
      unlisten.then((fn) => fn());
    };
  },
  getGitStatus: async (dirPath, includeUntracked) => {
    try {
      const result = await invoke<Record<string, unknown>>('get_git_status', {
        dirPath,
        includeUntracked: includeUntracked ?? null,
      });
      const statuses: Array<{ path: string; status: string }> = [];
      for (const f of (result.modified as string[]) || [])
        statuses.push({ path: f, status: 'modified' });
      for (const f of (result.added as string[]) || []) statuses.push({ path: f, status: 'added' });
      for (const f of (result.deleted as string[]) || [])
        statuses.push({ path: f, status: 'deleted' });
      for (const f of (result.untracked as string[]) || [])
        statuses.push({ path: f, status: 'untracked' });
      return { success: true, isGitRepo: result.isGitRepo as boolean, statuses } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  getGitBranch: async (dirPath) => {
    try {
      const branch = await invoke<string>('get_git_branch', { dirPath });
      return { success: true, branch } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  listArchiveContents: async (archivePath) => {
    try {
      const entries = await invoke<Record<string, unknown>[]>('list_archive_contents', {
        archivePath,
      });
      return {
        success: true,
        entries: entries.map((e) => ({
          name: e.name as string,
          path: e.path as string,
          size: e.size as number,
          isDirectory: e.isDirectory as boolean,
          compressedSize: e.compressedSize as number,
        })),
      } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },

  getCachedThumbnail: async (filePath) => {
    try {
      const dataUrl = await invoke<string | null>('get_cached_thumbnail', { filePath });
      return dataUrl
        ? ({ success: true, dataUrl } as never)
        : ({ success: false, error: 'Not cached' } as never);
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  saveCachedThumbnail: (filePath, dataUrl) =>
    wrap(() => invoke('save_cached_thumbnail', { filePath, dataUrl })),
  clearThumbnailCache: () => wrap(() => invoke('clear_thumbnail_cache')),
  getThumbnailCacheSize: async () => {
    try {
      const sizeBytes = await invoke<number>('get_thumbnail_cache_size');
      return { success: true, sizeBytes, fileCount: 0 } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },

  getLogsPath: () => invoke('get_logs_path'),
  openLogsFolder: () => wrap(() => invoke('open_logs_folder')),
  exportDiagnostics: async () => {
    try {
      const diag = await invoke<string>('export_diagnostics');
      return { success: true, path: diag } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  getLogFileContent: async () => {
    try {
      const content = await invoke<string>('get_log_file_content');
      return { success: true, content, isTruncated: false } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },

  getOpenWithApps: async (filePath) => {
    try {
      const apps = await invoke<Record<string, unknown>[]>('get_open_with_apps', { filePath });
      return { success: true, apps } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  openFileWithApp: (filePath, appId) =>
    wrap(() => invoke('open_file_with_app', { filePath, appId })),
  batchRename: async (items) => {
    try {
      const results = await invoke<Array<{ success?: boolean; error?: string }>>('batch_rename', {
        items,
      });
      const failures = results.filter((item) => item.success === false);
      if (failures.length > 0) {
        const firstError = failures[0]?.error || 'Batch rename failed';
        return {
          success: false,
          error: `${failures.length} item(s) failed to rename. ${firstError}`,
        } as never;
      }
      return { success: true } as never;
    } catch (e) {
      return { success: false, error: String(e) } as never;
    }
  },
  createSymlink: (targetPath, linkPath) =>
    wrap(() => invoke('create_symlink', { targetPath, linkPath })),
  shareItems: (filePaths) => wrap(() => invoke('share_items', { filePaths })),
  launchDesktopEntry: (filePath) => wrap(() => invoke('launch_desktop_entry', { filePath })),
  setUpdateChannel: (channel) => {
    currentUpdateChannel = channel === 'beta' ? 'beta' : channel === 'stable' ? 'stable' : 'auto';
  },
};

(window as unknown as { tauriAPI: TauriAPI }).tauriAPI = tauriAPI;
