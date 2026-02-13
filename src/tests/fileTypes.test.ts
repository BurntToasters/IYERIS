import { describe, it, expect } from 'vitest';

describe('File type detection', () => {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico'];
  const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];
  const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv'];
  const documentExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];
  const codeExtensions = ['.js', '.ts', '.py', '.java', '.c', '.cpp', '.rs', '.go'];
  const archiveExtensions = ['.zip', '.tar', '.gz', '.rar', '.7z', '.bz2'];

  function getFileCategory(
    extension: string
  ): 'image' | 'audio' | 'video' | 'document' | 'code' | 'archive' | 'other' {
    const ext = extension.toLowerCase();
    if (imageExtensions.includes(ext)) return 'image';
    if (audioExtensions.includes(ext)) return 'audio';
    if (videoExtensions.includes(ext)) return 'video';
    if (documentExtensions.includes(ext)) return 'document';
    if (codeExtensions.includes(ext)) return 'code';
    if (archiveExtensions.includes(ext)) return 'archive';
    return 'other';
  }

  describe('getFileCategory', () => {
    it('identifies image files', () => {
      imageExtensions.forEach((ext) => {
        expect(getFileCategory(ext)).toBe('image');
      });
    });

    it('identifies audio files', () => {
      audioExtensions.forEach((ext) => {
        expect(getFileCategory(ext)).toBe('audio');
      });
    });

    it('identifies video files', () => {
      videoExtensions.forEach((ext) => {
        expect(getFileCategory(ext)).toBe('video');
      });
    });

    it('identifies document files', () => {
      documentExtensions.forEach((ext) => {
        expect(getFileCategory(ext)).toBe('document');
      });
    });

    it('identifies code files', () => {
      codeExtensions.forEach((ext) => {
        expect(getFileCategory(ext)).toBe('code');
      });
    });

    it('identifies archive files', () => {
      archiveExtensions.forEach((ext) => {
        expect(getFileCategory(ext)).toBe('archive');
      });
    });

    it('returns other for unknown extensions', () => {
      expect(getFileCategory('.xyz')).toBe('other');
      expect(getFileCategory('.unknown')).toBe('other');
      expect(getFileCategory('')).toBe('other');
    });

    it('handles case insensitivity', () => {
      expect(getFileCategory('.PNG')).toBe('image');
      expect(getFileCategory('.Mp3')).toBe('audio');
      expect(getFileCategory('.ZIP')).toBe('archive');
    });
  });
});

describe('MIME type handling', () => {
  const mimeTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
  };

  function getMimeType(extension: string): string {
    return mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
  }

  it('returns correct MIME types for known extensions', () => {
    expect(getMimeType('.txt')).toBe('text/plain');
    expect(getMimeType('.html')).toBe('text/html');
    expect(getMimeType('.png')).toBe('image/png');
    expect(getMimeType('.pdf')).toBe('application/pdf');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(getMimeType('.xyz')).toBe('application/octet-stream');
    expect(getMimeType('.unknown')).toBe('application/octet-stream');
  });

  it('handles case insensitivity', () => {
    expect(getMimeType('.TXT')).toBe('text/plain');
    expect(getMimeType('.HTML')).toBe('text/html');
  });
});

