import { describe, it, expect } from 'vitest';
import { generateCacheKey, MAX_CACHE_SIZE_MB, MAX_CACHE_AGE_DAYS } from '../main/thumbnailCache';

describe('Thumbnail Cache', () => {
  describe('Cache key generation', () => {
    it('generates consistent keys for same inputs', () => {
      const key1 = generateCacheKey('/path/to/file.jpg', 1234567890);
      const key2 = generateCacheKey('/path/to/file.jpg', 1234567890);
      expect(key1).toBe(key2);
    });

    it('generates different keys for different paths', () => {
      const key1 = generateCacheKey('/path/to/file1.jpg', 1234567890);
      const key2 = generateCacheKey('/path/to/file2.jpg', 1234567890);
      expect(key1).not.toBe(key2);
    });

    it('generates different keys for different mtimes', () => {
      const key1 = generateCacheKey('/path/to/file.jpg', 1234567890);
      const key2 = generateCacheKey('/path/to/file.jpg', 1234567891);
      expect(key1).not.toBe(key2);
    });

    it('generates hex string keys', () => {
      const key = generateCacheKey('/test/file.png', 1000);
      expect(key).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe('Data URL validation', () => {
    function isValidDataUrl(dataUrl: string): boolean {
      return /^data:image\/[^;]+;base64,.+$/.test(dataUrl);
    }

    it('validates correct JPEG data URL', () => {
      const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
      expect(isValidDataUrl(dataUrl)).toBe(true);
    });

    it('validates correct PNG data URL', () => {
      const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
      expect(isValidDataUrl(dataUrl)).toBe(true);
    });

    it('rejects invalid data URL format', () => {
      expect(isValidDataUrl('not-a-data-url')).toBe(false);
      expect(isValidDataUrl('data:text/plain;base64,test')).toBe(false);
      expect(isValidDataUrl('data:image/jpeg,nobase64')).toBe(false);
    });

    it('rejects empty data URL', () => {
      expect(isValidDataUrl('')).toBe(false);
    });
  });

  describe('Cache size limits', () => {
    it('has reasonable default max cache size', () => {
      expect(MAX_CACHE_SIZE_MB).toBeGreaterThan(0);
      expect(MAX_CACHE_SIZE_MB).toBeLessThanOrEqual(1000);
    });

    it('has reasonable default max cache age', () => {
      expect(MAX_CACHE_AGE_DAYS).toBeGreaterThan(0);
      expect(MAX_CACHE_AGE_DAYS).toBeLessThanOrEqual(90);
    });

    function shouldEvict(lastAccessTime: number, now: number): boolean {
      const maxAge = MAX_CACHE_AGE_DAYS * 24 * 60 * 60 * 1000;
      return now - lastAccessTime > maxAge;
    }

    it('does not evict recently accessed items', () => {
      const now = Date.now();
      const lastAccess = now - 1000 * 60 * 60;
      expect(shouldEvict(lastAccess, now)).toBe(false);
    });

    it('evicts old items', () => {
      const now = Date.now();
      const lastAccess = now - 1000 * 60 * 60 * 24 * 31;
      expect(shouldEvict(lastAccess, now)).toBe(true);
    });
  });

  describe('Subdirectory hashing', () => {
    function getSubdir(cacheKey: string): string {
      return cacheKey.substring(0, 2);
    }

    it('extracts first 2 characters as subdirectory', () => {
      expect(getSubdir('abcdef123456')).toBe('ab');
      expect(getSubdir('00ff11ee')).toBe('00');
    });

    it('distributes keys across subdirectories', () => {
      const keys = ['aa111111', 'ab222222', 'ba333333', 'bb444444', 'ff555555'];
      const subdirs = new Set(keys.map(getSubdir));
      expect(subdirs.size).toBe(5);
    });
  });
});

describe('Image format support', () => {
  const IMAGE_EXTENSIONS = new Set([
    'jpg',
    'jpeg',
    'png',
    'gif',
    'webp',
    'bmp',
    'ico',
    'tiff',
    'tif',
    'avif',
    'jfif',
    'svg',
  ]);

  const RAW_EXTENSIONS = new Set([
    'cr2',
    'cr3',
    'nef',
    'arw',
    'dng',
    'orf',
    'rw2',
    'pef',
    'srw',
    'raf',
  ]);

  const ANIMATED_IMAGE_EXTENSIONS = new Set(['gif', 'webp', 'apng']);

  it('recognizes common image formats', () => {
    expect(IMAGE_EXTENSIONS.has('jpg')).toBe(true);
    expect(IMAGE_EXTENSIONS.has('png')).toBe(true);
    expect(IMAGE_EXTENSIONS.has('gif')).toBe(true);
    expect(IMAGE_EXTENSIONS.has('webp')).toBe(true);
  });

  it('recognizes RAW camera formats', () => {
    expect(RAW_EXTENSIONS.has('cr2')).toBe(true);
    expect(RAW_EXTENSIONS.has('nef')).toBe(true);
    expect(RAW_EXTENSIONS.has('arw')).toBe(true);
    expect(RAW_EXTENSIONS.has('dng')).toBe(true);
  });

  it('recognizes animated image formats', () => {
    expect(ANIMATED_IMAGE_EXTENSIONS.has('gif')).toBe(true);
    expect(ANIMATED_IMAGE_EXTENSIONS.has('webp')).toBe(true);
    expect(ANIMATED_IMAGE_EXTENSIONS.has('apng')).toBe(true);
  });

  it('does not consider static formats as animated', () => {
    expect(ANIMATED_IMAGE_EXTENSIONS.has('jpg')).toBe(false);
    expect(ANIMATED_IMAGE_EXTENSIONS.has('png')).toBe(false);
    expect(ANIMATED_IMAGE_EXTENSIONS.has('bmp')).toBe(false);
  });

  describe('Extension detection', () => {
    function getExtension(filename: string): string {
      return filename.split('.').pop()?.toLowerCase() || '';
    }

    it('extracts extension from filename', () => {
      expect(getExtension('photo.jpg')).toBe('jpg');
      expect(getExtension('image.PNG')).toBe('png');
      expect(getExtension('file.name.gif')).toBe('gif');
    });

    it('handles files without extension', () => {
      expect(getExtension('README')).toBe('readme');
      expect(getExtension('.gitignore')).toBe('gitignore');
    });
  });
});

describe('Audio waveform generation', () => {
  describe('Waveform data processing', () => {
    function normalizeWaveform(data: number[]): number[] {
      const maxVal = Math.max(...data.map(Math.abs));
      if (maxVal === 0) return data.map(() => 0);
      return data.map((d) => d / maxVal);
    }

    it('normalizes data to -1 to 1 range', () => {
      const data = [0.5, -0.5, 1.0, -1.0, 0];
      const normalized = normalizeWaveform(data);
      normalized.forEach((val) => {
        expect(val).toBeGreaterThanOrEqual(-1);
        expect(val).toBeLessThanOrEqual(1);
      });
    });

    it('handles all zeros', () => {
      const data = [0, 0, 0, 0];
      const normalized = normalizeWaveform(data);
      expect(normalized).toEqual([0, 0, 0, 0]);
    });

    it('preserves relative values', () => {
      const data = [2, 4, 8];
      const normalized = normalizeWaveform(data);
      expect(normalized[0]).toBe(0.25);
      expect(normalized[1]).toBe(0.5);
      expect(normalized[2]).toBe(1);
    });
  });

  describe('Sample reduction', () => {
    function reduceSamples(data: Float32Array, targetSamples: number): number[] {
      const blockSize = Math.floor(data.length / targetSamples);
      const result: number[] = [];

      for (let i = 0; i < targetSamples; i++) {
        const blockStart = blockSize * i;
        let sum = 0;
        for (let j = 0; j < blockSize; j++) {
          sum += Math.abs(data[blockStart + j]);
        }
        result.push(sum / blockSize);
      }

      return result;
    }

    it('reduces large arrays to target size', () => {
      const data = new Float32Array(1000);
      data.fill(0.5);
      const reduced = reduceSamples(data, 100);
      expect(reduced.length).toBe(100);
    });

    it('calculates average amplitude per block', () => {
      const data = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
      const reduced = reduceSamples(data, 2);
      expect(reduced[0]).toBeCloseTo(0.25, 5);
      expect(reduced[1]).toBeCloseTo(0.65, 5);
    });
  });
});

describe('Video thumbnail generation', () => {
  describe('Seek position calculation', () => {
    function getSeekPosition(duration: number): number {
      return Math.min(duration * 0.25, 10);
    }

    it('seeks to 25% for short videos', () => {
      expect(getSeekPosition(20)).toBe(5);
      expect(getSeekPosition(40)).toBe(10);
    });

    it('caps seek position at 10 seconds', () => {
      expect(getSeekPosition(100)).toBe(10);
      expect(getSeekPosition(1000)).toBe(10);
    });

    it('handles very short videos', () => {
      expect(getSeekPosition(1)).toBe(0.25);
      expect(getSeekPosition(0.5)).toBe(0.125);
    });
  });

  describe('Thumbnail dimensions', () => {
    function calculateThumbnailSize(
      videoWidth: number,
      videoHeight: number,
      maxSize: number
    ): { width: number; height: number } {
      const aspectRatio = videoWidth / videoHeight;

      if (videoWidth > videoHeight) {
        return {
          width: Math.min(videoWidth, maxSize),
          height: Math.round(Math.min(videoWidth, maxSize) / aspectRatio),
        };
      } else {
        return {
          width: Math.round(Math.min(videoHeight, maxSize) * aspectRatio),
          height: Math.min(videoHeight, maxSize),
        };
      }
    }

    it('scales landscape video correctly', () => {
      const size = calculateThumbnailSize(1920, 1080, 320);
      expect(size.width).toBe(320);
      expect(size.height).toBe(180);
    });

    it('scales portrait video correctly', () => {
      const size = calculateThumbnailSize(1080, 1920, 320);
      expect(size.width).toBe(180);
      expect(size.height).toBe(320);
    });

    it('preserves aspect ratio', () => {
      const size = calculateThumbnailSize(1920, 1080, 320);
      const originalRatio = 1920 / 1080;
      const thumbnailRatio = size.width / size.height;
      expect(thumbnailRatio).toBeCloseTo(originalRatio, 1);
    });
  });
});
