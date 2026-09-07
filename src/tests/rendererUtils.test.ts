import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  isWindowsPath,
  normalizeWindowsPath,
  rendererPath,
  encodeFileUrl,
  getFileDataUrlWithCache,
  clearPreviewDataUrlCache,
  EMOJI_ICON_MAPPINGS,
  PreviewDataUrlCache,
  renderIcon,
  SUPPORTED_ICON_NAMES,
  twemojiImg,
} from '../rendererUtils';
import { FOLDER_ICON_VALUES } from '../constants';
import { FILE_ICON_MAP } from '../fileTypes';

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
  it('preserves UNC roots and normalizes mixed separators', () => {
    expect(rendererPath.join('\\\\server\\share', 'folder/file.zip')).toBe(
      '\\\\server\\share\\folder\\file.zip'
    );
    expect(rendererPath.join('\\\\server\\share\\', 'archive.zip')).toBe(
      '\\\\server\\share\\archive.zip'
    );
  });

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
  it('makes icons decorative by default', () => {
    const result = twemojiImg('📁');
    expect(result).toContain('<svg');
    expect(result).toContain('class="twemoji"');
    expect(result).toContain('aria-hidden="true"');
    expect(result).toContain('focusable="false"');
    expect(result).not.toContain('aria-label=');
  });

  it('uses custom className', () => {
    const result = twemojiImg('📁', 'custom-class');
    expect(result).toContain('class="custom-class"');
  });

  it('uses custom alt text as aria-label', () => {
    const result = twemojiImg('📁', 'twemoji', 'my folder');
    expect(result).toContain('role="img"');
    expect(result).toContain('aria-label="my folder"');
    expect(result).not.toContain('aria-hidden=');
  });

  it('escapes custom alt text in svg attributes', () => {
    const result = twemojiImg('📁', 'twemoji', 'folder" onload="alert(1)');
    expect(result).toContain('aria-label="folder&quot; onload=&quot;alert(1)"');
    expect(result).not.toContain('onload="alert(1)');
  });

  it('handles emoji directly and resolves it to Lucide icon', () => {
    const result = twemojiImg('📁');
    expect(result).toContain('aria-hidden="true"');
    expect(result).toContain('<svg');
  });

  it('renders every registry, file, folder, and emoji-mapped icon', () => {
    const reachableNames = new Set([
      ...FOLDER_ICON_VALUES,
      ...Object.values(FILE_ICON_MAP),
      ...Object.values(EMOJI_ICON_MAPPINGS),
    ]);
    for (const name of reachableNames) {
      expect(SUPPORTED_ICON_NAMES, name).toContain(name);
      expect(renderIcon(name), name).toMatch(/^<svg /);
    }
    for (const name of SUPPORTED_ICON_NAMES) {
      expect(renderIcon(name), name).toMatch(/^<svg /);
    }
    for (const codepoint of Object.keys(EMOJI_ICON_MAPPINGS)) {
      expect(renderIcon(codepoint), codepoint).toMatch(/^<svg /);
    }
  });

  it('falls back to File for unknown names', () => {
    expect(renderIcon('not-a-real-icon')).toBe(renderIcon('file'));
  });
});

