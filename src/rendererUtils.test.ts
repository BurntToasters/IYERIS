import { describe, it, expect } from 'vitest';
import {
  isWindowsPath,
  normalizeWindowsPath,
  rendererPath,
  encodeFileUrl,
  twemojiImg,
} from './rendererUtils';

describe('isWindowsPath', () => {
  it('recognises drive letter paths', () => {
    expect(isWindowsPath('C:\\')).toBe(true);
    expect(isWindowsPath('D:/folder')).toBe(true);
    expect(isWindowsPath('z:\\file.txt')).toBe(true);
  });

  it('recognises UNC paths', () => {
    expect(isWindowsPath('\\\\server\\share')).toBe(true);
  });

  it('rejects Unix paths', () => {
    expect(isWindowsPath('/home/user')).toBe(false);
    expect(isWindowsPath('/tmp')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isWindowsPath('')).toBe(false);
  });

  it('rejects bare drive letter without separator', () => {
    expect(isWindowsPath('C:')).toBe(false);
  });
});

describe('normalizeWindowsPath', () => {
  it('converts forward slashes to backslashes', () => {
    expect(normalizeWindowsPath('C:/Users/test')).toBe('C:\\Users\\test');
  });

  it('preserves existing backslashes', () => {
    expect(normalizeWindowsPath('C:\\Users\\test')).toBe('C:\\Users\\test');
  });

  it('handles mixed separators', () => {
    expect(normalizeWindowsPath('C:\\Users/Mixed/path\\file')).toBe('C:\\Users\\Mixed\\path\\file');
  });

  it('handles empty string', () => {
    expect(normalizeWindowsPath('')).toBe('');
  });
});

describe('rendererPath.basename', () => {
  it('extracts filename from Unix path', () => {
    expect(rendererPath.basename('/home/user/file.txt')).toBe('file.txt');
  });

  it('extracts filename from Windows path', () => {
    expect(rendererPath.basename('C:\\Users\\file.txt')).toBe('file.txt');
  });

  it('strips extension when provided', () => {
    expect(rendererPath.basename('/path/file.txt', '.txt')).toBe('file');
  });

  it('does not strip non-matching extension', () => {
    expect(rendererPath.basename('/path/file.txt', '.md')).toBe('file.txt');
  });

  it('returns empty string for empty input', () => {
    expect(rendererPath.basename('')).toBe('');
  });

  it('returns last segment when trailing slash', () => {
    expect(rendererPath.basename('/path/dir/')).toBe('');
  });

  it('handles filename only', () => {
    expect(rendererPath.basename('readme.md')).toBe('readme.md');
  });
});

describe('rendererPath.dirname', () => {
  it('returns parent for Unix path', () => {
    expect(rendererPath.dirname('/home/user/file.txt')).toBe('/home/user');
  });

  it('returns root for root-level file', () => {
    expect(rendererPath.dirname('/file.txt')).toBe('/');
  });

  it('returns root for root itself', () => {
    expect(rendererPath.dirname('/')).toBe('/');
  });

  it('returns drive root for Windows root-level file', () => {
    expect(rendererPath.dirname('C:\\file.txt')).toBe('C:\\');
  });

  it('returns drive root for drive root itself', () => {
    expect(rendererPath.dirname('C:\\')).toBe('C:\\');
  });

  it('returns parent for Windows nested path', () => {
    expect(rendererPath.dirname('C:\\Users\\test\\file.txt')).toBe('C:\\Users\\test');
  });

  it('handles UNC paths with share only', () => {
    const result = rendererPath.dirname('\\\\server\\share');
    expect(result).toBe('\\\\server\\share\\');
  });

  it('handles UNC paths with subfolder', () => {
    expect(rendererPath.dirname('\\\\server\\share\\folder')).toBe('\\\\server\\share');
  });

  it('strips trailing slashes for Unix paths', () => {
    expect(rendererPath.dirname('/home/user/')).toBe('/home');
  });
});

describe('rendererPath.extname', () => {
  it('returns extension including dot', () => {
    expect(rendererPath.extname('/path/file.txt')).toBe('.txt');
  });

  it('returns last extension for multiple dots', () => {
    expect(rendererPath.extname('archive.tar.gz')).toBe('.gz');
  });

  it('returns empty for no extension', () => {
    expect(rendererPath.extname('/path/Makefile')).toBe('');
  });

  it('returns extension for dotfiles', () => {
    expect(rendererPath.extname('.gitignore')).toBe('.gitignore');
  });

  it('returns empty for empty string', () => {
    expect(rendererPath.extname('')).toBe('');
  });
});

describe('rendererPath.join', () => {
  it('joins segments with forward slash', () => {
    expect(rendererPath.join('a', 'b', 'c')).toBe('a/b/c');
  });

  it('collapses multiple slashes', () => {
    expect(rendererPath.join('a/', '/b/', '/c')).toBe('a/b/c');
  });

  it('handles single segment', () => {
    expect(rendererPath.join('hello')).toBe('hello');
  });

  it('preserves leading slash', () => {
    expect(rendererPath.join('/home', 'user')).toBe('/home/user');
  });
});

describe('encodeFileUrl', () => {
  it('encodes Unix path', () => {
    expect(encodeFileUrl('/home/user/file.txt')).toBe('file:////home/user/file.txt');
  });

  it('encodes Windows drive path', () => {
    const result = encodeFileUrl('C:\\Users\\test\\file.txt');
    expect(result).toBe('file:///C:/Users/test/file.txt');
  });

  it('encodes UNC path', () => {
    const result = encodeFileUrl('\\\\server\\share\\folder');
    expect(result).toBe('file://server/share/folder');
  });

  it('encodes special characters in path segments', () => {
    const result = encodeFileUrl('/home/user/my file (1).txt');
    expect(result).toContain('my%20file%20(1).txt');
  });

  it('preserves forward slash structure for Windows paths', () => {
    const result = encodeFileUrl('D:/Documents/notes.txt');
    expect(result).toBe('file:///D:/Documents/notes.txt');
  });
});

describe('twemojiImg', () => {
  it('returns img tag with correct codepoint', () => {
    const result = twemojiImg('😀');
    expect(result).toContain('1f600.svg');
    expect(result).toContain('class="twemoji"');
    expect(result).toContain('draggable="false"');
  });

  it('uses custom className', () => {
    const result = twemojiImg('😀', 'custom-class');
    expect(result).toContain('class="custom-class"');
  });

  it('uses custom alt text', () => {
    const result = twemojiImg('😀', 'twemoji', 'grinning face');
    expect(result).toContain('alt="grinning face"');
  });

  it('escapes alt text for XSS safety', () => {
    const result = twemojiImg('😀', 'twemoji', '<script>alert(1)</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('uses emoji as default alt text', () => {
    const result = twemojiImg('📁');
    expect(result).toContain('alt="📁"');
  });

  it('generates correct src path', () => {
    const result = twemojiImg('⚠');
    expect(result).toContain('src="../assets/twemoji/');
  });
});
