import { describe, it, expect } from 'vitest';
import { escapeHtml, isPathSafe, isUrlSafe, getErrorMessage } from './security';

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes less than signs', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes greater than signs', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#039;s');
  });

  it('escapes multiple special characters', () => {
    expect(escapeHtml('<div class="test">&</div>')).toBe('&lt;div class=&quot;test&quot;&gt;&amp;&lt;/div&gt;');
  });

  it('handles null input', () => {
    expect(escapeHtml(null)).toBe('');
  });

  it('handles undefined input', () => {
    expect(escapeHtml(undefined)).toBe('');
  });

  it('handles number input', () => {
    expect(escapeHtml(123)).toBe('123');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('returns unchanged string without special characters', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('isPathSafe', () => {
  it('rejects empty string', () => {
    expect(isPathSafe('')).toBe(false);
  });

  it('rejects null-like values', () => {
    expect(isPathSafe(null as unknown as string)).toBe(false);
    expect(isPathSafe(undefined as unknown as string)).toBe(false);
  });

  it('rejects paths with null bytes', () => {
    expect(isPathSafe('/home/user\0/file.txt')).toBe(false);
  });

  it('rejects paths with suspicious characters', () => {
    expect(isPathSafe('/home/user/<script>.txt', 'win32')).toBe(false);
    expect(isPathSafe('/home/user/file>.txt', 'win32')).toBe(false);
    expect(isPathSafe('/home/user/file".txt', 'win32')).toBe(false);
    expect(isPathSafe('/home/user/file|pipe.txt', 'win32')).toBe(false);
    expect(isPathSafe('/home/user/file*.txt', 'win32')).toBe(false);
    expect(isPathSafe('/home/user/file?.txt', 'win32')).toBe(false);
  });

  it('rejects paths with parent directory traversal', () => {
    expect(isPathSafe('/home/user/../../../etc/passwd')).toBe(false);
    expect(isPathSafe('../../etc/passwd')).toBe(false);
    expect(isPathSafe('/home/user/../etc/passwd')).toBe(false);
    expect(isPathSafe('C:\\Users\\..\\Windows', 'win32')).toBe(false);
  });

  it('accepts valid Unix paths', () => {
    expect(isPathSafe('/home/user/documents/file.txt', 'linux')).toBe(true);
    expect(isPathSafe('/Users/test/Desktop', 'darwin')).toBe(true);
  });

  it('accepts valid Windows paths', () => {
    expect(isPathSafe('C:\\Users\\test\\Documents', 'win32')).toBe(true);
    expect(isPathSafe('D:\\Projects\\code.ts', 'win32')).toBe(true);
  });

  it('rejects restricted Windows system paths', () => {
    expect(isPathSafe('C:\\Windows\\System32\\config\\SAM', 'win32')).toBe(false);
    expect(isPathSafe('C:\\Windows\\System32\\config\\SYSTEM', 'win32')).toBe(false);
    expect(isPathSafe('C:\\Windows\\System32\\config\\SECURITY', 'win32')).toBe(false);
  });

  it('rejects Windows device and extended-length paths', () => {
    expect(isPathSafe('\\\\?\\C:\\Windows\\System32', 'win32')).toBe(false);
    expect(isPathSafe('\\\\.\\C:\\Windows\\System32', 'win32')).toBe(false);
  });

  it('rejects Windows alternate data streams', () => {
    expect(isPathSafe('C:\\Users\\test\\file.txt:stream', 'win32')).toBe(false);
    expect(isPathSafe('\\\\server\\share\\file.txt:stream', 'win32')).toBe(false);
  });

  it('rejects Windows reserved device names', () => {
    expect(isPathSafe('C:\\Temp\\CON.txt', 'win32')).toBe(false);
    expect(isPathSafe('C:\\Temp\\LPT1', 'win32')).toBe(false);
  });

  it('rejects Windows names with trailing dots or spaces', () => {
    expect(isPathSafe('C:\\Temp\\badname.', 'win32')).toBe(false);
    expect(isPathSafe('C:\\Temp\\badname ', 'win32')).toBe(false);
  });

  it('accepts paths with spaces', () => {
    expect(isPathSafe('/home/user/my documents/file.txt', 'linux')).toBe(true);
    expect(isPathSafe('C:\\Users\\test\\My Documents\\file.txt', 'win32')).toBe(true);
  });

  it('accepts paths with unicode characters', () => {
    expect(isPathSafe('/home/user/文档/file.txt', 'linux')).toBe(true);
  });

  it('accepts paths containing ".." in names', () => {
    expect(isPathSafe('/home/user/..hidden/file.txt', 'linux')).toBe(true);
    expect(isPathSafe('/home/user/foo..bar/baz.txt', 'linux')).toBe(true);
    expect(isPathSafe('C:\\Users\\test\\..hidden\\file.txt', 'win32')).toBe(true);
  });

  it('accepts characters allowed on Unix', () => {
    expect(isPathSafe('/home/user/file?.txt', 'linux')).toBe(true);
    expect(isPathSafe('/home/user/file*.txt', 'linux')).toBe(true);
    expect(isPathSafe('/home/user/file|pipe.txt', 'linux')).toBe(true);
    expect(isPathSafe('/home/user/file<name>.txt', 'linux')).toBe(true);
    expect(isPathSafe('/home/user/file>name.txt', 'linux')).toBe(true);
  });
});

describe('isUrlSafe', () => {
  it('accepts http URLs', () => {
    expect(isUrlSafe('http://example.com')).toBe(true);
  });

  it('accepts https URLs', () => {
    expect(isUrlSafe('https://example.com/path')).toBe(true);
  });

  it('accepts mailto URLs', () => {
    expect(isUrlSafe('mailto:test@example.com')).toBe(true);
  });

  it('accepts file URLs', () => {
    expect(isUrlSafe('file:///home/user/file.txt')).toBe(true);
  });

  it('rejects javascript URLs', () => {
    expect(isUrlSafe('javascript:alert(1)')).toBe(false);
  });

  it('rejects data URLs', () => {
    expect(isUrlSafe('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(isUrlSafe('not a url')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isUrlSafe('')).toBe(false);
  });
});

describe('getErrorMessage', () => {
  it('extracts message from Error objects', () => {
    expect(getErrorMessage(new Error('test error'))).toBe('test error');
  });

  it('converts strings to string', () => {
    expect(getErrorMessage('string error')).toBe('string error');
  });

  it('converts numbers to string', () => {
    expect(getErrorMessage(404)).toBe('404');
  });

  it('converts objects to string', () => {
    expect(getErrorMessage({ foo: 'bar' })).toBe('[object Object]');
  });

  it('handles null', () => {
    expect(getErrorMessage(null)).toBe('null');
  });

  it('handles undefined', () => {
    expect(getErrorMessage(undefined)).toBe('undefined');
  });
});