describe('getFileDataUrlWithCache', () => {
  const request = (fingerprint = '1:1', maxBytes = 1024) => ({ fingerprint, maxBytes });

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
    const first = await getFileDataUrlWithCache('/a.txt', request());
    const second = await getFileDataUrlWithCache('/a.txt', request());

    expect(first).toBe('data:/a.txt');
    expect(second).toBe('data:/a.txt');
    expect(getFileDataUrlMock).toHaveBeenCalledTimes(1);
  });

  it('returns null for unsuccessful responses', async () => {
    getFileDataUrlMock.mockResolvedValueOnce({ success: false });
    await expect(getFileDataUrlWithCache('/bad.txt', request())).resolves.toBeNull();
  });

  it('evicts oldest entry after cache limit is exceeded', async () => {
    for (let i = 0; i < 65; i += 1) {
      await getFileDataUrlWithCache(`/file-${i}.txt`, request(`${i}:1`));
    }
    expect(getFileDataUrlMock).toHaveBeenCalledTimes(65);

    await getFileDataUrlWithCache('/file-0.txt', request('0:1'));
    expect(getFileDataUrlMock).toHaveBeenCalledTimes(66);
  });

  it('clears cache when requested', async () => {
    await getFileDataUrlWithCache('/clear-me.txt', request());
    clearPreviewDataUrlCache();
    await getFileDataUrlWithCache('/clear-me.txt', request());

    expect(getFileDataUrlMock).toHaveBeenCalledTimes(2);
  });

  it('deduplicates identical in-flight reads', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    getFileDataUrlMock.mockImplementation(async () => {
      await gate;
      return { success: true, dataUrl: 'data:/race.txt' };
    });

    const p1 = getFileDataUrlWithCache('/race.txt', request());
    const p2 = getFileDataUrlWithCache('/race.txt', request());
    release();

    await expect(Promise.all([p1, p2])).resolves.toEqual(['data:/race.txt', 'data:/race.txt']);
    expect(getFileDataUrlMock).toHaveBeenCalledTimes(1);
  });

  it('rejects stale fingerprints and entries from looser limits', async () => {
    await getFileDataUrlWithCache('/changing.txt', request('10:1', 2048));
    await getFileDataUrlWithCache('/changing.txt', request('10:2', 2048));
    await getFileDataUrlWithCache('/changing.txt', request('10:2', 1024));
    expect(getFileDataUrlMock).toHaveBeenCalledTimes(3);
  });

  it('retries after a failed read', async () => {
    getFileDataUrlMock.mockResolvedValueOnce({ success: false });
    await expect(getFileDataUrlWithCache('/retry.txt', request())).resolves.toBeNull();
    await expect(getFileDataUrlWithCache('/retry.txt', request())).resolves.toBe('data:/retry.txt');
    expect(getFileDataUrlMock).toHaveBeenCalledTimes(2);
  });

  it('retries after a rejected read', async () => {
    getFileDataUrlMock.mockRejectedValueOnce(new Error('IPC unavailable'));
    await expect(getFileDataUrlWithCache('/retry-error.txt', request())).rejects.toThrow(
      'IPC unavailable'
    );
    await expect(getFileDataUrlWithCache('/retry-error.txt', request())).resolves.toBe(
      'data:/retry-error.txt'
    );
    expect(getFileDataUrlMock).toHaveBeenCalledTimes(2);
  });

  it('does not repopulate after clear during an in-flight read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    getFileDataUrlMock.mockImplementationOnce(async () => {
      await gate;
      return { success: true, dataUrl: 'data:/pending.txt' };
    });
    const pending = getFileDataUrlWithCache('/pending.txt', request());
    clearPreviewDataUrlCache();
    release();
    await pending;
    await getFileDataUrlWithCache('/pending.txt', request());
    expect(getFileDataUrlMock).toHaveBeenCalledTimes(2);
  });

  it('does not let an older out-of-order read replace the latest fingerprint', async () => {
    let resolveOld!: (value: { success: boolean; dataUrl: string }) => void;
    let resolveNew!: (value: { success: boolean; dataUrl: string }) => void;
    let call = 0;
    getFileDataUrlMock.mockImplementation(
      () =>
        new Promise<{ success: boolean; dataUrl: string }>((resolve) => {
          call += 1;
          if (call === 1) resolveOld = resolve;
          else resolveNew = resolve;
        })
    );

    const oldRead = getFileDataUrlWithCache('/changing.txt', request('10:old'));
    const newRead = getFileDataUrlWithCache('/changing.txt', request('10:new'));
    await vi.waitFor(() => expect(getFileDataUrlMock).toHaveBeenCalledTimes(2));
    resolveNew({ success: true, dataUrl: 'data:new' });
    await expect(newRead).resolves.toBe('data:new');
    resolveOld({ success: true, dataUrl: 'data:old' });
    await expect(oldRead).resolves.toBe('data:old');

    await expect(getFileDataUrlWithCache('/changing.txt', request('10:new'))).resolves.toBe(
      'data:new'
    );
    expect(getFileDataUrlMock).toHaveBeenCalledTimes(2);
  });
});

describe('PreviewDataUrlCache', () => {
  const request = (fingerprint: string, maxBytes = 100) => ({ fingerprint, maxBytes });

  it('evicts by LRU order', () => {
    const cache = new PreviewDataUrlCache(2, 100);
    cache.set('a', 'data:aaaa', request('a'));
    cache.set('b', 'data:bbbb', request('b'));
    expect(cache.get('a', request('a'))).toBe('data:aaaa');
    cache.set('c', 'data:cccc', request('c'));
    expect(cache.get('b', request('b'))).toBeNull();
    expect(cache.get('a', request('a'))).toBe('data:aaaa');
  });

  it('evicts entries to stay inside UTF-16 memory budget', () => {
    const cache = new PreviewDataUrlCache(10, 20);
    cache.set('a', 'data:aaaa', request('a'));
    cache.set('b', 'data:bbbb', request('b'));
    expect(cache.get('a', request('a'))).toBeNull();
    expect(cache.get('b', request('b'))).toBe('data:bbbb');
  });

  it('never caches one entry larger than memory budget', () => {
    const cache = new PreviewDataUrlCache(10, 4);
    cache.set('a', 'data:aaa', request('a'));
    expect(cache.get('a', request('a'))).toBeNull();
  });
});
