import { z } from 'zod';
import { devLog } from './shared.js';

// Runtime schemas for IPC payloads. They mirror the Rust serde structs
// (#[serde(rename_all = "camelCase")]). Unknown keys are stripped (zod default),
// so extra backend fields never fail validation.
//
// Validation is intentionally non-fatal: on a mismatch we log the issues (dev)
// and return null so callers can drop or fail the record instead of trusting
// an unvalidated payload.

export const RawFileItemSchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  isSymlink: z.boolean(),
  isBrokenSymlink: z.boolean(),
  isAppBundle: z.boolean(),
  isShortcut: z.boolean(),
  isDesktopEntry: z.boolean(),
  symlinkTarget: z.string().nullable().optional(),
  shortcutTarget: z.string().nullable().optional(),
  isHidden: z.boolean(),
  size: z.number(),
  modified: z.number(),
  created: z.number(),
  extension: z.string(),
  permissions: z.number(),
  readonly: z.boolean(),
});
export type RawFileItem = z.infer<typeof RawFileItemSchema>;

export const RawDriveInfoSchema = z.object({
  name: z.string(),
  mountPoint: z.string(),
  totalSpace: z.number(),
  availableSpace: z.number(),
  fsType: z.string(),
  isRemovable: z.boolean(),
});
export type RawDriveInfo = z.infer<typeof RawDriveInfoSchema>;

export const RawItemPropertiesSchema = z.object({
  name: z.string(),
  path: z.string(),
  size: z.number(),
  isDirectory: z.boolean(),
  isSymlink: z.boolean(),
  symlinkTarget: z.string().nullable().optional(),
  isShortcut: z.boolean().nullable().optional(),
  shortcutTarget: z.string().nullable().optional(),
  isHidden: z.boolean(),
  readonly: z.boolean(),
  owner: z.string().nullable().optional(),
  group: z.string().nullable().optional(),
  isHiddenAttr: z.boolean().nullable().optional(),
  isSystemAttr: z.boolean().nullable().optional(),
  macTags: z.array(z.string()).nullable().optional(),
  created: z.number(),
  modified: z.number(),
  accessed: z.number(),
  extension: z.string(),
  // Null on Windows, where POSIX mode bits do not apply.
  permissions: z.number().nullable().optional(),
  sizeOnDisk: z.number().nullable().optional(),
  mimeType: z.string().nullable().optional(),
  opensWith: z.string().nullable().optional(),
  ownerName: z.string().nullable().optional(),
  groupName: z.string().nullable().optional(),
  isArchiveAttr: z.boolean().nullable().optional(),
  isCompressedAttr: z.boolean().nullable().optional(),
  isEncryptedAttr: z.boolean().nullable().optional(),
  isIndexedAttr: z.boolean().nullable().optional(),
});
export type RawItemProperties = z.infer<typeof RawItemPropertiesSchema>;

const RawCodeSignerSchema = z.object({
  name: z.string(),
  issuer: z.string().optional(),
  digestAlgorithm: z.string().optional(),
  timestamp: z.number().optional(),
  serialNumber: z.string().optional(),
  thumbprint: z.string().optional(),
  validFrom: z.number().optional(),
  validTo: z.number().optional(),
});

export const RawCodeSignatureSchema = z.object({
  supported: z.boolean(),
  signed: z.boolean(),
  status: z.enum([
    'valid',
    'invalid',
    'untrusted',
    'expired',
    'revoked',
    'unsigned',
    'unsupported',
    'error',
  ]),
  statusMessage: z.string().optional(),
  signers: z.array(RawCodeSignerSchema),
  identifier: z.string().optional(),
  teamId: z.string().optional(),
  hardenedRuntime: z.boolean().optional(),
});
export type RawCodeSignature = z.infer<typeof RawCodeSignatureSchema>;

export const RawSearchResultSchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  size: z.number(),
  modified: z.number(),
  extension: z.string(),
  matchContext: z.string().nullable().optional(),
  isHidden: z.boolean().optional(),
});
export type RawSearchResult = z.infer<typeof RawSearchResultSchema>;

export const RawArchiveEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  size: z.number(),
  isDirectory: z.boolean(),
  compressedSize: z.number(),
});
export type RawArchiveEntry = z.infer<typeof RawArchiveEntrySchema>;

export const RawFolderSizeSchema = z.object({
  totalSize: z.number(),
  fileCount: z.number(),
  folderCount: z.number(),
});
export type RawFolderSize = z.infer<typeof RawFolderSizeSchema>;

