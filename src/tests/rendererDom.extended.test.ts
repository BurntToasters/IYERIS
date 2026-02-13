// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { getById, setHtml, clearHtml } from '../rendererDom';

describe('rendererDom', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="test-el"><span>child</span></div>';
  });

  describe('getById', () => {
    it('returns element by id', () => {
      const el = getById('test-el');
      expect(el).toBeTruthy();
      expect(el!.id).toBe('test-el');
    });

    it('returns null for missing id', () => {
      expect(getById('nonexistent')).toBeNull();
    });

    it('caches element and returns same reference', () => {
      const first = getById('test-el');
      const second = getById('test-el');
      expect(second).toBe(first);
    });

    it('invalidates cache when element is removed from DOM', () => {
      const first = getById('test-el');
      expect(first).toBeTruthy();
      document.body.innerHTML = '';
      const second = getById('test-el');
      expect(second).toBeNull();
    });

    it('refreshes cache when element is replaced', () => {
      const first = getById('test-el');
      document.body.innerHTML = '<div id="test-el">new</div>';
      const second = getById('test-el');
      expect(second).not.toBe(first);
      expect(second!.textContent).toBe('new');
    });
  });

  describe('setHtml', () => {
    it('sets innerHTML on element', () => {
      const el = document.getElementById('test-el')!;
      setHtml(el, '<b>bold</b>');
      expect(el.innerHTML).toBe('<b>bold</b>');
    });

    it('does nothing when element is null', () => {
      setHtml(null, '<b>bold</b>');
    });
  });

  describe('clearHtml', () => {
    it('removes all children', () => {
      const el = document.getElementById('test-el')!;
      expect(el.childNodes.length).toBeGreaterThan(0);
      clearHtml(el);
      expect(el.childNodes.length).toBe(0);
    });

    it('does nothing when element is null', () => {
      clearHtml(null);
    });
  });
});
