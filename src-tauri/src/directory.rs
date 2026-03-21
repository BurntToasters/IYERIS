use serde::Serialize;
use std::fs;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::Emitter;
use walkdir::WalkDir;

static ACTIVE_FOLDER_CALCS: std::sync::LazyLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));
static ACTIVE_DIRECTORY_LISTINGS: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSizeResult {
    pub total_size: u64,
    pub file_count: u64,
    pub folder_count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileItem {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub is_broken_symlink: bool,
    pub is_app_bundle: bool,
    pub is_shortcut: bool,
    pub is_desktop_entry: bool,
    pub symlink_target: Option<String>,
    pub is_hidden: bool,
    pub size: u64,
    pub modified: f64,
    pub created: f64,
    pub extension: String,
    #[cfg(unix)]
    pub permissions: u32,
    #[cfg(not(unix))]
    pub permissions: u32,
    pub readonly: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub name: String,
    pub mount_point: String,
    pub total_space: u64,
    pub available_space: u64,
    pub fs_type: String,
    pub is_removable: bool,
}

fn drive_space(mount_point: &str) -> (u64, u64) {
    let path = std::path::Path::new(mount_point);
    let total = fs2::total_space(path).unwrap_or(0);
    let available = fs2::available_space(path).unwrap_or(0);
    (total, available)
}

fn build_drive(
    name: String,
    mount_point: String,
    fs_type: String,
    is_removable: bool,
) -> DriveInfo {
    let (total_space, available_space) = drive_space(&mount_point);
    DriveInfo {
        name,
        mount_point,
        total_space,
        available_space,
        fs_type,
        is_removable,
    }
}

fn is_hidden(name: &str, _path: &std::path::Path) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        if let Ok(meta) = _path.metadata() {
            return meta.file_attributes() & 0x2 != 0;
        }
    }
    false
}

fn detect_special_file_flags(path: &std::path::Path, is_directory: bool) -> (bool, bool, bool) {
    let name_lower = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_ascii_lowercase())
        .unwrap_or_default();

    #[cfg(target_os = "macos")]
    let is_app_bundle = is_directory && name_lower.ends_with(".app");
    #[cfg(not(target_os = "macos"))]
    let is_app_bundle = false;

    #[cfg(target_os = "windows")]
    let is_shortcut = !is_directory && name_lower.ends_with(".lnk");
    #[cfg(not(target_os = "windows"))]
    let is_shortcut = false;

    #[cfg(target_os = "linux")]
    let is_desktop_entry = !is_directory && name_lower.ends_with(".desktop");
    #[cfg(not(target_os = "linux"))]
    let is_desktop_entry = false;

    (is_app_bundle, is_shortcut, is_desktop_entry)
}

fn read_symlink_info(path: &std::path::Path, meta: &fs::Metadata) -> (Option<String>, bool) {
    if !meta.file_type().is_symlink() {
        return (None, false);
    }

    match fs::read_link(path) {
        Ok(target) => {
            let resolved_target = if target.is_absolute() {
                target.clone()
            } else {
                path.parent()
                    .unwrap_or_else(|| std::path::Path::new(""))
                    .join(&target)
            };
            (
                Some(target.to_string_lossy().to_string()),
                !resolved_target.exists(),
            )
        }
        Err(_) => (None, true),
    }
}

fn metadata_to_file_item(path: &std::path::Path, meta: &fs::Metadata) -> FileItem {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);

    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode()
    };
    #[cfg(not(unix))]
    let permissions = 0u32;

    let is_directory = meta.is_dir();
    let is_symlink = meta.file_type().is_symlink();
    let (symlink_target, is_broken_symlink) = read_symlink_info(path, meta);
    let (is_app_bundle, is_shortcut, is_desktop_entry) =
        detect_special_file_flags(path, is_directory);

    FileItem {
        name: name.clone(),
        path: path.to_string_lossy().to_string(),
        is_directory,
        is_symlink,
        is_broken_symlink,
        is_app_bundle,
        is_shortcut,
        is_desktop_entry,
        symlink_target,
        is_hidden: is_hidden(&name, path),
        size: meta.len(),
        modified,
        created,
        extension,
        permissions,
        readonly: meta.permissions().readonly(),
    }
}

