#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod archive;
mod cancellation;
mod copy_metadata;
mod directory;
mod elevated;
mod file_operations;
mod fs_utils;
mod indexer;
#[cfg(target_os = "macos")]
mod native_macos;
#[cfg(target_os = "windows")]
mod native_windows;
mod platform;
mod recovery;
mod search;
mod settings;
mod system;
mod thumbnails;
mod undo;
mod watcher;
mod window_snap;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);
static DEV_MODE: AtomicBool = AtomicBool::new(false);

pub(crate) fn is_dev_mode() -> bool {
    DEV_MODE.load(Ordering::Relaxed)
}

pub(crate) struct ClipboardState {
    pub operation: Option<String>,
    pub paths: Vec<String>,
}

pub(crate) struct DragState {
    pub paths: Vec<String>,
}

pub(crate) struct AppState {
    pub clipboard: Mutex<ClipboardState>,
    pub drag: Mutex<DragState>,
    pub watchers: Mutex<HashMap<String, watcher::DirectoryWatcher>>,
    pub zoom_levels: Mutex<HashMap<String, f64>>,
    pub tray: Mutex<Option<tauri::tray::TrayIcon>>,
}

pub(crate) fn make_temp_path(path: &Path, purpose: &str) -> PathBuf {
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let suffix = format!("{}.{}.{}.tmp", purpose, pid, counter);
    let extension = match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if !ext.is_empty() => format!("{}.{}", ext, suffix),
        _ => suffix,
    };
    path.with_extension(extension)
}

/// Reserve a unique temporary sibling without following a pre-existing
/// symlink. Callers must keep the returned file handle until they are ready to
/// write; the path is only used for the final atomic rename/cleanup.
pub(crate) fn create_secure_temp_file(
    path: &Path,
    purpose: &str,
) -> Result<(PathBuf, std::fs::File), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Temporary file has no parent directory".to_string())?;
    let parent_metadata = std::fs::symlink_metadata(parent).map_err(|error| {
        format!(
            "Failed to inspect temporary-file parent {}: {}",
            parent.display(),
            error
        )
    })?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err(format!(
            "Temporary-file parent is not a real directory: {}",
            parent.display()
        ));
    }
    for _ in 0..32 {
        let candidate = make_temp_path(path, purpose);
        match std::fs::OpenOptions::new()
            .write(true)
            .read(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to create secure temporary file {}: {}",
                    candidate.display(),
                    error
                ));
            }
        }
    }
    Err("Unable to reserve a unique temporary file".to_string())
}

/// Publish a fully-written temporary file over a regular destination.
///
/// `std::fs::rename` replaces an existing file on Unix, but returns
/// `AlreadyExists` on Windows. Keep the replacement atomic on both platforms
/// so settings, indexes, thumbnails, and native integration files can be
/// refreshed repeatedly without a delete-then-write gap.
pub(crate) fn atomic_replace_file(temp: &Path, destination: &Path) -> Result<(), String> {
    if let Ok(metadata) = std::fs::symlink_metadata(destination) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!(
                "Refusing to replace unsafe destination: {}",
                destination.display()
            ));
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let from: Vec<u16> = temp
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let to: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: both buffers are valid, NUL-terminated UTF-16 strings owned
        // for the duration of the call.
        unsafe {
            MoveFileExW(
                PCWSTR(from.as_ptr()),
                PCWSTR(to.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|error| format!("Failed to publish {}: {}", destination.display(), error))
    }

    #[cfg(not(windows))]
    {
        std::fs::rename(temp, destination)
            .map_err(|error| format!("Failed to publish {}: {}", destination.display(), error))
    }
}

/// Ensure a directory exists without traversing a symlinked component. The
/// standard `create_dir_all` follows symlinks in existing parents, which is
/// unsafe for app-owned state paths that may be redirected by another local
/// process. Create missing components one at a time and lstat each result.
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub(crate) fn ensure_real_directory_tree(path: &Path, label: &str) -> Result<(), String> {
    let mut missing = Vec::new();
    let mut cursor = path;
    let existing = loop {
        match std::fs::symlink_metadata(cursor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "{} is not a real directory: {}",
                        label,
                        cursor.display()
                    ));
                }
                break cursor;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = cursor
                    .file_name()
                    .ok_or_else(|| format!("Cannot determine {} parent directory", label))?;
                missing.push(name.to_os_string());
                cursor = cursor
                    .parent()
                    .ok_or_else(|| format!("Cannot determine {} parent directory", label))?;
            }
            Err(error) => {
                return Err(format!("Cannot inspect {}: {}", label, error));
            }
        }
    };

    ensure_no_symlink_components(existing, label)?;
    let mut current = existing.to_path_buf();
    for component in missing.iter().rev() {
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "{} is not a real directory: {}",
                        label,
                        current.display()
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current).map_err(|create_error| {
                    format!(
                        "Failed to create {} {}: {}",
                        label,
                        current.display(),
                        create_error
                    )
                })?;
                let metadata = std::fs::symlink_metadata(&current).map_err(|e| e.to_string())?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "{} changed into an unsafe path: {}",
                        label,
                        current.display()
                    ));
                }
            }
            Err(error) => {
                return Err(format!("Cannot inspect {}: {}", label, error));
            }
        }
    }
    Ok(())
}

