const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
};
const ESCAPE_RE = /[&<>"']/g;
const escapeReplacer = (m: string): string => ESCAPE_MAP[m];

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

const IS_DEV_MODE = typeof process !== 'undefined' && (process.argv || []).includes('--dev');

export function ignoreError(error: unknown): void {
  if (IS_DEV_MODE) {
    console.debug('[Ignored error]', error);
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
