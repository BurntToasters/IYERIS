import { describe, it, expect } from 'vitest';
import { escapeHtml, getErrorMessage } from './shared';

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
