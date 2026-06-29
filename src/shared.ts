import DOMPurify from 'dompurify';

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
};
const ESCAPE_RE = /[&<>"']/g;
const escapeReplacer = (m: string): string => ESCAPE_MAP[m] ?? '';

export function escapeHtml(text: unknown): string {
  if (text === null || text === undefined) return '';
  const str = String(text);
  return str.replace(ESCAPE_RE, escapeReplacer);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}

let devModeEnabled = false;

export function setDevMode(enabled: boolean): void {
  devModeEnabled = enabled;
  if (enabled) {
    (globalThis as Record<string, unknown>).__iyerisLogger = {
      debug: (...args: unknown[]) => globalThis.console.debug('[IYERIS]', ...args),
      info: (...args: unknown[]) => globalThis.console.info('[IYERIS]', ...args),
      warn: (...args: unknown[]) => globalThis.console.warn('[IYERIS]', ...args),
      error: (...args: unknown[]) => globalThis.console.error('[IYERIS]', ...args),
    };
    globalThis.console.info('[IYERIS] Dev mode enabled — verbose logging active');
  }
}

export function isDevMode(): boolean {
  return devModeEnabled;
}

export function devLog(category: string, ...args: unknown[]): void {
  if (devModeEnabled) {
    globalThis.console.debug(`[${category}]`, ...args);
  }
}

export function ignoreError(error: unknown): void {
  if (devModeEnabled) {
    globalThis.console.warn('[Ignored error]', error);
  } else if (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as Record<string, unknown>).__iyerisLogger === 'object'
  ) {
    try {
      const log = (globalThis as Record<string, unknown>).__iyerisLogger as {
        debug?: (...args: unknown[]) => void;
      };
      log.debug?.('[Ignored error]', error instanceof Error ? error.message : String(error));
    } catch {
      /* noop */
    }
  }
}

/**
 * L13: shared debounce helper. Six modules were rolling their own variant of
 * "timer + setTimeout + clearTimeout"; this factor eliminates that.
 *
 * Returns a callable wrapper plus a `cancel()` method for tear-down.
 */
export interface DebouncedFn<Args extends unknown[]> {
  (...args: Args): void;
  cancel(): void;
}

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms: number
): DebouncedFn<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapper = ((...args: Args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  }) as DebouncedFn<Args>;
  wrapper.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return wrapper;
}

/**
 * L14: standard pattern for reporting an IPC failure to the user. The previous
 * code had ~26 sites that wrote `showToast(result.error || 'fallback', 'Title', 'error')`;
 * this helper consolidates the fallback logic so callers don't keep
 * re-implementing it. Pass any IpcResult-like object plus a sensible fallback.
 *
 * showToast is renderer-only; this helper accepts it as a parameter so shared.ts
 * stays free of renderer imports.
 */
type ToastFn = (message: string, title?: string, kind?: 'error' | 'info' | 'warn') => void;

export function notifyIpcFailure(
  result: { error?: string | null } | unknown,
  fallback: string,
  toast: ToastFn,
  title?: string
): void {
  let message = fallback;
  if (
    result &&
    typeof result === 'object' &&
    'error' in result &&
    typeof (result as { error?: unknown }).error === 'string'
  ) {
    const err = (result as { error: string }).error;
    if (err.length > 0) message = err;
  }
  toast(message, title, 'error');
  if (devModeEnabled) {
    globalThis.console.debug('[IpcFailure]', { title, message, result });
  }
}

/**
 * L15: drop-in replacement for the most common ignoreError pattern when the
 * error IS user-visible. Use this instead of ignoreError when the user should
 * see the failure as a toast.
 */
export function reportIpcError(
  error: unknown,
  context: string,
  toast: ToastFn,
  title?: string
): void {
  const msg = getErrorMessage(error);
  toast(`${context}: ${msg}`, title, 'error');
  if (devModeEnabled) {
    globalThis.console.warn(`[${context}]`, error);
  }
}

export function assignKey<T extends object>(obj: T, key: keyof T, value: T[keyof T]): void {
  obj[key] = value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string');
}

const DANGEROUS_TAGS = new Set([
  'SCRIPT',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'FORM',
  'STYLE',
  'LINK',
  'META',
  'BASE',
  'NOSCRIPT',
  'SVG',
  'MATH',
  'TEMPLATE',
  'APPLET',
  'FRAME',
  'FRAMESET',
  'PORTAL',
  'AUDIO',
  'VIDEO',
  'SOURCE',
  'TRACK',
]);

// Attributes that can carry JS or load arbitrary resources. Stripped unconditionally.
const DANGEROUS_ATTRS = new Set([
  'formaction',
  'background',
  'poster',
  'srcset',
  'imagesrcset',
  'ping',
  'sandbox',
  'allow',
  'allowfullscreen',
  'csp',
  'dirname',
  'http-equiv',
  'manifest',
  'xmlns',
  'contextmenu',
]);

// URL-bearing attributes — value is checked against the URL allowlists below.
const URL_ATTRS = new Set(['href', 'src', 'action', 'cite', 'longdesc', 'data', 'usemap']);

const SAFE_URL_PATTERN = /^(?:https?|mailto|#):/i;
const SAFE_RESOURCE_URL_PATTERN = /^(?:https?:\/\/asset\.localhost\/)/i;
const HAS_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

const PURIFY_FORBID_TAGS = Array.from(DANGEROUS_TAGS, (t) => t.toLowerCase());

// Layer IYERIS's strict URL allowlist onto DOMPurify (href: http/https/mailto/#;
// resource URLs: relative or http(s)://asset.localhost only). Registered once.
let purifyHookInstalled = false;
function installPurifyHook(): void {
  if (purifyHookInstalled) return;
  purifyHookInstalled = true;
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    const name = data.attrName;
    if (!name) return;
    if (name.startsWith('on') || name === 'style' || DANGEROUS_ATTRS.has(name)) {
      data.keepAttr = false;
      return;
    }
    if (name.includes(':') && (name.endsWith(':href') || name.endsWith(':src'))) {
      data.keepAttr = false;
      return;
    }
    if (URL_ATTRS.has(name)) {
      const val = (data.attrValue ?? '').trim();
      if (/^\s*(?:javascript|data|vbscript)\s*:/i.test(val)) {
        data.keepAttr = false;
      } else if (name === 'href') {
        if (val && !val.startsWith('#') && !SAFE_URL_PATTERN.test(val)) data.keepAttr = false;
      } else if (
        val &&
        (/^\s*\/\//.test(val) ||
          (HAS_SCHEME_PATTERN.test(val) && !SAFE_RESOURCE_URL_PATTERN.test(val)))
      ) {
        data.keepAttr = false;
      }
    }
  });
}

export function sanitizeMarkdownHtml(html: string): string {
  installPurifyHook();
  // DOMPurify does the hardened parse/strip; the hook above layers IYERIS's
  // stricter URL policy on top. Single sanitize pass (no parse→serialize→reparse).
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: PURIFY_FORBID_TAGS,
    FORBID_ATTR: Array.from(DANGEROUS_ATTRS),
    ALLOW_DATA_ATTR: false,
  });
}
