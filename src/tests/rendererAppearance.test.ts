// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../types';
import { createDefaultSettings } from '../settings';
import { applyAppearance } from '../rendererAppearance';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...createDefaultSettings(),
    ...overrides,
  };
}

describe('applyAppearance', () => {
  beforeEach(() => {
    document.body.className = '';
    document.documentElement.removeAttribute('style');
  });

  it('applies the active theme class and clears old theme classes', () => {
    document.body.classList.add('theme-light', 'theme-github');

    applyAppearance(makeSettings({ theme: 'nord' }), {
      applyCustomThemeColors: vi.fn(),
      clearCustomThemeColors: vi.fn(),
    });

    expect(document.body.classList.contains('theme-nord')).toBe(true);
    expect(document.body.classList.contains('theme-light')).toBe(false);
    expect(document.body.classList.contains('theme-github')).toBe(false);
  });

  it('applies and clears custom theme colors based on selected theme', () => {
    const applyCustomThemeColors = vi.fn();
    const clearCustomThemeColors = vi.fn();

    applyAppearance(
      makeSettings({
        theme: 'custom',
        customTheme: {
          name: 'Test',
          accentColor: '#336699',
          bgPrimary: '#111111',
          bgSecondary: '#222222',
          textPrimary: '#ffffff',
          textSecondary: '#cccccc',
          glassBg: '#ffffff',
          glassBorder: '#ffffff',
          iconHue: '#336699',
        },
      }),
      { applyCustomThemeColors, clearCustomThemeColors }
    );

    expect(applyCustomThemeColors).toHaveBeenCalledTimes(1);
    expect(clearCustomThemeColors).not.toHaveBeenCalled();

    applyAppearance(makeSettings({ theme: 'light' }), {
      applyCustomThemeColors,
      clearCustomThemeColors,
    });
    expect(clearCustomThemeColors).toHaveBeenCalledTimes(1);
  });

  it('applies boolean appearance classes from settings', () => {
    applyAppearance(
      makeSettings({
        reduceMotion: true,
        highContrast: true,
        largeText: true,
        boldText: true,
        visibleFocus: true,
        reduceTransparency: true,
        liquidGlassMode: true,
        themedIcons: true,
        showFileCheckboxes: true,
        compactFileInfo: true,
        showFileExtensions: false,
      }),
      {
        applyCustomThemeColors: vi.fn(),
        clearCustomThemeColors: vi.fn(),
      }
    );

    expect(document.body.classList.contains('reduce-motion')).toBe(true);
    expect(document.body.classList.contains('high-contrast')).toBe(true);
    expect(document.body.classList.contains('large-text')).toBe(true);
    expect(document.body.classList.contains('bold-text')).toBe(true);
    expect(document.body.classList.contains('visible-focus')).toBe(true);
    expect(document.body.classList.contains('reduce-transparency')).toBe(true);
    expect(document.body.classList.contains('liquid-glass')).toBe(true);
    expect(document.body.classList.contains('themed-icons')).toBe(true);
    expect(document.body.classList.contains('show-file-checkboxes')).toBe(true);
    expect(document.body.classList.contains('compact-file-info')).toBe(true);
    expect(document.body.classList.contains('hide-file-extensions')).toBe(true);
  });

  it('applies density and preview position classes', () => {
    applyAppearance(
      makeSettings({
        uiDensity: 'compact',
        previewPanelPosition: 'bottom',
      }),
      {
        applyCustomThemeColors: vi.fn(),
        clearCustomThemeColors: vi.fn(),
      }
    );

    expect(document.body.classList.contains('compact-ui')).toBe(true);
    expect(document.body.classList.contains('large-ui')).toBe(false);
    expect(document.body.classList.contains('preview-bottom')).toBe(true);
    expect(document.body.classList.contains('preview-right')).toBe(false);
  });

  it('applies and clears grid and icon CSS variables', () => {
    const deps = {
      applyCustomThemeColors: vi.fn(),
      clearCustomThemeColors: vi.fn(),
    };

    applyAppearance(
      makeSettings({
        gridColumns: '4',
        iconSize: 96,
      }),
      deps
    );

    expect(document.documentElement.style.getPropertyValue('--grid-columns')).toBe('4');
    expect(document.documentElement.style.getPropertyValue('--icon-size-grid')).toBe('96px');

    applyAppearance(
      makeSettings({
        gridColumns: 'auto',
        iconSize: 0,
      }),
      deps
    );

    expect(document.documentElement.style.getPropertyValue('--grid-columns')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--icon-size-grid')).toBe('');
  });
});
