import { describe, expect, it } from 'vitest';
import {
  BACKEND_SUPPORTED_OPTIONS,
  getVisibleCompressMethods,
  getVisibleCompressUi,
} from '../compressFormatCapabilities';

describe('compress format capabilities audit', () => {
  it('hides UI fields the backend cannot apply', () => {
    const zipUi = getVisibleCompressUi('zip');
    expect(zipUi.solidBlockSize).toBe(false);
    expect(zipUi.cpuThreads).toBe(false);
    expect(zipUi.splitVolume).toBe(false);
    expect(zipUi.encryption).toBe(true);
    expect(zipUi.encryptionMethod).toBe(true);
    expect(zipUi.dictionarySize).toBe(false);

    const sevenZUi = getVisibleCompressUi('7z');
    expect(sevenZUi.solidBlockSize).toBe(false);
    expect(sevenZUi.cpuThreads).toBe(false);
    expect(sevenZUi.splitVolume).toBe(false);
    expect(sevenZUi.compressionMethod).toBe(false);
    expect(sevenZUi.encryption).toBe(true);
    expect(sevenZUi.encryptFileNames).toBe(true);

    const tarGzUi = getVisibleCompressUi('tar.gz');
    expect(tarGzUi.encryption).toBe(false);
    expect(tarGzUi.compressionMethod).toBe(false);
    expect(tarGzUi.compressionLevel).toBe(true);
  });

  it('exposes only backend-supported zip compression methods', () => {
    expect(getVisibleCompressMethods('zip')).toEqual(['Deflate', 'BZip2', 'LZMA']);
    expect(getVisibleCompressMethods('7z')).toEqual([]);
    expect(getVisibleCompressMethods('tar.gz')).toEqual([]);
  });

  it('matches backend option keys to visible controls', () => {
    expect([...BACKEND_SUPPORTED_OPTIONS.zip]).toEqual(
      expect.arrayContaining(['compressionLevel', 'method', 'password', 'encryptionMethod'])
    );
    expect([...BACKEND_SUPPORTED_OPTIONS['7z']]).toEqual(
      expect.arrayContaining(['compressionLevel', 'dictionarySize', 'password', 'encryptFileNames'])
    );
    expect([...BACKEND_SUPPORTED_OPTIONS['tar.gz']]).toEqual(['compressionLevel']);
  });
});
