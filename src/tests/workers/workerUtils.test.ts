import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isRecord,
  getErrorMessage,
  isCancelled,
  pruneCancelled,
  cancelled,
  normalizePathForCompare,
  normalizeModifiedDate,
  normalizeIndexTimestamp,
  getTextExtensionKey,
  parseDateRange,
  matchesDateRange,
  matchesFilters,
  parseIndexEntry,
  TEXT_FILE_EXTENSIONS,
  FILE_TYPE_EXTENSIONS,
  resetIndexCache,
} from '../../workers/workerUtils';

describe('isRecord', () => {
  it('returns true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('returns false for arrays', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isRecord(42)).toBe(false);
    expect(isRecord('hello')).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });

  it('returns true for Date and other object instances', () => {
    expect(isRecord(new Date())).toBe(true);
  });

  it('returns false for Set and Map (they are objects but also arrays-like)', () => {
    expect(isRecord(new Set())).toBe(true);
    expect(isRecord(new Map())).toBe(true);
  });
});

describe('getErrorMessage', () => {
  it('extracts message from Error instances', () => {
    expect(getErrorMessage(new Error('test error'))).toBe('test error');
  });

  it('converts strings directly', () => {
    expect(getErrorMessage('string error')).toBe('string error');
  });

  it('converts numbers to string', () => {
    expect(getErrorMessage(42)).toBe('42');
  });

  it('converts null to string', () => {
    expect(getErrorMessage(null)).toBe('null');
  });

  it('converts undefined to string', () => {
    expect(getErrorMessage(undefined)).toBe('undefined');
  });

  it('extracts message from Error subclasses', () => {
    expect(getErrorMessage(new TypeError('type err'))).toBe('type err');
  });
});

describe('cancelled map and isCancelled', () => {
  beforeEach(() => {
    cancelled.clear();
  });

  it('returns false for unknown operation ID', () => {
    expect(isCancelled('unknown-id')).toBe(false);
  });

  it('returns true for recently cancelled operation', () => {
    cancelled.set('op1', Date.now());
    expect(isCancelled('op1')).toBe(true);
  });

  it('returns false for undefined operationId', () => {
    expect(isCancelled(undefined)).toBe(false);
  });

  it('returns false for empty string operationId', () => {
    expect(isCancelled('')).toBe(false);
  });

  it('returns false and auto-deletes expired entries', () => {
    cancelled.set('old-op', Date.now() - 11 * 60 * 1000);
    expect(isCancelled('old-op')).toBe(false);
    expect(cancelled.has('old-op')).toBe(false);
  });
});

describe('pruneCancelled', () => {
  beforeEach(() => {
    cancelled.clear();
  });

  it('removes expired entries', () => {
    cancelled.set('expired', Date.now() - 11 * 60 * 1000);
    cancelled.set('recent', Date.now());
    pruneCancelled();
    expect(cancelled.has('expired')).toBe(false);
    expect(cancelled.has('recent')).toBe(true);
  });

  it('handles empty map', () => {
    pruneCancelled();
    expect(cancelled.size).toBe(0);
  });
});

describe('normalizePathForCompare', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('resolves relative paths', () => {
    const result = normalizePathForCompare('some/relative/path');
    expect(result).toContain('some');
    expect(result).toContain('relative');
  });

  it('preserves case on linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const result = normalizePathForCompare('/Home/User/Test');
    expect(result).toBe('/Home/User/Test');
  });

  it('lowercases on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const result = normalizePathForCompare('/Home/User/Test');
    expect(result).toBe(result.toLowerCase());
  });
});

describe('normalizeModifiedDate', () => {
  it('returns same Date instance for Date input', () => {
    const d = new Date('2024-01-15');
    expect(normalizeModifiedDate(d)).toBe(d);
  });

  it('creates Date from numeric timestamp', () => {
    const ts = 1705000000000;
    const result = normalizeModifiedDate(ts);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(ts);
  });

  it('creates Date from string', () => {
    const result = normalizeModifiedDate('2024-01-15');
    expect(result).toBeInstanceOf(Date);
    expect(result.getFullYear()).toBe(2024);
  });

  it('returns epoch for undefined', () => {
    const result = normalizeModifiedDate(undefined);
    expect(result.getTime()).toBe(0);
  });
});

describe('normalizeIndexTimestamp', () => {
  it('returns getTime() for Date instances', () => {
    const d = new Date('2024-06-01');
    expect(normalizeIndexTimestamp(d)).toBe(d.getTime());
  });

  it('returns number for finite numbers', () => {
    expect(normalizeIndexTimestamp(1705000000000)).toBe(1705000000000);
  });

  it('returns null for NaN', () => {
    expect(normalizeIndexTimestamp(NaN)).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(normalizeIndexTimestamp(Infinity)).toBeNull();
    expect(normalizeIndexTimestamp(-Infinity)).toBeNull();
  });

  it('converts numeric strings to numbers', () => {
    expect(normalizeIndexTimestamp('1705000000000')).toBe(1705000000000);
  });

  it('parses date strings', () => {
    const result = normalizeIndexTimestamp('2024-01-15');
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(0);
  });

  it('returns null for non-date strings', () => {
    expect(normalizeIndexTimestamp('not a date')).toBeNull();
  });

  it('returns null for null and undefined', () => {
    expect(normalizeIndexTimestamp(null)).toBeNull();
    expect(normalizeIndexTimestamp(undefined)).toBeNull();
  });

  it('returns null for invalid Date', () => {
    expect(normalizeIndexTimestamp(new Date('invalid'))).toBeNull();
  });
});

