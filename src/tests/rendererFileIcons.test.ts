import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../rendererUtils.js', () => ({
  twemojiImg: (char: string, cls: string) => `<img class="${cls}" data-char="${char}">`,
}));

import {
  getFileExtension,
  getFileTypeFromName,
  formatFileSize,
  getFileIcon,
} from '../rendererFileIcons';

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
});
