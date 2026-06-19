import { devLog } from './shared.js';
import { en } from './locales/en.js';

export type Messages = Record<string, string>;
export type TranslationParams = Record<string, string | number>;

const catalogs: Record<string, Messages> = {};
let currentLocale = 'en';

/** Register (or extend) a locale's message catalog. */
export function registerCatalog(locale: string, messages: Messages): void {
  catalogs[locale] = { ...(catalogs[locale] ?? {}), ...messages };
}

registerCatalog('en', en);

export function getLocale(): string {
  return currentLocale;
}

/** Switch locale if a catalog exists for it; otherwise keep the current one. */
export function setLocale(locale: string): void {
  if (catalogs[locale]) {
    currentLocale = locale;
  } else {
    devLog('i18n', `No catalog for "${locale}"; keeping "${currentLocale}"`);
  }
}

/** Pick the best available locale from a preferred value + the browser list. */
export function detectLocale(preferred?: string): string {
  const candidates: (string | undefined)[] = [preferred];
  if (typeof navigator !== 'undefined') {
    candidates.push(...(navigator.languages ?? [navigator.language]));
  }
  for (const candidate of candidates) {
    const base = candidate?.toLowerCase().split('-')[0];
    if (base && catalogs[base]) return base;
  }
  return 'en';
}

/**
 * Translate a key. Falls back to the `en` catalog, then to the key itself
 * (with a dev warning) so a missing string is visible but never throws.
 * Supports "{name}" interpolation and "one|other" pluralization via `count`.
 */
export function t(key: string, params?: TranslationParams): string {
  const message = catalogs[currentLocale]?.[key] ?? catalogs.en?.[key];
  if (message === undefined) {
    devLog('i18n', `Missing translation key: "${key}"`);
    return key;
  }
  let resolved = message;
  if (params && typeof params.count === 'number' && message.includes('|')) {
    const forms = message.split('|');
    resolved = (params.count === 1 ? forms[0] : forms[1]) ?? message;
  }
  return resolved.replace(/\{(\w+)\}/g, (_match, name: string) =>
    params && name in params ? String(params[name]) : `{${name}}`
  );
}