describe('getTextExtensionKey', () => {
  it('extracts extension from file path', () => {
    expect(getTextExtensionKey('file.ts')).toBe('ts');
    expect(getTextExtensionKey('/path/to/file.py')).toBe('py');
  });

  it('lowercases extension', () => {
    expect(getTextExtensionKey('FILE.JS')).toBe('js');
  });

  it('returns basename for files without extension', () => {
    expect(getTextExtensionKey('Makefile')).toBe('makefile');
    expect(getTextExtensionKey('/path/to/Makefile')).toBe('makefile');
  });

  it('strips leading dot from dotfiles', () => {
    expect(getTextExtensionKey('.gitignore')).toBe('gitignore');
  });

  it('returns empty string for empty input', () => {
    expect(getTextExtensionKey('')).toBe('');
  });
});

describe('parseDateRange', () => {
  it('parses both dateFrom and dateTo', () => {
    const range = parseDateRange({ dateFrom: '2024-01-01', dateTo: '2024-12-31' });
    expect(range.dateFrom).toBeInstanceOf(Date);
    expect(range.dateTo).toBeInstanceOf(Date);
  });

  it('sets dateTo to end of day (23:59:59)', () => {
    const range = parseDateRange({ dateTo: '2024-06-15' });
    expect(range.dateTo!.getHours()).toBe(23);
    expect(range.dateTo!.getMinutes()).toBe(59);
    expect(range.dateTo!.getSeconds()).toBe(59);
  });

  it('handles only dateFrom', () => {
    const range = parseDateRange({ dateFrom: '2024-01-01' });
    expect(range.dateFrom).toBeInstanceOf(Date);
    expect(range.dateTo).toBeNull();
  });

  it('handles only dateTo', () => {
    const range = parseDateRange({ dateTo: '2024-12-31' });
    expect(range.dateFrom).toBeNull();
    expect(range.dateTo).toBeInstanceOf(Date);
  });

  it('returns null dates when no filters', () => {
    const range = parseDateRange(undefined);
    expect(range.dateFrom).toBeNull();
    expect(range.dateTo).toBeNull();
  });

  it('returns null dates when filters have no dates', () => {
    const range = parseDateRange({});
    expect(range.dateFrom).toBeNull();
    expect(range.dateTo).toBeNull();
  });
});

describe('matchesDateRange', () => {
  it('returns true when within range', () => {
    const range = parseDateRange({ dateFrom: '2024-01-01', dateTo: '2024-12-31' });
    expect(matchesDateRange(new Date('2024-06-15'), range)).toBe(true);
  });

  it('returns false when before dateFrom', () => {
    const range = parseDateRange({ dateFrom: '2024-06-01' });
    expect(matchesDateRange(new Date('2024-01-01'), range)).toBe(false);
  });

  it('returns false when after dateTo', () => {
    const range = parseDateRange({ dateTo: '2024-06-01' });
    expect(matchesDateRange(new Date('2024-12-31'), range)).toBe(false);
  });

  it('returns true with open-ended range (no bounds)', () => {
    const range = { dateFrom: null, dateTo: null };
    expect(matchesDateRange(new Date(), range)).toBe(true);
  });

  it('returns true with only dateFrom set and value is after', () => {
    const range = parseDateRange({ dateFrom: '2024-01-01' });
    expect(matchesDateRange(new Date('2024-06-01'), range)).toBe(true);
  });
});

describe('matchesFilters', () => {
  const now = new Date();
  const stats = { size: 5000, mtime: now };

  it('allows everything with no filters', () => {
    expect(matchesFilters('file.txt', false, stats)).toBe(true);
  });

  it('allows everything with fileType=all', () => {
    expect(matchesFilters('file.txt', false, stats, { fileType: 'all' })).toBe(true);
  });

  it('rejects file when fileType=folder', () => {
    expect(matchesFilters('file.txt', false, stats, { fileType: 'folder' })).toBe(false);
  });

  it('accepts directory when fileType=folder', () => {
    expect(matchesFilters('mydir', true, stats, { fileType: 'folder' })).toBe(true);
  });

  it('rejects directory when fileType=image', () => {
    expect(matchesFilters('mydir', true, stats, { fileType: 'image' })).toBe(false);
  });

  it('accepts .jpg when fileType=image', () => {
    expect(matchesFilters('photo.jpg', false, stats, { fileType: 'image' })).toBe(true);
  });

  it('rejects .txt when fileType=image', () => {
    expect(matchesFilters('notes.txt', false, stats, { fileType: 'image' })).toBe(false);
  });

  it('rejects file below minSize', () => {
    expect(matchesFilters('file.txt', false, { size: 100, mtime: now }, { minSize: 500 })).toBe(
      false
    );
  });

  it('accepts file at minSize', () => {
    expect(matchesFilters('file.txt', false, { size: 500, mtime: now }, { minSize: 500 })).toBe(
      true
    );
  });

  it('rejects file above maxSize', () => {
    expect(matchesFilters('file.txt', false, { size: 10000, mtime: now }, { maxSize: 5000 })).toBe(
      false
    );
  });

  it('applies date range filter', () => {
    const oldDate = new Date('2020-01-01');
    expect(
      matchesFilters('file.txt', false, { size: 100, mtime: oldDate }, { dateFrom: '2024-01-01' })
    ).toBe(false);
  });

  it('combines fileType and size filters', () => {
    expect(
      matchesFilters(
        'photo.jpg',
        false,
        { size: 100, mtime: now },
        {
          fileType: 'image',
          minSize: 500,
        }
      )
    ).toBe(false);
  });
});

