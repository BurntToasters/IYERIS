import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Update } from '@tauri-apps/plugin-updater';
import type { ElectronAPI, Settings, HomeSettings } from './types';

type SpecialDirectory = 'desktop' | 'documents' | 'downloads' | 'music' | 'videos';

let pendingUpdate: Update | null = null;
const updateDownloadProgressCallbacks = new Set<
  (progress: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  }) => void
>();
const updateDownloadedCallbacks = new Set<(info: { version: string }) => void>();

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

const electronAPI: ElectronAPI = {
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
  cancelDirectoryContents: (_operationId) => Promise.resolve({ success: true } as never),
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
  setAttributes: () => Promise.resolve({ success: true } as never),
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
  saveSettingsSync: () => ({ success: true }) as never,
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
  getSystemClipboardData: () => Promise.resolve(null as never),
  getSystemClipboardFiles: () => Promise.resolve([]),
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
    wrap(() =>
      invoke('copy_items', { sourcePaths, destPath, conflictBehavior: conflictBehavior ?? null })
    ),
  moveItems: (sourcePaths, destPath, conflictBehavior) =>
    wrap(() =>
      invoke('move_items', { sourcePaths, destPath, conflictBehavior: conflictBehavior ?? null })
    ),
  showConflictDialog: () => Promise.resolve('rename' as never),
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
      const home = await invoke<string>('get_home_directory');
      const results = await invoke<Record<string, unknown>[]>('search_files_content', {
        dirPath: home,
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
    const currentVersion = await invoke<string>('get_app_version');
    const isFlatpak = await invoke<boolean>('is_flatpak');
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (update) {
        pendingUpdate = update;
        return {
          success: true,
          hasUpdate: true,
          currentVersion,
          latestVersion: update.version,
          isFlatpak,
        } as never;
      }
      return {
        success: true,
        hasUpdate: false,
        currentVersion,
        latestVersion: currentVersion,
        isFlatpak,
      } as never;
    } catch {
      return {
        success: true,
        hasUpdate: false,
        currentVersion,
        latestVersion: currentVersion,
        isFlatpak,
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
          updateDownloadProgressCallbacks.forEach((cb) => cb(payload));
        } else if (event.event === 'Finished') {
          updateDownloadedCallbacks.forEach((cb) => cb({ version: pendingUpdate?.version ?? '' }));
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
    const unlisten = listen('update-available', (event) => callback(event.payload as never));
    return () => {
      unlisten.then((fn) => fn());
    };
  },
  onUpdateDownloaded: (callback) => {
    updateDownloadedCallbacks.add(callback);
    return () => {
      updateDownloadedCallbacks.delete(callback);
    };
  },
  undoAction: () => Promise.resolve({ success: true, canUndo: false, canRedo: false } as never),
  redoAction: () => Promise.resolve({ success: true, canUndo: false, canRedo: false } as never),
  getUndoRedoState: () =>
    Promise.resolve({ success: true, canUndo: false, canRedo: false } as never),
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
    const unlisten = listen('system-resumed', () => callback());
    return () => {
      unlisten.then((fn) => fn());
    };
  },
  onDirectoryChanged: (callback) => {
    const unlisten = listen('directory-changed', (event) => callback(event.payload as never));
    return () => {
      unlisten.then((fn) => fn());
    };
  },
  onSystemThemeChanged: (callback) => {
    const unlisten = listen('system-theme-changed', (event) => callback(event.payload as never));
    return () => {
      unlisten.then((fn) => fn());
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
  batchRename: (items) => wrap(() => invoke('batch_rename', { items })),
  createSymlink: (targetPath, linkPath) =>
    wrap(() => invoke('create_symlink', { targetPath, linkPath })),
  shareItems: (filePaths) => wrap(() => invoke('share_items', { filePaths })),
  launchDesktopEntry: () => Promise.resolve({ success: true } as never),
};

(window as unknown as { electronAPI: ElectronAPI }).electronAPI = electronAPI;
