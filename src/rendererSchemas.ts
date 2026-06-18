import { z } from 'zod';
import { devLog } from './shared.js';

// Runtime schemas for IPC payloads. They mirror the Rust serde structs
// (#[serde(rename_all = "camelCase")]). Unknown keys are stripped (zod default),
// so extra backend fields never fail validation.
//
// Validation is intentionally NON-FATAL: on a mismatch we log the issues (dev)
// and fall back to the raw payload, so backend/field drift becomes a visible
// signal without breaking the UI on data we can't fully exercise here.

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

/**
 * Validate an IPC payload against a schema. Non-fatal: returns parsed data on
 * success, otherwise logs the issues and returns the raw value cast to the
 * schema type (keeps current behavior if the backend shape drifts).
 */
export function validateIpc<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  devLog('IPC', `payload validation failed for ${label}`, result.error.issues);
  return raw as T;
}
