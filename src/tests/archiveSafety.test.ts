import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AdvancedCompressOptions } from '../types';

vi.mock('../main/platformUtils', () => ({
  get7zipModule: vi.fn(),
  get7zipPath: vi.fn(() => '/usr/bin/7z'),
}));

vi.mock('../main/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { buildAdvancedRawFlags } from '../main/archiveSafety';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildAdvancedRawFlags', () => {
  it('returns empty array for undefined options', () => {
    expect(buildAdvancedRawFlags(undefined, '7z')).toEqual([]);
  });

  it('returns empty array for empty options', () => {
    expect(buildAdvancedRawFlags({}, '7z')).toEqual([]);
  });

  describe('compression level', () => {
    it('adds compression level flag', () => {
      const opts: AdvancedCompressOptions = { compressionLevel: 5 };
      const flags = buildAdvancedRawFlags(opts, '7z');
      expect(flags).toContain('-mx=5');
    });

    it('clamps compression level to 0-9 range', () => {
      expect(buildAdvancedRawFlags({ compressionLevel: -1 }, '7z')).toContain('-mx=0');
      expect(buildAdvancedRawFlags({ compressionLevel: 15 }, '7z')).toContain('-mx=9');
    });

    it('rounds fractional compression levels', () => {
      expect(buildAdvancedRawFlags({ compressionLevel: 3.7 }, '7z')).toContain('-mx=4');
    });

    it('ignores non-finite compression levels', () => {
      expect(buildAdvancedRawFlags({ compressionLevel: NaN }, '7z')).toEqual([]);
      expect(buildAdvancedRawFlags({ compressionLevel: Infinity }, '7z')).toEqual([]);
    });
  });

  describe('compression method', () => {
    it('adds method flag for 7z format', () => {
      const opts: AdvancedCompressOptions = { method: 'LZMA2' };
      const flags = buildAdvancedRawFlags(opts, '7z');
      expect(flags).toContain('-m0=LZMA2');
    });

    it('adds method flag for zip format', () => {
      const opts: AdvancedCompressOptions = { method: 'Deflate' };
      const flags = buildAdvancedRawFlags(opts, 'zip');
      expect(flags).toContain('-mm=Deflate');
    });

    it('rejects unsafe method values', () => {
      const opts: AdvancedCompressOptions = { method: 'evil; rm -rf /' as never };
      const flags = buildAdvancedRawFlags(opts, '7z');
      expect(flags).toEqual([]);
    });

    it('accepts all safe method values', () => {
      const safeMethods = ['LZMA', 'LZMA2', 'PPMd', 'BZip2', 'Deflate', 'Deflate64', 'Copy'];
      for (const method of safeMethods) {
        const flags = buildAdvancedRawFlags(
          { method: method as AdvancedCompressOptions['method'] },
          '7z'
        );
        expect(flags).toContain(`-m0=${method}`);
      }
    });
  });

  describe('dictionary size', () => {
    it('adds dictionary size for 7z', () => {
      const opts: AdvancedCompressOptions = { dictionarySize: '64m' };
      const flags = buildAdvancedRawFlags(opts, '7z');
      expect(flags).toContain('-md=64m');
    });

    it('adds dictionary size for zip only with compatible method', () => {
      const opts: AdvancedCompressOptions = { method: 'LZMA', dictionarySize: '32m' };
      const flags = buildAdvancedRawFlags(opts, 'zip');
      expect(flags).toContain('-md=32m');
    });

    it('does not add dictionary size for zip with incompatible method', () => {
      const opts: AdvancedCompressOptions = { method: 'Deflate', dictionarySize: '32m' };
      const flags = buildAdvancedRawFlags(opts, 'zip');
      expect(flags).not.toContain('-md=32m');
    });

    it('rejects unsafe dictionary size values', () => {
      const opts: AdvancedCompressOptions = { dictionarySize: '64m; echo hacked' };
      const flags = buildAdvancedRawFlags(opts, '7z');
      expect(flags).not.toContain(expect.stringContaining('-md='));
    });
  });

  describe('solid block size', () => {
    it('adds solid block on/off for 7z', () => {
      expect(buildAdvancedRawFlags({ solidBlockSize: 'on' }, '7z')).toContain('-ms=on');
      expect(buildAdvancedRawFlags({ solidBlockSize: 'off' }, '7z')).toContain('-ms=off');
    });

    it('adds numeric solid block size for 7z', () => {
      expect(buildAdvancedRawFlags({ solidBlockSize: '128m' }, '7z')).toContain('-ms=128m');
    });

    it('does not add solid block size for non-7z formats', () => {
      const flags = buildAdvancedRawFlags({ solidBlockSize: 'on' }, 'zip');
      expect(flags).not.toContain(expect.stringContaining('-ms='));
    });
  });

  describe('cpu threads', () => {
    it('adds thread count', () => {
      expect(buildAdvancedRawFlags({ cpuThreads: '4' }, '7z')).toContain('-mmt=4');
    });

    it('rejects unsafe thread values', () => {
      const flags = buildAdvancedRawFlags({ cpuThreads: '4; rm -rf /' }, '7z');
      expect(flags).not.toContain(expect.stringContaining('-mmt='));
    });

    it('rejects zero threads', () => {
      const flags = buildAdvancedRawFlags({ cpuThreads: '0' }, '7z');
      expect(flags).not.toContain(expect.stringContaining('-mmt='));
    });
  });

  describe('password and encryption', () => {
    it('adds password flag', () => {
      const flags = buildAdvancedRawFlags({ password: 'secret' }, '7z');
      expect(flags).toContain('-psecret');
    });

    it('does not add password flag for empty password', () => {
      const flags = buildAdvancedRawFlags({ password: '' }, '7z');
      expect(flags).not.toContain(expect.stringContaining('-p'));
    });

    it('adds encrypt filenames for 7z', () => {
      const flags = buildAdvancedRawFlags({ password: 'secret', encryptFileNames: true }, '7z');
      expect(flags).toContain('-mhe=on');
    });

    it('does not add encrypt filenames for zip', () => {
      const flags = buildAdvancedRawFlags({ password: 'secret', encryptFileNames: true }, 'zip');
      expect(flags).not.toContain('-mhe=on');
    });

    it('adds encryption method for zip with password', () => {
      const flags = buildAdvancedRawFlags(
        { password: 'secret', encryptionMethod: 'AES256' },
        'zip'
      );
      expect(flags).toContain('-mem=AES256');
    });

    it('defaults to AES256 for zip with unknown encryption method', () => {
      const flags = buildAdvancedRawFlags(
        { password: 'secret', encryptionMethod: 'INVALID' as never },
        'zip'
      );
      expect(flags).toContain('-mem=AES256');
    });

    it('accepts ZipCrypto encryption method', () => {
      const flags = buildAdvancedRawFlags(
        { password: 'secret', encryptionMethod: 'ZipCrypto' },
        'zip'
      );
      expect(flags).toContain('-mem=ZipCrypto');
    });
  });

  describe('split volume', () => {
    it('adds split volume flag', () => {
      const flags = buildAdvancedRawFlags({ splitVolume: '100m' }, '7z');
      expect(flags).toContain('-v100m');
    });

    it('rejects unsafe split volume values', () => {
      const flags = buildAdvancedRawFlags({ splitVolume: '100m; echo hacked' }, '7z');
      expect(flags).not.toContain(expect.stringContaining('-v'));
    });
  });

  describe('combined flags', () => {
    it('produces multiple flags from combined options', () => {
      const opts: AdvancedCompressOptions = {
        compressionLevel: 9,
        method: 'LZMA2',
        dictionarySize: '64m',
        cpuThreads: '8',
      };
      const flags = buildAdvancedRawFlags(opts, '7z');
      expect(flags).toContain('-mx=9');
      expect(flags).toContain('-m0=LZMA2');
      expect(flags).toContain('-md=64m');
      expect(flags).toContain('-mmt=8');
    });
  });
});
