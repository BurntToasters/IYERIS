// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  escapeHtml,
  getErrorMessage,
  setDevMode,
  isDevMode,
  devLog,
  ignoreError,
  assignKey,
  isRecord,
  sanitizeStringArray,
} from '../shared';

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
    expect(escapeHtml('<div class="test">&</div>')).toBe(
      '&lt;div class=&quot;test&quot;&gt;&amp;&lt;/div&gt;'
    );
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

  it('handles XSS attack vectors', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
    expect(escapeHtml('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('handles unicode characters', () => {
    expect(escapeHtml('Hello 世界 🌍')).toBe('Hello 世界 🌍');
  });

  it('handles newlines and tabs', () => {
    expect(escapeHtml('line1\nline2\ttab')).toBe('line1\nline2\ttab');
  });
});

describe('getErrorMessage', () => {
  it('extracts message from Error instance', () => {
    const error = new Error('Something went wrong');
    expect(getErrorMessage(error)).toBe('Something went wrong');
  });

  it('returns string as-is', () => {
    expect(getErrorMessage('An error occurred')).toBe('An error occurred');
  });

  it('converts number to string', () => {
    expect(getErrorMessage(404)).toBe('404');
  });

  it('converts null to string', () => {
    expect(getErrorMessage(null)).toBe('null');
  });

  it('converts undefined to string', () => {
    expect(getErrorMessage(undefined)).toBe('undefined');
  });

  it('converts object to string', () => {
    expect(getErrorMessage({ foo: 'bar' })).toBe('[object Object]');
  });

  it('handles Error subclasses', () => {
    const typeError = new TypeError('Invalid type');
    expect(getErrorMessage(typeError)).toBe('Invalid type');

    const rangeError = new RangeError('Out of range');
    expect(getErrorMessage(rangeError)).toBe('Out of range');
  });

  it('handles empty Error message', () => {
    const error = new Error('');
    expect(getErrorMessage(error)).toBe('');
  });
});

describe('dev mode logging utilities', () => {
  it('enables and disables dev mode', () => {
    setDevMode(true);
    expect(isDevMode()).toBe(true);
    setDevMode(false);
    expect(isDevMode()).toBe(false);
  });

  it('routes devLog to console.debug when enabled', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    setDevMode(true);
    devLog('Search', 'hello');
    expect(debugSpy).toHaveBeenCalledWith('[Search]', 'hello');
    setDevMode(false);
    debugSpy.mockRestore();
  });

  it('ignoreError logs to warn in dev mode', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setDevMode(true);
    ignoreError('ignored');
    expect(warnSpy).toHaveBeenCalledWith('[Ignored error]', 'ignored');
    setDevMode(false);
    warnSpy.mockRestore();
  });

  it('ignoreError uses __iyerisLogger.debug when available outside dev mode', () => {
    setDevMode(false);
    const loggerDebug = vi.fn();
    (globalThis as any).__iyerisLogger = { debug: loggerDebug };
    ignoreError(new Error('boom'));
    expect(loggerDebug).toHaveBeenCalledWith('[Ignored error]', 'boom');
    delete (globalThis as any).__iyerisLogger;
  });
});

describe('shared utility helpers', () => {
  it('assignKey mutates object key', () => {
    const obj = { a: 1, b: 2 };
    assignKey(obj, 'a', 42);
    expect(obj.a).toBe(42);
  });

  it('isRecord accepts plain objects and null-prototype objects', () => {
    expect(isRecord({ x: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it('isRecord rejects arrays, null, and primitives', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('sanitizeStringArray keeps only string entries', () => {
    expect(sanitizeStringArray(['a', 1, 'b', null, 'c'])).toEqual(['a', 'b', 'c']);
    expect(sanitizeStringArray('not-array')).toEqual([]);
  });
});
