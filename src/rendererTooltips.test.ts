/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./rendererDom.js', () => ({
  getById: (id: string) => document.getElementById(id),
}));

import { initTooltipSystem } from './rendererTooltips.js';

describe('rendererTooltips', () => {
  let errorHandler: (e: ErrorEvent) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    // Suppress uncaught exceptions from leaking listeners
    errorHandler = (e: ErrorEvent) => {
      e.preventDefault();
    };
    window.addEventListener('error', errorHandler);
    // Mock requestAnimationFrame
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    };
  });

  afterEach(() => {
    window.removeEventListener('error', errorHandler);
    vi.useRealTimers();
  });

  it('does nothing when tooltip element is missing', () => {
    document.body.innerHTML = '';
    initTooltipSystem();
    // no error
  });

  describe('with tooltip DOM', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div id="ui-tooltip" class="ui-tooltip" style="display:none">
          <span class="ui-tooltip-content"></span>
        </div>
        <button id="test-btn" title="Test tooltip">Click me</button>
        <div class="tour-tooltip"><button id="tour-btn" title="Tour tip">Tour</button></div>
        <div class="command-palette-modal"><button id="palette-btn" title="Palette tip">CMD</button></div>
        <div id="parent-with-title" title="Parent tooltip">
          <span id="child-no-title">child</span>
        </div>
      `;
      initTooltipSystem();
    });

    it('shows tooltip on mouseover with delay', () => {
      const btn = document.getElementById('test-btn')!;
      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: btn });
      document.dispatchEvent(event);

      expect(btn.getAttribute('title')).toBeNull();
      expect(btn.dataset.originalTitle).toBe('Test tooltip');

      const tooltip = document.getElementById('ui-tooltip')!;
      expect(tooltip.classList.contains('visible')).toBe(false);

      vi.advanceTimersByTime(500);
      expect(tooltip.style.display).toBe('block');
      const content = tooltip.querySelector('.ui-tooltip-content');
      expect(content!.textContent).toBe('Test tooltip');
    });

    it('hides tooltip on mouseout and restores title', () => {
      const btn = document.getElementById('test-btn')!;
      const overEvent = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(overEvent, 'target', { value: btn });
      document.dispatchEvent(overEvent);
      vi.advanceTimersByTime(500);

      const outEvent = new MouseEvent('mouseout', { bubbles: true });
      Object.defineProperty(outEvent, 'target', { value: btn });
      document.dispatchEvent(outEvent);

      expect(btn.getAttribute('title')).toBe('Test tooltip');
      expect(btn.dataset.originalTitle).toBeUndefined();

      const tooltip = document.getElementById('ui-tooltip')!;
      expect(tooltip.classList.contains('visible')).toBe(false);
    });

    it('skips tooltip for elements inside tour-tooltip', () => {
      const tourBtn = document.getElementById('tour-btn')!;
      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: tourBtn });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(500);

      expect(document.getElementById('ui-tooltip')!.classList.contains('visible')).toBe(false);
    });

    it('skips tooltip for elements inside command-palette-modal', () => {
      const paletteBtn = document.getElementById('palette-btn')!;
      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: paletteBtn });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(500);

      expect(document.getElementById('ui-tooltip')!.classList.contains('visible')).toBe(false);
    });

    it('finds title from ancestor element', () => {
      const child = document.getElementById('child-no-title')!;
      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: child });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(500);

      const tooltip = document.getElementById('ui-tooltip')!;
      expect(tooltip.style.display).toBe('block');
      expect(tooltip.querySelector('.ui-tooltip-content')!.textContent).toBe('Parent tooltip');
    });

    it('cleans up on scroll', () => {
      const btn = document.getElementById('test-btn')!;
      const overEvent = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(overEvent, 'target', { value: btn });
      document.dispatchEvent(overEvent);
      vi.advanceTimersByTime(500);

      document.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(200);

      const tooltip = document.getElementById('ui-tooltip')!;
      expect(tooltip.classList.contains('visible')).toBe(false);
      expect(btn.getAttribute('title')).toBe('Test tooltip');
    });

    it('cancels pending timeout on mouseout before delay', () => {
      const btn = document.getElementById('test-btn')!;
      const overEvent = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(overEvent, 'target', { value: btn });
      document.dispatchEvent(overEvent);

      const outEvent = new MouseEvent('mouseout', { bubbles: true });
      Object.defineProperty(outEvent, 'target', { value: btn });
      document.dispatchEvent(outEvent);

      vi.advanceTimersByTime(500);

      expect(document.getElementById('ui-tooltip')!.classList.contains('visible')).toBe(false);
    });

    it('ignores elements without title', () => {
      const noTitleEl = document.createElement('span');
      noTitleEl.textContent = 'no title';
      document.body.appendChild(noTitleEl);

      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: noTitleEl });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(500);

      expect(document.getElementById('ui-tooltip')!.classList.contains('visible')).toBe(false);
    });

    it('restores original title on mouseout from ancestor-titled element', () => {
      const child = document.getElementById('child-no-title')!;
      const parent = document.getElementById('parent-with-title')!;

      const overEvent = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(overEvent, 'target', { value: child });
      document.dispatchEvent(overEvent);

      // Parent title removed, stored in data-original-title
      expect(parent.getAttribute('title')).toBeNull();
      expect(parent.dataset.originalTitle).toBe('Parent tooltip');

      const outEvent = new MouseEvent('mouseout', { bubbles: true });
      Object.defineProperty(outEvent, 'target', { value: parent });
      document.dispatchEvent(outEvent);

      expect(parent.getAttribute('title')).toBe('Parent tooltip');
    });
  });
});
