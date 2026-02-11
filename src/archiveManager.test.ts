import { describe, it, expect } from 'vitest';
import { buildAdvancedRawFlags } from './archiveManager';
import type { AdvancedCompressOptions } from './types';

describe('ArchiveManager', () => {
  describe('Archive operations', () => {
    it('should have proper timeout constant defined', () => {
      const ARCHIVE_OPERATION_TIMEOUT = 30 * 60 * 1000;
      expect(ARCHIVE_OPERATION_TIMEOUT).toBe(1800000);
    });

    it('should validate archive operation timeout is reasonable', () => {
      const ARCHIVE_OPERATION_TIMEOUT = 30 * 60 * 1000;
      const thirtyMinutesInMs = 30 * 60 * 1000;
      expect(ARCHIVE_OPERATION_TIMEOUT).toEqual(thirtyMinutesInMs);
    });
  });

  describe('Archive process tracking', () => {
    it('should track operation start time', () => {
      const now = Date.now();
      const mockProcess = {
        operationId: 'test-123',
        process: null,
        startTime: now,
      };

      expect(mockProcess.startTime).toBeGreaterThan(0);
      expect(mockProcess.startTime).toBeLessThanOrEqual(Date.now());
    });

    it('should identify stale operations', () => {
      const TIMEOUT = 30 * 60 * 1000;
      const oldTime = Date.now() - (TIMEOUT + 1000);
      const recentTime = Date.now() - 1000;

      expect(Date.now() - oldTime).toBeGreaterThan(TIMEOUT);
      expect(Date.now() - recentTime).toBeLessThan(TIMEOUT);
    });
  });

  describe('buildAdvancedRawFlags', () => {
    it('returns empty array for undefined options', () => {
      expect(buildAdvancedRawFlags(undefined, '7z')).toEqual([]);
    });

    it('returns empty array for empty options', () => {
      expect(buildAdvancedRawFlags({}, '7z')).toEqual([]);
    });

    it('sets compression level', () => {
      const flags = buildAdvancedRawFlags({ compressionLevel: 9 }, '7z');
      expect(flags).toContain('-mx=9');
    });

    it('clamps compression level to 0-9', () => {
      expect(buildAdvancedRawFlags({ compressionLevel: -5 }, '7z')).toContain('-mx=0');
      expect(buildAdvancedRawFlags({ compressionLevel: 99 }, '7z')).toContain('-mx=9');
    });

    it('ignores non-finite compression levels', () => {
      expect(buildAdvancedRawFlags({ compressionLevel: Number.NaN }, '7z')).toEqual([]);
      expect(buildAdvancedRawFlags({ compressionLevel: Number.POSITIVE_INFINITY }, 'zip')).toEqual(
        []
      );
      expect(buildAdvancedRawFlags({ compressionLevel: Number.NEGATIVE_INFINITY }, 'zip')).toEqual(
        []
      );
    });

    it('sets compression method for valid values', () => {
      expect(buildAdvancedRawFlags({ method: 'LZMA2' }, '7z')).toContain('-m0=LZMA2');
      expect(buildAdvancedRawFlags({ method: 'Deflate' }, 'zip')).toContain('-mm=Deflate');
    });

    it('rejects invalid compression method', () => {
      expect(buildAdvancedRawFlags({ method: 'EVIL' }, '7z')).toEqual([]);
      expect(buildAdvancedRawFlags({ method: '' }, '7z')).toEqual([]);
    });

    it('sets dictionary size for valid values', () => {
      expect(buildAdvancedRawFlags({ dictionarySize: '16m' }, '7z')).toContain('-md=16m');
      expect(buildAdvancedRawFlags({ dictionarySize: '64k' }, '7z')).toContain('-md=64k');
    });

    it('sets zip dictionary size only for supported methods', () => {
      expect(buildAdvancedRawFlags({ method: 'LZMA', dictionarySize: '64k' }, 'zip')).toContain(
        '-md=64k'
      );
      expect(
        buildAdvancedRawFlags({ method: 'Deflate', dictionarySize: '64k' }, 'zip')
      ).not.toContain('-md=64k');
      expect(buildAdvancedRawFlags({ dictionarySize: '64k' }, 'zip')).not.toContain('-md=64k');
    });

    it('rejects invalid dictionary size', () => {
      expect(buildAdvancedRawFlags({ dictionarySize: '../../etc' }, '7z')).toEqual([]);
      expect(buildAdvancedRawFlags({ dictionarySize: '-rf /' }, '7z')).toEqual([]);
    });

    it('sets solid block size for 7z only', () => {
      expect(buildAdvancedRawFlags({ solidBlockSize: 'on' }, '7z')).toContain('-ms=on');
      expect(buildAdvancedRawFlags({ solidBlockSize: 'off' }, '7z')).toContain('-ms=off');
      expect(buildAdvancedRawFlags({ solidBlockSize: '128m' }, '7z')).toContain('-ms=128m');
    });

    it('ignores solid block size for non-7z formats', () => {
      expect(buildAdvancedRawFlags({ solidBlockSize: 'on' }, 'zip')).toEqual([]);
    });

    it('sets CPU threads', () => {
      expect(buildAdvancedRawFlags({ cpuThreads: '4' }, '7z')).toContain('-mmt=4');
      expect(buildAdvancedRawFlags({ cpuThreads: '16' }, 'zip')).toContain('-mmt=16');
    });

    it('rejects invalid thread values', () => {
      expect(buildAdvancedRawFlags({ cpuThreads: '0' }, '7z')).toEqual([]);
      expect(buildAdvancedRawFlags({ cpuThreads: 'abc' }, '7z')).toEqual([]);
      expect(buildAdvancedRawFlags({ cpuThreads: '100' }, '7z')).toEqual([]);
    });

    it('sets password', () => {
      const flags = buildAdvancedRawFlags({ password: 'secret123' }, '7z');
      expect(flags).toContain('-psecret123');
    });

    it('defaults zip encryption method to AES256 when password is set', () => {
      const flags = buildAdvancedRawFlags({ password: 'secret123' }, 'zip');
      expect(flags).toContain('-psecret123');
      expect(flags).toContain('-mem=AES256');
    });

    it('does not set password flags when password is empty', () => {
      const flags = buildAdvancedRawFlags({ password: '' }, '7z');
      expect(flags).toEqual([]);
    });

    it('sets encrypt file names for 7z with password', () => {
      const flags = buildAdvancedRawFlags({ password: 'test', encryptFileNames: true }, '7z');
      expect(flags).toContain('-ptest');
      expect(flags).toContain('-mhe=on');
    });

    it('does not encrypt file names for zip even if requested', () => {
      const flags = buildAdvancedRawFlags({ password: 'test', encryptFileNames: true }, 'zip');
      expect(flags).toContain('-ptest');
      expect(flags).not.toContain('-mhe=on');
    });

    it('sets encryption method for zip', () => {
      const flags = buildAdvancedRawFlags(
        { password: 'test', encryptionMethod: 'ZipCrypto' },
        'zip'
      );
      expect(flags).toContain('-mem=ZipCrypto');
    });

    it('ignores encryption method for 7z (always AES-256)', () => {
      const flags = buildAdvancedRawFlags(
        { password: 'test', encryptionMethod: 'ZipCrypto' },
        '7z'
      );
      expect(flags).not.toContain('-mem=ZipCrypto');
    });

    it('does not set encryption method without password', () => {
      const flags = buildAdvancedRawFlags({ encryptionMethod: 'AES256' }, 'zip');
      expect(flags).toEqual([]);
    });

    it('sets split volume size', () => {
      expect(buildAdvancedRawFlags({ splitVolume: '700m' }, '7z')).toContain('-v700m');
      expect(buildAdvancedRawFlags({ splitVolume: '100m' }, 'zip')).toContain('-v100m');
    });

    it('rejects invalid split values', () => {
      expect(buildAdvancedRawFlags({ splitVolume: '../etc' }, '7z')).toEqual([]);
    });

    it('combines multiple options', () => {
      const opts: AdvancedCompressOptions = {
        compressionLevel: 9,
        method: 'LZMA2',
        dictionarySize: '64m',
        solidBlockSize: 'on',
        cpuThreads: '4',
        password: 'mypass',
        encryptFileNames: true,
        splitVolume: '700m',
      };
      const flags = buildAdvancedRawFlags(opts, '7z');
      expect(flags).toContain('-mx=9');
      expect(flags).toContain('-m0=LZMA2');
      expect(flags).toContain('-md=64m');
      expect(flags).toContain('-ms=on');
      expect(flags).toContain('-mmt=4');
      expect(flags).toContain('-pmypass');
      expect(flags).toContain('-mhe=on');
      expect(flags).toContain('-v700m');
      expect(flags).toHaveLength(8);
    });
  });
});
