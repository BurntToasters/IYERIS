import { describe, it, expect, vi } from 'vitest';

vi.mock('../rendererUtils.js', () => ({
  twemojiImg: vi.fn((char: string, cls: string) => `<img class="${cls}" data-char="${char}">`),
}));

import { twemojiImg } from '../rendererUtils.js';
import {
  getFileExtension,
  getFileTypeFromName,
  formatFileSize,
  getFileIcon,
  IMAGE_ICON,
} from '../rendererFileIcons';

const twemojiImgMock = vi.mocked(twemojiImg);

describe('getFileExtension', () => {
  it('extracts simple extension', () => {
    expect(getFileExtension('photo.jpg')).toBe('jpg');
  });

  it('lowercases extension', () => {
    expect(getFileExtension('FILE.PNG')).toBe('png');
  });

  it('handles multiple dots (returns last)', () => {
    expect(getFileExtension('archive.tar.gz')).toBe('gz');
  });

  it('handles Makefile (returns lowercased name)', () => {
    expect(getFileExtension('Makefile')).toBe('makefile');
  });

  it('returns empty string for empty input', () => {
    expect(getFileExtension('')).toBe('');
  });

  it('handles dotfiles', () => {
    expect(getFileExtension('.gitignore')).toBe('gitignore');
  });

  it('handles single character extension', () => {
    expect(getFileExtension('test.c')).toBe('c');
  });

  it('truncates extremely long extensions to 20 chars', () => {
    expect(getFileExtension(`file.${'a'.repeat(30)}`)).toBe('a'.repeat(20));
  });
});

describe('getFileTypeFromName', () => {
  it('identifies images', () => {
    expect(getFileTypeFromName('photo.jpg')).toBe('Image');
    expect(getFileTypeFromName('icon.png')).toBe('Image');
    expect(getFileTypeFromName('image.webp')).toBe('Image');
  });

  it('identifies RAW images', () => {
    expect(getFileTypeFromName('photo.cr2')).toBe('RAW Image');
    expect(getFileTypeFromName('shot.nef')).toBe('RAW Image');
  });

  it('identifies videos', () => {
    expect(getFileTypeFromName('movie.mp4')).toBe('Video');
    expect(getFileTypeFromName('clip.mkv')).toBe('Video');
  });

  it('identifies audio', () => {
    expect(getFileTypeFromName('song.mp3')).toBe('Audio');
    expect(getFileTypeFromName('music.flac')).toBe('Audio');
  });

  it('identifies PDF documents', () => {
    expect(getFileTypeFromName('report.pdf')).toBe('PDF Document');
  });

  it('identifies Word documents', () => {
    expect(getFileTypeFromName('letter.docx')).toBe('Word Document');
  });

  it('identifies spreadsheets', () => {
    expect(getFileTypeFromName('data.xlsx')).toBe('Spreadsheet');
  });

  it('identifies presentations', () => {
    expect(getFileTypeFromName('slides.pptx')).toBe('Presentation');
  });

  it('identifies archives', () => {
    expect(getFileTypeFromName('backup.zip')).toBe('Archive');
    expect(getFileTypeFromName('data.tar')).toBe('Archive');
  });

  it('identifies source code', () => {
    expect(getFileTypeFromName('app.rs')).toBe('Source Code');
    expect(getFileTypeFromName('main.py')).toBe('Source Code');
    expect(getFileTypeFromName('server.go')).toBe('Source Code');
  });

  it('identifies web files', () => {
    expect(getFileTypeFromName('index.html')).toBe('Web File');
  });

  it('identifies data files', () => {
    expect(getFileTypeFromName('config.json')).toBe('Data File');
    expect(getFileTypeFromName('data.yaml')).toBe('Data File');
  });

  it('identifies text files', () => {
    expect(getFileTypeFromName('notes.txt')).toBe('Text File');
    expect(getFileTypeFromName('README.md')).toBe('Text File');
  });

  it('returns uppercased extension for unknown types', () => {
    expect(getFileTypeFromName('data.xyz')).toBe('XYZ File');
    expect(getFileTypeFromName('file.abc')).toBe('ABC File');
  });

  it('returns Text File for Makefile (matched by text extensions)', () => {
    expect(getFileTypeFromName('Makefile')).toBe('Text File');
  });

  it('returns File for empty extension', () => {
    expect(getFileTypeFromName('')).toBe('File');
    expect(getFileTypeFromName('name.')).toBe('File');
  });

  it('uses truncated extension when building unknown file label', () => {
    const ext20 = 'abcdefghijklmnopqrst';
    expect(getFileTypeFromName(`file.${ext20}uvwxyz`)).toBe(`${ext20.toUpperCase()} File`);
  });
});

