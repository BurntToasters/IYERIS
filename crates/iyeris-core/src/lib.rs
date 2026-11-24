//! Framework-free core logic for IYERIS v4.
//!
//! This crate must not depend on Tauri or any webview. Host applications supply
//! directories through [`PathProvider`] and receive events through [`EventSink`].

pub mod cancellation;
// Windows and macOS signature inspection calls into FFI.
#[allow(unsafe_code)]
pub mod code_signature;
// The OS-facing modules call into FFI, which needs `unsafe`. Allow it there
// only; the workspace lint still warns everywhere else.
#[allow(unsafe_code)]
pub mod copy_metadata;
#[allow(unsafe_code)]
pub mod elevated;
pub mod error;
#[allow(unsafe_code)]
pub mod file_operations;
pub mod fs_utils;
pub mod launch;
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
pub mod native_macos;
#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
pub mod native_windows;
pub mod paths;
pub mod platform;
pub mod recovery;
pub mod seams;
pub mod state;
pub mod undo;

pub use error::CoreError;
pub use paths::{
    atomic_replace_file, create_secure_temp_file, ensure_app_state_directory,
    ensure_no_symlink_components, ensure_not_root_path, ensure_real_directory_tree, is_dev_mode,
    make_temp_path, set_dev_mode, validate_existing_path, validate_path,
};
pub use seams::{
    EventSink, FixedPathProvider, NullSink, PathProvider, RecordingSink, StdPathProvider,
    APP_IDENTIFIER,
};
pub use state::{ClipboardState, CoreState, DragState};
