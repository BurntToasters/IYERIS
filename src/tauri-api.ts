import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { DragDropEvent } from '@tauri-apps/api/webview';
import type { Update } from '@tauri-apps/plugin-updater';
import type {
  TauriAPI,
  Settings,
  HomeSettings,
  HomeSettingsSaveResponse,
  LicensesData,
  NativeDragDropEvent,
  SettingsSaveResponse,
  GitFileStatus,
} from './types';
import { devLog, ignoreError } from './shared.js';
import { sanitizeSettings } from './settings.js';
import { sanitizeHomeSettings } from './homeSettings.js';
import {
  RawFileItemSchema,
  RawDriveInfoSchema,
  RawItemPropertiesSchema,
  RawSearchResultSchema,
  RawArchiveEntrySchema,
  RawFolderSizeSchema,
  RawDuplicateGroupSchema,
  RawGitStatusSchema,
  RawSettingsSchema,
  RawSettingsSaveSchema,
  RawDiagnosticsExportSchema,
  RawUndoStateSchema,
  RawIndexStatusSchema,
  RawHomeSettingsSchema,
  RawHomeSettingsSaveSchema,
  RawClipboardOperationSchema,
  RawArchiveProgressSchema,
  RawFileOperationProgressSchema,
  RawDirectoryChangedSchema,
  RawWatchedDirectoryRemovedSchema,
  RawDirectoryContentsProgressSchema,
  RawDirectoryTruncatedSchema,
  RawFolderSizeProgressSchema,
  RawChecksumProgressSchema,
  RawOpenWithAppSchema,
  validateIpc,
} from './rendererSchemas.js';

type SpecialDirectory = 'desktop' | 'documents' | 'downloads' | 'music' | 'videos';
type FileConflictBehavior = 'ask' | 'rename' | 'skip' | 'overwrite';
type ConflictResolution = 'rename' | 'skip' | 'overwrite' | 'cancel';
type ConflictDecision = Exclude<ConflictResolution, 'cancel'>;

let pendingUpdate: Update | null = null;
let updateDownloadInProgress = false;
let updateReadyToInstall = false;
let updateGeneration = 0;

function closeUpdate(update: Update | null): void {
  if (!update) return;
  try {
    void update.close().catch(ignoreError);
  } catch (error) {
    ignoreError(error);
  }
}

function replacePendingUpdate(update: Update | null): void {
  const previous = pendingUpdate;
  pendingUpdate = update;
  if (previous !== update) closeUpdate(previous);
}

let currentUpdateChannel: 'auto' | 'beta' | 'stable' = 'auto';
let cachedPlatformOS: string | null = null;
let lastWatchedDirectoryPath = '';
let settingsBaselineRaw: Record<string, unknown> | null = null;
let settingsBaselineView: Settings | null = null;
let latestSettingsCanonical: Record<string, unknown> | null = null;
let homeSettingsBaselineRaw: Record<string, unknown> | null = null;
let homeSettingsBaselineView: HomeSettings | null = null;
let latestHomeSettingsCanonical: Record<string, unknown> | null = null;
const IPC_SLOW_WARNING_MS = 1200;

function settingsRevision(settings: object): number {
  const revision = Object.getOwnPropertyDescriptor(settings, '_revision')?.value;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
    ? revision
    : 0;
}

function homeSettingsRevision(settings: object): number {
  const revision = Object.getOwnPropertyDescriptor(settings, '_revision')?.value;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
    ? revision
    : 0;
}

function getSettingsField(settings: Settings, key: string): unknown {
  return Object.getOwnPropertyDescriptor(settings, key)?.value;
}

function setSettingsField(settings: Settings, key: string, value: unknown): void {
  Object.defineProperty(settings, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function removeSettingsField(settings: Settings, key: string): void {
  Reflect.deleteProperty(settings, key);
}

function latestCanonicalForSave(settings: Record<string, unknown>): Record<string, unknown> {
  return latestSettingsCanonical &&
    settingsRevision(latestSettingsCanonical) > settingsRevision(settings)
    ? latestSettingsCanonical
    : settings;
}

function settingsValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => settingsValueEqual(item, right[index]))
    );
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && settingsValueEqual(leftRecord[key], rightRecord[key])
    )
  );
}

function parseSettingsPayload(raw: unknown, label: string): Record<string, unknown> | null {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      devLog('IPC', `invalid JSON in ${label}`);
      return null;
    }
  }
  return validateIpc(RawSettingsSchema, parsed, label);
}

function storeSettingsBaseline(settings: Record<string, unknown>): void {
  if (settingsBaselineRaw && settingsRevision(settings) < settingsRevision(settingsBaselineRaw))
    return;
  settingsBaselineRaw = { ...settings };
  settingsBaselineView = sanitizeSettings(settings);
  latestSettingsCanonical = { ...settings };
}

function advanceSettingsBaseline(
  remote: Record<string, unknown>,
  preserveKeys: Iterable<string>
): void {
  if (settingsBaselineRaw && settingsRevision(remote) < settingsRevision(settingsBaselineRaw))
    return;
  const nextRaw = { ...remote };
  const nextView = sanitizeSettings(remote);
  if (settingsBaselineRaw && settingsBaselineView) {
    for (const key of preserveKeys) {
      if (Object.prototype.hasOwnProperty.call(settingsBaselineRaw, key)) {
        nextRaw[key] = settingsBaselineRaw[key];
      } else {
        delete nextRaw[key];
      }
      if (Object.prototype.hasOwnProperty.call(settingsBaselineView, key)) {
        setSettingsField(nextView, key, getSettingsField(settingsBaselineView, key));
      } else {
        removeSettingsField(nextView, key);
      }
    }
  }
  settingsBaselineRaw = nextRaw;
  settingsBaselineView = nextView;
  latestSettingsCanonical = { ...remote };
}

function storeHomeSettingsBaseline(settings: Record<string, unknown>): void {
  if (
    homeSettingsBaselineRaw &&
    homeSettingsRevision(settings) < homeSettingsRevision(homeSettingsBaselineRaw)
  ) {
    return;
  }
  homeSettingsBaselineRaw = { ...settings };
  homeSettingsBaselineView = sanitizeHomeSettings(settings);
  latestHomeSettingsCanonical = { ...settings };
}

function advanceHomeSettingsBaseline(
  remote: Record<string, unknown>,
  preserveKeys: Iterable<string>
): void {
  if (
    homeSettingsBaselineRaw &&
    homeSettingsRevision(remote) < homeSettingsRevision(homeSettingsBaselineRaw)
  ) {
    return;
  }
  const nextRaw = { ...remote };
  const nextView = sanitizeHomeSettings(remote);
  if (homeSettingsBaselineRaw && homeSettingsBaselineView) {
    for (const key of preserveKeys) {
      if (Object.prototype.hasOwnProperty.call(homeSettingsBaselineRaw, key)) {
        nextRaw[key] = homeSettingsBaselineRaw[key];
      } else {
        delete nextRaw[key];
      }
      if (Object.prototype.hasOwnProperty.call(homeSettingsBaselineView, key)) {
        Object.defineProperty(nextView, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: Object.getOwnPropertyDescriptor(homeSettingsBaselineView, key)?.value,
        });
      } else {
        Reflect.deleteProperty(nextView, key);
      }
    }
  }
  homeSettingsBaselineRaw = nextRaw;
  homeSettingsBaselineView = nextView;
  latestHomeSettingsCanonical = { ...remote };
}

