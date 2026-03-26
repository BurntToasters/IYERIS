#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod archive;
mod directory;
mod elevated;
mod file_operations;
mod indexer;
mod platform;
mod search;
mod settings;
mod system;
mod thumbnails;
mod undo;
mod watcher;

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Manager;

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

pub(crate) fn validate_path(raw: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("{} path is required", label));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!("{} path must be absolute: {}", label, trimmed));
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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dev_mode = args.iter().any(|a| a == "--dev" || a == "--verbose");
    let start_minimized = args.iter().any(|a| a == "--minimized");
    DEV_MODE.store(dev_mode, Ordering::Relaxed);

    #[cfg(target_os = "windows")]
    if dev_mode {
        use windows::Win32::System::Console::{AttachConsole, AllocConsole, ATTACH_PARENT_PROCESS};
        unsafe {
            if AttachConsole(ATTACH_PARENT_PROCESS).is_err() {
                let _ = AllocConsole();
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
            if !has_nvidia {
                unsafe { std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1") };
            }
        }
    }

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
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            } else {
                let windows = app.webview_windows();
                let target = windows
                    .values()
                    .find(|w| w.is_visible().unwrap_or(false))
                    .or_else(|| windows.values().next());
                if let Some(w) = target {
                    let _ = w.show();
                    let _ = w.set_focus();
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
        .setup(move |app| {
            log::debug!("[Setup] App setup starting");

            #[cfg(not(target_os = "macos"))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                    log::debug!("[Setup] Disabled decorations for custom titlebar");
                }
            }

            if start_minimized {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                    log::debug!("[Setup] Started minimized to tray");
                }
                #[cfg(target_os = "macos")]
                {
                    let _ = app.handle().set_dock_visibility(false);
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
                    eprintln!("Tray setup failed: {}", error);
                    log::warn!("[Setup] Tray setup failed: {}", error);
                }
            }
            let settings_json = settings::get_settings(app.handle().clone())
                .unwrap_or_else(|_| "{}".to_string());
            log::debug!("[Setup] Settings loaded ({} bytes)", settings_json.len());

            let start_on_login = serde_json::from_str::<serde_json::Value>(&settings_json)
                .ok()
                .and_then(|v| v.get("startOnLogin").and_then(|f| f.as_bool()))
                .unwrap_or(false);
            {
                use tauri_plugin_autostart::ManagerExt;
                if start_on_login {
                    let _ = app.autolaunch().enable();
                } else {
                    let _ = app.autolaunch().disable();
                }
            }

            let enable_indexer = serde_json::from_str::<serde_json::Value>(&settings_json)
                .ok()
                .and_then(|value| value.get("enableIndexer").and_then(|flag| flag.as_bool()))
                .unwrap_or(true);

            if enable_indexer {
                indexer::initialize_index(app.handle());
                log::debug!("[Setup] File indexer initialized");
            } else {
                log::debug!("[Setup] File indexer disabled by settings");
            }
            log::info!("[Setup] App setup complete");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && system::should_minimize_to_tray(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                    #[cfg(target_os = "macos")]
                    if !system::has_other_visible_windows(window.app_handle(), "main") {
                        let _ = window.app_handle().set_dock_visibility(false);
                    }
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() != "main" {
                    let app = window.app_handle();
                    if system::should_minimize_to_tray(app) {
                        let main_hidden = app.get_webview_window("main")
                            .is_some_and(|w| !w.is_visible().unwrap_or(true));
                        if main_hidden && !system::has_other_visible_windows(app, window.label()) {
                            #[cfg(target_os = "macos")]
                            {
                                let _ = app.set_dock_visibility(false);
                            }
                        }
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
            // Elevated operations
            elevated::elevated_copy,
            elevated::elevated_move,
            elevated::elevated_delete,
            elevated::elevated_rename,
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
            // Undo/redo
            undo::undo_action,
            undo::redo_action,
            undo::get_undo_redo_state,
        ])
        .build(tauri::generate_context!())
    {
        Ok(app) => {
            app.run(|app_handle, event| {
                #[cfg(target_os = "macos")]
                if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
                    if !has_visible_windows {
                        let _ = app_handle.set_dock_visibility(true);
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                let _ = app_handle;
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

    #[test]
    fn make_temp_path_includes_purpose() {
        let base = Path::new("/tmp/test.json");
        let temp = make_temp_path(base, "download");
        let name = temp.file_name().unwrap().to_str().unwrap();
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
}
