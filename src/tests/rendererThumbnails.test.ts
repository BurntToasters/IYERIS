// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createThumbnailController } from '../rendererThumbnails';

describe('rendererThumbnails dual-root observers', () => {
  const originalIntersectionObserver = globalThis.IntersectionObserver;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="file-view"></div>
      <div id="dual-pane-secondary-list"></div>
    `;
  });

  afterEach(() => {
    if (originalIntersectionObserver) {
      globalThis.IntersectionObserver = originalIntersectionObserver;
    } else {
      delete (
        globalThis as typeof globalThis & { IntersectionObserver?: typeof IntersectionObserver }
      ).IntersectionObserver;
    }
  });

  it('creates isolated observers for primary and secondary roots', () => {
    const roots: Element[] = [];

    class MockIntersectionObserver {
      constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        if (options?.root instanceof Element) {
          roots.push(options.root);
        }
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => [] as IntersectionObserverEntry[]);
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds = [0];
    }

    globalThis.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;

    const controller = createThumbnailController({
      getCurrentSettings: () => ({ thumbnailQuality: 'medium' }) as never,
      getFileIcon: () => 'x',
      getFileExtension: () => 'png',
      formatFileSize: () => '1 B',
      getFileByPath: () => undefined,
    });

    const primaryItem = document.createElement('div');
    primaryItem.className = 'file-item has-thumbnail';
    primaryItem.dataset.path = '/tmp/a.png';
    document.getElementById('file-view')?.appendChild(primaryItem);

    const secondaryItem = document.createElement('div');
    secondaryItem.className = 'file-item has-thumbnail';
    secondaryItem.dataset.path = '/tmp/b.png';
    document.getElementById('dual-pane-secondary-list')?.appendChild(secondaryItem);

    controller.observeThumbnailItem(primaryItem);
    controller.observeThumbnailItem(secondaryItem, 'dual-pane-secondary-list');

    expect(roots).toHaveLength(2);
    expect((roots[0] as HTMLElement).id).toBe('file-view');
    expect((roots[1] as HTMLElement).id).toBe('dual-pane-secondary-list');
  });
});
