import { describe, it, expect } from 'vitest';
import { hexToRgb } from '../rendererThemeEditor';

describe('hexToRgb', () => {
  it('converts valid 6-char hex to rgb', () => {
    expect(hexToRgb('#ff0000')).toBe('255, 0, 0');
    expect(hexToRgb('#00ff00')).toBe('0, 255, 0');
    expect(hexToRgb('#0000ff')).toBe('0, 0, 255');
  });

  it('converts hex without # prefix', () => {
    expect(hexToRgb('ff0000')).toBe('255, 0, 0');
    expect(hexToRgb('ffffff')).toBe('255, 255, 255');
  });

  it('converts black', () => {
    expect(hexToRgb('#000000')).toBe('0, 0, 0');
  });

  it('converts white', () => {
    expect(hexToRgb('#ffffff')).toBe('255, 255, 255');
  });

  it('handles mixed case', () => {
    expect(hexToRgb('#FF8800')).toBe('255, 136, 0');
    expect(hexToRgb('#aaBBcc')).toBe('170, 187, 204');
  });

  it('returns fallback for invalid hex', () => {
    expect(hexToRgb('invalid')).toBe('0, 120, 212');
    expect(hexToRgb('')).toBe('0, 120, 212');
    expect(hexToRgb('#gggggg')).toBe('0, 120, 212');
  });

  it('returns fallback for 3-char hex (not supported by parseHexRgb)', () => {
    expect(hexToRgb('#fff')).toBe('0, 120, 212');
  });

  it('converts app accent colors', () => {
    expect(hexToRgb('#0078d4')).toBe('0, 120, 212');
    expect(hexToRgb('#4a9eff')).toBe('74, 158, 255');
    expect(hexToRgb('#2ecc71')).toBe('46, 204, 113');
  });
});
