// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../rendererDom.js', () => ({
  getById: (id: string) => document.getElementById(id),
  clearHtml: (el: HTMLElement) => {
    if (el) el.innerHTML = '';
  },
}));

import { createHoverCardController } from '../rendererHoverCard.js';

type Deps = Parameters<typeof createHoverCardController>[0];

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    getFileItemData: vi.fn(() => ({
      name: 'test.txt',
      path: '/test/test.txt',
      size: 1024,
      isDirectory: false,
      modified: '2024-01-01T00:00:00Z',
    })) as any,
    formatFileSize: vi.fn((s: number) => `${s} B`),
    getFileTypeFromName: vi.fn(() => 'Text File'),
    getFileIcon: vi.fn(() => '<svg>icon</svg>'),
    getThumbnailForPath: vi.fn(() => undefined),
    isRubberBandActive: vi.fn(() => false),
    ...overrides,
  };
}

function setupHoverCardDom() {
  document.body.innerHTML = `
    <div id="file-hover-card" class="file-hover-card">
      <div id="hover-card-thumbnail"></div>
      <div id="hover-card-name"></div>
      <div id="hover-card-size"></div>
      <div id="hover-card-type"></div>
      <div id="hover-card-date"></div>
      <div id="hover-card-extra-row" style="display:none">
        <span id="hover-card-extra-label"></span>
        <span id="hover-card-extra-value"></span>
      </div>
    </div>
    <div class="file-item" id="file-item-1">file1.txt</div>
  `;
}

