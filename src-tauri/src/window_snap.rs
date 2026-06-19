//! Native Windows 11 "Snap Layouts" support for IYERIS's custom (frameless) titlebar.
//!
//! Tauri renders the UI inside a WebView2 child window that covers the whole
//! client area, so the top-level window never receives `WM_NCHITTEST` over our
//! HTML maximize button — and that hit-test (returning `HTMAXBUTTON`) is exactly
//! what Windows needs to show the Snap Layouts flyout on hover. This is a known
//! WebView2 limitation acknowledged by the Tauri maintainers (tauri#4531).
//!
//! The fix — the same technique used by `tauri-plugin-snap-layout` and the
//! `dunkyl/tauri-snap-layout` reference — is to place a small transparent native
//! child window directly over the maximize button. That overlay's window
//! procedure returns `HTMAXBUTTON`, so the OS shows the flyout on hover and snaps
//! on the secondary zones; a click on the button itself toggles maximize/restore.
//!
//! The frontend is the single source of truth for the button's position (it
//! already knows the layout + DPI), so it reports the button's physical-pixel
//! rect and the native side stays minimal: position the overlay, hit-test, toggle
//! maximize on click, and emit a hover event so the button can still highlight
//! (the overlay sits on top of it, so the CSS `:hover` no longer fires).
//!
//! Everything here is a no-op on non-Windows platforms.

/// Position — and lazily create — the maximize-button overlay for the calling
/// window. Coordinates are physical pixels in the window's client space; pass a
/// zero-area rect to hide the overlay (e.g. when the titlebar is not shown).
#[tauri::command]
pub fn set_snap_overlay_bounds(
    window: tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) {
    #[cfg(target_os = "windows")]
    win::set_bounds(&window, x, y, width, height);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&window, x, y, width, height);
    }
}

/// Drop a window's overlay bookkeeping when the window is destroyed. The child
/// overlay itself is destroyed automatically by the OS together with its parent.
pub fn on_window_destroyed(window: &tauri::Window) {
    #[cfg(target_os = "windows")]
    win::remove(window);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
    }
}

