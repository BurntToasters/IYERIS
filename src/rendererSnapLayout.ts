import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Windows 11 Snap Layouts. WebView2 swallows the OS hit-test (WM_NCHITTEST) that
// the Snap flyout needs, so a transparent native overlay is placed over the
// maximize button (see src-tauri/src/window_snap.rs). The button's position +
// DPI only live here in the renderer, so we report its physical-pixel rect to the
// native side. The native overlay also intercepts the click (toggling maximize)
// and emits hover, since sitting on top of the button suppresses its CSS :hover.
// Windows-only; a no-op everywhere else.
export function initSnapLayout(register: (cleanup: () => void) => void): void {
  if (!document.body.classList.contains('platform-win32')) return;
  const maxBtn = document.getElementById('maximize-btn');
  if (!maxBtn) return;

  let frame = 0;
  const report = (): void => {
    frame = 0;
    const rect = maxBtn.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const visible = rect.width > 0 && rect.height > 0 && maxBtn.offsetParent !== null;
    invoke('set_snap_overlay_bounds', {
      x: visible ? Math.round(rect.left * dpr) : 0,
      y: visible ? Math.round(rect.top * dpr) : 0,
      width: visible ? Math.round(rect.width * dpr) : 0,
      height: visible ? Math.round(rect.height * dpr) : 0,
    }).catch(() => {});
  };
  const scheduleReport = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(report);
  };

  listen<boolean>('snap-max-hover', (event) => {
    maxBtn.classList.toggle('snap-hover', event.payload === true);
  })
    .then((unlisten) => register(unlisten))
    .catch(() => {});

  const resizeObserver = new ResizeObserver(scheduleReport);
  resizeObserver.observe(maxBtn);
  if (maxBtn.parentElement) resizeObserver.observe(maxBtn.parentElement);
  window.addEventListener('resize', scheduleReport);
  register(() => {
    resizeObserver.disconnect();
    window.removeEventListener('resize', scheduleReport);
    if (frame) cancelAnimationFrame(frame);
  });

  scheduleReport();
}
