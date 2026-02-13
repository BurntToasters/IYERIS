/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./rendererDom.js', () => ({
  getById: vi.fn((id: string) => document.getElementById(id)),
}));

import { createTypeaheadController } from './rendererTypeahead';

HTMLElement.prototype.scrollIntoView = function () {};

function makeDeps() {
  return {
    getFileItems: vi.fn(() => [] as HTMLElement[]),
    clearSelection: vi.fn(),
    getSelectedItems: vi.fn(() => new Set<string>()),
    updateStatusBar: vi.fn(),
  };
}

function createFileItem(name: string, path: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'file-item';
  item.setAttribute('data-path', path);
  item.tabIndex = -1;
  const span = document.createElement('span');
  span.className = 'file-name';
  span.textContent = name;
  item.appendChild(span);
  return item;
}

describe('rendererTypeahead', () => {
  let indicator: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="typeahead-indicator" style="display:none"></div>';
    indicator = document.getElementById('typeahead-indicator')!;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  describe('handleInput', () => {
    it('shows indicator with typed character', () => {
      const deps = makeDeps();
      const ctrl = createTypeaheadController(deps);
      ctrl.handleInput('a');
      expect(indicator.style.display).toBe('block');
      expect(indicator.textContent).toBe('a');
    });

    it('accumulates buffer with multiple characters', () => {
      const deps = makeDeps();
      const ctrl = createTypeaheadController(deps);
      ctrl.handleInput('h');
      ctrl.handleInput('e');
      ctrl.handleInput('l');
      expect(indicator.textContent).toBe('hel');
    });

    it('clears buffer after 800ms timeout', () => {
      const deps = makeDeps();
      const ctrl = createTypeaheadController(deps);
      ctrl.handleInput('x');
      expect(indicator.textContent).toBe('x');
      vi.advanceTimersByTime(800);
      expect(indicator.style.display).toBe('none');
      expect(indicator.textContent).toBe('');
    });

    it('resets timeout on subsequent input', () => {
      const deps = makeDeps();
      const ctrl = createTypeaheadController(deps);
      ctrl.handleInput('a');
      vi.advanceTimersByTime(600);
      ctrl.handleInput('b');
      vi.advanceTimersByTime(600);
      // only 600ms after 'b', buffer should still be active
      expect(indicator.textContent).toBe('ab');
      vi.advanceTimersByTime(200);
      // now 800ms after 'b', buffer clears
      expect(indicator.textContent).toBe('');
    });

    it('selects matching file item', () => {
      const deps = makeDeps();
      const items = [
        createFileItem('README.md', '/readme'),
        createFileItem('package.json', '/pkg'),
      ];
      items.forEach((i) => document.body.appendChild(i));
      deps.getFileItems.mockReturnValue(items);
      const selected = new Set<string>();
      deps.getSelectedItems.mockReturnValue(selected);

      const ctrl = createTypeaheadController(deps);
      ctrl.handleInput('p');

      expect(deps.clearSelection).toHaveBeenCalled();
      expect(items[1].classList.contains('selected')).toBe(true);
      expect(items[1].getAttribute('aria-selected')).toBe('true');
      expect(selected.has('/pkg')).toBe(true);
      expect(deps.updateStatusBar).toHaveBeenCalled();
    });

    it('matches case-insensitively', () => {
      const deps = makeDeps();
      const items = [createFileItem('Hello.txt', '/hello')];
      document.body.appendChild(items[0]);
      deps.getFileItems.mockReturnValue(items);
      deps.getSelectedItems.mockReturnValue(new Set<string>());

      const ctrl = createTypeaheadController(deps);
      ctrl.handleInput('h');
      expect(items[0].classList.contains('selected')).toBe(true);
    });

    it('does nothing when no match found', () => {
      const deps = makeDeps();
      const items = [createFileItem('alpha.txt', '/alpha')];
      deps.getFileItems.mockReturnValue(items);

      const ctrl = createTypeaheadController(deps);
      ctrl.handleInput('z');
      expect(deps.clearSelection).not.toHaveBeenCalled();
    });

    it('updates tabindex on matched item and resets previous', () => {
      const deps = makeDeps();
      const items = [
        createFileItem('apple.txt', '/apple'),
        createFileItem('banana.txt', '/banana'),
      ];
      items[0].tabIndex = 0; // currently active
      items.forEach((i) => document.body.appendChild(i));
      deps.getFileItems.mockReturnValue(items);
      deps.getSelectedItems.mockReturnValue(new Set<string>());

      const ctrl = createTypeaheadController(deps);
      ctrl.handleInput('b');
      expect(items[0].tabIndex).toBe(-1);
      expect(items[1].tabIndex).toBe(0);
    });

    it('focuses and scrolls matched item into view', () => {
      const deps = makeDeps();
      const item = createFileItem('test.txt', '/test');
      document.body.appendChild(item);
      deps.getFileItems.mockReturnValue([item]);
      deps.getSelectedItems.mockReturnValue(new Set<string>());

      const focusSpy = vi.spyOn(item, 'focus');
      const scrollSpy = vi.spyOn(item, 'scrollIntoView');

      const ctrl = createTypeaheadController(deps);
      ctrl.handleInput('t');
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });
    });

    it('handles item without data-path gracefully', () => {
      const deps = makeDeps();
      const item = document.createElement('div');
      item.className = 'file-item';
      item.tabIndex = -1;
      const span = document.createElement('span');
      span.className = 'file-name';
      span.textContent = 'nopath';
      item.appendChild(span);
      document.body.appendChild(item);
      deps.getFileItems.mockReturnValue([item]);
      const selected = new Set<string>();
      deps.getSelectedItems.mockReturnValue(selected);

      const ctrl = createTypeaheadController(deps);
      ctrl.handleInput('n');
      expect(item.classList.contains('selected')).toBe(true);
      expect(selected.size).toBe(0);
    });
  });

  describe('reset', () => {
    it('clears buffer, timeout, and hides indicator', () => {
      const deps = makeDeps();
      const ctrl = createTypeaheadController(deps);
      ctrl.handleInput('a');
      ctrl.handleInput('b');
      expect(indicator.textContent).toBe('ab');
      ctrl.reset();
      expect(indicator.style.display).toBe('none');
      expect(indicator.textContent).toBe('');
      // timeout should be cleared so no error after advancing
      vi.advanceTimersByTime(1000);
      expect(indicator.textContent).toBe('');
    });

    it('works when no prior input', () => {
      const deps = makeDeps();
      const ctrl = createTypeaheadController(deps);
      ctrl.reset();
      expect(indicator.style.display).toBe('none');
    });
  });

  describe('no indicator element', () => {
    it('handles missing indicator gracefully', () => {
      document.body.innerHTML = '';
      const deps = makeDeps();
      const ctrl = createTypeaheadController(deps);
      // should not throw
      ctrl.handleInput('x');
      ctrl.reset();
    });
  });
});
