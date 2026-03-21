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

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Manager;

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);

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
    pub watcher: Mutex<Option<watcher::DirectoryWatcher>>,
    pub zoom_level: Mutex<f64>,
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
    if !path.exists() {
        return Err(format!("{} path does not exist: {}", label, path.display()));
    }
    Ok(path)
}

fn main() {
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            let has_nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
            if !has_nvidia {
                unsafe { std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1") };
            }
        }
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));

    if let Err(err) = builder
        .manage(AppState {
            clipboard: Mutex::new(ClipboardState {
                operation: None,
                paths: vec![],
            }),
            drag: Mutex::new(DragState { paths: vec![] }),
            watcher: Mutex::new(None),
            zoom_level: Mutex::new(1.0),
        })
        .setup(|app| {
            if let Err(error) = system::setup_tray(app) {
                eprintln!("Tray setup failed: {}", error);
            }
            let settings_json = settings::get_settings(app.handle().clone())
                .unwrap_or_else(|_| "{}".to_string());
            let enable_indexer = serde_json::from_str::<serde_json::Value>(&settings_json)
                .ok()
                .and_then(|value| value.get("enableIndexer").and_then(|flag| flag.as_bool()))
                .unwrap_or(true);

            if enable_indexer {
                indexer::initialize_index(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && system::should_minimize_to_tray(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
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
            system::select_folder,
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
            // Update
            platform::check_for_updates,
            platform::download_update,
            platform::install_update,
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
        .run(tauri::generate_context!())
    {
        eprintln!("Application error: {}", err);
        std::process::exit(1);
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
