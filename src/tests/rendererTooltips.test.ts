// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../rendererDom.js', () => ({
  getById: (id: string) => document.getElementById(id),
}));

import { initTooltipSystem } from '../rendererTooltips.js';

describe('rendererTooltips', () => {
  let errorHandler: (e: ErrorEvent) => void;
  const setViewport = (width: number, height: number) => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  };
  const mockRect = (
    el: HTMLElement,
    rect: { top: number; left: number; width: number; height: number }
  ) => {
    const domRect = {
      x: rect.left,
      y: rect.top,
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      toJSON: () => '',
    } as DOMRect;
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(domRect);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    setViewport(1024, 768);

    errorHandler = (e: ErrorEvent) => {
      e.preventDefault();
    };
    window.addEventListener('error', errorHandler);

    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    };
  });

  afterEach(() => {
    window.removeEventListener('error', errorHandler);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does nothing when tooltip element is missing', () => {
    document.body.innerHTML = '';
    initTooltipSystem();
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

      expect(parent.getAttribute('title')).toBeNull();
      expect(parent.dataset.originalTitle).toBe('Parent tooltip');

      const outEvent = new MouseEvent('mouseout', { bubbles: true });
      Object.defineProperty(outEvent, 'target', { value: parent });
      document.dispatchEvent(outEvent);

      expect(parent.getAttribute('title')).toBe('Parent tooltip');
    });

    it('places tooltip on top when there is no room below anchor', () => {
      setViewport(320, 200);

      const btn = document.getElementById('test-btn')!;
      const tooltip = document.getElementById('ui-tooltip')!;
      mockRect(btn, { top: 170, left: 100, width: 40, height: 20 });
      mockRect(tooltip, { top: 0, left: 0, width: 120, height: 40 });

      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: btn });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(500);

      expect(tooltip.className).toContain('top');
      expect(tooltip.style.top).toBe('122px');
      expect(tooltip.style.left).toBe('60px');
    });

    it('clamps tooltip to viewport right edge', () => {
      setViewport(320, 400);

      const btn = document.getElementById('test-btn')!;
      const tooltip = document.getElementById('ui-tooltip')!;
      mockRect(btn, { top: 50, left: 290, width: 20, height: 20 });
      mockRect(tooltip, { top: 0, left: 0, width: 120, height: 30 });

      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: btn });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(500);

      expect(tooltip.className).toContain('bottom');
      expect(tooltip.style.left).toBe('192px');
      expect(tooltip.style.top).toBe('78px');
    });

    it('clamps tooltip to top and left viewport padding', () => {
      setViewport(180, 50);

      const btn = document.getElementById('test-btn')!;
      const tooltip = document.getElementById('ui-tooltip')!;
      mockRect(btn, { top: 20, left: 0, width: 20, height: 20 });
      mockRect(tooltip, { top: 0, left: 0, width: 120, height: 60 });

      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: btn });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(500);

      expect(tooltip.className).toContain('top');
      expect(tooltip.style.top).toBe('8px');
      expect(tooltip.style.left).toBe('8px');
    });

    it('shows tooltip even when content element is missing', () => {
      const btn = document.getElementById('test-btn')!;
      const tooltip = document.getElementById('ui-tooltip')!;
      tooltip.innerHTML = '';
      mockRect(btn, { top: 60, left: 80, width: 40, height: 20 });
      mockRect(tooltip, { top: 0, left: 0, width: 100, height: 30 });

      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: btn });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(500);

      expect(tooltip.style.display).toBe('block');
      expect(tooltip.classList.contains('visible')).toBe(true);
    });

    it('clears debounce timeout during re-init cleanup', () => {
      const btn = document.getElementById('test-btn')!;
      const firstOverEvent = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(firstOverEvent, 'target', { value: btn });
      document.dispatchEvent(firstOverEvent);

      expect(vi.getTimerCount()).toBe(2);

      initTooltipSystem();

      expect(vi.getTimerCount()).toBe(0);
      expect(btn.getAttribute('title')).toBe('Test tooltip');

      const secondOverEvent = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(secondOverEvent, 'target', { value: btn });
      document.dispatchEvent(secondOverEvent);

      expect(btn.getAttribute('title')).toBeNull();
      expect(btn.dataset.originalTitle).toBe('Test tooltip');
      expect(vi.getTimerCount()).toBe(2);
    });

    it('completes hide timeout safely after tooltip element is removed', () => {
      const btn = document.getElementById('test-btn')!;
      const overEvent = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(overEvent, 'target', { value: btn });
      document.dispatchEvent(overEvent);
      vi.advanceTimersByTime(500);

      const outEvent = new MouseEvent('mouseout', { bubbles: true });
      Object.defineProperty(outEvent, 'target', { value: btn });
      document.dispatchEvent(outEvent);

      document.body.innerHTML = '';
      initTooltipSystem();
      vi.advanceTimersByTime(150);

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
