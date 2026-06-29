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
  permissions: z.number(),
});
export type RawItemProperties = z.infer<typeof RawItemPropertiesSchema>;

export const RawSearchResultSchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  size: z.number(),
  modified: z.number(),
  extension: z.string(),
  matchContext: z.string().nullable().optional(),
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

export function validateIpc<T>(schema: z.ZodType<T>, raw: unknown, label: string): T | null {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  devLog('IPC', `payload validation failed for ${label}`, result.error.issues);
  return null;
}
