/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';

describe('loadHighlightJs', () => {
  beforeEach(async () => {
    // Reset module-level singletons between tests
    const { vi } = await import('vitest');
    vi.resetModules();
    // Clean up DOM
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    // Clean up window.hljs
    delete (window as Window & { hljs?: unknown }).hljs;
  });

  it('creates a link element and script element when none exist', async () => {
    const { loadHighlightJs } = await import('./rendererHighlight');

    // Trigger load — will hang until script onload/onerror fires
    const promise = loadHighlightJs();

    // Check that stylesheet link was created
    const link = document.querySelector('link[data-highlightjs="theme"]') as HTMLLinkElement;
    expect(link).toBeTruthy();
    expect(link.rel).toBe('stylesheet');
    expect(link.href).toContain('highlight.css');

    // Check that script was created
    const script = document.querySelector('script[data-highlightjs="core"]') as HTMLScriptElement;
    expect(script).toBeTruthy();
    expect(script.src).toContain('highlight.js');

    // Simulate script load with window.hljs set
    const fakeHljs = { highlightElement: () => {} };
    (window as Window & { hljs?: unknown }).hljs = fakeHljs;
    script.onload!(new Event('load'));

    const result = await promise;
    expect(result).toBe(fakeHljs);
  });

  it('returns cached hljs on second call', async () => {
    const { loadHighlightJs } = await import('./rendererHighlight');

    const promise1 = loadHighlightJs();
    const script = document.querySelector('script[data-highlightjs="core"]') as HTMLScriptElement;
    const fakeHljs = { highlightElement: () => {} };
    (window as Window & { hljs?: unknown }).hljs = fakeHljs;
    script.onload!(new Event('load'));
    const first = await promise1;

    // Second call should return cached value
    const second = await loadHighlightJs();
    expect(second).toBe(first);

    // No new script elements should have been created
    const scripts = document.querySelectorAll('script[data-highlightjs="core"]');
    expect(scripts.length).toBe(1);
  });

  it('deduplicates concurrent calls via hljsLoading promise', async () => {
    const { loadHighlightJs } = await import('./rendererHighlight');

    const p1 = loadHighlightJs();
    const p2 = loadHighlightJs();

    // Only one script should exist (second call reused hljsLoading)
    const scripts = document.querySelectorAll('script[data-highlightjs="core"]');
    expect(scripts.length).toBe(1);

    // Resolve it
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
    const { loadHighlightJs } = await import('./rendererHighlight');

    const promise = loadHighlightJs();
    const script = document.querySelector('script[data-highlightjs="core"]') as HTMLScriptElement;

    script.onerror!(new Event('error'));

    const result = await promise;
    expect(result).toBeNull();
  });

  it('does not create duplicate link if one already exists', async () => {
    // Pre-create theme link
    const existingLink = document.createElement('link');
    existingLink.dataset.highlightjs = 'theme';
    document.head.appendChild(existingLink);

    const { loadHighlightJs } = await import('./rendererHighlight');
    const promise = loadHighlightJs();

    const links = document.querySelectorAll('link[data-highlightjs="theme"]');
    expect(links.length).toBe(1);

    // Resolve
    const script = document.querySelector('script[data-highlightjs="core"]') as HTMLScriptElement;
    script.onerror!(new Event('error'));
    await promise;
  });

  it('uses existing script element and resolves from window.hljs if already loaded', async () => {
    // Pre-create script element
    const existingScript = document.createElement('script');
    existingScript.dataset.highlightjs = 'core';
    document.head.appendChild(existingScript);

    // Pre-set window.hljs (script already loaded)
    const fakeHljs = { highlightElement: () => {} };
    (window as Window & { hljs?: unknown }).hljs = fakeHljs;

    const { loadHighlightJs } = await import('./rendererHighlight');
    const result = await loadHighlightJs();
    expect(result).toBe(fakeHljs);

    // No new script should have been created
    const scripts = document.querySelectorAll('script[data-highlightjs="core"]');
    expect(scripts.length).toBe(1);
  });

  it('uses existing script and waits for load event when hljs not yet on window', async () => {
    // Pre-create script element without window.hljs yet
    const existingScript = document.createElement('script');
    existingScript.dataset.highlightjs = 'core';
    document.head.appendChild(existingScript);

    const { loadHighlightJs } = await import('./rendererHighlight');
    const promise = loadHighlightJs();

    // Simulate script load
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

    const { loadHighlightJs } = await import('./rendererHighlight');
    const promise = loadHighlightJs();

    existingScript.dispatchEvent(new Event('error'));

    const result = await promise;
    expect(result).toBeNull();
  });

  it('resolves null from window.hljs when hljs is undefined on load', async () => {
    const { loadHighlightJs } = await import('./rendererHighlight');

    const promise = loadHighlightJs();
    const script = document.querySelector('script[data-highlightjs="core"]') as HTMLScriptElement;

    // Don't set window.hljs — onload resolves with (window.hljs || null) = null
    script.onload!(new Event('load'));

    const result = await promise;
    expect(result).toBeNull();
  });
});
