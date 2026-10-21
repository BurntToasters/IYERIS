// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { MAX_MARKDOWN_HTML_LENGTH, sanitizeMarkdownHtml } from '../rendererMarkdown';

describe('sanitizeMarkdownHtml resource URLs', () => {
  it('rejects oversized generated HTML before sanitization', async () => {
    await expect(sanitizeMarkdownHtml('x'.repeat(MAX_MARKDOWN_HTML_LENGTH + 1))).rejects.toThrow(
      'Markdown HTML exceeds'
    );
  });

  it('removes dangerous href/src protocols', async () => {
    const input =
      '<a href="javascript:alert(1)">x</a><img src="data:text/plain,abc"><form action="javascript:alert(1)"></form>';
    const output = await sanitizeMarkdownHtml(input);
    expect(output).not.toContain('javascript:');
    expect(output).not.toContain('data:text');
  });

  it('removes remote src URLs', async () => {
    const output = await sanitizeMarkdownHtml(
      '<img src="https://example.com/x.png"><img src="//example.com/y.png">'
    );
    expect(output).toBe('<img><img>');
  });

  it('keeps relative and trusted asset src URLs', async () => {
    const output = await sanitizeMarkdownHtml(
      '<img src="./local.png"><img src="/images/a.png"><img src="https://asset.localhost/safe.png"><img src="http://asset.localhost/safe.png">'
    );
    expect(output).toContain('src="./local.png"');
    expect(output).toContain('src="/images/a.png"');
    expect(output).toContain('src="https://asset.localhost/safe.png"');
    expect(output).toContain('src="http://asset.localhost/safe.png"');
  });

  it('removes non-localhost asset scheme src URLs', async () => {
    const output = await sanitizeMarkdownHtml('<img src="asset:/safe.png">');
    expect(output).toBe('<img>');
  });

  it('removes inline event handlers and style attributes', async () => {
    const output = await sanitizeMarkdownHtml(
      '<a href="https://example.com" onclick="alert(1)" style="color:red">x</a>'
    );
    expect(output).toContain('href="https://example.com"');
    expect(output).not.toContain('onclick=');
    expect(output).not.toContain('style=');
  });

  it('removes unsupported href schemes but keeps # anchors', async () => {
    const output = await sanitizeMarkdownHtml(
      '<a href="ftp://example.com">bad</a><a href="#ok">ok</a>'
    );
    expect(output).toContain('<a>bad</a>');
    expect(output).toContain('<a href="#ok">ok</a>');
  });

  it('strips formaction (M10: attribute XSS vectors)', async () => {
    const output = await sanitizeMarkdownHtml(
      '<button formaction="javascript:alert(1)">x</button>'
    );
    expect(output).not.toContain('formaction');
    expect(output).not.toContain('javascript:');
  });

  it('strips srcset/imagesrcset/background/poster/ping', async () => {
    const output = await sanitizeMarkdownHtml(
      '<img srcset="https://evil.example/x.png 1x"><body background="https://evil.example/b.png"><a ping="https://evil.example/p">x</a>'
    );
    expect(output).not.toContain('srcset');
    expect(output).not.toContain('background=');
    expect(output).not.toContain('ping=');
  });

  it('strips xlink:href (SVG-in-HTML XSS vector)', async () => {
    const output = await sanitizeMarkdownHtml('<a xlink:href="javascript:alert(1)">x</a>');
    expect(output).not.toContain('xlink:href');
    expect(output).not.toContain('javascript:');
  });

  it('strips vbscript: URLs (legacy IE/Edge vector)', async () => {
    const output = await sanitizeMarkdownHtml('<a href="vbscript:msgbox(1)">x</a>');
    expect(output).not.toContain('vbscript:');
  });

  it('strips dangerous tags: AUDIO/VIDEO/SOURCE/PORTAL', async () => {
    const output = await sanitizeMarkdownHtml(
      '<audio src="x"></audio><video src="x"></video><source src="x"><portal src="x"></portal>'
    );
    expect(output).not.toMatch(/<audio/i);
    expect(output).not.toMatch(/<video/i);
    expect(output).not.toMatch(/<source/i);
    expect(output).not.toMatch(/<portal/i);
  });

  it('strips SVG and MathML payload containers', async () => {
    const output = await sanitizeMarkdownHtml(
      '<svg><a xlink:href="javascript:alert(1)">bad</a></svg><math><mi>x</mi></math><p>safe</p>'
    );
    expect(output).not.toMatch(/<svg|<math|javascript:/iu);
    expect(output).toContain('<p>safe</p>');
  });

  it('repairs malformed markup without retaining active attributes', async () => {
    const output = await sanitizeMarkdownHtml(
      '<div><img src="javascript:alert(1)" onerror="alert(2)"><p>kept'
    );
    expect(output).not.toMatch(/javascript:|onerror/iu);
    expect(output).toContain('kept');
  });

  it('strips ONCLICK (case-insensitive event handler match)', async () => {
    const output = await sanitizeMarkdownHtml('<a href="#x" ONCLICK="alert(1)">x</a>');
    expect(output).not.toMatch(/onclick/i);
  });
});
