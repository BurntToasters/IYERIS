import { devLog } from './shared.js';
import { en } from './locales/en.js';

export type Messages = Record<string, string>;
export type TranslationParams = Record<string, string | number>;

const catalogs: Record<string, Messages> = {};
let currentLocale = 'en';

/** Cached Intl.PluralRules instances keyed by locale (creation is non-trivial). */
const pluralRulesCache = new Map<string, Intl.PluralRules>();

function getPluralRules(locale: string): Intl.PluralRules {
  let pr = pluralRulesCache.get(locale);
  if (!pr) {
    pr = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, pr);
  }
  return pr;
}

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
 *
 * Pluralization via `count`:
 *   - Legacy format:  "singular|plural"
 *     → index 0 for `one`, last index for everything else (Intl.PluralRules).
 *   - Extended format: "one:file|few:files|many:files|other:files"
 *     → category matched by Intl.PluralRules; falls back to `other`.
 *     Supports all CLDR categories (zero/one/two/few/many/other) so locales
 *     like Russian or Arabic work correctly once their catalogs are added.
 *
 * Supports "{name}" placeholder interpolation.
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
    const pr = getPluralRules(currentLocale);
    const category = pr.select(params.count);

    // Extended named-category format: "one:file|few:files|other:files"
    if (forms.some((f) => /^(?:zero|one|two|few|many|other):/.test(f))) {
      const match = forms.find((f) => f.startsWith(`${category}:`));
      const fallback = forms.find((f) => f.startsWith('other:'));
      const chosen = match ?? fallback ?? forms[0];
      resolved = chosen?.replace(/^[a-z]+:/, '') ?? message;
    } else {
      // Legacy "singular|plural": index 0 = one form, last = other form.
      resolved = (category === 'one' ? forms[0] : forms[forms.length - 1]) ?? message;
    }
  }
  return resolved.replace(/\{(\w+)\}/g, (_match, name: string) =>
    params && name in params ? String(params[name]) : `{${name}}`
  );
}