describe('rendererHoverCard', () => {
  let errorHandler: (e: ErrorEvent) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';

    errorHandler = (e: ErrorEvent) => {
      e.preventDefault();
    };
    window.addEventListener('error', errorHandler);
  });

  afterEach(() => {
    window.removeEventListener('error', errorHandler);
    vi.useRealTimers();
  });

  describe('setEnabled', () => {
    it('disables hover card and hides it', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const card = document.getElementById('file-hover-card')!;
      card.classList.add('visible');
      ctrl.setEnabled(false);
      expect(card.classList.contains('visible')).toBe(false);
    });

    it('re-enables hover card', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();
      ctrl.setEnabled(false);
      ctrl.setEnabled(true);
    });
  });

  describe('setup', () => {
    it('initializes only once', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();
      ctrl.setup();
    });

    it('returns early when required elements are missing', () => {
      document.body.innerHTML = '<div id="file-hover-card"></div>';
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();
    });

    it('returns early when hover card itself is missing', () => {
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();
    });

    it('shows hover card on mouseover after delay', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1')!;
      document.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        })
      );

      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: fileItem });
      document.dispatchEvent(event);

      vi.advanceTimersByTime(1000);

      const card = document.getElementById('file-hover-card')!;
      expect(card.classList.contains('visible')).toBe(true);
      expect(document.getElementById('hover-card-name')!.textContent).toBe('test.txt');
      expect(document.getElementById('hover-card-size')!.textContent).toBe('1024 B');
      expect(document.getElementById('hover-card-type')!.textContent).toBe('Text File');
    });

    it('shows directory info correctly', () => {
      setupHoverCardDom();
      const deps = makeDeps({
        getFileItemData: vi.fn(() => ({
          name: 'folder',
          path: '/test/folder',
          size: 0,
          isDirectory: true,
          modified: '2024-01-01T00:00:00Z',
        })) as any,
      });
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1')!;
      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: fileItem });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(1000);

      expect(document.getElementById('hover-card-size')!.textContent).toBe('--');
      expect(document.getElementById('hover-card-type')!.textContent).toBe('Folder');
    });

    it('shows thumbnail when cached', () => {
      setupHoverCardDom();
      const deps = makeDeps({
        getThumbnailForPath: vi.fn(() => 'data:image/png;base64,ABC'),
      });
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1')!;
      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: fileItem });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(1000);

      const thumbnail = document.getElementById('hover-card-thumbnail')!;
      const img = thumbnail.querySelector('img');
      expect(img).toBeTruthy();
      expect(img!.src).toContain('data:image/png');
    });

    it('shows icon when no thumbnail cached', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1')!;
      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: fileItem });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(1000);

      const thumbnail = document.getElementById('hover-card-thumbnail')!;
      expect(thumbnail.querySelector('.hover-icon')).toBeTruthy();
    });

    it('does not show hover card when disabled', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();
      ctrl.setEnabled(false);

      const fileItem = document.getElementById('file-item-1')!;
      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: fileItem });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(1000);

      const card = document.getElementById('file-hover-card')!;
      expect(card.classList.contains('visible')).toBe(false);
    });

    it('does not show when rubber band is active', () => {
      setupHoverCardDom();
      const deps = makeDeps({ isRubberBandActive: vi.fn(() => true) });
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1')!;
      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: fileItem });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(1000);

      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(false);
    });

    it('hides on mouseout from file item', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1')!;

      const overEvent = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(overEvent, 'target', { value: fileItem });
      document.dispatchEvent(overEvent);
      vi.advanceTimersByTime(1000);

      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(true);

      const outEvent = new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body });
      Object.defineProperty(outEvent, 'target', { value: fileItem });
      document.dispatchEvent(outEvent);

      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(false);
    });

    it('hides on scroll', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1')!;
      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: fileItem });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(1000);

      document.dispatchEvent(new Event('scroll'));
      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(false);
    });

    it('hides on mousedown', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1')!;
      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: fileItem });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(1000);

      document.dispatchEvent(new MouseEvent('mousedown'));
      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(false);
    });

    it('cancels pending show on mouseout before delay', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1')!;
      const overEvent = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(overEvent, 'target', { value: fileItem });
      document.dispatchEvent(overEvent);

      const outEvent = new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body });
      Object.defineProperty(outEvent, 'target', { value: fileItem });
      document.dispatchEvent(outEvent);

      vi.advanceTimersByTime(1000);
      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(false);
    });

    it('does not show for null file item data', () => {
      setupHoverCardDom();
      const deps = makeDeps({
        getFileItemData: vi.fn(() => null),
      });
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1')!;
      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: fileItem });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(1000);

      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(false);
    });

    it('hides when hovering over non-file-item after file-item', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1')!;
      const overEvent = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(overEvent, 'target', { value: fileItem });
      document.dispatchEvent(overEvent);
      vi.advanceTimersByTime(1000);

      const nonFileEvent = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(nonFileEvent, 'target', { value: document.body });
      document.dispatchEvent(nonFileEvent);

      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(false);
    });

    it('does not show hover card if hovered file is removed before delay fires', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1')!;
      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: fileItem });
      document.dispatchEvent(event);

      fileItem.remove();
      vi.advanceTimersByTime(1000);

      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(false);
    });

    it('handles repeated mouseover on same item without requeueing', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const fileItem = document.getElementById('file-item-1')!;

      const first = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(first, 'target', { value: fileItem });
      document.dispatchEvent(first);
      const scheduledAfterFirst = setTimeoutSpy.mock.calls.length;

      const second = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(second, 'target', { value: fileItem });
      document.dispatchEvent(second);

      expect(setTimeoutSpy.mock.calls.length).toBe(scheduledAfterFirst);
      setTimeoutSpy.mockRestore();
    });

    it('clamps hover card position when viewport is too small', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const originalInnerWidth = window.innerWidth;
      const originalInnerHeight = window.innerHeight;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 200 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 160 });

      const fileItem = document.getElementById('file-item-1') as HTMLElement;
      vi.spyOn(fileItem, 'getBoundingClientRect').mockReturnValue({
        x: 10,
        y: 10,
        width: 20,
        height: 20,
        top: 10,
        right: 30,
        bottom: 30,
        left: 10,
        toJSON: () => ({}),
      });

      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: fileItem });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(1000);

      const card = document.getElementById('file-hover-card') as HTMLElement;
      expect(card.style.left).toBe('16px');
      expect(card.style.top).toBe('16px');

      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalInnerWidth,
      });
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      });
    });

    it('supports focusin/focusout hover behavior', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1') as HTMLElement;
      fileItem.tabIndex = 0;
      fileItem.focus();
      fileItem.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

      vi.advanceTimersByTime(1000);
      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(true);

      fileItem.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(false);
    });

    it('does not show on focusin when disabled', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();
      ctrl.setEnabled(false);

      const fileItem = document.getElementById('file-item-1') as HTMLElement;
      fileItem.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      vi.advanceTimersByTime(1000);

      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(false);
    });

    it('keeps hover visible when moving focus to another file item', () => {
      setupHoverCardDom();
      const second = document.createElement('div');
      second.className = 'file-item';
      second.id = 'file-item-2';
      second.textContent = 'file2.txt';
      document.body.appendChild(second);

      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const first = document.getElementById('file-item-1') as HTMLElement;
      first.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      vi.advanceTimersByTime(1000);
      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(true);

      first.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: second }));
      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(true);
    });

    it('ignores non-element targets in mouseout handler', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const event = new MouseEvent('mouseout', { bubbles: true });
      Object.defineProperty(event, 'target', { value: document });
      Object.defineProperty(event, 'relatedTarget', { value: null });

      expect(() => document.dispatchEvent(event)).not.toThrow();
    });

    it('handles null relatedTarget in mouseout branch', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1')!;
      const event = new MouseEvent('mouseout', { bubbles: true });
      Object.defineProperty(event, 'target', { value: fileItem });
      Object.defineProperty(event, 'relatedTarget', { value: null });

      document.dispatchEvent(event);
      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(false);
    });

    it('works when optional extra-row elements are absent', () => {
      document.body.innerHTML = `
        <div id="file-hover-card" class="file-hover-card">
          <div id="hover-card-thumbnail"></div>
          <div id="hover-card-name"></div>
          <div id="hover-card-size"></div>
          <div id="hover-card-type"></div>
          <div id="hover-card-date"></div>
        </div>
        <div class="file-item" id="file-item-1">file1.txt</div>
      `;
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1')!;
      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: fileItem });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(1000);

      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(true);
    });
  });

  describe('cleanup and hideHoverCard', () => {
    it('hideHoverCard is safe when hover card elements are missing', () => {
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      expect(() => ctrl.hideHoverCard()).not.toThrow();
    });

    it('cleanup removes listeners and allows setup again', () => {
      setupHoverCardDom();
      const deps = makeDeps();
      const ctrl = createHoverCardController(deps);
      ctrl.setup();

      const fileItem = document.getElementById('file-item-1')!;
      const event = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(event, 'target', { value: fileItem });
      document.dispatchEvent(event);
      vi.advanceTimersByTime(1000);
      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(true);

      ctrl.cleanup();
      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(false);

      const secondEvent = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(secondEvent, 'target', { value: fileItem });
      document.dispatchEvent(secondEvent);
      vi.advanceTimersByTime(1000);
      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(false);

      ctrl.setup();
      const thirdEvent = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(thirdEvent, 'target', { value: fileItem });
      document.dispatchEvent(thirdEvent);
      vi.advanceTimersByTime(1000);
      expect(document.getElementById('file-hover-card')!.classList.contains('visible')).toBe(true);
    });
  });
});