describe('formatFileSize', () => {
  it('formats 0 bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('formats bytes range', () => {
    expect(formatFileSize(500)).toBe('500 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('formats kilobytes', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('formats megabytes', () => {
    expect(formatFileSize(1048576)).toBe('1 MB');
    expect(formatFileSize(1572864)).toBe('1.5 MB');
  });

  it('formats gigabytes', () => {
    expect(formatFileSize(1073741824)).toBe('1 GB');
  });

  it('formats terabytes', () => {
    expect(formatFileSize(1099511627776)).toBe('1 TB');
  });

  it('formats fractional sizes with precision', () => {
    const result = formatFileSize(1234567);
    expect(result).toBe('1.18 MB');
  });

  it('returns 0 B for non-finite or negative values', () => {
    expect(formatFileSize(-1)).toBe('0 B');
    expect(formatFileSize(Number.NaN)).toBe('0 B');
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});

describe('getFileIcon', () => {
  it('returns an icon string containing img tag', () => {
    const icon = getFileIcon('photo.jpg');
    expect(icon).toContain('<img');
    expect(icon).toContain('twemoji');
  });

  it('returns consistent results for same extension (caching)', () => {
    const first = getFileIcon('a.txt');
    const second = getFileIcon('b.txt');
    expect(first).toBe(second);
  });

  it('returns different icons for different file types', () => {
    const imageIcon = getFileIcon('photo.jpg');
    const archiveIcon = getFileIcon('backup.zip');
    expect(imageIcon).not.toBe(archiveIcon);
  });

  it('returns default icon for unknown extension', () => {
    const icon = getFileIcon('file.xyzabc');
    expect(icon).toContain('<img');
  });

  it('uses IMAGE_ICON for mapped 1f5bc image codepoint', () => {
    expect(getFileIcon('wallpaper.jpg')).toBe(IMAGE_ICON);
  });

  it('uses twemoji conversion for mapped non-image codepoints', () => {
    const icon = getFileIcon('script.js');
    expect(icon).toContain('data-char="📜"');
  });

  it('uses RAW fallback for unmapped RAW extension', () => {
    expect(getFileIcon('capture.crw')).toBe(getFileIcon('capture.cr2'));
  });

  it('uses image fallback for unmapped image extension', () => {
    expect(getFileIcon('portrait.heic')).toBe(IMAGE_ICON);
  });

  it('uses video and audio fallbacks for unmapped extensions', () => {
    expect(getFileIcon('clip.m4v')).toBe(getFileIcon('clip.mp4'));
    expect(getFileIcon('track.opus')).toBe(getFileIcon('track.mp3'));
  });

  it('uses word and spreadsheet/presentation fallback icons', () => {
    expect(getFileIcon('doc.odt')).toBe(getFileIcon('doc.docx'));
    expect(getFileIcon('sheet.ods')).toBe(getFileIcon('sheet.xlsx'));
    expect(getFileIcon('slides.key')).toBe(getFileIcon('sheet.xlsx'));
  });

  it('uses archive fallback for unmapped archive extension', () => {
    expect(getFileIcon('backup.bz2')).toBe(getFileIcon('backup.zip'));
  });

  it('keeps serving icons when cache grows beyond max size', () => {
    for (let i = 0; i < 320; i += 1) {
      const icon = getFileIcon(`file.cacheext${i}`);
      expect(icon).toContain('<img');
    }
  });

  it('evicts oldest entry when cache exceeds max entries', async () => {
    vi.resetModules();

    const freshIcons = await import('../rendererFileIcons');
    const freshUtils = await import('../rendererUtils.js');
    const freshTwemoji = vi.mocked(freshUtils.twemojiImg);

    const before = freshTwemoji.mock.calls.length;
    freshIcons.getFileIcon('first.java');
    expect(freshTwemoji.mock.calls.length).toBe(before + 1);

    for (let i = 0; i < 300; i += 1) {
      freshIcons.getFileIcon(`f.eviction${i}`);
    }

    const beforeRecompute = freshTwemoji.mock.calls.length;
    freshIcons.getFileIcon('second.java');
    expect(freshTwemoji.mock.calls.length).toBe(beforeRecompute + 1);
  });

  it('tracks twemoji calls from mapped extensions only', () => {
    const before = twemojiImgMock.mock.calls.length;
    getFileIcon('mapped.ts');
    getFileIcon('unknown.zzzzzz');
    expect(twemojiImgMock.mock.calls.length).toBe(before + 1);
  });
});
