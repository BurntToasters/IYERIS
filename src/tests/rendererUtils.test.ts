import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  isWindowsPath,
  normalizeWindowsPath,
  rendererPath,
  encodeFileUrl,
  getFileDataUrlWithCache,
  clearPreviewDataUrlCache,
  twemojiImg,
} from '../rendererUtils';

beforeAll(() => {
  (globalThis as Record<string, unknown>).window = {
    __TAURI_INTERNALS__: {
      convertFileSrc: (filePath: string, protocol: string) =>
        `${protocol}://localhost/${encodeURIComponent(filePath)}`,
    },
  };
});

let getFileDataUrlMock: ReturnType<typeof vi.fn>;

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

  it('uses backslashes when first segment is a Windows path', () => {
    expect(rendererPath.join('C:\\Users', 'alice', 'docs')).toBe('C:\\Users\\alice\\docs');
  });
});

describe('encodeFileUrl', () => {
  it('encodes Unix path', () => {
    const result = encodeFileUrl('/home/user/file.txt');
    expect(result).toContain('asset');
    expect(result).toContain('localhost');
  });

  it('encodes Windows drive path', () => {
    const result = encodeFileUrl('C:\\Users\\test\\file.txt');
    expect(result).toContain('asset');
    expect(result).toContain('localhost');
  });

  it('encodes UNC path', () => {
    const result = encodeFileUrl('\\\\server\\share\\folder');
    expect(result).toContain('asset');
    expect(result).toContain('localhost');
  });

  it('returns a string for paths with special characters', () => {
    const result = encodeFileUrl('/home/user/my file (1).txt');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns a string for Windows forward-slash paths', () => {
    const result = encodeFileUrl('D:/Documents/notes.txt');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
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
    expect(result).toContain('src="/twemoji/');
  });
});

describe('getFileDataUrlWithCache', () => {
  beforeEach(() => {
    clearPreviewDataUrlCache();
    getFileDataUrlMock = vi.fn(async (filePath: string) => ({
      success: true,
      dataUrl: `data:${filePath}`,
    }));
    (globalThis as any).window.tauriAPI = {
      getFileDataUrl: getFileDataUrlMock,
    };
  });

  it('returns cached value on second lookup', async () => {
    const first = await getFileDataUrlWithCache('/a.txt');
    const second = await getFileDataUrlWithCache('/a.txt');

    expect(first).toBe('data:/a.txt');
    expect(second).toBe('data:/a.txt');
    expect(getFileDataUrlMock).toHaveBeenCalledTimes(1);
  });

  it('returns null for unsuccessful responses', async () => {
    getFileDataUrlMock.mockResolvedValueOnce({ success: false });
    await expect(getFileDataUrlWithCache('/bad.txt')).resolves.toBeNull();
  });

  it('evicts oldest entry after cache limit is exceeded', async () => {
    for (let i = 0; i < 65; i += 1) {
      await getFileDataUrlWithCache(`/file-${i}.txt`);
    }
    expect(getFileDataUrlMock).toHaveBeenCalledTimes(65);

    await getFileDataUrlWithCache('/file-0.txt');
    expect(getFileDataUrlMock).toHaveBeenCalledTimes(66);
  });

  it('clears cache when requested', async () => {
    await getFileDataUrlWithCache('/clear-me.txt');
    clearPreviewDataUrlCache();
    await getFileDataUrlWithCache('/clear-me.txt');

    expect(getFileDataUrlMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes existing key when duplicate requests race', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    getFileDataUrlMock.mockImplementation(async () => {
      await gate;
      return { success: true, dataUrl: 'data:/race.txt' };
    });

    const p1 = getFileDataUrlWithCache('/race.txt');
    const p2 = getFileDataUrlWithCache('/race.txt');
    release();

    await expect(Promise.all([p1, p2])).resolves.toEqual(['data:/race.txt', 'data:/race.txt']);
    expect(getFileDataUrlMock).toHaveBeenCalledTimes(2);
  });
});