#[cfg(target_os = "windows")]
mod win {
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::{Mutex, OnceLock};

    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use tauri::{Emitter, WebviewWindow, Window};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, GetWindowLongPtrW, RegisterClassExW, SetWindowLongPtrW,
        SetWindowPos, ShowWindow, GWLP_USERDATA, HMENU, HTMAXBUTTON, HWND_TOP, SWP_NOACTIVATE,
        SWP_SHOWWINDOW, SW_HIDE, WINDOW_EX_STYLE, WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP,
        WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS,
    };

    /// Per-window overlay state, keyed by the parent window's `HWND` (as `isize`).
    struct Overlay {
        hwnd: isize,
        window: WebviewWindow,
        hovered: bool,
    }

    fn overlays() -> &'static Mutex<HashMap<isize, Overlay>> {
        static OVERLAYS: OnceLock<Mutex<HashMap<isize, Overlay>>> = OnceLock::new();
        OVERLAYS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn class_name() -> PCWSTR {
        w!("IyerisSnapOverlay")
    }

    fn parent_hwnd<W: HasWindowHandle>(window: &W) -> Option<isize> {
        match window.window_handle().ok()?.as_raw() {
            RawWindowHandle::Win32(handle) => Some(handle.hwnd.get()),
            _ => None,
        }
    }

    pub fn set_bounds(window: &WebviewWindow, x: i32, y: i32, width: i32, height: i32) {
        let Some(parent) = parent_hwnd(window) else {
            return;
        };
        let owned = window.clone();
        // Win32 window operations must run on the thread that owns the window;
        // Tauri commands may be dispatched on a worker thread.
        let _ = window.run_on_main_thread(move || unsafe {
            let overlay = match overlay_for(parent) {
                Some(hwnd) => hwnd,
                None => match create_overlay(parent, owned) {
                    Some(hwnd) => hwnd,
                    None => return,
                },
            };
            if width <= 0 || height <= 0 {
                let _ = ShowWindow(overlay, SW_HIDE);
            } else {
                let _ = SetWindowPos(
                    overlay,
                    HWND_TOP,
                    x,
                    y,
                    width,
                    height,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
        });
    }

    pub fn remove(window: &Window) {
        if let Some(parent) = parent_hwnd(window) {
            if let Ok(mut map) = overlays().lock() {
                map.remove(&parent);
            }
        }
    }

    fn overlay_for(parent: isize) -> Option<HWND> {
        let map = overlays().lock().ok()?;
        map.get(&parent).map(|o| HWND(o.hwnd as *mut c_void))
    }

    /// SAFETY: must be called on the window's owning (main) thread.
    unsafe fn create_overlay(parent: isize, window: WebviewWindow) -> Option<HWND> {
        ensure_class();
        let instance = HINSTANCE(GetModuleHandleW(PCWSTR::null()).ok()?.0);
        // A bare child window with no client area (the WndProc reports the whole
        // surface as HTMAXBUTTON) and no background brush: invisible but
        // hit-testable, so the HTML button shows through underneath.
        let overlay = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name(),
            PCWSTR::null(),
            WS_CHILD | WS_CLIPSIBLINGS,
            0,
            0,
            0,
            0,
            HWND(parent as *mut c_void),
            HMENU::default(),
            instance,
            None,
        )
        .ok()?;
        // Stash the parent handle so the overlay's WndProc can find its state.
        SetWindowLongPtrW(overlay, GWLP_USERDATA, parent);
        if let Ok(mut map) = overlays().lock() {
            map.insert(
                parent,
                Overlay {
                    hwnd: overlay.0 as isize,
                    window,
                    hovered: false,
                },
            );
        }
        Some(overlay)
    }

    /// SAFETY: must be called on the main thread.
    unsafe fn ensure_class() {
        static REGISTERED: OnceLock<bool> = OnceLock::new();
        REGISTERED.get_or_init(|| {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(overlay_proc),
                hInstance: HINSTANCE(GetModuleHandleW(PCWSTR::null()).unwrap_or_default().0),
                lpszClassName: class_name(),
                ..Default::default()
            };
            RegisterClassExW(&class);
            true
        });
    }

    fn window_for(overlay: HWND) -> Option<WebviewWindow> {
        let parent = unsafe { GetWindowLongPtrW(overlay, GWLP_USERDATA) };
        let map = overlays().lock().ok()?;
        map.get(&parent).map(|o| o.window.clone())
    }

    /// Updates the cached hover flag; returns true only when it actually changes,
    /// so we emit one event per enter/leave instead of per mouse-move.
    fn set_hovered(overlay: HWND, hovered: bool) -> bool {
        let parent = unsafe { GetWindowLongPtrW(overlay, GWLP_USERDATA) };
        let mut map = match overlays().lock() {
            Ok(map) => map,
            Err(_) => return false,
        };
        match map.get_mut(&parent) {
            Some(entry) if entry.hovered != hovered => {
                entry.hovered = hovered;
                true
            }
            _ => false,
        }
    }

    unsafe extern "system" fn overlay_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            // Reporting the whole overlay as the maximize button is what makes
            // Windows 11 show the Snap Layouts flyout while hovering it.
            WM_NCHITTEST => return LRESULT(HTMAXBUTTON as isize),
            // Swallow the press; act on release like a normal caption button.
            WM_NCLBUTTONDOWN => return LRESULT(0),
            WM_NCLBUTTONUP => {
                if let Some(window) = window_for(hwnd) {
                    let maximized = window.is_maximized().unwrap_or(false);
                    let _ = if maximized {
                        window.unmaximize()
                    } else {
                        window.maximize()
                    };
                }
                return LRESULT(0);
            }
            WM_NCMOUSEMOVE => {
                if set_hovered(hwnd, true) {
                    if let Some(window) = window_for(hwnd) {
                        let _ = window.emit("snap-max-hover", true);
                    }
                    // Re-arm leave tracking so we learn when the cursor exits.
                    let mut track = TRACKMOUSEEVENT {
                        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                        dwFlags: TME_LEAVE | TME_NONCLIENT,
                        hwndTrack: hwnd,
                        dwHoverTime: 0,
                    };
                    let _ = TrackMouseEvent(&mut track);
                }
                return LRESULT(0);
            }
            WM_NCMOUSELEAVE => {
                if set_hovered(hwnd, false) {
                    if let Some(window) = window_for(hwnd) {
                        let _ = window.emit("snap-max-hover", false);
                    }
                }
            }
            _ => {}
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}
