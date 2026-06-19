import { describe, it, expect, afterEach } from 'vitest';
import { t, setLocale, getLocale, registerCatalog, detectLocale } from '../i18n';

afterEach(() => {
  setLocale('en'); // reset shared module state between tests
});

describe('t() — interpolation & pluralization', () => {
  it('returns a plain string', () => {
    expect(t('toast.largeFolder.title')).toBe('Large Folder');
  });

  it('interpolates {placeholder} params', () => {
    expect(t('statusBar.selected', { count: 3, size: '1 KB' })).toBe('3 selected (1 KB)');
  });

  it('selects singular vs plural by count', () => {
    expect(t('statusBar.items', { count: 1 })).toBe('1 item');
    expect(t('statusBar.items', { count: 5 })).toBe('5 items');
    expect(t('statusBar.items', { count: 0 })).toBe('0 items');
  });

  it('leaves unknown placeholders intact', () => {
    expect(t('statusBar.selected', { count: 2 })).toBe('2 selected ({size})');
  });

  it('falls back to the key for a missing translation', () => {
    expect(t('does.not.exist')).toBe('does.not.exist');
  });
});

describe('locale management', () => {
  it('switches locale and falls back to en for missing keys', () => {
    registerCatalog('xx', { 'toast.largeFolder.title': 'XX Folder' });
    setLocale('xx');
    expect(getLocale()).toBe('xx');
    expect(t('toast.largeFolder.title')).toBe('XX Folder');
    // key absent in xx → en fallback
    expect(t('statusBar.items', { count: 1 })).toBe('1 item');
  });

  it('ignores setLocale for an unregistered locale', () => {
    setLocale('en');
    setLocale('zz-nope');
    expect(getLocale()).toBe('en');
  });

  it('detectLocale matches a registered base language', () => {
    registerCatalog('de', { 'toast.largeFolder.title': 'Großer Ordner' });
    expect(detectLocale('de-DE')).toBe('de');
    expect(detectLocale('fr-FR')).toBe('en'); // no fr catalog
    expect(detectLocale()).toBe('en');
  });
});
