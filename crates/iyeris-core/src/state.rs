//! Mutable state shared by core file operations.
//!
//! Ported from `ClipboardState` and `DragState` in `src-tauri/src/main.rs`.
//! The watcher, zoom and tray fields of the v3 `AppState` are Tauri-only and
//! stay in the v3 app.

use std::sync::Mutex;

/// Internal clipboard: the pending operation and the paths it applies to.
#[derive(Debug, Default)]
pub struct ClipboardState {
    pub operation: Option<String>,
    pub paths: Vec<String>,
}

/// Paths currently being dragged out of the app.
#[derive(Debug, Default)]
pub struct DragState {
    pub paths: Vec<String>,
}

/// State handed to core file operations in place of the v3 Tauri-managed app state.
#[derive(Debug, Default)]
pub struct CoreState {
    pub clipboard: Mutex<ClipboardState>,
    pub drag: Mutex<DragState>,
}