/// Reject a path that traverses any symbolic-link component. This is used for
/// app-owned state paths where accepting a directory symlink could redirect a
/// write outside the location the application selected. Callers pass an
/// existing path (normally a parent directory), so every ancestor can be
/// inspected with lstat semantics.
pub(crate) fn ensure_no_symlink_components(path: &Path, label: &str) -> Result<(), String> {
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!("{} path contains a parent traversal", label));
    }

    let mut current = path;
    loop {
        let metadata = std::fs::symlink_metadata(current).map_err(|error| {
            format!(
                "Cannot inspect {} path {}: {}",
                label,
                current.display(),
                error
            )
        })?;
        #[cfg(target_os = "macos")]
        let system_alias = matches!(current.to_str(), Some("/var" | "/tmp" | "/etc"))
            && std::fs::read_link(current).ok().is_some_and(|target| {
                target == Path::new("private").join(current.file_name().unwrap_or_default())
                    || target == Path::new("/private").join(current.file_name().unwrap_or_default())
            });
        #[cfg(not(target_os = "macos"))]
        let system_alias = false;
        if metadata.file_type().is_symlink() && !system_alias {
            return Err(format!(
                "{} path traverses a symbolic link: {}",
                label,
                current.display()
            ));
        }
        if current.parent().is_none() || current.parent() == Some(current) {
            break;
        }
        current = current.parent().expect("parent checked above");
    }
    Ok(())
}

/// Create an application-state directory tree and return its canonical path.
///
/// Unlike user-selected paths, app-state roots may legitimately be redirected
/// by the OS (for example a home directory backed by a symlink, or a Windows
/// junction for AppData). Those trusted ancestor links must be allowed, but the
/// final state directory itself must be a real directory: accepting a
/// symlink/reparse point there would let another local process redirect
/// settings, index, or thumbnail writes after startup.
pub(crate) fn ensure_app_state_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create {} {}: {}", label, path.display(), error))?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Cannot inspect {} {}: {}", label, path.display(), error))?;
    if metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
        || !metadata.is_dir()
    {
        return Err(format!(
            "{} is not a real directory: {}",
            label,
            path.display()
        ));
    }
    path.canonicalize()
        .map_err(|error| format!("Cannot resolve {} {}: {}", label, path.display(), error))
}

#[cfg(target_os = "windows")]
fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(target_os = "windows"))]
fn metadata_is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

pub(crate) fn validate_path(raw: &str, label: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err(format!("{} path is required", label));
    }
    // IPC callers can otherwise force every path-taking command to copy and
    // log arbitrarily large strings before the OS rejects them. Keep a
    // generous cross-platform bound (well above native path limits) and
    // reject embedded NULs before constructing a PathBuf.
    const MAX_PATH_BYTES: usize = 1024 * 1024;
    if raw.len() > MAX_PATH_BYTES {
        return Err(format!(
            "{} path exceeds the {} byte limit",
            label, MAX_PATH_BYTES
        ));
    }
    if raw.contains('\0') {
        return Err(format!("{} path contains a NUL character", label));
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!("{} path must be absolute: {}", label, raw));
    }
    Ok(path)
}

pub(crate) fn validate_existing_path(raw: &str, label: &str) -> Result<PathBuf, String> {
    let path = validate_path(raw, label)?;
    match std::fs::symlink_metadata(&path) {
        Ok(_) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("{} path does not exist: {}", label, path.display()))
        }
        Err(error) => Err(format!(
            "Failed to access {} path {}: {}",
            label,
            path.display(),
            error
        )),
    }
}

pub(crate) fn ensure_not_root_path(path: &Path, action: &str) -> Result<(), String> {
    let canonical = match path.canonicalize() {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Copy/move destinations may not exist yet. Resolve the nearest
            // existing parent without falling back to the raw path; reject
            // symlink ancestors so a later privileged/mutating call cannot be
            // redirected through a swapped parent.
            let mut missing = Vec::new();
            let mut cursor = path;
            let existing = loop {
                match std::fs::symlink_metadata(cursor) {
                    Ok(metadata) => {
                        if metadata.file_type().is_symlink() || !metadata.is_dir() {
                            return Err(format!(
                                "Cannot safely resolve path before attempting to {}",
                                action
                            ));
                        }
                        break cursor;
                    }
                    Err(next_error) if next_error.kind() == std::io::ErrorKind::NotFound => {
                        let name = cursor.file_name().ok_or_else(|| {
                            format!("Cannot safely resolve path before attempting to {}", action)
                        })?;
                        missing.push(name.to_os_string());
                        cursor = cursor.parent().ok_or_else(|| {
                            format!("Cannot safely resolve path before attempting to {}", action)
                        })?;
                    }
                    Err(next_error) => {
                        return Err(format!(
                            "Cannot safely resolve path before attempting to {}: {}",
                            action, next_error
                        ));
                    }
                }
            };
            let mut resolved = existing.canonicalize().map_err(|resolve_error| {
                format!(
                    "Cannot safely resolve path before attempting to {}: {}",
                    action, resolve_error
                )
            })?;
            for component in missing.iter().rev() {
                resolved.push(component);
            }
            resolved
        }
        Err(error) => {
            return Err(format!(
                "Cannot safely resolve path before attempting to {}: {}",
                action, error
            ));
        }
    };
    if canonical.parent().is_none() {
        return Err(format!("Cannot {} a root directory", action));
    }
    Ok(())
}

