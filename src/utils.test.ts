import { describe, it, expect } from 'vitest';
import * as path from 'path';

describe('Path utilities', () => {
  describe('path.basename', () => {
    it('extracts filename from Unix path', () => {
      expect(path.basename('/home/user/document.txt')).toBe('document.txt');
    });

    it('extracts filename from Windows path', () => {
      expect(path.win32.basename('C:\\Users\\test\\file.txt')).toBe('file.txt');
    });

    it('returns empty string for root paths', () => {
      expect(path.basename('/')).toBe('');
    });

    it('handles paths with trailing slashes', () => {
      expect(path.basename('/home/user/')).toBe('user');
    });

    it('extracts extension correctly', () => {
      expect(path.extname('document.txt')).toBe('.txt');
      expect(path.extname('archive.tar.gz')).toBe('.gz');
      expect(path.extname('no-extension')).toBe('');
      expect(path.extname('.gitignore')).toBe('');
    });
  });

  describe('path.dirname', () => {
    it('extracts directory from Unix path', () => {
      expect(path.dirname('/home/user/document.txt')).toBe('/home/user');
    });

    it('extracts directory from Windows path', () => {
      const result = path.win32.dirname('C:\\Users\\test\\file.txt');
      expect(result).toBe('C:\\Users\\test');
    });

    it('returns dot for filename only', () => {
      expect(path.dirname('file.txt')).toBe('.');
    });
  });

  describe('path.join', () => {
    it('joins paths correctly', () => {
      const result = path.join('/home', 'user', 'docs');
      expect(result).toMatch(/home[/\\]user[/\\]docs/);
    });

    it('handles empty segments', () => {
      const result = path.join('/home', '', 'user');
      expect(result).toMatch(/home[/\\]user/);
    });

    it('normalizes slashes', () => {
      const result = path.join('/home/', '/user');
      expect(result).toMatch(/home[/\\]user/);
    });
  });

  describe('path.resolve', () => {
    it('resolves absolute path', () => {
      const result = path.resolve('/home/user');
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('resolves relative to absolute', () => {
      const result = path.resolve('relative', 'path');
      expect(path.isAbsolute(result)).toBe(true);
    });
  });

  describe('path.isAbsolute', () => {
    it('identifies Unix absolute paths', () => {
      expect(path.isAbsolute('/home/user')).toBe(true);
      expect(path.isAbsolute('relative/path')).toBe(false);
    });
  });

  describe('path.normalize', () => {
    it('normalizes paths with double slashes', () => {
      const result = path.normalize('/home//user///docs');
      expect(result).not.toContain('//');
    });

    it('resolves dot segments', () => {
      const result = path.normalize('/home/user/./docs');
      expect(result).not.toContain('/./');
    });
  });
});

describe('String utilities for file operations', () => {
  describe('file extension handling', () => {
    it('correctly identifies common extensions', () => {
      const extensions = ['.txt', '.pdf', '.doc', '.xls', '.png', '.jpg', '.mp3', '.mp4'];
      extensions.forEach((ext) => {
        expect(path.extname(`file${ext}`)).toBe(ext);
      });
    });

    it('handles multiple dots in filename', () => {
      expect(path.extname('file.backup.txt')).toBe('.txt');
      expect(path.extname('archive.tar.gz')).toBe('.gz');
    });

    it('handles no extension', () => {
      expect(path.extname('Makefile')).toBe('');
      expect(path.extname('LICENSE')).toBe('');
    });

    it('handles dotfiles', () => {
      expect(path.extname('.gitignore')).toBe('');
      expect(path.extname('.bashrc')).toBe('');
      expect(path.extname('.config.json')).toBe('.json');
    });
  });

  describe('path splitting', () => {
    it('splits Unix paths correctly', () => {
      const parts = '/home/user/docs/file.txt'.split('/').filter(Boolean);
      expect(parts).toEqual(['home', 'user', 'docs', 'file.txt']);
    });

    it('handles Windows-style paths', () => {
      const parts = 'C:\\Users\\test\\file.txt'.split(/[/\\]/).filter(Boolean);
      expect(parts).toContain('Users');
      expect(parts).toContain('test');
      expect(parts).toContain('file.txt');
    });
  });
});

describe('File size formatting', () => {
  function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  it('formats bytes correctly', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(500)).toBe('500 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('formats kilobytes correctly', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(10240)).toBe('10 KB');
  });

  it('formats megabytes correctly', () => {
    expect(formatFileSize(1048576)).toBe('1 MB');
    expect(formatFileSize(5242880)).toBe('5 MB');
  });

  it('formats gigabytes correctly', () => {
    expect(formatFileSize(1073741824)).toBe('1 GB');
  });

  it('formats terabytes correctly', () => {
    expect(formatFileSize(1099511627776)).toBe('1 TB');
  });
});

describe('Date formatting', () => {
  it('formats dates consistently', () => {
    const date = new Date('2024-06-15T10:30:00');
    const formatted = date.toLocaleDateString();
    expect(typeof formatted).toBe('string');
    expect(formatted.length).toBeGreaterThan(0);
  });

  it('handles date comparison', () => {
    const older = new Date('2024-01-01');
    const newer = new Date('2024-12-31');
    expect(older.getTime()).toBeLessThan(newer.getTime());
  });
});

describe('Array operations for file lists', () => {
  it('sorts file names alphabetically', () => {
    const files = ['zebra.txt', 'alpha.txt', 'beta.txt'];
    const sorted = [...files].sort((a, b) => a.localeCompare(b));
    expect(sorted).toEqual(['alpha.txt', 'beta.txt', 'zebra.txt']);
  });

  it('sorts case-insensitively', () => {
    const files = ['Zebra.txt', 'alpha.txt', 'Beta.txt'];
    const sorted = [...files].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    expect(sorted).toEqual(['alpha.txt', 'Beta.txt', 'Zebra.txt']);
  });

  it('sorts numbers in names correctly', () => {
    const files = ['file10.txt', 'file2.txt', 'file1.txt'];
    const sorted = [...files].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    expect(sorted).toEqual(['file1.txt', 'file2.txt', 'file10.txt']);
  });

  it('filters by extension', () => {
    const files = ['doc.txt', 'image.png', 'data.txt', 'photo.jpg'];
    const txtFiles = files.filter((f) => path.extname(f) === '.txt');
    expect(txtFiles).toEqual(['doc.txt', 'data.txt']);
  });

  it('groups by extension', () => {
    const files = ['a.txt', 'b.png', 'c.txt', 'd.jpg'];
    const grouped = files.reduce(
      (acc, file) => {
        const ext = path.extname(file) || 'none';
        if (!acc[ext]) acc[ext] = [];
        acc[ext].push(file);
        return acc;
      },
      {} as Record<string, string[]>
    );
    expect(grouped['.txt']).toEqual(['a.txt', 'c.txt']);
    expect(grouped['.png']).toEqual(['b.png']);
    expect(grouped['.jpg']).toEqual(['d.jpg']);
  });
});