describe('parseIndexEntry', () => {
  it('parses array format [path, payload]', () => {
    const result = parseIndexEntry(['/path/file.txt', { name: 'file.txt', size: 100 }]);
    expect(result.filePath).toBe('/path/file.txt');
    expect(result.item).toBeDefined();
    expect(result.item!.name).toBe('file.txt');
  });

  it('parses object format with path property', () => {
    const result = parseIndexEntry({
      path: '/path/file.txt',
      name: 'file.txt',
      isFile: true,
      isDirectory: false,
      size: 200,
    });
    expect(result.filePath).toBe('/path/file.txt');
    expect(result.item).toBeDefined();
  });

  it('returns empty for non-array non-object', () => {
    expect(parseIndexEntry('string')).toEqual({});
    expect(parseIndexEntry(42)).toEqual({});
    expect(parseIndexEntry(null)).toEqual({});
  });

  it('handles array with non-string first element', () => {
    const result = parseIndexEntry([42, { name: 'file' }]);
    expect(result.filePath).toBeUndefined();
    expect(result.item).toBeDefined();
  });

  it('handles array with non-record second element', () => {
    const result = parseIndexEntry(['/path', 'not-an-object']);
    expect(result.filePath).toBe('/path');
    expect(result.item).toBeUndefined();
  });
});

describe('TEXT_FILE_EXTENSIONS', () => {
  it('contains common text extensions', () => {
    expect(TEXT_FILE_EXTENSIONS.has('txt')).toBe(true);
    expect(TEXT_FILE_EXTENSIONS.has('js')).toBe(true);
    expect(TEXT_FILE_EXTENSIONS.has('ts')).toBe(true);
    expect(TEXT_FILE_EXTENSIONS.has('py')).toBe(true);
    expect(TEXT_FILE_EXTENSIONS.has('md')).toBe(true);
    expect(TEXT_FILE_EXTENSIONS.has('json')).toBe(true);
  });

  it('contains shell and config extensions', () => {
    expect(TEXT_FILE_EXTENSIONS.has('sh')).toBe(true);
    expect(TEXT_FILE_EXTENSIONS.has('yaml')).toBe(true);
    expect(TEXT_FILE_EXTENSIONS.has('toml')).toBe(true);
    expect(TEXT_FILE_EXTENSIONS.has('ini')).toBe(true);
  });

  it('does not contain binary extensions', () => {
    expect(TEXT_FILE_EXTENSIONS.has('jpg')).toBe(false);
    expect(TEXT_FILE_EXTENSIONS.has('mp4')).toBe(false);
    expect(TEXT_FILE_EXTENSIONS.has('zip')).toBe(false);
  });
});

describe('FILE_TYPE_EXTENSIONS', () => {
  it('has image category with correct extensions', () => {
    expect(FILE_TYPE_EXTENSIONS['image'].has('jpg')).toBe(true);
    expect(FILE_TYPE_EXTENSIONS['image'].has('png')).toBe(true);
    expect(FILE_TYPE_EXTENSIONS['image'].has('svg')).toBe(true);
  });

  it('has video category with correct extensions', () => {
    expect(FILE_TYPE_EXTENSIONS['video'].has('mp4')).toBe(true);
    expect(FILE_TYPE_EXTENSIONS['video'].has('mkv')).toBe(true);
  });

  it('has audio category', () => {
    expect(FILE_TYPE_EXTENSIONS['audio'].has('mp3')).toBe(true);
    expect(FILE_TYPE_EXTENSIONS['audio'].has('flac')).toBe(true);
  });

  it('has document category', () => {
    expect(FILE_TYPE_EXTENSIONS['document'].has('pdf')).toBe(true);
    expect(FILE_TYPE_EXTENSIONS['document'].has('docx')).toBe(true);
  });

  it('has archive category', () => {
    expect(FILE_TYPE_EXTENSIONS['archive'].has('zip')).toBe(true);
    expect(FILE_TYPE_EXTENSIONS['archive'].has('7z')).toBe(true);
  });
});
