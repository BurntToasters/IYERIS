import { describe, it, expect } from 'vitest';
import { parsePath, buildPathFromSegments } from './rendererNavigation';

describe('parsePath', () => {
  describe('Unix paths', () => {
    it('parses a simple Unix path', () => {
      const result = parsePath('/home/user/docs');
      expect(result.segments).toEqual(['home', 'user', 'docs']);
      expect(result.isWindows).toBe(false);
      expect(result.isUnc).toBe(false);
    });

    it('parses root path', () => {
      const result = parsePath('/');
      expect(result.segments).toEqual([]);
      expect(result.isWindows).toBe(false);
    });

    it('parses single-level path', () => {
      const result = parsePath('/usr');
      expect(result.segments).toEqual(['usr']);
    });

    it('filters empty segments', () => {
      const result = parsePath('/home//user///docs');
      expect(result.segments).toEqual(['home', 'user', 'docs']);
    });
  });

  describe('Windows drive paths', () => {
    it('parses a drive path with backslashes', () => {
      const result = parsePath('C:\\Users\\test');
      expect(result.segments).toEqual(['C:', 'Users', 'test']);
      expect(result.isWindows).toBe(true);
      expect(result.isUnc).toBe(false);
    });

    it('parses a drive path with forward slashes', () => {
      const result = parsePath('D:/Documents/notes');
      expect(result.segments).toEqual(['D:', 'Documents', 'notes']);
      expect(result.isWindows).toBe(true);
    });

    it('parses drive root', () => {
      const result = parsePath('C:\\');
      expect(result.segments).toEqual(['C:']);
      expect(result.isWindows).toBe(true);
    });

    it('handles lowercase drive letters', () => {
      const result = parsePath('e:\\data');
      expect(result.segments[0]).toBe('e:');
      expect(result.isWindows).toBe(true);
    });
  });

  describe('UNC paths', () => {
    it('parses a UNC path', () => {
      const result = parsePath('\\\\server\\share\\folder');
      expect(result.segments).toEqual(['server', 'share', 'folder']);
      expect(result.isWindows).toBe(true);
      expect(result.isUnc).toBe(true);
    });

    it('parses minimal UNC path', () => {
      const result = parsePath('\\\\server\\share');
      expect(result.segments).toEqual(['server', 'share']);
      expect(result.isUnc).toBe(true);
    });
  });
});

describe('buildPathFromSegments', () => {
  describe('Unix paths', () => {
    it('builds a Unix path from segments', () => {
      const result = buildPathFromSegments(['home', 'user', 'docs'], 2, false, false);
      expect(result).toBe('/home/user/docs');
    });

    it('builds root-level Unix path', () => {
      const result = buildPathFromSegments(['home'], 0, false, false);
      expect(result).toBe('/home');
    });

    it('returns empty for negative index', () => {
      expect(buildPathFromSegments(['a', 'b'], -1, false, false)).toBe('');
    });
  });

  describe('Windows drive paths', () => {
    it('builds a Windows path', () => {
      const result = buildPathFromSegments(['C:', 'Users', 'test'], 2, true, false);
      expect(result).toBe('C:\\Users\\test');
    });

    it('builds drive root with trailing backslash', () => {
      const result = buildPathFromSegments(['C:'], 0, true, false);
      expect(result).toBe('C:\\');
    });
  });

  describe('UNC paths', () => {
    it('builds a UNC path with subfolder', () => {
      const result = buildPathFromSegments(['server', 'share', 'folder'], 2, true, true);
      expect(result).toBe('\\\\server\\share\\folder');
    });

    it('builds minimal UNC share with trailing backslash', () => {
      const result = buildPathFromSegments(['server', 'share'], 1, true, true);
      expect(result).toBe('\\\\server\\share\\');
    });

    it('builds UNC server only with trailing backslash', () => {
      const result = buildPathFromSegments(['server'], 0, true, true);
      expect(result).toBe('\\\\server\\');
    });
  });

  describe('roundtrip', () => {
    it('parse then build reconstructs Unix path', () => {
      const original = '/home/user/docs';
      const parsed = parsePath(original);
      const rebuilt = buildPathFromSegments(
        parsed.segments,
        parsed.segments.length - 1,
        parsed.isWindows,
        parsed.isUnc
      );
      expect(rebuilt).toBe(original);
    });

    it('parse then build reconstructs Windows path', () => {
      const parsed = parsePath('C:\\Users\\test');
      const rebuilt = buildPathFromSegments(
        parsed.segments,
        parsed.segments.length - 1,
        parsed.isWindows,
        parsed.isUnc
      );
      expect(rebuilt).toBe('C:\\Users\\test');
    });

    it('parse then build reconstructs UNC path', () => {
      const parsed = parsePath('\\\\server\\share\\folder');
      const rebuilt = buildPathFromSegments(
        parsed.segments,
        parsed.segments.length - 1,
        parsed.isWindows,
        parsed.isUnc
      );
      expect(rebuilt).toBe('\\\\server\\share\\folder');
    });
  });
});
