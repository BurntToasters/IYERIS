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

export function sanitizeStringArray(
  value: unknown,
  maxItemLength = 4096,
  maxTotalLength = 2 * 1024 * 1024
): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  let total = 0;
  for (const item of value) {
    if (typeof item !== 'string' || item.length > maxItemLength) continue;
    if (total + item.length > maxTotalLength) break;
    result.push(item);
    total += item.length;
  }
  return result;
}
