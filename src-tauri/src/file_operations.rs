use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Emitter;

static ACTIVE_CHECKSUMS: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemProperties {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub is_hidden: bool,
    pub readonly: bool,
    pub created: f64,
    pub modified: f64,
    pub accessed: f64,
    pub extension: String,
    #[cfg(unix)]
    pub permissions: u32,
    #[cfg(not(unix))]
    pub permissions: u32,
}

#[tauri::command]
pub async fn open_file(file_path: String) -> Result<(), String> {
    open::that(&file_path).map_err(|e| format!("Failed to open file: {}", e))
}

#[tauri::command]
pub async fn create_folder(parent_path: String, folder_name: String) -> Result<String, String> {
    let parent = crate::validate_existing_path(&parent_path, "Parent")?;
    let new_path = parent.join(&folder_name);
    fs::create_dir_all(&new_path).map_err(|e| format!("Failed to create folder: {}", e))?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn create_file(parent_path: String, file_name: String) -> Result<String, String> {
    let parent = crate::validate_existing_path(&parent_path, "Parent")?;
    let new_path = parent.join(&file_name);
    fs::File::create(&new_path).map_err(|e| format!("Failed to create file: {}", e))?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn delete_item(item_path: String) -> Result<(), String> {
    let path = crate::validate_existing_path(&item_path, "Item")?;
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| format!("Failed to delete directory: {}", e))
    } else {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {}", e))
    }
}

#[tauri::command]
pub async fn trash_item(item_path: String) -> Result<(), String> {
    let path = crate::validate_existing_path(&item_path, "Item")?;
    trash::delete(&path).map_err(|e| format!("Failed to trash item: {}", e))
}

