import { describe, expect, it } from 'vitest';
import {
  EXTRACTABLE_COMPOUND_SUFFIXES,
  isExtractableArchivePath,
  isListableArchivePath,
  supportsExtractPassword,
} from '../archiveFormatCapabilities';
import {
  BACKEND_COMPRESS_METHODS,
  BACKEND_SUPPORTED_OPTIONS,
  COMPRESS_FORMAT_UI,
  getVisibleCompressMethods,
  getVisibleCompressUi,
  type CompressFormat,
} from '../compressFormatCapabilities';

const COMPRESS_FORMATS: CompressFormat[] = ['7z', 'zip', 'tar.gz'];

describe('archive capability audit', () => {
  it('extract routing matches backend support', () => {
    const positive = [
      'a.zip',
      'a.7z',
      'a.tar',
      'a.tar.gz',
      'a.tgz',
      'a.tar.bz2',
      'a.tbz2',
      'a.tar.xz',
      'a.txz',
      'a.gz',
      'a.xz',
    ];
    const negative = ['a.rar', 'a.cab', 'a.iso', 'a.wim', 'readme.txt'];

    for (const path of positive) {
      expect(isExtractableArchivePath(path), path).toBe(true);
    }
    for (const path of negative) {
      expect(isExtractableArchivePath(path), path).toBe(false);
    }
    for (const suffix of EXTRACTABLE_COMPOUND_SUFFIXES) {
      expect(isExtractableArchivePath(`backup${suffix}`)).toBe(true);
    }
  });

  it('lists only extractable archives for preview', () => {
    expect(isListableArchivePath('backup.zip')).toBe(true);
    expect(isListableArchivePath('backup.rar')).toBe(false);
    expect(supportsExtractPassword('secret.7z')).toBe(true);
    expect(supportsExtractPassword('data.tar.gz')).toBe(false);
  });

  it('compress UI visibility matches backend support matrix', () => {
    for (const format of COMPRESS_FORMATS) {
      const ui = getVisibleCompressUi(format);
      const supported = BACKEND_SUPPORTED_OPTIONS[format];

      if (ui.encryption) expect(supported.has('password')).toBe(true);
      if (ui.encryptionMethod) expect(supported.has('encryptionMethod')).toBe(true);
      if (ui.compressionMethod) expect(supported.has('method')).toBe(true);
      if (ui.dictionarySize) expect(supported.has('dictionarySize')).toBe(true);
      if (ui.encryptFileNames) expect(supported.has('encryptFileNames')).toBe(true);

      expect(ui.solidBlockSize).toBe(false);
      expect(ui.cpuThreads).toBe(false);
      expect(ui.splitVolume).toBe(false);

      const visibleMethods = getVisibleCompressMethods(format);
      for (const method of visibleMethods) {
        expect(BACKEND_COMPRESS_METHODS[format]).toContain(method);
      }
      if (ui.compressionMethod) {
        expect(visibleMethods.length).toBeGreaterThanOrEqual(2);
      }

      const docUi = COMPRESS_FORMAT_UI[format];
      if (ui.compressionLevel) expect(docUi.compressionLevel).toBe(true);
    }
  });
});
