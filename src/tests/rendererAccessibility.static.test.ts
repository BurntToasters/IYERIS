// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeIconName, SUPPORTED_ICON_NAMES } from '../rendererUtils.js';

function accessibleName(element: HTMLElement): string {
  const ariaLabel = element.getAttribute('aria-label')?.trim();
  if (ariaLabel) return ariaLabel;
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const value = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() || '')
      .filter(Boolean)
      .join(' ');
    if (value) return value;
  }
  if (element.id) {
    const label = document.querySelector<HTMLLabelElement>(`label[for="${element.id}"]`);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }
  const wrappingLabel = element.closest('label')?.textContent?.trim();
  if (wrappingLabel) return wrappingLabel;
  if (element instanceof HTMLButtonElement && element.textContent?.trim()) {
    return element.textContent.trim();
  }
  // `title` is only a tooltip fallback, not a dependable accessible name
  // across screen readers. Shipped controls must expose an explicit label,
  // visible text, or an associated `<label>`.
  return '';
}

describe('shipped DOM accessibility invariants', () => {
  beforeAll(() => {
    const html = readFileSync(resolve(process.cwd(), 'src/index.html'), 'utf8');
    const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1];
    if (!body) throw new Error('src/index.html has no body');
    document.body.innerHTML = body;
  });

  it('has no duplicate IDs', () => {
    const ids = Array.from(document.querySelectorAll<HTMLElement>('[id]'), (element) => element.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });

  it('maps every shipped data icon to the typed registry', () => {
    const supported = new Set(SUPPORTED_ICON_NAMES);
    const unmapped = Array.from(document.querySelectorAll<HTMLElement>('[data-icon]'))
      .map((element) => element.dataset.icon || '')
      .filter((icon) => !supported.has(normalizeIconName(icon)));
    expect(unmapped).toEqual([]);
  });

  it('names every form control and button', () => {
    const unnamed = Array.from(
      document.querySelectorAll<HTMLElement>('input, select, textarea, button')
    )
      .filter((element) => element.getAttribute('type') !== 'hidden')
      .filter((element) => !accessibleName(element))
      .map((element) => element.id || element.outerHTML.slice(0, 100));
    expect(unnamed).toEqual([]);
  });

  it('names every dialog', () => {
    const unnamed = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
      .filter((dialog) => !accessibleName(dialog))
      .map((dialog) => dialog.parentElement?.id || dialog.outerHTML.slice(0, 100));
    expect(unnamed).toEqual([]);
  });

  it('connects every combobox to a listbox popup', () => {
    for (const combobox of document.querySelectorAll<HTMLElement>('[role="combobox"]')) {
      const controlledId = combobox.getAttribute('aria-controls');
      const popup = controlledId ? document.getElementById(controlledId) : null;
      expect(combobox.getAttribute('aria-haspopup'), combobox.id).toBe('listbox');
      expect(combobox.getAttribute('aria-autocomplete'), combobox.id).toBe('list');
      expect(combobox.hasAttribute('aria-expanded'), combobox.id).toBe(true);
      expect(popup, combobox.id).not.toBeNull();
      expect(popup?.getAttribute('role'), combobox.id).toBe('listbox');
    }
  });

  it('keeps each populated tablist in one valid active state', () => {
    for (const tablist of document.querySelectorAll<HTMLElement>('[role="tablist"]')) {
      const tabs = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]'));
      if (tabs.length === 0) continue;
      expect(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1);
      for (const tab of tabs) {
        const active = tab.getAttribute('aria-selected') === 'true';
        expect(tab.tabIndex, tab.id).toBe(active ? 0 : -1);
        const panel = document.getElementById(tab.getAttribute('aria-controls') || '');
        expect(panel, tab.id).not.toBeNull();
        expect(panel?.getAttribute('role'), tab.id).toBe('tabpanel');
        expect(panel?.getAttribute('aria-labelledby'), tab.id).toBe(tab.id);
        expect(panel?.hasAttribute('hidden'), tab.id).toBe(!active);
      }
    }
  });
});
