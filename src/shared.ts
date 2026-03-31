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
]);

const SAFE_URL_PATTERN = /^(?:https?|mailto|#):/i;
const SAFE_RESOURCE_URL_PATTERN = /^(?:asset:|https?:\/\/asset\.localhost\/)/i;
const HAS_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

export function sanitizeMarkdownHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const toRemove: Element[] = [];
  while (walker.nextNode()) {
    const el = walker.currentNode as Element;
    if (DANGEROUS_TAGS.has(el.tagName)) {
      toRemove.push(el);
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on') || attr.name === 'style') {
        el.removeAttribute(attr.name);
      } else if (attr.name === 'href' || attr.name === 'src' || attr.name === 'action') {
        const val = attr.value.trim();
        if (/^\s*javascript\s*:/i.test(val) || /^\s*data\s*:/i.test(val)) {
          el.removeAttribute(attr.name);
        } else if (
          attr.name === 'href' &&
          val &&
          !val.startsWith('#') &&
          !SAFE_URL_PATTERN.test(val)
        ) {
          el.removeAttribute(attr.name);
        } else if (
          (attr.name === 'src' || attr.name === 'action') &&
          val &&
          (/^\s*\/\//.test(val) ||
            (HAS_SCHEME_PATTERN.test(val) && !SAFE_RESOURCE_URL_PATTERN.test(val)))
        ) {
          el.removeAttribute(attr.name);
        }
      }
    }
  }
  for (const el of toRemove) el.remove();
  const div = document.createElement('div');
  div.appendChild(template.content.cloneNode(true));
  return div.innerHTML;
}
