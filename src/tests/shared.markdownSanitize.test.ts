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

  it('removes inline event handlers and style attributes', () => {
    const output = sanitizeMarkdownHtml(
      '<a href="https://example.com" onclick="alert(1)" style="color:red">x</a>'
    );
    expect(output).toContain('href="https://example.com"');
    expect(output).not.toContain('onclick=');
    expect(output).not.toContain('style=');
  });

  it('removes unsupported href schemes but keeps # anchors', () => {
    const output = sanitizeMarkdownHtml('<a href="ftp://example.com">bad</a><a href="#ok">ok</a>');
    expect(output).toContain('<a>bad</a>');
    expect(output).toContain('<a href="#ok">ok</a>');
  });

  it('strips formaction (M10: attribute XSS vectors)', () => {
    const output = sanitizeMarkdownHtml('<button formaction="javascript:alert(1)">x</button>');
    expect(output).not.toContain('formaction');
    expect(output).not.toContain('javascript:');
  });

  it('strips srcset/imagesrcset/background/poster/ping', () => {
    const output = sanitizeMarkdownHtml(
      '<img srcset="https://evil.example/x.png 1x"><body background="https://evil.example/b.png"><a ping="https://evil.example/p">x</a>'
    );
    expect(output).not.toContain('srcset');
    expect(output).not.toContain('background=');
    expect(output).not.toContain('ping=');
  });

  it('strips xlink:href (SVG-in-HTML XSS vector)', () => {
    const output = sanitizeMarkdownHtml('<a xlink:href="javascript:alert(1)">x</a>');
    expect(output).not.toContain('xlink:href');
    expect(output).not.toContain('javascript:');
  });

  it('strips vbscript: URLs (legacy IE/Edge vector)', () => {
    const output = sanitizeMarkdownHtml('<a href="vbscript:msgbox(1)">x</a>');
    expect(output).not.toContain('vbscript:');
  });

  it('strips dangerous tags: AUDIO/VIDEO/SOURCE/PORTAL', () => {
    const output = sanitizeMarkdownHtml(
      '<audio src="x"></audio><video src="x"></video><source src="x"><portal src="x"></portal>'
    );
    expect(output).not.toMatch(/<audio/i);
    expect(output).not.toMatch(/<video/i);
    expect(output).not.toMatch(/<source/i);
    expect(output).not.toMatch(/<portal/i);
  });

  it('strips ONCLICK (case-insensitive event handler match)', () => {
    const output = sanitizeMarkdownHtml('<a href="#x" ONCLICK="alert(1)">x</a>');
    expect(output).not.toMatch(/onclick/i);
  });
});