#[tauri::command]
pub async fn get_directory_contents(
    dir_path: String,
    operation_id: Option<String>,
    include_hidden: Option<bool>,
    _stream_only: Option<bool>,
    app: tauri::AppHandle,
) -> Result<Vec<FileItem>, String> {
    log::debug!("[Directory] get_directory_contents: {} (op={:?})", dir_path, operation_id);
    let path = crate::validate_existing_path(&dir_path, "Directory")?;
    let show_hidden = include_hidden.unwrap_or(false);
    let op_id = operation_id.unwrap_or_default();

    if !op_id.is_empty() {
        let mut listings = ACTIVE_DIRECTORY_LISTINGS.lock().map_err(|e| e.to_string())?;
        listings.insert(op_id.clone());
    }

    let listing_op_id = op_id.clone();
    let progress_path = dir_path.clone();

    let result = tokio::task::spawn_blocking(move || {
        let entries = fs::read_dir(&path).map_err(|e| format!("Failed to read directory: {}", e))?;
        let mut items = Vec::new();
        let mut loaded: usize = 0;

        for entry in entries.filter_map(|e| e.map_err(|err| log::warn!("[Directory] read_dir entry error: {}", err)).ok()) {
            if !listing_op_id.is_empty() {
                let listings = ACTIVE_DIRECTORY_LISTINGS.lock().map_err(|e| e.to_string())?;
                if !listings.contains(&listing_op_id) {
                    break;
                }
            }

            let entry_path = entry.path();
            let name = entry
                .file_name()
                .to_string_lossy()
                .to_string();

            if !show_hidden && is_hidden(&name, &entry_path) {
                continue;
            }

            let meta = match fs::symlink_metadata(&entry_path) {
                Ok(m) => m,
                Err(_) => continue,
            };

            items.push(metadata_to_file_item(&entry_path, &meta));
            loaded += 1;

            if loaded % 200 == 0 {
                let _ = app.emit(
                    "directory-contents-progress",
                    serde_json::json!({
                        "dirPath": progress_path,
                        "loaded": loaded,
                        "operationId": listing_op_id,
                    }),
                );
            }
        }

        let _ = app.emit(
            "directory-contents-progress",
            serde_json::json!({
                "dirPath": progress_path,
                "loaded": loaded,
                "operationId": listing_op_id,
            }),
        );

        Ok(items)
    })
    .await
    .map_err(|e| e.to_string())?;

    if !op_id.is_empty() {
        let mut listings = ACTIVE_DIRECTORY_LISTINGS.lock().map_err(|e| e.to_string())?;
        listings.remove(&op_id);
    }

    result
}

#[tauri::command]
pub async fn cancel_directory_contents(operation_id: String) -> Result<(), String> {
    let mut listings = ACTIVE_DIRECTORY_LISTINGS.lock().map_err(|e| e.to_string())?;
    listings.remove(&operation_id);
    Ok(())
}