fn early_settings_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var("APPDATA").ok().map(PathBuf::from);

    #[cfg(target_os = "macos")]
    let base = std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join("Library").join("Application Support"));

    #[cfg(target_os = "linux")]
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .map(|h| PathBuf::from(h).join(".local").join("share"))
        });

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let base: Option<PathBuf> = None;

    base.map(|b| b.join("run.rosie.iyeris").join("settings.json"))
}

fn read_early_setting_bool(key: &str) -> bool {
    early_settings_path()
        .and_then(|path| {
            let file = file_operations::open_regular_read(&path).ok()?;
            let size = file.metadata().ok()?.len();
            const MAX_EARLY_SETTINGS_BYTES: u64 = 8 * 1024 * 1024;
            if size > MAX_EARLY_SETTINGS_BYTES {
                return None;
            }
            let mut content = String::with_capacity(size as usize);
            file.take(MAX_EARLY_SETTINGS_BYTES.saturating_add(1))
                .read_to_string(&mut content)
                .ok()?;
            (content.len() as u64 <= MAX_EARLY_SETTINGS_BYTES).then_some(content)
        })
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|json| json.get(key).and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

fn has_minimized_launch_arg(args: &[String]) -> bool {
    args.iter().any(|a| a == "--minimized" || a == "--hidden")
}

/// Set environment variables that must be configured before any threads are spawned.
fn setup_environment(disable_hw_accel: bool, dev_mode: bool) {
    #[cfg(target_os = "windows")]
    {
        if dev_mode {
            use windows::Win32::System::Console::{
                AllocConsole, AttachConsole, ATTACH_PARENT_PROCESS,
            };
            unsafe {
                if AttachConsole(ATTACH_PARENT_PROCESS).is_err() {
                    let _ = AllocConsole();
                }
            }
        }
        if disable_hw_accel {
            // Preserve any WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS set externally; only append --disable-gpu.
            let existing =
                std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
            let existing = existing.trim();
            let args = if existing.is_empty() {
                "--disable-gpu".to_string()
            } else if existing.split_whitespace().any(|a| a == "--disable-gpu") {
                existing.to_string()
            } else {
                format!("{existing} --disable-gpu")
            };
            unsafe {
                std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
            }
        }
    }

    // Must run before env_logger init to avoid set_var in a multi-threaded context
    #[cfg(target_os = "linux")]
    {
        if std::env::var("GDK_BACKEND").is_err() {
            unsafe { std::env::set_var("GDK_BACKEND", "x11") };
        }
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            let has_nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
            if disable_hw_accel || !has_nvidia {
                unsafe { std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1") };
            }
        }
    }

    // Suppress unused parameter warnings on platforms that don't use them.
    let _ = (disable_hw_accel, dev_mode);
}

/// M7: returns a path passed in argv to a single-instance / startup launch,
/// after additional sanity checks. Previously any absolute existing path was
/// accepted; the frontend would then navigate the user to whatever showed up.
/// We now also:
///  * reject NUL bytes and non-whitespace control characters
///  * canonicalize and require the target to exist
///
/// Arguments arrive through argv rather than a shell, so shell-looking
/// characters (and newlines, which are valid filenames) are allowed.
fn first_open_path_arg(args: &[String]) -> Option<String> {
    for arg in args.iter().skip(1) {
        if arg.starts_with("--") {
            continue;
        }
        if arg
            .chars()
            .any(|c| c == '\0' || (c.is_control() && !matches!(c, '\t' | '\n' | '\r')))
        {
            log::warn!("[SingleInstance] rejecting arg with control character");
            continue;
        }
        let path = std::path::Path::new(arg);
        if !path.is_absolute() {
            continue;
        }
        match path.canonicalize() {
            Ok(canonical) if canonical.exists() => {
                return Some(canonical.to_string_lossy().to_string());
            }
            _ => continue,
        }
    }
    None
}

fn setup_native_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let handle = app.handle();
    let file = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &MenuItem::with_id(
                handle,
                "new-window",
                "New Window",
                true,
                Some("CmdOrCtrl+N"),
            )?,
            &MenuItem::with_id(handle, "new-tab", "New Tab", true, Some("CmdOrCtrl+T"))?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "new-file", "New File", true, None::<&str>)?,
            &MenuItem::with_id(
                handle,
                "new-folder",
                "New Folder",
                true,
                Some("CmdOrCtrl+Shift+N"),
            )?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &MenuItem::with_id(handle, "copy", "Copy", true, Some("CmdOrCtrl+C"))?,
            &MenuItem::with_id(handle, "cut", "Cut", true, Some("CmdOrCtrl+X"))?,
            &MenuItem::with_id(handle, "paste", "Paste", true, Some("CmdOrCtrl+V"))?,
            &MenuItem::with_id(handle, "rename", "Rename", true, Some("F2"))?,
            &MenuItem::with_id(handle, "delete", "Delete", true, Some("Delete"))?,
        ],
    )?;
    let view = Submenu::with_items(
        handle,
        "View",
        true,
        &[
            &MenuItem::with_id(handle, "view-grid", "Grid", true, Some("CmdOrCtrl+1"))?,
            &MenuItem::with_id(handle, "view-list", "List", true, Some("CmdOrCtrl+2"))?,
            &MenuItem::with_id(handle, "view-column", "Column", true, Some("CmdOrCtrl+3"))?,
            &MenuItem::with_id(
                handle,
                "dual-pane",
                "Dual Pane",
                true,
                Some("CmdOrCtrl+Shift+D"),
            )?,
            &MenuItem::with_id(handle, "refresh", "Refresh", true, Some("F5"))?,
        ],
    )?;
    let go = Submenu::with_items(
        handle,
        "Go",
        true,
        &[
            &MenuItem::with_id(handle, "back", "Back", true, Some("Alt+Left"))?,
            &MenuItem::with_id(handle, "forward", "Forward", true, Some("Alt+Right"))?,
            &MenuItem::with_id(handle, "up", "Up", true, Some("Alt+Up"))?,
            &MenuItem::with_id(handle, "home", "Home", true, Some("CmdOrCtrl+H"))?,
        ],
    )?;
    let tools = Submenu::with_items(
        handle,
        "Tools",
        true,
        &[
            &MenuItem::with_id(
                handle,
                "command-palette",
                "Command Palette",
                true,
                Some("CmdOrCtrl+Shift+P"),
            )?,
            &MenuItem::with_id(
                handle,
                "find-duplicates",
                "Find Duplicates",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(handle, "settings", "Settings", true, Some("CmdOrCtrl+,"))?,
        ],
    )?;
    let window = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
    )?;
    let help = Submenu::with_items(
        handle,
        "Help",
        true,
        &[&MenuItem::with_id(
            handle,
            "shortcuts",
            "Keyboard Shortcuts",
            true,
            Some("CmdOrCtrl+/"),
        )?],
    )?;
    let menu = Menu::with_items(handle, &[&file, &edit, &view, &go, &tools, &window, &help])?;
    app.set_menu(menu)?;
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(result) = elevated::handle_transfer_helper(&args) {
        match result {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    let dev_mode = args.iter().any(|a| a == "--dev" || a == "--verbose");
    #[allow(unused_mut)]
    let mut start_minimized = has_minimized_launch_arg(&args);
    DEV_MODE.store(dev_mode, Ordering::Relaxed);

    #[cfg(target_os = "macos")]
    {
        let early_start_on_login = read_early_setting_bool("startOnLogin");

        if !start_minimized && early_start_on_login {
            let uptime = native_macos::system_uptime_seconds();
            if uptime < 120 {
                log::info!(
                    "[Autostart] startOnLogin fallback: uptime {}s < 120s, starting minimized",
                    uptime
                );
                start_minimized = true;
            }
        }
    }

    let _disable_hw_accel = read_early_setting_bool("disableHardwareAcceleration");

    setup_environment(_disable_hw_accel, dev_mode);

    if dev_mode {
        let mut builder = env_logger::Builder::new();
        builder
            .filter_level(log::LevelFilter::Debug)
            .format(|buf, record| {
                writeln!(
                    buf,
                    "[{} {} {}:{}] {}",
                    chrono::Local::now().format("%H:%M:%S%.3f"),
                    record.level(),
                    record.file().unwrap_or("?"),
                    record.line().unwrap_or(0),
                    record.args(),
                )
            })
            .init();
        log::info!("IYERIS dev mode enabled (args: {:?})", args);
        log::info!(
            "Platform: {} / {} / v{}",
            std::env::consts::OS,
            std::env::consts::ARCH,
            env!("CARGO_PKG_VERSION"),
        );
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            #[cfg(target_os = "macos")]
            if has_minimized_launch_arg(&_args) {
                log::debug!("[SingleInstance] Ignoring minimized relaunch request");
                return;
            }

            #[cfg(target_os = "macos")]
            {
                let _ = app.set_dock_visibility(true);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                if let Some(open_path) = first_open_path_arg(&_args) {
                    if let Err(e) = window.emit("native-open-path", open_path) {
                        log::warn!("[SingleInstance] emit native-open-path failed: {}", e);
                    }
                }
            } else {
                let windows = app.webview_windows();
                let target = windows
                    .values()
                    .find(|w| w.is_visible().unwrap_or(false))
                    .or_else(|| windows.values().next());
                if let Some(w) = target {
                    let _ = w.show();
                    let _ = w.set_focus();
                    if let Some(open_path) = first_open_path_arg(&_args) {
                        if let Err(e) = w.emit("native-open-path", open_path) {
                            log::warn!("[SingleInstance] emit native-open-path failed: {}", e);
                        }
                    }
                }
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ));

    match builder
        .manage(AppState {
            clipboard: Mutex::new(ClipboardState {
                operation: None,
                paths: vec![],
            }),
            drag: Mutex::new(DragState { paths: vec![] }),
            watchers: Mutex::new(HashMap::new()),
            zoom_levels: Mutex::new(HashMap::new()),
            tray: Mutex::new(None),
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            let windows = app.webview_windows();
            let focused_window = windows
                .values()
                .find(|window| window.is_focused().unwrap_or(false))
                .cloned();
            if let Some(window) = focused_window.or_else(|| app.get_webview_window("main")) {
                if let Err(e) = window.emit("native-menu-command", id) {
                    log::warn!("[Menu] emit failed: {}", e);
                }
            } else {
                for window in windows.values() {
                    if let Err(e) = window.emit("native-menu-command", id.clone()) {
                        log::warn!("[Menu] emit failed: {}", e);
                    }
                }
            }
        })
        .setup(move |app| {
            log::debug!("[Setup] App setup starting");
            let settings_json =
                settings::get_settings_sync(app.handle().clone()).unwrap_or_else(|err| {
                    log::warn!(
                        "[Setup] Failed to read settings: {}; falling back to defaults",
                        err
                    );
                    "{}".to_string()
                });
            log::debug!("[Setup] Settings loaded ({} bytes)", settings_json.len());
            // L3: explicitly distinguish "valid JSON" from "fell back to {}"
            // so a malformed settings file produces a warning instead of
            // silently losing user preferences.
            let settings_value = match serde_json::from_str::<serde_json::Value>(&settings_json) {
                Ok(v) => v,
                Err(err) => {
                    log::warn!(
                        "[Setup] Settings file is not valid JSON ({}); using defaults",
                        err
                    );
                    serde_json::Value::default()
                }
            };

            match app.path().app_data_dir() {
                Ok(app_data_dir) => {
                    if let Err(error) = recovery::initialize_app_data(&app_data_dir) {
                        log::error!(
                            "[Setup] Transfer recovery is unavailable; transfers will fail closed: {}",
                            error
                        );
                    }
                }
                Err(error) => {
                    let message = format!("Cannot resolve application data directory: {}", error);
                    recovery::set_initialization_error(message.clone());
                    log::error!(
                        "[Setup] Transfer recovery is unavailable; transfers will fail closed: {}",
                        message
                    );
                }
            }

            let additional_index_locations = match settings_value.get("additionalIndexLocations") {
                None | Some(serde_json::Value::Null) => Vec::new(),
                Some(serde_json::Value::Array(values)) => {
                    let parsed = values.iter().map(serde_json::Value::as_str).collect::<Option<Vec<_>>>();
                    match parsed {
                        Some(locations) => locations.into_iter().map(str::to_string).collect(),
                        None => {
                            log::warn!("[Setup] additionalIndexLocations contains non-string values; using defaults");
                            Vec::new()
                        }
                    }
                }
                Some(_) => {
                    log::warn!("[Setup] additionalIndexLocations is not an array; using defaults");
                    Vec::new()
                }
            };
            if let Err(error) = indexer::set_additional_index_locations(additional_index_locations) {
                log::warn!("[Setup] Additional index locations were rejected; using defaults: {}", error);
                let _ = indexer::set_additional_index_locations(Vec::new());
            }

            let native_menu_enabled = settings_value
                .get("nativeMenuEnabled")
                .and_then(|flag| flag.as_bool())
                .unwrap_or(true);
            if native_menu_enabled {
                if let Err(error) = setup_native_menu(app) {
                    log::warn!("[Setup] Native menu setup failed: {}", error);
                }
            } else {
                log::debug!("[Setup] Native menu disabled by settings");
            }

            #[cfg(not(target_os = "macos"))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                    log::debug!("[Setup] Disabled decorations for custom titlebar");
                }
            }

            if start_minimized {
                log::debug!("[Setup] Started minimized to tray");
                #[cfg(target_os = "macos")]
                {
                    let _ = app.handle().set_dock_visibility(false);
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                log::debug!("[Setup] Showing main window");
            }
            if let Some(open_path) = first_open_path_arg(&args) {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = window.emit("native-open-path", open_path) {
                        log::warn!("[Setup] emit native-open-path failed: {}", e);
                    }
                }
            }

            match system::setup_tray(app) {
                Ok(tray) => {
                    let state = app.state::<AppState>();
                    if let Ok(mut guard) = state.tray.lock() {
                        *guard = Some(tray);
                    };
                    log::debug!("[Setup] System tray initialized");
                }
                Err(error) => {
                    log::warn!("[Setup] Tray setup failed: {}", error);
                    if let Some(window) = app.get_webview_window("main") {
                        use tauri::Emitter;
                        let _ = window.emit(
                            "tray-setup-failed",
                            serde_json::json!({ "error": error.to_string() }),
                        );
                    }
                }
            }
            let start_on_login = settings_value
                .get("startOnLogin")
                .and_then(|f| f.as_bool())
                .unwrap_or(false);
            if !cfg!(debug_assertions) {
                use tauri_plugin_autostart::ManagerExt;
                if start_on_login {
                    let _ = app.autolaunch().enable();
                } else {
                    let _ = app.autolaunch().disable();
                }
            }

            let enable_indexer = settings_value
                .get("enableIndexer")
                .and_then(|flag| flag.as_bool())
                .unwrap_or(true);

            if enable_indexer {
                indexer::set_enabled(true, None);
                indexer::initialize_index(app.handle());
                log::debug!("[Setup] File indexer initialized");
            } else {
                indexer::set_enabled(false, Some(app.handle()));
                log::debug!("[Setup] File indexer disabled by settings");
            }
            log::info!("[Setup] App setup complete");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Only hide-to-tray the LAST visible window; let others close normally.
                if system::should_minimize_to_tray(window.app_handle())
                    && !system::has_other_visible_windows(window.app_handle(), window.label())
                {
                    api.prevent_close();
                    let _ = window.hide();
                    #[cfg(target_os = "macos")]
                    {
                        let _ = window.app_handle().hide();
                        let _ = window.app_handle().set_dock_visibility(false);
                    }
                }
            }
            if let tauri::WindowEvent::Focused(false) = event {
                system::record_focus_lost();
            }
            if let tauri::WindowEvent::Destroyed = event {
                window_snap::on_window_destroyed(window);
                let app = window.app_handle();
                if system::should_minimize_to_tray(app)
                    && !system::has_other_visible_windows(app, window.label())
                {
                    #[cfg(target_os = "macos")]
                    {
                        let _ = app.set_dock_visibility(false);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Directory operations
            directory::get_directory_contents,
            directory::cancel_directory_contents,
            directory::get_drives,
            directory::get_drive_info,
            directory::get_home_directory,
            directory::get_special_directory,
            directory::get_disk_space,
            directory::calculate_folder_size,
            directory::cancel_folder_size_calculation,
            // File operations
            file_operations::open_file,
            file_operations::create_folder,
            file_operations::create_file,
            file_operations::delete_item,
            file_operations::trash_item,
            file_operations::open_trash,
            file_operations::rename_item,
            file_operations::copy_items,
            file_operations::move_items,
            file_operations::cancel_file_operation,
            recovery::list_transfer_recovery,
            recovery::acknowledge_transfer_recovery,
            file_operations::get_item_properties,
            file_operations::set_permissions,
            file_operations::set_attributes,
            file_operations::read_file_content,
            file_operations::get_file_data_url,
            file_operations::batch_rename,
            file_operations::create_symlink,
            file_operations::resolve_shortcut,
            // Clipboard & drag
            file_operations::set_clipboard,
            file_operations::get_clipboard,
            file_operations::get_system_clipboard_data,
            file_operations::get_system_clipboard_files,
            file_operations::write_to_system_clipboard,
            file_operations::set_drag_data,
            file_operations::get_drag_data,
            file_operations::clear_drag_data,
            // Search
            search::search_files,
            search::search_files_content,
            search::search_files_content_global,
            search::cancel_search,
            search::search_index,
            search::rebuild_index,
            search::get_index_status,
            // Archive
            archive::compress_files,
            archive::extract_archive,
            archive::cancel_archive_operation,
            archive::list_archive_contents,
            archive::get_embedded_office_thumbnail,
            // Settings
            settings::get_settings,
            settings::save_settings,
            settings::reset_settings,
            settings::get_settings_path,
            settings::get_home_settings,
            settings::save_home_settings,
            settings::reset_home_settings,
            settings::get_home_settings_path,
            // System & platform
            system::get_platform,
            system::get_system_accent_color,
            system::get_system_text_scale,
            system::is_dev_mode,
            system::is_mas,
            system::is_flatpak,
            system::is_snap,
            system::is_ms_store,
            system::is_msi,
            system::minimize_window,
            system::maximize_window,
            system::close_window,
            system::open_new_window,
            system::set_zoom_level,
            system::get_zoom_level,
            system::open_terminal,
            system::get_app_version,
            system::relaunch_app,
            system::get_licenses,
            system::get_logs_path,
            system::open_logs_folder,
            system::export_diagnostics,
            system::get_log_file_content,
            system::share_items,
            system::set_autostart,
            system::get_autostart,
            system::check_full_disk_access,
            system::request_full_disk_access,
            system::get_open_with_apps,
            system::open_file_with_app,
            system::launch_desktop_entry,
            system::get_native_integration_status,
            system::install_native_integration,
            system::uninstall_native_integration,
            // Elevated operations
            elevated::elevated_copy,
            elevated::elevated_move,
            elevated::elevated_delete,
            elevated::elevated_rename,
            elevated::elevated_copy_batch,
            elevated::elevated_move_batch,
            elevated::elevated_delete_batch,
            elevated::restart_as_admin,
            // Thumbnails
            thumbnails::get_cached_thumbnail,
            thumbnails::save_cached_thumbnail,
            thumbnails::clear_thumbnail_cache,
            thumbnails::get_thumbnail_cache_size,
            // File watcher
            watcher::watch_directory,
            watcher::unwatch_directory,
            // Git
            platform::get_git_status,
            platform::get_git_branch,
            // Checksum
            file_operations::calculate_checksum,
            file_operations::cancel_checksum_calculation,
            file_operations::find_duplicate_files,
            // Undo/redo
            undo::undo_action,
            undo::redo_action,
            undo::get_undo_redo_state,
            // Window / Snap Layouts (Windows)
            window_snap::set_snap_overlay_bounds,
        ])
        .build(tauri::generate_context!())
    {
        Ok(app) => {
            #[cfg(target_os = "macos")]
            let launched_minimized_at_start = start_minimized;
            #[cfg(target_os = "macos")]
            let launch_instant = std::time::Instant::now();

            app.run(move |app_handle, event| {
                #[cfg(target_os = "macos")]
                if let tauri::RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } = event
                {
                    if launched_minimized_at_start
                        && launch_instant.elapsed() < std::time::Duration::from_secs(10)
                    {
                        return;
                    }
                    if !has_visible_windows {
                        let _ = app_handle.set_dock_visibility(true);
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                if let tauri::RunEvent::Exit = event {
                    undo::discard_history_on_exit();
                }
                if let tauri::RunEvent::ExitRequested { .. } = event {
                    log::info!("[App] Exit requested — cleaning up");
                    indexer::cancel_build();
                    if let Some(state) = app_handle.try_state::<AppState>() {
                        let mut watchers = state.watchers.lock().unwrap_or_else(|poisoned| {
                            log::warn!(
                                "[App] watcher map mutex poisoned during shutdown; recovering"
                            );
                            poisoned.into_inner()
                        });
                        watchers.clear();
                    }
                }
            });
        }
        Err(err) => {
            eprintln!("Application error: {}", err);
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn validate_path_preserves_trailing_spaces() {
        let temp = tempfile::tempdir().unwrap();
        let intended = temp.path().join("report ");
        let sibling = temp.path().join("report");
        std::fs::write(&intended, b"selected").unwrap();
        std::fs::write(&sibling, b"unselected").unwrap();
        let validated = validate_path(intended.to_str().unwrap(), "File").unwrap();
        assert_eq!(validated, intended);
        assert_eq!(std::fs::read(validated).unwrap(), b"selected");
    }

    #[cfg(unix)]
    #[test]
    fn state_directory_rejects_symlink_above_existing_parent() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let real = root.join("real");
        std::fs::create_dir_all(real.join("existing")).unwrap();
        std::os::unix::fs::symlink(&real, root.join("link")).unwrap();
        assert!(ensure_real_directory_tree(&root.join("link/existing/new"), "State").is_err());
        assert!(!real.join("existing/new").exists());
    }

    #[test]
    fn transfer_recovery_journal_reload_and_acknowledgement_keep_referenced_data() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let journal_path = root.join("transfer-recovery").join("journal.json");
        let staging = root.join(".iyeris-copy-staging");
        let backup = root.join(".iyeris-overwrite-backup");
        let destination = root.join("destination");
        std::fs::write(&staging, b"partial copy").unwrap();
        std::fs::write(&backup, b"original destination").unwrap();

        let store = recovery::RecoveryJournal::open(&journal_path).unwrap();
        let record_id = store
            .begin_operation(
                "copy",
                Some("copy-op-1"),
                &[],
                std::slice::from_ref(&destination),
            )
            .unwrap();
        store
            .record_paths(
                &record_id,
                recovery::RecoveryPaths {
                    staging: vec![staging.clone()],
                    backups: vec![backup.clone()],
                    retained: Vec::new(),
                },
            )
            .unwrap();
        drop(store);

        let reloaded = recovery::RecoveryJournal::open(&journal_path).unwrap();
        let unfinished = reloaded.list_unfinished().unwrap();
        assert_eq!(unfinished.len(), 1);
        assert_eq!(unfinished[0].id, record_id);
        assert_eq!(unfinished[0].kind, "copy");
        assert_eq!(
            unfinished[0].staging_paths,
            vec![staging.to_string_lossy().to_string()]
        );
        assert_eq!(
            unfinished[0].backup_paths,
            vec![backup.to_string_lossy().to_string()]
        );
        reloaded.acknowledge(&record_id).unwrap();
        assert!(reloaded.list_unfinished().unwrap().is_empty());
        assert_eq!(std::fs::read(&staging).unwrap(), b"partial copy");
        assert_eq!(std::fs::read(&backup).unwrap(), b"original destination");
    }

    #[test]
    fn transfer_recovery_journal_rejects_oversized_state_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let journal_path = root.join("journal.json");
        std::fs::write(&journal_path, vec![b'x'; recovery::MAX_JOURNAL_BYTES + 1]).unwrap();
        assert!(recovery::RecoveryJournal::open(&journal_path).is_err());
    }

    #[test]
    fn make_temp_path_includes_purpose() {
        let base = Path::new("/tmp/test.json");
        let temp = make_temp_path(base, "download");
        let name = temp
            .file_name()
            .and_then(|n| n.to_str())
            .expect("temp path should have a valid UTF-8 filename");
        assert!(name.contains("download"));
        assert!(name.ends_with(".tmp"));
    }

    #[test]
    fn make_temp_path_unique() {
        let base = Path::new("/tmp/test.json");
        let t1 = make_temp_path(base, "test");
        let t2 = make_temp_path(base, "test");
        assert_ne!(t1, t2);
    }

    #[test]
    fn validate_path_rejects_empty() {
        assert!(validate_path("", "Test").is_err());
        assert!(validate_path("   ", "Test").is_err());
    }

    #[test]
    fn validate_path_rejects_relative() {
        assert!(validate_path("relative/path", "Test").is_err());
    }

    #[test]
    fn validate_path_rejects_nul_and_oversized_input() {
        assert!(validate_path("/tmp/bad\0name", "Test").is_err());
        let oversized = format!("/tmp/{}", "x".repeat(1_048_576));
        assert!(validate_path(&oversized, "Test").is_err());
    }

    #[test]
    fn has_minimized_launch_arg_detects_supported_flags() {
        let args = vec!["app".to_string(), "--minimized".to_string()];
        assert!(has_minimized_launch_arg(&args));

        let args = vec!["app".to_string(), "--hidden".to_string()];
        assert!(has_minimized_launch_arg(&args));

        let args = vec!["app".to_string(), "--dev".to_string()];
        assert!(!has_minimized_launch_arg(&args));
    }

    #[cfg(unix)]
    #[test]
    fn first_open_path_arg_accepts_shell_looking_filenames() {
        let temp = tempfile::tempdir().expect("tempdir");
        let suspicious = temp.path().join("bad $`;|&<>\nname.txt");
        std::fs::write(&suspicious, "valid").expect("write temp file");
        let args = vec!["app".to_string(), suspicious.to_string_lossy().to_string()];
        assert_eq!(
            first_open_path_arg(&args),
            Some(
                suspicious
                    .canonicalize()
                    .expect("canonical path")
                    .to_string_lossy()
                    .to_string()
            )
        );
    }

    #[cfg(windows)]
    #[test]
    fn first_open_path_arg_accepts_shell_looking_filenames() {
        let temp = tempfile::tempdir().expect("tempdir");
        let suspicious = temp.path().join("bad $`;&name.txt");
        std::fs::write(&suspicious, "valid").expect("write temp file");
        let args = vec!["app".to_string(), suspicious.to_string_lossy().to_string()];
        assert_eq!(
            first_open_path_arg(&args),
            Some(
                suspicious
                    .canonicalize()
                    .expect("canonical path")
                    .to_string_lossy()
                    .to_string()
            )
        );
    }

    #[test]
    fn first_open_path_arg_rejects_control_characters() {
        let temp = tempfile::tempdir().expect("tempdir");
        let control = temp.path().join("bad\u{1}name.txt");
        let args = vec!["app".to_string(), control.to_string_lossy().to_string()];
        assert!(first_open_path_arg(&args).is_none());
    }

    #[test]
    fn app_state_directory_creates_nested_tree_and_canonicalizes() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("state").join("nested");
        let resolved = ensure_app_state_directory(&path, "Test state").expect("create state dir");
        assert!(path.is_dir());
        assert_eq!(resolved, path.canonicalize().expect("canonical path"));
    }

    #[cfg(unix)]
    #[test]
    fn app_state_directory_allows_symlinked_ancestor() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().expect("tempdir");
        let real = temp.path().join("real");
        std::fs::create_dir_all(&real).expect("create real dir");
        let link = temp.path().join("link");
        symlink(&real, &link).expect("create ancestor symlink");

        let resolved = ensure_app_state_directory(&link.join("state"), "Test state")
            .expect("trusted ancestor symlink should be allowed");
        assert!(resolved.starts_with(real.canonicalize().expect("canonical real dir")));
        assert!(resolved.ends_with("state"));
    }

    #[cfg(unix)]
    #[test]
    fn app_state_directory_rejects_symlinked_final_component() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().expect("tempdir");
        let real = temp.path().join("real");
        std::fs::create_dir_all(&real).expect("create real dir");
        let link = temp.path().join("link");
        symlink(&real, &link).expect("create symlink");

        assert!(ensure_app_state_directory(&link, "Test state").is_err());
    }

    #[test]
    fn app_state_directory_rejects_non_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let file = temp.path().join("state");
        std::fs::write(&file, "not a directory").expect("write temp file");

        assert!(ensure_app_state_directory(&file, "Test state").is_err());
    }

    #[test]
    fn first_open_path_arg_accepts_existing_absolute_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        let file_path = temp.path().join("ok.txt");
        std::fs::write(&file_path, "ok").expect("write temp file");
        let args = vec!["app".to_string(), file_path.to_string_lossy().to_string()];
        assert_eq!(
            first_open_path_arg(&args),
            Some(
                file_path
                    .canonicalize()
                    .expect("canonical path")
                    .to_string_lossy()
                    .to_string()
            )
        );
    }
}
