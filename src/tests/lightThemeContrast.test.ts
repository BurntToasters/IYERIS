import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(new URL('../css/themes.css', import.meta.url), 'utf8');
const uiStylesheet = readFileSync(new URL('../css/ui3.css', import.meta.url), 'utf8');
const lightTheme = stylesheet.match(/body\.theme-light \{([\s\S]*?)\n\}/)?.[1] ?? '';

function token(name: string): string {
  const value = lightTheme.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  if (!value) throw new Error(`Missing literal light-theme token: ${name}`);
  return value;
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)
    ?.map((channel) => parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));

  if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${hex}`);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

describe('light theme contrast contract', () => {
  const canvas = token('--surface-0');
  const raised = token('--surface-1');
  const control = token('--surface-2');
  const primary = token('--text-primary');
  const secondary = token('--text-secondary');
  const tertiary = token('--text-tertiary');

  it('keeps readable text hierarchy across every light surface', () => {
    for (const surface of [canvas, raised, control]) {
      expect(contrast(primary, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(secondary, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tertiary, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(primary, surface)).toBeGreaterThan(contrast(secondary, surface));
      expect(contrast(secondary, surface)).toBeGreaterThan(contrast(tertiary, surface));
    }
  });

  it('keeps primary actions and required input boundaries distinguishable', () => {
    expect(contrast(token('--text-on-accent'), token('--accent-color'))).toBeGreaterThanOrEqual(
      4.5
    );
    expect(contrast(token('--control-border'), canvas)).toBeGreaterThanOrEqual(3);
    expect(contrast(token('--control-border'), raised)).toBeGreaterThanOrEqual(3);
  });

  it('does not let light-mode surface rules override primary or close-button states', () => {
    expect(uiStylesheet).toContain('body.theme-light .modal-button:not(.primary):not(:disabled)');
    expect(uiStylesheet).toContain('.titlebar-button.close:hover');
    expect(uiStylesheet).toContain('background: var(--danger-color);');
  });
});