#[tauri::command]
pub async fn get_drives() -> Result<Vec<DriveInfo>, String> {
    tokio::task::spawn_blocking(|| {
        let mut drives = Vec::new();

        #[cfg(target_os = "windows")]
        {
            for letter in b'A'..=b'Z' {
                let mount = format!("{}:\\", letter as char);
                let path = std::path::Path::new(&mount);
                if path.exists() {
                    drives.push(build_drive(
                        format!("{}: Drive", letter as char),
                        mount,
                        String::new(),
                        false,
                    ));
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            drives.push(build_drive(
                "Macintosh HD".into(),
                "/".into(),
                "apfs".into(),
                false,
            ));
            if let Ok(entries) = fs::read_dir("/Volumes") {
                for entry in entries.filter_map(|e| e.map_err(|err| log::warn!("[Directory] /Volumes entry error: {}", err)).ok()) {
                    let mount = entry.path().to_string_lossy().to_string();
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name != "Macintosh HD" {
                        drives.push(build_drive(name, mount, String::new(), true));
                    }
                }
            }
        }

        #[cfg(target_os = "linux")]
        {
            drives.push(build_drive("Root".into(), "/".into(), "ext4".into(), false));
            let home = std::env::var("HOME").unwrap_or_default();
            if !home.is_empty() && home != "/" {
                drives.push(build_drive("Home".into(), home, String::new(), false));
            }
            if let Ok(entries) = fs::read_dir("/media") {
                for entry in entries.filter_map(|e| e.map_err(|err| log::warn!("[Directory] /media entry error: {}", err)).ok()) {
                    let mount = entry.path().to_string_lossy().to_string();
                    let name = entry.file_name().to_string_lossy().to_string();
                    drives.push(build_drive(name, mount, String::new(), true));
                }
            }
        }

        Ok(drives)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_drive_info() -> Result<Vec<DriveInfo>, String> {
    get_drives().await
}

#[tauri::command]
pub async fn get_home_directory() -> Result<String, String> {
    directories::UserDirs::new()
        .map(|d| d.home_dir().to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".into())
}

#[tauri::command]
pub async fn get_special_directory(directory: String) -> Result<String, String> {
    let user_dirs = directories::UserDirs::new()
        .ok_or_else(|| "Could not determine user directories".to_string())?;

    let path = match directory.as_str() {
        "home" => Some(user_dirs.home_dir().to_path_buf()),
        "desktop" => user_dirs.desktop_dir().map(|p| p.to_path_buf()),
        "documents" => user_dirs.document_dir().map(|p| p.to_path_buf()),
        "downloads" => user_dirs.download_dir().map(|p| p.to_path_buf()),
        "music" => user_dirs.audio_dir().map(|p| p.to_path_buf()),
        "pictures" => user_dirs.picture_dir().map(|p| p.to_path_buf()),
        "videos" => user_dirs.video_dir().map(|p| p.to_path_buf()),
        _ => None,
    };

    path.map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| format!("Unknown special directory: {}", directory))
}

#[tauri::command]
pub async fn get_disk_space(drive_path: String) -> Result<serde_json::Value, String> {
    let path = crate::validate_existing_path(&drive_path, "Drive")?;
    tokio::task::spawn_blocking(move || {
        let total = fs2::total_space(&path).map_err(|e| e.to_string())?;
        let free = fs2::available_space(&path).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "total": total,
            "free": free,
            "used": total.saturating_sub(free),
            "path": path.to_string_lossy(),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn calculate_folder_size(
    folder_path: String,
    operation_id: String,
    app: tauri::AppHandle,
) -> Result<FolderSizeResult, String> {
    let path = crate::validate_existing_path(&folder_path, "Folder")?;

    {
        let mut calcs = ACTIVE_FOLDER_CALCS.lock().map_err(|e| e.to_string())?;
        calcs.insert(operation_id.clone());
    }

    let op_id = operation_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut total: u64 = 0;
        let mut file_count: u64 = 0;
        let mut folder_count: u64 = 0;

        for entry in WalkDir::new(&path).into_iter().filter_map(|e| e.map_err(|err| log::warn!("[Directory] folder size walk error: {}", err)).ok()) {
            {
                let calcs = ACTIVE_FOLDER_CALCS.lock().map_err(|e| e.to_string())?;
                if !calcs.contains(&op_id) {
                    return Err("Calculation cancelled".to_string());
                }
            }

            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    total = total.saturating_add(meta.len());
                    file_count += 1;
                    if file_count % 500 == 0 {
                        let _ = app.emit("folder-size-progress", serde_json::json!({
                            "operationId": op_id,
                            "size": total,
                            "files": file_count,
                        }));
                    }
                } else if meta.is_dir() {
                    folder_count += 1;
                }
            }
        }

        Ok(FolderSizeResult {
            total_size: total,
            file_count,
            folder_count,
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    {
        let mut calcs = ACTIVE_FOLDER_CALCS.lock().map_err(|e| e.to_string())?;
        calcs.remove(&operation_id);
    }

    result
}

#[tauri::command]
pub async fn cancel_folder_size_calculation(operation_id: String) -> Result<(), String> {
    let mut calcs = ACTIVE_FOLDER_CALCS.lock().map_err(|e| e.to_string())?;
    calcs.remove(&operation_id);
    Ok(())
}