function latestCanonicalHomeSettingsForSave(
  settings: Record<string, unknown>
): Record<string, unknown> {
  return latestHomeSettingsCanonical &&
    homeSettingsRevision(latestHomeSettingsCanonical) > homeSettingsRevision(settings)
    ? latestHomeSettingsCanonical
    : settings;
}

const SETTINGS_PATCH_RESERVED_KEYS = new Set(['_revision', '_timestamp']);
const HOME_SETTINGS_PATCH_RESERVED_KEYS = new Set(['_revision']);

// Undefined values disappear from JSON.stringify, so a removed optional key
// would never reach the backend. Build the patch from the union of the new
// settings and the baseline view, and encode removals as explicit nulls with
// the baseline value for conflict detection.
function buildSettingsPatch(
  settings: object,
  baselineRaw: Record<string, unknown>,
  baselineView: object,
  reservedKeys: ReadonlySet<string>
): { patch: Record<string, unknown>; baseValues: Record<string, unknown> } {
  const settingsRecord = settings as Record<string, unknown>;
  const baselineRecord = baselineView as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  const baseValues: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(settingsRecord), ...Object.keys(baselineRecord)]);
  for (const key of keys) {
    if (reservedKeys.has(key)) continue;
    const hasNewValue = Object.prototype.hasOwnProperty.call(settingsRecord, key);
    const newValue = settingsRecord[key];
    const baselineValue = baselineRecord[key];
    if (!hasNewValue || newValue === undefined) {
      if (baselineValue === undefined) continue;
      patch[key] = null;
    } else {
      if (settingsValueEqual(newValue, baselineValue)) continue;
      patch[key] = newValue;
    }
    if (Object.prototype.hasOwnProperty.call(baselineRaw, key)) {
      baseValues[key] = baselineRaw[key];
    }
  }
  return { patch, baseValues };
}