export const RawDuplicateGroupSchema = z.object({
  size: z.number(),
  hash: z.string(),
  paths: z.array(z.string()),
});
export type RawDuplicateGroup = z.infer<typeof RawDuplicateGroupSchema>;

export const RawGitStatusSchema = z.object({
  isGitRepo: z.boolean(),
  modified: z.array(z.string()),
  added: z.array(z.string()),
  deleted: z.array(z.string()),
  untracked: z.array(z.string()),
});
export type RawGitStatus = z.infer<typeof RawGitStatusSchema>;

export const RawSettingsSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (settings) =>
      settings._revision === undefined ||
      (typeof settings._revision === 'number' &&
        Number.isSafeInteger(settings._revision) &&
        settings._revision >= 0),
    'settings revision must be a non-negative safe integer'
  );

export const RawSettingsSaveSchema = z.object({
  status: z.enum(['saved', 'conflict']),
  settings: RawSettingsSchema,
  conflictKeys: z.array(z.string()).optional(),
  changedKeys: z.array(z.string()).optional(),
});

export const RawDiagnosticsExportSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved'), path: z.string().min(1) }),
  z.object({ status: z.literal('cancelled') }),
]);

export const RawUndoStateSchema = z.object({
  canUndo: z.boolean(),
  canRedo: z.boolean(),
});

export const RawIndexStatusSchema = z.object({
  isBuilding: z.boolean(),
  entryCount: z.number().int().nonnegative(),
  lastBuilt: z.string().nullable().optional(),
  truncated: z.boolean().optional(),
  truncationReasons: z.array(z.string()).optional(),
  indexedRoots: z.array(z.string()).optional(),
});

export const RawHomeSettingsSchema = z
  .object({
    _revision: z.number().int().nonnegative().safe().optional(),
    showQuickAccess: z.boolean().optional(),
    showRecents: z.boolean().optional(),
    showBookmarks: z.boolean().optional(),
    showDrives: z.boolean().optional(),
    showDiskUsage: z.boolean().optional(),
    hiddenQuickAccessItems: z.array(z.string()).optional(),
    quickAccessOrder: z.array(z.string()).optional(),
    sectionOrder: z.array(z.string()).optional(),
    pinnedRecents: z.array(z.string()).optional(),
    compactCards: z.boolean().optional(),
    sidebarQuickAccessOrder: z.array(z.string()).optional(),
    hiddenSidebarQuickAccessItems: z.array(z.string()).optional(),
  })
  .passthrough();

export const RawHomeSettingsSaveSchema = z.object({
  status: z.enum(['saved', 'conflict']),
  settings: RawHomeSettingsSchema,
  conflictKeys: z.array(z.string()).optional(),
  changedKeys: z.array(z.string()).optional(),
});

export const RawClipboardOperationSchema = z.object({
  operation: z.enum(['copy', 'cut']),
  paths: z.array(z.string()),
});

export const RawArchiveProgressSchema = z.object({
  operationId: z.string().optional(),
  current: z.number().finite(),
  total: z.number().finite(),
  name: z.string(),
});

export const RawFileOperationProgressSchema = z.object({
  operationId: z.string().optional(),
  operation: z.enum(['copy', 'move']),
  current: z.number().finite(),
  total: z.number().finite(),
  name: z.string(),
});

export const RawDirectoryChangedSchema = z.object({
  dirPath: z.string(),
  eventId: z.number().finite().optional(),
  eventKind: z.string().optional(),
  eventPaths: z.array(z.string()).optional(),
});

export const RawWatchedDirectoryRemovedSchema = z.object({ dirPath: z.string() });

export const RawDirectoryContentsProgressSchema = z.object({
  dirPath: z.string(),
  items: z.array(z.unknown()).optional(),
  loaded: z.number().finite(),
  operationId: z.string().optional(),
});

export const RawDirectoryTruncatedSchema = z.object({
  dirPath: z.string(),
  count: z.number().int().nonnegative(),
});

export const RawFolderSizeProgressSchema = z.object({
  operationId: z.string(),
  size: z.number().finite().nonnegative(),
  files: z.number().int().nonnegative(),
});

export const RawChecksumProgressSchema = z.object({
  operationId: z.string(),
  percent: z.number().finite().min(0).max(100),
  algorithm: z.string(),
});

export const RawOpenWithAppSchema = z.object({ id: z.string(), name: z.string() });

export function validateIpc<T>(schema: z.ZodType<T>, raw: unknown, label: string): T | null {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  devLog('IPC', `payload validation failed for ${label}`, result.error.issues);
  return null;
}
