// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeMarkdownHtml } from '../shared';

describe('sanitizeMarkdownHtml resource URLs', () => {
  it('removes dangerous href/src protocols', () => {
    const input =
      '<a href="javascript:alert(1)">x</a><img src="data:text/plain,abc"><form action="javascript:alert(1)"></form>';
    const output = sanitizeMarkdownHtml(input);
    expect(output).not.toContain('javascript:');
    expect(output).not.toContain('data:text');
  });

  it('removes remote src URLs', () => {
    const output = sanitizeMarkdownHtml(
      '<img src="https://example.com/x.png"><img src="//example.com/y.png">'
    );
    expect(output).toBe('<img><img>');
  });

  it('keeps relative and trusted asset src URLs', () => {
    const output = sanitizeMarkdownHtml(
      '<img src="./local.png"><img src="/images/a.png"><img src="https://asset.localhost/safe.png"><img src="http://asset.localhost/safe.png">'
    );
    expect(output).toContain('src="./local.png"');
    expect(output).toContain('src="/images/a.png"');
    expect(output).toContain('src="https://asset.localhost/safe.png"');
    expect(output).toContain('src="http://asset.localhost/safe.png"');
  });

  it('removes non-localhost asset scheme src URLs', () => {
    const output = sanitizeMarkdownHtml('<img src="asset:/safe.png">');
    expect(output).toBe('<img>');
  });
});
