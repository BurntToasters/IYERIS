use serde::Serialize;
use std::fs;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::Emitter;
use walkdir::WalkDir;

static ACTIVE_FOLDER_CALCS: std::sync::LazyLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileItem {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub is_symlink: bool,
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

    FileItem {
        name: name.clone(),
        path: path.to_string_lossy().to_string(),
        is_directory: meta.is_dir(),
        is_symlink: meta.is_symlink(),
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
    _operation_id: Option<String>,
    include_hidden: Option<bool>,
    _stream_only: Option<bool>,
) -> Result<Vec<FileItem>, String> {
    let path = crate::validate_existing_path(&dir_path, "Directory")?;
    let show_hidden = include_hidden.unwrap_or(false);

    tokio::task::spawn_blocking(move || {
        let entries = fs::read_dir(&path).map_err(|e| format!("Failed to read directory: {}", e))?;
        let mut items = Vec::new();

        for entry in entries.flatten() {
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
        }

        Ok(items)
    })
    .await
    .map_err(|e| e.to_string())?
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
                    drives.push(DriveInfo {
                        name: format!("{}: Drive", letter as char),
                        mount_point: mount,
                        total_space: 0,
                        available_space: 0,
                        fs_type: String::new(),
                        is_removable: false,
                    });
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            drives.push(DriveInfo {
                name: "Macintosh HD".into(),
                mount_point: "/".into(),
                total_space: 0,
                available_space: 0,
                fs_type: "apfs".into(),
                is_removable: false,
            });
            if let Ok(entries) = fs::read_dir("/Volumes") {
                for entry in entries.flatten() {
                    let mount = entry.path().to_string_lossy().to_string();
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name != "Macintosh HD" {
                        drives.push(DriveInfo {
                            name,
                            mount_point: mount,
                            total_space: 0,
                            available_space: 0,
                            fs_type: String::new(),
                            is_removable: true,
                        });
                    }
                }
            }
        }

        #[cfg(target_os = "linux")]
        {
            drives.push(DriveInfo {
                name: "Root".into(),
                mount_point: "/".into(),
                total_space: 0,
                available_space: 0,
                fs_type: "ext4".into(),
                is_removable: false,
            });
            let home = std::env::var("HOME").unwrap_or_default();
            if !home.is_empty() && home != "/" {
                drives.push(DriveInfo {
                    name: "Home".into(),
                    mount_point: home,
                    total_space: 0,
                    available_space: 0,
                    fs_type: String::new(),
                    is_removable: false,
                });
            }
            if let Ok(entries) = fs::read_dir("/media") {
                for entry in entries.flatten() {
                    let mount = entry.path().to_string_lossy().to_string();
                    let name = entry.file_name().to_string_lossy().to_string();
                    drives.push(DriveInfo {
                        name,
                        mount_point: mount,
                        total_space: 0,
                        available_space: 0,
                        fs_type: String::new(),
                        is_removable: true,
                    });
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
    tokio::task::spawn_blocking(move || {
        let info = sys_info::disk_info().map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "total": info.total * 1024,
            "free": info.free * 1024,
            "used": (info.total - info.free) * 1024,
            "path": drive_path,
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
) -> Result<u64, String> {
    let path = crate::validate_existing_path(&folder_path, "Folder")?;

    {
        let mut calcs = ACTIVE_FOLDER_CALCS.lock().map_err(|e| e.to_string())?;
        calcs.insert(operation_id.clone());
    }

    let op_id = operation_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut total: u64 = 0;
        let mut count: u64 = 0;

        for entry in WalkDir::new(&path).into_iter().flatten() {
            {
                let calcs = ACTIVE_FOLDER_CALCS.lock().unwrap();
                if !calcs.contains(&op_id) {
                    return Err("Calculation cancelled".to_string());
                }
            }

            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    total += meta.len();
                    count += 1;
                    if count % 500 == 0 {
                        let _ = app.emit("folder-size-progress", serde_json::json!({
                            "operationId": op_id,
                            "size": total,
                            "files": count,
                        }));
                    }
                }
            }
        }

        Ok(total)
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
