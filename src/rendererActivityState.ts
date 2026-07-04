import { getCurrentWindow } from '@tauri-apps/api/window';
import { devLog, ignoreError } from './shared.js';

type ActivityListener = (isForeground: boolean, reason: string) => void;

let focused = typeof document !== 'undefined' ? document.hasFocus() : true;
let hidden = typeof document !== 'undefined' ? document.visibilityState === 'hidden' : false;
let initialized = false;
let dirtyRefreshReason: string | null = null;
const listeners = new Set<ActivityListener>();

export function isForeground(): boolean {
  if (!initialized) return true;
  return focused && !hidden;
}

export function isFocused(): boolean {
  if (!initialized) return true;
  return focused;
}

export function markDirtyRefresh(reason: string): void {
  dirtyRefreshReason = dirtyRefreshReason ? `${dirtyRefreshReason},${reason}` : reason;
}

/** Consume and clear any pending coalesced refresh reason. */
export function takeDirtyRefreshReason(): string | null {
  const reason = dirtyRefreshReason;
  dirtyRefreshReason = null;
  return reason;
}

export function onActivityChange(listener: ActivityListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(reason: string): void {
  const foreground = isForeground();
  if (typeof document !== 'undefined') {
    document.body.classList.toggle('app-background', !foreground);
    document.body.classList.toggle('window-inactive', !focused);
  }
  for (const listener of listeners) {
    try {
      listener(foreground, reason);
    } catch (error) {
      devLog('Activity', 'listener error', error);
    }
  }
}

/** Wire DOM focus/visibility + Tauri focus into one signal. Returns cleanup. Call once. */
export async function initActivityState(): Promise<() => void> {
  if (initialized) return () => {};
  initialized = true;

  if (typeof document !== 'undefined') {
    focused = document.hasFocus();
    hidden = document.visibilityState === 'hidden';
  }

  const onFocus = () => {
    if (focused) return;
    focused = true;
    emit('dom-focus');
  };
  const onBlur = () => {
    if (!focused) return;
    focused = false;
    emit('dom-blur');
  };
  const onVisibility = () => {
    const nextHidden = document.visibilityState === 'hidden';
    if (nextHidden === hidden) return;
    hidden = nextHidden;
    emit('visibilitychange');
  };

  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);

  let unlistenTauriFocus: (() => void) | undefined;
  try {
    unlistenTauriFocus = await getCurrentWindow().onFocusChanged(({ payload }) => {
      if (payload === focused) return;
      focused = payload;
      emit(payload ? 'tauri-focus' : 'tauri-blur');
    });
  } catch (error) {
    // DOM focus/visibility still cover the main case.
    ignoreError(error);
  }

  emit('init');

  return () => {
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
    unlistenTauriFocus?.();
    initialized = false;
  };
}
