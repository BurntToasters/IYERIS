// @vitest-environment jsdom
//
// F1 (composition layer): rendererElements.ts resolves every DOM handle the app
// needs at module load. Every other suite hand-builds its own DOM fixture, so a
// renamed or removed id in the shipped src/index.html would break the real app
// while leaving all of those fixtures green. These tests assert the contract
// against the actual index.html that ships in the bundle.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INDEX_HTML_PATH = resolve(process.cwd(), 'src/index.html');
const ELEMENTS_SRC_PATH = resolve(process.cwd(), 'src/rendererElements.ts');

/** Inner HTML of the shipped index.html <body>. */
function readRealIndexBody(): string {
  const html = readFileSync(INDEX_HTML_PATH, 'utf8');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!body) throw new Error('src/index.html has no <body> element');
  return body[1];
}

/** Every id passed to requireElement() in rendererElements.ts. */
function readRequiredElementIds(): string[] {
  const src = readFileSync(ELEMENTS_SRC_PATH, 'utf8');
  return [...src.matchAll(/requireElement<[^>]*>\('([^']+)'\)/g)].map((match) => match[1]);
}

function mountRealIndexBody(): void {
  document.body.innerHTML = readRealIndexBody();
}

describe('rendererElements DOM contract', () => {
  let elements: typeof import('../rendererElements');
  let requiredIds: string[];

  beforeAll(async () => {
    mountRealIndexBody();
    requiredIds = readRequiredElementIds();
    elements = await import('../rendererElements');
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a meaningful set of required ids from rendererElements.ts', () => {
    // Guards the regex above: every requireElement() call must yield exactly one
    // exported element handle, so a parse that silently matches nothing fails here.
    const exportedElementCount = Object.values(elements).filter(
      (value) => value instanceof HTMLElement
    ).length;
    expect(requiredIds.length).toBe(exportedElementCount);
    expect(requiredIds.length).toBeGreaterThan(30);
    expect(new Set(requiredIds).size).toBe(requiredIds.length);
    expect(requiredIds).toContain('file-grid');
    expect(requiredIds).toContain('address-input');
  });

  it('the shipped index.html defines every element requireElement() demands', () => {
    const missing = requiredIds.filter((id) => document.getElementById(id) === null);
    expect(missing).toEqual([]);
  });

  it('resolves every exported handle to a node that is still in the document', () => {
    const detached = Object.entries(elements)
      .filter(([, value]) => value instanceof HTMLElement)
      .filter(([, value]) => !document.contains(value as HTMLElement))
      .map(([key]) => key);
    expect(detached).toEqual([]);
  });

  it('exposes the handles the renderer and wiring import by name', () => {
    expect(elements.addressInput).toBeInstanceOf(HTMLInputElement);
    expect(elements.fileGrid.id).toBe('file-grid');
    expect(elements.fileView.id).toBe('file-view');
    expect(elements.columnView.id).toBe('column-view');
    expect(elements.loading.id).toBe('loading');
    expect(elements.loadingText.id).toBe('loading-text');
    expect(elements.emptyState.id).toBe('empty-state');
    expect(elements.folderTree.id).toBe('folder-tree');
    expect(elements.drivesList.id).toBe('drives-list');
    expect(typeof elements.announceToScreenReader).toBe('function');
  });

  it('marks the file grid as an accessible listbox at load time', () => {
    expect(elements.fileGrid.getAttribute('role')).toBe('listbox');
    expect(elements.fileGrid.getAttribute('aria-label')).toBe('File list');
  });

  it('publishes screen-reader announcements into the live region', async () => {
    const liveRegion = document.getElementById('sr-announcements');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.getAttribute('aria-live')).toBe('polite');

    liveRegion!.textContent = 'stale';
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return 1;
    });

    elements.announceToScreenReader('3 items selected');
    // Cleared synchronously so assistive tech re-reads an identical message.
    expect(liveRegion!.textContent).toBe('');

    frames.forEach((frame) => frame(0));
    expect(liveRegion!.textContent).toBe('3 items selected');
  });

  it('fails loudly and names the element when the DOM contract is broken', async () => {
    // Detach one required element from the DOM already mounted in beforeAll rather
    // than re-parsing the 181KB index.html: two extra parses here pushed this test
    // past the default 5s timeout when the whole suite runs in parallel.
    const fileGrid = document.getElementById('file-grid')!;
    const parent = fileGrid.parentElement!;
    const nextSibling = fileGrid.nextSibling;
    fileGrid.remove();

    vi.resetModules();
    try {
      await expect(import('../rendererElements')).rejects.toThrow(
        /Missing required DOM element: #file-grid/
      );
    } finally {
      parent.insertBefore(fileGrid, nextSibling);
      vi.resetModules();
    }
  });
});