#[tauri::command]
pub async fn open_trash() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        open::that(std::path::Path::new(&format!(
            "{}/.Trash",
            std::env::var("HOME").unwrap_or_default()
        )))
        .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        open::that("shell:RecycleBinFolder").map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let trash_path = format!(
            "{}/.local/share/Trash",
            std::env::var("HOME").unwrap_or_default()
        );
        open::that(&trash_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn rename_item(old_path: String, new_name: String) -> Result<String, String> {
    let path = crate::validate_existing_path(&old_path, "Item")?;
    let new_path = path
        .parent()
        .ok_or("Cannot determine parent directory")?
        .join(&new_name);
    fs::rename(&path, &new_path).map_err(|e| format!("Failed to rename: {}", e))?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn copy_items(
    source_paths: Vec<String>,
    dest_path: String,
    _conflict_behavior: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let dest = crate::validate_existing_path(&dest_path, "Destination")?;
    let total = source_paths.len();

    for (i, source) in source_paths.iter().enumerate() {
        let src = PathBuf::from(source);
        let name = src
            .file_name()
            .ok_or("Invalid source path")?
            .to_string_lossy()
            .to_string();
        let target = dest.join(&name);

        let _ = app.emit(
            "file-operation-progress",
            serde_json::json!({
                "operation": "copy",
                "current": i + 1,
                "total": total,
                "name": name,
            }),
        );

        if src.is_dir() {
            copy_dir_recursive(&src, &target)?;
        } else {
            fs::copy(&src, &target).map_err(|e| format!("Failed to copy {}: {}", name, e))?;
        }
    }

    Ok(())
}

fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("Failed to create directory: {}", e))?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let entry_path = entry.path();
        let target = dest.join(entry.file_name());
        if entry_path.is_dir() {
            copy_dir_recursive(&entry_path, &target)?;
        } else {
            fs::copy(&entry_path, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn move_items(
    source_paths: Vec<String>,
    dest_path: String,
    _conflict_behavior: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let dest = crate::validate_existing_path(&dest_path, "Destination")?;
    let total = source_paths.len();

    for (i, source) in source_paths.iter().enumerate() {
        let src = PathBuf::from(source);
        let name = src
            .file_name()
            .ok_or("Invalid source path")?
            .to_string_lossy()
            .to_string();
        let target = dest.join(&name);

        let _ = app.emit(
            "file-operation-progress",
            serde_json::json!({
                "operation": "move",
                "current": i + 1,
                "total": total,
                "name": name,
            }),
        );

        if let Err(_) = fs::rename(&src, &target) {
            if src.is_dir() {
                copy_dir_recursive(&src, &target)?;
                fs::remove_dir_all(&src).map_err(|e| e.to_string())?;
            } else {
                fs::copy(&src, &target).map_err(|e| e.to_string())?;
                fs::remove_file(&src).map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn get_item_properties(item_path: String) -> Result<ItemProperties, String> {
    let path = crate::validate_existing_path(&item_path, "Item")?;
    let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;

    let to_ms = |t: std::io::Result<std::time::SystemTime>| {
        t.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    };

    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode()
    };
    #[cfg(not(unix))]
    let permissions = 0u32;

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(ItemProperties {
        name: name.clone(),
        path: path.to_string_lossy().to_string(),
        size: meta.len(),
        is_directory: meta.is_dir(),
        is_symlink: meta.is_symlink(),
        is_hidden: name.starts_with('.'),
        readonly: meta.permissions().readonly(),
        created: to_ms(meta.created()),
        modified: to_ms(meta.modified()),
        accessed: to_ms(meta.accessed()),
        extension: path
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default(),
        permissions,
    })
}

#[tauri::command]
pub async fn set_permissions(item_path: String, mode: u32) -> Result<(), String> {
    let path = crate::validate_existing_path(&item_path, "Item")?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(mode);
        fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
    }

    #[cfg(not(unix))]
    {
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        let mut perms = meta.permissions();
        perms.set_readonly(mode & 0o200 == 0);
        fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn read_file_content(
    file_path: String,
    max_size: Option<u64>,
) -> Result<String, String> {
    let path = crate::validate_existing_path(&file_path, "File")?;
    let limit = max_size.unwrap_or(10 * 1024 * 1024);

    tokio::task::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > limit {
            return Err(format!(
                "File too large: {} bytes (limit: {} bytes)",
                meta.len(),
                limit
            ));
        }
        let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut content = String::new();
        file.read_to_string(&mut content)
            .map_err(|e| format!("Failed to read file as text: {}", e))?;
        Ok(content)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_file_data_url(
    file_path: String,
    max_size: Option<u64>,
) -> Result<String, String> {
    let path = crate::validate_existing_path(&file_path, "File")?;
    let limit = max_size.unwrap_or(50 * 1024 * 1024);

    tokio::task::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > limit {
            return Err("File too large for data URL".into());
        }
        let data = fs::read(&path).map_err(|e| e.to_string())?;
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "svg" => "image/svg+xml",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            "pdf" => "application/pdf",
            _ => "application/octet-stream",
        };
        use std::io::Write;
        let mut buf = Vec::new();
        write!(buf, "data:{};base64,", mime).map_err(|e| e.to_string())?;
        let encoded = base64_encode(&data);
        buf.extend_from_slice(encoded.as_bytes());
        String::from_utf8(buf).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[(n >> 18 & 63) as usize] as char);
        result.push(CHARS[(n >> 12 & 63) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[(n >> 6 & 63) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(n & 63) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

#[tauri::command]
pub async fn batch_rename(
    items: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut results = Vec::new();
    for item in &items {
        let old_path = item["oldPath"]
            .as_str()
            .ok_or("Missing oldPath")?;
        let new_name = item["newName"]
            .as_str()
            .ok_or("Missing newName")?;
        let path = PathBuf::from(old_path);
        let new_path = path
            .parent()
            .ok_or("Cannot determine parent")?
            .join(new_name);
        match fs::rename(&path, &new_path) {
            Ok(_) => results.push(serde_json::json!({
                "oldPath": old_path,
                "newPath": new_path.to_string_lossy(),
                "success": true,
            })),
            Err(e) => results.push(serde_json::json!({
                "oldPath": old_path,
                "success": false,
                "error": e.to_string(),
            })),
        }
    }
    Ok(results)
}

#[tauri::command]
pub async fn create_symlink(target_path: String, link_path: String) -> Result<(), String> {
    let target = crate::validate_existing_path(&target_path, "Target")?;
    let link = PathBuf::from(&link_path);

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, &link)
            .map_err(|e| format!("Failed to create symlink: {}", e))
    }

    #[cfg(target_os = "windows")]
    {
        if target.is_dir() {
            std::os::windows::fs::symlink_dir(&target, &link)
                .map_err(|e| format!("Failed to create symlink: {}", e))
        } else {
            std::os::windows::fs::symlink_file(&target, &link)
                .map_err(|e| format!("Failed to create symlink: {}", e))
        }
    }
}

#[tauri::command]
pub async fn resolve_shortcut(shortcut_path: String) -> Result<String, String> {
    let path = PathBuf::from(&shortcut_path);
    let resolved = fs::read_link(&path).map_err(|e| format!("Failed to resolve shortcut: {}", e))?;
    Ok(resolved.to_string_lossy().to_string())
}

#[tauri::command]
pub fn set_clipboard(
    state: tauri::State<'_, crate::AppState>,
    clipboard_data: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut cb = state.clipboard.lock().map_err(|e| e.to_string())?;
    if let Some(data) = clipboard_data {
        cb.operation = data["operation"].as_str().map(String::from);
        cb.paths = data["paths"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
    } else {
        cb.operation = None;
        cb.paths.clear();
    }
    Ok(())
}

#[tauri::command]
pub fn get_clipboard(
    state: tauri::State<'_, crate::AppState>,
) -> Result<serde_json::Value, String> {
    let cb = state.clipboard.lock().map_err(|e| e.to_string())?;
    if let Some(ref op) = cb.operation {
        Ok(serde_json::json!({
            "operation": op,
            "paths": cb.paths,
        }))
    } else {
        Ok(serde_json::Value::Null)
    }
}

#[tauri::command]
pub fn set_drag_data(
    state: tauri::State<'_, crate::AppState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let mut drag = state.drag.lock().map_err(|e| e.to_string())?;
    drag.paths = paths;
    Ok(())
}

#[tauri::command]
pub fn get_drag_data(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<String>, String> {
    let drag = state.drag.lock().map_err(|e| e.to_string())?;
    Ok(drag.paths.clone())
}

#[tauri::command]
pub fn clear_drag_data(
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let mut drag = state.drag.lock().map_err(|e| e.to_string())?;
    drag.paths.clear();
    Ok(())
}

#[tauri::command]
pub async fn calculate_checksum(
    file_path: String,
    operation_id: String,
    algorithms: Vec<String>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let path = crate::validate_existing_path(&file_path, "File")?;

    {
        let mut active = ACTIVE_CHECKSUMS.lock().map_err(|e| e.to_string())?;
        active.insert(operation_id.clone());
    }

    let op_id = operation_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        use sha2::{Sha256, Sha512, Digest};
        use md5::Md5;

        let file_size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
        let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut results = serde_json::Map::new();

        for algo in &algorithms {
            {
                let active = ACTIVE_CHECKSUMS.lock().unwrap();
                if !active.contains(&op_id) {
                    return Err("Checksum cancelled".to_string());
                }
            }

            let hash = match algo.to_lowercase().as_str() {
                "sha256" => {
                    let mut hasher = Sha256::new();
                    let mut buf = [0u8; 8192];
                    let mut read_total = 0u64;
                    use std::io::Seek;
                    file.seek(std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
                    loop {
                        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
                        if n == 0 { break; }
                        hasher.update(&buf[..n]);
                        read_total += n as u64;
                        if read_total % (1024 * 1024) == 0 {
                            let percent = if file_size > 0 { (read_total as f64 / file_size as f64) * 100.0 } else { 100.0 };
                            let _ = app.emit("checksum-progress", serde_json::json!({
                                "operationId": op_id, "percent": percent, "algorithm": algo
                            }));
                        }
                    }
                    hex::encode(hasher.finalize())
                },
                "sha512" => {
                    let mut hasher = Sha512::new();
                    let mut buf = [0u8; 8192];
                    use std::io::Seek;
                    file.seek(std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
                    loop {
                        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
                        if n == 0 { break; }
                        hasher.update(&buf[..n]);
                    }
                    hex::encode(hasher.finalize())
                },
                "md5" => {
                    let mut hasher = Md5::new();
                    let mut buf = [0u8; 8192];
                    use std::io::Seek;
                    file.seek(std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
                    loop {
                        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
                        if n == 0 { break; }
                        hasher.update(&buf[..n]);
                    }
                    hex::encode(hasher.finalize())
                },
                "crc32" => {
                    let mut hasher = crc32fast::Hasher::new();
                    let mut buf = [0u8; 8192];
                    use std::io::Seek;
                    file.seek(std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
                    loop {
                        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
                        if n == 0 { break; }
                        hasher.update(&buf[..n]);
                    }
                    format!("{:08x}", hasher.finalize())
                },
                _ => return Err(format!("Unknown algorithm: {}", algo)),
            };
            results.insert(algo.clone(), serde_json::Value::String(hash));
        }

        Ok(serde_json::Value::Object(results))
    })
    .await
    .map_err(|e| e.to_string())?;

    {
        let mut active = ACTIVE_CHECKSUMS.lock().map_err(|e| e.to_string())?;
        active.remove(&operation_id);
    }

    result
}

#[tauri::command]
pub async fn cancel_checksum_calculation(operation_id: String) -> Result<(), String> {
    let mut active = ACTIVE_CHECKSUMS.lock().map_err(|e| e.to_string())?;
    active.remove(&operation_id);
    Ok(())
}
