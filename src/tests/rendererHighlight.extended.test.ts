// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

describe('loadHighlightJs', () => {
  beforeEach(async () => {
    const { vi } = await import('vitest');
    vi.resetModules();

    document.head.innerHTML = '';
    document.body.innerHTML = '';

    delete (window as Window & { hljs?: unknown }).hljs;
  });

  it('creates a link element and script element when none exist', async () => {
    const { loadHighlightJs } = await import('../rendererHighlight');

    const promise = loadHighlightJs();

    const link = document.querySelector('link[data-highlightjs="theme"]') as HTMLLinkElement;
    expect(link).toBeTruthy();
    expect(link.rel).toBe('stylesheet');
    expect(link.href).toContain('highlight.css');

    const script = document.querySelector('script[data-highlightjs="core"]') as HTMLScriptElement;
    expect(script).toBeTruthy();
    expect(script.src).toContain('highlight.js');

    const fakeHljs = { highlightElement: () => {} };
    (window as Window & { hljs?: unknown }).hljs = fakeHljs;
    script.onload!(new Event('load'));

    const result = await promise;
    expect(result).toBe(fakeHljs);
  });

  it('returns cached hljs on second call', async () => {
    const { loadHighlightJs } = await import('../rendererHighlight');

    const promise1 = loadHighlightJs();
    const script = document.querySelector('script[data-highlightjs="core"]') as HTMLScriptElement;
    const fakeHljs = { highlightElement: () => {} };
    (window as Window & { hljs?: unknown }).hljs = fakeHljs;
    script.onload!(new Event('load'));
    const first = await promise1;

    const second = await loadHighlightJs();
    expect(second).toBe(first);

    const scripts = document.querySelectorAll('script[data-highlightjs="core"]');
    expect(scripts.length).toBe(1);
  });

  it('deduplicates concurrent calls via hljsLoading promise', async () => {
    const { loadHighlightJs } = await import('../rendererHighlight');

    const p1 = loadHighlightJs();
    const p2 = loadHighlightJs();

    const scripts = document.querySelectorAll('script[data-highlightjs="core"]');
    expect(scripts.length).toBe(1);

    const script = scripts[0] as HTMLScriptElement;
    const fakeHljs = { highlightElement: () => {} };
    (window as Window & { hljs?: unknown }).hljs = fakeHljs;
    script.onload!(new Event('load'));

    const r1 = await p1;
    const r2 = await p2;
    expect(r1).toBe(r2);
    expect(r1).toBe(fakeHljs);
  });

  it('resolves null on script error', async () => {
    const { loadHighlightJs } = await import('../rendererHighlight');

    const promise = loadHighlightJs();
    const script = document.querySelector('script[data-highlightjs="core"]') as HTMLScriptElement;

    script.onerror!(new Event('error'));

    const result = await promise;
    expect(result).toBeNull();
  });

  it('does not create duplicate link if one already exists', async () => {
    const existingLink = document.createElement('link');
    existingLink.dataset.highlightjs = 'theme';
    document.head.appendChild(existingLink);

    const { loadHighlightJs } = await import('../rendererHighlight');
    const promise = loadHighlightJs();

    const links = document.querySelectorAll('link[data-highlightjs="theme"]');
    expect(links.length).toBe(1);

    const script = document.querySelector('script[data-highlightjs="core"]') as HTMLScriptElement;
    script.onerror!(new Event('error'));
    await promise;
  });

  it('uses existing script element and resolves from window.hljs if already loaded', async () => {
    const existingScript = document.createElement('script');
    existingScript.dataset.highlightjs = 'core';
    document.head.appendChild(existingScript);

    const fakeHljs = { highlightElement: () => {} };
    (window as Window & { hljs?: unknown }).hljs = fakeHljs;

    const { loadHighlightJs } = await import('../rendererHighlight');
    const result = await loadHighlightJs();
    expect(result).toBe(fakeHljs);

    const scripts = document.querySelectorAll('script[data-highlightjs="core"]');
    expect(scripts.length).toBe(1);
  });

  it('uses existing script and waits for load event when hljs not yet on window', async () => {
    const existingScript = document.createElement('script');
    existingScript.dataset.highlightjs = 'core';
    document.head.appendChild(existingScript);

    const { loadHighlightJs } = await import('../rendererHighlight');
    const promise = loadHighlightJs();

    const fakeHljs = { highlightElement: () => {} };
    (window as Window & { hljs?: unknown }).hljs = fakeHljs;
    existingScript.dispatchEvent(new Event('load'));

    const result = await promise;
    expect(result).toBe(fakeHljs);
  });

  it('uses existing script and resolves null on error event', async () => {
    const existingScript = document.createElement('script');
    existingScript.dataset.highlightjs = 'core';
    document.head.appendChild(existingScript);

    const { loadHighlightJs } = await import('../rendererHighlight');
    const promise = loadHighlightJs();

    existingScript.dispatchEvent(new Event('error'));

    const result = await promise;
    expect(result).toBeNull();
  });

  it('resolves null from window.hljs when hljs is undefined on load', async () => {
    const { loadHighlightJs } = await import('../rendererHighlight');

    const promise = loadHighlightJs();
    const script = document.querySelector('script[data-highlightjs="core"]') as HTMLScriptElement;

    script.onload!(new Event('load'));

    const result = await promise;
    expect(result).toBeNull();
  });
});