describe('File name validation', () => {
  const invalidWindowsChars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
  const reservedWindowsNames = [
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'COM2',
    'COM3',
    'COM4',
    'COM5',
    'COM6',
    'COM7',
    'COM8',
    'COM9',
    'LPT1',
    'LPT2',
    'LPT3',
    'LPT4',
    'LPT5',
    'LPT6',
    'LPT7',
    'LPT8',
    'LPT9',
  ];

  function isValidWindowsFileName(name: string): boolean {
    if (!name || name.length === 0) return false;
    if (name.length > 255) return false;
    if (invalidWindowsChars.some((char) => name.includes(char))) return false;
    if (name.endsWith('.') || name.endsWith(' ')) return false;
    const baseName = name.split('.')[0].toUpperCase();
    if (reservedWindowsNames.includes(baseName)) return false;
    return true;
  }

  function isValidUnixFileName(name: string): boolean {
    if (!name || name.length === 0) return false;
    if (name.length > 255) return false;
    if (name.includes('/')) return false;
    if (name.includes('\0')) return false;
    return true;
  }

  describe('isValidWindowsFileName', () => {
    it('accepts valid file names', () => {
      expect(isValidWindowsFileName('document.txt')).toBe(true);
      expect(isValidWindowsFileName('my file.pdf')).toBe(true);
      expect(isValidWindowsFileName('file-name_123.doc')).toBe(true);
    });

    it('rejects empty names', () => {
      expect(isValidWindowsFileName('')).toBe(false);
    });

    it('rejects names with invalid characters', () => {
      invalidWindowsChars.forEach((char) => {
        expect(isValidWindowsFileName(`file${char}name.txt`)).toBe(false);
      });
    });

    it('rejects names ending with dot or space', () => {
      expect(isValidWindowsFileName('file.')).toBe(false);
      expect(isValidWindowsFileName('file ')).toBe(false);
    });

    it('rejects reserved names', () => {
      reservedWindowsNames.forEach((name) => {
        expect(isValidWindowsFileName(name)).toBe(false);
        expect(isValidWindowsFileName(`${name}.txt`)).toBe(false);
      });
    });

    it('rejects names exceeding 255 characters', () => {
      const longName = 'a'.repeat(256);
      expect(isValidWindowsFileName(longName)).toBe(false);
    });
  });

  describe('isValidUnixFileName', () => {
    it('accepts valid file names', () => {
      expect(isValidUnixFileName('document.txt')).toBe(true);
      expect(isValidUnixFileName('file with spaces.pdf')).toBe(true);
      expect(isValidUnixFileName('.hidden')).toBe(true);
      expect(isValidUnixFileName('file:with:colons.txt')).toBe(true);
    });

    it('rejects empty names', () => {
      expect(isValidUnixFileName('')).toBe(false);
    });

    it('rejects names with forward slash', () => {
      expect(isValidUnixFileName('path/file.txt')).toBe(false);
    });

    it('rejects names with null character', () => {
      expect(isValidUnixFileName('file\0name.txt')).toBe(false);
    });

    it('rejects names exceeding 255 characters', () => {
      const longName = 'a'.repeat(256);
      expect(isValidUnixFileName(longName)).toBe(false);
    });

    it('accepts characters that Windows rejects', () => {
      expect(isValidUnixFileName('file<name>.txt')).toBe(true);
      expect(isValidUnixFileName('file|pipe.txt')).toBe(true);
      expect(isValidUnixFileName('file?.txt')).toBe(true);
    });
  });
});

describe('Duplicate file naming', () => {
  function generateUniqueName(baseName: string, existingNames: Set<string>): string {
    if (!existingNames.has(baseName)) return baseName;

    const dotIndex = baseName.lastIndexOf('.');
    const name = dotIndex > 0 ? baseName.substring(0, dotIndex) : baseName;
    const ext = dotIndex > 0 ? baseName.substring(dotIndex) : '';

    let counter = 2;
    let newName = `${name} (${counter})${ext}`;

    while (existingNames.has(newName)) {
      counter++;
      newName = `${name} (${counter})${ext}`;
    }

    return newName;
  }

  it('returns original name if not duplicate', () => {
    const existing = new Set(['other.txt']);
    expect(generateUniqueName('new.txt', existing)).toBe('new.txt');
  });

  it('adds (2) suffix for first duplicate', () => {
    const existing = new Set(['file.txt']);
    expect(generateUniqueName('file.txt', existing)).toBe('file (2).txt');
  });

  it('increments suffix for multiple duplicates', () => {
    const existing = new Set(['file.txt', 'file (2).txt', 'file (3).txt']);
    expect(generateUniqueName('file.txt', existing)).toBe('file (4).txt');
  });

  it('handles files without extension', () => {
    const existing = new Set(['README']);
    expect(generateUniqueName('README', existing)).toBe('README (2)');
  });

  it('handles files with multiple dots', () => {
    const existing = new Set(['archive.tar.gz']);
    expect(generateUniqueName('archive.tar.gz', existing)).toBe('archive.tar (2).gz');
  });

  it('handles empty existing set', () => {
    const existing = new Set<string>();
    expect(generateUniqueName('file.txt', existing)).toBe('file.txt');
  });
});