async function saveHomeSettingsThroughBridge(
  settings: HomeSettings
): Promise<HomeSettingsSaveResponse> {
  const serializedSettings = JSON.stringify(settings);
  if (!homeSettingsBaselineRaw || !homeSettingsBaselineView) {
    try {
      const json = await invoke<string>('get_home_settings');
      let parsed: unknown;
      try {
        parsed = JSON.parse(json || '{}') as unknown;
      } catch {
        return { success: false, error: 'Could not parse current home settings before saving' };
      }
      const canonical = validateIpc(RawHomeSettingsSchema, parsed, 'HomeSettingsBeforeSave');
      if (!canonical) {
        return { success: false, error: 'Could not load current home settings before saving' };
      }
      storeHomeSettingsBaseline(canonical);
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
  const baselineRaw = homeSettingsBaselineRaw;
  const baselineView = homeSettingsBaselineView;
  if (!baselineRaw || !baselineView) {
    return { success: false, error: 'Could not establish current home settings before saving' };
  }

  const { patch, baseValues } = buildSettingsPatch(
    settings,
    baselineRaw,
    baselineView,
    HOME_SETTINGS_PATCH_RESERVED_KEYS
  );

  try {
    const raw = await invoke<unknown>('save_home_settings', {
      settings: serializedSettings,
      expectedRevision: homeSettingsRevision(baselineRaw),
      patch: JSON.stringify(patch),
      baseValues: JSON.stringify(baseValues),
    });
    const result = validateIpc(RawHomeSettingsSaveSchema, raw, 'HomeSettingsSave');
    if (!result) return { success: false, error: 'Invalid home settings response from backend' };
    if (result.status === 'conflict') {
      advanceHomeSettingsBaseline(result.settings, Object.keys(patch));
      return {
        success: false,
        error: 'Home settings changed in another window. Review the latest settings and try again.',
        settings: sanitizeHomeSettings(latestCanonicalHomeSettingsForSave(result.settings)),
        conflictKeys: result.conflictKeys ?? Object.keys(patch),
        changedKeys: result.changedKeys ?? Object.keys(patch),
      };
    }
    storeHomeSettingsBaseline(result.settings);
    return {
      success: true,
      settings: sanitizeHomeSettings(latestCanonicalHomeSettingsForSave(result.settings)),
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function saveSettingsThroughBridge(
  settings: Settings,
  replace = false
): Promise<SettingsSaveResponse> {
  const serializedSettings = JSON.stringify(settings);
  if (!settingsBaselineRaw || !settingsBaselineView) {
    try {
      const json = await invoke<string>('get_settings');
      const canonical = parseSettingsPayload(json || '{}', 'SettingsBeforeSave');
      if (!canonical)
        return { success: false, error: 'Could not load current settings before saving' };
      storeSettingsBaseline(canonical);
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
  const baselineRaw = settingsBaselineRaw;
  const baselineView = settingsBaselineView;
  if (!baselineRaw || !baselineView) {
    return { success: false, error: 'Could not establish current settings before saving' };
  }

  const expectedRevision = settingsRevision(baselineRaw);
  if (replace) {
    try {
      const raw = await invoke<unknown>('save_settings', {
        settings: serializedSettings,
        expectedRevision,
        replace: true,
      });
      const result = validateIpc(RawSettingsSaveSchema, raw, 'SettingsSave');
      if (!result) return { success: false, error: 'Invalid settings response from backend' };
      if (result.status === 'conflict') {
        advanceSettingsBaseline(result.settings, []);
        return {
          success: false,
          error: 'Settings changed in another window. Review the latest settings and try again.',
          settings: sanitizeSettings(latestCanonicalForSave(result.settings)),
          conflictKeys: result.conflictKeys ?? ['settings'],
          changedKeys: result.changedKeys ?? ['settings'],
        };
      }
      storeSettingsBaseline(result.settings);
      return {
        success: true,
        settings: sanitizeSettings(latestCanonicalForSave(result.settings)),
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  const { patch, baseValues } = buildSettingsPatch(
    settings,
    baselineRaw,
    baselineView,
    SETTINGS_PATCH_RESERVED_KEYS
  );

  try {
    const raw = await invoke<unknown>('save_settings', {
      settings: serializedSettings,
      expectedRevision,
      patch: JSON.stringify(patch),
      baseValues: JSON.stringify(baseValues),
    });
    const parsed = validateIpc(RawSettingsSaveSchema, raw, 'SettingsSave');
    if (!parsed) return { success: false, error: 'Invalid settings response from backend' };
    if (parsed.status === 'conflict') {
      advanceSettingsBaseline(parsed.settings, Object.keys(patch));
      return {
        success: false,
        error: 'Settings changed in another window. Review the latest settings and try again.',
        settings: sanitizeSettings(latestCanonicalForSave(parsed.settings)),
        conflictKeys: parsed.conflictKeys ?? Object.keys(patch),
        changedKeys: parsed.changedKeys ?? Object.keys(patch),
      };
    }
    storeSettingsBaseline(parsed.settings);
    return {
      success: true,
      settings: sanitizeSettings(latestCanonicalForSave(parsed.settings)),
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, nowMs() - startedAt);
}

function isRuntimeDevLoggingEnabled(): boolean {
  if (typeof globalThis === 'undefined') return false;
  const value = (globalThis as Record<string, unknown>).__iyerisLogger;
  return typeof value === 'object' && value !== null;
}

function logIpcTiming(command: string, durationMs: number, details: Record<string, unknown>): void {
  devLog('IPC', `${command} completed in ${durationMs.toFixed(1)}ms`, details);
  if (isRuntimeDevLoggingEnabled() && durationMs >= IPC_SLOW_WARNING_MS) {
    console.warn(`[IPC] Slow ${command}: ${durationMs.toFixed(1)}ms`, details);
  }
}

async function getUpdaterTargetBase(): Promise<string> {
  if (!cachedPlatformOS) {
    cachedPlatformOS = await invoke<string>('get_platform');
  }
  const mapped = cachedPlatformOS === 'win32' ? 'windows' : cachedPlatformOS;
  return mapped;
}

async function getCheckTarget(
  channel: 'auto' | 'beta' | 'stable',
  installedIsBeta: boolean
): Promise<string | undefined> {
  if (!isCheckingBetaChannel(channel, installedIsBeta)) return undefined;
  const base = await getUpdaterTargetBase();
  return `${base}-beta`;
}

function isCheckingBetaChannel(
  channel: 'auto' | 'beta' | 'stable',
  installedIsBeta: boolean
): boolean {
  return channel === 'beta' || (channel === 'auto' && installedIsBeta);
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

async function wrap(
  fn: () => Promise<unknown>
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    await fn();
    return { success: true as const };
  } catch (e) {
    return { success: false as const, error: String(e) };
  }
}

function buildFileItem(raw: unknown) {
  const v = validateIpc(RawFileItemSchema, raw, 'FileItem');
  if (!v) return null;
  return {
    name: v.name,
    path: v.path,
    isDirectory: v.isDirectory,
    isFile: !v.isDirectory,
    isSymlink: v.isSymlink ?? false,
    isBrokenSymlink: v.isBrokenSymlink ?? false,
    isAppBundle: v.isAppBundle ?? false,
    isShortcut: v.isShortcut ?? false,
    isDesktopEntry: v.isDesktopEntry ?? false,
    symlinkTarget: v.symlinkTarget ?? undefined,
    shortcutTarget: v.shortcutTarget ?? undefined,
    isHidden: v.isHidden ?? false,
    size: v.size,
    modified: new Date(v.modified),
    isSystemProtected: false,
  };
}

// Search returns SearchResult (no symlink flags), so it gets its own schema;
// the output keeps the FileItem shape the renderer expects.
function buildSearchResultItem(raw: Record<string, unknown>) {
  const v = validateIpc(RawSearchResultSchema, raw, 'SearchResult');
  if (!v) return null;
  return {
    name: v.name,
    path: v.path,
    isDirectory: v.isDirectory,
    isFile: !v.isDirectory,
    isSymlink: false,
    isBrokenSymlink: false,
    isAppBundle: false,
    isShortcut: false,
    isDesktopEntry: false,
    symlinkTarget: undefined,
    shortcutTarget: undefined,
    isHidden: v.isHidden ?? v.name.startsWith('.'),
    size: v.size,
    modified: new Date(v.modified),
    isSystemProtected: false,
    matchContext: v.matchContext ?? undefined,
  };
}

function bindSystemFallbacks() {
  if (systemFallbacksBound) return;
  systemFallbacksBound = true;

  let hiddenAt: number | null = null;
  const RESUME_THRESHOLD_MS = 5_000;

  const emitThemeChanged = () => {
    const isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
    systemThemeChangedCallbacks.forEach((cb) => cb({ isDarkMode }));
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
    } else if (document.visibilityState === 'visible' && hiddenAt !== null) {
      const elapsed = Date.now() - hiddenAt;
      hiddenAt = null;
      if (elapsed >= RESUME_THRESHOLD_MS) {
        systemResumedCallbacks.forEach((cb) => cb());
      }
    }
  });

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', emitThemeChanged);
}

const MAX_CONFLICT_RESOLUTION_ATTEMPTS = 10_001;

function parseConflictItem(errorMessage: string): string | null {
  const marker = 'CONFLICT:';
  const index = errorMessage.indexOf(marker);
  if (index === -1) return null;
  const rest = errorMessage.slice(index + marker.length).trim();
  // Native errors terminate the conflict item at the end of the message.
  // Keep punctuation and spaces: both are valid filename characters.
  return rest || null;
}

function normalizeWatchPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed) return '';
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\');
  if (isWindowsPath) {
    const normalized = trimmed.replace(/\//g, '\\');
    return normalized.replace(/\\+$/, '').toLowerCase();
  }
  const normalized = trimmed.replace(/\/+$/, '');
  return normalized || '/';
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
  command: 'copy_items' | 'move_items' | 'elevated_copy_batch' | 'elevated_move_batch',
  operation: 'copy' | 'move',
  sourcePaths: string[],
  destPath: string,
  conflictBehavior?: FileConflictBehavior,
  operationId?: string,
  previousResolutions?: Record<string, ConflictDecision>
) {
  const behavior = conflictBehavior ?? 'ask';
  const conflictResolutions: Record<string, ConflictDecision> = { ...previousResolutions };
  let attempts = 0;

  while (attempts++ < MAX_CONFLICT_RESOLUTION_ATTEMPTS) {
    try {
      await invoke(command, {
        sourcePaths,
        destPath,
        conflictBehavior: behavior,
        conflictResolutions: behavior === 'ask' ? conflictResolutions : null,
        operationId: operationId ?? null,
      });
      return { success: true as const };
    } catch (e) {
      const error = String(e);
      if (behavior !== 'ask') {
        return { success: false as const, error, conflictResolutions };
      }

      const conflictItem = parseConflictItem(error);
      if (!conflictItem) {
        return { success: false as const, error, conflictResolutions };
      }

      const resolution = await promptConflictResolution(conflictItem, operation);
      if (resolution === 'cancel') {
        return { success: false as const, error: 'Operation cancelled' };
      }

      conflictResolutions[conflictItem] = resolution;
    }
  }

  return {
    success: false as const,
    error: 'Too many file-conflict resolution attempts',
  };
}

const tauriAPI: TauriAPI = {
  getDirectoryContents: async (dirPath, operationId, includeHidden, _streamOnly) => {
    const startedAt = nowMs();
    devLog('IPC', 'get_directory_contents request', {
      dirPath,
      operationId: operationId ?? null,
      includeHidden: includeHidden ?? null,
    });
    try {
      const items = await invoke<Record<string, unknown>[]>('get_directory_contents', {
        dirPath,
        operationId: operationId ?? null,
        includeHidden: includeHidden ?? null,
        streamOnly: null,
      });
      const durationMs = elapsedMs(startedAt);
      logIpcTiming('get_directory_contents', durationMs, {
        dirPath,
        operationId: operationId ?? null,
        itemCount: items.length,
      });
      return {
        success: true,
        contents: items.map(buildFileItem).filter((item) => item !== null),
      };
    } catch (e) {
      const durationMs = elapsedMs(startedAt);
      devLog('IPC', `get_directory_contents failed in ${durationMs.toFixed(1)}ms`, {
        dirPath,
        operationId: operationId ?? null,
        error: String(e),
      });
      return { success: false, error: String(e) };
    }
  },
  cancelDirectoryContents: (operationId) => {
    devLog('IPC', 'cancel_directory_contents request', { operationId });
    return wrap(() => invoke('cancel_directory_contents', { operationId }));
  },
  getDrives: async () => {
    try {
      const drives = await invoke<Record<string, unknown>[]>('get_drives');
      return drives.map((d) => d.mountPoint as string);
    } catch (e) {
      devLog('IPC', 'getDrives failed', e);
      throw e;
    }
  },
  getDriveInfo: async () => {
    const startedAt = nowMs();
    devLog('IPC', 'get_drive_info request');
    try {
      const drives = await invoke<Record<string, unknown>[]>('get_drive_info');
      const mapped = drives
        .map((d) => {
          const v = validateIpc(RawDriveInfoSchema, d, 'DriveInfo');
          if (!v) return null;
          return { path: v.mountPoint, label: v.name };
        })
        .filter((d): d is { path: string; label: string } => d !== null);
      logIpcTiming('get_drive_info', elapsedMs(startedAt), { driveCount: mapped.length });
      return mapped;
    } catch (e) {
      devLog('IPC', `get_drive_info failed in ${elapsedMs(startedAt).toFixed(1)}ms`, e);
      throw e;
    }
  },
  getHomeDirectory: () => invoke('get_home_directory'),
  getSpecialDirectory: async (directory: SpecialDirectory) => {
    try {
      const p = await invoke<string>('get_special_directory', { directory });
      return { success: true, path: p };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  openFile: (filePath) => wrap(() => invoke('open_file', { filePath })),
  selectFolder: async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      if (selected) return { success: true, path: selected as string };
      return { success: false, error: 'No folder selected' };
    } catch (e) {
      return { success: false, error: String(e) };
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
    } catch (e) {
      devLog('IPC', 'getAutostart failed', e);
      return false;
    }
  },
  createFolder: async (parentPath, folderName) => {
    try {
      const p = await invoke<string>('create_folder', { parentPath, folderName });
      return { success: true, path: p };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  createFile: async (parentPath, fileName) => {
    try {
      const p = await invoke<string>('create_file', { parentPath, fileName });
      return { success: true, path: p };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  deleteItem: (itemPath) => wrap(() => invoke('delete_item', { itemPath })),
  trashItem: (itemPath) => wrap(() => invoke('trash_item', { itemPath })),
  openTrash: () => wrap(() => invoke('open_trash')),
  renameItem: async (oldPath, newName) => {
    try {
      const p = await invoke<string>('rename_item', { oldPath, newName });
      return { success: true, path: p };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  getItemProperties: async (itemPath) => {
    try {
      const props = await invoke<Record<string, unknown>>('get_item_properties', { itemPath });
      const v = validateIpc(RawItemPropertiesSchema, props, 'ItemProperties');
      if (!v) {
        return { success: false, error: 'Invalid item properties from backend' };
      }
      return {
        success: true,
        properties: {
          path: v.path,
          name: v.name,
          size: v.size,
          isDirectory: v.isDirectory,
          isFile: !v.isDirectory,
          isSymlink: v.isSymlink ?? false,
          symlinkTarget: v.symlinkTarget ?? undefined,
          isShortcut: v.isShortcut ?? undefined,
          shortcutTarget: v.shortcutTarget ?? undefined,
          created: new Date(v.created),
          modified: new Date(v.modified),
          accessed: new Date(v.accessed),
          mode: v.permissions ?? undefined,
          isReadOnly: v.readonly,
          isHiddenAttr: v.isHiddenAttr ?? undefined,
          isSystemAttr: v.isSystemAttr ?? undefined,
          owner: v.owner ?? undefined,
          group: v.group ?? undefined,
          extension: v.extension,
          sizeOnDisk: v.sizeOnDisk ?? undefined,
          mimeType: v.mimeType ?? undefined,
          opensWith: v.opensWith ?? undefined,
          ownerName: v.ownerName ?? undefined,
          groupName: v.groupName ?? undefined,
          isArchiveAttr: v.isArchiveAttr ?? undefined,
          isCompressedAttr: v.isCompressedAttr ?? undefined,
          isEncryptedAttr: v.isEncryptedAttr ?? undefined,
          isIndexedAttr: v.isIndexedAttr ?? undefined,
        },
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  setPermissions: (itemPath, mode) => wrap(() => invoke('set_permissions', { itemPath, mode })),
  setAttributes: (itemPath, attrs) => wrap(() => invoke('set_attributes', { itemPath, attrs })),
  getSettings: async () => {
    try {
      const json = await invoke<string>('get_settings');
      const settings = parseSettingsPayload(json || '{}', 'Settings');
      if (!settings) {
        return { success: false, error: 'Settings file is corrupted, using defaults' };
      }
      storeSettingsBaseline(settings);
      return { success: true, settings: sanitizeSettings(settings) };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  saveSettings: (settings: Settings, replace = false) =>
    saveSettingsThroughBridge(settings, replace),
  saveSettingsSync: (settings: Settings, replace = false) =>
    saveSettingsThroughBridge(settings, replace),
  reconcileSettingsSnapshot: (remote, local, canonical) => {
    const latest =
      (canonical && parseSettingsPayload(canonical, 'SettingsEventCanonical')) ||
      (latestSettingsCanonical &&
      settingsRevision(latestSettingsCanonical) === settingsRevision(remote)
        ? latestSettingsCanonical
        : parseSettingsPayload(remote, 'SettingsEvent'));
    if (!latest) return local;
    const currentRevision = settingsBaselineRaw ? settingsRevision(settingsBaselineRaw) : 0;
    if (settingsRevision(latest) < currentRevision) return local;

    const baseline = settingsBaselineView ?? local;
    const pendingKeys = Object.keys(local).filter(
      (key) =>
        key !== '_revision' &&
        key !== '_timestamp' &&
        !settingsValueEqual(getSettingsField(local, key), getSettingsField(baseline, key))
    );
    advanceSettingsBaseline(latest, pendingKeys);
    const merged: Record<string, unknown> = { ...sanitizeSettings(latest) };
    for (const key of pendingKeys) {
      if (Object.prototype.hasOwnProperty.call(local, key)) {
        merged[key] = getSettingsField(local, key);
      } else {
        delete merged[key];
      }
    }
    return sanitizeSettings(merged);
  },
  resolveSettingsConflict: (settings, keys, resolution) => {
    const latest = latestSettingsCanonical;
    if (!latest) return settings;
    const latestView = sanitizeSettings(latest);
    const next: Record<string, unknown> = { ...settings, _revision: settingsRevision(latest) };
    if (settingsBaselineRaw && settingsBaselineView) {
      if (keys.includes('settings')) {
        settingsBaselineRaw = { ...latest };
        settingsBaselineView = latestView;
        return resolution === 'useLatest' ? latestView : sanitizeSettings(next);
      }
      for (const key of keys) {
        if (key === '_revision' || key === '_timestamp') continue;
        if (Object.prototype.hasOwnProperty.call(latest, key)) {
          settingsBaselineRaw[key] = latest[key];
        } else {
          delete settingsBaselineRaw[key];
        }
        if (Object.prototype.hasOwnProperty.call(latestView, key)) {
          setSettingsField(settingsBaselineView, key, getSettingsField(latestView, key));
        } else {
          removeSettingsField(settingsBaselineView, key);
        }
        if (resolution === 'useLatest') {
          if (Object.prototype.hasOwnProperty.call(latestView, key)) {
            next[key] = getSettingsField(latestView, key);
          } else {
            delete next[key];
          }
        }
      }
    }
    return sanitizeSettings(next);
  },
  resetSettings: () => wrap(() => invoke('reset_settings')),
  relaunchApp: () => invoke('relaunch_app'),
  getSettingsPath: () => invoke('get_settings_path'),
  getHomeSettings: async () => {
    try {
      const json = await invoke<string>('get_home_settings');
      let parsed: unknown;
      try {
        parsed = JSON.parse(json || '{}') as unknown;
      } catch {
        return { success: false, error: 'Home settings file is corrupted, using defaults' };
      }
      const settings = validateIpc(RawHomeSettingsSchema, parsed, 'HomeSettings');
      if (!settings) {
        return { success: false, error: 'Home settings file is corrupted, using defaults' };
      }
      storeHomeSettingsBaseline(settings);
      return { success: true, settings: sanitizeHomeSettings(settings) };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  saveHomeSettings: (settings: HomeSettings) => saveHomeSettingsThroughBridge(settings),
  reconcileHomeSettingsSnapshot: (remote, local, canonical) => {
    const latest =
      (canonical && validateIpc(RawHomeSettingsSchema, canonical, 'HomeSettingsEventCanonical')) ||
      (latestHomeSettingsCanonical &&
      homeSettingsRevision(latestHomeSettingsCanonical) === homeSettingsRevision(remote)
        ? latestHomeSettingsCanonical
        : validateIpc(RawHomeSettingsSchema, remote, 'HomeSettingsEvent'));
    if (!latest) return local;
    const currentRevision = homeSettingsBaselineRaw
      ? homeSettingsRevision(homeSettingsBaselineRaw)
      : 0;
    if (homeSettingsRevision(latest) < currentRevision) return local;

    const baseline = homeSettingsBaselineView ?? local;
    const pendingKeys = Object.keys(local).filter(
      (key) =>
        key !== '_revision' &&
        !settingsValueEqual(
          Object.getOwnPropertyDescriptor(local, key)?.value,
          Object.getOwnPropertyDescriptor(baseline, key)?.value
        )
    );
    advanceHomeSettingsBaseline(latest, pendingKeys);
    const merged: Record<string, unknown> = { ...sanitizeHomeSettings(latest) };
    for (const key of pendingKeys) {
      if (Object.prototype.hasOwnProperty.call(local, key)) {
        merged[key] = Object.getOwnPropertyDescriptor(local, key)?.value;
      } else {
        delete merged[key];
      }
    }
    return sanitizeHomeSettings(merged);
  },
  resolveHomeSettingsConflict: (settings, keys, resolution) => {
    const latest = latestHomeSettingsCanonical;
    if (!latest) return settings;
    const latestView = sanitizeHomeSettings(latest);
    const next: HomeSettings = { ...settings, _revision: homeSettingsRevision(latest) };
    if (homeSettingsBaselineRaw && homeSettingsBaselineView) {
      for (const key of keys) {
        if (key === '_revision') continue;
        if (Object.prototype.hasOwnProperty.call(latest, key)) {
          homeSettingsBaselineRaw[key] = latest[key];
        } else {
          delete homeSettingsBaselineRaw[key];
        }
        if (Object.prototype.hasOwnProperty.call(latestView, key)) {
          Object.defineProperty(homeSettingsBaselineView, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: Object.getOwnPropertyDescriptor(latestView, key)?.value,
          });
        } else {
          Reflect.deleteProperty(homeSettingsBaselineView, key);
        }
        if (resolution === 'useLatest') {
          if (Object.prototype.hasOwnProperty.call(latestView, key)) {
            Object.defineProperty(next, key, {
              configurable: true,
              enumerable: true,
              writable: true,
              value: Object.getOwnPropertyDescriptor(latestView, key)?.value,
            });
          } else {
            Reflect.deleteProperty(next, key);
          }
        }
      }
    }
    return sanitizeHomeSettings(next);
  },
  resetHomeSettings: () => wrap(() => invoke('reset_home_settings')),
  getHomeSettingsPath: () => invoke('get_home_settings_path'),

  setClipboard: (clipboardData) => invoke('set_clipboard', { clipboardData }),
  // Resolve to null on failure so a clipboard-read error never blocks startup.
  getClipboard: async () => {
    try {
      const raw = await invoke<unknown>('get_clipboard');
      if (raw === null) return null;
      return validateIpc(RawClipboardOperationSchema, raw, 'ClipboardOperation');
    } catch {
      return null;
    }
  },
  getSystemClipboardData: async () => {
    try {
      const data = await invoke<{ operation?: string; paths?: string[] } | null>(
        'get_system_clipboard_data'
      );
      if (data?.paths?.length) {
        return {
          operation: data.operation === 'cut' ? 'cut' : 'copy',
          paths: data.paths,
        };
      }
    } catch (e) {
      devLog('IPC', 'getSystemClipboardData failed', e);
    }
    return null;
  },
  getSystemClipboardFiles: async () => {
    try {
      const paths = await invoke<string[]>('get_system_clipboard_files');
      if (Array.isArray(paths) && paths.length > 0) return paths;
    } catch (e) {
      devLog('IPC', 'getSystemClipboardFiles failed', e);
    }
    return [];
  },
  writeToSystemClipboard: (text: string) => invoke('write_to_system_clipboard', { text }),
  onClipboardChanged: (callback) => {
    const unlisten = listen('clipboard-changed', (event) => {
      if (event.payload === null) {
        callback(null);
        return;
      }
      const clipboard = validateIpc(RawClipboardOperationSchema, event.payload, 'ClipboardEvent');
      if (clipboard) callback(clipboard);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(ignoreError);
    };
  },

  setDragData: (paths) => invoke('set_drag_data', { paths }),
  getDragData: async () => {
    try {
      const paths = await invoke<string[]>('get_drag_data');
      return paths.length > 0 ? { paths } : null;
    } catch (e) {
      devLog('IPC', 'getDragData failed', e);
      return null;
    }
  },
  clearDragData: () => invoke('clear_drag_data'),
  getPathForFile: (file: File) => {
    try {
      const webview = getCurrentWebview() as { getPathForFile?: (f: File) => string };
      return webview.getPathForFile?.(file) ?? '';
    } catch {
      return '';
    }
  },
  onNativeDragDrop: (callback) => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload as DragDropEvent;
      const normalized: NativeDragDropEvent = {
        type: payload.type,
      };
      if ('paths' in payload) normalized.paths = payload.paths;
      if ('position' in payload) normalized.position = payload.position;
      callback(normalized);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(ignoreError);
    };
  },

  onSettingsChanged: (callback) => {
    const unlisten = listen('settings-changed', (event) => {
      const payload = parseSettingsPayload(event.payload, 'SettingsEvent');
      if (payload) callback(sanitizeSettings(payload), payload);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(ignoreError);
    };
  },
  onHomeSettingsChanged: (callback) => {
    const unlisten = listen('home-settings-changed', (event) => {
      let payload: unknown = event.payload;
      try {
        if (typeof payload === 'string') payload = JSON.parse(payload) as unknown;
        const settings = validateIpc(RawHomeSettingsSchema, payload, 'HomeSettingsEvent');
        if (settings) callback(sanitizeHomeSettings(settings), settings);
      } catch {
        console.error('[Settings] Failed to parse home-settings-changed payload');
      }
    });
    return () => {
      unlisten.then((fn) => fn()).catch(ignoreError);
    };
  },

  copyItems: (sourcePaths, destPath, conflictBehavior, operationId) =>
    runFileOperationWithConflictResolution(
      'copy_items',
      'copy',
      sourcePaths,
      destPath,
      conflictBehavior,
      operationId
    ),
  moveItems: (sourcePaths, destPath, conflictBehavior, operationId) =>
    runFileOperationWithConflictResolution(
      'move_items',
      'move',
      sourcePaths,
      destPath,
      conflictBehavior,
      operationId
    ),
  showConflictDialog: (fileName, operation) =>
    promptConflictResolution(fileName, operation as 'copy' | 'move'),
  searchFiles: async (dirPath, query, filters, operationId, includeHidden) => {
    try {
      const results = await invoke<Record<string, unknown>[]>('search_files', {
        dirPath,
        query,
        filters: filters ? JSON.stringify(filters) : null,
        operationId: operationId ?? null,
        includeHidden: includeHidden === true,
      });
      return {
        success: true,
        results: results.map(buildSearchResultItem).filter((item) => item !== null),
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  searchFilesWithContent: async (dirPath, query, filters, operationId, includeHidden) => {
    try {
      const results = await invoke<Record<string, unknown>[]>('search_files_content', {
        dirPath,
        query,
        filters: filters ? JSON.stringify(filters) : null,
        operationId: operationId ?? null,
        includeHidden: includeHidden === true,
      });
      return {
        success: true,
        results: results.map(buildSearchResultItem).filter((item) => item !== null),
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  searchFilesWithContentGlobal: async (query, filters, operationId, includeHidden) => {
    try {
      const results = await invoke<Record<string, unknown>[]>('search_files_content_global', {
        query,
        filters: filters ? JSON.stringify(filters) : null,
        operationId: operationId ?? null,
        includeHidden: includeHidden === true,
      });
      return {
        success: true,
        results: results.map(buildSearchResultItem).filter((item) => item !== null),
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  getDiskSpace: async (drivePath) => {
    const startedAt = nowMs();
    devLog('IPC', 'get_disk_space request', { drivePath });
    try {
      const info = await invoke<Record<string, unknown>>('get_disk_space', { drivePath });
      logIpcTiming('get_disk_space', elapsedMs(startedAt), {
        drivePath,
        total: info.total as number,
        free: info.free as number,
      });
      return { success: true, total: info.total as number, free: info.free as number };
    } catch (e) {
      devLog('IPC', `get_disk_space failed in ${elapsedMs(startedAt).toFixed(1)}ms`, {
        drivePath,
        error: String(e),
      });
      return { success: false, error: String(e) };
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
  elevatedCopyBatch: (sourcePaths, destPath, behavior, resolutions) =>
    runFileOperationWithConflictResolution(
      'elevated_copy_batch',
      'copy',
      sourcePaths,
      destPath,
      behavior,
      undefined,
      resolutions
    ),
  elevatedMoveBatch: (sourcePaths, destPath, behavior, resolutions) =>
    runFileOperationWithConflictResolution(
      'elevated_move_batch',
      'move',
      sourcePaths,
      destPath,
      behavior,
      undefined,
      resolutions
    ),
  elevatedDeleteBatch: (itemPaths) => wrap(() => invoke('elevated_delete_batch', { itemPaths })),
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
      const payload = await invoke<{ content: string; isTruncated: boolean }>('read_file_content', {
        filePath,
        maxSize: maxSize ?? null,
      });
      return {
        success: true,
        content: payload.content,
        isTruncated: payload.isTruncated,
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  getFileDataUrl: async (filePath, maxSize) => {
    try {
      const dataUrl = await invoke<string>('get_file_data_url', {
        filePath,
        maxSize: maxSize ?? null,
      });
      return { success: true, dataUrl };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  getLicenses: async () => {
    try {
      const json = await invoke<string>('get_licenses');
      const parsed = JSON.parse(json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { success: false, error: 'Invalid licenses payload format' };
      }
      return { success: true, licenses: parsed as LicensesData };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  getPlatform: () => invoke('get_platform'),
  getWindowLabel: () => {
    try {
      return getCurrentWebviewWindow().label;
    } catch {
      return 'unknown';
    }
  },
  getAppVersion: () => invoke('get_app_version'),
  getSystemAccentColor: () => invoke('get_system_accent_color'),
  isMas: () => invoke('is_mas'),
  isFlatpak: () => invoke('is_flatpak'),
  isMsStore: () => invoke('is_ms_store'),
  isDevMode: () => invoke('is_dev_mode'),
  getSystemTextScale: () => invoke('get_system_text_scale'),
  checkFullDiskAccess: async () => {
    try {
      const hasAccess = await invoke<boolean>('check_full_disk_access');
      return { success: true, hasAccess };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  requestFullDiskAccess: () => wrap(() => invoke('request_full_disk_access')),
  checkForUpdates: async () => {
    let currentVersion: string;
    let isFlatpak: boolean;
    let isMas: boolean;
    let isMsStore: boolean;
    let isMsi: boolean;
    try {
      [currentVersion, isFlatpak, isMas, isMsStore, isMsi] = await Promise.all([
        invoke<string>('get_app_version'),
        invoke<boolean>('is_flatpak'),
        invoke<boolean>('is_mas'),
        invoke<boolean>('is_ms_store'),
        invoke<boolean>('is_msi'),
      ]);
    } catch (e) {
      return { success: false as const, error: String(e) };
    }
    const installedIsBeta = /-(beta|alpha|rc)/i.test(currentVersion);
    const requestedChannel = currentUpdateChannel;
    const isBeta = isCheckingBetaChannel(requestedChannel, installedIsBeta);

    // A second check must not replace the update object while download/install
    // owns it. Return the current state instead; caller can retry after the
    // active operation completes.
    if (updateDownloadInProgress || updateReadyToInstall) {
      return {
        success: true,
        hasUpdate: pendingUpdate !== null,
        currentVersion,
        latestVersion: pendingUpdate?.version ?? currentVersion,
        isBeta,
      };
    }
    const generation = ++updateGeneration;

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
      };
    }

    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const target = await getCheckTarget(requestedChannel, installedIsBeta);
      const update = target ? await check({ target }) : await check();
      if (generation !== updateGeneration || updateDownloadInProgress || updateReadyToInstall) {
        if (update !== pendingUpdate) closeUpdate(update);
        return {
          success: true,
          hasUpdate: pendingUpdate !== null,
          currentVersion,
          latestVersion: pendingUpdate?.version ?? currentVersion,
          isBeta: isCheckingBetaChannel(currentUpdateChannel, installedIsBeta),
        };
      }
      if (update) {
        replacePendingUpdate(update);
        updateReadyToInstall = false;
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
        };
      }
      if (!updateDownloadInProgress && !updateReadyToInstall) {
        replacePendingUpdate(null);
      }
      return {
        success: true,
        hasUpdate: false,
        currentVersion,
        latestVersion: currentVersion,
        isBeta,
      };
    } catch (e) {
      if (generation === updateGeneration && !updateDownloadInProgress && !updateReadyToInstall) {
        replacePendingUpdate(null);
      }
      const message = String(e);
      const error = /pubkey|signature|updater/i.test(message)
        ? 'Updater is not configured correctly. Configure the updater public key before checking for updates.'
        : message;
      return {
        success: false,
        error,
      };
    }
  },
  downloadUpdate: async () => {
    try {
      const update = pendingUpdate;
      if (!update) return { success: false as const, error: 'No update available' };
      if (updateDownloadInProgress) {
        return { success: false as const, error: 'Update download already in progress' };
      }
      if (updateReadyToInstall) return { success: true as const };
      const generation = updateGeneration;
      updateDownloadInProgress = true;
      updateReadyToInstall = false;
      let downloaded = 0;
      let contentLength = 0;
      await update.download((event) => {
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
        }
      });
      updateDownloadInProgress = false;
      if (pendingUpdate !== update || updateGeneration !== generation) {
        if (pendingUpdate === update) replacePendingUpdate(null);
        else closeUpdate(update);
        return { success: false as const, error: 'Update was superseded by a newer check' };
      }
      // Finished reports transport completion. Only the resolved download
      // promise confirms verification and availability of the install resource.
      if (!updateReadyToInstall) {
        updateReadyToInstall = true;
        updateDownloadedCallbacks.forEach((cb) => {
          try {
            cb({ version: update.version });
          } catch (err) {
            console.error('[Updater] onUpdateDownloaded callback error:', err);
          }
        });
      }
      return { success: true as const };
    } catch (e) {
      updateDownloadInProgress = false;
      updateReadyToInstall = false;
      return { success: false as const, error: String(e) };
    }
  },
  installUpdate: async () => {
    try {
      const update = pendingUpdate;
      if (!update) return { success: false as const, error: 'No update available' };
      if (!updateReadyToInstall) {
        return { success: false as const, error: 'Update has not finished downloading' };
      }
      const generation = updateGeneration;
      await update.install();
      if (pendingUpdate === update && updateGeneration === generation) {
        updateReadyToInstall = false;
        replacePendingUpdate(null);
      }
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
      const raw = await invoke<unknown>('undo_action');
      const state = validateIpc(RawUndoStateSchema, raw, 'UndoState');
      if (!state) return { success: false, error: 'Invalid undo state from backend' };
      return { success: true, canUndo: state.canUndo, canRedo: state.canRedo };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  redoAction: async () => {
    try {
      const raw = await invoke<unknown>('redo_action');
      const state = validateIpc(RawUndoStateSchema, raw, 'RedoState');
      if (!state) return { success: false, error: 'Invalid redo state from backend' };
      return { success: true, canUndo: state.canUndo, canRedo: state.canRedo };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  getUndoRedoState: async () => {
    try {
      const raw = await invoke<unknown>('get_undo_redo_state');
      const state = validateIpc(RawUndoStateSchema, raw, 'UndoRedoState');
      if (!state) return { success: false, error: 'Invalid undo state from backend' };
      return { success: true, canUndo: state.canUndo, canRedo: state.canRedo };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  searchIndex: async (query, operationId, filters, includeHidden) => {
    try {
      const results = await invoke<Record<string, unknown>[]>('search_index', {
        query,
        operationId: operationId ?? null,
        filters: filters ? JSON.stringify(filters) : null,
        includeHidden: includeHidden === true,
      });
      return {
        success: true,
        results: results.map(buildSearchResultItem).filter((item) => item !== null),
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  cancelSearch: (operationId) => wrap(() => invoke('cancel_search', { operationId })),
  rebuildIndex: () => wrap(() => invoke('rebuild_index')),
  getIndexStatus: async () => {
    try {
      const raw = await invoke<unknown>('get_index_status');
      const status = validateIpc(RawIndexStatusSchema, raw, 'IndexStatus');
      if (!status) return { success: false, error: 'Invalid index status from backend' };
      const lastIndexTime = status.lastBuilt ? new Date(status.lastBuilt) : null;
      if (lastIndexTime && !Number.isFinite(lastIndexTime.getTime())) {
        return { success: false, error: 'Invalid index timestamp from backend' };
      }
      return {
        success: true,
        status: {
          isIndexing: status.isBuilding,
          totalFiles: status.entryCount,
          indexedFiles: status.entryCount,
          lastIndexTime,
          truncated: status.truncated ?? false,
          truncationReasons: status.truncationReasons ?? [],
          indexedRoots: status.indexedRoots ?? [],
        },
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  compressFiles: (sourcePaths, outputPath, format, operationId, advancedOptions) =>
    wrap(() =>
      invoke('compress_files', {
        sourcePaths,
        outputPath,
        format: format ?? null,
        operationId: operationId ?? null,
        advancedOptions: advancedOptions ?? null,
      })
    ),
  extractArchive: (archivePath, destPath, operationId, password) =>
    wrap(() =>
      invoke('extract_archive', {
        archivePath,
        destPath,
        operationId: operationId ?? null,
        password: password ?? null,
      })
    ),
  cancelArchiveOperation: (operationId) =>
    wrap(() => invoke('cancel_archive_operation', { operationId })),
  onCompressProgress: (callback) => {
    const unlisten = listen('compress-progress', (event) => {
      const progress = validateIpc(RawArchiveProgressSchema, event.payload, 'CompressProgress');
      if (progress) callback(progress);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(ignoreError);
    };
  },
  onExtractProgress: (callback) => {
    const unlisten = listen('extract-progress', (event) => {
      const progress = validateIpc(RawArchiveProgressSchema, event.payload, 'ExtractProgress');
      if (progress) callback(progress);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(ignoreError);
    };
  },
  onFileOperationProgress: (callback) => {
    const unlisten = listen('file-operation-progress', (event) => {
      const progress = validateIpc(
        RawFileOperationProgressSchema,
        event.payload,
        'FileOperationProgress'
      );
      if (progress) callback(progress);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(ignoreError);
    };
  },
  cancelFileOperation: (operationId) =>
    wrap(() => invoke('cancel_file_operation', { operationId })),
  onSystemResumed: (callback) => {
    bindSystemFallbacks();
    systemResumedCallbacks.add(callback);
    return () => {
      systemResumedCallbacks.delete(callback);
    };
  },
  onDirectoryChanged: (callback) => {
    const unlisten = listen('directory-changed', (event) => {
      const changed = validateIpc(RawDirectoryChangedSchema, event.payload, 'DirectoryChanged');
      if (changed) callback(changed);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(ignoreError);
    };
  },
  onWatchedDirRemoved: (callback) => {
    const unlisten = listen('watched-dir-removed', (event) => {
      const removed = validateIpc(
        RawWatchedDirectoryRemovedSchema,
        event.payload,
        'WatchedDirectoryRemoved'
      );
      if (removed) callback(removed);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(ignoreError);
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
      return { success: true, zoomLevel };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  watchDirectory: async (dirPath) => {
    const normalized = normalizeWatchPath(dirPath);
    devLog('Watcher', 'watch_directory request', {
      dirPath,
      normalized,
      lastWatchedDirectoryPath,
    });
    try {
      if (normalized && normalized === lastWatchedDirectoryPath) {
        devLog('Watcher', 'watch_directory skipped (already watching path)', {
          normalized,
        });
        return true;
      }
      await invoke('watch_directory', { dirPath });
      lastWatchedDirectoryPath = normalized;
      devLog('Watcher', 'watch_directory started', {
        dirPath,
        normalized,
      });
      return true;
    } catch (error) {
      devLog('Watcher', 'watch_directory failed', {
        dirPath,
        normalized,
        error: String(error),
      });
      return false;
    }
  },
  unwatchDirectory: () => {
    devLog('Watcher', 'unwatch_directory request', { lastWatchedDirectoryPath });
    lastWatchedDirectoryPath = '';
    return invoke('unwatch_directory');
  },
  calculateFolderSize: async (folderPath, operationId) => {
    try {
      const result = await invoke<Record<string, number>>('calculate_folder_size', {
        folderPath,
        operationId,
      });
      const v = validateIpc(RawFolderSizeSchema, result, 'FolderSize');
      if (!v) {
        return { success: false, error: 'Invalid folder size from backend' };
      }
      return {
        success: true,
        result: {
          totalSize: v.totalSize ?? 0,
          fileCount: v.fileCount ?? 0,
          folderCount: v.folderCount ?? 0,
        },
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  cancelFolderSizeCalculation: (operationId) =>
    wrap(() => invoke('cancel_folder_size_calculation', { operationId })),
  onFolderSizeProgress: (callback) => {
    const unlisten = listen('folder-size-progress', (event) => {
      const p = validateIpc(RawFolderSizeProgressSchema, event.payload, 'FolderSizeProgress');
      if (!p) return;
      callback({
        operationId: p.operationId,
        calculatedSize: p.size,
        fileCount: p.files,
        folderCount: 0,
        currentPath: '',
      });
    });
    return () => {
      unlisten.then((fn) => fn()).catch(ignoreError);
    };
  },
  onDirectoryContentsProgress: (callback) => {
    const unlisten = listen('directory-contents-progress', (event) => {
      const progress = validateIpc(
        RawDirectoryContentsProgressSchema,
        event.payload,
        'DirectoryContentsProgress'
      );
      if (!progress) return;
      const items = progress.items
        ?.map((item) => buildFileItem(item))
        .filter((item) => item !== null);
      callback({
        dirPath: progress.dirPath,
        loaded: progress.loaded,
        operationId: progress.operationId,
        items,
      });
    });
    return () => {
      unlisten.then((fn) => fn()).catch(ignoreError);
    };
  },
  onDirectoryTruncated: (callback) => {
    const unlisten = listen('directory-truncated', (event) => {
      const truncated = validateIpc(
        RawDirectoryTruncatedSchema,
        event.payload,
        'DirectoryTruncated'
      );
      if (truncated) callback(truncated);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(ignoreError);
    };
  },
  calculateChecksum: async (filePath, operationId, algorithms) => {
    try {
      const result = await invoke<Record<string, string>>('calculate_checksum', {
        filePath,
        operationId,
        algorithms,
      });
      return {
        success: true,
        result: {
          md5: result.md5,
          sha256: result.sha256,
          sha512: result.sha512,
          blake3: result.blake3,
          crc32: result.crc32,
        },
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  cancelChecksumCalculation: (operationId) =>
    wrap(() => invoke('cancel_checksum_calculation', { operationId })),
  onChecksumProgress: (callback) => {
    const unlisten = listen('checksum-progress', (event) => {
      const progress = validateIpc(RawChecksumProgressSchema, event.payload, 'ChecksumProgress');
      if (progress) callback(progress);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(ignoreError);
    };
  },
  getGitStatus: async (dirPath, includeUntracked) => {
    try {
      const raw = await invoke<Record<string, unknown>>('get_git_status', {
        dirPath,
        includeUntracked: includeUntracked ?? null,
      });
      const result = validateIpc(RawGitStatusSchema, raw, 'GitStatus');
      if (!result) {
        return { success: false, error: 'Invalid git status from backend' };
      }
      const statuses: GitFileStatus[] = [];
      for (const f of result.modified || []) statuses.push({ path: f, status: 'modified' });
      for (const f of result.added || []) statuses.push({ path: f, status: 'added' });
      for (const f of result.deleted || []) statuses.push({ path: f, status: 'deleted' });
      for (const f of result.untracked || []) statuses.push({ path: f, status: 'untracked' });
      return { success: true, isGitRepo: result.isGitRepo, statuses };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  getGitBranch: async (dirPath) => {
    try {
      const branch = await invoke<string>('get_git_branch', { dirPath });
      return { success: true, branch };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  listArchiveContents: async (archivePath) => {
    try {
      const entries = await invoke<Record<string, unknown>[]>('list_archive_contents', {
        archivePath,
      });
      return {
        success: true,
        entries: entries
          .map((e) => {
            const v = validateIpc(RawArchiveEntrySchema, e, 'ArchiveEntry');
            if (!v) return null;
            return {
              name: v.name,
              path: v.path,
              size: v.size,
              isDirectory: v.isDirectory,
              compressedSize: v.compressedSize,
            };
          })
          .filter((entry) => entry !== null),
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  getEmbeddedOfficeThumbnail: async (filePath, maxSize) => {
    try {
      const dataUrl = await invoke<string>('get_embedded_office_thumbnail', {
        filePath,
        maxSize: maxSize ?? null,
      });
      return { success: true, dataUrl };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },

  findDuplicateFiles: async (dirPath, minSize, includeHidden) => {
    try {
      const payload = await invoke<{ groups: Record<string, unknown>[]; partial: boolean }>(
        'find_duplicate_files',
        {
          dirPath,
          minSize: minSize ?? null,
          includeHidden: includeHidden ?? null,
        }
      );
      return {
        success: true,
        groups: payload.groups
          .map((g) => validateIpc(RawDuplicateGroupSchema, g, 'DuplicateGroup'))
          .filter((group) => group !== null),
        partial: payload.partial,
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },

  getCachedThumbnail: async (filePath, mtimeMs, fileSize, variant) => {
    try {
      const dataUrl = await invoke<string | null>('get_cached_thumbnail', {
        filePath,
        mtimeMs,
        fileSize,
        ...(variant === undefined ? {} : { variant }),
      });
      return dataUrl ? { success: true, dataUrl } : { success: false, error: 'Not cached' };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  saveCachedThumbnail: (filePath, dataUrl, mtimeMs, fileSize, variant) =>
    wrap(() =>
      invoke('save_cached_thumbnail', {
        filePath,
        dataUrl,
        mtimeMs,
        fileSize,
        ...(variant === undefined ? {} : { variant }),
      })
    ),
  clearThumbnailCache: () => wrap(() => invoke('clear_thumbnail_cache')),
  getThumbnailCacheSize: async () => {
    try {
      const result = await invoke<{ sizeBytes: number; fileCount: number }>(
        'get_thumbnail_cache_size'
      );
      return { success: true, sizeBytes: result.sizeBytes, fileCount: result.fileCount };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },

  getLogsPath: () => invoke('get_logs_path'),
  openLogsFolder: () => wrap(() => invoke('open_logs_folder')),
  exportDiagnostics: async () => {
    try {
      const raw = await invoke<unknown>('export_diagnostics');
      const result = validateIpc(RawDiagnosticsExportSchema, raw, 'DiagnosticsExport');
      if (!result) return { success: false, error: 'Invalid diagnostics export response' };
      if (result.status === 'cancelled') return { success: true, status: 'cancelled' };
      return { success: true, status: 'saved', path: result.path };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  getLogFileContent: async () => {
    try {
      const content = await invoke<string>('get_log_file_content');
      return { success: true, content, isTruncated: false };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },

  getOpenWithApps: async (filePath) => {
    try {
      const raw = await invoke<unknown>('get_open_with_apps', { filePath });
      if (!Array.isArray(raw)) {
        return { success: false, error: 'Invalid open-with app list from backend' };
      }
      const apps = raw
        .map((app) => validateIpc(RawOpenWithAppSchema, app, 'OpenWithApp'))
        .filter((app) => app !== null);
      return { success: true, apps };
    } catch (e) {
      return { success: false, error: String(e) };
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
        };
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  createSymlink: (targetPath, linkPath) =>
    wrap(() => invoke('create_symlink', { targetPath, linkPath })),
  shareItems: (filePaths) => wrap(() => invoke('share_items', { filePaths })),
  launchDesktopEntry: (filePath) => wrap(() => invoke('launch_desktop_entry', { filePath })),
  getNativeIntegrationStatus: async () => {
    try {
      const data = await invoke<Record<string, unknown>>('get_native_integration_status');
      return {
        success: true,
        supported: data.supported as boolean,
        installed: data.installed as boolean,
        message: data.message as string,
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
  installNativeIntegration: () => wrap(() => invoke('install_native_integration')),
  uninstallNativeIntegration: () => wrap(() => invoke('uninstall_native_integration')),
  onNativeMenuCommand: (callback) => {
    const unlisten = listen('native-menu-command', (event) => callback(String(event.payload)));
    return () => {
      unlisten.then((fn) => fn()).catch(ignoreError);
    };
  },
  onNativeOpenPath: (callback) => {
    const unlisten = listen('native-open-path', (event) => callback(String(event.payload)));
    return () => {
      unlisten.then((fn) => fn()).catch(ignoreError);
    };
  },
  setUpdateChannel: (channel) => {
    currentUpdateChannel = channel === 'beta' ? 'beta' : channel === 'stable' ? 'stable' : 'auto';
    updateGeneration += 1;
    if (!updateDownloadInProgress) {
      replacePendingUpdate(null);
      updateReadyToInstall = false;
    }
  },
};

(window as Window).tauriAPI = tauriAPI;
