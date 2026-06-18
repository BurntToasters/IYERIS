import { describe, it, expect } from 'vitest';
import {
  RawFileItemSchema,
  RawDriveInfoSchema,
  RawItemPropertiesSchema,
  validateIpc,
} from '../rendererSchemas';

const validFileItem = {
  name: 'a.txt',
  path: '/x/a.txt',
  isDirectory: false,
  isSymlink: false,
  isBrokenSymlink: false,
  isAppBundle: false,
  isShortcut: false,
  isDesktopEntry: false,
  symlinkTarget: null,
  isHidden: false,
  size: 10,
  modified: 1_700_000_000_000,
  created: 1_690_000_000_000,
  extension: 'txt',
  permissions: 420,
  readonly: false,
};

describe('validateIpc + RawFileItemSchema', () => {
  it('parses a valid FileItem payload', () => {
    const v = validateIpc(RawFileItemSchema, validFileItem, 'FileItem');
    expect(v.name).toBe('a.txt');
    expect(v.symlinkTarget).toBeNull();
    expect(v.size).toBe(10);
  });

  it('strips unknown backend keys instead of failing', () => {
    const v = validateIpc(RawFileItemSchema, { ...validFileItem, bogusField: 42 }, 'FileItem');
    expect((v as Record<string, unknown>).bogusField).toBeUndefined();
    expect(v.name).toBe('a.txt');
  });

  it('falls back to the raw payload (non-fatal) on a type mismatch', () => {
    const bad = { ...validFileItem, size: 'huge' };
    const v = validateIpc(RawFileItemSchema, bad, 'FileItem');
    // Non-throwing: returns the raw value so the UI keeps working on drift.
    expect((v as Record<string, unknown>).size).toBe('huge');
  });
});

describe('RawDriveInfoSchema', () => {
  it('parses a valid DriveInfo payload', () => {
    const v = validateIpc(
      RawDriveInfoSchema,
      {
        name: 'Macintosh HD',
        mountPoint: '/',
        totalSpace: 1000,
        availableSpace: 500,
        fsType: 'apfs',
        isRemovable: false,
      },
      'DriveInfo'
    );
    expect(v.mountPoint).toBe('/');
    expect(v.name).toBe('Macintosh HD');
  });
});

describe('RawItemPropertiesSchema', () => {
  it('parses a valid ItemProperties payload with null optionals', () => {
    const v = validateIpc(
      RawItemPropertiesSchema,
      {
        name: 'a.txt',
        path: '/x/a.txt',
        size: 10,
        isDirectory: false,
        isSymlink: false,
        symlinkTarget: null,
        isShortcut: null,
        shortcutTarget: null,
        isHidden: false,
        readonly: false,
        owner: 'dev',
        group: null,
        isHiddenAttr: null,
        isSystemAttr: null,
        macTags: null,
        created: 1,
        modified: 2,
        accessed: 3,
        extension: 'txt',
        permissions: 420,
      },
      'ItemProperties'
    );
    expect(v.owner).toBe('dev');
    expect(v.macTags).toBeNull();
    expect(v.accessed).toBe(3);
  });
});

import {
  RawSearchResultSchema,
  RawArchiveEntrySchema,
  RawFolderSizeSchema,
} from '../rendererSchemas';

describe('RawSearchResultSchema', () => {
  it('parses a SearchResult (FileItem flags absent) with matchContext', () => {
    const v = validateIpc(
      RawSearchResultSchema,
      {
        name: 'a.txt',
        path: '/x/a.txt',
        isDirectory: false,
        size: 5,
        modified: 1700000000000,
        extension: 'txt',
        matchContext: 'line with hit',
      },
      'SearchResult'
    );
    expect(v.matchContext).toBe('line with hit');
    expect(v.size).toBe(5);
  });

  it('accepts a null matchContext (plain search)', () => {
    const v = validateIpc(
      RawSearchResultSchema,
      {
        name: 'd',
        path: '/d',
        isDirectory: true,
        size: 0,
        modified: 1,
        extension: '',
        matchContext: null,
      },
      'SearchResult'
    );
    expect(v.matchContext).toBeNull();
    expect(v.isDirectory).toBe(true);
  });
});

describe('RawArchiveEntrySchema', () => {
  it('parses an archive entry', () => {
    const v = validateIpc(
      RawArchiveEntrySchema,
      { name: 'f', path: 'dir/f', size: 100, isDirectory: false, compressedSize: 40 },
      'ArchiveEntry'
    );
    expect(v.compressedSize).toBe(40);
  });
});

describe('RawFolderSizeSchema', () => {
  it('parses a folder-size result', () => {
    const v = validateIpc(
      RawFolderSizeSchema,
      { totalSize: 2048, fileCount: 3, folderCount: 1 },
      'FolderSize'
    );
    expect(v.totalSize).toBe(2048);
    expect(v.folderCount).toBe(1);
  });
});
